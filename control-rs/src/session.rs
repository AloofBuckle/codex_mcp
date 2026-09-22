use anyhow::{Context, Result, anyhow, bail};
use mcpbrowser_control::{discover_root, get_bool, get_string, load_config, write_atomic};
use serde_json::json;
use std::{
    collections::BTreeMap,
    env, fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};

fn selected_config() -> Option<PathBuf> {
    env::var("CUA_CONFIG")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn command_ok(program: &str, args: &[&str], envs: &BTreeMap<String, String>) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .envs(envs)
        .status()
        .with_context(|| format!("run {program}"))?;
    if !status.success() {
        bail!("{program} exited with {status}")
    }
    Ok(())
}

fn configure_plasma(config: &serde_json::Value, envs: &BTreeMap<String, String>) -> Result<()> {
    let kwrite = get_string(config, "tools.kwriteconfig")?;
    for args in [
        vec![
            "--file",
            "kdeglobals",
            "--group",
            "General",
            "--key",
            "ColorScheme",
            "BreezeDark",
        ],
        vec![
            "--file",
            "kdeglobals",
            "--group",
            "KDE",
            "--key",
            "widgetStyle",
            "Breeze",
        ],
        vec![
            "--file",
            "kdeglobals",
            "--group",
            "Icons",
            "--key",
            "Theme",
            "breeze-dark",
        ],
        vec![
            "--file",
            "kwinrc",
            "--group",
            "Windows",
            "--key",
            "Placement",
            "Centered",
        ],
        vec![
            "--file",
            "kscreenlockerrc",
            "--group",
            "Daemon",
            "--key",
            "Autolock",
            "--type",
            "bool",
            "false",
        ],
        vec![
            "--file",
            "kscreenlockerrc",
            "--group",
            "Daemon",
            "--key",
            "LockOnResume",
            "--type",
            "bool",
            "false",
        ],
    ] {
        command_ok(&kwrite, &args, envs)?;
    }
    for action in ["suspend", "hibernate", "reboot", "shutdown"] {
        command_ok(
            &kwrite,
            &[
                "--file",
                "kdeglobals",
                "--group",
                "KDE Action Restrictions",
                "--key",
                action,
                "--type",
                "bool",
                "false",
            ],
            envs,
        )?;
    }
    Ok(())
}

fn publish_environment(config: &serde_json::Value, envs: &BTreeMap<String, String>) -> Result<()> {
    let file = PathBuf::from(get_string(config, "nativePlasma.environmentFile")?);
    let mut exported = BTreeMap::new();
    for key in [
        "XDG_RUNTIME_DIR",
        "WAYLAND_DISPLAY",
        "DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "PULSE_SERVER",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
        "KDE_FULL_SESSION",
        "KDE_SESSION_VERSION",
        "QT_QPA_PLATFORM",
    ] {
        if let Some(value) = envs.get(key) {
            exported.insert(key.to_string(), value.clone());
        }
    }
    write_atomic(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({"env": exported}))?
        )
        .as_bytes(),
        0o600,
    )
}

fn link_audio(config: &serde_json::Value, envs: &BTreeMap<String, String>) -> Result<()> {
    let audio = get_string(config, "nativePlasma.audioRuntimeDir")?;
    if audio.is_empty() {
        return Ok(());
    }
    let run = envs
        .get("MCPBROWSER_NATIVE_RUN")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("MCPBROWSER_NATIVE_RUN is missing"))?;
    for name in ["pipewire-0", "pipewire-0-manager"] {
        let source = Path::new(&audio).join(name);
        if source.exists() {
            let target = run.join(name);
            let _ = fs::remove_file(&target);
            symlink(source, target)?;
        }
    }
    Ok(())
}

fn wait_parent_or_child(mut child: Option<Child>) -> Result<()> {
    let original_parent = unsafe { libc::getppid() };
    loop {
        if let Some(c) = child.as_mut() {
            if let Some(status) = c.try_wait()? {
                if status.success() {
                    return Ok(());
                }
                bail!("Plasma shell exited with {status}")
            }
        }
        let parent = unsafe { libc::getppid() };
        if parent <= 1 || parent != original_parent {
            if let Some(c) = child.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn main() -> Result<()> {
    let root = discover_root()?;
    let config = load_config(&root, selected_config().as_deref())?;
    let mut envs: BTreeMap<String, String> = env::vars().collect();
    envs.insert("XDG_CURRENT_DESKTOP".into(), "KDE".into());
    envs.insert("XDG_SESSION_DESKTOP".into(), "KDE".into());
    envs.insert("DESKTOP_SESSION".into(), "plasma".into());
    envs.insert("KDE_FULL_SESSION".into(), "true".into());
    envs.insert("KDE_SESSION_VERSION".into(), "6".into());
    envs.insert("QT_QPA_PLATFORM".into(), "wayland".into());

    for key in [
        "nativePlasma.configDir",
        "nativePlasma.dataDir",
        "nativePlasma.cacheDir",
    ] {
        let path = PathBuf::from(get_string(&config.value, key)?);
        fs::create_dir_all(path)?;
    }
    if let Some(home) = envs.get("HOME") {
        fs::create_dir_all(Path::new(home).join("Downloads"))?;
    }
    link_audio(&config.value, &envs)?;
    publish_environment(&config.value, &envs)?;

    if !get_bool(&config.value, "nativePlasma.enabled")? {
        return wait_parent_or_child(None);
    }
    configure_plasma(&config.value, &envs)?;
    let plasmashell = get_string(&config.value, "tools.plasmashell")?;
    let child = Command::new(&plasmashell)
        .env_clear()
        .envs(&envs)
        .stdin(Stdio::null())
        .spawn()
        .with_context(|| format!("start {plasmashell}"))?;
    wait_parent_or_child(Some(child))
}
