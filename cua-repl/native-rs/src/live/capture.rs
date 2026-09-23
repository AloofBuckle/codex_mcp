//! A Wayland client which leases committed output DMA-BUFs. It never allocates
//! a capture BO and never asks the compositor to copy or re-render each frame.
use super::gpu::{DamageRect, Dmabuf, Plane};
use crate::{DesktopInfo, settings::setting};
use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use std::{
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    path::PathBuf,
    time::Duration,
};
use wayland_client::{
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    backend::WaylandError,
    protocol::{wl_output, wl_registry},
};

mod protocol {
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!(
            "../native-shell/dmabuf-capture/mcpbrowser-dmabuf-capture-v1.xml"
        );
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!(
        "../native-shell/dmabuf-capture/mcpbrowser-dmabuf-capture-v1.xml"
    );
}
use protocol::{
    mcpbrowser_dmabuf_capture_frame_v1::{self, McpbrowserDmabufCaptureFrameV1},
    mcpbrowser_dmabuf_capture_manager_v1::McpbrowserDmabufCaptureManagerV1,
    mcpbrowser_dmabuf_capture_session_v1::{self, McpbrowserDmabufCaptureSessionV1},
};

pub fn monotonic_us() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // CLOCK_MONOTONIC is also used by the compositor's commit timestamps.
    unsafe {
        libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts);
    }
    ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1_000
}

fn flush_nonblocking(connection: &Connection) -> Result<()> {
    match connection.flush() {
        Ok(()) => Ok(()),
        Err(WaylandError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CursorState {
    #[serde(rename = "t")]
    pub kind: &'static str,
    pub x: i32,
    pub y: i32,
    pub visible: bool,
    pub shape: String,
    #[serde(rename = "hotspotX")]
    pub hotspot_x: i32,
    #[serde(rename = "hotspotY")]
    pub hotspot_y: i32,
}

impl Default for CursorState {
    fn default() -> Self {
        Self {
            kind: "cursor",
            x: 0,
            y: 0,
            visible: false,
            shape: "default".into(),
            hotspot_x: 0,
            hotspot_y: 0,
        }
    }
}

#[derive(Debug)]
pub struct CapturedFrame {
    pub buffer: Dmabuf,
    pub damage: Vec<DamageRect>,
    pub pts_us: u64,
    lease: McpbrowserDmabufCaptureFrameV1,
    acquire_fences: Vec<OwnedFd>,
}

impl CapturedFrame {
    pub fn merge_damage_from(&mut self, older: &CapturedFrame) {
        self.damage.extend_from_slice(&older.damage);
        if self.damage.len() > 32 {
            let mut x0 = self.buffer.width;
            let mut y0 = self.buffer.height;
            let mut x1 = 0u32;
            let mut y1 = 0u32;
            for rect in &self.damage {
                x0 = x0.min(rect.x);
                y0 = y0.min(rect.y);
                x1 = x1.max(rect.x.saturating_add(rect.width).min(self.buffer.width));
                y1 = y1.max(rect.y.saturating_add(rect.height).min(self.buffer.height));
            }
            self.damage.clear();
            if x1 > x0 && y1 > y0 {
                self.damage.push(DamageRect {
                    x: x0,
                    y: y0,
                    width: x1 - x0,
                    height: y1 - y0,
                });
            }
        }
    }

    /// Nonblocking acquire barrier. A Wayland ready event alone is not a GPU
    /// completion barrier. Explicit renderer fences take precedence; otherwise
    /// we export the DMA-BUF reservation object's existing writer fence.
    pub fn is_ready(&self) -> Result<bool> {
        for fd in &self.acquire_fences {
            let mut pollfd = libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut pollfd, 1, 0) };
            if result < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            ensure!(
                pollfd.revents & (libc::POLLERR | libc::POLLNVAL) == 0,
                "acquire fence failed"
            );
            if result == 0 {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

impl Drop for CapturedFrame {
    fn drop(&mut self) {
        // Caller must have finished VAProc reads before this release. It is
        // also safe to discard an unconsumed lease without waiting on its GPU
        // writer: the compositor continues owning its own producer dependency.
        self.lease.destroy();
    }
}

#[derive(Default)]
struct PartialFrame {
    proxy: Option<McpbrowserDmabufCaptureFrameV1>,
    width: u32,
    height: u32,
    fourcc: u32,
    modifier: u64,
    planes: Vec<Option<Plane>>,
    explicit_fence: Option<OwnedFd>,
    damage: Vec<DamageRect>,
}

#[derive(Default)]
struct State {
    manager: Option<McpbrowserDmabufCaptureManagerV1>,
    outputs: Vec<(wl_output::WlOutput, Option<String>)>,
    session: Option<McpbrowserDmabufCaptureSessionV1>,
    pending: Option<PartialFrame>,
    latest: Option<CapturedFrame>,
    cursor: CursorState,
    cursor_dirty: bool,
    error: Option<String>,
    captured: u64,
    replaced: u64,
}

pub struct Capture {
    connection: Connection,
    queue: EventQueue<State>,
    state: State,
    force_next: bool,
}

impl Capture {
    pub fn connect(desktop: &DesktopInfo) -> Result<Self> {
        let run = desktop
            .env
            .get("XDG_RUNTIME_DIR")
            .context("desktop runtime directory missing")?;
        let display = desktop
            .env
            .get("WAYLAND_DISPLAY")
            .context("desktop Wayland socket missing")?;
        let path = PathBuf::from(run).join(display);
        // Do not mutate process-wide environment used by concurrent input/RTC.
        let socket =
            UnixStream::connect(&path).with_context(|| format!("connect {}", path.display()))?;
        let connection = Connection::from_socket(socket)?;
        let mut queue = connection.new_event_queue::<State>();
        let qh = queue.handle();
        connection.display().get_registry(&qh, ());
        let mut state = State::default();
        queue.roundtrip(&mut state)?;
        queue.roundtrip(&mut state)?;
        let manager = state.manager.as_ref().context(
            "compositor lacks mcpbrowser_dmabuf_capture_manager_v1; no copy fallback is allowed",
        )?;
        let wanted = setting("MCPBROWSER_NATIVE_OUTPUT");
        let output = state
            .outputs
            .iter()
            .find(|(_, name)| name.as_deref() == Some(wanted.as_str()))
            .with_context(|| format!("Wayland output {wanted} not found"))?;
        state.session = Some(manager.get_session(&output.0, &qh, ()));
        let proxy = state.session.as_ref().unwrap().capture(1, &qh, ());
        state.pending = Some(PartialFrame {
            proxy: Some(proxy),
            ..Default::default()
        });
        connection.flush()?;
        tracing::info!(socket=%path.display(), output=%wanted,
            capture="leased-output-dmabuf", capture_blits=0,
            "native direct Wayland capture connected");
        Ok(Self {
            connection,
            queue,
            state,
            force_next: false,
        })
    }

    pub fn take_latest(&mut self) -> Option<CapturedFrame> {
        self.state.latest.take()
    }
    pub fn take_cursor(&mut self) -> Option<CursorState> {
        if !self.state.cursor_dirty {
            return None;
        }
        self.state.cursor_dirty = false;
        Some(self.state.cursor.clone())
    }
    pub fn counters(&self) -> (u64, u64) {
        (self.state.captured, self.state.replaced)
    }

    /// Cancel an idle damage-only request and ask KWin for a fresh complete
    /// output lease. Sparse streaming uses this to recover from packet loss
    /// without keeping an AV1/NV12 shadow framebuffer current on every frame.
    pub fn force_capture(&mut self) {
        self.state.latest.take();
        if let Some(pending) = self.state.pending.take()
            && let Some(proxy) = pending.proxy
        {
            proxy.destroy();
        }
        self.force_next = true;
    }

    fn rearm(&mut self) {
        if self.state.pending.is_none() && self.state.error.is_none() {
            let qh = self.queue.handle();
            let force = u32::from(self.force_next);
            self.force_next = false;
            let proxy = self.state.session.as_ref().unwrap().capture(force, &qh, ());
            self.state.pending = Some(PartialFrame {
                proxy: Some(proxy),
                ..Default::default()
            });
        }
    }

    pub fn pump(&mut self, wait: Duration, wake: &OwnedFd) -> Result<()> {
        self.queue.dispatch_pending(&mut self.state)?;
        self.rearm();
        // The Wayland socket is nonblocking. EAGAIN only means its send buffer
        // is temporarily full; POLLOUT/another pump will make progress. It is
        // not a compositor/capture failure and must not restart the GPU stream.
        flush_nonblocking(&self.connection)?;
        if let Some(guard) = self.queue.prepare_read() {
            let mut pfds = [
                libc::pollfd {
                    fd: self.connection.backend().poll_fd().as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: wake.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // ppoll keeps the encode-completion polling period below 1 ms;
            // when idle, a real Wayland event wakes us immediately.
            let ts = libc::timespec {
                tv_sec: wait.as_secs() as libc::time_t,
                tv_nsec: wait.subsec_nanos() as libc::c_long,
            };
            let ret = unsafe { libc::ppoll(pfds.as_mut_ptr(), 2, &ts, std::ptr::null()) };
            if ret < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() != std::io::ErrorKind::Interrupted {
                    return Err(e.into());
                }
            } else if ret > 0 {
                ensure!(
                    pfds[0].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) == 0,
                    "Wayland capture connection closed"
                );
                if pfds[1].revents & libc::POLLIN != 0 {
                    let mut counter = 0u64;
                    unsafe {
                        libc::read(wake.as_raw_fd(), (&mut counter as *mut u64).cast(), 8);
                    }
                }
                if pfds[0].revents & libc::POLLIN != 0 {
                    match guard.read() {
                        Ok(_) => {}
                        // ReadEventsGuard explicitly documents WouldBlock as a
                        // normal result when another readiness edge consumed no
                        // complete Wayland message. Do not tear down the GPU
                        // stream for that nonblocking condition.
                        Err(WaylandError::Io(error))
                            if error.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        self.queue.dispatch_pending(&mut self.state)?;
        if let Some(error) = self.state.error.take() {
            bail!("{error}");
        }
        self.rearm();
        flush_nonblocking(&self.connection)?;
        Ok(())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.state.latest.take();
        if let Some(pending) = self.state.pending.take() {
            if let Some(proxy) = pending.proxy {
                proxy.destroy();
            }
        }
        if let Some(session) = self.state.session.take() {
            session.destroy();
        }
        if let Some(manager) = self.state.manager.take() {
            manager.destroy();
        }
        let _ = self.connection.flush();
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            match interface.as_str() {
                "mcpbrowser_dmabuf_capture_manager_v1" => {
                    state.manager = Some(registry.bind(name, 1, qh, ()));
                }
                "wl_output" if version >= 4 => {
                    state.outputs.push((registry.bind(name, 4, qh, ()), None));
                }
                _ => {}
            }
        }
    }
}

impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(
        state: &mut Self,
        proxy: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Name { name } = event {
            if let Some(output) = state.outputs.iter_mut().find(|(o, _)| o.id() == proxy.id()) {
                output.1 = Some(name);
            }
        }
    }
}

wayland_client::delegate_noop!(State: ignore McpbrowserDmabufCaptureManagerV1);

impl Dispatch<McpbrowserDmabufCaptureSessionV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &McpbrowserDmabufCaptureSessionV1,
        event: mcpbrowser_dmabuf_capture_session_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use mcpbrowser_dmabuf_capture_session_v1::Event;
        match event {
            Event::CursorPosition { x, y, visible } => {
                state.cursor.x = x;
                state.cursor.y = y;
                state.cursor.visible = visible != 0;
                state.cursor_dirty = true;
            }
            Event::CursorShape {
                shape,
                hotspot_x,
                hotspot_y,
            } => {
                state.cursor.shape = if shape.is_empty() {
                    "default".into()
                } else {
                    shape
                };
                state.cursor.hotspot_x = hotspot_x;
                state.cursor.hotspot_y = hotspot_y;
                state.cursor_dirty = true;
            }
        }
    }
}

#[repr(C)]
struct ExportSyncFile {
    flags: u32,
    fd: i32,
}

fn implicit_acquire_fence(fd: &OwnedFd) -> Result<OwnedFd> {
    // _IOWR(DMA_BUF_BASE='b', 2, struct dma_buf_export_sync_file).
    const DMA_BUF_IOCTL_EXPORT_SYNC_FILE: libc::c_ulong = 0xc008_6202;
    let mut export = ExportSyncFile {
        flags: 1, /* DMA_BUF_SYNC_READ */
        fd: -1,
    };
    let ret = unsafe { libc::ioctl(fd.as_raw_fd(), DMA_BUF_IOCTL_EXPORT_SYNC_FILE, &mut export) };
    if ret < 0 {
        return Err(std::io::Error::last_os_error()).context("export capture acquire fence");
    }
    ensure!(export.fd >= 0, "invalid acquire sync_file fd");
    Ok(unsafe { OwnedFd::from_raw_fd(export.fd) })
}

impl State {
    fn finish_frame(&mut self, sec_hi: u32, sec_lo: u32, nsec: u32) -> Result<()> {
        let mut pending = self
            .pending
            .take()
            .context("unexpected ready without capture request")?;
        // Wrap proxy first so every validation/error path releases the lease.
        let lease = pending.proxy.take().context("capture frame has no lease")?;
        let mut frame = CapturedFrame {
            buffer: Dmabuf {
                width: pending.width,
                height: pending.height,
                fourcc: pending.fourcc,
                modifier: pending.modifier,
                planes: Vec::new(),
            },
            damage: if pending.damage.is_empty() {
                vec![DamageRect::full(pending.width, pending.height)]
            } else {
                std::mem::take(&mut pending.damage)
            },
            pts_us: ((u64::from(sec_hi) << 32) | u64::from(sec_lo)) * 1_000_000
                + u64::from(nsec) / 1_000,
            lease,
            acquire_fences: Vec::new(),
        };
        ensure!(
            !pending.planes.is_empty() && nsec < 1_000_000_000,
            "invalid capture descriptor/timestamp"
        );
        for plane in pending.planes {
            frame
                .buffer
                .planes
                .push(plane.context("capture plane missing")?);
        }
        if let Some(fence) = pending.explicit_fence {
            frame.acquire_fences.push(fence);
        } else {
            for plane in &frame.buffer.planes {
                frame
                    .acquire_fences
                    .push(implicit_acquire_fence(&plane.fd)?);
            }
        }
        self.captured += 1;
        if let Some(older) = self.latest.take() {
            frame.merge_damage_from(&older);
            self.replaced += 1;
        }
        self.latest = Some(frame);
        Ok(())
    }
}

impl Dispatch<McpbrowserDmabufCaptureFrameV1, ()> for State {
    fn event(
        state: &mut Self,
        proxy: &McpbrowserDmabufCaptureFrameV1,
        event: mcpbrowser_dmabuf_capture_frame_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use mcpbrowser_dmabuf_capture_frame_v1::Event;
        if state.error.is_some() {
            return;
        }
        if !state
            .pending
            .as_ref()
            .is_some_and(|p| p.proxy.as_ref().is_some_and(|v| v.id() == proxy.id()))
        {
            state.error = Some("event on a non-pending capture lease".into());
            return;
        }
        match event {
            Event::Buffer {
                width,
                height,
                fourcc,
                modifier_hi,
                modifier_lo,
                num_planes,
                transform,
            } => {
                if num_planes == 0 || num_planes > 4 || width == 0 || height == 0 || transform != 0
                {
                    state.error = Some("unsupported output DMA-BUF layout/transform".into());
                    return;
                }
                let p = state.pending.as_mut().unwrap();
                p.width = width;
                p.height = height;
                p.fourcc = fourcc;
                p.modifier = (u64::from(modifier_hi) << 32) | u64::from(modifier_lo);
                p.planes = (0..num_planes).map(|_| None).collect();
            }
            Event::Plane {
                index,
                fd,
                offset,
                stride,
                size,
            } => {
                let p = state.pending.as_mut().unwrap();
                if let Some(slot) = p.planes.get_mut(index as usize) {
                    if slot.is_some() {
                        state.error = Some("duplicate capture plane".into());
                    } else {
                        *slot = Some(Plane {
                            fd,
                            offset,
                            stride,
                            size: u64::from(size),
                        });
                    }
                } else {
                    state.error = Some("capture plane index out of range".into());
                }
            }
            Event::Fence { fd } => {
                state.pending.as_mut().unwrap().explicit_fence = Some(fd);
            }
            Event::Damage {
                x,
                y,
                width,
                height,
            } => {
                let p = state.pending.as_mut().unwrap();
                let valid = x >= 0
                    && y >= 0
                    && width > 0
                    && height > 0
                    && i64::from(x) + i64::from(width) <= i64::from(p.width)
                    && i64::from(y) + i64::from(height) <= i64::from(p.height)
                    && p.damage.len() < 64;
                if valid {
                    p.damage.push(DamageRect {
                        x: x as u32,
                        y: y as u32,
                        width: width as u32,
                        height: height as u32,
                    });
                } else {
                    state.error = Some("invalid capture damage rectangle".into());
                }
            }
            Event::Ready {
                tv_sec_hi,
                tv_sec_lo,
                tv_nsec,
            } => {
                if let Err(e) = state.finish_frame(tv_sec_hi, tv_sec_lo, tv_nsec) {
                    state.error = Some(format!("{e:#}"));
                }
            }
            Event::Failed { reason } => {
                state.error = Some(format!(
                    "compositor refused direct capture: reason={reason}"
                ));
            }
        }
    }
}
