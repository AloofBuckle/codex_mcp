# Native Live

Native Live is an independent Rust remote-desktop backend. Its production video
producer does not spawn a recorder or depend on FFmpeg, AVCodec, AVFilter, MWP1,
or a raw-image upload/readback path.

## Production video path

```text
Native applications / nested KWin
  -> Sway's normal output composition (DMA-BUF)
  -> mcpbrowser_dmabuf_capture_v1 output-buffer lease
  -> cached PRIME2 import of that same buffer into libva
  -> one VAProc full-range RGB -> NV12 conversion
  -> oneVPL MFXVideoENCODE_EncodeFrameAsync (video memory)
  -> AV1 low-overhead OBU + Rust sequence-header handling
  -> in-process VideoHub
  -> existing UDP WebRTC AV1 track / MWD1 DataChannel
```

The private protocol is defined in `native-shell/dmabuf-capture/`. Its wlroots
bridge leases the actual committed output with `wlr_buffer_lock`; it does not
allocate a capture GBM BO or invoke a second output/screencopy render pass.
A capture session requires a complete normally composed output and software
cursor composition. This preserves the existing desktop rather than promising
to remove KWin/Sway composition itself. Unknown compressed modifiers, multi-plane
RGB inputs, output transforms and cross-GPU transfers are rejected, not silently
copied through a compatibility path.

`native-rs/src/live/capture.rs` owns the Wayland connection and leases.
`gpu.rs` owns PRIME2 import caching, VAProc surfaces, allocator and oneVPL FFI.
`codec.rs` owns the producer lifetime, latest-frame scheduling, IDR latch, PTS and
VideoHub. The GPU core has no Smithay or FFmpeg dependency. Native input and the
existing network/frontend protocols are independent of this producer rewrite.

## Ownership and synchronization

A ready Wayland event is not assumed to be a GPU completion barrier. The client
waits on an explicit renderer sync_file, or exports the DMA-BUF reservation
writer fence when the producer uses implicit synchronization. Importing a DMA-BUF
creates a view; it does not copy its pixels. Imports are cached by allocation
identity and layout with a bounded eight-entry cache and retained FD identity.

The compositor cannot recycle a leased RGB output while VAProc reads it.
After VAProc's NV12 output is synchronized, the RGB lease is returned immediately.
The NV12 surface stays owned until oneVPL completion and the input Locked field
confirm that encoding has released it. Error teardown destroys GPU consumers
before returning outstanding leases. There are three NV12 surfaces and one
in-flight encode slot; raw pixel memory is never mapped to the CPU.

Compressed AV1 output is copied into Rust-owned packet storage for delivery.
This is not a claim that all copies, all GPU work, or desktop composition vanish.
The eliminated work is the additional full-frame RGB screencopy pass and its
intermediate capture buffers, unnecessary conversion of superseded captures,
and repeated capture/conversion of an unchanged desktop.

## Scheduling, quality and lifecycle

Real damaged output commits drive capture, with a configured active ceiling
(default 120 fps). Only the newest unconverted lease is retained while the
encoder is busy. The last update of a burst is retained until the rate ceiling
permits it, rather than being discarded and leaving a stale desktop forever.

An unchanged desktop reuses the last NV12 surface for the default 1 fps
heartbeat and for an immediate IDR request. It does not request another output
render, RGB capture or VAProc conversion. New peers and recovery requests set a
bounded in-process IDR latch. DEVICE_BUSY does not sleep in the MFX submit call
or consume that latch; the producer polls and accepts newer input instead.

The first subscriber opens capture and encoding. Approximately two seconds after
the last subscriber leaves, all encoder sessions, surfaces, cached FDs and
Wayland leases are released. PTS and frame identity remain monotonic across
stream restarts. Initialization failures are reported in health and use bounded
retry backoff; no recorder, software encoder, TCP or WebSocket media fallback is
introduced.

The current profile is AV1 Main, no B frames, AsyncDepth 1, VBR 3 Mbps target /
10 Mbps maximum, and a one-frame VBV. VAProc explicitly describes full-range sRGB
input and full-range BT.709 NV12 output; AV1 carries the same full-range BT.709
metadata. A complete output needs color conversion, not alpha recomposition.
The small low-latency VBV can make the initial keyframe less detailed than
subsequent refinement frames; this is distinct from an RGB range/matrix error.

## Health and validation

`/health` includes `pipeline`: backend, capture mode, active state, session starts,
failures, captured/converted/encoded frame counts, heartbeat reuse, busy events,
conversion/encode/source-to-packet timing and the last error. The static path
should increase encoded/heartbeat counts without increasing captured/converted.

`cargo test --manifest-path native-rs/Cargo.toml --lib --bin mcpbrowser-cua-native-live`
checks the protocol-adjacent metadata, AV1 sequence-header handling and existing
RTC behavior. `examples/direct_gpu_probe.rs` is an opt-in real-GPU producer test:
it records OBU output and diagnostics, requests a mid-stream IDR, checks idle
teardown, reconnects, and checks random access and non-resetting timestamps.
FFmpeg may be used as an external test decoder; it is not a producer dependency.

The private wlroots extension is reproducibly applied and built with:

```sh
cargo run --quiet --manifest-path control-rs/Cargo.toml -- prepare-wlroots WLROOTS_SOURCE --build WLROOTS_BUILD
```

The Rust command changes/builds only the selected source tree; it does not install libraries or restart a desktop. Deployment must
atomically replace the private wlroots library and Native Live binary, then
restart the native compositor and Native Live. Do not overwrite an in-use shared
library in place. Browser's separate compositor/encoder does not need restarting.
