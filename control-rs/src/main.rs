use anyhow::{Context, Result, anyhow, bail};
use mcpbrowser_control::{
    LoadedConfig, discover_root, find_executable, get, get_bool, get_string, get_u64, load_config,
    native_environment, write_atomic,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixStream,
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

fn usage() -> &'static str {
    "mcpbrowserctl <command> [--config file.yaml]\n\
commands:\n\
  check                    validate YAML\n\
  doctor                   check configured prerequisites\n\
  json                     print resolved configuration\n\
  get <dotted.key>         print one resolved configuration value\n\
  env                      print native environment as JSON\n\
  url                      print private GUI login URL\n\
  serve                    run GUI + HTTP MCP, no stdio MCP\n\
  mcp                      run stdio MCP without GUI\n\
  service-start            start serve mode detached with PID/log files\n\
  service-stop             stop the detached source service\n\
  display-start            start configured Xvfb display if needed\n\
  native-build             build/install Native Rust binaries\n\
  native-input-build       build the native input helper\n\
  native-run <role>        exec desktop|worker|live|pointer with YAML env\n\
  native-app <name>        launch browser|files|terminal on Native desktop\n\
  deploy [--out dir]       render systemd deployment files\n\
  native-install [--apply] [--start]  render/install Native units\n\
  extension-install        prepare extension and Native Messaging host\n\
  native-shims-build       build configured optional native shims\n\
  prepare-wlroots <src> [--build dir] patch a wlroots source tree for DMA-BUF lease\n\
  source-release [--out dir] create allowlisted source tarball\n\
  package [options]        build main DEB/RPM with Rust control binary\n\
  package-native [options] build target-distro Native DEB/RPM\n\
  version                  print control/runtime versions"
}

fn config_arg(args: &[String]) -> Result<Option<PathBuf>> {
    if let Some(i) = args.iter().position(|x| x == "--config") {
        let Some(v) = args.get(i + 1) else {
            bail!("--config requires a path")
        };
        Ok(Some(PathBuf::from(v)))
    } else {
        Ok(None)
    }
}

fn strip_config(args: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--config" {
            if i + 1 >= args.len() {
                bail!("--config requires a path")
            }
            i += 2;
        } else {
            out.push(args[i].clone());
            i += 1;
        }
    }
    Ok(out)
}

fn loaded(args: &[String]) -> Result<LoadedConfig> {
    let root = discover_root()?;
    let config = config_arg(args)?;
    load_config(&root, config.as_deref())
}

fn value_to_text(value: &Value) -> Result<String> {
    Ok(match value {
        Value::String(s) => s.clone(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Null => String::new(),
        other => serde_json::to_string(other)?,
    })
}

fn run_status(mut command: Command, label: &str) -> Result<()> {
    let status = command.status().with_context(|| format!("run {label}"))?;
    if !status.success() {
        bail!("{label} failed with {status}")
    }
    Ok(())
}

fn run_output(mut command: Command, label: &str) -> Result<String> {
    let output = command.output().with_context(|| format!("run {label}"))?;
    if !output.status.success() {
        bail!(
            "{label} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

fn ensure_executable(config: &LoadedConfig, key: &str) -> Result<PathBuf> {
    let raw = get_string(&config.value, key)?;
    find_executable(&raw).ok_or_else(|| anyhow!("configured {key} is not executable: {raw}"))
}

fn doctor(config: &LoadedConfig) -> Result<bool> {
    let mut checks = BTreeMap::new();
    let node = get_string(&config.value, "tools.node")?;
    let node_ok = find_executable(&node)
        .and_then(|path| {
            Command::new(path).arg("--version").output().ok().map(|o| {
                o.status.success()
                    && String::from_utf8_lossy(&o.stdout)
                        .trim_start_matches('v')
                        .starts_with("24.")
            })
        })
        .unwrap_or(false);
    checks.insert("node".to_string(), node_ok);
    checks.insert(
        "browser".into(),
        find_executable(&get_string(&config.value, "browser.executablePath")?).is_some(),
    );
    if !get_bool(&config.value, "browser.headless")?
        && get_bool(&config.value, "browser.spawnXvfb")?
    {
        checks.insert(
            "xvfb".into(),
            find_executable(&get_string(&config.value, "tools.xvfb")?).is_some(),
        );
    }
    if get_bool(&config.value, "native.enabled")? {
        for key in [
            "nativeDesktop",
            "nativeWorker",
            "nativePointer",
            "sway",
            "swaymsg",
            "grim",
            "wtype",
            "wlrRandr",
            "dbusDaemon",
            "atspiRegistry",
        ] {
            let path = format!("tools.{key}");
            checks.insert(
                key.into(),
                find_executable(&get_string(&config.value, &path)?).is_some(),
            );
        }
        for key in ["nativeSystem.renderNode", "nativeSystem.kwinBinary"] {
            let raw = get_string(&config.value, key)?;
            checks.insert(key.into(), !raw.is_empty() && Path::new(&raw).exists());
        }
    }
    if get_bool(&config.value, "nativeLive.enabled")? {
        checks.insert(
            "nativeLive".into(),
            find_executable(&get_string(&config.value, "tools.nativeLive")?).is_some(),
        );
    }
    if get_bool(&config.value, "gui.tls.enabled")? {
        for key in ["certFile", "keyFile"] {
            checks.insert(
                format!("tls.{key}"),
                Path::new(&get_string(&config.value, &format!("gui.tls.{key}"))?).is_file(),
            );
        }
    }
    let ok = checks.values().all(|v| *v);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "ok": ok,
            "checks": checks,
            "proxyRequired": false,
        }))?
    );
    Ok(ok)
}

fn gui_url(config: &LoadedConfig) -> Result<String> {
    let public = get_string(&config.value, "gui.publicOrigin")?;
    let origin = if public.is_empty() {
        let host = get_string(&config.value, "gui.host")?;
        let port = get_u64(&config.value, "gui.port")?;
        let tls = get_bool(&config.value, "gui.tls.enabled")?;
        let visible_host = if host == "0.0.0.0" || host == "::" {
            "localhost".into()
        } else {
            host
        };
        let host_fmt = if visible_host.contains(':') && !visible_host.starts_with('[') {
            format!("[{visible_host}]")
        } else {
            visible_host
        };
        format!(
            "{}://{}:{}",
            if tls { "https" } else { "http" },
            host_fmt,
            port
        )
    } else {
        public
    };
    let token_file = get_string(&config.value, "gui.tokenFile")?;
    let token = fs::read_to_string(&token_file)
        .with_context(|| format!("read GUI token file {token_file}"))?
        .trim()
        .to_string();
    if token.is_empty() {
        bail!("GUI token file is empty")
    }
    let base = get_string(&config.value, "gui.basePath")?;
    Ok(format!("{origin}{base}/?token={}", percent_encode(&token)))
}

fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn exec_node_runtime(config: &LoadedConfig, serve: bool) -> Result<()> {
    let node = ensure_executable(config, "tools.node")?;
    let server = config.root.join("src/server.mjs");
    let mut cmd = Command::new(node);
    cmd.arg(server);
    if serve {
        cmd.arg("--gui").arg("--no-stdio");
    } else {
        cmd.arg("--no-gui").arg("--quiet");
    }
    if let Some(path) = &config.config_path {
        cmd.arg("--config").arg(path);
    }
    cmd.env("MCPBROWSER_ROOT", &config.root);
    cmd.env("MCPBROWSER_CONTROL_BINARY", env::current_exe()?);
    let err = cmd.exec();
    Err(err).context("exec Node runtime")
}

fn service_start(config: &LoadedConfig) -> Result<()> {
    let runtime = PathBuf::from(get_string(&config.value, "runtimeDir")?);
    fs::create_dir_all(&runtime)?;
    let pid_file = runtime.join("server.pid");
    if let Ok(raw) = fs::read_to_string(&pid_file) {
        if let Ok(pid) = raw.trim().parse::<i32>() {
            if process_alive(pid) {
                println!("recorded service process {pid} is still running; no duplicate started");
                return Ok(());
            }
        }
    }
    let exe = env::current_exe()?;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime.join("server.stdout.log"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime.join("server.stderr.log"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("serve");
    if let Some(path) = &config.config_path {
        cmd.arg("--config").arg(path);
    }
    cmd.current_dir(&config.root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .process_group(0);
    let child = cmd.spawn().context("start detached source service")?;
    write_atomic(&pid_file, format!("{}\n", child.id()).as_bytes(), 0o600)?;
    thread::sleep(Duration::from_millis(500));
    if !process_alive(child.id() as i32) {
        bail!("service did not stay running; inspect server.stderr.log")
    }
    println!("started MCPBrowser service PID {}", child.id());
    Ok(())
}

fn process_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn service_stop(config: &LoadedConfig) -> Result<()> {
    let runtime = PathBuf::from(get_string(&config.value, "runtimeDir")?);
    let pid_file = runtime.join("server.pid");
    if !pid_file.exists() {
        println!("no project service PID file");
        return Ok(());
    }
    let raw = fs::read_to_string(&pid_file)?;
    let pid: i32 = raw.trim().parse().context("invalid PID file")?;
    if !process_alive(pid) {
        fs::remove_file(&pid_file)?;
        println!("recorded process is no longer running");
        return Ok(());
    }
    let cmdline = fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    let text = String::from_utf8_lossy(&cmdline).replace('\0', " ");
    if !text.contains("mcpbrowserctl") || !text.contains("serve") {
        bail!("PID {pid} is not an MCPBrowser control serve process; refusing to signal it")
    }
    let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
    if rc != 0 {
        return Err(io::Error::last_os_error()).context("signal service");
    }
    fs::remove_file(&pid_file)?;
    println!("requested graceful shutdown of PID {pid}");
    Ok(())
}

fn display_start(config: &LoadedConfig) -> Result<()> {
    let display = get_string(&config.value, "browser.display")?;
    let Some(num) = display.strip_prefix(':') else {
        bail!("browser.display must be :<number>")
    };
    let num = num.split('.').next().unwrap_or(num);
    if !num.chars().all(|c| c.is_ascii_digit()) {
        bail!("browser.display must be :<number>")
    }
    let socket = PathBuf::from(format!("/tmp/.X11-unix/X{num}"));
    if socket.exists() {
        println!("display {display} already exists; no changes made");
        return Ok(());
    }
    let xvfb = ensure_executable(config, "tools.xvfb")?;
    let runtime = PathBuf::from(get_string(&config.value, "runtimeDir")?).join("display");
    fs::create_dir_all(&runtime)?;
    let log = File::create(runtime.join("xvfb.log"))?;
    let err = log.try_clone()?;
    let screen = format!(
        "{}x{}x{}",
        get_u64(&config.value, "browser.xvfbScreen.width")?,
        get_u64(&config.value, "browser.xvfbScreen.height")?,
        get_u64(&config.value, "browser.xvfbScreen.depth")?
    );
    let child = Command::new(xvfb)
        .arg(&display)
        .args(["-screen", "0", &screen, "-nolisten", "tcp"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .process_group(0)
        .spawn()?;
    write_atomic(
        &runtime.join("xvfb.pid"),
        format!("{}\n", child.id()).as_bytes(),
        0o600,
    )?;
    for _ in 0..20 {
        if socket.exists() {
            println!("created isolated display {display}");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    bail!(
        "Xvfb did not create {display}; inspect {}",
        runtime.join("xvfb.log").display()
    )
}

fn native_role_key(role: &str) -> Result<&'static str> {
    match role {
        "desktop" => Ok("tools.nativeDesktop"),
        "worker" => Ok("tools.nativeWorker"),
        "live" => Ok("tools.nativeLive"),
        "pointer" => Ok("tools.nativePointer"),
        _ => bail!("native role must be desktop|worker|live|pointer"),
    }
}

fn native_run(config: &LoadedConfig, role: &str, extra: &[String]) -> Result<()> {
    let key = native_role_key(role)?;
    let executable = ensure_executable(config, key)?;
    let mut cmd = Command::new(executable);
    cmd.args(extra).current_dir(&config.root);
    for (k, v) in native_environment(config)? {
        cmd.env(k, v);
    }
    let err = cmd.exec();
    Err(err).context("exec native role")
}

fn copy_executable(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = dst.with_extension(format!("new-{}", std::process::id()));
    fs::copy(src, &tmp).with_context(|| format!("copy {} -> {}", src.display(), tmp.display()))?;
    let mut p = fs::metadata(&tmp)?.permissions();
    p.set_mode(0o755);
    fs::set_permissions(&tmp, p)?;
    fs::rename(tmp, dst)?;
    Ok(())
}

fn native_build(config: &LoadedConfig) -> Result<()> {
    let cargo = ensure_executable(config, "tools.cargo")?;
    let target = PathBuf::from(get_string(&config.value, "deployment.buildDir")?);
    fs::create_dir_all(&target)?;
    let mut control = Command::new(&cargo);
    control
        .current_dir(&config.root)
        .env("CARGO_TARGET_DIR", &target)
        .args(["build", "--locked", "--release", "--manifest-path"])
        .arg(config.root.join("control-rs/Cargo.toml"))
        .arg("--bins");
    run_status(control, "control cargo build")?;
    let mut cmd = Command::new(&cargo);
    cmd.current_dir(&config.root)
        .env("CARGO_TARGET_DIR", &target)
        .args(["build", "--locked", "--release", "--manifest-path"])
        .arg(config.root.join("native-rs/Cargo.toml"))
        .arg("--bins");
    run_status(cmd, "native cargo build")?;
    for (binary, key) in [
        ("mcpbrowserctl", "tools.controlBinary"),
        ("mcpbrowser-session", "tools.nativeSession"),
        ("mcpbrowser-cua-native-desktop", "tools.nativeDesktop"),
        ("mcpbrowser-cua-native-worker", "tools.nativeWorker"),
        ("mcpbrowser-wayland-pointer", "tools.nativePointer"),
        ("mcpbrowser-cua-native-live", "tools.nativeLive"),
    ] {
        let dst = PathBuf::from(get_string(&config.value, key)?);
        if dst.as_os_str().is_empty() {
            bail!("{key} must be a path for native-build")
        }
        copy_executable(&target.join("release").join(binary), &dst)?;
    }
    native_input_build(config)?;
    println!("native Rust binaries and input helper built into configured tool paths");
    Ok(())
}

fn native_input_build(config: &LoadedConfig) -> Result<()> {
    let cc = ensure_executable(config, "tools.cc")?;
    let pkg = ensure_executable(config, "tools.pkgConfig")?;
    let flags = run_output(
        {
            let mut c = Command::new(pkg);
            c.args(["--cflags", "--libs", "xkbcommon"]);
            c
        },
        "pkg-config xkbcommon",
    )?;
    let dst = PathBuf::from(get_string(&config.value, "tools.nativeInput")?);
    if !dst.is_absolute() {
        bail!("tools.nativeInput must be a configured path, not a bare executable name")
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = dst.with_extension(format!("new-{}", std::process::id()));
    let mut cmd = Command::new(cc);
    cmd.current_dir(&config.root)
        .args(["-O2", "-Wall", "-Wextra"])
        .arg(config.root.join("native/cua_input.c"))
        .arg("-o")
        .arg(&tmp);
    for flag in flags.split_whitespace() {
        cmd.arg(flag);
    }
    run_status(cmd, "compile native input helper")?;
    let mut permissions = fs::metadata(&tmp)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&tmp, permissions)?;
    fs::rename(tmp, dst)?;
    Ok(())
}

fn native_rpc(config: &LoadedConfig, method: &str, args: Value) -> Result<Value> {
    let socket = get_string(&config.value, "native.socketPath")?;
    let mut stream =
        UnixStream::connect(&socket).with_context(|| format!("connect Native RPC {socket}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    let request = json!({"method": method, "args": args});
    stream.write_all(serde_json::to_string(&request)?.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    let reply: Value = serde_json::from_str(&line).context("parse Native RPC reply")?;
    if !reply.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let message = reply
            .get("error")
            .and_then(|x| x.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Native request failed");
        bail!("{message}")
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

fn string_array(config: &Value, key: &str) -> Result<Vec<String>> {
    let xs = get(config, key)
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("{key} must be an array"))?;
    xs.iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| anyhow!("{key} must contain strings"))
        })
        .collect()
}

fn native_browser_debug_port(config: &LoadedConfig) -> Result<Option<u16>> {
    let profile = PathBuf::from(get_string(&config.value, "nativeBrowser.profilesDir")?).join(
        get_string(&config.value, "nativeBrowser.browser.profileName")?,
    );
    let marker = format!("--user-data-dir={}", profile.display());
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        if !entry
            .file_name()
            .to_string_lossy()
            .chars()
            .all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let cmdline = match fs::read(entry.path().join("cmdline")) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let text = String::from_utf8_lossy(&cmdline).replace('\0', " ");
        if !text.contains(&marker) {
            continue;
        }
        for part in text.split_whitespace() {
            if let Some(raw) = part.strip_prefix("--remote-debugging-port=") {
                if let Ok(port) = raw.parse::<u16>() {
                    return Ok(Some(port));
                }
            }
        }
    }
    Ok(None)
}

fn sync_native_profile(config: &LoadedConfig) -> Result<()> {
    let source = PathBuf::from(get_string(&config.value, "profilesDir")?)
        .join(get_string(&config.value, "browser.profileName")?);
    let target = PathBuf::from(get_string(&config.value, "nativeBrowser.profilesDir")?).join(
        get_string(&config.value, "nativeBrowser.browser.profileName")?,
    );
    if source.canonicalize().ok() == target.canonicalize().ok() {
        bail!("Native Chrome must not share Browser user-data-dir directly")
    }
    if !source.is_dir() {
        bail!("Browser profile does not exist: {}", source.display())
    }
    fs::create_dir_all(&target)?;
    let rsync = ensure_executable(config, "tools.rsync")?;
    let excludes = [
        "Singleton*",
        "DevToolsActivePort",
        ".com.google.Chrome.*",
        "BrowserMetrics*",
        "Crashpad/",
        "GPUPersistentCache/",
        "component_crx_cache/",
        "extensions_crx_cache/",
        "optimization_guide_model_store/",
        "Safe Browsing/",
        "Default/Cache/",
        "Default/Code Cache/",
        "Default/GPUCache/",
        "Default/DawnGraphiteCache/",
        "Default/DawnWebGPUCache/",
        "Default/GrShaderCache/",
        "Default/ShaderCache/",
        "Default/Sessions/",
        "Default/Sessions_Encrypted/",
    ];
    let mut cmd = Command::new(rsync);
    cmd.args(["-a", "--delete", "--delete-excluded"]);
    for pattern in excludes {
        cmd.arg("--exclude").arg(pattern);
    }
    cmd.arg(format!("{}/", source.display()))
        .arg(format!("{}/", target.display()));
    run_status(cmd, "sync Native Chrome profile")?;
    for name in [
        "SingletonCookie",
        "SingletonLock",
        "SingletonSocket",
        "DevToolsActivePort",
    ] {
        let _ = fs::remove_file(target.join(name));
    }
    Ok(())
}

fn native_launch_app(config: &LoadedConfig, app: String, mut args: Vec<String>) -> Result<()> {
    let launcher = string_array(&config.value, "nativeShell.launcher")?;
    let (app, args) = if launcher.is_empty() {
        (app, args)
    } else {
        let mut wrapped = launcher[1..].to_vec();
        wrapped.push(app);
        wrapped.append(&mut args);
        (launcher[0].clone(), wrapped)
    };
    native_rpc(
        config,
        "launch_app",
        json!({"app": app, "args": args, "options": {"backend": "wayland"}}),
    )?;
    Ok(())
}

fn native_app(config: &LoadedConfig, name: &str) -> Result<()> {
    match name {
        "terminal" => native_launch_app(
            config,
            get_string(&config.value, "nativeShell.terminal")?,
            string_array(&config.value, "nativeShell.terminalArgs")?,
        ),
        "files" => native_launch_app(
            config,
            get_string(&config.value, "nativeShell.fileManager")?,
            string_array(&config.value, "nativeShell.fileManagerArgs")?,
        ),
        "browser" => {
            if let Some(port) = native_browser_debug_port(config)? {
                let node = ensure_executable(config, "tools.node")?;
                let viewport = get(&config.value, "nativeBrowser.browser.viewport")
                    .ok_or_else(|| anyhow!("nativeBrowser.browser.viewport missing"))?;
                let width = viewport
                    .get("width")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("native browser width missing"))?;
                let height = viewport
                    .get("height")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("native browser height missing"))?;
                let mut cmd = Command::new(node);
                cmd.arg(config.root.join("src/native/browser-window.mjs"))
                    .arg(port.to_string())
                    .arg(width.to_string())
                    .arg(height.to_string());
                run_status(cmd, "open Native Chrome window")
            } else {
                sync_native_profile(config)?;
                native_launch_app(
                    config,
                    get_string(&config.value, "tools.node")?,
                    vec![
                        config
                            .root
                            .join("src/native/browser.mjs")
                            .display()
                            .to_string(),
                    ],
                )
            }
        }
        _ => bail!("native-app must be browser|files|terminal"),
    }
}

fn systemd_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

fn deploy(config: &LoadedConfig, destination: &Path) -> Result<Vec<PathBuf>> {
    fs::create_dir_all(destination)?;
    let exe = PathBuf::from(get_string(&config.value, "deployment.controlBinary")?);
    let Some(cfg) = &config.config_path else {
        bail!("deployment requires an explicit YAML/JSON configuration")
    };
    let units = get(&config.value, "deployment.units")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("deployment.units must be a mapping"))?;
    let user = get_string(&config.value, "deployment.user")?;
    let group = get_string(&config.value, "deployment.group")?;
    let root = get_string(&config.value, "rootDir")?;
    let common = format!(
        "User={user}\nGroup={group}\nWorkingDirectory={}\nEnvironment={}\nEnvironment={}\nUMask=0077\n",
        root,
        systemd_quote(&format!("MCPBROWSER_ROOT={root}")),
        systemd_quote(&format!("CUA_CONFIG={}", cfg.display())),
    );
    let command = |args: &[&str]| -> String {
        let mut all = vec![systemd_quote(&exe.display().to_string())];
        all.extend(args.iter().map(|x| systemd_quote(x)));
        all.join(" ")
    };
    let mut rendered = Vec::new();
    let desktop_name = units
        .get("desktop")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("deployment.units.desktop missing"))?;
    let socket_name = units
        .get("socket")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("deployment.units.socket missing"))?;
    let worker_name = units
        .get("worker")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("deployment.units.worker missing"))?;
    let daemon_name = units
        .get("daemon")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("deployment.units.daemon missing"))?;
    let live_name = units
        .get("live")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("deployment.units.live missing"))?;
    let audio_name = units.get("audio").and_then(Value::as_str);
    let cfg_s = cfg.display().to_string();
    let socket_path = get_string(&config.value, "native.socketPath")?;
    let daemon = format!(
        "[Unit]\nDescription=CUA browser and authenticated HTTP MCP service\nAfter=network.target\n\n[Service]\nType=exec\n{common}ExecStart={}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n",
        command(&["serve", "--config", &cfg_s])
    );
    let desktop_audio_dependencies = audio_name
        .map(|name| format!("Wants={name}\nAfter=network.target {name}\n"))
        .unwrap_or_else(|| "After=network.target\n".to_string());
    let desktop = format!(
        "[Unit]\nDescription=MCPBrowser native desktop\n{desktop_audio_dependencies}\n[Service]\nType=notify\nNotifyAccess=main\n{common}ExecStart={}\nRestart=on-failure\nRestartSec=2\nTimeoutStartSec=35\nKillMode=control-group\n\n[Install]\nWantedBy=multi-user.target\n",
        command(&["native-run", "desktop", "--config", &cfg_s])
    );
    let socket = format!(
        "[Unit]\nDescription=MCPBrowser persistent native RPC socket\n\n[Socket]\nListenStream={socket_path}\nSocketUser={user}\nSocketGroup={group}\nSocketMode=0600\nDirectoryMode=0700\nAccept=no\nService={worker_name}\nRemoveOnStop=yes\n\n[Install]\nWantedBy=sockets.target\n"
    );
    let worker = format!(
        "[Unit]\nDescription=MCPBrowser persistent native computer-use backend\nWants={desktop_name}\nBindsTo={socket_name}\nAfter={desktop_name} {socket_name}\n\n[Service]\nType=exec\n{common}Sockets={socket_name}\nExecStart={}\nRestart=on-failure\nRestartSec=250ms\nKillMode=control-group\n\n[Install]\nWantedBy=multi-user.target\n",
        command(&["native-run", "worker", "--config", &cfg_s])
    );
    let live = format!(
        "[Unit]\nDescription=MCPBrowser Native Live remote desktop\nWants={desktop_name}\nAfter=network.target {desktop_name}\n\n[Service]\nType=exec\n{common}ExecStart={}\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\n\n[Install]\nWantedBy=multi-user.target\n",
        command(&["native-run", "live", "--config", &cfg_s])
    );
    for (name, body) in [
        (daemon_name, daemon),
        (desktop_name, desktop),
        (socket_name, socket),
        (worker_name, worker),
        (live_name, live),
    ] {
        let path = destination.join(name);
        write_atomic(&path, body.as_bytes(), 0o644)?;
        rendered.push(path);
    }
    if get_bool(&config.value, "nativePlasma.enabled")? {
        let plasma_data = destination.join("plasma-data");
        let apps = plasma_data.join("applications");
        fs::create_dir_all(&apps)?;
        let cfg_s = cfg.display().to_string();

        let browser_exec = PathBuf::from(get_string(&config.value, "browser.executablePath")?);
        if let Some(parent) = browser_exec.parent() {
            let icon = parent.join("product_logo_128.png");
            if icon.is_file() {
                let icon_dir = plasma_data.join("icons/hicolor/128x128/apps");
                fs::create_dir_all(&icon_dir)?;
                fs::copy(icon, icon_dir.join("google-chrome.png"))?;
            }
        }
        let exec = format!("{} native-app browser --config {}", exe.display(), cfg_s);
        let browser_desktop = format!(
            "[Desktop Entry]\nType=Application\nName=Google Chrome\nExec={exec}\nIcon=google-chrome\nStartupWMClass=google-chrome\nTerminal=false\nCategories=Network;WebBrowser;\n"
        );
        write_atomic(
            &apps.join("google-chrome.desktop"),
            browser_desktop.as_bytes(),
            0o644,
        )?;

        for (role, title, icon) in [
            ("files", "Files", "system-file-manager"),
            ("terminal", "Terminal", "utilities-terminal"),
        ] {
            let exec = format!("{} native-app {} --config {}", exe.display(), role, cfg_s);
            let desktop = format!(
                "[Desktop Entry]\nType=Application\nName={title}\nExec={exec}\nIcon={icon}\nTerminal=false\nCategories=System;\n"
            );
            write_atomic(
                &apps.join(format!("mcpbrowser-{role}.desktop")),
                desktop.as_bytes(),
                0o644,
            )?;
        }

        let theme_source = config
            .root
            .join("native-shell/plasma-theme/mcpbrowser-black");
        let theme_destination = plasma_data.join("plasma/desktoptheme/mcpbrowser-black");
        copy_dir(&theme_source, &theme_destination)?;
        let color_dir = plasma_data.join("color-schemes");
        fs::create_dir_all(&color_dir)?;
        fs::copy(
            theme_source.join("colors"),
            color_dir.join("MCPBrowserBlack.colors"),
        )?;
    }

    let origin = get_string(&config.value, "gui.publicOrigin")?;
    let base = get_string(&config.value, "gui.basePath")?;
    let port = get_u64(&config.value, "gui.port")?;
    let host = get_string(&config.value, "gui.host")?;
    let origin = if origin.is_empty() {
        format!(
            "http://{}:{}",
            if host == "0.0.0.0" {
                "localhost"
            } else {
                &host
            },
            port
        )
    } else {
        origin
    };
    write_atomic(
        &destination.join("codex-http.toml"),
        format!(
            "[mcp_servers.cua_repl]\nurl = {:?}\nbearer_token_env_var = \"CUA_MCP_TOKEN\"\n",
            format!("{origin}{base}/mcp")
        )
        .as_bytes(),
        0o600,
    )?;
    Ok(rendered)
}

fn native_install(config: &LoadedConfig, apply: bool, start: bool) -> Result<()> {
    let stage = PathBuf::from(get_string(&config.value, "artifactsDir")?).join("deployment");
    let files = deploy(config, &stage)?;
    let mut selected = Vec::new();
    for file in files {
        let name = file
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or_default();
        let wanted = name == get_string(&config.value, "deployment.units.desktop")?
            || name == get_string(&config.value, "deployment.units.socket")?
            || name == get_string(&config.value, "deployment.units.worker")?
            || (get_bool(&config.value, "nativeLive.enabled")?
                && name == get_string(&config.value, "deployment.units.live")?);
        if wanted {
            selected.push(file);
        }
    }
    if !apply {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"installed": false, "stage": stage, "units": selected})
            )?
        );
        return Ok(());
    }
    if unsafe { libc::geteuid() } != 0 {
        bail!("native unit installation requires root")
    }
    let units_dir = PathBuf::from(get_string(&config.value, "deployment.unitsDir")?);
    fs::create_dir_all(&units_dir)?;
    let control_source = PathBuf::from(get_string(&config.value, "tools.controlBinary")?);
    let control_target = PathBuf::from(get_string(&config.value, "deployment.controlBinary")?);
    if control_source.is_file() {
        copy_executable(&control_source, &control_target)?;
    } else {
        copy_executable(&env::current_exe()?, &control_target)?;
    }
    for file in &selected {
        let Some(name) = file.file_name() else {
            continue;
        };
        let dst = units_dir.join(name);
        write_atomic(&dst, &fs::read(file)?, 0o644)?;
    }
    if get_bool(&config.value, "nativePlasma.enabled")? {
        let generated = stage.join("plasma-data");
        if generated.is_dir() {
            let destination = PathBuf::from(get_string(&config.value, "nativePlasma.dataDir")?);
            copy_dir(&generated, &destination)?;
            let legacy_browser = destination.join("applications/mcpbrowser-browser.desktop");
            if legacy_browser.is_file() {
                fs::remove_file(legacy_browser)?;
            }
        }
    }
    let systemctl = ensure_executable(config, "tools.systemctl")?;
    run_status(
        {
            let mut c = Command::new(&systemctl);
            c.arg("daemon-reload");
            c
        },
        "systemctl daemon-reload",
    )?;
    if start {
        let names: Vec<String> = selected
            .iter()
            .filter_map(|p| p.file_name().map(|x| x.to_string_lossy().to_string()))
            .collect();
        let mut c = Command::new(systemctl);
        c.args(["enable", "--now"]);
        c.args(&names);
        run_status(c, "systemctl enable --now")?;
    }
    println!(
        "native units installed{}",
        if start { " and started" } else { "" }
    );
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn extension_install(config: &LoadedConfig) -> Result<()> {
    let id = get_string(&config.value, "extension.extensionId")?;
    if id.is_empty() {
        bail!("configure extension.manifestKey with extensionId: auto, or provide extensionId")
    }
    let source = PathBuf::from(get_string(&config.value, "extension.extensionDir")?);
    let runtime = PathBuf::from(get_string(&config.value, "runtimeDir")?);
    let prepared = runtime.join("extensions").join(&id);
    if prepared.exists() {
        fs::remove_dir_all(&prepared)?;
    }
    copy_dir(&source, &prepared)?;
    let manifest_path = prepared.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let key = get_string(&config.value, "extension.manifestKey")?;
    if !key.is_empty() {
        manifest
            .as_object_mut()
            .unwrap()
            .insert("key".into(), Value::String(key));
    } else {
        manifest.as_object_mut().unwrap().remove("key");
    }
    write_atomic(
        &manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?).as_bytes(),
        0o600,
    )?;
    let host_name = get_string(&config.value, "extension.hostName")?;
    write_atomic(
        &prepared.join("deployment.js"),
        format!(
            "export const HOST = {};\n",
            serde_json::to_string(&host_name)?
        )
        .as_bytes(),
        0o600,
    )?;
    let host_dir = runtime.join("native-hosts");
    fs::create_dir_all(&host_dir)?;
    let launcher = host_dir.join(&host_name);
    if launcher.exists() {
        fs::remove_file(&launcher)?;
    }
    let control = PathBuf::from(get_string(&config.value, "tools.controlBinary")?);
    let control = if control.is_file() {
        control
    } else {
        env::current_exe()?
    };
    symlink(control, &launcher)?;
    let sidecar = PathBuf::from(format!("{}.json", launcher.display()));
    write_atomic(
        &sidecar,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "socketPath": get_string(&config.value, "extension.socketPath")?,
                "configPath": config.config_path.as_ref().map(|p| p.display().to_string()),
            }))?
        )
        .as_bytes(),
        0o600,
    )?;
    let native_manifest = json!({
        "name": host_name,
        "description": "MCPBrowser CUA Google Chrome extension bridge",
        "path": launcher,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{id}/")],
    });
    let roots = get(&config.value, "extension.nativeHostRoots")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("extension.nativeHostRoots must be an array"))?;
    for root in roots {
        let Some(root) = root.as_str() else { continue };
        let dir = PathBuf::from(root);
        fs::create_dir_all(&dir)?;
        write_atomic(
            &dir.join(format!(
                "{}.json",
                get_string(&config.value, "extension.hostName")?
            )),
            format!("{}\n", serde_json::to_string_pretty(&native_manifest)?).as_bytes(),
            0o600,
        )?;
    }
    println!("{}", prepared.display());
    Ok(())
}

fn extension_host_from_invocation(argv0: &Path) -> Result<()> {
    const MAX_FRAME: usize = 20 * 1024 * 1024;
    let sidecar = PathBuf::from(format!("{}.json", argv0.display()));
    let meta: Value = serde_json::from_slice(
        &fs::read(&sidecar).with_context(|| format!("read {}", sidecar.display()))?,
    )?;
    let socket_path = meta
        .get("socketPath")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native-host sidecar missing socketPath"))?;
    let stream =
        UnixStream::connect(socket_path).with_context(|| format!("connect {socket_path}"))?;
    let mut to_socket = stream.try_clone()?;
    let reader = thread::spawn(move || -> Result<()> {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            let mut hdr = [0u8; 4];
            match input.read_exact(&mut hdr) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(e.into()),
            }
            let len = u32::from_le_bytes(hdr) as usize;
            if len > MAX_FRAME {
                bail!("native messaging frame too large")
            }
            let mut body = vec![0u8; len];
            input.read_exact(&mut body)?;
            to_socket.write_all(&body)?;
            to_socket.write_all(b"\n")?;
            to_socket.flush()?;
        }
        let _ = to_socket.shutdown(std::net::Shutdown::Write);
        Ok(())
    });
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut lines = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = lines.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        while line.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_FRAME {
            bail!("bridge frame too large")
        }
        output.write_all(&(line.len() as u32).to_le_bytes())?;
        output.write_all(&line)?;
        output.flush()?;
    }
    reader
        .join()
        .map_err(|_| anyhow!("native host input thread panicked"))??;
    Ok(())
}

fn source_release_excluded(rel: &Path) -> bool {
    let text = rel.to_string_lossy();
    if rel.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git" | ".runtime" | "artifacts" | "node_modules" | "target")
        )
    }) {
        return true;
    }
    text.starts_with("cua.production")
        || (text.starts_with("cua.config.") && text != "cua.config.example.yaml")
}

fn collect_release_dir(root: &Path, rel: &Path, out: &mut BTreeSet<PathBuf>) -> Result<()> {
    let dir = root.join(rel);
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let child = rel.join(entry.file_name());
        if source_release_excluded(&child) {
            continue;
        }
        let ty = entry.file_type()?;
        if ty.is_dir() {
            collect_release_dir(root, &child, out)?;
        } else if ty.is_file() || ty.is_symlink() {
            out.insert(child);
        }
    }
    Ok(())
}

fn simple_star_match(name: &str, pattern: &str) -> bool {
    if !pattern.contains('*') {
        return name == pattern;
    }
    let parts = pattern.split('*').collect::<Vec<_>>();
    let mut rest = name;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if index == 0 && !pattern.starts_with('*') {
            let Some(next) = rest.strip_prefix(part) else {
                return false;
            };
            rest = next;
            continue;
        }
        if index + 1 == parts.len() && !pattern.ends_with('*') {
            return rest.ends_with(part);
        }
        let Some(pos) = rest.find(part) else {
            return false;
        };
        rest = &rest[pos + part.len()..];
    }
    true
}

fn source_release_files(root: &Path, package: &Value) -> Result<BTreeSet<PathBuf>> {
    let entries = package
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("package.json files must be an array"))?;
    let mut files = BTreeSet::new();
    for entry in entries {
        let raw = entry
            .as_str()
            .ok_or_else(|| anyhow!("package.json files entries must be strings"))?;
        if raw.ends_with('/') {
            collect_release_dir(root, Path::new(raw.trim_end_matches('/')), &mut files)?;
            continue;
        }
        if raw.contains('*') {
            let path = Path::new(raw);
            let parent = path.parent().unwrap_or_else(|| Path::new(""));
            let pattern = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| anyhow!("invalid package.json files glob {raw}"))?;
            let dir = root.join(parent);
            if dir.is_dir() {
                for item in fs::read_dir(dir)? {
                    let item = item?;
                    let name = item.file_name();
                    let Some(name) = name.to_str() else { continue };
                    let rel = parent.join(name);
                    if simple_star_match(name, pattern)
                        && !source_release_excluded(&rel)
                        && item.file_type()?.is_file()
                    {
                        files.insert(rel);
                    }
                }
            }
            continue;
        }
        let rel = PathBuf::from(raw);
        if source_release_excluded(&rel) {
            continue;
        }
        let source = root.join(&rel);
        if source.is_dir() {
            collect_release_dir(root, &rel, &mut files)?;
        } else if source.is_file() {
            files.insert(rel);
        }
    }
    for required in ["package.json", "package-lock.json", ".gitignore"] {
        let rel = PathBuf::from(required);
        if root.join(&rel).is_file() {
            files.insert(rel);
        }
    }
    Ok(files)
}

fn source_release(config: &LoadedConfig, out: &Path) -> Result<PathBuf> {
    fs::create_dir_all(out)?;
    let package: Value = serde_json::from_slice(&fs::read(config.root.join("package.json"))?)?;
    let name = package
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("mcpbrowser")
        .trim_start_matches("open-cua-");
    let version = package
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.0.0");
    let stage = env::temp_dir().join(format!(
        "mcpbrowser-release-{}-{}",
        std::process::id(),
        version
    ));
    let package_root = stage.join("package");
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    fs::create_dir_all(&package_root)?;
    for rel in source_release_files(&config.root, &package)? {
        let src = config.root.join(&rel);
        if !src.is_file() {
            continue;
        }
        let dst = package_root.join(&rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    let tar = ensure_executable(config, "tools.tar")?;
    let file = out.join(format!("{name}-{version}.tar.gz"));
    let mut cmd = Command::new(tar);
    cmd.args([
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
    ])
    .arg(&file)
    .arg("-C")
    .arg(&stage)
    .arg("package");
    run_status(cmd, "source release tar")?;
    fs::remove_dir_all(stage).ok();
    println!("{}", file.display());
    Ok(file)
}

fn native_shims_build(config: &LoadedConfig) -> Result<()> {
    let target = get_string(&config.value, "nativePlasma.refreshShim")?;
    if target.is_empty() {
        println!("nativePlasma.refreshShim is empty; no optional shim to build");
        return Ok(());
    }
    let cxx = ensure_executable(config, "tools.cxx")?;
    let pkg = ensure_executable(config, "tools.pkgConfig")?;
    let flags = run_output(
        {
            let mut c = Command::new(pkg);
            c.args(["--cflags", "--libs", "wayland-client"]);
            c
        },
        "pkg-config wayland-client",
    )?;
    let target = PathBuf::from(target);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension(format!("new-{}", std::process::id()));
    let mut cmd = Command::new(cxx);
    cmd.current_dir(&config.root)
        .args(["-O2", "-fPIC", "-shared"])
        .arg(
            config
                .root
                .join("native-shell/kwin-nested-refresh-shim.cpp"),
        )
        .arg("-ldl");
    for flag in flags.split_whitespace() {
        cmd.arg(flag);
    }
    cmd.arg("-o").arg(&tmp);
    run_status(cmd, "build KWin refresh shim")?;
    let mut permissions = fs::metadata(&tmp)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&tmp, permissions)?;
    fs::rename(&tmp, &target)?;
    println!("{}", target.display());
    Ok(())
}

fn prepare_wlroots(config: &LoadedConfig, source: &Path, build: Option<&Path>) -> Result<()> {
    let source = source
        .canonicalize()
        .with_context(|| format!("resolve wlroots source {}", source.display()))?;
    let export = source.join("types/wlr_export_dmabuf_v1.c");
    let meson = source.join("protocol/meson.build");
    let mut code =
        fs::read_to_string(&export).with_context(|| format!("read {}", export.display()))?;
    let mut build_text =
        fs::read_to_string(&meson).with_context(|| format!("read {}", meson.display()))?;
    let include = "#include \"mcpbrowser_dmabuf_capture_v1.c\"";
    let registration = "mcpbrowser_dmabuf_capture_create(display);";
    if !code.contains(include) {
        let anchor = "#define EXPORT_DMABUF_MANAGER_VERSION 1";
        if code.matches(anchor).count() != 1 {
            bail!("unsupported wlroots export manager: include anchor not unique")
        }
        code = code.replacen(anchor, &format!("{include}\n\n{anchor}"), 1);
    }
    if !code.contains(registration) {
        let anchor = "wl_list_init(&manager->frames);";
        if code.matches(anchor).count() != 1 {
            bail!("unsupported wlroots export manager: registration anchor not unique")
        }
        code = code.replacen(anchor, &format!("{anchor}\n\t{registration}"), 1);
    }
    let entry = "'mcpbrowser-dmabuf-capture-v1': 'mcpbrowser-dmabuf-capture-v1.xml',";
    if !build_text.contains(entry) {
        let anchor = "protocols = {";
        if build_text.matches(anchor).count() != 1 {
            bail!("unsupported wlroots protocol build table")
        }
        build_text = build_text.replacen(anchor, &format!("{anchor}\n\t{entry}"), 1);
    }
    fs::write(&export, code)?;
    fs::write(&meson, build_text)?;
    fs::copy(
        config.root.join("native-shell/dmabuf-capture/bridge.c"),
        source.join("types/mcpbrowser_dmabuf_capture_v1.c"),
    )?;
    fs::copy(
        config
            .root
            .join("native-shell/dmabuf-capture/mcpbrowser-dmabuf-capture-v1.xml"),
        source.join("protocol/mcpbrowser-dmabuf-capture-v1.xml"),
    )?;
    if let Some(build) = build {
        let ninja = ensure_executable(config, "tools.ninja")?;
        let build = build
            .canonicalize()
            .with_context(|| format!("resolve build directory {}", build.display()))?;
        let mut cmd = Command::new(ninja);
        cmd.arg("-C").arg(build);
        run_status(cmd, "ninja wlroots")?;
    }
    println!(
        "DMA-BUF lease protocol source prepared: {}",
        source.display()
    );
    Ok(())
}

fn maybe_extension_host(args: &[String]) -> Result<bool> {
    if args.len() >= 2 && args[1].starts_with("chrome-extension://") {
        extension_host_from_invocation(Path::new(&args[0]))?;
        return Ok(true);
    }
    Ok(false)
}

fn main() -> Result<()> {
    let raw: Vec<String> = env::args().collect();
    if maybe_extension_host(&raw)? {
        return Ok(());
    }
    let mut args = raw.into_iter().skip(1).collect::<Vec<_>>();
    let command = if args.is_empty() {
        "help".to_string()
    } else {
        args.remove(0)
    };
    let cfg = config_arg(&args)?;
    let clean = strip_config(&args)?;
    match command.as_str() {
        "help" | "--help" | "-h" => println!("{}", usage()),
        "version" | "--version" | "-v" => {
            let root = discover_root()?;
            let pkg: Value = serde_json::from_slice(&fs::read(root.join("package.json"))?)?;
            println!(
                "mcpbrowserctl {}",
                pkg.get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
        }
        "check" => {
            let _ = loaded(&args)?;
            println!("YAML configuration valid");
        }
        "json" => {
            let c = loaded(&args)?;
            println!("{}", serde_json::to_string_pretty(&c.value)?);
        }
        "get" => {
            let c = loaded(&args)?;
            let key = clean
                .first()
                .ok_or_else(|| anyhow!("get requires dotted.key"))?;
            let value = get(&c.value, key).ok_or_else(|| anyhow!("unknown key {key}"))?;
            println!("{}", value_to_text(value)?);
        }
        "env" => {
            let c = loaded(&args)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&native_environment(&c)?)?
            );
        }
        "doctor" => {
            let c = loaded(&args)?;
            if !doctor(&c)? {
                std::process::exit(1);
            }
        }
        "url" => {
            let c = loaded(&args)?;
            println!("{}", gui_url(&c)?);
        }
        "serve" => {
            let c = loaded(&args)?;
            exec_node_runtime(&c, true)?;
        }
        "mcp" => {
            let c = loaded(&args)?;
            exec_node_runtime(&c, false)?;
        }
        "service-start" => {
            let c = loaded(&args)?;
            service_start(&c)?;
        }
        "service-stop" => {
            let c = loaded(&args)?;
            service_stop(&c)?;
        }
        "display-start" => {
            let c = loaded(&args)?;
            display_start(&c)?;
        }
        "native-build" => {
            let c = loaded(&args)?;
            native_build(&c)?;
        }
        "native-input-build" => {
            let c = loaded(&args)?;
            native_input_build(&c)?;
        }
        "native-run" => {
            let role = clean
                .first()
                .ok_or_else(|| anyhow!("native-run requires a role"))?;
            let c = loaded(&args)?;
            native_run(&c, role, &clean[1..])?;
        }
        "native-app" => {
            let name = clean
                .first()
                .ok_or_else(|| anyhow!("native-app requires browser|files|terminal"))?;
            let c = loaded(&args)?;
            native_app(&c, name)?;
        }
        "deploy" => {
            let c = loaded(&args)?;
            let out = if let Some(i) = clean.iter().position(|x| x == "--out") {
                PathBuf::from(
                    clean
                        .get(i + 1)
                        .ok_or_else(|| anyhow!("--out requires a directory"))?,
                )
            } else {
                PathBuf::from(get_string(&c.value, "artifactsDir")?).join("deployment")
            };
            let files = deploy(&c, &out)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({"destination": out, "files": files}))?
            );
        }
        "native-install" => {
            let c = loaded(&args)?;
            native_install(
                &c,
                clean.iter().any(|x| x == "--apply"),
                clean.iter().any(|x| x == "--start"),
            )?;
        }
        "extension-install" => {
            let c = loaded(&args)?;
            extension_install(&c)?;
        }
        "native-shims-build" => {
            let c = loaded(&args)?;
            native_shims_build(&c)?;
        }
        "prepare-wlroots" => {
            let source = clean
                .first()
                .ok_or_else(|| anyhow!("prepare-wlroots requires a source tree"))?;
            let build = clean
                .iter()
                .position(|x| x == "--build")
                .map(|i| {
                    clean
                        .get(i + 1)
                        .ok_or_else(|| anyhow!("--build requires a directory"))
                })
                .transpose()?;
            let c = loaded(&args)?;
            prepare_wlroots(&c, Path::new(source), build.map(Path::new))?;
        }
        "source-release" => {
            let c = loaded(&args)?;
            let out = if let Some(i) = clean.iter().position(|x| x == "--out") {
                PathBuf::from(
                    clean
                        .get(i + 1)
                        .ok_or_else(|| anyhow!("--out requires a directory"))?,
                )
            } else {
                PathBuf::from(get_string(&c.value, "artifactsDir")?).join("release")
            };
            source_release(&c, &out)?;
        }
        "package" | "package-native" => {
            let root = discover_root()?;
            let value = |flag: &str, default: Option<String>| -> Result<String> {
                if let Some(i) = clean.iter().position(|x| x == flag) {
                    return clean
                        .get(i + 1)
                        .cloned()
                        .ok_or_else(|| anyhow!("{flag} requires a value"));
                }
                default.ok_or_else(|| anyhow!("{flag} is required"))
            };
            let host_arch = match env::consts::ARCH {
                "x86_64" => "x64",
                "aarch64" => "arm64",
                other => bail!("unsupported host architecture {other}"),
            };
            let options = mcpbrowser_control::package::PackageOptions {
                format: value(
                    "--format",
                    Some(if command == "package" {
                        "all".into()
                    } else {
                        String::new()
                    }),
                )?,
                arch: value("--arch", Some(host_arch.into()))?,
                out: PathBuf::from(value(
                    "--out",
                    Some(root.join("artifacts/packages").display().to_string()),
                )?),
                cache: PathBuf::from(value(
                    "--cache",
                    Some(root.join("artifacts/package-cache").display().to_string()),
                )?),
                offline: clean.iter().any(|x| x == "--offline"),
                deb_container: clean.iter().any(|x| x == "--deb-container"),
                config: cfg.clone(),
            };
            if command == "package-native" && options.format.is_empty() {
                bail!("package-native requires --format rpm|deb");
            }
            let result = if command == "package" {
                mcpbrowser_control::package::package_main(&root, options)?
            } else {
                mcpbrowser_control::package::package_native(&root, options)?
            };
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        other => bail!("unknown command {other:?}\n{}", usage()),
    }
    let _ = cfg;
    Ok(())
}
