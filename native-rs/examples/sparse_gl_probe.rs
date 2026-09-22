use anyhow::{Result, bail, ensure};
use mcpbrowser_native_cua::{
    live::{
        capture::Capture,
        gpu::{DamageRect, Dmabuf, EncoderInput},
    },
    read_desktop_info,
};
use std::{
    collections::HashMap,
    ffi::{CString, c_void},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::ffi::OsStrExt,
    path::Path,
    ptr,
    time::{Duration, Instant},
};

type EGLDisplay = *mut c_void;
type EGLContext = *mut c_void;
type EGLConfig = *mut c_void;
type EGLImage = *mut c_void;
const EGL_PLATFORM_GBM_KHR: u32 = 0x31D7;
const EGL_OPENGL_ES_API: u32 = 0x30A0;
const EGL_RENDERABLE_TYPE: isize = 0x3040;
const EGL_OPENGL_ES3_BIT: isize = 0x40;
const EGL_CONTEXT_CLIENT_VERSION: isize = 0x3098;
const EGL_NONE: isize = 0x3038;
const EGL_LINUX_DMA_BUF_EXT: u32 = 0x3270;
const EGL_WIDTH: isize = 0x3057;
const EGL_HEIGHT: isize = 0x3056;
const EGL_LINUX_DRM_FOURCC_EXT: isize = 0x3271;
const EGL_DMA_BUF_PLANE0_FD_EXT: isize = 0x3272;
const EGL_DMA_BUF_PLANE0_OFFSET_EXT: isize = 0x3273;
const EGL_DMA_BUF_PLANE0_PITCH_EXT: isize = 0x3274;
const EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT: isize = 0x3443;
const EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT: isize = 0x3444;
const GL_TEXTURE_2D: u32 = 0x0de1;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_NEAREST: i32 = 0x2600;
const GL_FRAMEBUFFER: u32 = 0x8d40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8ce0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8cd5;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_PACK_ALIGNMENT: u32 = 0x0d05;
const GL_NO_ERROR: u32 = 0;
#[link(name = "gbm")]
unsafe extern "C" {
    fn gbm_create_device(fd: i32) -> *mut c_void;
    fn gbm_device_destroy(dev: *mut c_void);
}
#[link(name = "EGL")]
unsafe extern "C" {
    fn eglGetPlatformDisplay(platform: u32, native: *mut c_void, attrs: *const isize)
    -> EGLDisplay;
    fn eglInitialize(dpy: EGLDisplay, maj: *mut i32, min: *mut i32) -> u32;
    fn eglBindAPI(api: u32) -> u32;
    fn eglChooseConfig(
        dpy: EGLDisplay,
        attrs: *const i32,
        cfg: *mut EGLConfig,
        size: i32,
        num: *mut i32,
    ) -> u32;
    fn eglCreateContext(
        dpy: EGLDisplay,
        cfg: EGLConfig,
        share: EGLContext,
        attrs: *const i32,
    ) -> EGLContext;
    fn eglMakeCurrent(
        dpy: EGLDisplay,
        draw: *mut c_void,
        read: *mut c_void,
        ctx: EGLContext,
    ) -> u32;
    fn eglCreateImage(
        dpy: EGLDisplay,
        ctx: EGLContext,
        target: u32,
        buffer: *mut c_void,
        attrs: *const isize,
    ) -> EGLImage;
    fn eglDestroyImage(dpy: EGLDisplay, img: EGLImage) -> u32;
    fn eglDestroyContext(dpy: EGLDisplay, ctx: EGLContext) -> u32;
    fn eglTerminate(dpy: EGLDisplay) -> u32;
    fn eglGetError() -> u32;
    fn eglGetProcAddress(name: *const i8) -> *const c_void;
}
#[link(name = "GLESv2")]
unsafe extern "C" {
    fn glGenTextures(n: i32, v: *mut u32);
    fn glDeleteTextures(n: i32, v: *const u32);
    fn glBindTexture(target: u32, v: u32);
    fn glTexParameteri(target: u32, pname: u32, value: i32);
    fn glGenFramebuffers(n: i32, v: *mut u32);
    fn glDeleteFramebuffers(n: i32, v: *const u32);
    fn glBindFramebuffer(target: u32, v: u32);
    fn glFramebufferTexture2D(
        target: u32,
        attachment: u32,
        textarget: u32,
        texture: u32,
        level: i32,
    );
    fn glCheckFramebufferStatus(target: u32) -> u32;
    fn glReadPixels(x: i32, y: i32, w: i32, h: i32, format: u32, ty: u32, data: *mut c_void);
    fn glPixelStorei(pname: u32, param: i32);
    fn glGetError() -> u32;
}
type ImageTarget = unsafe extern "C" fn(u32, *mut c_void);
struct Imported {
    image: EGLImage,
    tex: u32,
    fbo: u32,
    _fd: OwnedFd,
}
struct GlReader {
    fd: i32,
    gbm: *mut c_void,
    dpy: EGLDisplay,
    ctx: EGLContext,
    image_target: ImageTarget,
    cache: HashMap<(u64, u64), Imported>,
}
impl GlReader {
    fn new(path: &Path) -> Result<Self> {
        unsafe {
            let c = CString::new(path.as_os_str().as_bytes())?;
            let fd = libc::open(c.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC);
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let gbm = gbm_create_device(fd);
            ensure!(!gbm.is_null(), "gbm_create_device failed");
            let dpy = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, ptr::null());
            ensure!(!dpy.is_null(), "eglGetPlatformDisplay failed");
            let (mut a, mut b) = (0, 0);
            ensure!(
                eglInitialize(dpy, &mut a, &mut b) != 0,
                "eglInitialize {:#x}",
                eglGetError()
            );
            ensure!(eglBindAPI(EGL_OPENGL_ES_API) != 0, "eglBindAPI");
            let attrs = [
                EGL_RENDERABLE_TYPE as i32,
                EGL_OPENGL_ES3_BIT as i32,
                EGL_NONE as i32,
            ];
            let mut cfg = ptr::null_mut();
            let mut n = 0;
            ensure!(
                eglChooseConfig(dpy, attrs.as_ptr(), &mut cfg, 1, &mut n) != 0 && n > 0,
                "eglChooseConfig {:#x}",
                eglGetError()
            );
            let ca = [EGL_CONTEXT_CLIENT_VERSION as i32, 3, EGL_NONE as i32];
            let ctx = eglCreateContext(dpy, cfg, ptr::null_mut(), ca.as_ptr());
            ensure!(!ctx.is_null(), "eglCreateContext {:#x}", eglGetError());
            ensure!(
                eglMakeCurrent(dpy, ptr::null_mut(), ptr::null_mut(), ctx) != 0,
                "eglMakeCurrent {:#x}",
                eglGetError()
            );
            let name = CString::new("glEGLImageTargetTexture2DOES")?;
            let p = eglGetProcAddress(name.as_ptr());
            ensure!(!p.is_null(), "glEGLImageTargetTexture2DOES missing");
            let image_target: ImageTarget = std::mem::transmute(p);
            glPixelStorei(GL_PACK_ALIGNMENT, 1);
            Ok(Self {
                fd,
                gbm,
                dpy,
                ctx,
                image_target,
                cache: HashMap::new(),
            })
        }
    }
    fn imported(&mut self, b: &Dmabuf) -> Result<&Imported> {
        let p = &b.planes[0];
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(p.fd.as_raw_fd(), &mut st) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let key = (st.st_dev, st.st_ino);
        if !self.cache.contains_key(&key) {
            let fd = p.fd.try_clone()?;
            let attrs = [
                EGL_WIDTH,
                b.width as isize,
                EGL_HEIGHT,
                b.height as isize,
                EGL_LINUX_DRM_FOURCC_EXT,
                b.fourcc as isize,
                EGL_DMA_BUF_PLANE0_FD_EXT,
                fd.as_raw_fd() as isize,
                EGL_DMA_BUF_PLANE0_OFFSET_EXT,
                p.offset as isize,
                EGL_DMA_BUF_PLANE0_PITCH_EXT,
                p.stride as isize,
                EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT,
                (b.modifier as u32) as isize,
                EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT,
                (b.modifier >> 32) as isize,
                EGL_NONE,
            ];
            unsafe {
                let image = eglCreateImage(
                    self.dpy,
                    ptr::null_mut(),
                    EGL_LINUX_DMA_BUF_EXT,
                    ptr::null_mut(),
                    attrs.as_ptr(),
                );
                ensure!(!image.is_null(), "eglCreateImage {:#x}", eglGetError());
                let mut tex = 0;
                glGenTextures(1, &mut tex);
                glBindTexture(GL_TEXTURE_2D, tex);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
                (self.image_target)(GL_TEXTURE_2D, image);
                ensure!(glGetError() == GL_NO_ERROR, "image target GL error");
                let mut fbo = 0;
                glGenFramebuffers(1, &mut fbo);
                glBindFramebuffer(GL_FRAMEBUFFER, fbo);
                glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
                ensure!(
                    glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
                    "FBO incomplete"
                );
                self.cache.insert(
                    key,
                    Imported {
                        image,
                        tex,
                        fbo,
                        _fd: fd,
                    },
                );
            }
        }
        Ok(self.cache.get(&key).unwrap())
    }
    fn read(
        &mut self,
        b: &Dmabuf,
        r: DamageRect,
        flip_y_coord: bool,
        flip_rows: bool,
    ) -> Result<Vec<u8>> {
        let h = b.height;
        let imp = self.imported(b)?;
        unsafe { glBindFramebuffer(GL_FRAMEBUFFER, imp.fbo) };
        let y = if flip_y_coord {
            h - r.y - r.height
        } else {
            r.y
        };
        let mut out = vec![0u8; r.width as usize * r.height as usize * 4];
        unsafe {
            glReadPixels(
                r.x as i32,
                y as i32,
                r.width as i32,
                r.height as i32,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                out.as_mut_ptr().cast(),
            );
            let e = glGetError();
            ensure!(e == GL_NO_ERROR, "glReadPixels error {e:#x}")
        };
        if flip_rows {
            let row = r.width as usize * 4;
            for y in 0..(r.height as usize / 2) {
                let (a, b) = out.split_at_mut((r.height as usize - 1 - y) * row);
                a[y * row..(y + 1) * row].swap_with_slice(&mut b[..row]);
            }
        }
        Ok(out)
    }
}
impl Drop for GlReader {
    fn drop(&mut self) {
        unsafe {
            for (_, i) in self.cache.drain() {
                glDeleteFramebuffers(1, &i.fbo);
                glDeleteTextures(1, &i.tex);
                eglDestroyImage(self.dpy, i.image);
            }
            eglMakeCurrent(self.dpy, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
            eglDestroyContext(self.dpy, self.ctx);
            eglTerminate(self.dpy);
            gbm_device_destroy(self.gbm);
            libc::close(self.fd);
        }
    }
}
fn ref_rgba(bgrx: &[u8]) -> Vec<u8> {
    let mut o = vec![0; bgrx.len()];
    for (i, p) in bgrx.chunks_exact(4).enumerate() {
        o[i * 4] = p[2];
        o[i * 4 + 1] = p[1];
        o[i * 4 + 2] = p[0];
        o[i * 4 + 3] = 255
    }
    o
}
fn rgb_eq_perm(a: &[u8], b: &[u8], p: [usize; 3]) -> bool {
    a.len() == b.len()
        && a.chunks_exact(4)
            .zip(b.chunks_exact(4))
            .all(|(x, y)| x[p[0]] == y[0] && x[p[1]] == y[1] && x[p[2]] == y[2])
}
fn main() -> Result<()> {
    let d = read_desktop_info()?;
    let va = EncoderInput::new(Path::new(&d.render_node), d.width, d.height)?;
    let mut gl = GlReader::new(Path::new(&d.render_node))?;
    let mut cap = Capture::connect(&d)?;
    let raw = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
    ensure!(raw >= 0, "eventfd");
    let wake = unsafe { OwnedFd::from_raw_fd(raw) };
    let perms = [
        [0, 1, 2],
        [2, 1, 0],
        [1, 0, 2],
        [0, 2, 1],
        [1, 2, 0],
        [2, 0, 1],
    ];
    let mut mode = None;
    let mut times = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut checked = 0u64;
    while Instant::now() < deadline {
        cap.pump(Duration::from_millis(20), &wake)?;
        let Some(f) = cap.take_latest() else { continue };
        if !f.is_ready()? {
            continue;
        }
        let rr = f.damage.first().copied().unwrap_or(DamageRect {
            x: 0,
            y: 0,
            width: 96,
            height: 96,
        });
        let r = DamageRect {
            x: rr.x.min(d.width - 96),
            y: rr.y.min(d.height - 96),
            width: 96,
            height: 96,
        };
        if mode.is_none() {
            let probe = DamageRect {
                x: 800,
                y: 380,
                width: 320,
                height: 320,
            };
            let (_, _, _, refb) = va.readback_region_32(&f.buffer, probe)?;
            let reference = ref_rgba(&refb);
            'find: for fy in [false, true] {
                for fr in [false, true] {
                    let got = gl.read(&f.buffer, probe, fy, fr)?;
                    for (pi, p) in perms.iter().copied().enumerate() {
                        if rgb_eq_perm(&got, &reference, p) {
                            mode = Some((fy, fr, pi));
                            break 'find;
                        }
                    }
                }
            }
            if mode.is_none() {
                bail!("no EGL orientation/channel permutation produced the VA reference pixels")
            };
            checked += 1;
            continue;
        }
        let (fy, fr, pi) = mode.unwrap();
        let t = Instant::now();
        let _ = gl.read(&f.buffer, r, fy, fr)?;
        times.push(t.elapsed().as_micros() as u64);
        if checked < 5 {
            let (_, _, _, refb) = va.readback_region_32(&f.buffer, r)?;
            let got = gl.read(&f.buffer, r, fy, fr)?;
            ensure!(
                rgb_eq_perm(&got, &ref_rgba(&refb), perms[pi]),
                "EGL pixels diverged"
            );
            checked += 1;
        }
    }
    ensure!(!times.is_empty(), "no timings");
    times.sort_unstable();
    let p = |x: f64| times[((times.len() - 1) as f64 * x).round() as usize];
    println!(
        "{}",
        serde_json::to_string_pretty(
            &serde_json::json!({"mode":mode,"samples":times.len(),"avg_us":times.iter().sum::<u64>()/times.len()as u64,"p50_us":p(0.5),"p95_us":p(0.95),"p99_us":p(0.99),"checked":checked})
        )?
    );
    Ok(())
}
