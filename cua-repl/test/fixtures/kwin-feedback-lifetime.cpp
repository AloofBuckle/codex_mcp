#include "../native-shell/kwin-nested-refresh-shim.cpp"
#include <cassert>

static int completed = 0;

static void record_done(void *, wl_callback *, uint32_t) { ++completed; }

static callback_wrap *pair_with(feedback_wrap *feedback) {
    auto *callback = new callback_wrap{};
    callback->feedback = feedback;
    callback->done = record_done;
    feedback->callback = callback;
    return callback;
}

int main() {
    {
        auto *feedback = new feedback_wrap{};
        auto *callback = pair_with(feedback);
        unlink_and_free(feedback);
        assert(callback->feedback == nullptr);
        wrap_callback_done(callback, nullptr, 0);
    }
    {
        auto *feedback = new feedback_wrap{};
        auto *callback = pair_with(feedback);
        wrap_callback_done(callback, nullptr, 0);
        assert(callback->done_seen);
        unlink_and_free(feedback);
    }
    {
        auto *feedback = new feedback_wrap{};
        auto *callback = pair_with(feedback);
        callback->data = feedback;
        callback->done = [](void *data, wl_callback *, uint32_t) {
            ++completed;
            unlink_and_free(static_cast<feedback_wrap *>(data));
        };
        wrap_callback_done(callback, nullptr, 0);
    }
    assert(completed == 3);
}
