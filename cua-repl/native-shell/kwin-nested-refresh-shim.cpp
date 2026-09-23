#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <dlfcn.h>
#include <new>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wayland-client.h>

static uint64_t timespec_to_ns(const struct timespec &ts) {
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static struct timespec ns_to_timespec(uint64_t ns) {
    struct timespec ts;
    ts.tv_sec = (time_t)(ns / 1000000000ULL);
    ts.tv_nsec = (long)(ns % 1000000000ULL);
    return ts;
}

static uint32_t target_mhz() {
    const char *raw = getenv("MCPBROWSER_KWIN_NESTED_REFRESH_MHZ");
    unsigned long mhz = raw && *raw ? strtoul(raw, nullptr, 10) : 120000UL;
    return mhz ? (uint32_t)mhz : 120000U;
}

enum synth_mode {
    SYNTH_OFF = 0,
    SYNTH_CALLBACK = 1,
    SYNTH_LEGACY = 2,
};

static synth_mode synth_presentation_mode() {
    const char *raw = getenv("MCPBROWSER_KWIN_SYNTH_PRESENT");
    if (raw && strcmp(raw, "0") == 0)
        return SYNTH_OFF;
    if (raw && strcmp(raw, "legacy") == 0)
        return SYNTH_LEGACY;
    return SYNTH_CALLBACK;
}

// KWin::OutputModeline::OutputModeline(QSize const&, uint, QFlags<Flag>)
using ctor_fn = void (*)(void *, const void *, uint32_t, int);
extern "C" void
mcpbrowser_output_modeline_ctor(void *self, const void *size, uint32_t refresh,
                         int flags) asm("_ZN4KWin14OutputModelineC1ERK5QSizej6QFlagsINS0_4FlagEE");
extern "C" void mcpbrowser_output_modeline_ctor(void *self, const void *size, uint32_t refresh,
                                         int flags) {
    static ctor_fn real_fn = nullptr;
    if (!real_fn)
        real_fn = reinterpret_cast<ctor_fn>(
            dlsym(RTLD_NEXT, "_ZN4KWin14OutputModelineC1ERK5QSizej6QFlagsINS0_4FlagEE"));
    if (refresh == 60000U)
        refresh = target_mhz();
    real_fn(self, size, refresh, flags);
}

extern "C" void
mcpbrowser_output_modeline_ctor2(void *self, const void *size, uint32_t refresh,
                          int flags) asm("_ZN4KWin14OutputModelineC2ERK5QSizej6QFlagsINS0_4FlagEE");
extern "C" void mcpbrowser_output_modeline_ctor2(void *self, const void *size, uint32_t refresh,
                                          int flags) {
    static ctor_fn real_fn = nullptr;
    if (!real_fn)
        real_fn = reinterpret_cast<ctor_fn>(
            dlsym(RTLD_NEXT, "_ZN4KWin14OutputModelineC2ERK5QSizej6QFlagsINS0_4FlagEE"));
    if (refresh == 60000U)
        refresh = target_mhz();
    real_fn(self, size, refresh, flags);
}

using set_refresh_fn = void (*)(void *, int);
extern "C" void
mcpbrowser_renderloop_set_refresh(void *self, int refresh) asm("_ZN4KWin10RenderLoop14setRefreshRateEi");
extern "C" void mcpbrowser_renderloop_set_refresh(void *self, int refresh) {
    static set_refresh_fn real_fn = nullptr;
    if (!real_fn)
        real_fn = reinterpret_cast<set_refresh_fn>(
            dlsym(RTLD_NEXT, "_ZN4KWin10RenderLoop14setRefreshRateEi"));
    int effective = refresh == 60000 ? (int)target_mhz() : refresh;
    if (getenv("MCPBROWSER_KWIN_TRACE_REFRESH")) {
        fprintf(stderr, "MCPBROWSER_KWIN_REFRESH input_mhz=%d effective_mhz=%d\n", refresh, effective);
    }
    real_fn(self, effective);
}

// Parent Sway discards presentation feedback for nested KWin's root surface
// (the actual content lives in subsurfaces). Turn that discard into a synthetic
// VSync presentation so KWin can advance frames using the host cadence.
struct wp_presentation_feedback;
struct wl_output;
using real_add_listener_fn = int (*)(struct wl_proxy *, void (**)(void), void *);
using sync_output_fn = void (*)(void *, struct wp_presentation_feedback *, struct wl_output *);
using presented_fn = void (*)(void *, struct wp_presentation_feedback *, uint32_t, uint32_t,
                              uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
using discarded_fn = void (*)(void *, struct wp_presentation_feedback *);
using callback_done_fn = void (*)(void *, struct wl_callback *, uint32_t);

struct feedback_wrap;
struct callback_wrap {
    void *data = nullptr;
    callback_done_fn done = nullptr;
    feedback_wrap *feedback = nullptr;
    bool done_seen = false;
    struct timespec done_time{};
};
struct feedback_wrap {
    void *data = nullptr;
    sync_output_fn sync = nullptr;
    presented_fn presented = nullptr;
    discarded_fn discarded = nullptr;
    callback_wrap *callback = nullptr;
    bool discarded_seen = false;
};

static thread_local feedback_wrap *pending_feedback_pair = nullptr;

static uint32_t target_refresh_ns() { return (uint32_t)(1000000000000ULL / target_mhz()); }

// Quantize synthetic presentation timestamps onto one stable host-vsync grid.
// This does not generate frames: it only timestamps presentation feedback for
// frames KWin actually committed. If KWin skips a refresh interval, the next
// real frame naturally advances by multiple ticks.
static struct timespec quantized_present_time(const struct timespec &sample) {
    static thread_local bool initialized = false;
    static thread_local uint64_t epoch_ns = 0;
    static thread_local uint64_t last_tick = 0;
    static thread_local uint64_t samples = 0;
    static thread_local int64_t error_sum_ns = 0;
    static thread_local int64_t error_max_abs_ns = 0;
    static thread_local struct timespec report_started = {0, 0};

    const uint64_t interval = target_refresh_ns();
    const uint64_t now = timespec_to_ns(sample);
    if (!initialized) {
        // Anchor the phase at the first real callback; all later timestamps are
        // integer multiples of the advertised refresh period from this point.
        epoch_ns = now;
        last_tick = 0;
        report_started = sample;
        initialized = true;
        return sample;
    }

    const uint64_t elapsed = now > epoch_ns ? now - epoch_ns : 0;
    // Nearest tick minimizes the feedback error. Keep it strictly monotonic so
    // two closely-spaced commits cannot receive the same presentation time.
    uint64_t tick = (elapsed + interval / 2) / interval;
    if (tick <= last_tick) {
        tick = last_tick + 1;
    }
    const uint64_t quantized = epoch_ns + tick * interval;
    last_tick = tick;

    const int64_t error = (int64_t)quantized - (int64_t)now;
    const int64_t abs_error = error < 0 ? -error : error;
    error_sum_ns += error;
    if (abs_error > error_max_abs_ns)
        error_max_abs_ns = abs_error;
    samples++;

    const uint64_t report_elapsed = now - timespec_to_ns(report_started);
    if (getenv("MCPBROWSER_KWIN_TRACE_REFRESH") && report_elapsed >= 1000000000ULL && samples) {
        fprintf(stderr,
                "MCPBROWSER_KWIN_PRESENT_GRID samples=%llu avg_error_us=%.1f max_abs_error_us=%.1f "
                "interval_ns=%u\n",
                (unsigned long long)samples, (double)error_sum_ns / (double)samples / 1000.0,
                (double)error_max_abs_ns / 1000.0, target_refresh_ns());
        samples = 0;
        error_sum_ns = 0;
        error_max_abs_ns = 0;
        report_started = sample;
    }
    return ns_to_timespec(quantized);
}

static void unlink_and_free(feedback_wrap *w) {
    if (!w)
        return;
    if (pending_feedback_pair == w)
        pending_feedback_pair = nullptr;
    if (w->callback) {
        w->callback->feedback = nullptr;
        // A presentation event may arrive before the frame callback. Its
        // listener data remains live until that callback has actually run.
        if (w->callback->done_seen)
            delete w->callback;
        w->callback = nullptr;
    }
    delete w;
}

static void deliver_synthetic_presented(feedback_wrap *w, struct wp_presentation_feedback *fb,
                                        const struct timespec &when) {
    if (!w)
        return;
    const struct timespec presented_when = quantized_present_time(when);
    uint64_t sec = (uint64_t)presented_when.tv_sec;
    presented_fn presented = w->presented;
    void *original_data = w->data;
    callback_wrap *cb = w->callback;
    if (pending_feedback_pair == w)
        pending_feedback_pair = nullptr;
    if (cb)
        cb->feedback = nullptr;

    if (presented) {
        // KWin's own Wayland backend records wl_surface_frame.done with
        // steady_clock and explicitly calls it the best available estimate of
        // the host commit deadline. Feed that same clock domain back as the
        // synthetic presentation timestamp instead of sampling an unrelated
        // time at wp_presentation_feedback.discarded delivery.
        presented(original_data, fb, (uint32_t)(sec >> 32), (uint32_t)sec,
                  (uint32_t)presented_when.tv_nsec, target_refresh_ns(), 0, 0, 1u);
    } else if (w->discarded) {
        w->discarded(original_data, fb);
    }
    if (cb && cb->done_seen)
        delete cb;
    delete w;
}

static void wrap_sync(void *data, struct wp_presentation_feedback *fb, struct wl_output *out) {
    auto *w = static_cast<feedback_wrap *>(data);
    if (w->sync)
        w->sync(w->data, fb, out);
}
static void wrap_presented(void *data, struct wp_presentation_feedback *fb, uint32_t shi,
                           uint32_t slo, uint32_t nsec, uint32_t refresh, uint32_t qhi,
                           uint32_t qlo, uint32_t flags) {
    auto *w = static_cast<feedback_wrap *>(data);
    if (refresh == 0)
        refresh = target_refresh_ns();
    presented_fn presented = w->presented;
    void *original_data = w->data;
    callback_wrap *cb = w->callback;
    if (pending_feedback_pair == w)
        pending_feedback_pair = nullptr;
    if (cb)
        cb->feedback = nullptr;
    if (presented)
        presented(original_data, fb, shi, slo, nsec, refresh, qhi, qlo, flags | 1u);
    if (cb)
        free(cb);
    free(w);
}
static void wrap_discarded(void *data, struct wp_presentation_feedback *fb) {
    auto *w = static_cast<feedback_wrap *>(data);
    if (synth_presentation_mode() == SYNTH_LEGACY && w->presented) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        deliver_synthetic_presented(w, fb, now);
        return;
    }
    if (synth_presentation_mode() == SYNTH_CALLBACK && w->callback) {
        w->discarded_seen = true;
        if (w->callback->done_seen) {
            deliver_synthetic_presented(w, fb, w->callback->done_time);
        }
        return;
    }
    discarded_fn discarded = w->discarded;
    void *original_data = w->data;
    if (discarded)
        discarded(original_data, fb);
    unlink_and_free(w);
}

static void wrap_callback_done(void *data, struct wl_callback *callback, uint32_t time) {
    auto *cb = static_cast<callback_wrap *>(data);

    // Let KWin record frameCallbackTime first, then sample the same monotonic
    // clock. This keeps its presentationSafetyMargin small and positive.
    if (cb->done)
        cb->done(cb->data, callback, time);
    cb->done_seen = true;
    clock_gettime(CLOCK_MONOTONIC, &cb->done_time);

    // The original handler may synchronously release the presentation side.
    feedback_wrap *w = cb->feedback;
    if (!w) {
        delete cb;
        return;
    }
    if (w && w->discarded_seen) {
        // The feedback object is still alive because we deliberately deferred
        // KWin's discarded handler. Complete the frame now with the callback
        // timestamp; KWin will destroy both protocol objects while unwinding.
        deliver_synthetic_presented(w, nullptr, cb->done_time);
    }
}

extern "C" int wl_proxy_add_listener(struct wl_proxy *proxy, void (**implementation)(void),
                                     void *data) {
    static real_add_listener_fn real_add = nullptr;
    if (!real_add)
        real_add =
            reinterpret_cast<real_add_listener_fn>(dlsym(RTLD_NEXT, "wl_proxy_add_listener"));
    const char *klass = wl_proxy_get_class(proxy);
    const synth_mode mode = synth_presentation_mode();
    if (mode != SYNTH_OFF && klass && strcmp(klass, "wp_presentation_feedback") == 0 &&
        implementation) {
        auto *w = new (std::nothrow) feedback_wrap{};
        if (w) {
            w->data = data;
            w->sync = reinterpret_cast<sync_output_fn>(implementation[0]);
            w->presented = reinterpret_cast<presented_fn>(implementation[1]);
            w->discarded = reinterpret_cast<discarded_fn>(implementation[2]);
            static void (*wrapped[3])(void) = {
                reinterpret_cast<void (*)(void)>(wrap_sync),
                reinterpret_cast<void (*)(void)>(wrap_presented),
                reinterpret_cast<void (*)(void)>(wrap_discarded),
            };
            int result = real_add(proxy, wrapped, w);
            if (result == 0 && mode == SYNTH_CALLBACK) {
                pending_feedback_pair = w;
            } else if (result != 0) {
                delete w;
            }
            return result;
        }
    }
    if (mode == SYNTH_CALLBACK && klass && strcmp(klass, "wl_callback") == 0 && implementation &&
        pending_feedback_pair) {
        auto *cb = new (std::nothrow) callback_wrap{};
        if (cb) {
            feedback_wrap *w = pending_feedback_pair;
            pending_feedback_pair = nullptr;
            cb->data = data;
            cb->done = reinterpret_cast<callback_done_fn>(implementation[0]);
            cb->feedback = w;
            w->callback = cb;
            static void (*wrapped_callback[1])(void) = {
                reinterpret_cast<void (*)(void)>(wrap_callback_done),
            };
            int result = real_add(proxy, wrapped_callback, cb);
            if (result != 0) {
                w->callback = nullptr;
                delete cb;
            }
            return result;
        }
    }
    return real_add(proxy, implementation, data);
}
