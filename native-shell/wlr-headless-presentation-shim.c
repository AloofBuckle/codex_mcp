#define _GNU_SOURCE
#define WLR_USE_UNSTABLE

#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_presentation_time.h>

typedef void (*real_send_presented_fn)(struct wlr_presentation_feedback *,
                                       const struct wlr_presentation_event *);

static uint64_t timespec_to_ns(uint64_t sec, uint32_t nsec) {
    return sec * 1000000000ULL + (uint64_t)nsec;
}

static void ns_to_event_time(uint64_t ns, struct wlr_presentation_event *event) {
    event->tv_sec = ns / 1000000000ULL;
    event->tv_nsec = (uint32_t)(ns % 1000000000ULL);
}

/*
 * The headless backend has no hardware vblank clock. Its presentation event is
 * delivered from the Wayland event loop, so using that delivery instant as the
 * presentation timestamp feeds scheduler jitter back into nested compositors.
 *
 * Keep one virtual vblank phase for the single Native headless output. We do
 * not generate events or frames here: each real presentation event is merely
 * timestamped at the most recent tick of the advertised refresh grid. Skipped
 * real frames therefore skip ticks naturally, preserving VFR semantics.
 */
static uint64_t quantize_headless_present(struct wlr_output *output, uint32_t refresh_ns,
                                          uint64_t sample_ns) {
    static struct wlr_output *grid_output = NULL;
    static uint32_t grid_refresh_ns = 0;
    static uint64_t grid_epoch_ns = 0;
    static uint64_t grid_last_ns = 0;
    static uint64_t report_started_ns = 0;
    static uint64_t report_samples = 0;
    static uint64_t report_age_sum_ns = 0;
    static uint64_t report_age_max_ns = 0;

    if (grid_output != output || grid_refresh_ns != refresh_ns || grid_epoch_ns == 0) {
        grid_output = output;
        grid_refresh_ns = refresh_ns;
        grid_epoch_ns = sample_ns;
        grid_last_ns = sample_ns;
        report_started_ns = sample_ns;
        report_samples = 0;
        report_age_sum_ns = 0;
        report_age_max_ns = 0;
        return sample_ns;
    }

    const uint64_t elapsed_ns = sample_ns >= grid_epoch_ns ? sample_ns - grid_epoch_ns : 0;
    const uint64_t tick = elapsed_ns / refresh_ns;
    uint64_t grid_ns = grid_epoch_ns + tick * (uint64_t)refresh_ns;
    if (grid_ns < grid_last_ns) {
        grid_ns = grid_last_ns;
    }
    grid_last_ns = grid_ns;

    const uint64_t age_ns = sample_ns >= grid_ns ? sample_ns - grid_ns : 0;
    report_samples++;
    report_age_sum_ns += age_ns;
    if (age_ns > report_age_max_ns) {
        report_age_max_ns = age_ns;
    }
    if (getenv("MCPBROWSER_WLR_PRESENT_TRACE") && sample_ns - report_started_ns >= 1000000000ULL &&
        report_samples > 0) {
        fprintf(stderr,
                "MCPBROWSER_WLR_PRESENT_GRID samples=%llu avg_age_us=%.1f max_age_us=%.1f refresh_ns=%u\n",
                (unsigned long long)report_samples,
                (double)report_age_sum_ns / (double)report_samples / 1000.0,
                (double)report_age_max_ns / 1000.0, refresh_ns);
        report_started_ns = sample_ns;
        report_samples = 0;
        report_age_sum_ns = 0;
        report_age_max_ns = 0;
    }
    return grid_ns;
}

/*
 * wlroots' headless backend reports the configured wl_output refresh rate, but
 * its present event leaves timestamp/refresh/VSYNC fields at zero. Chromium's
 * Wayland frame clock treats that as unknown presentation timing and falls
 * back to roughly 60 Hz even when the headless output is configured for 120 Hz.
 *
 * Fix only incomplete presentation feedback. Real DRM/X11/Wayland backends
 * that already provide presentation timing pass through untouched.
 */
void wlr_presentation_feedback_send_presented(struct wlr_presentation_feedback *feedback,
                                              const struct wlr_presentation_event *event) {
    static real_send_presented_fn real_send;
    if (real_send == NULL) {
        real_send =
            (real_send_presented_fn)dlsym(RTLD_NEXT, "wlr_presentation_feedback_send_presented");
    }

    struct wlr_presentation_event fixed = *event;
    if (fixed.refresh == 0 && fixed.output != NULL && fixed.output->refresh > 0) {
        /* output->refresh is mHz; presentation refresh is nanoseconds. */
        fixed.refresh = (uint32_t)(1000000000000ULL / (uint32_t)fixed.output->refresh);

        uint64_t sample_ns;
        if (fixed.tv_sec == 0 && fixed.tv_nsec == 0) {
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            sample_ns = timespec_to_ns((uint64_t)now.tv_sec, (uint32_t)now.tv_nsec);
        } else {
            sample_ns = timespec_to_ns(fixed.tv_sec, fixed.tv_nsec);
        }
        ns_to_event_time(quantize_headless_present(fixed.output, fixed.refresh, sample_ns), &fixed);
        if (fixed.seq == 0) {
            fixed.seq = fixed.output->commit_seq;
        }
        /* wp_presentation_feedback_kind_vsync */
        fixed.flags |= 0x1u;
    }

    real_send(feedback, &fixed);
}
