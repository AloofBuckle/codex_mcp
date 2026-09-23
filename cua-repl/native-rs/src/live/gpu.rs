//! Native GPU-only leased DMA-BUF -> VAProc NV12 -> oneVPL AV1.
//! The allocator and encode machinery derive from mcpmonitor's proven GPU path.
//! There is no FFmpeg, Smithay, pixel mapping, hwupload, or capture allocation.
mod ffi {
    #![allow(
        non_snake_case,
        non_camel_case_types,
        non_upper_case_globals,
        dead_code,
        improper_ctypes,
        unused_imports,
        unsafe_op_in_unsafe_fn
    )]
    include!(concat!(env!("OUT_DIR"), "/gpu.rs"));
}
use anyhow::{Context, Result, anyhow, bail, ensure};
use ffi::*;
use libc::{c_int, c_void};
use std::cell::{Cell, RefCell};
use std::os::fd::OwnedFd;

#[derive(Debug)]
pub struct Plane {
    pub fd: OwnedFd,
    pub offset: u32,
    pub stride: u32,
    pub size: u64,
}
#[derive(Debug)]
pub struct Dmabuf {
    pub width: u32,
    pub height: u32,
    pub fourcc: u32,
    pub modifier: u64,
    pub planes: Vec<Plane>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamageRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl DamageRect {
    pub fn full(width: u32, height: u32) -> Self {
        Self {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    pub fn area(self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct PlaneKey {
    dev: u64,
    ino: u64,
    offset: u32,
    stride: u32,
    size: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct FrameKey {
    width: u32,
    height: u32,
    fourcc: u32,
    modifier: u64,
    planes: Vec<PlaneKey>,
}
struct ImportedRgb {
    key: FrameKey,
    surface: VASurfaceID,
    // Keep DMA-BUF identity alive even after the Wayland frame is released.
    _fds: Vec<OwnedFd>,
}
impl Dmabuf {
    fn validate(&self) -> Result<FrameKey> {
        if self.width < 2
            || self.height < 2
            || self.width > MAX_DIM
            || self.height > MAX_DIM
            || self.width % 2 != 0
            || self.height % 2 != 0
        {
            bail!(
                "invalid/even DMA-BUF dimensions {}x{}",
                self.width,
                self.height
            );
        }
        if self.planes.is_empty() || self.planes.len() > 4 {
            bail!("RGB capture must contain 1..=4 DMA-BUF planes");
        }
        if !matches!(self.fourcc, DRM_AR24 | DRM_AB24 | DRM_XR24 | DRM_XB24) {
            bail!("unsupported capture fourcc {:#x}", self.fourcc);
        }
        // Only layouts explicitly supported by the current Intel RGB importer.
        // Modifier 9 is uncompressed Tile4. Render-compressed RGB modifiers
        // are not imported directly, so the direct KWin backend can select a
        // supported modifier through deployment configuration.
        if !matches!(
            self.modifier,
            0 | 0x0100_0000_0000_0001 | 0x0100_0000_0000_0002 | 0x0100_0000_0000_0009
        ) {
            bail!("unsupported RGB DRM modifier {:#x}", self.modifier);
        }
        let mut plane_keys = Vec::with_capacity(self.planes.len());
        for (index, p) in self.planes.iter().enumerate() {
            if p.stride == 0
                || p.size == 0
                || p.size > u32::MAX as u64
                || u64::from(p.offset) >= p.size
            {
                bail!("invalid DMA-BUF plane {index} extent");
            }
            if index == 0 {
                let min = u64::from(p.stride)
                    .checked_mul(u64::from(self.height))
                    .and_then(|v| v.checked_add(u64::from(p.offset)))
                    .context("DMA-BUF main-plane extent overflow")?;
                if p.stride < self.width * 4 || min > p.size {
                    bail!("invalid DMA-BUF main-plane stride/extent");
                }
            }
            let mut stat: libc::stat = unsafe { zeroed() };
            if unsafe { libc::fstat(p.fd.as_raw_fd(), &mut stat) } != 0 {
                return Err(std::io::Error::last_os_error()).context("fstat DMA-BUF plane");
            }
            let actual = unsafe { libc::lseek(p.fd.as_raw_fd(), 0, libc::SEEK_END) };
            if actual < 0 || actual as u64 != p.size {
                bail!("DMA-BUF plane {index} allocation size disagrees with descriptor");
            }
            plane_keys.push(PlaneKey {
                dev: stat.st_dev,
                ino: stat.st_ino,
                offset: p.offset,
                stride: p.stride,
                size: p.size,
            });
        }
        Ok(FrameKey {
            width: self.width,
            height: self.height,
            fourcc: self.fourcc,
            modifier: self.modifier,
            planes: plane_keys,
        })
    }
}

use std::collections::VecDeque;
use std::ffi::{CStr, CString};
use std::mem::{size_of, zeroed};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::ptr;
use std::rc::Rc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_DIM: u32 = 8192;
const MAX_BS: usize = 256 << 20;
const MIN_BS: u64 = 4 << 20;
const BUSY_TO: Duration = Duration::from_secs(5);
const BUSY_SLEEP: Duration = Duration::from_micros(100);
const SYNC_TO_MS: u32 = 500;

/// oneVPL is configured with AsyncDepth=1. Keep two canonical NV12 canvases so
/// a damage update can read the previous complete frame while VPP composes the
/// next complete frame. This avoids relying on undefined preservation of
/// pixels outside VAProc output_region.
pub const PIPELINE_DEPTH: usize = 2;
const ENCODE_ASYNC_DEPTH: usize = 1;

const VA_INVALID: u32 = u32::MAX;
const VA_OK: VAStatus = ffi::VA_STATUS_SUCCESS as VAStatus;
const VA_PROFILE_NONE_C: VAProfile = ffi::VAProfile_VAProfileNone as VAProfile;
const VA_ENTRY_VPP: VAEntrypoint = ffi::VAEntrypoint_VAEntrypointVideoProc as VAEntrypoint;
const VA_YUV420: u32 = ffi::VA_RT_FORMAT_YUV420 as u32;
const VA_YUV420_10: u32 = ffi::VA_RT_FORMAT_YUV420_10 as u32;
const VA_RGB32: u32 = ffi::VA_RT_FORMAT_RGB32 as u32;
const VA_PROGRESSIVE_C: c_int = ffi::VA_PROGRESSIVE as c_int;
const VA_ATTR_SET: u32 = ffi::VA_SURFACE_ATTRIB_SETTABLE as u32;
const VA_ATTR_PIX: VASurfaceAttribType =
    ffi::VASurfaceAttribType_VASurfaceAttribPixelFormat as VASurfaceAttribType;
const VA_ATTR_MEM: VASurfaceAttribType =
    ffi::VASurfaceAttribType_VASurfaceAttribMemoryType as VASurfaceAttribType;
const VA_ATTR_EXT: VASurfaceAttribType =
    ffi::VASurfaceAttribType_VASurfaceAttribExternalBufferDescriptor as VASurfaceAttribType;
const VA_MEM_PRIME2: i32 = ffi::VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2 as i32;
const VA_VAL_INT: VAGenericValueType =
    ffi::VAGenericValueType_VAGenericValueTypeInteger as VAGenericValueType;
const VA_VAL_PTR: VAGenericValueType =
    ffi::VAGenericValueType_VAGenericValueTypePointer as VAGenericValueType;
const VA_BUF_VPP: VABufferType =
    ffi::VABufferType_VAProcPipelineParameterBufferType as VABufferType;

const MFX_OK: mfxStatus = ffi::mfxStatus_MFX_ERR_NONE as mfxStatus;
const MFX_WRN_EXEC: mfxStatus = ffi::mfxStatus_MFX_WRN_IN_EXECUTION as mfxStatus;
const MFX_WRN_BUSY: mfxStatus = ffi::mfxStatus_MFX_WRN_DEVICE_BUSY as mfxStatus;
const MFX_ERR_NULL: mfxStatus = ffi::mfxStatus_MFX_ERR_NULL_PTR as mfxStatus;
const MFX_ERR_UNSUP: mfxStatus = ffi::mfxStatus_MFX_ERR_UNSUPPORTED as mfxStatus;
const MFX_ERR_ALLOC: mfxStatus = ffi::mfxStatus_MFX_ERR_MEMORY_ALLOC as mfxStatus;
const MFX_ERR_BS: mfxStatus = ffi::mfxStatus_MFX_ERR_NOT_ENOUGH_BUFFER as mfxStatus;
const MFX_ERR_PARAM: mfxStatus = ffi::mfxStatus_MFX_ERR_INVALID_VIDEO_PARAM as mfxStatus;
const MFX_IMPL_HW: u32 = ffi::mfxImplType_MFX_IMPL_TYPE_HARDWARE as u32;
const MFX_ACCEL_VAAPI_C: u32 = ffi::mfxAccelerationMode_MFX_ACCEL_MODE_VIA_VAAPI as u32;
const MFX_VAR_U32: mfxVariantType = ffi::mfxVariantType_MFX_VARIANT_TYPE_U32 as mfxVariantType;
const MFX_HANDLE_VA: mfxHandleType = ffi::mfxHandleType_MFX_HANDLE_VA_DISPLAY as mfxHandleType;
const MFX_IN_VIDEO: u16 = ffi::MFX_IOPATTERN_IN_VIDEO_MEMORY as u16;
const MFX_AV1: u32 = ffi::MFX_CODEC_AV1 as u32;
const MFX_AV1_MAIN: u16 = ffi::MFX_PROFILE_AV1_MAIN as u16;
const MFX_NV12: u32 = ffi::MFX_FOURCC_NV12 as u32;
const MFX_P010: u32 = ffi::MFX_FOURCC_P010 as u32;
const MFX_RGB4: u32 = ffi::MFX_FOURCC_RGB4 as u32;
const MFX_CHROMA420: u16 = ffi::MFX_CHROMAFORMAT_YUV420 as u16;
const MFX_PROGRESSIVE: u16 = ffi::MFX_PICSTRUCT_PROGRESSIVE as u16;
const MFX_CBR: u16 = ffi::MFX_RATECONTROL_CBR as u16;
const MFX_VBR: u16 = ffi::MFX_RATECONTROL_VBR as u16;
const MFX_CQP: u16 = ffi::MFX_RATECONTROL_CQP as u16;
const MFX_ICQ: u16 = ffi::MFX_RATECONTROL_ICQ as u16;
const MFX_ON: u16 = ffi::MFX_CODINGOPTION_ON as u16;
const MFX_OFF: u16 = ffi::MFX_CODINGOPTION_OFF as u16;
const MFX_SCENARIO_REMOTE: u16 = ffi::MFX_SCENARIO_DISPLAY_REMOTING as u16;
const MFX_CONTENT_SCREEN: u16 = ffi::MFX_CONTENT_NON_VIDEO_SCREEN as u16;
const MFX_FT_I: u16 = ffi::MFX_FRAMETYPE_I as u16;
const MFX_FT_REF: u16 = ffi::MFX_FRAMETYPE_REF as u16;
const MFX_FT_IDR: u16 = ffi::MFX_FRAMETYPE_IDR as u16;
const MFX_EXT_CO3: u32 = ffi::MFX_EXTBUFF_CODING_OPTION3 as u32;
const MFX_EXT_AV1_BS: u32 = ffi::MFX_EXTBUFF_AV1_BITSTREAM_PARAM as u32;
const MFX_EXT_DIRTY: u32 = ffi::MFX_EXTBUFF_DIRTY_RECTANGLES as u32;
const DRM_AR24: u32 = fourcc(b'A', b'R', b'2', b'4');
const DRM_AB24: u32 = fourcc(b'A', b'B', b'2', b'4');
const DRM_XR24: u32 = fourcc(b'X', b'R', b'2', b'4');
const DRM_XB24: u32 = fourcc(b'X', b'B', b'2', b'4');
const VA_BGRA: u32 = fourcc(b'B', b'G', b'R', b'A');
const VA_BGRX: u32 = fourcc(b'B', b'G', b'R', b'X');
const VA_RGBA: u32 = fourcc(b'R', b'G', b'B', b'A');
const VA_RGBX: u32 = fourcc(b'R', b'G', b'B', b'X');
const VA_XRGB: u32 = fourcc(b'X', b'R', b'G', b'B');
const VA_NV12: u32 = fourcc(b'N', b'V', b'1', b'2');
const VA_P010: u32 = fourcc(b'P', b'0', b'1', b'0');

const fn fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 {
    (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
}
const fn align16(v: u32) -> u32 {
    (v + 15) & !15
}

#[derive(Clone, Copy, Debug)]
pub enum Codec {
    Av1,
}
impl Codec {
    fn id(self) -> u32 {
        match self {
            Codec::Av1 => MFX_AV1,
        }
    }
    fn profile(self) -> u16 {
        match self {
            Codec::Av1 => MFX_AV1_MAIN,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateControlMode {
    Cbr,
    Vbr,
    Cqp,
    Icq,
}

#[derive(Clone, Debug)]
pub struct GopConfig {
    pub pictures: u16,
    pub ref_distance: u16,
    pub idr_interval: u16,
    pub strict: bool,
}

impl GopConfig {
    pub fn validate(&self) -> Result<()> {
        if self.pictures == 0 || self.ref_distance == 0 || self.ref_distance > self.pictures {
            bail!("invalid GOP parameters");
        }
        Ok(())
    }
}

impl RateControlMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cbr => "cbr",
            Self::Vbr => "vbr",
            Self::Cqp => "cqp",
            Self::Icq => "icq",
        }
    }

    fn onevpl(self) -> u16 {
        match self {
            Self::Cbr => MFX_CBR,
            Self::Vbr => MFX_VBR,
            Self::Cqp => MFX_CQP,
            Self::Icq => MFX_ICQ,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RateControlConfig {
    pub mode: RateControlMode,
    pub target_usage: u16,
    pub cbr_target_kbps: u32,
    pub cbr_buffer_frames: u32,
    pub cbr_initial_delay_frames: u32,
    pub cbr_buffer_size_kb: Option<u32>,
    pub cbr_initial_delay_kb: Option<u32>,
    pub vbr_target_kbps: u32,
    pub vbr_max_kbps: u32,
    pub vbr_buffer_frames: u32,
    pub vbr_initial_delay_frames: u32,
    pub vbr_buffer_size_kb: Option<u32>,
    pub vbr_initial_delay_kb: Option<u32>,
    pub vbr_max_frame_size_i_bytes: Option<u32>,
    pub vbr_max_frame_size_p_bytes: Option<u32>,
    pub vbr_low_delay_brc: bool,
    pub cqp_qpi: u16,
    pub cqp_qpp: u16,
    pub cqp_qpb: u16,
    pub icq_quality: u16,
}

impl RateControlConfig {
    pub fn target_kbps(&self) -> Option<u32> {
        match self.mode {
            RateControlMode::Cbr => Some(self.cbr_target_kbps),
            RateControlMode::Vbr => Some(self.vbr_target_kbps),
            RateControlMode::Cqp | RateControlMode::Icq => None,
        }
    }

    pub fn max_kbps(&self) -> Option<u32> {
        match self.mode {
            RateControlMode::Cbr => Some(self.cbr_target_kbps),
            RateControlMode::Vbr => Some(self.vbr_max_kbps),
            RateControlMode::Cqp | RateControlMode::Icq => None,
        }
    }

    fn bitrate_ceiling(&self) -> u32 {
        self.max_kbps().unwrap_or(1)
    }

    fn validate(&self, fps: u32) -> Result<()> {
        if fps == 0 || fps > u16::MAX as u32 || !(1..=7).contains(&self.target_usage) {
            bail!("invalid encoder parameters");
        }
        let bitrate_ok = |v: u32| (100..=1_000_000).contains(&v);
        if !bitrate_ok(self.cbr_target_kbps)
            || !bitrate_ok(self.vbr_target_kbps)
            || !bitrate_ok(self.vbr_max_kbps)
            || self.vbr_max_kbps < self.vbr_target_kbps
            || !(1..=16).contains(&self.cbr_buffer_frames)
            || self.cbr_initial_delay_frames > 16
            || self
                .cbr_buffer_size_kb
                .is_some_and(|v| v == 0 || v > 1_000_000)
            || self.cbr_initial_delay_kb.is_some_and(|v| v > 1_000_000)
            || matches!((self.cbr_buffer_size_kb, self.cbr_initial_delay_kb), (Some(b), Some(i)) if i > b)
            || !(1..=16).contains(&self.vbr_buffer_frames)
            || self.vbr_initial_delay_frames > 16
            || self
                .vbr_buffer_size_kb
                .is_some_and(|v| v == 0 || v > 1_000_000)
            || self.vbr_initial_delay_kb.is_some_and(|v| v > 1_000_000)
            || matches!((self.vbr_buffer_size_kb, self.vbr_initial_delay_kb), (Some(b), Some(i)) if i > b)
            || self
                .vbr_max_frame_size_i_bytes
                .is_some_and(|v| v == 0 || v > 10_000_000)
            || self
                .vbr_max_frame_size_p_bytes
                .is_some_and(|v| v == 0 || v > 10_000_000)
            || matches!(
                (
                    self.vbr_max_frame_size_i_bytes,
                    self.vbr_max_frame_size_p_bytes
                ),
                (None, Some(_))
            )
            || self.cqp_qpi > 255
            || self.cqp_qpp > 255
            || self.cqp_qpb > 255
            || !(1..=51).contains(&self.icq_quality)
        {
            bail!("invalid rate-control parameters");
        }
        Ok(())
    }
}

struct VaState {
    fd: c_int,
    display: VADisplay,
    rgb: RefCell<Vec<ImportedRgb>>,
    sparse_images: RefCell<Vec<SparseImage>>,
    sparse_atlas: RefCell<Option<SparseAtlas>>,
    nv12: Vec<VASurfaceID>,
    cfg: VAConfigID,
    ctx: VAContextID,
}

#[derive(Clone, Copy)]
struct SparseImage {
    image_id: VAImageID,
    buf: VABufferID,
    fourcc: u32,
    width: u32,
    height: u32,
    pitch: u32,
    offset: u32,
}

#[derive(Clone, Copy)]
struct SparseAtlas {
    surface: VASurfaceID,
    width: u32,
    height: u32,
    fourcc: u32,
}
impl VaState {
    fn kill(&mut self) {
        // SAFETY: handles are owned here and guarded by invalid sentinels.
        unsafe {
            if self.display.is_null() {
                if self.fd >= 0 {
                    libc::close(self.fd);
                    self.fd = -1;
                }
                return;
            }
            if self.ctx != VA_INVALID {
                let _ = vaDestroyContext(self.display, self.ctx);
                self.ctx = VA_INVALID;
            }
            if self.cfg != VA_INVALID {
                let _ = vaDestroyConfig(self.display, self.cfg);
                self.cfg = VA_INVALID;
            }
            if !self.nv12.is_empty() {
                let n = self.nv12.len() as c_int;
                let _ = vaDestroySurfaces(self.display, self.nv12.as_mut_ptr(), n);
                self.nv12.clear();
            }
            for mut entry in self.rgb.get_mut().drain(..) {
                let _ = vaDestroySurfaces(self.display, &mut entry.surface, 1);
            }
            for image in self.sparse_images.get_mut().drain(..) {
                let _ = vaDestroyImage(self.display, image.image_id);
            }
            if let Some(mut atlas) = self.sparse_atlas.get_mut().take() {
                let _ = vaDestroySurfaces(self.display, &mut atlas.surface, 1);
            }
            let _ = vaTerminate(self.display);
            self.display = ptr::null_mut();
            if self.fd >= 0 {
                libc::close(self.fd);
                self.fd = -1;
            }
        }
    }
}
impl Drop for VaState {
    fn drop(&mut self) {
        self.kill();
    }
}

struct VplState {
    loader: mfxLoader,
    session: mfxSession,
    open: bool,
}
impl VplState {
    fn new() -> Self {
        Self {
            loader: ptr::null_mut(),
            session: ptr::null_mut(),
            open: false,
        }
    }
    fn kill(&mut self) {
        // SAFETY: VPL handles are owned here; allocator outlives this call.
        unsafe {
            if !self.session.is_null() {
                if self.open {
                    let _ = MFXVideoENCODE_Close(self.session);
                    self.open = false;
                }
                let _ = MFXClose(self.session);
                self.session = ptr::null_mut();
            }
            if !self.loader.is_null() {
                MFXUnload(self.loader);
                self.loader = ptr::null_mut();
            }
        }
    }
}
impl Drop for VplState {
    fn drop(&mut self) {
        self.kill();
    }
}

struct VaMemId {
    display: VADisplay,
    surface: VASurfaceID,
    owned: bool,
}
struct Alloc {
    display: VADisplay,
    api: mfxFrameAllocator,
    live: Mutex<Vec<(*mut mfxMemId, u16)>>,
}
impl Alloc {
    fn new(d: VADisplay) -> Box<Self> {
        let mut a = Box::new(Self {
            display: d,
            api: unsafe { zeroed() },
            live: Mutex::new(Vec::new()),
        });
        a.api.pthis = (&mut *a as *mut Self).cast::<c_void>();
        a.api.Alloc = Some(alloc_cb);
        a.api.Lock = Some(lock_cb);
        a.api.Unlock = Some(unlock_cb);
        a.api.GetHDL = Some(gethdl_cb);
        a.api.Free = Some(free_cb);
        a
    }
    fn cleanup(&mut self) {
        let items = match self.live.lock() {
            Ok(mut g) => std::mem::take(&mut *g),
            Err(p) => {
                let mut g = p.into_inner();
                std::mem::take(&mut *g)
            }
        };
        for (m, n) in items {
            free_mids(m, n as usize);
        }
    }
}
impl Drop for Alloc {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn free_mids(mids: *mut mfxMemId, count: usize) {
    if mids.is_null() {
        return;
    }
    // SAFETY: calloc array of Box::into_raw records, consumed once.
    unsafe {
        for i in 0..count {
            let m = *mids.add(i);
            if m.is_null() {
                continue;
            }
            let r = Box::from_raw(m as *mut VaMemId);
            if r.owned && r.surface != VA_INVALID {
                let mut s = r.surface;
                let _ = vaDestroySurfaces(r.display, &mut s as *mut VASurfaceID, 1);
            }
        }
        libc::free(mids as *mut c_void);
    }
}

fn dims(i: &mfxFrameInfo) -> (u16, u16) {
    unsafe {
        (
            i.__bindgen_anon_1.__bindgen_anon_1.Width,
            i.__bindgen_anon_1.__bindgen_anon_1.Height,
        )
    }
}
fn crop(i: &mfxFrameInfo) -> (u16, u16) {
    unsafe {
        (
            i.__bindgen_anon_1.__bindgen_anon_1.CropW,
            i.__bindgen_anon_1.__bindgen_anon_1.CropH,
        )
    }
}
fn pix_attr(p: u32) -> VASurfaceAttrib {
    let mut a: VASurfaceAttrib = unsafe { zeroed() };
    a.type_ = VA_ATTR_PIX;
    a.flags = VA_ATTR_SET;
    a.value.type_ = VA_VAL_INT;
    a.value.value.i = p as i32;
    a
}
fn make_info(fourcc_value: u32, w: u16, h: u16, fps: u32) -> mfxFrameInfo {
    let mut i: mfxFrameInfo = unsafe { zeroed() };
    i.FourCC = fourcc_value;
    i.ChromaFormat = MFX_CHROMA420;
    i.PicStruct = MFX_PROGRESSIVE;
    i.FrameRateExtN = fps;
    i.FrameRateExtD = 1;
    let aw = align16(w as u32) as u16;
    let ah = align16(h as u32) as u16;
    // Writing the width/height union view does not read any inactive field.
    {
        i.__bindgen_anon_1.__bindgen_anon_1.Width = aw;
        i.__bindgen_anon_1.__bindgen_anon_1.Height = ah;
        i.__bindgen_anon_1.__bindgen_anon_1.CropX = 0;
        i.__bindgen_anon_1.__bindgen_anon_1.CropY = 0;
        i.__bindgen_anon_1.__bindgen_anon_1.CropW = w;
        i.__bindgen_anon_1.__bindgen_anon_1.CropH = h;
    }
    i
}
fn bs_mult(k: u32) -> u16 {
    if k <= u16::MAX as u32 {
        1
    } else {
        (((k as u64 + 65534) / 65535).min(u16::MAX as u64)) as u16
    }
}
fn bs_target(k: u32, m: u16) -> u16 {
    let d = m.max(1) as u32;
    k.div_ceil(d).clamp(1, u16::MAX as u32) as u16
}

fn bs_target_allow_zero(k: u32, m: u16) -> u16 {
    if k == 0 { 0 } else { bs_target(k, m) }
}

fn rc_buffer_kb(kbps: u32, fps: u32, frames: u32, mult: u16) -> u32 {
    let max_effective = u16::MAX as u64 * mult.max(1) as u64;
    (kbps as u64 * frames as u64)
        .div_ceil(fps as u64 * 8)
        .clamp(1, max_effective) as u32
}

fn vae(op: &str, s: VAStatus) -> anyhow::Error {
    let msg = unsafe {
        let p = vaErrorStr(s);
        if p.is_null() {
            String::from("unknown")
        } else {
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    };
    anyhow!("{op}: VA {s} 0x{:08x} {msg}", s as u32)
}
fn chkva(op: &str, s: VAStatus) -> Result<()> {
    if s == VA_OK { Ok(()) } else { Err(vae(op, s)) }
}
fn mfxe(op: &str, s: mfxStatus) -> anyhow::Error {
    anyhow!("{op}: MFX {s} 0x{:08x}", s as u32)
}
fn chkmfx(op: &str, s: mfxStatus) -> Result<()> {
    if s >= MFX_OK {
        Ok(())
    } else {
        Err(mfxe(op, s))
    }
}

fn import_rgb(d: VADisplay, b: &Dmabuf) -> Result<VASurfaceID> {
    let k = b.validate()?;
    let vaf = match b.fourcc {
        DRM_AR24 => VA_BGRA,
        DRM_AB24 => VA_RGBA,
        DRM_XR24 => VA_BGRX,
        DRM_XB24 => VA_RGBX,
        _ => bail!("unsupported RGB format"),
    };
    let mut desc: VADRMPRIMESurfaceDescriptor = unsafe { zeroed() };
    desc.fourcc = vaf;
    desc.width = b.width;
    desc.height = b.height;
    // A compressed DRM format can have auxiliary planes. Multiple plane fds
    // may still refer to the same GEM object, so deduplicate objects by the
    // validated device/inode identity and point each layer plane at it.
    let mut objects: Vec<(u64, u64)> = Vec::new();
    let mut object_index = Vec::with_capacity(b.planes.len());
    for (i, p) in b.planes.iter().enumerate() {
        let pk = &k.planes[i];
        let oi = if let Some(at) = objects.iter().position(|id| *id == (pk.dev, pk.ino)) {
            at
        } else {
            let at = objects.len();
            ensure!(at < desc.objects.len(), "too many DMA-BUF objects");
            objects.push((pk.dev, pk.ino));
            desc.objects[at].fd = p.fd.as_raw_fd();
            desc.objects[at].size = pk.size as u32;
            desc.objects[at].drm_format_modifier = b.modifier;
            at
        };
        object_index.push(oi as u32);
    }
    desc.num_objects = objects.len() as u32;
    desc.num_layers = 1;
    desc.layers[0].drm_format = b.fourcc;
    desc.layers[0].num_planes = b.planes.len() as u32;
    for (i, p) in b.planes.iter().enumerate() {
        desc.layers[0].object_index[i] = object_index[i];
        desc.layers[0].offset[i] = p.offset;
        desc.layers[0].pitch[i] = p.stride;
    }
    let mut attrs: [VASurfaceAttrib; 3] = unsafe { zeroed() };
    attrs[0].type_ = VA_ATTR_MEM;
    attrs[0].flags = VA_ATTR_SET;
    attrs[0].value.type_ = VA_VAL_INT;
    attrs[0].value.value.i = VA_MEM_PRIME2;
    attrs[1].type_ = VA_ATTR_EXT;
    attrs[1].flags = VA_ATTR_SET;
    attrs[1].value.type_ = VA_VAL_PTR;
    attrs[1].value.value.p = (&mut desc as *mut VADRMPRIMESurfaceDescriptor).cast::<c_void>();
    attrs[2] = pix_attr(vaf);
    let mut surface = VA_INVALID;
    chkva("vaCreateSurfaces(PRIME2 RGB)", unsafe {
        vaCreateSurfaces(
            d,
            VA_RGB32,
            b.width,
            b.height,
            &mut surface,
            1,
            attrs.as_mut_ptr(),
            3,
        )
    })?;
    Ok(surface)
}

fn filter(l: mfxLoader, name: &'static [u8], v: u32) -> Result<()> {
    let c = unsafe { MFXCreateConfig(l) };
    if c.is_null() {
        bail!("MFXCreateConfig failed");
    }
    let mut var: mfxVariant = unsafe { zeroed() };
    var.Type = MFX_VAR_U32;
    var.Data.U32 = v;
    chkmfx("MFXSetConfigFilterProperty", unsafe {
        MFXSetConfigFilterProperty(c, name.as_ptr(), var)
    })
}
fn query(s: mfxSession, p: &mut mfxVideoParam) -> Result<()> {
    let end = Instant::now() + BUSY_TO;
    loop {
        let ptr = p as *mut mfxVideoParam;
        let st = unsafe { MFXVideoENCODE_Query(s, ptr, ptr) };
        if st == MFX_WRN_BUSY {
            if Instant::now() >= end {
                bail!("query busy");
            }
            std::thread::sleep(BUSY_SLEEP);
            continue;
        }
        return chkmfx("MFXVideoENCODE_Query", st);
    }
}
fn init(s: mfxSession, p: &mut mfxVideoParam) -> Result<()> {
    let end = Instant::now() + BUSY_TO;
    loop {
        let st = unsafe { MFXVideoENCODE_Init(s, p as *mut mfxVideoParam) };
        if st == MFX_WRN_BUSY {
            if Instant::now() >= end {
                bail!("init busy");
            }
            std::thread::sleep(BUSY_SLEEP);
            continue;
        }
        return chkmfx("MFXVideoENCODE_Init", st);
    }
}

unsafe extern "C" fn alloc_cb(
    pthis: mfxHDL,
    req: *mut mfxFrameAllocRequest,
    resp: *mut mfxFrameAllocResponse,
) -> mfxStatus {
    if pthis.is_null() || req.is_null() || resp.is_null() {
        return MFX_ERR_NULL;
    }
    // SAFETY: pthis is the Box<Alloc> installed in Alloc::new.
    let a = pthis as *mut Alloc;
    let d = unsafe { (*a).display };
    let (n, fourcc, w, h, alloc_id) = unsafe {
        let r = &*req;
        let (w, h) = dims(&r.Info);
        (
            r.NumFrameMin.max(r.NumFrameSuggested),
            r.Info.FourCC,
            w,
            h,
            r.__bindgen_anon_1.AllocId,
        )
    };
    if n == 0 {
        return MFX_ERR_ALLOC;
    }
    let (rt, pix) = match fourcc {
        MFX_NV12 => (VA_YUV420, VA_NV12),
        MFX_P010 => (VA_YUV420_10, VA_P010),
        MFX_RGB4 => (VA_RGB32, VA_BGRA),
        _ => return MFX_ERR_UNSUP,
    };
    if w == 0 || h == 0 {
        return MFX_ERR_PARAM;
    }
    let cu = n as usize;
    let mut surfaces: Vec<VASurfaceID> = vec![VA_INVALID; cu];
    let mut attr = pix_attr(pix);
    let st = unsafe {
        vaCreateSurfaces(
            d,
            rt,
            w as u32,
            h as u32,
            surfaces.as_mut_ptr(),
            n as u32,
            &mut attr as *mut VASurfaceAttrib,
            1,
        )
    };
    if st != VA_OK {
        return MFX_ERR_ALLOC;
    }
    let mids = unsafe { libc::calloc(cu, size_of::<mfxMemId>()) as *mut mfxMemId };
    if mids.is_null() {
        unsafe {
            let mut s = surfaces;
            let _ = vaDestroySurfaces(d, s.as_mut_ptr(), n as c_int);
        }
        return MFX_ERR_ALLOC;
    }
    for i in 0..cu {
        let r = Box::new(VaMemId {
            display: d,
            surface: surfaces[i],
            owned: true,
        });
        unsafe {
            *mids.add(i) = Box::into_raw(r) as mfxMemId;
        }
    }
    unsafe {
        (*resp).AllocId = alloc_id;
        (*resp).reserved = [0; 3];
        (*resp).mids = mids;
        (*resp).NumFrameActual = n;
        (*resp).reserved2 = 0;
    }
    if let Ok(mut g) = (unsafe { &(*a).live }).lock() {
        g.push((mids, n));
    }
    MFX_OK
}
unsafe extern "C" fn lock_cb(_p: mfxHDL, m: mfxMemId, ptr: *mut mfxFrameData) -> mfxStatus {
    if !ptr.is_null() {
        unsafe {
            ptr::write_bytes(ptr, 0, 1);
        }
    }
    if m.is_null() {
        return MFX_ERR_NULL;
    }
    MFX_ERR_UNSUP
}
unsafe extern "C" fn unlock_cb(_p: mfxHDL, _m: mfxMemId, ptr: *mut mfxFrameData) -> mfxStatus {
    if !ptr.is_null() {
        unsafe {
            ptr::write_bytes(ptr, 0, 1);
        }
    }
    MFX_OK
}
unsafe extern "C" fn gethdl_cb(_p: mfxHDL, m: mfxMemId, h: *mut mfxHDL) -> mfxStatus {
    if m.is_null() || h.is_null() {
        return MFX_ERR_NULL;
    }
    let r = m as *mut VaMemId;
    unsafe {
        *h = ptr::addr_of_mut!((*r).surface).cast::<c_void>();
    }
    MFX_OK
}
unsafe extern "C" fn free_cb(pthis: mfxHDL, resp: *mut mfxFrameAllocResponse) -> mfxStatus {
    if resp.is_null() {
        return MFX_ERR_NULL;
    }
    let (mids, n) = unsafe { ((*resp).mids, (*resp).NumFrameActual as usize) };
    unsafe {
        (*resp).mids = ptr::null_mut();
        (*resp).NumFrameActual = 0;
    }
    if !pthis.is_null() {
        let a = pthis as *mut Alloc;
        if let Ok(mut g) = (unsafe { &(*a).live }).lock() {
            g.retain(|(p, _)| *p != mids);
        }
    }
    free_mids(mids, n);
    MFX_OK
}

pub struct EncoderInput {
    va: VaState,
    ow: u32,
    oh: u32,
    converting: Cell<Option<usize>>,
}

impl Drop for EncoderInput {
    fn drop(&mut self) {
        // Error cleanup still precedes the compositor lease release. Never
        // destroy an externally read RGB surface while its VPP read is active.
        if let Some(index) = self.converting.get() {
            if let Ok(dst) = self.nv12_surface(index) {
                unsafe {
                    let _ = vaSyncSurface(self.va.display, dst);
                }
            }
        }
    }
}

impl EncoderInput {
    pub fn new(render_node: &Path, width: u32, height: u32) -> Result<Rc<Self>> {
        if width < 2 || height < 2 {
            bail!("invalid encoder input parameters");
        }
        if width > MAX_DIM || height > MAX_DIM || width % 2 != 0 || height % 2 != 0 {
            bail!("dimensions must be even and <=8192");
        }
        let iw = width;
        let ih = height;
        let ow = iw & !1;
        let oh = ih & !1;
        let sw = align16(ow);
        let sh = align16(oh);
        let path = CString::new(render_node.as_os_str().as_bytes().to_vec())?;
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
        if fd < 0 {
            bail!(
                "open render node failed: {}",
                std::io::Error::last_os_error()
            );
        }
        let display = unsafe { vaGetDisplayDRM(fd) };
        if display.is_null() {
            unsafe {
                libc::close(fd);
            }
            bail!("vaGetDisplayDRM failed");
        }
        let mut va = VaState {
            fd,
            display,
            rgb: RefCell::new(Vec::with_capacity(8)),
            sparse_images: RefCell::new(Vec::with_capacity(8)),
            sparse_atlas: RefCell::new(None),
            nv12: Vec::with_capacity(PIPELINE_DEPTH),
            cfg: VA_INVALID,
            ctx: VA_INVALID,
        };
        let (mut maj, mut min) = (0, 0);
        let st = unsafe { vaInitialize(display, &mut maj, &mut min) };
        if st != VA_OK {
            va.display = ptr::null_mut();
            return Err(vae("vaInitialize", st));
        }
        let mut na = pix_attr(VA_NV12);
        let mut nv = vec![VA_INVALID; PIPELINE_DEPTH];
        chkva("vaCreateSurfaces(NV12)", unsafe {
            vaCreateSurfaces(
                display,
                VA_YUV420,
                sw,
                sh,
                nv.as_mut_ptr(),
                nv.len() as u32,
                &mut na as *mut VASurfaceAttrib,
                1,
            )
        })?;
        va.nv12 = nv;
        let mut cfg = VA_INVALID;
        chkva("vaCreateConfig", unsafe {
            vaCreateConfig(
                display,
                VA_PROFILE_NONE_C,
                VA_ENTRY_VPP,
                ptr::null_mut(),
                0,
                &mut cfg as *mut VAConfigID,
            )
        })?;
        va.cfg = cfg;
        let mut ctx = VA_INVALID;
        chkva("vaCreateContext", unsafe {
            vaCreateContext(
                display,
                cfg,
                sw as c_int,
                sh as c_int,
                VA_PROGRESSIVE_C,
                va.nv12.as_mut_ptr(),
                va.nv12.len() as c_int,
                &mut ctx as *mut VAContextID,
            )
        })?;
        va.ctx = ctx;
        Ok(Rc::new(Self {
            va,
            ow,
            oh,
            converting: Cell::new(None),
        }))
    }

    pub fn surface_count(&self) -> usize {
        self.va.nv12.len()
    }

    fn imported_rgb_surface(&self, frame: &Dmabuf) -> Result<VASurfaceID> {
        let key = frame.validate()?;
        let mut cache = self.va.rgb.borrow_mut();
        if let Some(at) = cache.iter().position(|entry| entry.key == key) {
            let entry = cache.remove(at);
            let surface = entry.surface;
            cache.push(entry);
            return Ok(surface);
        }

        let retained_fds = frame
            .planes
            .iter()
            .map(|p| p.fd.try_clone())
            .collect::<std::io::Result<Vec<_>>>()?;
        if cache.len() >= 8 {
            let mut old = cache.remove(0);
            chkva("evict PRIME2 import", unsafe {
                vaDestroySurfaces(self.va.display, &mut old.surface, 1)
            })?;
        }
        let surface = import_rgb(self.va.display, frame)?;
        tracing::info!(
            fourcc = frame.fourcc,
            modifier = frame.modifier,
            planes = frame.planes.len(),
            stride = frame.planes[0].stride,
            imports = cache.len() + 1,
            "native cached direct output DMA-BUF import"
        );
        cache.push(ImportedRgb {
            key,
            surface,
            _fds: retained_fds,
        });
        Ok(surface)
    }

    /// Diagnostic sparse-protocol primitive: copy only `region` from the
    /// imported compositor RGB surface into a CPU-mappable linear VAImage.
    /// The returned bytes preserve the driver's packed 32-bit channel order;
    /// `fourcc` identifies that order so the client can swizzle in a shader.
    /// This is intentionally not used by the production AV1 path.
    pub fn readback_region_32(
        &self,
        frame: &Dmabuf,
        region: DamageRect,
    ) -> Result<(u32, u32, u32, Vec<u8>)> {
        let x1 = region.x.saturating_add(region.width).min(self.ow);
        let y1 = region.y.saturating_add(region.height).min(self.oh);
        let x0 = region.x.min(x1);
        let y0 = region.y.min(y1);
        let width = x1.saturating_sub(x0);
        let height = y1.saturating_sub(y0);
        ensure!(width > 0 && height > 0, "empty sparse readback region");
        ensure!(
            width <= u16::MAX as u32 && height <= u16::MAX as u32,
            "sparse readback region too large"
        );

        let surface = self.imported_rgb_surface(frame)?;
        let preferred = match frame.fourcc {
            DRM_AR24 => [VA_BGRA, VA_BGRX, VA_RGBA, VA_RGBX],
            DRM_AB24 => [VA_RGBA, VA_RGBX, VA_BGRA, VA_BGRX],
            DRM_XR24 => [VA_BGRX, VA_BGRA, VA_RGBX, VA_RGBA],
            DRM_XB24 => [VA_RGBX, VA_RGBA, VA_BGRX, VA_BGRA],
            _ => bail!("unsupported RGB format for sparse readback"),
        };
        let cached = {
            let images = self.va.sparse_images.borrow();
            images
                .iter()
                .find(|image| {
                    image.width == width
                        && image.height == height
                        && preferred.contains(&image.fourcc)
                })
                .copied()
        };
        let image = if let Some(image) = cached {
            image
        } else {
            let max_formats = unsafe { vaMaxNumImageFormats(self.va.display) };
            ensure!(max_formats > 0, "VA reports no image formats");
            let mut formats: Vec<VAImageFormat> =
                (0..max_formats).map(|_| unsafe { zeroed() }).collect();
            let mut num_formats = max_formats;
            chkva("vaQueryImageFormats", unsafe {
                vaQueryImageFormats(self.va.display, formats.as_mut_ptr(), &mut num_formats)
            })?;
            formats.truncate(num_formats.max(0) as usize);
            let mut image_format = preferred
                .into_iter()
                .find_map(|fourcc| {
                    formats
                        .iter()
                        .find(|format| format.fourcc == fourcc)
                        .copied()
                })
                .context("VA exposes no packed 32-bit RGB image format")?;
            let mut raw: VAImage = unsafe { zeroed() };
            chkva("vaCreateImage(sparse)", unsafe {
                vaCreateImage(
                    self.va.display,
                    &mut image_format,
                    width as c_int,
                    height as c_int,
                    &mut raw,
                )
            })?;
            ensure!(
                raw.num_planes == 1,
                "sparse readback image is not packed RGB"
            );
            ensure!(
                raw.pitches[0] >= width.saturating_mul(4),
                "invalid sparse readback pitch"
            );
            let image = SparseImage {
                image_id: raw.image_id,
                buf: raw.buf,
                fourcc: raw.format.fourcc,
                width,
                height,
                pitch: raw.pitches[0],
                offset: raw.offsets[0],
            };
            let mut images = self.va.sparse_images.borrow_mut();
            if images.len() >= 8 {
                let old = images.remove(0);
                chkva("vaDestroyImage(sparse cache evict)", unsafe {
                    vaDestroyImage(self.va.display, old.image_id)
                })?;
            }
            images.push(image);
            image
        };

        (|| -> Result<(u32, u32, u32, Vec<u8>)> {
            chkva("vaGetImage(sparse)", unsafe {
                vaGetImage(
                    self.va.display,
                    surface,
                    x0 as c_int,
                    y0 as c_int,
                    width,
                    height,
                    image.image_id,
                )
            })?;
            let mut mapped: *mut c_void = ptr::null_mut();
            chkva("vaMapBuffer(sparse)", unsafe {
                vaMapBuffer(self.va.display, image.buf, &mut mapped)
            })?;
            let copy_result = (|| -> Result<Vec<u8>> {
                ensure!(!mapped.is_null(), "sparse readback mapped null buffer");
                let row_bytes = width as usize * 4;
                let pitch = image.pitch as usize;
                let offset = image.offset as usize;
                let mut out = vec![0u8; row_bytes * height as usize];
                for row in 0..height as usize {
                    let src = unsafe { (mapped as *const u8).add(offset + row * pitch) };
                    let dst = &mut out[row * row_bytes..(row + 1) * row_bytes];
                    unsafe { ptr::copy_nonoverlapping(src, dst.as_mut_ptr(), row_bytes) };
                }
                Ok(out)
            })();
            let unmap = unsafe { vaUnmapBuffer(self.va.display, image.buf) };
            if unmap != VA_OK {
                return Err(vae("vaUnmapBuffer(sparse)", unmap));
            }
            let bytes = copy_result?;
            Ok((image.fourcc, width, height, bytes))
        })()
    }

    /// Probe whether the media driver can expose an imported compositor RGB
    /// surface as a directly mappable linear image. Some drivers derive a
    /// zero-copy view; tiled layouts may instead be unusable as linear rows.
    pub fn readback_region_derive_32(
        &self,
        frame: &Dmabuf,
        region: DamageRect,
    ) -> Result<(u32, u32, u32, Vec<u8>)> {
        let x1 = region.x.saturating_add(region.width).min(self.ow);
        let y1 = region.y.saturating_add(region.height).min(self.oh);
        let x0 = region.x.min(x1);
        let y0 = region.y.min(y1);
        let width = x1.saturating_sub(x0);
        let height = y1.saturating_sub(y0);
        ensure!(width > 0 && height > 0, "empty derived sparse region");
        let surface = self.imported_rgb_surface(frame)?;
        let mut image: VAImage = unsafe { zeroed() };
        chkva("vaDeriveImage(sparse)", unsafe {
            vaDeriveImage(self.va.display, surface, &mut image)
        })?;
        let result = (|| -> Result<(u32, u32, u32, Vec<u8>)> {
            ensure!(
                image.num_planes == 1,
                "derived sparse image is not packed RGB"
            );
            ensure!(
                [
                    VA_BGRA, VA_BGRX, VA_RGBA, VA_RGBX, VA_XRGB, DRM_AR24, DRM_XR24, DRM_AB24,
                    DRM_XB24
                ]
                .contains(&image.format.fourcc),
                "derived sparse image has unsupported format fourcc=0x{:08x} width={} height={} pitch={}",
                image.format.fourcc,
                image.width,
                image.height,
                image.pitches[0]
            );
            ensure!(
                u32::from(image.width) >= x1 && u32::from(image.height) >= y1,
                "derived sparse image dimensions are smaller than surface"
            );
            ensure!(
                image.pitches[0] >= u32::from(image.width).saturating_mul(4),
                "invalid derived image pitch"
            );
            let mut mapped: *mut c_void = ptr::null_mut();
            chkva("vaMapBuffer(derived sparse)", unsafe {
                vaMapBuffer(self.va.display, image.buf, &mut mapped)
            })?;
            let copy_result = (|| -> Result<Vec<u8>> {
                ensure!(!mapped.is_null(), "derived sparse mapped null buffer");
                let pitch = image.pitches[0] as usize;
                let offset = image.offsets[0] as usize;
                let row_bytes = width as usize * 4;
                let mut out = vec![0u8; row_bytes * height as usize];
                for row in 0..height as usize {
                    let src_at = offset + (y0 as usize + row) * pitch + x0 as usize * 4;
                    let src = unsafe { (mapped as *const u8).add(src_at) };
                    let dst = &mut out[row * row_bytes..(row + 1) * row_bytes];
                    unsafe { ptr::copy_nonoverlapping(src, dst.as_mut_ptr(), row_bytes) };
                }
                Ok(out)
            })();
            let unmap = unsafe { vaUnmapBuffer(self.va.display, image.buf) };
            if unmap != VA_OK {
                return Err(vae("vaUnmapBuffer(derived sparse)", unmap));
            }
            Ok((image.format.fourcc, width, height, copy_result?))
        })();
        let destroy = unsafe { vaDestroyImage(self.va.display, image.image_id) };
        if destroy != VA_OK {
            return Err(vae("vaDestroyImage(derived sparse)", destroy));
        }
        result
    }

    /// Read one bounding rectangle from the GPU, but return only the original
    /// damage rectangles. This pays the fixed vaGetImage cost once per desktop
    /// frame while keeping network payload proportional to actual damage.
    pub fn readback_rects_bounding_32(
        &self,
        frame: &Dmabuf,
        rects: &[DamageRect],
    ) -> Result<(u32, Vec<(DamageRect, Vec<u8>)>)> {
        ensure!(
            !rects.is_empty() && rects.len() <= 16,
            "invalid sparse rect count"
        );
        let mut clipped = Vec::with_capacity(rects.len());
        let mut x0 = self.ow;
        let mut y0 = self.oh;
        let mut x1 = 0u32;
        let mut y1 = 0u32;
        for rect in rects {
            let rx0 = rect.x.min(self.ow);
            let ry0 = rect.y.min(self.oh);
            let rx1 = rect.x.saturating_add(rect.width).min(self.ow);
            let ry1 = rect.y.saturating_add(rect.height).min(self.oh);
            if rx1 <= rx0 || ry1 <= ry0 {
                continue;
            }
            let rect = DamageRect {
                x: rx0,
                y: ry0,
                width: rx1 - rx0,
                height: ry1 - ry0,
            };
            x0 = x0.min(rx0);
            y0 = y0.min(ry0);
            x1 = x1.max(rx1);
            y1 = y1.max(ry1);
            clipped.push(rect);
        }
        ensure!(!clipped.is_empty(), "no non-empty sparse rectangles");
        let bounds = DamageRect {
            x: x0,
            y: y0,
            width: x1 - x0,
            height: y1 - y0,
        };
        let (fourcc, width, height, bounding) = self.readback_region_32(frame, bounds)?;
        let stride = width as usize * 4;
        let mut output = Vec::with_capacity(clipped.len());
        for rect in clipped {
            let local_x = (rect.x - bounds.x) as usize;
            let local_y = (rect.y - bounds.y) as usize;
            let row_bytes = rect.width as usize * 4;
            let mut data = vec![0u8; row_bytes * rect.height as usize];
            for row in 0..rect.height as usize {
                let src_at = (local_y + row) * stride + local_x * 4;
                let dst_at = row * row_bytes;
                data[dst_at..dst_at + row_bytes]
                    .copy_from_slice(&bounding[src_at..src_at + row_bytes]);
            }
            output.push((rect, data));
        }
        debug_assert_eq!(height, bounds.height);
        Ok((fourcc, output))
    }

    fn sparse_atlas(&self) -> Result<SparseAtlas> {
        if let Some(atlas) = *self.va.sparse_atlas.borrow() {
            return Ok(atlas);
        }
        const ATLAS_W: u32 = 512;
        const ATLAS_H: u32 = 512;
        let mut attr = pix_attr(VA_BGRX);
        let mut surface = VA_INVALID;
        chkva("vaCreateSurfaces(sparse atlas)", unsafe {
            vaCreateSurfaces(
                self.va.display,
                VA_RGB32,
                ATLAS_W,
                ATLAS_H,
                &mut surface,
                1,
                &mut attr,
                1,
            )
        })?;
        let atlas = SparseAtlas {
            surface,
            width: ATLAS_W,
            height: ATLAS_H,
            fourcc: VA_BGRX,
        };
        *self.va.sparse_atlas.borrow_mut() = Some(atlas);
        Ok(atlas)
    }

    fn readback_surface_32(
        &self,
        surface: VASurfaceID,
        width: u32,
        height: u32,
        preferred: [u32; 4],
    ) -> Result<(u32, Vec<u8>)> {
        let cached = {
            let images = self.va.sparse_images.borrow();
            images
                .iter()
                .find(|image| {
                    image.width == width
                        && image.height == height
                        && preferred.contains(&image.fourcc)
                })
                .copied()
        };
        let image = if let Some(image) = cached {
            image
        } else {
            let max_formats = unsafe { vaMaxNumImageFormats(self.va.display) };
            ensure!(max_formats > 0, "VA reports no image formats");
            let mut formats: Vec<VAImageFormat> =
                (0..max_formats).map(|_| unsafe { zeroed() }).collect();
            let mut num_formats = max_formats;
            chkva("vaQueryImageFormats", unsafe {
                vaQueryImageFormats(self.va.display, formats.as_mut_ptr(), &mut num_formats)
            })?;
            formats.truncate(num_formats.max(0) as usize);
            let mut image_format = preferred
                .into_iter()
                .find_map(|fourcc| {
                    formats
                        .iter()
                        .find(|format| format.fourcc == fourcc)
                        .copied()
                })
                .context("VA exposes no packed 32-bit RGB image format")?;
            let mut raw: VAImage = unsafe { zeroed() };
            chkva("vaCreateImage(sparse surface)", unsafe {
                vaCreateImage(
                    self.va.display,
                    &mut image_format,
                    width as c_int,
                    height as c_int,
                    &mut raw,
                )
            })?;
            ensure!(
                raw.num_planes == 1,
                "sparse surface image is not packed RGB"
            );
            ensure!(
                raw.pitches[0] >= width.saturating_mul(4),
                "invalid sparse surface pitch"
            );
            let image = SparseImage {
                image_id: raw.image_id,
                buf: raw.buf,
                fourcc: raw.format.fourcc,
                width,
                height,
                pitch: raw.pitches[0],
                offset: raw.offsets[0],
            };
            let mut images = self.va.sparse_images.borrow_mut();
            if images.len() >= 8 {
                let old = images.remove(0);
                chkva("vaDestroyImage(sparse surface cache evict)", unsafe {
                    vaDestroyImage(self.va.display, old.image_id)
                })?;
            }
            images.push(image);
            image
        };
        chkva("vaGetImage(sparse surface)", unsafe {
            vaGetImage(
                self.va.display,
                surface,
                0,
                0,
                width,
                height,
                image.image_id,
            )
        })?;
        let mut mapped: *mut c_void = ptr::null_mut();
        chkva("vaMapBuffer(sparse surface)", unsafe {
            vaMapBuffer(self.va.display, image.buf, &mut mapped)
        })?;
        let copy_result = (|| -> Result<Vec<u8>> {
            ensure!(!mapped.is_null(), "sparse surface mapped null buffer");
            let row_bytes = width as usize * 4;
            let pitch = image.pitch as usize;
            let offset = image.offset as usize;
            let mut out = vec![0u8; row_bytes * height as usize];
            for row in 0..height as usize {
                let src = unsafe { (mapped as *const u8).add(offset + row * pitch) };
                let dst = &mut out[row * row_bytes..(row + 1) * row_bytes];
                unsafe { ptr::copy_nonoverlapping(src, dst.as_mut_ptr(), row_bytes) };
            }
            Ok(out)
        })();
        let unmap = unsafe { vaUnmapBuffer(self.va.display, image.buf) };
        if unmap != VA_OK {
            return Err(vae("vaUnmapBuffer(sparse surface)", unmap));
        }
        Ok((image.fourcc, copy_result?))
    }

    /// Pack multiple compositor damage rectangles into one 512x512 RGB atlas
    /// on the GPU, then perform a single CPU readback. The payload remains one
    /// tight byte vector per original rectangle; atlas gaps are never sent.
    pub fn readback_rects_packed_32(
        &self,
        frame: &Dmabuf,
        rects: &[DamageRect],
    ) -> Result<(u32, Vec<(DamageRect, Vec<u8>)>)> {
        ensure!(
            !rects.is_empty() && rects.len() <= 16,
            "invalid sparse rect count"
        );
        let src = self.imported_rgb_surface(frame)?;
        let atlas = self.sparse_atlas()?;
        let mut placements = Vec::with_capacity(rects.len());
        let mut px = 0u32;
        let mut py = 0u32;
        let mut row_h = 0u32;
        for rect in rects {
            let x1 = rect.x.saturating_add(rect.width).min(self.ow);
            let y1 = rect.y.saturating_add(rect.height).min(self.oh);
            let x0 = rect.x.min(x1);
            let y0 = rect.y.min(y1);
            let clipped = DamageRect {
                x: x0,
                y: y0,
                width: x1.saturating_sub(x0),
                height: y1.saturating_sub(y0),
            };
            if clipped.width == 0 || clipped.height == 0 {
                continue;
            }
            ensure!(
                clipped.width <= atlas.width && clipped.height <= atlas.height,
                "sparse rectangle exceeds atlas"
            );
            if px.saturating_add(clipped.width) > atlas.width {
                py = py.saturating_add(row_h);
                px = 0;
                row_h = 0;
            }
            ensure!(
                py.saturating_add(clipped.height) <= atlas.height,
                "sparse rectangles do not fit atlas"
            );
            placements.push((clipped, px, py));
            px = px.saturating_add(clipped.width);
            row_h = row_h.max(clipped.height);
        }
        ensure!(!placements.is_empty(), "no non-empty sparse rectangles");

        let mut buffers = Vec::<VABufferID>::with_capacity(placements.len());
        let begin = unsafe { vaBeginPicture(self.va.display, self.va.ctx, atlas.surface) };
        if begin != VA_OK {
            return Err(vae("vaBeginPicture(sparse atlas)", begin));
        }
        let mut render_error: Option<anyhow::Error> = None;
        for (rect, out_x, out_y) in &placements {
            let mut sreg = VARectangle {
                x: rect.x as i16,
                y: rect.y as i16,
                width: rect.width as u16,
                height: rect.height as u16,
            };
            let mut dreg = VARectangle {
                x: *out_x as i16,
                y: *out_y as i16,
                width: rect.width as u16,
                height: rect.height as u16,
            };
            let mut par: VAProcPipelineParameterBuffer = unsafe { zeroed() };
            par.surface = src;
            par.surface_color_standard = ffi::_VAProcColorStandardType_VAProcColorStandardExplicit;
            par.output_color_standard = ffi::_VAProcColorStandardType_VAProcColorStandardExplicit;
            par.input_color_properties.color_range = ffi::VA_SOURCE_RANGE_FULL as u8;
            par.input_color_properties.colour_primaries = 1;
            par.input_color_properties.transfer_characteristics = 13;
            par.input_color_properties.matrix_coefficients = 0;
            par.output_color_properties.color_range = ffi::VA_SOURCE_RANGE_FULL as u8;
            par.output_color_properties.colour_primaries = 1;
            par.output_color_properties.transfer_characteristics = 13;
            par.output_color_properties.matrix_coefficients = 0;
            par.surface_region = &mut sreg;
            par.output_region = &mut dreg;
            par.output_background_color = 0;
            par.blend_state = ptr::null();
            par.filter_flags = ffi::VA_FILTER_SCALING_DEFAULT;
            let mut buf = VA_INVALID;
            let created = unsafe {
                vaCreateBuffer(
                    self.va.display,
                    self.va.ctx,
                    VA_BUF_VPP,
                    size_of::<VAProcPipelineParameterBuffer>() as u32,
                    1,
                    &mut par as *mut _ as *mut c_void,
                    &mut buf,
                )
            };
            if created != VA_OK {
                render_error = Some(vae("vaCreateBuffer(sparse atlas)", created));
                break;
            }
            buffers.push(buf);
            let rendered = unsafe { vaRenderPicture(self.va.display, self.va.ctx, &mut buf, 1) };
            if rendered != VA_OK {
                render_error = Some(vae("vaRenderPicture(sparse atlas)", rendered));
                break;
            }
        }
        let end = unsafe { vaEndPicture(self.va.display, self.va.ctx) };
        for buf in buffers {
            unsafe {
                let _ = vaDestroyBuffer(self.va.display, buf);
            }
        }
        if let Some(error) = render_error {
            return Err(error);
        }
        chkva("vaEndPicture(sparse atlas)", end)?;
        chkva("vaSyncSurface(sparse atlas)", unsafe {
            vaSyncSurface(self.va.display, atlas.surface)
        })?;
        let (fourcc, atlas_bytes) = self.readback_surface_32(
            atlas.surface,
            atlas.width,
            atlas.height,
            [atlas.fourcc, VA_BGRA, VA_RGBX, VA_RGBA],
        )?;
        let atlas_stride = atlas.width as usize * 4;
        let mut output = Vec::with_capacity(placements.len());
        for (rect, out_x, out_y) in placements {
            let row_bytes = rect.width as usize * 4;
            let mut data = vec![0u8; row_bytes * rect.height as usize];
            for row in 0..rect.height as usize {
                let src_at = (out_y as usize + row) * atlas_stride + out_x as usize * 4;
                let dst_at = row * row_bytes;
                data[dst_at..dst_at + row_bytes]
                    .copy_from_slice(&atlas_bytes[src_at..src_at + row_bytes]);
            }
            output.push((rect, data));
        }
        Ok((fourcc, output))
    }

    fn nv12_surface(&self, surface_index: usize) -> Result<VASurfaceID> {
        self.va
            .nv12
            .get(surface_index)
            .copied()
            .ok_or_else(|| anyhow!("NV12 surface index out of range"))
    }

    /// Submit RGB -> NV12 conversion and return immediately after vaEndPicture.
    /// The caller must call `finish_convert()` before the NV12 surface is given
    /// to oneVPL or the RGB capture slot is reused.
    pub fn begin_convert(
        &self,
        frame: &Dmabuf,
        surface_index: usize,
        damage: &[DamageRect],
        previous_surface: Option<usize>,
    ) -> Result<DamageRect> {
        if self.converting.get().is_some() {
            bail!("VPP already has an in-flight conversion");
        }
        if frame.width != self.ow || frame.height != self.oh {
            bail!("capture size changed");
        }
        let src = self.imported_rgb_surface(frame)?;
        let dst = self.nv12_surface(surface_index)?;
        let region = self.coalesce_damage(damage);
        let full = DamageRect::full(self.ow, self.oh);
        if let Some(previous_index) = previous_surface.filter(|index| *index != surface_index) {
            if region.area() < full.area() {
                let previous = self.nv12_surface(previous_index)?;
                self.submit_reuse_patch(previous, src, dst, region)?;
            } else {
                self.submit_convert(src, dst, full)?;
            }
        } else {
            // The first frame must initialize every output pixel. A partial
            // VAProc render is not an in-place patch contract on iHD.
            self.submit_convert(src, dst, full)?;
        }
        self.converting.set(Some(surface_index));
        Ok(if previous_surface.is_some() {
            region
        } else {
            full
        })
    }

    fn coalesce_damage(&self, damage: &[DamageRect]) -> DamageRect {
        let full = DamageRect::full(self.ow, self.oh);
        if damage.is_empty() {
            return full;
        }

        let mut x0 = self.ow;
        let mut y0 = self.oh;
        let mut x1 = 0u32;
        let mut y1 = 0u32;
        let mut any = false;
        for rect in damage {
            let rx0 = rect.x.min(self.ow);
            let ry0 = rect.y.min(self.oh);
            let rx1 = rect.x.saturating_add(rect.width).min(self.ow);
            let ry1 = rect.y.saturating_add(rect.height).min(self.oh);
            if rx1 <= rx0 || ry1 <= ry0 {
                continue;
            }
            x0 = x0.min(rx0);
            y0 = y0.min(ry0);
            x1 = x1.max(rx1);
            y1 = y1.max(ry1);
            any = true;
        }
        if !any {
            return full;
        }

        // NV12 is 4:2:0; 16-pixel expansion also keeps the VPP region aligned
        // with the encoder's macroblock/superblock-friendly update granularity.
        x0 &= !15;
        y0 &= !15;
        x1 = align16(x1).min(self.ow);
        y1 = align16(y1).min(self.oh);
        let region = DamageRect {
            x: x0,
            y: y0,
            width: x1.saturating_sub(x0),
            height: y1.saturating_sub(y0),
        };
        if region.width == 0 || region.height == 0 {
            return full;
        }
        // There is only one VAProc submission either way. Large bounding boxes
        // are cheaper and less surprising as a normal full-frame CSC.
        if region.area().saturating_mul(4) >= full.area().saturating_mul(3) {
            full
        } else {
            region
        }
    }

    fn submit_convert(&self, src: VASurfaceID, dst: VASurfaceID, region: DamageRect) -> Result<()> {
        let mut sreg = VARectangle {
            x: region.x as i16,
            y: region.y as i16,
            width: region.width as u16,
            height: region.height as u16,
        };
        let mut dreg = VARectangle {
            x: region.x as i16,
            y: region.y as i16,
            width: region.width as u16,
            height: region.height as u16,
        };
        let mut par: VAProcPipelineParameterBuffer = unsafe { zeroed() };
        par.surface = src;
        // Match the actual full-range desktop RGB and encoder VUI. The short
        // SRGB/BT709 enums with unspecified transfer properties do not reproduce
        // this conversion on the supported VA path. These explicit values are
        // verified against source color bars and the previous VAAPI pipeline trace.
        par.surface_color_standard = ffi::_VAProcColorStandardType_VAProcColorStandardExplicit;
        par.output_color_standard = ffi::_VAProcColorStandardType_VAProcColorStandardExplicit;
        par.input_color_properties.color_range = ffi::VA_SOURCE_RANGE_FULL as u8;
        par.input_color_properties.colour_primaries = 1;
        par.input_color_properties.transfer_characteristics = 13;
        par.input_color_properties.matrix_coefficients = 0;
        par.output_color_properties.color_range = ffi::VA_SOURCE_RANGE_FULL as u8;
        par.output_color_properties.colour_primaries = 1;
        par.output_color_properties.transfer_characteristics = 1;
        par.output_color_properties.matrix_coefficients = 1;
        par.surface_region = &mut sreg as *mut VARectangle;
        par.output_region = &mut dreg as *mut VARectangle;
        par.output_background_color = 0xff00_0000;
        // The compositor already produced a complete opaque output. Request
        // only CSC/chroma conversion, not a second alpha composition pass.
        par.blend_state = ptr::null();
        // Source and destination are always 1:1. Asking the media driver for
        // the high-quality scaling path here cannot improve the image and may
        // select extra sampler/filter work. DEFAULT keeps this as CSC/chroma
        // conversion only.
        par.filter_flags = ffi::VA_FILTER_SCALING_DEFAULT;
        let mut buf = VA_INVALID;
        chkva("vaCreateBuffer(VPP)", unsafe {
            vaCreateBuffer(
                self.va.display,
                self.va.ctx,
                VA_BUF_VPP,
                size_of::<VAProcPipelineParameterBuffer>() as u32,
                1,
                &mut par as *mut _ as *mut c_void,
                &mut buf as *mut VABufferID,
            )
        })?;
        let b = unsafe { vaBeginPicture(self.va.display, self.va.ctx, dst) };
        if b != VA_OK {
            unsafe {
                let _ = vaDestroyBuffer(self.va.display, buf);
            }
            return Err(vae("vaBeginPicture", b));
        }
        let r = unsafe {
            vaRenderPicture(self.va.display, self.va.ctx, &mut buf as *mut VABufferID, 1)
        };
        let e = unsafe { vaEndPicture(self.va.display, self.va.ctx) };
        let d = unsafe { vaDestroyBuffer(self.va.display, buf) };
        if r != VA_OK {
            return Err(vae("vaRenderPicture", r));
        }
        if e != VA_OK {
            return Err(vae("vaEndPicture", e));
        }
        if d != VA_OK {
            return Err(vae("vaDestroyBuffer", d));
        }
        Ok(())
    }

    /// Build a complete destination frame from the previous canonical NV12
    /// surface plus the current RGB damage region in one VAProc picture. The
    /// first source covers the whole output; the second source overwrites only
    /// the changed rectangle. Unlike relying on output_region preservation,
    /// every destination pixel is explicitly produced this frame.
    fn submit_reuse_patch(
        &self,
        previous: VASurfaceID,
        rgb: VASurfaceID,
        dst: VASurfaceID,
        region: DamageRect,
    ) -> Result<()> {
        let mut full_src = VARectangle {
            x: 0,
            y: 0,
            width: self.ow as u16,
            height: self.oh as u16,
        };
        let mut full_dst = full_src;
        let mut patch_src = VARectangle {
            x: region.x as i16,
            y: region.y as i16,
            width: region.width as u16,
            height: region.height as u16,
        };
        let mut patch_dst = patch_src;

        let mut base: VAProcPipelineParameterBuffer = unsafe { zeroed() };
        base.surface = previous;
        base.surface_color_standard = ffi::_VAProcColorStandardType_VAProcColorStandardExplicit;
        base.output_color_standard = ffi::_VAProcColorStandardType_VAProcColorStandardExplicit;
        base.input_color_properties.color_range = ffi::VA_SOURCE_RANGE_FULL as u8;
        base.input_color_properties.colour_primaries = 1;
        base.input_color_properties.transfer_characteristics = 1;
        base.input_color_properties.matrix_coefficients = 1;
        base.output_color_properties.color_range = ffi::VA_SOURCE_RANGE_FULL as u8;
        base.output_color_properties.colour_primaries = 1;
        base.output_color_properties.transfer_characteristics = 1;
        base.output_color_properties.matrix_coefficients = 1;
        base.surface_region = &mut full_src as *mut VARectangle;
        base.output_region = &mut full_dst as *mut VARectangle;
        base.output_background_color = 0xff00_0000;
        base.blend_state = ptr::null();
        base.filter_flags = ffi::VA_FILTER_SCALING_DEFAULT;

        let mut patch: VAProcPipelineParameterBuffer = unsafe { zeroed() };
        patch.surface = rgb;
        patch.surface_color_standard = ffi::_VAProcColorStandardType_VAProcColorStandardExplicit;
        patch.output_color_standard = ffi::_VAProcColorStandardType_VAProcColorStandardExplicit;
        patch.input_color_properties.color_range = ffi::VA_SOURCE_RANGE_FULL as u8;
        patch.input_color_properties.colour_primaries = 1;
        patch.input_color_properties.transfer_characteristics = 13;
        patch.input_color_properties.matrix_coefficients = 0;
        patch.output_color_properties.color_range = ffi::VA_SOURCE_RANGE_FULL as u8;
        patch.output_color_properties.colour_primaries = 1;
        patch.output_color_properties.transfer_characteristics = 1;
        patch.output_color_properties.matrix_coefficients = 1;
        patch.surface_region = &mut patch_src as *mut VARectangle;
        patch.output_region = &mut patch_dst as *mut VARectangle;
        patch.output_background_color = 0;
        patch.blend_state = ptr::null();
        patch.filter_flags = ffi::VA_FILTER_SCALING_DEFAULT;

        let mut base_buf = VA_INVALID;
        let mut patch_buf = VA_INVALID;
        chkva("vaCreateBuffer(VPP reuse base)", unsafe {
            vaCreateBuffer(
                self.va.display,
                self.va.ctx,
                VA_BUF_VPP,
                size_of::<VAProcPipelineParameterBuffer>() as u32,
                1,
                &mut base as *mut _ as *mut c_void,
                &mut base_buf as *mut VABufferID,
            )
        })?;
        let patch_create = unsafe {
            vaCreateBuffer(
                self.va.display,
                self.va.ctx,
                VA_BUF_VPP,
                size_of::<VAProcPipelineParameterBuffer>() as u32,
                1,
                &mut patch as *mut _ as *mut c_void,
                &mut patch_buf as *mut VABufferID,
            )
        };
        if patch_create != VA_OK {
            unsafe {
                let _ = vaDestroyBuffer(self.va.display, base_buf);
            }
            return Err(vae("vaCreateBuffer(VPP reuse patch)", patch_create));
        }

        let begin = unsafe { vaBeginPicture(self.va.display, self.va.ctx, dst) };
        if begin != VA_OK {
            unsafe {
                let _ = vaDestroyBuffer(self.va.display, base_buf);
                let _ = vaDestroyBuffer(self.va.display, patch_buf);
            }
            return Err(vae("vaBeginPicture(VPP reuse)", begin));
        }
        let base_render = unsafe {
            vaRenderPicture(
                self.va.display,
                self.va.ctx,
                &mut base_buf as *mut VABufferID,
                1,
            )
        };
        let patch_render = if base_render == VA_OK {
            unsafe {
                vaRenderPicture(
                    self.va.display,
                    self.va.ctx,
                    &mut patch_buf as *mut VABufferID,
                    1,
                )
            }
        } else {
            base_render
        };
        let end = unsafe { vaEndPicture(self.va.display, self.va.ctx) };
        let destroy_base = unsafe { vaDestroyBuffer(self.va.display, base_buf) };
        let destroy_patch = unsafe { vaDestroyBuffer(self.va.display, patch_buf) };
        if base_render != VA_OK {
            return Err(vae("vaRenderPicture(VPP reuse base)", base_render));
        }
        if patch_render != VA_OK {
            return Err(vae("vaRenderPicture(VPP reuse patch)", patch_render));
        }
        if end != VA_OK {
            return Err(vae("vaEndPicture(VPP reuse)", end));
        }
        if destroy_base != VA_OK {
            return Err(vae("vaDestroyBuffer(VPP reuse base)", destroy_base));
        }
        if destroy_patch != VA_OK {
            return Err(vae("vaDestroyBuffer(VPP reuse patch)", destroy_patch));
        }
        Ok(())
    }

    /// Complete a previously submitted VPP operation.  This is deliberately a
    /// separate call so the worker can harvest oneVPL completions while the VPP
    /// engine is processing the next frame.
    pub fn finish_convert(&self, surface_index: usize) -> Result<()> {
        if self.converting.get() != Some(surface_index) {
            bail!("VPP completion ownership mismatch");
        }
        let dst = self.nv12_surface(surface_index)?;
        // VAProc and oneVPL use separate producer/consumer contexts. A oneVPL
        // SyncOperation is not an acquire barrier for externally-produced VA
        // surfaces, so synchronize the VPP output before handing it to encode.
        chkva("vaSyncSurface(VPP output)", unsafe {
            vaSyncSurface(self.va.display, dst)
        })?;
        self.converting.set(None);
        Ok(())
    }
}

struct EncodeSlot {
    bs: Vec<u8>,
    bit: mfxBitstream,
    input: mfxFrameSurface1,
    mid: Box<VaMemId>,
    pending_sync: mfxSyncPoint,
    surface_index: Option<usize>,
    started: Option<Instant>,
    submit_us: u64,
    pts_us: u64,
}

pub struct EncodedFrame {
    pub surface_index: usize,
    pub data: Vec<u8>,
    pub keyframe: bool,
    pub encode_us: u64,
    pub submit_us: u64,
    pub pts_us: u64,
}

pub struct Encoder {
    // Keeps the shared VA display/NV12 ring alive until this oneVPL session has
    // been closed. Each async encode slot points at one ring surface at a time.
    _encoder_input: Rc<EncoderInput>,
    vpl: VplState,
    alloc: Box<Alloc>,
    slots: Vec<EncodeSlot>,
    pending_order: VecDeque<usize>,
    frame: u32,
}

// Construct and use on the encoding thread; native handles are not exposed as Send.
impl Drop for Encoder {
    fn drop(&mut self) {
        self.vpl.kill();
        self.alloc.cleanup();
    }
}

impl Encoder {
    pub fn new(
        encoder_input: Rc<EncoderInput>,
        fps: u32,
        rate_control: &RateControlConfig,
        gop: &GopConfig,
        onevpl_vendor_impl_id: u32,
        codec: Codec,
    ) -> Result<Self> {
        rate_control.validate(fps)?;
        gop.validate()?;
        let display = encoder_input.va.display;
        let ow = encoder_input.ow;
        let oh = encoder_input.oh;
        let sw = align16(ow);
        let sh = align16(oh);
        let mut alloc = Alloc::new(display);
        let mut vpl = VplState::new();
        let loader = unsafe { MFXLoad() };
        if loader.is_null() {
            bail!("MFXLoad failed");
        }
        vpl.loader = loader;
        filter(loader, b"mfxImplDescription.Impl\0", MFX_IMPL_HW)?;
        // Hosts with multiple oneVPL implementations can pin the desired
        // VendorImplID through deployment YAML. Zero keeps dispatcher selection portable.
        if onevpl_vendor_impl_id != 0 {
            filter(
                loader,
                b"mfxImplDescription.VendorImplID\0",
                onevpl_vendor_impl_id,
            )?;
        }
        filter(loader, b"mfxImplDescription.ApiVersion.Version\0", 2 << 16)?;
        filter(
            loader,
            b"mfxImplDescription.AccelerationMode\0",
            MFX_ACCEL_VAAPI_C,
        )?;
        filter(
            loader,
            b"mfxImplDescription.mfxEncoderDescription.encoder.CodecID\0",
            codec.id(),
        )?;
        let mut session: mfxSession = ptr::null_mut();
        let st = unsafe { MFXCreateSession(loader, 0, &mut session) };
        if st < 0 || session.is_null() {
            bail!("MFXCreateSession failed: {st}");
        }
        vpl.session = session;
        chkmfx("SetHandle", unsafe {
            MFXVideoCORE_SetHandle(session, MFX_HANDLE_VA, display as mfxHDL)
        })?;
        chkmfx("SetAlloc", unsafe {
            MFXVideoCORE_SetFrameAllocator(session, &mut alloc.api as *mut mfxFrameAllocator)
        })?;
        let mult = bs_mult(rate_control.bitrate_ceiling());
        let mut m: mfxInfoMFX = unsafe { zeroed() };
        m.LowPower = MFX_ON;
        m.BRCParamMultiplier = mult;
        m.FrameInfo = make_info(MFX_NV12, ow as u16, oh as u16, fps);
        m.CodecId = codec.id();
        m.CodecProfile = codec.profile();
        // SAFETY: zeroed struct then populate the encoder rate-control union view.
        unsafe {
            let e = &mut m.__bindgen_anon_1.__bindgen_anon_1;
            e.TargetUsage = rate_control.target_usage;
            e.GopPicSize = gop.pictures;
            e.GopRefDist = gop.ref_distance;
            e.GopOptFlag = if gop.strict {
                ffi::MFX_GOP_STRICT as u16
            } else {
                0
            };
            e.IdrInterval = gop.idr_interval;
            e.RateControlMethod = rate_control.mode.onevpl();
            match rate_control.mode {
                RateControlMode::Cbr => {
                    let buffer_kb = rate_control.cbr_buffer_size_kb.unwrap_or_else(|| {
                        rc_buffer_kb(
                            rate_control.cbr_target_kbps,
                            fps,
                            rate_control.cbr_buffer_frames,
                            mult,
                        )
                    });
                    let initial_kb = rate_control.cbr_initial_delay_kb.unwrap_or_else(|| {
                        if rate_control.cbr_initial_delay_frames == 0 {
                            0
                        } else {
                            rc_buffer_kb(
                                rate_control.cbr_target_kbps,
                                fps,
                                rate_control.cbr_initial_delay_frames,
                                mult,
                            )
                            .min(buffer_kb)
                        }
                    });
                    e.__bindgen_anon_1.InitialDelayInKB = bs_target_allow_zero(initial_kb, mult);
                    e.BufferSizeInKB = bs_target(buffer_kb, mult);
                    e.__bindgen_anon_2.TargetKbps = bs_target(rate_control.cbr_target_kbps, mult);
                }
                RateControlMode::Vbr => {
                    let buffer_kb = rate_control.vbr_buffer_size_kb.unwrap_or_else(|| {
                        rc_buffer_kb(
                            rate_control.vbr_max_kbps,
                            fps,
                            rate_control.vbr_buffer_frames,
                            mult,
                        )
                    });
                    let initial_kb = rate_control.vbr_initial_delay_kb.unwrap_or_else(|| {
                        if rate_control.vbr_initial_delay_frames == 0 {
                            0
                        } else {
                            rc_buffer_kb(
                                rate_control.vbr_max_kbps,
                                fps,
                                rate_control.vbr_initial_delay_frames,
                                mult,
                            )
                            .min(buffer_kb)
                        }
                    });
                    e.__bindgen_anon_1.InitialDelayInKB = bs_target_allow_zero(initial_kb, mult);
                    e.BufferSizeInKB = bs_target(buffer_kb, mult);
                    e.__bindgen_anon_2.TargetKbps = bs_target(rate_control.vbr_target_kbps, mult);
                    e.__bindgen_anon_3.MaxKbps = bs_target(rate_control.vbr_max_kbps, mult);
                }
                RateControlMode::Cqp => {
                    e.__bindgen_anon_1.QPI = rate_control.cqp_qpi;
                    e.__bindgen_anon_2.QPP = rate_control.cqp_qpp;
                    e.__bindgen_anon_3.QPB = rate_control.cqp_qpb;
                }
                RateControlMode::Icq => {
                    e.__bindgen_anon_2.ICQQuality = rate_control.icq_quality;
                }
            }
            e.NumRefFrame = 1;
        }
        let mut c3: mfxExtCodingOption3 = unsafe { zeroed() };
        c3.Header.BufferId = MFX_EXT_CO3;
        c3.Header.BufferSz = size_of::<mfxExtCodingOption3>() as u32;
        c3.ScenarioInfo = MFX_SCENARIO_REMOTE;
        c3.ContentInfo = MFX_CONTENT_SCREEN;
        if rate_control.mode == RateControlMode::Vbr {
            c3.MaxFrameSizeI = rate_control.vbr_max_frame_size_i_bytes.unwrap_or(0);
            c3.MaxFrameSizeP = rate_control.vbr_max_frame_size_p_bytes.unwrap_or(0);
            c3.AdaptiveMaxFrameSize = MFX_OFF;
        }
        // LowDelayBRC is only meaningful for the VBR family. Keep it disabled
        // for CBR/CQP/ICQ even though CodingOption3 is shared by all modes.
        c3.LowDelayBRC =
            if rate_control.mode == RateControlMode::Vbr && rate_control.vbr_low_delay_brc {
                MFX_ON
            } else {
                MFX_OFF
            };
        let mut signal: mfxExtVideoSignalInfo = unsafe { zeroed() };
        signal.Header.BufferId = ffi::MFX_EXTBUFF_VIDEO_SIGNAL_INFO;
        signal.Header.BufferSz = size_of::<mfxExtVideoSignalInfo>() as u32;
        signal.VideoFormat = 5;
        // Remote desktop content originates as full-range sRGB. Keep the
        // RGB->NV12 conversion full-range and advertise that exact range in
        // AV1 video signal metadata so the decoder does not apply a studio-
        // range expansion to already full-range samples.
        signal.VideoFullRange = 1;
        signal.ColourDescriptionPresent = 1;
        signal.ColourPrimaries = 1;
        signal.TransferCharacteristics = 1;
        signal.MatrixCoefficients = 1;
        let mut av1_bs: mfxExtAV1BitstreamParam = unsafe { zeroed() };
        av1_bs.Header.BufferId = MFX_EXT_AV1_BS;
        av1_bs.Header.BufferSz = size_of::<mfxExtAV1BitstreamParam>() as u32;
        // Raw low-overhead AV1 OBU stream. Browsers/RTP do not want IVF file
        // headers inside individual encoded samples.
        av1_bs.WriteIVFHeaders = MFX_OFF;
        let mut ext: [*mut mfxExtBuffer; 3] = [
            (&mut c3 as *mut mfxExtCodingOption3).cast::<mfxExtBuffer>(),
            (&mut signal as *mut mfxExtVideoSignalInfo).cast::<mfxExtBuffer>(),
            (&mut av1_bs as *mut mfxExtAV1BitstreamParam).cast::<mfxExtBuffer>(),
        ];
        let mut p: mfxVideoParam = unsafe { zeroed() };
        // Keep the encoder's *internal* queue at one frame. The application
        // pipeline is asynchronous across render/VPP/encode stages, but letting
        // oneVPL buffer several AV1 inputs returns MFX_ERR_MORE_DATA while it
        // fills that queue and adds fixed frame latency. One encode in flight is
        // enough to overlap VCS(N) with VPP/render(N+1).
        p.AsyncDepth = ENCODE_ASYNC_DEPTH as u16;
        p.IOPattern = MFX_IN_VIDEO;
        p.ExtParam = ext.as_mut_ptr();
        p.NumExtParam = 3;
        p.__bindgen_anon_1.mfx = m;
        query(session, &mut p)?;
        let queried_mfx = unsafe { p.__bindgen_anon_1.mfx };
        let (queried_rc, queried_a, queried_b, queried_c, queried_buffer, queried_target_usage) = unsafe {
            let e = &queried_mfx.__bindgen_anon_1.__bindgen_anon_1;
            (
                e.RateControlMethod,
                e.__bindgen_anon_1.InitialDelayInKB,
                e.__bindgen_anon_2.TargetKbps,
                e.__bindgen_anon_3.MaxKbps,
                e.BufferSizeInKB,
                e.TargetUsage,
            )
        };
        let queried_mult = queried_mfx.BRCParamMultiplier.max(1) as u32;
        let (queried_gop, queried_ref_dist, queried_gop_flags, queried_idr_interval) = unsafe {
            let e = &queried_mfx.__bindgen_anon_1.__bindgen_anon_1;
            (e.GopPicSize, e.GopRefDist, e.GopOptFlag, e.IdrInterval)
        };
        match rate_control.mode {
            RateControlMode::Cbr => tracing::info!(
                codec_profile = queried_mfx.CodecProfile,
                codec_level = queried_mfx.CodecLevel,
                mode = rate_control.mode.as_str(),
                rate_control = queried_rc,
                target_kbps = queried_b as u32 * queried_mult,
                vbv_kb = queried_buffer as u32 * queried_mult,
                initial_delay_kb = queried_a as u32 * queried_mult,
                low_delay_brc = c3.LowDelayBRC,
                target_usage = queried_target_usage,
                gop_pictures = queried_gop,
                gop_ref_distance = queried_ref_dist,
                gop_flags = queried_gop_flags,
                idr_interval = queried_idr_interval,
                "encoder BRC negotiated"
            ),
            RateControlMode::Vbr => tracing::info!(
                codec_profile = queried_mfx.CodecProfile,
                codec_level = queried_mfx.CodecLevel,
                mode = rate_control.mode.as_str(),
                rate_control = queried_rc,
                target_kbps = queried_b as u32 * queried_mult,
                max_kbps = queried_c as u32 * queried_mult,
                vbv_kb = queried_buffer as u32 * queried_mult,
                initial_delay_kb = queried_a as u32 * queried_mult,
                low_delay_brc = c3.LowDelayBRC,
                max_frame_size_i = c3.MaxFrameSizeI,
                max_frame_size_p = c3.MaxFrameSizeP,
                target_usage = queried_target_usage,
                gop_pictures = queried_gop,
                gop_ref_distance = queried_ref_dist,
                gop_flags = queried_gop_flags,
                idr_interval = queried_idr_interval,
                "encoder BRC negotiated"
            ),
            RateControlMode::Cqp => tracing::info!(
                codec_profile = queried_mfx.CodecProfile,
                codec_level = queried_mfx.CodecLevel,
                mode = rate_control.mode.as_str(),
                rate_control = queried_rc,
                qpi = queried_a,
                qpp = queried_b,
                qpb = queried_c,
                target_usage = queried_target_usage,
                gop_pictures = queried_gop,
                gop_ref_distance = queried_ref_dist,
                gop_flags = queried_gop_flags,
                idr_interval = queried_idr_interval,
                "encoder BRC negotiated"
            ),
            RateControlMode::Icq => tracing::info!(
                codec_profile = queried_mfx.CodecProfile,
                codec_level = queried_mfx.CodecLevel,
                mode = rate_control.mode.as_str(),
                rate_control = queried_rc,
                quality = queried_b,
                target_usage = queried_target_usage,
                gop_pictures = queried_gop,
                gop_ref_distance = queried_ref_dist,
                gop_flags = queried_gop_flags,
                idr_interval = queried_idr_interval,
                "encoder BRC negotiated"
            ),
        }
        init(session, &mut p)?;
        vpl.open = true;
        let mut actual: mfxVideoParam = unsafe { zeroed() };
        chkmfx("GetVideoParam", unsafe {
            MFXVideoENCODE_GetVideoParam(session, &mut actual as *mut mfxVideoParam)
        })?;
        let (kb, rmult) = unsafe {
            (
                actual
                    .__bindgen_anon_1
                    .mfx
                    .__bindgen_anon_1
                    .__bindgen_anon_1
                    .BufferSizeInKB,
                actual.__bindgen_anon_1.mfx.BRCParamMultiplier,
            )
        };
        let need = (kb as u64 * (if rmult == 0 { 1 } else { rmult as u64 }) * 1000).max(MIN_BS);
        if need > MAX_BS as u64 {
            bail!("bitstream requirement too large");
        }
        let info = unsafe { p.__bindgen_anon_1.mfx.FrameInfo };
        let (dw, dh) = dims(&info);
        if dw as u32 > sw || dh as u32 > sh {
            bail!("driver needs larger surface");
        }
        let (cw, ch) = crop(&info);
        if cw != ow as u16 || ch != oh as u16 {
            bail!("driver changed crop");
        }
        let first_surface = encoder_input.nv12_surface(0)?;
        let mut slots = Vec::with_capacity(ENCODE_ASYNC_DEPTH);
        for _ in 0..ENCODE_ASYNC_DEPTH {
            let mut storage = vec![0u8; need as usize];
            let mut bit: mfxBitstream = unsafe { zeroed() };
            bit.Data = storage.as_mut_ptr();
            bit.MaxLength = storage.len() as u32;
            let mut mid = Box::new(VaMemId {
                display,
                surface: first_surface,
                owned: false,
            });
            let mut input: mfxFrameSurface1 = unsafe { zeroed() };
            input.Info = info;
            // SAFETY: `mid` is boxed, so its address stays stable when the
            // EncodeSlot or Encoder is moved.
            input.Data.MemId = &mut *mid as *mut VaMemId as mfxMemId;
            slots.push(EncodeSlot {
                bs: storage,
                bit,
                input,
                mid,
                pending_sync: ptr::null_mut(),
                surface_index: None,
                started: None,
                submit_us: 0,
                pts_us: 0,
            });
        }
        Ok(Encoder {
            _encoder_input: encoder_input,
            vpl,
            alloc,
            slots,
            pending_order: VecDeque::with_capacity(PIPELINE_DEPTH),
            frame: 0,
        })
    }

    pub fn capacity(&self) -> usize {
        self.slots.len()
    }

    pub fn pending_len(&self) -> usize {
        self.pending_order.len()
    }

    pub fn oldest_age_us(&self) -> Option<u64> {
        let slot_index = *self.pending_order.front()?;
        self.slots
            .get(slot_index)?
            .started
            .map(|started| started.elapsed().as_micros() as u64)
    }

    pub fn submit_encode(
        &mut self,
        surface_index: usize,
        pts_us: u64,
        force_idr: bool,
        dirty: Option<DamageRect>,
    ) -> Result<bool> {
        if self.pending_order.len() >= self.slots.len() {
            bail!("encoder async pipeline is full");
        }
        let slot_index = self
            .slots
            .iter()
            .position(|slot| slot.pending_sync.is_null())
            .ok_or_else(|| anyhow!("no free encoder async slot"))?;
        let surface = self._encoder_input.nv12_surface(surface_index)?;
        let slot = &mut self.slots[slot_index];
        slot.mid.surface = surface;
        slot.input.Data.FrameOrder = self.frame;
        slot.input.Data.TimeStamp = ((pts_us as u128 * 90_000) / 1_000_000) as u64;
        slot.bit.DataOffset = 0;
        slot.bit.DataLength = 0;
        slot.bit.FrameType = 0;
        slot.bit.MaxLength = slot.bs.len() as u32;
        slot.bit.Data = slot.bs.as_mut_ptr();
        let mut ctl: mfxEncodeCtrl = unsafe { zeroed() };
        if force_idr {
            ctl.FrameType = MFX_FT_I | MFX_FT_IDR | MFX_FT_REF;
        }
        let mut dirty_ext: mfxExtDirtyRect = unsafe { zeroed() };
        let mut dirty_ptr: *mut mfxExtBuffer = ptr::null_mut();
        if let Some(rect) = dirty.filter(|rect| rect.width > 0 && rect.height > 0) {
            dirty_ext.Header.BufferId = MFX_EXT_DIRTY;
            dirty_ext.Header.BufferSz = size_of::<mfxExtDirtyRect>() as u32;
            dirty_ext.NumRect = 1;
            dirty_ext.Rect[0].Left = rect.x;
            dirty_ext.Rect[0].Top = rect.y;
            dirty_ext.Rect[0].Right = rect.x.saturating_add(rect.width);
            dirty_ext.Rect[0].Bottom = rect.y.saturating_add(rect.height);
            dirty_ptr = &mut dirty_ext.Header as *mut mfxExtBuffer;
            ctl.NumExtParam = 1;
            ctl.ExtParam = &mut dirty_ptr as *mut *mut mfxExtBuffer;
        }
        let cp: *mut mfxEncodeCtrl = if force_idr || !dirty_ptr.is_null() {
            &mut ctl as *mut mfxEncodeCtrl
        } else {
            ptr::null_mut()
        };
        let began = Instant::now();
        let mut sync: mfxSyncPoint = ptr::null_mut();
        let mut grows = 0u32;
        let last = loop {
            let st = unsafe {
                MFXVideoENCODE_EncodeFrameAsync(
                    self.vpl.session,
                    cp,
                    &mut slot.input as *mut mfxFrameSurface1,
                    &mut slot.bit as *mut mfxBitstream,
                    &mut sync as *mut mfxSyncPoint,
                )
            };
            if st == MFX_WRN_BUSY {
                // Retain the ready NV12 surface and IDR latch. Let the event
                // loop poll completion / receive fresher frames instead of sleeping.
                return Ok(false);
            }
            if st == MFX_ERR_BS {
                if grows >= 3 {
                    bail!("bitstream buffer too small");
                }
                grows += 1;
                let old = slot.bs.len();
                let new = old.checked_mul(2).ok_or_else(|| anyhow!("size overflow"))?;
                if new > MAX_BS {
                    bail!("bitstream buffer too large");
                }
                slot.bs.resize(new, 0);
                slot.bit.Data = slot.bs.as_mut_ptr();
                slot.bit.MaxLength = new as u32;
                slot.bit.DataOffset = 0;
                slot.bit.DataLength = 0;
                sync = ptr::null_mut();
                continue;
            }
            chkmfx("EncodeFrameAsync", st)?;
            break st;
        };
        if sync.is_null() {
            bail!("no sync point (status {last})");
        }
        slot.pending_sync = sync;
        slot.surface_index = Some(surface_index);
        slot.pts_us = pts_us;
        slot.submit_us = began.elapsed().as_micros() as u64;
        slot.started = Some(began);
        self.pending_order.push_back(slot_index);
        self.frame = self.frame.wrapping_add(1);
        Ok(true)
    }

    pub fn poll_complete(&mut self) -> Result<Option<EncodedFrame>> {
        self.complete_oldest(0)
    }

    pub fn wait_complete(&mut self) -> Result<Option<EncodedFrame>> {
        self.complete_oldest(SYNC_TO_MS)
    }

    fn complete_oldest(&mut self, wait_ms: u32) -> Result<Option<EncodedFrame>> {
        let Some(&slot_index) = self.pending_order.front() else {
            return Ok(None);
        };
        let sync = self.slots[slot_index].pending_sync;
        if sync.is_null() {
            bail!("encoder pending queue contains an empty sync slot");
        }
        let st = unsafe { MFXVideoCORE_SyncOperation(self.vpl.session, sync, wait_ms) };
        if st == MFX_WRN_EXEC || st == MFX_WRN_BUSY {
            return Ok(None);
        }
        chkmfx("SyncOperation", st)?;

        let popped = self.pending_order.pop_front();
        debug_assert_eq!(popped, Some(slot_index));
        let slot = &mut self.slots[slot_index];
        slot.pending_sync = ptr::null_mut();
        if slot.input.Data.Locked != 0 {
            bail!("encoder retained the input surface after sync");
        }
        let surface_index = slot
            .surface_index
            .take()
            .ok_or_else(|| anyhow!("encoder completion missing surface index"))?;
        let encode_us = slot
            .started
            .take()
            .map(|started| started.elapsed().as_micros() as u64)
            .unwrap_or(0);
        let submit_us = std::mem::take(&mut slot.submit_us);
        let off = slot.bit.DataOffset as usize;
        let len = slot.bit.DataLength as usize;
        let keyframe = slot.bit.FrameType & MFX_FT_I != 0;
        if off > slot.bs.len() || len > slot.bs.len() - off {
            bail!("invalid bitstream bounds");
        }
        Ok(Some(EncodedFrame {
            surface_index,
            data: slot.bs[off..off + len].to_vec(),
            keyframe,
            encode_us,
            submit_us,
            pts_us: slot.pts_us,
        }))
    }
}

/// Probe the exact configured render node; never select a different GPU.
pub fn probe(node: &Path) -> Result<()> {
    let input = EncoderInput::new(node, 64, 64)?;
    let d = input.va.display;
    let mut entries = vec![0 as VAEntrypoint; unsafe { vaMaxNumEntrypoints(d) }.max(1) as usize];
    let mut count = 0;
    chkva("query AV1 encode entrypoints", unsafe {
        vaQueryConfigEntrypoints(
            d,
            ffi::VAProfile_VAProfileAV1Profile0,
            entries.as_mut_ptr(),
            &mut count,
        )
    })?;
    if !entries[..count as usize].iter().any(|e| {
        *e == ffi::VAEntrypoint_VAEntrypointEncSliceLP
            || *e == ffi::VAEntrypoint_VAEntrypointEncSlice
    }) {
        bail!("configured render node has no hardware AV1 encoder");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;

    fn descriptor() -> Dmabuf {
        let raw = unsafe { libc::memfd_create(c"descriptor-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(raw >= 0);
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        assert_eq!(unsafe { libc::ftruncate(fd.as_raw_fd(), 64 * 64 * 4) }, 0);
        Dmabuf {
            width: 64,
            height: 64,
            fourcc: DRM_XR24,
            modifier: 0,
            planes: vec![Plane {
                fd,
                offset: 0,
                stride: 256,
                size: 16384,
            }],
        }
    }

    #[test]
    fn descriptor_identity_is_stable_across_fd_dup() {
        let a = descriptor();
        let b = Dmabuf {
            width: a.width,
            height: a.height,
            fourcc: a.fourcc,
            modifier: a.modifier,
            planes: vec![Plane {
                fd: a.planes[0].fd.try_clone().unwrap(),
                offset: 0,
                stride: 256,
                size: 16384,
            }],
        };
        assert_eq!(a.validate().unwrap(), b.validate().unwrap());
    }

    #[test]
    fn descriptor_rejects_unsupported_or_out_of_bounds_layouts() {
        let mut d = descriptor();
        d.width = 63;
        assert!(d.validate().is_err());
        d.width = 64;
        d.modifier = 0x0100_0000_0000_0009;
        assert!(d.validate().is_ok());
        d.modifier = 0x0100_0000_0000_000a;
        assert!(d.validate().is_err());
        d.modifier = 0;
        d.planes[0].stride = 255;
        assert!(d.validate().is_err());
        d.planes[0].stride = 256;
        d.planes[0].offset = 1;
        assert!(d.validate().is_err());
        d.planes[0].offset = 0;
        d.planes[0].size = 16385;
        assert!(d.validate().is_err());
        d.planes[0].size = 16384;
        d.fourcc = VA_NV12;
        assert!(d.validate().is_err());
        d.fourcc = DRM_XR24;
        d.planes.clear();
        assert!(d.validate().is_err());
    }

    #[test]
    fn bitrate_target_saturates_without_overflow() {
        for multiplier in [0, 1, 2, u16::MAX] {
            assert_eq!(bs_target(u32::MAX, multiplier), u16::MAX);
        }
        assert_eq!(bs_target(0, 1), 1);
        assert_eq!(bs_target_allow_zero(0, 1), 0);
        assert_eq!(bs_target(65_537, 2), 32_769);
    }

    #[test]
    fn constants() {
        assert_eq!(VA_NV12, 0x3231_564E);
        assert_eq!(MFX_NV12, 0x3231_564E);
        assert_eq!(DRM_AR24, 0x3432_5241);
        assert_eq!(align16(1), 16);
        assert_eq!(align16(8192), 8192);
        assert_eq!(bs_mult(8_000), 1);
        assert_eq!(bs_target(8_000, 1), 8_000);
    }
}
