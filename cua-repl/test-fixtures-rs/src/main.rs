use anyhow::{Context, Result, bail};
use eframe::{egui, glow::HasContext as _};
use serde_json::json;
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::CommandExt,
    },
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};

fn write_state(path: &Option<PathBuf>, value: serde_json::Value) {
    let Some(path) = path else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        path,
        format!("{}\n", serde_json::to_string(&value).unwrap()),
    );
}

#[derive(Clone, Copy, Debug)]
enum Mode {
    Smoke,
    Controls,
    Gl,
}

struct FixtureApp {
    mode: Mode,
    log: Option<PathBuf>,
    clicks: u64,
    keys: u64,
    text: String,
    scale: f64,
    scroll: f64,
    gl_version: String,
    gl_renderer: String,
    initial_written: bool,
}

impl FixtureApp {
    fn new(mode: Mode, log: Option<PathBuf>, cc: &eframe::CreationContext<'_>) -> Self {
        let (gl_version, gl_renderer) = if let Some(gl) = cc.gl.as_ref() {
            unsafe {
                (
                    gl.get_parameter_string(eframe::glow::VERSION),
                    gl.get_parameter_string(eframe::glow::RENDERER),
                )
            }
        } else {
            ("eframe".into(), "software/unknown".into())
        };
        Self {
            mode,
            log,
            clicks: 0,
            keys: 0,
            text: String::new(),
            scale: 20.0,
            scroll: 0.0,
            gl_version,
            gl_renderer,
            initial_written: false,
        }
    }

    fn controls_state(&self) -> serde_json::Value {
        json!({"scale": self.scale, "scroll": self.scroll, "ready": true})
    }

    fn gl_state(&self) -> serde_json::Value {
        json!({
            "clicks": self.clicks,
            "keys": self.keys,
            "version": self.gl_version,
            "renderer": self.gl_renderer,
        })
    }
}

impl eframe::App for FixtureApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        match self.mode {
            Mode::Smoke => {
                egui::CentralPanel::default().show(ctx, |ui| {
                    ui.vertical(|ui| {
                        let label = if self.clicks == 0 {
                            "Click me".to_string()
                        } else {
                            format!("Clicked {}", self.clicks)
                        };
                        if ui.button(label).clicked() {
                            self.clicks += 1;
                        }
                        ui.add(egui::TextEdit::singleline(&mut self.text).hint_text("Type here"));
                    });
                });
            }
            Mode::Controls => {
                let mut changed = false;
                let raw_scroll = ctx.input(|i| i.raw_scroll_delta.y.abs() as f64);
                if raw_scroll > 0.0 {
                    self.scroll += raw_scroll;
                    changed = true;
                }
                egui::CentralPanel::default().show(ctx, |ui| {
                    let response = ui.add(
                        egui::Slider::new(&mut self.scale, 0.0..=100.0)
                            .text("Scale")
                            .step_by(1.0),
                    );
                    changed |= response.changed();
                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for i in 0..60 {
                            ui.add_sized(
                                [ui.available_width(), 48.0],
                                egui::Label::new(format!("Row {i:02}")),
                            );
                        }
                    });
                });
                if changed || !self.initial_written {
                    write_state(&self.log, self.controls_state());
                }
            }
            Mode::Gl => {
                let (clicked, key_count) = ctx.input(|i| {
                    let clicks = i.pointer.any_pressed();
                    let keys = i
                        .events
                        .iter()
                        .filter(|event| {
                            matches!(
                                event,
                                egui::Event::Key {
                                    pressed: true,
                                    repeat: false,
                                    ..
                                }
                            )
                        })
                        .count() as u64;
                    (clicks, keys)
                });
                if clicked {
                    self.clicks += 1;
                }
                self.keys += key_count;
                let color = if self.clicks > 0 {
                    egui::Color32::from_rgb(25, 166, 64)
                } else {
                    egui::Color32::from_rgb(179, 25, 64)
                };
                egui::CentralPanel::default()
                    .frame(egui::Frame::default().fill(color))
                    .show(ctx, |ui| {
                        ui.allocate_space(ui.available_size());
                    });
                write_state(&self.log, self.gl_state());
                ctx.request_repaint_after(Duration::from_millis(50));
            }
        }
        self.initial_written = true;
    }
}

fn backend() -> &'static str {
    if env::var("WINIT_UNIX_BACKEND").ok().as_deref() == Some("x11")
        || env::var("GDK_BACKEND").ok().as_deref() == Some("x11")
    {
        "x11"
    } else {
        "wayland"
    }
}

fn run_gui(mode: Mode) -> Result<()> {
    let log = env::var_os("MCPBROWSER_FIXTURE_LOG").map(PathBuf::from);
    let (title, size) = match mode {
        Mode::Smoke => (
            if backend() == "x11" {
                "CUA Native X11 Smoke"
            } else {
                "CUA Native Wayland Smoke"
            },
            [640.0, 360.0],
        ),
        Mode::Controls => ("MCPBrowser Native Controls", [640.0, 480.0]),
        Mode::Gl => ("MCPBrowser Native OpenGL", [500.0, 320.0]),
    };
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title(title)
            .with_inner_size(size),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native(
        title,
        options,
        Box::new(move |cc| Ok(Box::new(FixtureApp::new(mode, log, cc)))),
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))
}

fn run_lock(path: &Path) -> Result<()> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if rc != 0 {
        bail!("flock failed: {}", std::io::Error::last_os_error())
    }
    println!("ready");
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn fd_check() -> Result<()> {
    let expected_pid: u32 = env::var("LISTEN_PID")
        .context("LISTEN_PID missing")?
        .parse()?;
    if expected_pid != std::process::id() {
        bail!("LISTEN_PID does not match current process")
    }
    let listen_fds = env::var("LISTEN_FDS").context("LISTEN_FDS missing")?;
    if listen_fds != "1" {
        bail!("LISTEN_FDS must be 1")
    }
    let mut file = unsafe { File::from_raw_fd(3) };
    let mut value = String::new();
    file.read_to_string(&mut value)?;
    if value != "descriptor-three" {
        bail!("unexpected fd 3 payload")
    }
    println!(
        "{}",
        env::var("MCPBROWSER_NATIVE_WIDTH").context("native width missing")?
    );
    Ok(())
}

fn exec_native_run(input: &Path, control: &Path, config: &Path) -> Result<()> {
    let input = File::open(input).with_context(|| format!("open {}", input.display()))?;
    if unsafe { libc::dup2(input.as_raw_fd(), 3) } < 0 {
        bail!("dup2 failed: {}", std::io::Error::last_os_error())
    }
    unsafe {
        libc::fcntl(3, libc::F_SETFD, 0);
    }
    let pid = std::process::id().to_string();
    let err = Command::new(control)
        .args(["native-run", "worker", "fd-check", "--config"])
        .arg(config)
        .env("LISTEN_PID", pid)
        .env("LISTEN_FDS", "1")
        .exec();
    Err(err).with_context(|| format!("exec {}", control.display()))
}

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("smoke") => run_gui(Mode::Smoke),
        Some("controls") => run_gui(Mode::Controls),
        Some("gl") => run_gui(Mode::Gl),
        Some("lock") => {
            let path = args.next().context("lock requires a path")?;
            run_lock(Path::new(&path))
        }
        Some("fd-check") => fd_check(),
        Some("exec-native-run") => {
            let input = args.next().context("exec-native-run requires input path")?;
            let control = args
                .next()
                .context("exec-native-run requires control path")?;
            let config = args
                .next()
                .context("exec-native-run requires config path")?;
            exec_native_run(Path::new(&input), Path::new(&control), Path::new(&config))
        }
        _ => bail!(
            "usage: mcpbrowser-test-fixture <smoke|controls|gl|lock|fd-check|exec-native-run> ..."
        ),
    }
}
