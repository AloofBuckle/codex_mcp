use anyhow::{Context, Result, bail};
use mcpbrowser_native_cua::settings::{setting, tool};
use mcpbrowser_native_cua::{DesktopInfo, ensure_dir, run_dir, state_dir};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::signal::unix::{SignalKind, signal};
use zbus::{Address, Connection};

#[derive(Clone)]
struct A11yBus {
    address: String,
}

#[zbus::interface(name = "org.a11y.Bus")]
impl A11yBus {
    #[zbus(name = "GetAddress")]
    fn get_address(&self) -> String {
        self.address.clone()
    }
}

#[derive(Clone)]
struct A11yStatus {
    enabled: Arc<Mutex<bool>>,
    screen_reader: Arc<Mutex<bool>>,
}

#[zbus::interface(name = "org.a11y.Status")]
impl A11yStatus {
    #[zbus(property, name = "IsEnabled")]
    fn is_enabled(&self) -> bool {
        *self.enabled.lock().expect("a11y status mutex")
    }

    #[zbus(property, name = "IsEnabled")]
    fn set_is_enabled(&self, value: bool) {
        *self.enabled.lock().expect("a11y status mutex") = value;
    }

    #[zbus(property, name = "ScreenReaderEnabled")]
    fn screen_reader_enabled(&self) -> bool {
        *self.screen_reader.lock().expect("a11y status mutex")
    }

    #[zbus(property, name = "ScreenReaderEnabled")]
    fn set_screen_reader_enabled(&self, value: bool) {
        *self.screen_reader.lock().expect("a11y status mutex") = value;
    }
}

struct Children(Vec<Child>);

impl Children {
    fn spawn(
        &mut self,
        program: &str,
        args: &[&str],
        env: &HashMap<String, String>,
    ) -> Result<u32> {
        let child = Command::new(tool(program))
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("spawn {program}"))?;
        let pid = child.id();
        self.0.push(child);
        Ok(pid)
    }

    fn check(&mut self) -> Result<()> {
        for child in &mut self.0 {
            if let Some(status) = child.try_wait()? {
                bail!("critical desktop child pid={} exited: {status}", child.id());
            }
        }
        Ok(())
    }

    fn stop(&mut self) {
        for child in self.0.iter_mut().rev() {
            let _ = child.kill();
        }
        for child in self.0.iter_mut().rev() {
            let _ = child.wait();
        }
    }
}

impl Drop for Children {
    fn drop(&mut self) {
        self.stop();
    }
}

fn base_env(run: &Path, state: &Path) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    for key in [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "SWAYSOCK",
        "DBUS_SESSION_BUS_ADDRESS",
        "AT_SPI_BUS_ADDRESS",
        "CUA_INJECT_SOCKET",
        "CUA_WAYLAND_NEST",
        "MCPBROWSER_CUA_INPUT_SOCKET",
        "PULSE_SERVER",
        "PULSE_SINK",
        // The old outer-Sway path used this to suppress CCS globally. Direct
        // KWin pins only its capture swapchain to Tile4 instead, so ordinary
        // client surfaces remain free to use compression.
        "INTEL_DEBUG",
    ] {
        env.remove(key);
    }
    env.insert("HOME".into(), state.join("home").display().to_string());
    env.insert("XDG_RUNTIME_DIR".into(), run.display().to_string());
    let configured = |name: &str, fallback: &Path| {
        let value = setting(name);
        if value.is_empty() {
            fallback.display().to_string()
        } else {
            value
        }
    };
    env.insert(
        "XDG_CONFIG_HOME".into(),
        configured("MCPBROWSER_PLASMA_CONFIG_DIR", &state.join("plasma-config")),
    );
    env.insert(
        "XDG_CACHE_HOME".into(),
        configured("MCPBROWSER_PLASMA_CACHE_DIR", &state.join("plasma-cache")),
    );
    env.insert(
        "XDG_DATA_HOME".into(),
        configured("MCPBROWSER_PLASMA_DATA_DIR", &state.join("plasma-data")),
    );
    env.insert("XDG_SESSION_TYPE".into(), "wayland".into());
    env.insert("XDG_CURRENT_DESKTOP".into(), "KDE".into());
    env.insert("XDG_SESSION_DESKTOP".into(), "KDE".into());
    env.insert("DESKTOP_SESSION".into(), "plasma".into());
    env.insert("KDE_FULL_SESSION".into(), "true".into());
    env.insert("KDE_SESSION_VERSION".into(), "6".into());
    env.insert(
        "DBUS_SESSION_BUS_ADDRESS".into(),
        format!("unix:path={}", run.join("session-bus").display()),
    );
    env.insert(
        "AT_SPI_BUS_ADDRESS".into(),
        format!("unix:path={}", run.join("a11y-bus").display()),
    );
    env.insert("NO_AT_BRIDGE".into(), "0".into());
    env.insert("ACCESSIBILITY_ENABLED".into(), "1".into());
    env.insert("GSETTINGS_BACKEND".into(), "keyfile".into());
    env.insert("QT_QPA_PLATFORM".into(), "wayland".into());
    env.insert("GTK_A11Y".into(), "atspi".into());
    env.insert("QT_LINUX_ACCESSIBILITY_ALWAYS_ON".into(), "1".into());
    env
}

fn write_bus_config(path: &Path, bus_type: &str, address: &str) -> Result<()> {
    let service_dirs = if bus_type == "session" {
        "<standard_session_servicedirs/>"
    } else {
        ""
    };
    fs::write(
        path,
        format!(
            "<busconfig><type>{bus_type}</type><auth>EXTERNAL</auth>{service_dirs}\n\
             <listen>{address}</listen><policy context=\"default\">\n\
             <allow user=\"{}\"/><allow send_destination=\"*\"/>\n\
             <allow receive_type=\"method_call\"/><allow receive_type=\"method_return\"/>\n\
             <allow receive_type=\"error\"/><allow receive_type=\"signal\"/><allow own=\"*\"/>\n\
             </policy></busconfig>",
            unsafe { libc::geteuid() }
        ),
    )?;
    Ok(())
}

async fn wait_for<F, T>(
    label: &str,
    timeout: Duration,
    mut f: F,
    children: &mut Children,
) -> Result<T>
where
    F: FnMut() -> Result<Option<T>>,
{
    let deadline = Instant::now() + timeout;
    loop {
        children.check()?;
        if let Some(value) = f()? {
            return Ok(value);
        }
        if Instant::now() >= deadline {
            bail!("timeout waiting for {label}");
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}

fn socket_exists(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_socket())
        .unwrap_or(false)
}

fn process_uses_device(pid: u32, device: &Path) -> Result<bool> {
    let wanted = fs::metadata(device)?.rdev();
    let fd_dir = Path::new("/proc").join(pid.to_string()).join("fd");
    for entry in fs::read_dir(fd_dir)? {
        let entry = entry?;
        if fs::metadata(entry.path()).is_ok_and(|meta| meta.rdev() == wanted) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn process_has_software_gl(pid: u32) -> bool {
    fs::read_to_string(Path::new("/proc").join(pid.to_string()).join("maps"))
        .is_ok_and(|maps| maps.contains("swrast_dri.so") || maps.contains("llvmpipe"))
}

fn exported_env(env: &HashMap<String, String>) -> HashMap<String, String> {
    const KEYS: &[&str] = &[
        "HOME",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
        "KDE_FULL_SESSION",
        "KDE_SESSION_VERSION",
        "DBUS_SESSION_BUS_ADDRESS",
        "AT_SPI_BUS_ADDRESS",
        "NO_AT_BRIDGE",
        "ACCESSIBILITY_ENABLED",
        "GSETTINGS_BACKEND",
        "QT_QPA_PLATFORM",
        "GTK_A11Y",
        "QT_LINUX_ACCESSIBILITY_ALWAYS_ON",
        "WAYLAND_DISPLAY",
    ];
    env.iter()
        .filter(|(key, _)| {
            KEYS.contains(&key.as_str())
                || key.starts_with("MCPBROWSER_TOOL_")
                || key.starts_with("MCPBROWSER_NATIVE_")
                || ["CUA_CONFIG", "MCPBROWSER_ROOT"].contains(&key.as_str())
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

async fn run() -> Result<()> {
    let run = run_dir();
    let state = state_dir();
    let width: u32 = setting("MCPBROWSER_NATIVE_WIDTH")
        .parse()
        .context("nativeSystem.width")?;
    let height: u32 = setting("MCPBROWSER_NATIVE_HEIGHT")
        .parse()
        .context("nativeSystem.height")?;
    let fps: u32 = setting("MCPBROWSER_NATIVE_FPS")
        .parse()
        .context("nativeSystem.fps")?;
    let output = setting("MCPBROWSER_NATIVE_OUTPUT");
    let scale: f64 = setting("MCPBROWSER_NATIVE_SCALE")
        .parse()
        .context("nativeSystem.scale")?;
    let wayland = setting("MCPBROWSER_NATIVE_WAYLAND_SOCKET");
    if wayland.is_empty() || wayland.contains('/') {
        bail!("invalid direct KWin Wayland socket name");
    }
    ensure_dir(&run)?;
    for dir in [
        state.clone(),
        state.join("home"),
        Path::new(&base_env(&run, &state)["XDG_CONFIG_HOME"]).to_path_buf(),
        Path::new(&base_env(&run, &state)["XDG_CACHE_HOME"]).to_path_buf(),
        Path::new(&base_env(&run, &state)["XDG_DATA_HOME"]).to_path_buf(),
    ] {
        ensure_dir(&dir)?;
    }
    for entry in fs::read_dir(&run)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("sway-ipc.")
            || name.starts_with("wayland-")
            || name == setting("MCPBROWSER_NATIVE_WAYLAND_SOCKET")
            || name == format!("{}.lock", setting("MCPBROWSER_NATIVE_WAYLAND_SOCKET"))
            || matches!(
                name.as_str(),
                "session-bus" | "a11y-bus" | "environment.json"
            )
        {
            let _ = fs::remove_file(entry.path());
        }
    }

    let mut env = base_env(&run, &state);
    // D-Bus activation snapshots the daemon's startup environment. The socket
    // does not need to exist yet, but the final name must already be present so
    // Plasma services activated after KWin starts can connect to the compositor.
    env.insert("WAYLAND_DISPLAY".into(), wayland.clone());
    let session_addr = env["DBUS_SESSION_BUS_ADDRESS"].clone();
    let a11y_addr = env["AT_SPI_BUS_ADDRESS"].clone();
    write_bus_config(&run.join("session.conf"), "session", &session_addr)?;
    write_bus_config(&run.join("a11y.conf"), "accessibility", &a11y_addr)?;

    let mut children = Children(Vec::new());
    children.spawn(
        "dbus-daemon",
        &[
            "--nofork",
            &format!("--config-file={}", run.join("session.conf").display()),
        ],
        &env,
    )?;
    wait_for(
        "session bus",
        Duration::from_secs(8),
        || Ok(socket_exists(&run.join("session-bus")).then_some(())),
        &mut children,
    )
    .await?;
    children.spawn(
        "dbus-daemon",
        &[
            "--nofork",
            &format!("--config-file={}", run.join("a11y.conf").display()),
        ],
        &env,
    )?;
    wait_for(
        "accessibility bus",
        Duration::from_secs(8),
        || Ok(socket_exists(&run.join("a11y-bus")).then_some(())),
        &mut children,
    )
    .await?;

    let mut registry_env = env.clone();
    registry_env.insert("DBUS_SESSION_BUS_ADDRESS".into(), a11y_addr.clone());
    children.spawn(
        &setting("MCPBROWSER_NATIVE_ATSPI_REGISTRY"),
        &["--dbus-name", "org.a11y.atspi.Registry"],
        &registry_env,
    )?;

    let address: Address = session_addr.parse()?;
    let broker: Connection = zbus::connection::Builder::address(address)?
        .name("org.a11y.Bus")?
        .serve_at(
            "/org/a11y/bus",
            A11yBus {
                address: a11y_addr.clone(),
            },
        )?
        .serve_at(
            "/org/a11y/bus",
            A11yStatus {
                enabled: Arc::new(Mutex::new(true)),
                screen_reader: Arc::new(Mutex::new(true)),
            },
        )?
        .build()
        .await?;
    let _keep_broker_alive = broker;

    // Wait until registryd owns its name on the accessibility bus.
    let a11y_address: Address = a11y_addr.parse()?;
    let a11y_conn = zbus::connection::Builder::address(a11y_address)?
        .build()
        .await?;
    let dbus = zbus::fdo::DBusProxy::new(&a11y_conn).await?;
    let registry_name = zbus::names::BusName::try_from("org.a11y.atspi.Registry")?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        children.check()?;
        if dbus
            .name_has_owner(registry_name.clone())
            .await
            .unwrap_or(false)
        {
            break;
        }
        if Instant::now() >= deadline {
            bail!("timeout waiting for AT-SPI registry");
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }

    let render_node = setting("MCPBROWSER_NATIVE_RENDER_NODE");
    if render_node.is_empty() || !Path::new(&render_node).exists() {
        bail!("direct KWin requires the configured GPU render node");
    }
    let kwin_binary = setting("MCPBROWSER_NATIVE_KWIN");
    let kwin_library = setting("MCPBROWSER_NATIVE_KWIN_LIBRARY_PATH");
    let capture_modifier = setting("MCPBROWSER_NATIVE_CAPTURE_MODIFIER");
    if !Path::new(&kwin_binary).is_file() || !Path::new(&kwin_library).is_dir() {
        bail!("private direct-KWin runtime is not installed");
    }
    let session = setting("MCPBROWSER_NATIVE_SESSION");
    if session.is_empty() || !Path::new(&session).is_file() {
        bail!("tools.nativeSession is not configured or built");
    }

    let mut compositor_env = env.clone();
    compositor_env.insert("KWIN_COMPOSE".into(), "O2".into());
    compositor_env.insert("KWIN_WAYLAND_NO_PERMISSION_CHECKS".into(), "1".into());
    compositor_env.insert("KWIN_SCREENSHOT_NO_PERMISSION_CHECKS".into(), "1".into());
    compositor_env.insert("MCPBROWSER_NATIVE_RENDER_NODE".into(), render_node.clone());
    compositor_env.insert(
        "MCPBROWSER_KWIN_VIRTUAL_REFRESH_MHZ".into(),
        (fps * 1000).to_string(),
    );
    compositor_env.insert("MCPBROWSER_NATIVE_OUTPUT".into(), output.clone());
    compositor_env.insert("MCPBROWSER_KWIN_CAPTURE_MODIFIER".into(), capture_modifier);
    compositor_env.insert("MCPBROWSER_KWIN_LOW_LATENCY".into(), "1".into());
    compositor_env.insert("MCPBROWSER_KWIN_REMOTE_CURSOR".into(), "1".into());
    compositor_env.insert("LD_LIBRARY_PATH".into(), kwin_library);
    compositor_env.insert("MCPBROWSER_NATIVE_RUN".into(), run.display().to_string());
    let plasma_environment = setting("MCPBROWSER_PLASMA_ENVIRONMENT_FILE");
    compositor_env.insert(
        "MCPBROWSER_PLASMA_ENVIRONMENT_FILE".into(),
        if plasma_environment.is_empty() {
            run.join("plasma-environment").display().to_string()
        } else {
            plasma_environment
        },
    );
    compositor_env.insert(
        "MCPBROWSER_PLASMA_AUDIO_RUNTIME".into(),
        setting("MCPBROWSER_PLASMA_AUDIO_RUNTIME"),
    );
    compositor_env.insert("MCPBROWSER_TOOL_PLASMASHELL".into(), tool("plasmashell"));
    compositor_env.insert("MCPBROWSER_TOOL_KWRITECONFIG".into(), tool("kwriteconfig"));
    compositor_env.insert("MCPBROWSER_TOOL_QDBUS".into(), tool("qdbus"));

    let width_s = width.to_string();
    let height_s = height.to_string();
    let scale_s = scale.to_string();
    let kwin_pid = children.spawn(
        &kwin_binary,
        &[
            "--virtual",
            "--socket",
            &wayland,
            "--width",
            &width_s,
            "--height",
            &height_s,
            "--scale",
            &scale_s,
            "--output-count",
            "1",
            "--no-lockscreen",
            "--no-global-shortcuts",
            "--xwayland",
            &session,
        ],
        &compositor_env,
    )?;

    wait_for(
        "direct KWin Wayland socket",
        Duration::from_secs(15),
        || Ok(socket_exists(&run.join(&wayland)).then_some(())),
        &mut children,
    )
    .await?;
    wait_for(
        "direct KWin hardware renderer",
        Duration::from_secs(10),
        || {
            if process_has_software_gl(kwin_pid) {
                bail!("direct KWin loaded a software GL renderer");
            }
            Ok(process_uses_device(kwin_pid, Path::new(&render_node))?.then_some(()))
        },
        &mut children,
    )
    .await?;
    env.insert("WAYLAND_DISPLAY".into(), wayland.clone());
    env.insert("MCPBROWSER_NATIVE_OUTPUT".into(), output.clone());
    wait_for(
        "Plasma session environment",
        Duration::from_secs(15),
        || {
            Ok(
                Path::new(&compositor_env["MCPBROWSER_PLASMA_ENVIRONMENT_FILE"])
                    .is_file()
                    .then_some(()),
            )
        },
        &mut children,
    )
    .await?;

    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_string();
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let info = DesktopInfo {
        env: exported_env(&env),
        pid: kwin_pid,
        epoch: format!("{boot_id}:{kwin_pid}:{now}"),
        width,
        height,
        renderer: "kwin-virtual-egl".into(),
        render_node,
    };
    let tmp = run.join("environment.tmp");
    fs::write(&tmp, serde_json::to_vec(&info)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, run.join("environment.json"))?;
    let _ = Command::new(tool("systemd-notify"))
        .args([
            "--ready",
            &format!("--status=Direct KWin GPU desktop ready: {width}x{height}@{fps}"),
        ])
        .status();
    println!(
        "{}",
        serde_json::to_string(&json!({
            "pid": info.pid, "epoch": info.epoch, "width": info.width, "height": info.height,
            "renderer": info.renderer, "renderNode": info.render_node,
        }))?
    );

    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    loop {
        tokio::select! {
            _ = term.recv() => break,
            _ = interrupt.recv() => break,
            _ = tokio::time::sleep(Duration::from_millis(250)) => children.check()?,
        }
    }
    let _ = fs::remove_file(run.join("environment.json"));
    children.stop();
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("mcpbrowser-cua-native-desktop: {error:#}");
        std::process::exit(1);
    }
}
