use atspi::proxy::accessible::{AccessibleProxy, ObjectRefExt};
use atspi::proxy::proxy_ext::ProxyExt;
use atspi::{AccessibilityConnection, CoordType, Interface, State};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use fs2::FileExt;
use mcpbrowser_native_cua::settings::{setting, tool};
use mcpbrowser_native_cua::{DesktopInfo, app_prefix, desktop_unit, read_desktop_info, run_dir};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as TokioBufReader,
};
use tokio::net::{UnixListener as TokioUnixListener, UnixStream as TokioUnixStream};
use tokio::time::timeout;
use uuid::Uuid;
use zbus::names::BusName;

const MAX_NODES: usize = 1200;
const MAX_REQUEST: usize = 4 * 1024 * 1024;

#[derive(Debug)]
struct NativeError {
    code: &'static str,
    message: String,
}

type NResult<T> = Result<T, NativeError>;

impl NativeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn fail<T>(code: &'static str, message: impl Into<String>) -> NResult<T> {
    Err(NativeError::new(code, message))
}

fn env_error(error: impl std::fmt::Display) -> NativeError {
    NativeError::new("environment", error.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PublicWindow {
    app: String,
    id: u64,
    title: String,
}

#[derive(Debug, Clone)]
struct Window {
    public: PublicWindow,
    native_id: String,
    pid: u32,
    start: String,
    bounds: Rect,
    focused: bool,
    alias: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppInfo {
    id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "isRunning")]
    is_running: bool,
    windows: Vec<PublicWindow>,
}

#[derive(Debug, Clone)]
struct DesktopEntry {
    id: String,
    name: String,
    exec: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Screenshot {
    id: String,
    url: String,
    width: u32,
    height: u32,
    #[serde(rename = "originX")]
    origin_x: f64,
    #[serde(rename = "originY")]
    origin_y: f64,
    #[serde(rename = "zIndex")]
    z_index: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccessibilityState {
    tree: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    focused_element: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_elements: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowState {
    accessibility: Option<AccessibilityState>,
    screenshots: Vec<Screenshot>,
    window: PublicWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct AxNode {
    index: usize,
    path: Vec<usize>,
    depth: usize,
    role: String,
    name: String,
    description: String,
    identifier: String,
    value: Option<Value>,
    editable: bool,
    focused: bool,
    selected: bool,
    selectable: bool,
    enabled: bool,
    expanded: bool,
    expandable: bool,
    placeholder: String,
    actions: Vec<String>,
    frame: Option<Rect>,
    selected_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Observation {
    epoch: String,
    window: PublicWindow,
    pid: u32,
    start: String,
    fingerprint: String,
    nodes: Vec<AxNode>,
    #[serde(rename = "createdAt")]
    created_at: f64,
}

#[derive(Debug, Clone)]
struct AxObject {
    reference: atspi::ObjectRefOwned,
}

#[derive(Debug)]
struct Desktop {
    info: DesktopInfo,
    env: HashMap<String, String>,
    epoch_number: u64,
}

impl Desktop {
    fn new() -> NResult<Self> {
        let info = read_desktop_info().map_err(|_| {
            NativeError::new(
                "unavailable",
                "The system-owned native desktop is not ready",
            )
        })?;
        let mut env: HashMap<String, String> = std::env::vars().collect();
        for (k, v) in &info.env {
            env.insert(k.clone(), v.clone());
        }
        for key in [
            "CUA_INJECT_SOCKET",
            "MCPBROWSER_CUA_INPUT_SOCKET",
            "CUA_WAYLAND_NEST",
            "XAUTHORITY",
        ] {
            env.remove(key);
        }
        let digest = Sha256::digest(info.epoch.as_bytes());
        let epoch_number =
            ((digest[0] as u64) << 16) | ((digest[1] as u64) << 8) | digest[2] as u64;
        Ok(Self {
            info,
            env,
            epoch_number,
        })
    }

    fn kwin_call(&self, method: &str, args: &[&str]) -> NResult<String> {
        let mut command = Command::new(tool("qdbus"));
        command
            .env_clear()
            .envs(&self.env)
            .arg("org.kde.KWin")
            .arg("/KWin")
            .arg(format!("org.kde.KWin.{method}"))
            .args(args);
        let output = command.output().map_err(env_error)?;
        if !output.status.success() {
            return fail(
                "environment",
                format!(
                    "KWin D-Bus {method} failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn windows(&self) -> NResult<Vec<Window>> {
        let raw = self.kwin_call("mwsListWindowsJson", &[])?;
        let values: Vec<Value> = serde_json::from_str(&raw).map_err(env_error)?;
        let mut found = Vec::new();
        for node in values {
            // Desktop/panel surfaces are KWin clients too, but they are not
            // user-addressable application windows.
            if node.get("resourceClass").and_then(Value::as_str) == Some("plasmashell")
                && node.get("skipTaskbar").and_then(Value::as_bool) == Some(true)
            {
                continue;
            }
            let Some(pid) = node.get("pid").and_then(Value::as_u64).filter(|v| *v > 0) else {
                continue;
            };
            let pid = pid as u32;
            let Some(start) = proc_start(pid) else {
                continue;
            };
            let Some(uuid) = node
                .get("uuid")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
            else {
                continue;
            };
            let alias = ["desktopFile", "resourceClass", "resourceName"]
                .into_iter()
                .find_map(|key| {
                    node.get(key)
                        .and_then(Value::as_str)
                        .filter(|v| !v.is_empty())
                })
                .unwrap_or("")
                .to_string();
            let unit = managed_unit(pid);
            let app = unit
                .as_deref()
                .map(|u| u.strip_suffix(".service").unwrap_or(u).to_string())
                .unwrap_or_else(|| {
                    if alias.is_empty() {
                        format!("pid:{pid}:{start}")
                    } else {
                        alias.clone()
                    }
                });
            let digest = Sha256::digest(uuid.as_bytes());
            let token = u32::from_be_bytes(digest[..4].try_into().unwrap()) & 0x0fff_ffff;
            let id = self
                .epoch_number
                .saturating_mul(1u64 << 28)
                .saturating_add(token as u64);
            found.push(Window {
                public: PublicWindow {
                    app,
                    id,
                    title: node
                        .get("caption")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                },
                native_id: uuid.to_string(),
                pid,
                start,
                bounds: Rect {
                    x: number(node.get("x")).unwrap_or(0.0),
                    y: number(node.get("y")).unwrap_or(0.0),
                    width: number(node.get("width")).unwrap_or(0.0),
                    height: number(node.get("height")).unwrap_or(0.0),
                },
                focused: node.get("active").and_then(Value::as_bool).unwrap_or(false),
                alias,
            });
        }
        Ok(found)
    }

    fn resolve(&self, args: &Map<String, Value>) -> NResult<Window> {
        let windows = self.windows()?;
        let mut hits: Vec<Window>;
        if let Some(win) = args.get("window") {
            let Some(obj) = win.as_object() else {
                return fail("validation", "window requires app and id");
            };
            let app = obj
                .get("app")
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::new("validation", "window requires app and id"))?;
            let id = integer(obj.get("id"), "window.id", 1, (1u64 << 53) - 1)?;
            hits = windows
                .into_iter()
                .filter(|w| w.public.id == id && w.public.app == app)
                .collect();
        } else if args.contains_key("id") {
            let id = integer(args.get("id"), "id", 1, (1u64 << 53) - 1)?;
            let app = args.get("app").and_then(Value::as_str);
            hits = windows
                .into_iter()
                .filter(|w| w.public.id == id && app.is_none_or(|a| w.public.app == a))
                .collect();
        } else {
            let app = string_arg(args.get("app"), "app", 4096)?;
            hits = windows
                .iter()
                .filter(|w| app == w.public.app || app == w.alias)
                .cloned()
                .collect();
            if hits.is_empty() {
                let lower = app.to_lowercase();
                hits = windows
                    .iter()
                    .filter(|w| {
                        let exe = proc_executable(w.pid);
                        lower == w.alias.to_lowercase()
                            || lower == w.public.title.to_lowercase()
                            || lower == exe.to_lowercase()
                            || Path::new(&exe)
                                .file_name()
                                .and_then(|x| x.to_str())
                                .is_some_and(|s| lower == s.to_lowercase())
                    })
                    .cloned()
                    .collect();
            }
            if hits.is_empty() {
                let lower = app.to_lowercase();
                let ids: HashSet<String> = self
                    .apps()?
                    .into_iter()
                    .filter(|a| {
                        lower == a.id.to_lowercase() || lower == a.display_name.to_lowercase()
                    })
                    .map(|a| a.id)
                    .collect();
                hits = windows
                    .into_iter()
                    .filter(|w| ids.contains(&w.public.app))
                    .collect();
            }
            if hits.len() > 1 {
                let active: Vec<_> = hits.iter().filter(|w| w.focused).cloned().collect();
                if active.len() == 1 {
                    return Ok(active[0].clone());
                }
                return fail(
                    "ambiguous_window",
                    "More than one matching window; use list_windows/get_window",
                );
            }
        }
        hits.into_iter()
            .next()
            .ok_or_else(|| NativeError::new("window_not_found", "noMatchingWindow"))
    }

    fn focus(&self, window: &Window) -> NResult<Window> {
        let result = self.kwin_call("activateWindowByUuid", &[&window.native_id])?;
        if result != "true" {
            return fail("focus_failed", "KWin rejected target window activation");
        }
        let checked = self.resolve(&Map::from_iter([(
            "window".into(),
            serde_json::to_value(&window.public).unwrap(),
        )]))?;
        if !checked.focused {
            return fail("focus_failed", "Target window did not gain focus");
        }
        Ok(checked)
    }

    fn apps(&self) -> NResult<Vec<AppInfo>> {
        let mut grouped: BTreeMap<String, AppInfo> = BTreeMap::new();
        for window in self.windows()? {
            let display_name = if window.alias.is_empty() {
                Path::new(&proc_executable(window.pid))
                    .file_name()
                    .and_then(|x| x.to_str())
                    .unwrap_or(&window.public.app)
                    .to_string()
            } else {
                window.alias.clone()
            };
            grouped
                .entry(window.public.app.clone())
                .or_insert_with(|| AppInfo {
                    id: window.public.app.clone(),
                    display_name,
                    is_running: true,
                    windows: Vec::new(),
                })
                .windows
                .push(window.public.clone());
        }
        for (unit, description) in managed_units()? {
            let app = unit.strip_suffix(".service").unwrap_or(&unit).to_string();
            let name = serde_json::from_str::<Value>(&description)
                .ok()
                .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| app.clone());
            grouped.entry(app.clone()).or_insert(AppInfo {
                id: app,
                display_name: name,
                is_running: true,
                windows: Vec::new(),
            });
        }
        for entry in desktop_entries(&self.env) {
            grouped.entry(entry.id.clone()).or_insert(AppInfo {
                id: entry.id,
                display_name: entry.name,
                is_running: false,
                windows: Vec::new(),
            });
        }
        let mut apps: Vec<_> = grouped.into_values().collect();
        apps.sort_by(|a, b| {
            (!a.is_running, a.display_name.to_lowercase(), a.id.clone()).cmp(&(
                !b.is_running,
                b.display_name.to_lowercase(),
                b.id.clone(),
            ))
        });
        Ok(apps)
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

fn integer(value: Option<&Value>, name: &str, min: u64, max: u64) -> NResult<u64> {
    let Some(value) = value.and_then(Value::as_u64) else {
        return fail("validation", format!("{name} must be an integer"));
    };
    if !(min..=max).contains(&value) {
        return fail("validation", format!("{name} must be in [{min}, {max}]"));
    }
    Ok(value)
}

fn bounded(value: Option<&Value>, name: &str, min: f64, max: f64) -> NResult<f64> {
    let Some(value) = value.and_then(Value::as_f64) else {
        return fail("validation", format!("{name} must be a finite number"));
    };
    if !value.is_finite() || value < min || value > max {
        return fail("validation", format!("{name} must be in [{min}, {max}]"));
    }
    Ok(value)
}

fn string_arg(value: Option<&Value>, name: &str, max: usize) -> NResult<String> {
    let Some(value) = value.and_then(Value::as_str) else {
        return fail("validation", format!("{name} must be a string"));
    };
    if value.contains('\0') || value.len() > max {
        return fail(
            "validation",
            format!("{name} must be a string without NUL, at most {max} characters"),
        );
    }
    Ok(value.to_string())
}

fn proc_start(pid: u32) -> Option<String> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = text.rsplit_once(')')?.1;
    rest.split_whitespace().nth(19).map(str::to_string)
}

fn proc_executable(pid: u32) -> String {
    fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

fn managed_unit(pid: u32) -> Option<String> {
    let text = fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    for token in text.split(['/', '\n']) {
        if token.starts_with(&app_prefix()) && token.ends_with(".service") {
            let stem = token.strip_suffix(".service")?;
            let prefix = app_prefix();
            let suffix = stem.strip_prefix(&prefix)?;
            if suffix.len() == 32 && suffix.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(token.to_string());
            }
        }
    }
    None
}

fn managed_units() -> NResult<Vec<(String, String)>> {
    let output = Command::new(tool("systemctl"))
        .args([
            "list-units",
            "--all",
            "--no-pager",
            "--output=json",
            &format!("{}*.service", app_prefix()),
        ])
        .output()
        .map_err(env_error)?;
    if !output.status.success() {
        return fail("environment", "systemctl list-units failed");
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(env_error)?;
    let mut result = Vec::new();
    for unit in value.as_array().into_iter().flatten() {
        let active = unit.get("active").and_then(Value::as_str).unwrap_or("");
        if !matches!(active, "active" | "activating" | "reloading") {
            continue;
        }
        let Some(name) = unit.get("unit").and_then(Value::as_str) else {
            continue;
        };
        result.push((
            name.to_string(),
            unit.get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ));
    }
    Ok(result)
}

fn desktop_entries(env: &HashMap<String, String>) -> Vec<DesktopEntry> {
    let mut dirs = Vec::new();
    if let Some(v) = env.get("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(v).join("applications"));
    }
    for root in env
        .get("XDG_DATA_DIRS")
        .map(String::as_str)
        .unwrap_or("/usr/local/share:/usr/share")
        .split(':')
    {
        if !root.is_empty() {
            dirs.push(PathBuf::from(root).join("applications"));
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for item in read.flatten() {
            let path = item.path();
            if path.extension().and_then(|x| x.to_str()) != Some("desktop") {
                continue;
            }
            let id = item.file_name().to_string_lossy().into_owned();
            if !seen.insert(id.clone()) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let mut in_main = false;
            let mut name = None;
            let mut exec = None;
            let mut hidden = false;
            let mut no_display = false;
            let mut app_type = None;
            for raw in text.lines() {
                let line = raw.trim();
                if line.starts_with('[') && line.ends_with(']') {
                    in_main = line == "[Desktop Entry]";
                    continue;
                }
                if !in_main || line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let Some((k, v)) = line.split_once('=') else {
                    continue;
                };
                match k {
                    "Name" => {
                        if name.is_none() {
                            name = Some(v.to_string());
                        }
                    }
                    "Exec" => exec = Some(v.to_string()),
                    "Hidden" => hidden = v.eq_ignore_ascii_case("true"),
                    "NoDisplay" => no_display = v.eq_ignore_ascii_case("true"),
                    "Type" => app_type = Some(v.to_string()),
                    _ => {}
                }
            }
            if hidden || no_display || app_type.as_deref() != Some("Application") {
                continue;
            }
            if let (Some(name), Some(exec)) = (name, exec) {
                out.push(DesktopEntry { id, name, exec });
            }
        }
    }
    out
}

fn which(program: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    if program.contains('/') {
        let p = PathBuf::from(program);
        return p.is_file().then_some(p);
    }
    for dir in env
        .get("PATH")
        .map(String::as_str)
        .unwrap_or("/usr/local/bin:/usr/bin:/bin")
        .split(':')
    {
        let p = Path::new(if dir.is_empty() { "." } else { dir }).join(program);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn clean_desktop_exec(raw: &str) -> NResult<Vec<String>> {
    let parsed = shell_words::split(raw)
        .map_err(|e| NativeError::new("validation", format!("Invalid desktop Exec: {e}")))?;
    let fields = [
        "%f", "%F", "%u", "%U", "%d", "%D", "%n", "%N", "%i", "%c", "%k", "%v", "%m",
    ];
    Ok(parsed
        .into_iter()
        .filter(|x| !fields.contains(&x.as_str()))
        .map(|x| x.replace("%%", "%"))
        .collect())
}

fn launch_app(desktop: &Desktop, args: &Map<String, Value>) -> NResult<AppInfo> {
    let identifier = string_arg(args.get("app"), "app", 4096)?;
    let extras = args
        .get("args")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let Some(extras) = extras.as_array() else {
        return fail("validation", "args must be an array of strings");
    };
    if extras.len() > 256 {
        return fail("validation", "args must be an array of strings");
    }
    let mut extras: Vec<String> = extras
        .iter()
        .map(|v| string_arg(Some(v), "args item", 65536))
        .collect::<NResult<_>>()?;
    let options = args.get("options").cloned().unwrap_or_else(|| json!({}));
    let Some(options) = options.as_object() else {
        return fail("validation", "options must be an object");
    };
    let backend = options
        .get("backend")
        .and_then(Value::as_str)
        .unwrap_or("wayland");
    if !matches!(backend, "wayland" | "x11") {
        return fail("validation", "backend must be wayland or x11");
    }
    let mut env = desktop.info.env.clone();
    if backend == "x11" {
        env.insert("GDK_BACKEND".into(), "x11".into());
        env.insert("QT_QPA_PLATFORM".into(), "xcb".into());
        env.insert("SDL_VIDEODRIVER".into(), "x11".into());
        env.insert("WINIT_UNIX_BACKEND".into(), "x11".into());
        env.insert("MOZ_ENABLE_WAYLAND".into(), "0".into());
    } else {
        env.insert("GDK_BACKEND".into(), "wayland".into());
        env.insert("QT_QPA_PLATFORM".into(), "wayland".into());
        env.insert("SDL_VIDEODRIVER".into(), "wayland".into());
        env.insert("WINIT_UNIX_BACKEND".into(), "wayland".into());
        env.insert("MOZ_ENABLE_WAYLAND".into(), "1".into());
    }
    let custom = options.get("env").cloned().unwrap_or_else(|| json!({}));
    let Some(custom) = custom.as_object() else {
        return fail("validation", "options.env must be an object");
    };
    let mut reserved: HashSet<String> = desktop.info.env.keys().cloned().collect();
    reserved.extend(
        [
            "DBUS_STARTER_ADDRESS",
            "DBUS_STARTER_BUS_TYPE",
            "NOTIFY_SOCKET",
        ]
        .into_iter()
        .map(str::to_string),
    );
    for (key, value) in custom {
        if reserved.contains(key) {
            return fail(
                "validation",
                format!("Cannot override desktop routing variable {key}"),
            );
        }
        if !valid_env_key(key) {
            return fail("validation", "Invalid environment key");
        }
        env.insert(
            key.clone(),
            string_arg(Some(value), "environment value", 65536)?,
        );
    }

    let mut command_path = which(&identifier, &desktop.env);
    let mut name = Path::new(&identifier)
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or(&identifier)
        .to_string();
    if command_path.is_none() {
        let lower = identifier.to_lowercase();
        let entry = desktop_entries(&desktop.env)
            .into_iter()
            .find(|a| lower == a.id.to_lowercase() || lower == a.name.to_lowercase())
            .ok_or_else(|| {
                NativeError::new(
                    "app_not_found",
                    format!(
                        "appNotFound({})",
                        serde_json::to_string(&identifier).unwrap()
                    ),
                )
            })?;
        let mut argv = clean_desktop_exec(&entry.exec)?;
        if argv.is_empty() {
            return fail("validation", "Empty desktop Exec");
        }
        let program = argv.remove(0);
        command_path = which(&program, &desktop.env).or_else(|| Some(PathBuf::from(program)));
        let mut merged = argv;
        merged.append(&mut extras);
        extras = merged;
        name = entry.name;
    }
    let command_path = command_path.ok_or_else(|| {
        NativeError::new(
            "app_not_found",
            format!(
                "appNotFound({})",
                serde_json::to_string(&identifier).unwrap()
            ),
        )
    })?;
    if !command_path.is_file() {
        return fail("app_not_found", "Resolved executable is not a file");
    }
    let unit = format!("{}{}", app_prefix(), Uuid::new_v4().simple());
    let description =
        json!({"name": name, "command": command_path.display().to_string()}).to_string();
    let cwd = options
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_else(|| env.get("HOME").map(String::as_str).unwrap_or("/"));
    if !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
        return fail("validation", "cwd must be an existing absolute directory");
    }
    let mut argv = vec![
        "--quiet".to_string(),
        "--collect".to_string(),
        format!("--unit={unit}"),
        format!("--description={description}"),
        "--service-type=exec".into(),
        "--property=ExitType=cgroup".into(),
        "--property=KillMode=control-group".into(),
        "--property=TimeoutStopSec=3s".into(),
        format!("--property=After={}", desktop_unit()),
        "--property=Restart=on-failure".into(),
        "--property=RestartSec=500ms".into(),
        format!("--working-directory={cwd}"),
        "--property=UMask=0077".into(),
        "--property=SELinuxContext=system_u:system_r:unconfined_t:s0".into(),
    ];
    for (k, v) in &env {
        argv.push(format!("--setenv={k}={v}"));
    }
    argv.push("--".into());
    argv.push(command_path.display().to_string());
    argv.extend(extras);
    let output = Command::new(tool("systemd-run"))
        .args(&argv)
        .output()
        .map_err(env_error)?;
    if !output.status.success() {
        return fail(
            "environment",
            format!("systemd-run: {}", String::from_utf8_lossy(&output.stderr)),
        );
    }
    Ok(AppInfo {
        id: unit,
        display_name: name,
        is_running: true,
        windows: Vec::new(),
    })
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

async fn short<T, E>(future: impl std::future::Future<Output = Result<T, E>>) -> Option<T> {
    timeout(Duration::from_millis(600), future).await.ok()?.ok()
}

async fn component_extents_async(proxy: &AccessibleProxy<'_>) -> Option<Rect> {
    let proxies = proxy.proxies().await.ok()?;
    let component = proxies.component().await.ok()?;
    let (x, y, width, height) = short(component.get_extents(CoordType::Window)).await?;
    Some(Rect {
        x: x as f64,
        y: y as f64,
        width: width as f64,
        height: height as f64,
    })
}

fn map_role(role: String) -> String {
    match role.as_str() {
        "frame" | "window" => "standard window".into(),
        "push button" => "button".into(),
        "text" | "entry" | "text box" => "text field".into(),
        "scroll pane" | "scrollable panel" => "scroll area".into(),
        "scrollbar" => "scroll bar".into(),
        "panel" | "filler" | "generic" => "group".into(),
        _ => role,
    }
}

fn normalize_container_roles(nodes: &mut [AxNode]) {
    // GTK4 sometimes reports GtkScrolledWindow itself as "generic" over raw
    // AT-SPI D-Bus while libatspi's higher-level wrapper reports "scroll pane".
    // A direct scrollbar child is the stable semantic signal; normalize the
    // parent to Codex-style "scroll area" rather than leaking binding details.
    let scroll_parent_paths: Vec<Vec<usize>> = nodes
        .iter()
        .filter(|n| n.role == "scroll bar" && !n.path.is_empty())
        .map(|n| n.path[..n.path.len() - 1].to_vec())
        .collect();
    for parent_path in scroll_parent_paths {
        if let Some(parent) = nodes
            .iter_mut()
            .find(|n| n.path == parent_path && n.role == "group")
        {
            parent.role = "scroll area".into();
        }
    }
}

fn fingerprint(nodes: &[AxNode]) -> String {
    let bytes = serde_json::to_vec(nodes).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn render_tree(nodes: &[AxNode]) -> String {
    let mut lines = Vec::new();
    for e in nodes {
        let mut flags = Vec::new();
        if e.selected {
            flags.push("selected".to_string());
        } else if e.selectable {
            flags.push("selectable".to_string());
        }
        if e.expandable {
            flags.push(if e.expanded { "expanded" } else { "collapsed" }.to_string());
        }
        if e.editable {
            flags.push("settable".into());
            flags.push("string".into());
        }
        let mut line = format!("{}{} {}", "    ".repeat(e.depth), e.index, e.role);
        if !flags.is_empty() {
            line.push_str(&format!(" ({})", flags.join(", ")));
        }
        if !e.name.is_empty() {
            line.push(' ');
            line.push_str(&e.name.replace('\n', " "));
        }
        if !e.description.is_empty() && e.description != e.name {
            line.push_str(" Description: ");
            line.push_str(&e.description);
        }
        if let Some(value) = &e.value {
            let rendered = match value {
                Value::String(s) => s.replace('\n', " "),
                _ => value.to_string(),
            };
            if rendered != e.name {
                line.push_str(" Value: ");
                line.push_str(&rendered);
            }
        }
        if !e.placeholder.is_empty()
            && e.placeholder != e.name
            && e.value.as_ref().and_then(Value::as_str) != Some(e.placeholder.as_str())
        {
            line.push_str(" Placeholder: ");
            line.push_str(&e.placeholder);
        }
        if !e.identifier.is_empty() {
            line.push_str(", ID: ");
            line.push_str(&e.identifier);
        }
        let mut secondary: Vec<String> = e
            .actions
            .iter()
            .filter(|a| {
                !matches!(
                    a.to_lowercase().as_str(),
                    "click" | "press" | "activate" | "toggle"
                )
            })
            .map(|a| title_case(a))
            .collect();
        if e.index == 0 {
            secondary.insert(0, "Raise".into());
        }
        if !secondary.is_empty() {
            line.push_str(", Secondary Actions: ");
            line.push_str(&secondary.join(", "));
        }
        lines.push(line);
    }
    lines.join("\n")
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn screenshot_id(desktop: &Desktop, window: &Window, width: u32, height: u32) -> String {
    let payload = json!({
        "epoch": desktop.info.epoch,
        "window": window.public,
        "pid": window.pid,
        "start": window.start,
        "bounds": window.bounds,
        "width": width,
        "height": height,
    });
    format!(
        "sway-shot.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
    )
}

fn command_bytes(
    program: &str,
    args: &[String],
    env: &HashMap<String, String>,
    timeout_duration: Duration,
) -> NResult<Vec<u8>> {
    if tokio::runtime::Handle::try_current()
        .is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
    {
        return tokio::task::block_in_place(|| {
            command_bytes_blocking(program, args, env, timeout_duration)
        });
    }
    command_bytes_blocking(program, args, env, timeout_duration)
}

fn command_bytes_blocking(
    program: &str,
    args: &[String],
    env: &HashMap<String, String>,
    timeout_duration: Duration,
) -> NResult<Vec<u8>> {
    let mut command = Command::new(tool(program));
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut owned = HelperProcess {
        child: command.spawn().map_err(env_error)?,
        reaped: false,
    };
    let child = &mut owned.child;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| NativeError::new("environment", "child stdout pipe missing"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| NativeError::new("environment", "child stderr pipe missing"))?;
    for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
        // SAFETY: both descriptors are owned live pipe ends. Nonblocking reads
        // let one deadline cover the child and descendants holding either pipe.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(env_error(std::io::Error::last_os_error()));
        }
    }
    let deadline = Instant::now() + timeout_duration;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut exited = false;
    while !(stdout_done && stderr_done && exited) {
        if Instant::now() >= deadline {
            return fail(
                "timeout",
                format!("{program} timed out (including output pipes)"),
            );
        }
        stdout_done |= drain_helper_pipe(&mut stdout, &mut output, 64 * 1024 * 1024)?;
        stderr_done |= drain_helper_pipe(&mut stderr, &mut errors, 1024 * 1024)?;
        if !exited {
            exited = helper_exited(child.id())?;
        }
        if !(stdout_done && stderr_done && exited) {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    let command_name = Path::new(program)
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or(program);
    if owned.finish().map_err(env_error)?.success() {
        Ok(output)
    } else {
        fail(
            "environment",
            format!("{command_name}: {}", String::from_utf8_lossy(&errors)),
        )
    }
}

fn helper_exited(pid: u32) -> NResult<bool> {
    // Keep the leader unreaped until group cleanup. Its PID cannot be reused
    // while descendants still hold the helper's output pipes.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(env_error(error));
    }
    Ok(unsafe { info.si_pid() } != 0)
}

struct HelperProcess {
    child: std::process::Child,
    reaped: bool,
}

impl HelperProcess {
    fn finish(&mut self) -> std::io::Result<std::process::ExitStatus> {
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let status = self.child.wait()?;
        self.reaped = true;
        Ok(status)
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        // The helper was started in its own process group. Never signal the
        // daemon, desktop or unrelated application groups.
        if !self.reaped {
            let _ = self.finish();
        }
    }
}

fn drain_helper_pipe(pipe: &mut impl Read, bytes: &mut Vec<u8>, limit: usize) -> NResult<bool> {
    let mut chunk = [0u8; 16384];
    // Bound each turn as well, so a producer cannot monopolize the deadline.
    for _ in 0..16 {
        match pipe.read(&mut chunk) {
            Ok(0) => return Ok(true),
            Ok(count) => {
                if bytes.len() + count > limit {
                    return fail("environment", "Native helper output limit exceeded");
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(env_error(error)),
        }
    }
    Ok(false)
}

async fn kwin_capture_area_png(desktop: &Desktop, area: Rect) -> NResult<Vec<u8>> {
    let width = area.width.round() as u32;
    let height = area.height.round() as u32;
    if width == 0 || height == 0 {
        return fail("capture_failed", "Capture area is empty");
    }
    let address: zbus::Address = desktop
        .env
        .get("DBUS_SESSION_BUS_ADDRESS")
        .ok_or_else(|| NativeError::new("unavailable", "Desktop D-Bus address missing"))?
        .parse()
        .map_err(env_error)?;
    let connection = zbus::connection::Builder::address(address)
        .map_err(env_error)?
        .build()
        .await
        .map_err(env_error)?;

    let mut fds = [-1i32; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(env_error(std::io::Error::last_os_error()));
    }
    let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write_fd = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    let options: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::from([
        ("include-cursor", zbus::zvariant::Value::Bool(false)),
        ("native-resolution", zbus::zvariant::Value::Bool(false)),
        ("hide-caller-windows", zbus::zvariant::Value::Bool(false)),
    ]);
    let pipe = zbus::zvariant::Fd::from(write_fd.as_fd());
    connection
        .call_method(
            Some("org.kde.KWin.ScreenShot2"),
            "/org/kde/KWin/ScreenShot2",
            Some("org.kde.KWin.ScreenShot2"),
            "CaptureArea",
            &(
                area.x.round() as i32,
                area.y.round() as i32,
                width,
                height,
                options,
                pipe,
            ),
        )
        .await
        .map_err(env_error)?;
    drop(write_fd);

    let raw = tokio::task::block_in_place(|| -> std::io::Result<Vec<u8>> {
        let mut file = File::from(read_fd);
        let mut bytes = Vec::with_capacity(width as usize * height as usize * 4);
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    })
    .map_err(env_error)?;
    let expected = width as usize * height as usize * 4;
    if raw.len() != expected {
        return fail(
            "capture_failed",
            format!(
                "Unexpected KWin screenshot size: {} != {expected}",
                raw.len()
            ),
        );
    }

    let mut child = Command::new(tool("image-magick"))
        .args([
            "-size",
            &format!("{width}x{height}"),
            "-depth",
            "8",
            "BGRA:-",
            "png:-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(env_error)?;
    child
        .stdin
        .take()
        .ok_or_else(|| NativeError::new("environment", "ImageMagick stdin missing"))?
        .write_all(&raw)
        .map_err(env_error)?;
    let output = child.wait_with_output().map_err(env_error)?;
    if !output.status.success() {
        return fail(
            "capture_failed",
            format!(
                "ImageMagick failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        );
    }
    Ok(output.stdout)
}

async fn screenshot(desktop: &Desktop, window: &Window) -> NResult<Screenshot> {
    let window = desktop.focus(window)?;
    let r = window.bounds;
    if r.width <= 0.0 || r.height <= 0.0 {
        return fail("capture_failed", "Window has no capturable area");
    }
    if r.x < 0.0
        || r.y < 0.0
        || r.x + r.width > desktop.info.width as f64
        || r.y + r.height > desktop.info.height as f64
    {
        return fail(
            "capture_failed",
            "Window extends outside the native output; move/resize it before capture",
        );
    }
    tokio::time::sleep(Duration::from_millis(60)).await;
    let data = kwin_capture_area_png(desktop, r).await?;
    if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
        return fail("capture_failed", "Invalid screenshot output");
    }
    let width = u32::from_be_bytes(data[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(data[20..24].try_into().unwrap());
    Ok(Screenshot {
        id: screenshot_id(desktop, &window, width, height),
        url: format!("data:image/png;base64,{}", STANDARD.encode(&data)),
        width,
        height,
        origin_x: r.x,
        origin_y: r.y,
        z_index: 0,
    })
}

async fn observe(
    desktop: &Desktop,
    mut window: Window,
    args: &Map<String, Value>,
) -> NResult<(WindowState, Observation)> {
    for name in ["include_text", "include_screenshot"] {
        if let Some(v) = args.get(name) {
            if !v.is_boolean() {
                return fail("validation", format!("{name} must be boolean"));
            }
        }
    }
    let include_text = args
        .get("include_text")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_screenshot = args
        .get("include_screenshot")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if include_screenshot {
        window = desktop.focus(&window)?;
    }
    let (nodes, objects, warnings) = if include_text {
        ax_tree_fixed(desktop, &window).await
    } else {
        (Vec::new(), Vec::new(), Vec::new())
    };
    let _ = objects;
    let screenshots = if include_screenshot {
        vec![screenshot(desktop, &window).await?]
    } else {
        Vec::new()
    };
    let accessibility = if include_text {
        let mut tree = render_tree(&nodes);
        if !warnings.is_empty() {
            if !tree.is_empty() {
                tree.push('\n');
            }
            tree.push_str(&warnings.join("\n"));
        }
        let focused_element = nodes
            .iter()
            .find(|n| n.focused)
            .map(|n| format!("{} {}", n.index, n.role));
        let selected: Vec<_> = nodes
            .iter()
            .filter(|n| n.selected)
            .map(|n| format!("{} {}", n.index, n.role))
            .collect();
        let selected_text = nodes.iter().find_map(|n| n.selected_text.clone());
        Some(AccessibilityState {
            tree,
            focused_element,
            selected_elements: (!selected.is_empty()).then_some(selected),
            selected_text,
        })
    } else {
        None
    };
    let observation = Observation {
        epoch: desktop.info.epoch.clone(),
        window: window.public.clone(),
        pid: window.pid,
        start: window.start.clone(),
        fingerprint: fingerprint(&nodes),
        nodes,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64(),
    };
    Ok((
        WindowState {
            accessibility,
            screenshots,
            window: window.public,
        },
        observation,
    ))
}

async fn ax_tree_fixed(
    desktop: &Desktop,
    window: &Window,
) -> (Vec<AxNode>, Vec<AxObject>, Vec<String>) {
    // Same traversal as ax_tree(), but Component extents must be awaited. Keep this
    // separate so all AT-SPI calls remain bounded and no blocking executor is nested.
    let Some(addr) = desktop.info.env.get("AT_SPI_BUS_ADDRESS") else {
        return ax_unavailable();
    };
    let Ok(address) = addr.parse() else {
        return ax_unavailable();
    };
    let Ok(connection) = AccessibilityConnection::from_address(address).await else {
        return ax_unavailable();
    };
    let Ok(root) = connection.root_accessible_on_registry().await else {
        return ax_unavailable();
    };
    let Some(children) = short(root.get_children()).await else {
        return ax_unavailable();
    };
    let Ok(dbus) = zbus::fdo::DBusProxy::new(connection.connection()).await else {
        return ax_unavailable();
    };
    let mut app_ref = None;
    for child in children {
        let Some(name) = child.name() else { continue };
        let bus: BusName<'_> = name.clone().into();
        if short(dbus.get_connection_unix_process_id(bus)).await == Some(window.pid) {
            app_ref = Some(child);
            break;
        }
    }
    let Some(app_ref) = app_ref else {
        return ax_unavailable();
    };
    let Ok(app_proxy) = app_ref.as_accessible_proxy(connection.connection()).await else {
        return ax_unavailable();
    };
    let roots = short(app_proxy.get_children()).await.unwrap_or_default();
    let mut candidates = Vec::new();
    for reference in roots {
        let Ok(proxy) = reference.as_accessible_proxy(connection.connection()).await else {
            continue;
        };
        let name = short(proxy.name()).await.unwrap_or_default();
        candidates.push((reference, name));
    }
    let exact: Vec<_> = candidates
        .iter()
        .filter(|(_, name)| *name == window.public.title)
        .collect();
    let root_ref = if exact.len() == 1 {
        exact[0].0.clone()
    } else if candidates.len() == 1 {
        candidates[0].0.clone()
    } else {
        return ax_unavailable();
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut nodes = Vec::new();
    let mut objects = Vec::new();
    let mut stack = vec![(root_ref, 0usize, Vec::<usize>::new())];
    while let Some((reference, depth, path)) = stack.pop() {
        if nodes.len() >= MAX_NODES || depth > 48 || Instant::now() >= deadline {
            break;
        }
        let Ok(proxy) = reference.as_accessible_proxy(connection.connection()).await else {
            continue;
        };
        let states = short(proxy.get_state())
            .await
            .unwrap_or_else(atspi::StateSet::empty);
        if states.contains(State::Defunct) {
            continue;
        }
        let role = map_role(
            short(proxy.get_role_name())
                .await
                .unwrap_or_else(|| "unknown".into()),
        );
        let name = short(proxy.name()).await.unwrap_or_default();
        let description = short(proxy.description()).await.unwrap_or_default();
        let attrs = short(proxy.get_attributes()).await.unwrap_or_default();
        let identifier = short(proxy.accessible_id()).await.unwrap_or_default();
        let interfaces = short(proxy.get_interfaces()).await.unwrap_or_default();
        let editable = interfaces.contains(Interface::EditableText);
        let frame = if interfaces.contains(Interface::Component) {
            component_extents_async(&proxy).await
        } else {
            None
        };
        let mut value = None;
        let mut selected_text = None;
        if interfaces.contains(Interface::Text) {
            if let Ok(proxies) = proxy.proxies().await {
                if let Ok(text_proxy) = proxies.text().await {
                    if let Some(count) = short(text_proxy.character_count()).await {
                        if let Some(text) = short(text_proxy.get_text(0, count.min(8000))).await {
                            value = Some(Value::String(text));
                        }
                    }
                    if short(text_proxy.get_n_selections()).await.unwrap_or(0) > 0 {
                        if let Some((start, end)) = short(text_proxy.get_selection(0)).await {
                            selected_text = short(text_proxy.get_text(start, end)).await;
                        }
                    }
                }
            }
        } else if interfaces.contains(Interface::Value) {
            if let Ok(proxies) = proxy.proxies().await {
                if let Ok(value_proxy) = proxies.value().await {
                    value = short(value_proxy.current_value())
                        .await
                        .and_then(serde_json::Number::from_f64)
                        .map(Value::Number);
                }
            }
        }
        let mut actions = Vec::new();
        if interfaces.contains(Interface::Action) {
            if let Ok(proxies) = proxy.proxies().await {
                if let Ok(action) = proxies.action().await {
                    let count = short(action.n_actions()).await.unwrap_or(0).clamp(0, 64);
                    for i in 0..count {
                        if let Some(action_name) = short(action.get_name(i)).await {
                            actions.push(action_name);
                        }
                    }
                }
            }
        }
        let index = nodes.len();
        nodes.push(AxNode {
            index,
            path: path.clone(),
            depth,
            role,
            name,
            description,
            identifier,
            value,
            editable,
            focused: states.contains(State::Focused),
            selected: states.contains(State::Selected),
            selectable: states.contains(State::Selectable),
            enabled: states.contains(State::Enabled) || states.contains(State::Sensitive),
            expanded: states.contains(State::Expanded),
            expandable: states.contains(State::Expandable),
            placeholder: attrs.get("placeholder-text").cloned().unwrap_or_default(),
            actions,
            frame,
            selected_text,
        });
        objects.push(AxObject {
            reference: reference.clone(),
        });
        let children = short(proxy.get_children()).await.unwrap_or_default();
        for (i, child) in children.into_iter().enumerate().rev() {
            let mut child_path = path.clone();
            child_path.push(i);
            stack.push((child, depth + 1, child_path));
        }
    }
    normalize_container_roles(&mut nodes);
    let mut warnings = Vec::new();
    if Instant::now() >= deadline || nodes.len() >= MAX_NODES {
        warnings.push("Accessibility tree truncated at traversal budget.".into());
    }
    (nodes, objects, warnings)
}

fn ax_unavailable() -> (Vec<AxNode>, Vec<AxObject>, Vec<String>) {
    (
        Vec::new(),
        Vec::new(),
        vec!["Accessibility tree unavailable for this window; use screenshot coordinates.".into()],
    )
}

async fn verify_observation(
    desktop: &Desktop,
    window: &Window,
    observation: Option<&Observation>,
    index: &Value,
) -> NResult<(AxNode, AxObject)> {
    let Some(observation) = observation else {
        return fail("stale_index", "Refresh state before using an element index");
    };
    if observation.epoch != desktop.info.epoch
        || observation.window.id != window.public.id
        || observation.pid != window.pid
        || observation.start != window.start
    {
        return fail("stale_index", "Refresh state before using an element index");
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    if now - observation.created_at > 300.0 {
        return fail("stale_index", "Observation expired; refresh state");
    }
    let idx = if let Some(n) = index.as_u64() {
        n as usize
    } else if let Some(s) = index.as_str() {
        s.parse::<usize>()
            .map_err(|_| NativeError::new("validation", "element_index must be numeric"))?
    } else {
        return fail("validation", "element_index must be numeric");
    };
    if idx >= MAX_NODES {
        return fail("validation", "element_index out of range");
    }
    let (nodes, objects, _) = ax_tree_fixed(desktop, window).await;
    if fingerprint(&nodes) != observation.fingerprint || idx >= nodes.len() || idx >= objects.len()
    {
        return fail(
            "stale_index",
            "Accessibility state changed; refresh state before using this index",
        );
    }
    Ok((nodes[idx].clone(), objects[idx].clone()))
}

fn decode_screenshot_id(desktop: &Desktop, window: &Window, sid: &str) -> NResult<Value> {
    let Some(encoded) = sid.strip_prefix("sway-shot.") else {
        return fail(
            "stale_screenshot",
            "Screenshot does not belong to this live window",
        );
    };
    let data = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| {
        NativeError::new(
            "stale_screenshot",
            "Screenshot does not belong to this live window",
        )
    })?;
    let shot: Value = serde_json::from_slice(&data).map_err(|_| {
        NativeError::new(
            "stale_screenshot",
            "Screenshot does not belong to this live window",
        )
    })?;
    if shot.get("epoch").and_then(Value::as_str) != Some(desktop.info.epoch.as_str())
        || shot
            .get("window")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_u64)
            != Some(window.public.id)
        || shot
            .get("window")
            .and_then(|v| v.get("app"))
            .and_then(Value::as_str)
            != Some(window.public.app.as_str())
        || shot.get("pid").and_then(Value::as_u64) != Some(window.pid as u64)
        || shot.get("start").and_then(Value::as_str) != Some(window.start.as_str())
    {
        return fail(
            "stale_screenshot",
            "Screenshot does not belong to this live window",
        );
    }
    Ok(shot)
}

fn coords(
    desktop: &Desktop,
    window: &Window,
    args: &Map<String, Value>,
    xkey: &str,
    ykey: &str,
) -> NResult<(f64, f64)> {
    let mut x = bounded(args.get(xkey), xkey, 0.0, 16384.0)?;
    let mut y = bounded(args.get(ykey), ykey, 0.0, 16384.0)?;
    if let Some(sid) = args.get("screenshotId").and_then(Value::as_str) {
        let shot = decode_screenshot_id(desktop, window, sid)?;
        let sw = shot
            .get("width")
            .and_then(Value::as_f64)
            .filter(|v| *v > 0.0)
            .ok_or_else(|| {
                NativeError::new(
                    "stale_screenshot",
                    "Screenshot does not belong to this live window",
                )
            })?;
        let sh = shot
            .get("height")
            .and_then(Value::as_f64)
            .filter(|v| *v > 0.0)
            .ok_or_else(|| {
                NativeError::new(
                    "stale_screenshot",
                    "Screenshot does not belong to this live window",
                )
            })?;
        x = x * window.bounds.width / sw;
        y = y * window.bounds.height / sh;
    }
    if x >= window.bounds.width || y >= window.bounds.height {
        return fail("validation", "Coordinates outside the captured window");
    }
    let gx = window.bounds.x + x;
    let gy = window.bounds.y + y;
    if gx < 0.0 || gy < 0.0 || gx >= desktop.info.width as f64 || gy >= desktop.info.height as f64 {
        return fail("validation", "Point outside the native output");
    }
    Ok((gx, gy))
}

fn pointer(desktop: &Desktop, mode: &str, xy: (f64, f64), extra: &[f64]) -> NResult<()> {
    let mut args = vec![
        mode.to_string(),
        xy.0.to_string(),
        xy.1.to_string(),
        desktop.info.width.to_string(),
        desktop.info.height.to_string(),
    ];
    args.extend(extra.iter().map(ToString::to_string));
    let _ = command_bytes(
        &setting("MCPBROWSER_TOOL_NATIVE_POINTER"),
        &args,
        &desktop.env,
        Duration::from_secs(6),
    )?;
    Ok(())
}

fn keypress(desktop: &Desktop, key: &str) -> NResult<()> {
    if key.contains('\0') || key.len() > 256 {
        return fail("validation", "key must be a short string");
    }
    let _ = command_bytes(
        &setting("MCPBROWSER_TOOL_NATIVE_POINTER"),
        &["key".into(), key.to_string()],
        &desktop.env,
        Duration::from_secs(6),
    )?;
    Ok(())
}

async fn mutate(
    desktop: &Desktop,
    method: &str,
    args: &mut Map<String, Value>,
    observation: Option<&Observation>,
) -> NResult<()> {
    if method == "click" {
        let count = args.get("click_count").and_then(Value::as_u64).unwrap_or(1);
        if !(1..=3).contains(&count) {
            return fail("validation", "click_count must be in [1, 3]");
        }
        let button = args
            .get("mouse_button")
            .and_then(Value::as_str)
            .unwrap_or("left");
        if !matches!(button, "left" | "right" | "middle" | "l" | "r" | "m") {
            return fail("validation", "Unknown mouse_button");
        }
    }
    if matches!(method, "click" | "move_cursor" | "scroll") && !args.contains_key("element_index") {
        let _ = bounded(args.get("x"), "x", 0.0, 16384.0)?;
        let _ = bounded(args.get("y"), "y", 0.0, 16384.0)?;
    }
    if method == "drag" {
        for key in ["from_x", "from_y", "to_x", "to_y"] {
            let _ = bounded(args.get(key), key, 0.0, 16384.0)?;
        }
    }
    if method == "type_text" {
        let _ = string_arg(args.get("text"), "text", 65536)?;
    }
    if method == "press_key" {
        let _ = string_arg(args.get("key"), "key", 256)?;
    }
    if method == "set_value" {
        let _ = string_arg(args.get("value"), "value", 65536)?;
    }
    let mut window = desktop.resolve(args)?;
    if method == "activate_window" {
        let _ = desktop.focus(&window)?;
        return Ok(());
    }
    if method == "close_window" {
        let result = desktop.kwin_call("closeWindowByUuid", &[&window.native_id])?;
        if result != "true" {
            return fail("environment", "KWin rejected target window close");
        }
        return Ok(());
    }

    if matches!(method, "click" | "set_value" | "perform_secondary_action")
        && args.contains_key("element_index")
    {
        let index_value = args.get("element_index").unwrap().clone();
        let (node, object) =
            verify_observation(desktop, &window, observation, &index_value).await?;
        let address = desktop
            .info
            .env
            .get("AT_SPI_BUS_ADDRESS")
            .ok_or_else(|| NativeError::new("unavailable", "AT-SPI address missing"))?
            .parse()
            .map_err(env_error)?;
        let connection = AccessibilityConnection::from_address(address)
            .await
            .map_err(env_error)?;
        let proxy = object
            .reference
            .as_accessible_proxy(connection.connection())
            .await
            .map_err(env_error)?;
        let interfaces = short(proxy.get_interfaces()).await.unwrap_or_default();
        if method == "set_value" {
            let value = string_arg(args.get("value"), "value", 65536)?;
            let proxies = proxy.proxies().await.map_err(env_error)?;
            if node.editable && interfaces.contains(Interface::EditableText) {
                let editable = proxies.editable_text().await.map_err(env_error)?;
                if short(editable.set_text_contents(&value)).await != Some(true) {
                    return fail("action_failed", "AX set_value returned false");
                }
            } else if interfaces.contains(Interface::Value) {
                let number = value.parse::<f64>().map_err(|_| {
                    NativeError::new("validation", "Value control requires a numeric string")
                })?;
                if !number.is_finite() {
                    return fail("validation", "Value must be finite");
                }
                let value_proxy = proxies.value().await.map_err(env_error)?;
                timeout(
                    Duration::from_millis(600),
                    value_proxy.set_current_value(number),
                )
                .await
                .map_err(|_| NativeError::new("timeout", "AT-SPI value action timed out"))?
                .map_err(env_error)?;
            } else {
                return fail("unsupported", "The element is not settable");
            }
            return Ok(());
        }
        let desired_name = if method == "perform_secondary_action" {
            Some(string_arg(args.get("action"), "action", 128)?)
        } else {
            None
        };
        if desired_name
            .as_deref()
            .is_some_and(|n| n.eq_ignore_ascii_case("raise"))
            && node.index == 0
        {
            let _ = desktop.focus(&window)?;
            return Ok(());
        }
        let button = args
            .get("mouse_button")
            .and_then(Value::as_str)
            .unwrap_or("left");
        let count = args.get("click_count").and_then(Value::as_u64).unwrap_or(1);
        if interfaces.contains(Interface::Action)
            && (desired_name.is_some() || (count == 1 && matches!(button, "left" | "l")))
        {
            let proxies = proxy.proxies().await.map_err(env_error)?;
            let action = proxies.action().await.map_err(env_error)?;
            let wanted: Vec<String> = desired_name
                .clone()
                .map(|v| vec![v.to_lowercase()])
                .unwrap_or_else(|| {
                    vec![
                        "click".into(),
                        "press".into(),
                        "activate".into(),
                        "toggle".into(),
                    ]
                });
            if let Some(idx) = node
                .actions
                .iter()
                .position(|a| wanted.iter().any(|w| a.eq_ignore_ascii_case(w)))
            {
                if short(action.do_action(idx as i32)).await != Some(true) {
                    return fail("action_failed", "AX action returned false");
                }
                return Ok(());
            }
        }
        if let Some(name) = desired_name {
            return fail(
                "unsupported",
                format!("No secondary accessibility action named {name}"),
            );
        }
        let Some(frame) = node.frame else {
            return fail("unsupported", "Element has no clickable bounds or action");
        };
        if frame.width <= 0.0 || frame.height <= 0.0 {
            return fail("unsupported", "Element has no clickable bounds or action");
        }
        args.insert("x".into(), json!(frame.x + frame.width / 2.0));
        args.insert("y".into(), json!(frame.y + frame.height / 2.0));
    }

    if matches!(
        method,
        "click" | "type_text" | "press_key" | "scroll" | "drag" | "move_cursor"
    ) {
        window = desktop.focus(&window)?;
        match method {
            "type_text" => {
                let text = string_arg(args.get("text"), "text", 65536)?;
                let _ = command_bytes(
                    &setting("MCPBROWSER_TOOL_NATIVE_POINTER"),
                    &["text".into(), text],
                    &desktop.env,
                    Duration::from_secs(10),
                )?;
                return Ok(());
            }
            "press_key" => {
                keypress(desktop, &string_arg(args.get("key"), "key", 256)?)?;
                return Ok(());
            }
            "click" => {
                let buttons = HashMap::from([
                    ("left", 1.0),
                    ("l", 1.0),
                    ("right", 2.0),
                    ("r", 2.0),
                    ("middle", 3.0),
                    ("m", 3.0),
                ]);
                let button = args
                    .get("mouse_button")
                    .and_then(Value::as_str)
                    .unwrap_or("left");
                let count = args.get("click_count").and_then(Value::as_u64).unwrap_or(1) as f64;
                pointer(
                    desktop,
                    "click",
                    coords(desktop, &window, args, "x", "y")?,
                    &[*buttons.get(button).unwrap(), count],
                )?;
                return Ok(());
            }
            "move_cursor" => {
                pointer(
                    desktop,
                    "move",
                    coords(desktop, &window, args, "x", "y")?,
                    &[],
                )?;
                return Ok(());
            }
            "drag" => {
                let from = coords(desktop, &window, args, "from_x", "from_y")?;
                let to = coords(desktop, &window, args, "to_x", "to_y")?;
                pointer(desktop, "drag", from, &[to.0, to.1])?;
                return Ok(());
            }
            "scroll" => {
                if let Some(direction) = args
                    .get("direction")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    let pages = args.get("pages").and_then(Value::as_f64).unwrap_or(1.0);
                    if !(0.0..=20.0).contains(&pages) {
                        return fail("validation", "pages out of range");
                    }
                    if !matches!(direction.as_str(), "up" | "down" | "left" | "right") {
                        return fail("validation", "Invalid direction");
                    }
                    let index = args
                        .get("element_index")
                        .ok_or_else(|| {
                            NativeError::new(
                                "validation",
                                "element_index required for directional scroll",
                            )
                        })?
                        .clone();
                    let (node, _) =
                        verify_observation(desktop, &window, observation, &index).await?;
                    let Some(frame) = node.frame else {
                        return fail("unsupported", "Scroll element has no bounds");
                    };
                    args.insert("x".into(), json!(frame.x + frame.width / 2.0));
                    args.insert("y".into(), json!(frame.y + frame.height / 2.0));
                    let sx = if matches!(direction.as_str(), "left" | "right") {
                        (if direction == "left" { -1.0 } else { 1.0 })
                            * frame.width.max(10.0)
                            * pages
                    } else {
                        0.0
                    };
                    let sy = if matches!(direction.as_str(), "up" | "down") {
                        (if direction == "up" { -1.0 } else { 1.0 })
                            * frame.height.max(10.0)
                            * pages
                    } else {
                        0.0
                    };
                    args.insert("scrollX".into(), json!(sx));
                    args.insert("scrollY".into(), json!(sy));
                }
                let dx = args.get("scrollX").and_then(Value::as_f64).unwrap_or(0.0);
                let dy = args.get("scrollY").and_then(Value::as_f64).unwrap_or(0.0);
                if dx.abs() > 10000.0 || dy.abs() > 10000.0 {
                    return fail("validation", "scroll delta out of range");
                }
                pointer(
                    desktop,
                    "scroll",
                    coords(desktop, &window, args, "x", "y")?,
                    &[dx, dy],
                )?;
                return Ok(());
            }
            _ => {}
        }
    }
    fail("unsupported", format!("Unsupported method {method}"))
}

async fn dispatch(
    desktop: &Desktop,
    method: &str,
    args: &mut Map<String, Value>,
    observation: Option<&Observation>,
) -> NResult<(Value, Option<Observation>)> {
    match method {
        "health" => {
            let filtered = vec![json!({
                "name": setting("MCPBROWSER_NATIVE_OUTPUT"),
                "active": true,
                "rect": {"x":0,"y":0,"width":desktop.info.width,"height":desktop.info.height},
                "scale": setting("MCPBROWSER_NATIVE_SCALE").parse::<f64>().unwrap_or(1.0)
            })];
            Ok((
                json!({"available":true,"backend":"mcpbrowser-native","mode":"full_access","desktop":"kwin-virtual","width":desktop.info.width,"height":desktop.info.height,"renderer":desktop.info.renderer,"epoch":desktop.info.epoch,"outputs":filtered}),
                None,
            ))
        }
        "list_windows" => Ok((
            serde_json::to_value(
                desktop
                    .windows()?
                    .into_iter()
                    .map(|w| w.public)
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
            None,
        )),
        "list_apps" => Ok((serde_json::to_value(desktop.apps()?).unwrap(), None)),
        "get_window" => Ok((
            serde_json::to_value(desktop.resolve(args)?.public).unwrap(),
            None,
        )),
        "launch_app" => Ok((
            serde_json::to_value(launch_app(desktop, args)?).unwrap(),
            None,
        )),
        "kill_app" => {
            let app = string_arg(args.get("app"), "app", 128)?;
            let prefix = app_prefix();
            let Some(suffix) = app.strip_prefix(&prefix) else {
                return fail(
                    "unsupported",
                    "kill_app only stops explicitly managed application units; close attached windows individually",
                );
            };
            if suffix.len() != 32 || !suffix.chars().all(|c| c.is_ascii_hexdigit()) {
                return fail(
                    "unsupported",
                    "kill_app only stops explicitly managed application units; close attached windows individually",
                );
            }
            let status = Command::new(tool("systemctl"))
                .args(["stop", &format!("{app}.service")])
                .status()
                .map_err(env_error)?;
            if !status.success() {
                return fail("environment", "systemctl stop failed");
            }
            Ok((Value::Null, None))
        }
        "get_desktop_state" => {
            let data = kwin_capture_area_png(
                desktop,
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: desktop.info.width as f64,
                    height: desktop.info.height as f64,
                },
            )
            .await?;
            Ok((
                json!({"screenshots":[{"id":format!("desktop.{}",desktop.info.epoch),"url":format!("data:image/png;base64,{}",STANDARD.encode(data)),"width":desktop.info.width,"height":desktop.info.height,"originX":0,"originY":0,"zIndex":0}],"windows":desktop.windows()?.into_iter().map(|w|w.public).collect::<Vec<_>>() }),
                None,
            ))
        }
        "get_window_state" | "get_app_state" => {
            let window = desktop.resolve(args)?;
            if method == "get_app_state" {
                args.insert("include_text".into(), Value::Bool(true));
            }
            let (state, observation) = observe(desktop, window, args).await?;
            Ok((serde_json::to_value(state).unwrap(), Some(observation)))
        }
        _ => {
            let observe_after = args
                .get("_observe_after")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let before = if observe_after {
                Some(desktop.resolve(args)?)
            } else {
                None
            };
            mutate(desktop, method, args, observation).await?;
            // A successful mutation means the target application had a chance to
            // process the input/AT-SPI action, not merely that we queued it. This
            // also keeps raw Window2 calls deterministic when the caller observes
            // state immediately after a mutation.
            tokio::time::sleep(Duration::from_millis(320)).await;
            if let Some(before) = before {
                let window = desktop.resolve(&Map::from_iter([(
                    "window".into(),
                    serde_json::to_value(before.public).unwrap(),
                )]))?;
                let mut observe_args = Map::new();
                observe_args.insert("include_text".into(), Value::Bool(true));
                observe_args.insert("include_screenshot".into(), Value::Bool(true));
                let (state, observation) = observe(desktop, window, &observe_args).await?;
                Ok((serde_json::to_value(state).unwrap(), Some(observation)))
            } else {
                Ok((Value::Null, None))
            }
        }
    }
}

fn peer_closed(fd: i32) -> bool {
    let mut byte = [0u8; 1];
    let rc = unsafe {
        libc::recv(
            fd,
            byte.as_mut_ptr().cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    if rc == 0 {
        return true;
    }
    if rc < 0 {
        let err = std::io::Error::last_os_error();
        return !matches!(
            err.raw_os_error(),
            Some(libc::EAGAIN) | Some(libc::ENOTSOCK)
        );
    }
    false
}

async fn run_request(raw: &str, peer_fd: i32) -> NResult<Value> {
    if raw.len() > MAX_REQUEST {
        return fail("validation", "Oversized native request");
    }
    let request: Value = serde_json::from_str(raw)
        .map_err(|e| NativeError::new("validation", format!("Invalid JSON request: {e}")))?;
    let Some(obj) = request.as_object() else {
        return fail("validation", "Expected request object");
    };
    let method = string_arg(obj.get("method"), "method", 128)?;
    let args_value = obj.get("args").cloned().unwrap_or_else(|| json!({}));
    let Some(mut args) = args_value.as_object().cloned() else {
        return fail("validation", "args must be an object");
    };
    let observation = obj
        .get("observation")
        .filter(|v| !v.is_null())
        .map(|v| {
            serde_json::from_value::<Observation>(v.clone())
                .map_err(|e| NativeError::new("validation", format!("Invalid observation: {e}")))
        })
        .transpose()?;

    // Desktop routing is refreshed for every RPC. The backend process is
    // persistent, but a Sway restart creates a new epoch and environment.
    let desktop = Desktop::new()?;
    let lock_path = run_dir().join("action.lock");
    let lock = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(env_error)?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if peer_closed(peer_fd) {
            return fail("cancelled", "Caller disconnected before native dispatch");
        }
        match lock.try_lock_exclusive() {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return fail("busy", "Native desktop is busy; retry");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(env_error(error)),
        }
    }
    if peer_closed(peer_fd) {
        return fail("cancelled", "Caller disconnected before native dispatch");
    }
    let result = dispatch(&desktop, &method, &mut args, observation.as_ref()).await;
    let _ = lock.unlock();
    let (result, observation) = result?;
    Ok(json!({"ok":true,"result":result,"observation":observation}))
}

fn reply_json(result: NResult<Value>) -> String {
    let reply = match result {
        Ok(value) => value,
        Err(error) => json!({"ok":false,"error":{"code":error.code,"message":error.message}}),
    };
    serde_json::to_string(&reply).unwrap_or_else(|_| {
        "{\"ok\":false,\"error\":{\"code\":\"environment\",\"message\":\"serialization failure\"}}".into()
    })
}

async fn read_request(reader: &mut (impl AsyncBufRead + Unpin)) -> std::io::Result<String> {
    let mut raw = String::new();
    // Read one extra byte to detect overflow without buffering an unlimited line.
    reader
        .take(MAX_REQUEST as u64 + 1)
        .read_line(&mut raw)
        .await?;
    Ok(raw)
}

async fn serve_client(stream: TokioUnixStream) {
    let peer_fd = stream.as_raw_fd();
    let mut reader = TokioBufReader::new(stream);
    loop {
        let raw = match read_request(&mut reader).await {
            Ok(raw) => raw,
            Err(_) => return,
        };
        if raw.is_empty() {
            return;
        }
        let text = reply_json(run_request(&raw, peer_fd).await);
        let stream = reader.get_mut();
        if stream.write_all(text.as_bytes()).await.is_err()
            || stream.write_all(b"\n").await.is_err()
            || stream.flush().await.is_err()
        {
            return;
        }
        if raw.len() > MAX_REQUEST {
            // The remainder is not another request; do not dispatch a suffix.
            return;
        }
    }
}

fn inherited_listener() -> NResult<TokioUnixListener> {
    let pid = std::env::var("LISTEN_PID")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or_default();
    let fds = std::env::var("LISTEN_FDS")
        .ok()
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or_default();
    if pid != std::process::id() || fds < 1 {
        return fail(
            "environment",
            "No systemd listening socket was passed to native worker",
        );
    }
    // SAFETY: systemd socket activation guarantees descriptors begin at fd 3
    // and transfers ownership of the descriptor to this service process.
    let listener = unsafe { std::os::unix::net::UnixListener::from_raw_fd(3) };
    listener.set_nonblocking(true).map_err(env_error)?;
    TokioUnixListener::from_std(listener).map_err(env_error)
}

async fn serve() -> NResult<()> {
    let listener = inherited_listener()?;
    loop {
        let (stream, _) = listener.accept().await.map_err(env_error)?;
        tokio::spawn(serve_client(stream));
    }
}

async fn run_stdio() -> NResult<Value> {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut raw = String::new();
    Read::take(&mut reader, MAX_REQUEST as u64 + 1)
        .read_line(&mut raw)
        .map_err(env_error)?;
    run_request(&raw, 0).await
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let socket_activated = std::env::var("LISTEN_PID")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        == Some(std::process::id())
        && std::env::var("LISTEN_FDS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or_default()
            > 0;

    if socket_activated {
        if let Err(error) = serve().await {
            eprintln!("native worker fatal: {}: {}", error.code, error.message);
            std::process::exit(1);
        }
        return;
    }

    // Direct execution remains a one-request stdin/stdout diagnostic mode.
    println!("{}", reply_json(run_stdio().await));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_includes_descendants_holding_output_pipes() {
        let env = std::env::vars().collect::<HashMap<_, _>>();
        let start = Instant::now();
        let error = command_bytes(
            "/bin/sh",
            &["-c".into(), "sleep 5 & printf ok".into()],
            &env,
            Duration::from_millis(100),
        )
        .unwrap_err();
        assert_eq!(error.code, "timeout");
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn helper_pipe_rejects_oversize_output_without_accumulating_it() {
        let mut input = std::io::Cursor::new(vec![b'x'; 32]);
        let mut output = Vec::new();
        assert!(drain_helper_pipe(&mut input, &mut output, 8).is_err());
        assert!(output.is_empty());
    }

    #[tokio::test]
    async fn request_limit_is_enforced_before_newline_or_eof() {
        let (mut producer, consumer) = tokio::io::duplex(8192);
        let writer = tokio::spawn(async move {
            let _ = producer.write_all(&vec![b'x'; MAX_REQUEST + 1]).await;
            // Deliberately keep the stream open and never send a newline.
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let mut reader = TokioBufReader::new(consumer);
        let raw = timeout(Duration::from_secs(2), read_request(&mut reader)).await;
        writer.abort();
        let raw = raw.expect("oversize frame must not wait for EOF").unwrap();
        assert_eq!(raw.len(), MAX_REQUEST + 1);
        assert_eq!(run_request(&raw, -1).await.unwrap_err().code, "validation");
    }

    #[tokio::test]
    async fn bounded_request_reader_preserves_following_requests() {
        let mut reader = TokioBufReader::new(&b"{\"one\":1}\n{\"two\":2}\n"[..]);
        assert_eq!(read_request(&mut reader).await.unwrap(), "{\"one\":1}\n");
        assert_eq!(read_request(&mut reader).await.unwrap(), "{\"two\":2}\n");
        assert_eq!(read_request(&mut reader).await.unwrap(), "");
    }

    #[test]
    fn command_bytes_drains_large_stdout_before_child_exit() {
        let env = std::env::vars().collect::<HashMap<_, _>>();
        let head = which("head", &env).expect("head must be available on PATH");
        let bytes = command_bytes(
            head.to_str().expect("head path must be UTF-8"),
            &["-c".into(), "1048576".into(), "/dev/zero".into()],
            &env,
            Duration::from_secs(3),
        )
        .expect("large stdout must not deadlock");
        assert_eq!(bytes.len(), 1_048_576);
    }

    #[test]
    fn command_bytes_drains_large_stderr_before_child_exit() {
        let env = std::env::vars().collect::<HashMap<_, _>>();
        let bytes = command_bytes(
            "/bin/sh",
            &[
                "-c".into(),
                "head -c 1048576 /dev/zero >&2; printf ok".into(),
            ],
            &env,
            Duration::from_secs(3),
        )
        .expect("large stderr must not deadlock");
        assert_eq!(bytes, b"ok");
    }
}
