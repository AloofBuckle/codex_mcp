//! Native's sole production video producer: leased Wayland output DMA-BUF,
//! cached PRIME2 import, one RGB->NV12 conversion, direct oneVPL, in-process OBU.
use super::{
    capture::{Capture, CapturedFrame, CursorState, monotonic_us},
    gpu::{self, Encoder, EncoderInput, GopConfig, RateControlConfig, RateControlMode},
};
use crate::{
    DesktopInfo,
    settings::{setting, video_profile},
};
use anyhow::{Context, Result, bail, ensure};
use bytes::Bytes;
use mcpbrowser_media_session::Demand;
use serde::{Deserialize, Serialize};
use std::{
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::Path,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc, watch};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    Av1,
}
impl VideoCodec {
    pub fn as_str(self) -> &'static str {
        "av1"
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct CodecCapability {
    pub codec: VideoCodec,
    pub available: bool,
    #[serde(rename = "hardwareAvailable")]
    pub hardware_available: bool,
    #[serde(rename = "backendReady")]
    pub backend_ready: bool,
    pub device: Option<String>,
    pub reason: Option<String>,
}
#[derive(Debug, Clone)]
pub struct EncodedFrame {
    pub sequence: u64,
    pub pts90k: u32,
    pub source_pts_us: u64,
    pub keyframe: bool,
    pub has_config: bool,
    pub data: Bytes,
    pub duration: Duration,
    pub published_at: Instant,
}

#[derive(Default)]
struct PipelineStats {
    active: AtomicBool,
    starts: AtomicU64,
    failures: AtomicU64,
    captured: AtomicU64,
    converted: AtomicU64,
    encoded: AtomicU64,
    dropped_before_vpp: AtomicU64,
    heartbeat_encoded: AtomicU64,
    device_busy: AtomicU64,
    convert_us: AtomicU64,
    vpp_pixels: AtomicU64,
    vpp_full_pixels: AtomicU64,
    dirty_encoder_submits: AtomicU64,
    encode_us: AtomicU64,
    capture_to_packet_us: AtomicU64,
    capture_to_packet_max_us: AtomicU64,
    last_error: Mutex<Option<String>>,
}
#[derive(Clone)]
pub struct VideoHub {
    tx: broadcast::Sender<Arc<EncodedFrame>>,
    demand: Demand,
    cursor_tx: watch::Sender<CursorState>,
    keyframe_tx: mpsc::Sender<()>,
    wake: Arc<OwnedFd>,
    stats: Arc<PipelineStats>,
}
fn wake(fd: &OwnedFd) {
    let one = 1u64;
    // EAGAIN means a wake is already pending; no event may be lost.
    unsafe {
        libc::write(fd.as_raw_fd(), (&one as *const u64).cast(), 8);
    }
}
impl VideoHub {
    pub fn codec(&self) -> VideoCodec {
        VideoCodec::Av1
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<EncodedFrame>> {
        let rx = self.tx.subscribe();
        wake(&self.wake);
        rx
    }
    pub fn demand(&self) -> &Demand {
        &self.demand
    }
    pub fn viewer_count(&self) -> usize {
        self.demand.count()
    }
    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
    pub fn subscribe_cursor(&self) -> watch::Receiver<CursorState> {
        self.cursor_tx.subscribe()
    }
    pub fn request_keyframe(&self) {
        let _ = self.keyframe_tx.try_send(());
        wake(&self.wake);
    }
    pub fn diagnostics(&self) -> serde_json::Value {
        let s = &self.stats;
        let n = s.encoded.load(Ordering::Relaxed);
        let c = s.converted.load(Ordering::Relaxed);
        let vpp_pixels = s.vpp_pixels.load(Ordering::Relaxed);
        let vpp_full_pixels = s.vpp_full_pixels.load(Ordering::Relaxed);
        serde_json::json!({
            "backend":"onevpl-ffi", "capture":"wayland-output-dmabuf-lease",
            "active":s.active.load(Ordering::Relaxed),
            "capture_copy_passes":0, "cpu_pixel_readbacks":0, "ffmpeg":false,
            "nv12_pool":gpu::PIPELINE_DEPTH, "encode_async_depth":1,
            "starts":s.starts.load(Ordering::Relaxed), "failures":s.failures.load(Ordering::Relaxed),
            "captured":s.captured.load(Ordering::Relaxed), "converted":c, "encoded":n,
            "dropped_before_vpp":s.dropped_before_vpp.load(Ordering::Relaxed),
            "heartbeat_encoded":s.heartbeat_encoded.load(Ordering::Relaxed),
            "device_busy":s.device_busy.load(Ordering::Relaxed),
            "convert_avg_us":s.convert_us.load(Ordering::Relaxed)/c.max(1),
            "vpp_pixels":vpp_pixels,
            "vpp_pixel_ratio":if vpp_full_pixels == 0 { 0.0 } else { vpp_pixels as f64 / vpp_full_pixels as f64 },
            "dirty_encoder_submits":s.dirty_encoder_submits.load(Ordering::Relaxed),
            "encode_avg_us":s.encode_us.load(Ordering::Relaxed)/n.max(1),
            "capture_to_packet_avg_us":s.capture_to_packet_us.load(Ordering::Relaxed)/n.max(1),
            "capture_to_packet_max_us":s.capture_to_packet_max_us.load(Ordering::Relaxed),
            "last_error":s.last_error.lock().ok().and_then(|v| v.clone()),
        })
    }
}
#[derive(Debug, Clone)]
pub struct EncoderSelection {
    pub codec: VideoCodec,
    pub capture_device: String,
    pub encode_device: String,
    pub onevpl_vendor_impl_id: u32,
    pub max_fps: u32,
    pub idle_fps: u32,
    pub rate_control: RateControlConfig,
    pub gop: GopConfig,
    pub capabilities: Vec<CodecCapability>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoProfileYaml {
    codec: String,
    one_vpl: OneVplYaml,
    rate_control: RateControlYaml,
    gop: GopYaml,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OneVplYaml {
    vendor_impl_id: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GopYaml {
    pictures: u16,
    ref_distance: u16,
    idr_interval: u16,
    strict: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateControlYaml {
    mode: String,
    target_usage: u16,
    cbr: CbrYaml,
    vbr: VbrYaml,
    cqp: CqpYaml,
    icq: IcqYaml,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CbrYaml {
    target_kbps: u32,
    buffer_frames: u32,
    initial_delay_frames: u32,
    #[serde(default)]
    buffer_size_kb: Option<u32>,
    #[serde(default)]
    initial_delay_kb: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VbrYaml {
    target_kbps: u32,
    max_kbps: u32,
    buffer_frames: u32,
    initial_delay_frames: u32,
    #[serde(default)]
    buffer_size_kb: Option<u32>,
    #[serde(default)]
    initial_delay_kb: Option<u32>,
    #[serde(default)]
    max_frame_size_i_bytes: Option<u32>,
    #[serde(default)]
    max_frame_size_p_bytes: Option<u32>,
    low_delay_brc: bool,
}

#[derive(Debug, Deserialize)]
struct CqpYaml {
    qpi: u16,
    qpp: u16,
    qpb: u16,
}

#[derive(Debug, Deserialize)]
struct IcqYaml {
    quality: u16,
}

impl VideoProfileYaml {
    fn native_defaults() -> Self {
        Self {
            codec: "av1".into(),
            one_vpl: OneVplYaml { vendor_impl_id: 0 },
            gop: GopYaml {
                pictures: u16::MAX,
                ref_distance: 1,
                idr_interval: 0,
                strict: true,
            },
            rate_control: RateControlYaml {
                mode: "vbr".into(),
                target_usage: 7,
                cbr: CbrYaml {
                    target_kbps: 3000,
                    buffer_frames: 1,
                    initial_delay_frames: 1,
                    buffer_size_kb: None,
                    initial_delay_kb: None,
                },
                vbr: VbrYaml {
                    target_kbps: 3000,
                    max_kbps: 10000,
                    buffer_frames: 1,
                    initial_delay_frames: 1,
                    buffer_size_kb: None,
                    initial_delay_kb: None,
                    max_frame_size_i_bytes: None,
                    max_frame_size_p_bytes: None,
                    low_delay_brc: true,
                },
                cqp: CqpYaml {
                    qpi: 128,
                    qpp: 128,
                    qpb: 128,
                },
                icq: IcqYaml { quality: 26 },
            },
        }
    }
}

pub fn discover_selection(desktop: &DesktopInfo) -> Result<EncoderSelection> {
    ensure!(
        setting("MCPBROWSER_NATIVE_LIVE_CODEC") == "av1",
        "Native supports only direct oneVPL AV1"
    );
    let capture_device = match setting("MCPBROWSER_NATIVE_LIVE_CAPTURE_NODE") {
        value if value.is_empty() => desktop.render_node.clone(),
        value => value,
    };
    let encode_device = match setting("MCPBROWSER_NATIVE_LIVE_ENCODER_NODE") {
        value if value.is_empty() => capture_device.clone(),
        value => value,
    };
    ensure!(
        same_device_node(&capture_device, &encode_device)
            && same_device_node(&capture_device, &desktop.render_node),
        "capture, compositor and encoder must use the same render node; no cross-GPU copy fallback"
    );
    gpu::probe(Path::new(&encode_device))?;
    let max_fps = env_u32("MCPBROWSER_NATIVE_LIVE_MAX_FPS", 120, 1, 240)?;
    let yaml = match video_profile("native")? {
        Some(value) => serde_yaml::from_value::<VideoProfileYaml>(value)
            .context("parse video.native from shared YAML")?,
        None => VideoProfileYaml::native_defaults(),
    };
    ensure!(yaml.codec == "av1", "video.native.codec must be av1");
    let mode_name =
        explicit_env("MCPBROWSER_NATIVE_LIVE_RC_MODE").unwrap_or(yaml.rate_control.mode);
    let mode = match mode_name.as_str() {
        "cbr" => RateControlMode::Cbr,
        "vbr" => RateControlMode::Vbr,
        "cqp" => RateControlMode::Cqp,
        "icq" => RateControlMode::Icq,
        other => bail!("unsupported MCPBROWSER_NATIVE_LIVE_RC_MODE={other:?}"),
    };
    let vbr_target = env_u32_compat_override(
        "MCPBROWSER_NATIVE_LIVE_VBR_TARGET_KBPS",
        "MCPBROWSER_NATIVE_LIVE_BITRATE_KBPS",
        yaml.rate_control.vbr.target_kbps,
        100,
        200_000,
    )?;
    let vbr_max = env_u32_compat_override(
        "MCPBROWSER_NATIVE_LIVE_VBR_MAX_KBPS",
        "MCPBROWSER_NATIVE_LIVE_MAX_BITRATE_KBPS",
        yaml.rate_control.vbr.max_kbps,
        vbr_target,
        200_000,
    )?;
    let rate_control = RateControlConfig {
        mode,
        target_usage: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_TARGET_USAGE",
            yaml.rate_control.target_usage as u32,
            1,
            7,
        )? as u16,
        cbr_target_kbps: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_CBR_TARGET_KBPS",
            yaml.rate_control.cbr.target_kbps,
            100,
            200_000,
        )?,
        cbr_buffer_frames: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_CBR_BUFFER_FRAMES",
            yaml.rate_control.cbr.buffer_frames,
            1,
            16,
        )?,
        cbr_initial_delay_frames: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_CBR_INITIAL_DELAY_FRAMES",
            yaml.rate_control.cbr.initial_delay_frames,
            0,
            16,
        )?,
        cbr_buffer_size_kb: env_optional_u32_override(
            "MCPBROWSER_NATIVE_LIVE_CBR_BUFFER_SIZE_KB",
            yaml.rate_control.cbr.buffer_size_kb,
            1,
            1_000_000,
        )?,
        cbr_initial_delay_kb: env_optional_u32_override(
            "MCPBROWSER_NATIVE_LIVE_CBR_INITIAL_DELAY_KB",
            yaml.rate_control.cbr.initial_delay_kb,
            0,
            1_000_000,
        )?,
        vbr_target_kbps: vbr_target,
        vbr_max_kbps: vbr_max,
        vbr_buffer_frames: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_VBR_BUFFER_FRAMES",
            yaml.rate_control.vbr.buffer_frames,
            1,
            16,
        )?,
        vbr_initial_delay_frames: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_VBR_INITIAL_DELAY_FRAMES",
            yaml.rate_control.vbr.initial_delay_frames,
            0,
            16,
        )?,
        vbr_buffer_size_kb: env_optional_u32_override(
            "MCPBROWSER_NATIVE_LIVE_VBR_BUFFER_SIZE_KB",
            yaml.rate_control.vbr.buffer_size_kb,
            1,
            1_000_000,
        )?,
        vbr_initial_delay_kb: env_optional_u32_override(
            "MCPBROWSER_NATIVE_LIVE_VBR_INITIAL_DELAY_KB",
            yaml.rate_control.vbr.initial_delay_kb,
            0,
            1_000_000,
        )?,
        vbr_max_frame_size_i_bytes: env_optional_u32_override(
            "MCPBROWSER_NATIVE_LIVE_VBR_MAX_FRAME_SIZE_I_BYTES",
            yaml.rate_control.vbr.max_frame_size_i_bytes,
            1,
            10_000_000,
        )?,
        vbr_max_frame_size_p_bytes: env_optional_u32_override(
            "MCPBROWSER_NATIVE_LIVE_VBR_MAX_FRAME_SIZE_P_BYTES",
            yaml.rate_control.vbr.max_frame_size_p_bytes,
            1,
            10_000_000,
        )?,
        vbr_low_delay_brc: env_bool_override(
            "MCPBROWSER_NATIVE_LIVE_VBR_LOW_DELAY_BRC",
            yaml.rate_control.vbr.low_delay_brc,
        )?,
        cqp_qpi: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_CQP_QPI",
            yaml.rate_control.cqp.qpi as u32,
            0,
            255,
        )? as u16,
        cqp_qpp: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_CQP_QPP",
            yaml.rate_control.cqp.qpp as u32,
            0,
            255,
        )? as u16,
        cqp_qpb: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_CQP_QPB",
            yaml.rate_control.cqp.qpb as u32,
            0,
            255,
        )? as u16,
        icq_quality: env_u32_override(
            "MCPBROWSER_NATIVE_LIVE_ICQ_QUALITY",
            yaml.rate_control.icq.quality as u32,
            1,
            51,
        )? as u16,
    };
    let gop = GopConfig {
        pictures: yaml.gop.pictures,
        ref_distance: yaml.gop.ref_distance,
        idr_interval: yaml.gop.idr_interval,
        strict: yaml.gop.strict,
    };
    gop.validate()?;
    let capability = CodecCapability {
        codec: VideoCodec::Av1,
        available: true,
        hardware_available: true,
        backend_ready: true,
        device: Some(encode_device.clone()),
        reason: None,
    };
    Ok(EncoderSelection {
        codec: VideoCodec::Av1,
        capture_device,
        encode_device,
        onevpl_vendor_impl_id: yaml.one_vpl.vendor_impl_id,
        max_fps,
        idle_fps: env_u32("MCPBROWSER_NATIVE_LIVE_IDLE_FPS", 1, 0, max_fps)?,
        rate_control,
        gop,
        capabilities: vec![capability],
    })
}

fn explicit_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn env_u32_override(name: &str, fallback: u32, min: u32, max: u32) -> Result<u32> {
    let value = match explicit_env(name) {
        Some(raw) => raw.parse().with_context(|| format!("invalid {name}"))?,
        None => fallback,
    };
    ensure!(
        (min..=max).contains(&value),
        "{name} must be within {min}..={max}"
    );
    Ok(value)
}

fn env_optional_u32_override(
    name: &str,
    fallback: Option<u32>,
    min: u32,
    max: u32,
) -> Result<Option<u32>> {
    let value = explicit_env(name)
        .map(|raw| raw.parse().with_context(|| format!("invalid {name}")))
        .transpose()?
        .or(fallback);
    if let Some(value) = value {
        ensure!(
            (min..=max).contains(&value),
            "{name} must be within {min}..={max}"
        );
    }
    Ok(value)
}

fn env_u32_compat_override(
    name: &str,
    compat: &str,
    fallback: u32,
    min: u32,
    max: u32,
) -> Result<u32> {
    let value = explicit_env(name)
        .or_else(|| explicit_env(compat))
        .map(|raw| raw.parse().with_context(|| format!("invalid {name}")))
        .transpose()?
        .unwrap_or(fallback);
    ensure!(
        (min..=max).contains(&value),
        "{name} must be within {min}..={max}"
    );
    Ok(value)
}

fn env_bool_override(name: &str, fallback: bool) -> Result<bool> {
    let Some(raw) = explicit_env(name) else {
        return Ok(fallback);
    };
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("invalid {name}"),
    }
}
fn env_u32(name: &str, fallback: u32, min: u32, max: u32) -> Result<u32> {
    let raw = setting(name);
    let value = if raw.is_empty() {
        fallback
    } else {
        raw.parse().with_context(|| format!("invalid {name}"))?
    };
    ensure!(
        (min..=max).contains(&value),
        "{name} must be within {min}..={max}"
    );
    Ok(value)
}
fn same_device_node(lhs: &str, rhs: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(lhs), std::fs::metadata(rhs)) {
        (Ok(a), Ok(b)) => a.rdev() == b.rdev(),
        _ => false,
    }
}

pub async fn start_av1(_: DesktopInfo, selection: &EncoderSelection) -> Result<VideoHub> {
    let raw = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC) };
    ensure!(
        raw >= 0,
        "create video worker wake fd: {}",
        std::io::Error::last_os_error()
    );
    let wake_fd = Arc::new(unsafe { OwnedFd::from_raw_fd(raw) });
    let demand_wake = wake_fd.clone();
    let demand = Demand::new(move || wake(&demand_wake));
    let (tx, _) = broadcast::channel(16);
    let (cursor_tx, _) = watch::channel(CursorState::default());
    let (keyframe_tx, mut keyframe_rx) = mpsc::channel(1);
    let stats = Arc::new(PipelineStats::default());
    let hub = VideoHub {
        tx: tx.clone(),
        demand: demand.clone(),
        cursor_tx: cursor_tx.clone(),
        keyframe_tx,
        wake: wake_fd.clone(),
        stats: stats.clone(),
    };
    let options = selection.clone();
    thread::Builder::new().name("native-vpl".into()).spawn(move || {
        // Retain media identity across capture/encoder recovery. Existing RTC
        // peers must never see a reset frame counter or a backwards timestamp.
        let origin = monotonic_us();
        let mut sequence = 0u64;
        let mut last_pts = 0u64;
        let mut consecutive_failures = 0u32;
        loop {
            while demand.count() == 0 {
                if keyframe_rx.is_closed() { return; }
                let mut pfd = libc::pollfd { fd:wake_fd.as_raw_fd(), events:libc::POLLIN, revents:0 };
                unsafe { libc::poll(&mut pfd, 1, 1000); }
                let mut v=0u64;
                unsafe { libc::read(wake_fd.as_raw_fd(), (&mut v as *mut u64).cast(), 8); }
            }
            let result = run_stream(&options, &tx, &demand, &cursor_tx, &mut keyframe_rx, &wake_fd, &stats,
                origin, &mut sequence, &mut last_pts);
            stats.active.store(false, Ordering::Relaxed);
            if let Err(error) = result {
                stats.failures.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut v) = stats.last_error.lock() { *v=Some(format!("{error:#}")); }
                tracing::error!(error=%format!("{error:#}"), "native direct GPU stream stopped; no copy/FFmpeg fallback");
                consecutive_failures = consecutive_failures.saturating_add(1);
            } else {
                consecutive_failures = 0;
            }
            if keyframe_rx.is_closed() { return; }
            if consecutive_failures > 0 {
                thread::sleep(Duration::from_millis(250 * (1u64 << consecutive_failures.min(4))));
            }
        }
    }).context("spawn Native GPU worker")?;
    Ok(hub)
}

// Field drop order is intentional: drain/destroy GPU users before returning a
// still-leased compositor buffer, then close the Wayland connection last.
struct Stream {
    encoder: Encoder,
    input: Rc<EncoderInput>,
    raw: Option<CapturedFrame>,
    capture: Capture,
}
fn run_stream(
    options: &EncoderSelection,
    tx: &broadcast::Sender<Arc<EncodedFrame>>,
    demand: &Demand,
    cursor_tx: &watch::Sender<CursorState>,
    requests: &mut mpsc::Receiver<()>,
    wake: &OwnedFd,
    stats: &PipelineStats,
    origin: u64,
    sequence: &mut u64,
    last_pts: &mut u64,
) -> Result<()> {
    let desktop = crate::read_desktop_info()?;
    ensure!(
        same_device_node(&desktop.render_node, &options.encode_device),
        "desktop render device changed"
    );
    let input = EncoderInput::new(
        Path::new(&options.encode_device),
        desktop.width,
        desktop.height,
    )?;
    let encoder = Encoder::new(
        input.clone(),
        options.max_fps,
        &options.rate_control,
        &options.gop,
        options.onevpl_vendor_impl_id,
        gpu::Codec::Av1,
    )?;
    let capture = Capture::connect(&desktop)?;
    let mut stream = Stream {
        encoder,
        input,
        raw: None,
        capture,
    };
    stats.active.store(true, Ordering::Relaxed);
    stats.starts.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut v) = stats.last_error.lock() {
        *v = None;
    }
    let mut sequence_header = Vec::new();
    let mut force_idr = true;
    let mut inflight: Option<(usize, u64)> = None;
    // An unchanged desktop reuses this already-converted NV12 surface.
    let mut last_surface: Option<usize> = None;
    let mut ready: Option<(usize, u64, u64, bool, Option<gpu::DamageRect>)> = None;
    let dirty_rects = setting("MCPBROWSER_NATIVE_LIVE_DIRTY_RECTS") == "1";
    let reuse_nv12 = setting("MCPBROWSER_NATIVE_LIVE_NV12_REUSE") == "1";
    let period_us = 1_000_000 / u64::from(options.max_fps);
    let mut next_capture_pts = 0u64;
    let idle_period =
        (options.idle_fps > 0).then(|| Duration::from_secs_f64(1.0 / f64::from(options.idle_fps)));
    let mut last_submit = Instant::now();
    let mut no_subscribers: Option<Instant> = None;
    let mut capture_count = 0u64;
    let mut replace_count = 0u64;
    let mut report = Instant::now();
    let mut report_frames = 0u64;
    let mut report_converted = 0u64;
    let mut report_bytes = 0u64;
    let max_lag_us = u64::from(env_u32("MCPBROWSER_NATIVE_LIVE_MAX_LAG_MS", 30, 1, 1000)?) * 1000;
    loop {
        if requests.is_closed() {
            return Ok(());
        }
        while requests.try_recv().is_ok() {
            force_idr = true;
        }
        if demand.count() == 0 {
            let since = no_subscribers.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_secs(2) {
                return Ok(());
            }
        } else {
            no_subscribers = None;
        }

        if let Some(completed) = stream.encoder.poll_complete()? {
            let (inflight_index, source_pts_us) =
                inflight.context("encoder completion without in-flight frame")?;
            ensure!(
                inflight_index == completed.surface_index,
                "NV12 ownership mismatch on encode completion"
            );
            inflight = None;
            let (data, has_config) =
                prepare_av1_packet(completed.data, completed.keyframe, &mut sequence_header)?;
            let published_at = Instant::now();
            let latency = monotonic_us().saturating_sub(origin + completed.pts_us);
            let duration = if *sequence == 0 {
                Duration::from_micros(period_us)
            } else {
                Duration::from_micros(completed.pts_us.saturating_sub(*last_pts).max(1))
            };
            *last_pts = completed.pts_us;
            report_bytes += data.len() as u64;
            let packet = Arc::new(EncodedFrame {
                sequence: *sequence,
                pts90k: ((completed.pts_us as u128 * 90000) / 1_000_000) as u32,
                source_pts_us,
                keyframe: completed.keyframe,
                has_config,
                data: Bytes::from(data),
                duration,
                published_at,
            });
            let _ = tx.send(packet);
            *sequence = sequence.wrapping_add(1);
            report_frames += 1;
            stats.encoded.fetch_add(1, Ordering::Relaxed);
            stats
                .encode_us
                .fetch_add(completed.encode_us, Ordering::Relaxed);
            stats
                .capture_to_packet_us
                .fetch_add(latency, Ordering::Relaxed);
            stats
                .capture_to_packet_max_us
                .fetch_max(latency, Ordering::Relaxed);
        }

        if let Some(mut raw) = stream.capture.take_latest() {
            if let Some(older) = stream.raw.take() {
                raw.merge_damage_from(&older);
                stats.dropped_before_vpp.fetch_add(1, Ordering::Relaxed);
            }
            stream.raw = Some(raw);
        }
        let (captures, replaces) = stream.capture.counters();
        stats
            .captured
            .fetch_add(captures - capture_count, Ordering::Relaxed);
        stats
            .dropped_before_vpp
            .fetch_add(replaces - replace_count, Ordering::Relaxed);
        capture_count = captures;
        replace_count = replaces;

        // A DEVICE_BUSY submission did not consume the frame or IDR latch.
        // Replace a stale unsubmitted NV12 only when a fresher raw lease exists.
        if ready.is_some_and(|(_, pts, _, _, _)| {
            monotonic_us().saturating_sub(origin + pts) > max_lag_us
        }) && stream.raw.is_some()
        {
            ready = None;
        }

        // Do not spend VPP work on intermediate frames while encoding is busy.
        // Keep only the newest unconverted lease; no FIFO and no duplicate RGB blit.
        if inflight.is_none() && ready.is_none() {
            if let Some(raw) = stream.raw.as_ref() {
                let age = monotonic_us().saturating_sub(raw.pts_us);
                // Coalesce rapid damage, but do not discard the final update
                // of a VFR burst: no later commit is guaranteed to arrive. A
                // single latest lease is not a stale FIFO and can wait until
                // the encode-rate ceiling permits it.
                let rate_ready = monotonic_us().saturating_add(period_us / 8) >= next_capture_pts;
                let acquired = raw.is_ready()?;
                ensure!(
                    acquired || age < 2_000_000,
                    "capture acquire fence timed out"
                );
                if rate_ready && acquired {
                    let source_pts = raw.pts_us;
                    let index = if reuse_nv12 {
                        last_surface
                            .map_or(0, |previous| (previous + 1) % stream.input.surface_count())
                    } else {
                        last_surface.unwrap_or(0)
                    };
                    ensure!(index < stream.input.surface_count(), "no NV12 surface");
                    let begin = Instant::now();
                    let full_damage = [gpu::DamageRect::full(raw.buffer.width, raw.buffer.height)];
                    let requested_damage = if reuse_nv12 {
                        raw.damage.as_slice()
                    } else {
                        full_damage.as_slice()
                    };
                    let converted_region = stream.input.begin_convert(
                        &raw.buffer,
                        index,
                        requested_damage,
                        reuse_nv12.then_some(last_surface).flatten(),
                    )?;
                    stream.input.finish_convert(index)?;
                    // Only now may KWin reuse its original RGB output buffer.
                    let full_pixels = u64::from(raw.buffer.width) * u64::from(raw.buffer.height);
                    stream.raw.take();
                    stats
                        .convert_us
                        .fetch_add(begin.elapsed().as_micros() as u64, Ordering::Relaxed);
                    stats
                        .vpp_pixels
                        .fetch_add(converted_region.area(), Ordering::Relaxed);
                    stats
                        .vpp_full_pixels
                        .fetch_add(full_pixels, Ordering::Relaxed);
                    stats.converted.fetch_add(1, Ordering::Relaxed);
                    report_converted += 1;
                    next_capture_pts = source_pts + period_us;
                    last_surface = Some(index);
                    ready = Some((
                        index,
                        source_pts.saturating_sub(origin).max(*last_pts + 1),
                        source_pts,
                        false,
                        if dirty_rects && converted_region.area() < full_pixels {
                            Some(converted_region)
                        } else {
                            None
                        },
                    ));
                }
            }
            if ready.is_none()
                && stream.raw.is_none()
                && last_surface.is_some()
                && (force_idr || idle_period.is_some_and(|p| last_submit.elapsed() >= p))
            {
                ready = Some((
                    last_surface.unwrap(),
                    monotonic_us().saturating_sub(origin).max(*last_pts + 1),
                    monotonic_us(),
                    true,
                    None,
                ));
            }
        }
        if inflight.is_none() {
            if let Some((index, pts, source_pts, heartbeat, dirty)) = ready {
                let encoder_dirty = (!force_idr).then_some(dirty).flatten();
                if stream
                    .encoder
                    .submit_encode(index, pts, force_idr, encoder_dirty)?
                {
                    if encoder_dirty.is_some() {
                        stats.dirty_encoder_submits.fetch_add(1, Ordering::Relaxed);
                    }
                    force_idr = false;
                    inflight = Some((index, source_pts));
                    ready = None;
                    last_submit = Instant::now();
                    if heartbeat {
                        stats.heartbeat_encoded.fetch_add(1, Ordering::Relaxed);
                    }
                } else {
                    stats.device_busy.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        if report.elapsed() >= Duration::from_secs(5) {
            let secs = report.elapsed().as_secs_f64();
            tracing::info!(
                fps = report_frames as f64 / secs,
                vpp_fps = report_converted as f64 / secs,
                mbps = report_bytes as f64 * 8.0 / secs / 1e6,
                capture_copy_passes = 0,
                cpu_pixel_readbacks = 0,
                captured = stats.captured.load(Ordering::Relaxed),
                dropped_before_vpp = stats.dropped_before_vpp.load(Ordering::Relaxed),
                heartbeat_encoded = stats.heartbeat_encoded.load(Ordering::Relaxed),
                "native direct oneVPL pipeline"
            );
            report = Instant::now();
            report_frames = 0;
            report_converted = 0;
            report_bytes = 0;
        }
        let busy = inflight.is_some() || ready.is_some() || stream.raw.is_some();
        let wait = if busy {
            Duration::from_micros(250)
        } else {
            idle_period
                .map(|p| p.saturating_sub(last_submit.elapsed()))
                .unwrap_or(Duration::from_millis(100))
                .min(Duration::from_millis(100))
        };
        stream.capture.pump(wait, wake)?;
        if let Some(cursor) = stream.capture.take_cursor() {
            cursor_tx.send_replace(cursor);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ObuRange {
    kind: u8,
    start: usize,
    end: usize,
}

fn read_leb128(data: &[u8], at: &mut usize) -> Result<usize> {
    let mut value = 0usize;
    for shift in (0..56).step_by(7) {
        let byte = *data.get(*at).context("truncated AV1 leb128")?;
        *at += 1;
        let chunk = (byte & 0x7f) as usize;
        value = value
            .checked_add(chunk.checked_shl(shift).context("AV1 leb128 overflow")?)
            .context("AV1 leb128 overflow")?;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    bail!("AV1 leb128 exceeds 8 bytes")
}

fn parse_av1_obus(data: &[u8]) -> Result<Vec<ObuRange>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < data.len() {
        let start = at;
        let header = data[at];
        at += 1;
        if header & 0x80 != 0 || header & 0x01 != 0 {
            bail!("invalid AV1 OBU header 0x{header:02x}")
        }
        let kind = (header >> 3) & 0x0f;
        if header & 0x04 != 0 {
            let extension = *data.get(at).context("truncated AV1 OBU extension")?;
            if extension & 0x07 != 0 {
                bail!("invalid AV1 OBU extension")
            }
            at += 1;
        }
        if header & 0x02 == 0 {
            out.push(ObuRange {
                kind,
                start,
                end: data.len(),
            });
            break;
        }
        let payload = read_leb128(data, &mut at)?;
        let end = at.checked_add(payload).context("AV1 OBU size overflow")?;
        if end > data.len() {
            bail!("truncated AV1 OBU payload")
        }
        out.push(ObuRange { kind, start, end });
        at = end;
    }
    if out.is_empty() {
        bail!("AV1 packet contains no OBUs")
    }
    Ok(out)
}

fn prepare_av1_packet(
    data: Vec<u8>,
    keyframe: bool,
    sequence_header: &mut Vec<u8>,
) -> Result<(Vec<u8>, bool)> {
    const OBU_SEQUENCE_HEADER: u8 = 1;
    const OBU_TEMPORAL_DELIMITER: u8 = 2;
    let obus = parse_av1_obus(&data)?;
    let mut has_config = false;
    for obu in &obus {
        if obu.kind == OBU_SEQUENCE_HEADER {
            has_config = true;
            sequence_header.clear();
            sequence_header.extend_from_slice(&data[obu.start..obu.end]);
        }
    }
    if !keyframe || has_config {
        return Ok((data, has_config));
    }
    if sequence_header.is_empty() {
        bail!("AV1 keyframe arrived before a sequence header")
    }
    let insert_at = obus
        .first()
        .filter(|obu| obu.kind == OBU_TEMPORAL_DELIMITER)
        .map(|obu| obu.end)
        .unwrap_or(0);
    let mut completed = Vec::with_capacity(data.len() + sequence_header.len());
    completed.extend_from_slice(&data[..insert_at]);
    completed.extend_from_slice(sequence_header);
    completed.extend_from_slice(&data[insert_at..]);
    Ok((completed, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn obu(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![(kind << 3) | 2, payload.len() as u8];
        v.extend_from_slice(payload);
        v
    }
    #[test]
    fn av1_sequence_header_is_cached_and_reinjected() {
        let td = obu(2, &[]);
        let seq = obu(1, &[9, 8, 7]);
        let frame = obu(6, &[1, 2, 3, 4]);
        let mut first = td.clone();
        first.extend_from_slice(&seq);
        first.extend_from_slice(&frame);
        let mut cache = Vec::new();
        let (first, has_config) = prepare_av1_packet(first, true, &mut cache).unwrap();
        assert!(has_config);
        assert_eq!(
            parse_av1_obus(&first)
                .unwrap()
                .iter()
                .map(|o| o.kind)
                .collect::<Vec<_>>(),
            vec![2, 1, 6]
        );
        assert_eq!(cache, seq);

        let mut later = td;
        later.extend_from_slice(&frame);
        let (later, has_config) = prepare_av1_packet(later, true, &mut cache).unwrap();
        assert!(has_config);
        assert_eq!(
            parse_av1_obus(&later)
                .unwrap()
                .iter()
                .map(|o| o.kind)
                .collect::<Vec<_>>(),
            vec![2, 1, 6]
        );
    }

    #[test]
    fn av1_inter_frame_does_not_claim_config() {
        let frame = obu(6, &[4, 5, 6]);
        let mut cache = Vec::new();
        let (_, has_config) = prepare_av1_packet(frame, false, &mut cache).unwrap();
        assert!(!has_config);
    }
}
