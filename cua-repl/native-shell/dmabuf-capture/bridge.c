/* SPDX-License-Identifier: MIT
 * Included by the private wlroots export-dmabuf implementation. This protocol
 * intentionally does NOT use screencopy, an intermediate BO, or an extra draw.
 */
#include "mcpbrowser-dmabuf-capture-v1-protocol.h"
#include <limits.h>
#include <wlr/render/drm_syncobj.h>
#include <wlr/types/wlr_buffer.h>

struct mcpbrowser_capture_session;
struct mcpbrowser_capture_frame {
    struct wl_resource *resource;
    struct mcpbrowser_capture_session *session;
    struct wl_list link;
    struct wlr_buffer *buffer;
    bool waiting;
    bool force;
};

struct mcpbrowser_capture_session {
    struct wl_resource *resource;
    struct wlr_output *output;
    struct wl_list frames;
    struct wl_listener commit;
    struct wl_listener output_destroy;
    unsigned int count;
};

static void mcpbrowser_resource_destroy(struct wl_client *client, struct wl_resource *resource) {
    wl_resource_destroy(resource);
}

static const struct mcpbrowser_dmabuf_capture_frame_v1_interface mcpbrowser_frame_impl = {
    .destroy = mcpbrowser_resource_destroy,
};

static void mcpbrowser_frame_resource_destroy(struct wl_resource *resource) {
    struct mcpbrowser_capture_frame *frame = wl_resource_get_user_data(resource);
    if (!frame)
        return;
    if (frame->session)
        frame->session->count--;
    wl_list_remove(&frame->link);
    /* Native releases only after VAProc has consumed the RGB input. */
    wlr_buffer_unlock(frame->buffer);
    free(frame);
}

static void mcpbrowser_fail_waiting(struct mcpbrowser_capture_session *session, uint32_t reason) {
    struct mcpbrowser_capture_frame *frame;
    wl_list_for_each(frame, &session->frames, link) {
        if (frame->waiting) {
            frame->waiting = false;
            mcpbrowser_dmabuf_capture_frame_v1_send_failed(frame->resource, reason);
        }
    }
}

static void mcpbrowser_capture_commit(struct wl_listener *listener, void *data) {
    struct mcpbrowser_capture_session *session = wl_container_of(listener, session, commit);
    struct wlr_output_event_commit *event = data;
    if (!(event->state->committed & WLR_OUTPUT_STATE_BUFFER))
        return;
    struct mcpbrowser_capture_frame *frame;
    wl_list_for_each(frame, &session->frames, link) {
        if (!frame->waiting)
            continue;
        if (!frame->force && (event->state->committed & WLR_OUTPUT_STATE_DAMAGE) &&
            !pixman_region32_not_empty((pixman_region32_t *)&event->state->damage)) {
            continue;
        }
        struct wlr_dmabuf_attributes a = {0};
        bool has_dmabuf = wlr_buffer_get_dmabuf(event->state->buffer, &a);
        if (!has_dmabuf || a.n_planes < 1 || a.n_planes > 4 ||
            session->output->transform != WL_OUTPUT_TRANSFORM_NORMAL ||
            (event->state->buffer_src_box.width != 0 &&
             (event->state->buffer_src_box.x != 0 || event->state->buffer_src_box.y != 0 ||
              event->state->buffer_src_box.width != a.width ||
              event->state->buffer_src_box.height != a.height)) ||
            (event->state->buffer_dst_box.width != 0 &&
             (event->state->buffer_dst_box.x != 0 || event->state->buffer_dst_box.y != 0 ||
              event->state->buffer_dst_box.width != a.width ||
              event->state->buffer_dst_box.height != a.height))) {
            wlr_log(WLR_ERROR,
                    "MCPBrowser capture unsupported output: dma=%d planes=%d size=%dx%d transform=%d "
                    "src=%g,%g,%g,%g dst=%d,%d,%d,%d",
                    has_dmabuf, a.n_planes, a.width, a.height, session->output->transform,
                    event->state->buffer_src_box.x, event->state->buffer_src_box.y,
                    event->state->buffer_src_box.width, event->state->buffer_src_box.height,
                    event->state->buffer_dst_box.x, event->state->buffer_dst_box.y,
                    event->state->buffer_dst_box.width, event->state->buffer_dst_box.height);
            frame->waiting = false;
            mcpbrowser_dmabuf_capture_frame_v1_send_failed(frame->resource, 2);
            continue;
        }
        uint32_t sizes[4];
        bool valid = true;
        for (int i = 0; i < a.n_planes; ++i) {
            off_t size = lseek(a.fd[i], 0, SEEK_END);
            if (size <= 0 || size > UINT32_MAX) {
                valid = false;
                break;
            }
            sizes[i] = (uint32_t)size;
        }
        if (!valid) {
            wlr_log(WLR_ERROR, "MCPBrowser capture invalid DMA-BUF allocation size");
            frame->waiting = false;
            mcpbrowser_dmabuf_capture_frame_v1_send_failed(frame->resource, 2);
            continue;
        }
        int fence_fd = -1;
        if (event->state->committed & WLR_OUTPUT_STATE_WAIT_TIMELINE) {
            fence_fd = wlr_drm_syncobj_timeline_export_sync_file(event->state->wait_timeline,
                                                                 event->state->wait_point);
            if (fence_fd < 0) {
                frame->waiting = false;
                mcpbrowser_dmabuf_capture_frame_v1_send_failed(frame->resource, 4);
                continue;
            }
        }
        frame->buffer = wlr_buffer_lock(event->state->buffer);
        frame->waiting = false;
        mcpbrowser_dmabuf_capture_frame_v1_send_buffer(frame->resource, a.width, a.height, a.format,
                                                a.modifier >> 32, a.modifier & 0xffffffff,
                                                a.n_planes, session->output->transform);
        for (int i = 0; i < a.n_planes; ++i) {
            mcpbrowser_dmabuf_capture_frame_v1_send_plane(frame->resource, i, a.fd[i], a.offset[i],
                                                   a.stride[i], sizes[i]);
        }
        if (fence_fd >= 0) {
            mcpbrowser_dmabuf_capture_frame_v1_send_fence(frame->resource, fence_fd);
            close(fence_fd);
        }
        uint64_t sec = event->when->tv_sec;
        mcpbrowser_dmabuf_capture_frame_v1_send_ready(frame->resource, sec >> 32, sec & 0xffffffff,
                                               event->when->tv_nsec);
        /* Deliberately retain buffer and resource until frame.destroy. */
    }
}

static void mcpbrowser_output_gone(struct wl_listener *listener, void *data) {
    struct mcpbrowser_capture_session *session = wl_container_of(listener, session, output_destroy);
    mcpbrowser_fail_waiting(session, 1);
    wl_list_remove(&session->commit.link);
    wl_list_init(&session->commit.link);
    wl_list_remove(&session->output_destroy.link);
    wl_list_init(&session->output_destroy.link);
    session->output = NULL;
}

static void mcpbrowser_session_resource_destroy(struct wl_resource *resource) {
    struct mcpbrowser_capture_session *session = wl_resource_get_user_data(resource);
    if (!session)
        return;
    mcpbrowser_fail_waiting(session, 5);
    wl_list_remove(&session->commit.link);
    wl_list_remove(&session->output_destroy.link);
    if (session->output) {
        wlr_output_lock_software_cursors(session->output, false);
        wlr_output_lock_attach_render(session->output, false);
    }
    /* Ready leases may outlive the session; do NOT unlock them prematurely. */
    struct mcpbrowser_capture_frame *frame, *tmp;
    wl_list_for_each_safe(frame, tmp, &session->frames, link) {
        frame->session = NULL;
        wl_list_remove(&frame->link);
        wl_list_init(&frame->link);
    }
    free(session);
}

static void mcpbrowser_session_capture(struct wl_client *client, struct wl_resource *resource, uint32_t id,
                                uint32_t force) {
    struct mcpbrowser_capture_session *session = wl_resource_get_user_data(resource);
    struct mcpbrowser_capture_frame *frame = calloc(1, sizeof(*frame));
    if (!frame) {
        wl_client_post_no_memory(client);
        return;
    }
    frame->resource = wl_resource_create(client, &mcpbrowser_dmabuf_capture_frame_v1_interface, 1, id);
    if (!frame->resource) {
        free(frame);
        wl_client_post_no_memory(client);
        return;
    }
    wl_resource_set_implementation(frame->resource, &mcpbrowser_frame_impl, frame,
                                   mcpbrowser_frame_resource_destroy);
    frame->session = session;
    wl_list_insert(&session->frames, &frame->link);
    session->count++;
    if (!session->output || !session->output->enabled || session->count > 4) {
        mcpbrowser_dmabuf_capture_frame_v1_send_failed(frame->resource, session->count > 4 ? 3 : 1);
        return;
    }
    frame->waiting = true;
    frame->force = force != 0;
    if (frame->force)
        wlr_output_update_needs_frame(session->output);
}

static const struct mcpbrowser_dmabuf_capture_session_v1_interface mcpbrowser_session_impl = {
    .destroy = mcpbrowser_resource_destroy,
    .capture = mcpbrowser_session_capture,
};

static void mcpbrowser_get_session(struct wl_client *client, struct wl_resource *manager, uint32_t id,
                            struct wl_resource *output_resource) {
    struct mcpbrowser_capture_session *session = calloc(1, sizeof(*session));
    if (!session) {
        wl_client_post_no_memory(client);
        return;
    }
    session->resource = wl_resource_create(client, &mcpbrowser_dmabuf_capture_session_v1_interface, 1, id);
    if (!session->resource) {
        free(session);
        wl_client_post_no_memory(client);
        return;
    }
    wl_resource_set_implementation(session->resource, &mcpbrowser_session_impl, session,
                                   mcpbrowser_session_resource_destroy);
    wl_list_init(&session->frames);
    wl_list_init(&session->commit.link);
    wl_list_init(&session->output_destroy.link);
    session->output = wlr_output_from_resource(output_resource);
    if (!session->output)
        return;
    session->commit.notify = mcpbrowser_capture_commit;
    session->output_destroy.notify = mcpbrowser_output_gone;
    wl_signal_add(&session->output->events.commit, &session->commit);
    wl_signal_add(&session->output->events.destroy, &session->output_destroy);
    /* Lease a complete output, not a 1x1 solid-color/direct-scanout buffer with
     * viewport transforms. This is the normal output composition, not an
     * additional screencopy render. The old screencopy path also held this lock.
     */
    wlr_output_lock_attach_render(session->output, true);
    /* Embed cursor once in the normal output composition; no capture blit. */
    wlr_output_lock_software_cursors(session->output, true);
}

static const struct mcpbrowser_dmabuf_capture_manager_v1_interface mcpbrowser_manager_impl = {
    .destroy = mcpbrowser_resource_destroy,
    .get_session = mcpbrowser_get_session,
};

static void mcpbrowser_manager_bind(struct wl_client *client, void *data, uint32_t version, uint32_t id) {
    struct wl_resource *resource =
        wl_resource_create(client, &mcpbrowser_dmabuf_capture_manager_v1_interface, 1, id);
    if (!resource) {
        wl_client_post_no_memory(client);
        return;
    }
    wl_resource_set_implementation(resource, &mcpbrowser_manager_impl, NULL, NULL);
}

static void mcpbrowser_dmabuf_capture_create(struct wl_display *display) {
    if (!wl_global_create(display, &mcpbrowser_dmabuf_capture_manager_v1_interface, 1, NULL,
                          mcpbrowser_manager_bind)) {
        wlr_log(WLR_ERROR, "MCPBrowser DMA-BUF lease global creation failed");
    } else {
        wlr_log(WLR_INFO, "MCPBrowser DMA-BUF lease capture enabled: no screencopy blit");
    }
}
