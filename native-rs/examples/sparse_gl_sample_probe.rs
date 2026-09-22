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
    ffi::{CStr, CString, c_void},
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
const EGL_RENDERABLE_TYPE: i32 = 0x3040;
const EGL_OPENGL_ES3_BIT: i32 = 0x40;
const EGL_CONTEXT_CLIENT_VERSION: i32 = 0x3098;
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
const GL_CLAMP_TO_EDGE: i32 = 0x812f;
const GL_TEXTURE_WRAP_S: u32 = 0x2802;
const GL_TEXTURE_WRAP_T: u32 = 0x2803;
const GL_FRAMEBUFFER: u32 = 0x8d40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8ce0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8cd5;
const GL_RGBA: u32 = 0x1908;
const GL_RGBA8: i32 = 0x8058;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_TRIANGLES: u32 = 0x0004;
const GL_VERTEX_SHADER: u32 = 0x8b31;
const GL_FRAGMENT_SHADER: u32 = 0x8b30;
const GL_COMPILE_STATUS: u32 = 0x8b81;
const GL_LINK_STATUS: u32 = 0x8b82;
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
    fn glBindTexture(t: u32, v: u32);
    fn glTexParameteri(t: u32, p: u32, v: i32);
    fn glTexImage2D(
        t: u32,
        l: i32,
        internal: i32,
        w: i32,
        h: i32,
        b: i32,
        f: u32,
        ty: u32,
        data: *const c_void,
    );
    fn glGenFramebuffers(n: i32, v: *mut u32);
    fn glDeleteFramebuffers(n: i32, v: *const u32);
    fn glBindFramebuffer(t: u32, v: u32);
    fn glFramebufferTexture2D(t: u32, a: u32, tt: u32, tex: u32, l: i32);
    fn glCheckFramebufferStatus(t: u32) -> u32;
    fn glViewport(x: i32, y: i32, w: i32, h: i32);
    fn glReadPixels(x: i32, y: i32, w: i32, h: i32, f: u32, ty: u32, d: *mut c_void);
    fn glPixelStorei(p: u32, v: i32);
    fn glCreateShader(t: u32) -> u32;
    fn glShaderSource(s: u32, n: i32, src: *const *const i8, len: *const i32);
    fn glCompileShader(s: u32);
    fn glGetShaderiv(s: u32, p: u32, v: *mut i32);
    fn glGetShaderInfoLog(s: u32, max: i32, len: *mut i32, log: *mut i8);
    fn glCreateProgram() -> u32;
    fn glAttachShader(p: u32, s: u32);
    fn glLinkProgram(p: u32);
    fn glGetProgramiv(p: u32, n: u32, v: *mut i32);
    fn glGetProgramInfoLog(p: u32, max: i32, len: *mut i32, log: *mut i8);
    fn glUseProgram(p: u32);
    fn glGetUniformLocation(p: u32, n: *const i8) -> i32;
    fn glUniform4f(l: i32, a: f32, b: f32, c: f32, d: f32);
    fn glActiveTexture(t: u32);
    fn glUniform1i(l: i32, v: i32);
    fn glDrawArrays(m: u32, f: i32, c: i32);
    fn glDeleteShader(s: u32);
    fn glDeleteProgram(p: u32);
    fn glGetError() -> u32;
}
const GL_TEXTURE0: u32 = 0x84c0;
type ImageTarget = unsafe extern "C" fn(u32, *mut c_void);
struct Imported {
    image: EGLImage,
    tex: u32,
    _fd: OwnedFd,
}
struct G {
    fd: i32,
    gbm: *mut c_void,
    dpy: EGLDisplay,
    ctx: EGLContext,
    target: ImageTarget,
    cache: HashMap<(u64, u64), Imported>,
    out_tex: u32,
    fbo: u32,
    prog: u32,
    u_rect: i32,
    w: u32,
    h: u32,
}
fn shader(kind: u32, src: &str) -> Result<u32> {
    unsafe {
        let s = glCreateShader(kind);
        let c = CString::new(src)?;
        let p = c.as_ptr();
        glShaderSource(s, 1, &p, ptr::null());
        glCompileShader(s);
        let mut ok = 0;
        glGetShaderiv(s, GL_COMPILE_STATUS, &mut ok);
        if ok == 0 {
            let mut b = vec![0i8; 4096];
            let mut n = 0;
            glGetShaderInfoLog(s, b.len() as i32, &mut n, b.as_mut_ptr());
            bail!("shader: {}", CStr::from_ptr(b.as_ptr()).to_string_lossy())
        }
        Ok(s)
    }
}
impl G {
    fn new(path: &Path, w: u32, h: u32) -> Result<Self> {
        unsafe {
            let c = CString::new(path.as_os_str().as_bytes())?;
            let fd = libc::open(c.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC);
            ensure!(fd >= 0, "open");
            let gbm = gbm_create_device(fd);
            ensure!(!gbm.is_null(), "gbm");
            let dpy = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, ptr::null());
            let (mut a, mut b) = (0, 0);
            ensure!(
                eglInitialize(dpy, &mut a, &mut b) != 0,
                "egl init {:#x}",
                eglGetError()
            );
            ensure!(eglBindAPI(EGL_OPENGL_ES_API) != 0, "bind");
            let attrs = [EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_NONE as i32];
            let (mut cfg, mut n) = (ptr::null_mut(), 0);
            ensure!(
                eglChooseConfig(dpy, attrs.as_ptr(), &mut cfg, 1, &mut n) != 0 && n > 0,
                "cfg"
            );
            let ca = [EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE as i32];
            let ctx = eglCreateContext(dpy, cfg, ptr::null_mut(), ca.as_ptr());
            ensure!(!ctx.is_null(), "ctx");
            ensure!(
                eglMakeCurrent(dpy, ptr::null_mut(), ptr::null_mut(), ctx) != 0,
                "current"
            );
            let ep = CString::new("glEGLImageTargetTexture2DOES")?;
            let pp = eglGetProcAddress(ep.as_ptr());
            ensure!(!pp.is_null(), "image target");
            let target: ImageTarget = std::mem::transmute(pp);
            let vs = shader(
                GL_VERTEX_SHADER,
                "#version 300 es\nprecision highp float;out vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}",
            )?;
            let fs = shader(
                GL_FRAGMENT_SHADER,
                "#version 300 es\nprecision highp float;uniform sampler2D s;uniform vec4 r;in vec2 uv;out vec4 o;void main(){vec2 q=mix(r.xy,r.zw,uv);o=texture(s,q);}",
            )?;
            let prog = glCreateProgram();
            glAttachShader(prog, vs);
            glAttachShader(prog, fs);
            glLinkProgram(prog);
            let mut ok = 0;
            glGetProgramiv(prog, GL_LINK_STATUS, &mut ok);
            if ok == 0 {
                let mut bb = vec![0i8; 4096];
                let mut nn = 0;
                glGetProgramInfoLog(prog, bb.len() as i32, &mut nn, bb.as_mut_ptr());
                bail!("link {}", CStr::from_ptr(bb.as_ptr()).to_string_lossy())
            }
            glDeleteShader(vs);
            glDeleteShader(fs);
            glUseProgram(prog);
            let u_rect = glGetUniformLocation(prog, CString::new("r")?.as_ptr());
            let u_src = glGetUniformLocation(prog, CString::new("s")?.as_ptr());
            glUniform1i(u_src, 0);
            let mut out_tex = 0;
            glGenTextures(1, &mut out_tex);
            glBindTexture(GL_TEXTURE_2D, out_tex);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            glTexImage2D(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8,
                w as i32,
                h as i32,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                ptr::null(),
            );
            let mut fbo = 0;
            glGenFramebuffers(1, &mut fbo);
            glBindFramebuffer(GL_FRAMEBUFFER, fbo);
            glFramebufferTexture2D(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                out_tex,
                0,
            );
            ensure!(
                glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
                "fbo"
            );
            glPixelStorei(GL_PACK_ALIGNMENT, 1);
            Ok(Self {
                fd,
                gbm,
                dpy,
                ctx,
                target,
                cache: HashMap::new(),
                out_tex,
                fbo,
                prog,
                u_rect,
                w,
                h,
            })
        }
    }
    fn imported(&mut self, b: &Dmabuf) -> Result<u32> {
        let p = &b.planes[0];
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(p.fd.as_raw_fd(), &mut st) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let k = (st.st_dev, st.st_ino);
        if !self.cache.contains_key(&k) {
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
                ensure!(!image.is_null(), "egl image {:#x}", eglGetError());
                let mut tex = 0;
                glGenTextures(1, &mut tex);
                glActiveTexture(GL_TEXTURE0);
                glBindTexture(GL_TEXTURE_2D, tex);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
                (self.target)(GL_TEXTURE_2D, image);
                ensure!(glGetError() == GL_NO_ERROR, "target");
                self.cache.insert(
                    k,
                    Imported {
                        image,
                        tex,
                        _fd: fd,
                    },
                );
            }
        }
        Ok(self.cache[&k].tex)
    }
    fn read(
        &mut self,
        b: &Dmabuf,
        r: DamageRect,
        flip_src_y: bool,
        flip_out: bool,
    ) -> Result<Vec<u8>> {
        let tex = self.imported(b)?;
        unsafe {
            glBindFramebuffer(GL_FRAMEBUFFER, self.fbo);
            glViewport(0, 0, self.w as i32, self.h as i32);
            glUseProgram(self.prog);
            glActiveTexture(GL_TEXTURE0);
            glBindTexture(GL_TEXTURE_2D, tex);
            let x0 = r.x as f32 / b.width as f32;
            let x1 = (r.x + r.width) as f32 / b.width as f32;
            let mut y0 = r.y as f32 / b.height as f32;
            let mut y1 = (r.y + r.height) as f32 / b.height as f32;
            if flip_src_y {
                y0 = 1.0 - y0;
                y1 = 1.0 - y1;
            }
            glUniform4f(self.u_rect, x0, y0, x1, y1);
            glDrawArrays(GL_TRIANGLES, 0, 3);
            let mut out = vec![0u8; (self.w * self.h * 4) as usize];
            glReadPixels(
                0,
                0,
                self.w as i32,
                self.h as i32,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                out.as_mut_ptr().cast(),
            );
            ensure!(glGetError() == GL_NO_ERROR, "gl err");
            if flip_out {
                let row = self.w as usize * 4;
                for y in 0..self.h as usize / 2 {
                    let (a, b) = out.split_at_mut((self.h as usize - 1 - y) * row);
                    a[y * row..(y + 1) * row].swap_with_slice(&mut b[..row]);
                }
            }
            Ok(out)
        }
    }
}
impl Drop for G {
    fn drop(&mut self) {
        unsafe {
            for (_, x) in self.cache.drain() {
                glDeleteTextures(1, &x.tex);
                eglDestroyImage(self.dpy, x.image);
            }
            glDeleteFramebuffers(1, &self.fbo);
            glDeleteTextures(1, &self.out_tex);
            glDeleteProgram(self.prog);
            eglMakeCurrent(self.dpy, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
            eglDestroyContext(self.dpy, self.ctx);
            eglTerminate(self.dpy);
            gbm_device_destroy(self.gbm);
            libc::close(self.fd);
        }
    }
}
fn ref_rgba(b: &[u8]) -> Vec<u8> {
    let mut o = vec![0; b.len()];
    for (i, p) in b.chunks_exact(4).enumerate() {
        o[i * 4] = p[2];
        o[i * 4 + 1] = p[1];
        o[i * 4 + 2] = p[0];
        o[i * 4 + 3] = 255
    }
    o
}
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && a.chunks_exact(4)
            .zip(b.chunks_exact(4))
            .all(|(x, y)| x[..3] == y[..3])
}
fn main() -> Result<()> {
    let d = read_desktop_info()?;
    let va = EncoderInput::new(Path::new(&d.render_node), d.width, d.height)?;
    let mut g = G::new(Path::new(&d.render_node), 96, 96)?;
    let mut cap = Capture::connect(&d)?;
    let fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
    let wake = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut mode = None;
    let mut times = Vec::new();
    let mut checked = 0;
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        cap.pump(Duration::from_millis(20), &wake)?;
        let Some(f) = cap.take_latest() else { continue };
        if !f.is_ready()? {
            continue;
        }
        let q = f.damage.first().copied().unwrap_or(DamageRect {
            x: 0,
            y: 0,
            width: 96,
            height: 96,
        });
        let r = DamageRect {
            x: q.x.min(d.width - 96),
            y: q.y.min(d.height - 96),
            width: 96,
            height: 96,
        };
        if mode.is_none() {
            let calibration = r;
            let (_, patches) = va.readback_rects_bounding_32(&f.buffer, &[calibration])?;
            let rb = &patches
                .first()
                .ok_or_else(|| anyhow::anyhow!("no calibration patch"))?
                .1;
            let rr = ref_rgba(rb);
            'm: for sy in [false, true] {
                for fo in [false, true] {
                    let got = g.read(&f.buffer, calibration, sy, fo)?;
                    let checksum: u64 = got.iter().map(|v| *v as u64).sum();
                    eprintln!(
                        "mode sy={} fo={} checksum={} first={:?}",
                        sy,
                        fo,
                        checksum,
                        &got[..got.len().min(32)]
                    );
                    if same(&got, &rr) {
                        mode = Some((sy, fo));
                        break 'm;
                    }
                }
            }
            if mode.is_none() {
                eprintln!(
                    "reference checksum={} first={:?}",
                    rr.iter().map(|v| *v as u64).sum::<u64>(),
                    &rr[..rr.len().min(32)]
                );
                bail!("sampled EGL path did not match current MWD2 reference")
            };
            checked += 1;
            continue;
        }
        let (sy, fo) = mode.unwrap();
        let t = Instant::now();
        let got = g.read(&f.buffer, r, sy, fo)?;
        times.push(t.elapsed().as_micros() as u64);
        if checked < 5 {
            let (_, patches) = va.readback_rects_bounding_32(&f.buffer, &[r])?;
            let rb = &patches
                .first()
                .ok_or_else(|| anyhow::anyhow!("no check patch"))?
                .1;
            ensure!(same(&got, &ref_rgba(rb)), "pixel mismatch");
            checked += 1;
        }
    }
    ensure!(!times.is_empty(), "no samples");
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
