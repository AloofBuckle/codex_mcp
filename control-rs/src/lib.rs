use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use regex::Regex;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use url::Url;

#[derive(Clone, Debug)]
pub struct LoadedConfig {
    pub root: PathBuf,
    pub config_path: Option<PathBuf>,
    pub value: Value,
}

pub fn discover_root() -> Result<PathBuf> {
    if let Ok(raw) = env::var("MCPBROWSER_ROOT") {
        if !raw.is_empty() {
            let p = PathBuf::from(raw);
            if p.join("config/defaults.yaml").is_file() {
                return Ok(p.canonicalize().unwrap_or(p));
            }
        }
    }
    let mut candidates = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    for base in candidates {
        for ancestor in base.ancestors() {
            if ancestor.join("config/defaults.yaml").is_file() {
                return Ok(ancestor.to_path_buf());
            }
        }
    }
    bail!("could not locate MCPBrowser root; set MCPBROWSER_ROOT")
}

fn parse_yaml_json(path: &Path) -> Result<Value> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let y: serde_yaml::Value =
        serde_yaml::from_str(&text).with_context(|| format!("parse YAML {}", path.display()))?;
    serde_json::to_value(y).context("convert YAML to JSON value")
}

fn deep_merge(base: &mut Value, extra: &Value) {
    match (base, extra) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                match a.get_mut(k) {
                    Some(existing) => deep_merge(existing, v),
                    None => {
                        a.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (a, b) => *a = b.clone(),
    }
}

pub fn get<'a>(root: &'a Value, dotted: &str) -> Option<&'a Value> {
    let mut cur = root;
    for part in dotted.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur)
}

pub fn get_string(root: &Value, dotted: &str) -> Result<String> {
    match get(root, dotted) {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        Some(Value::Bool(v)) => Ok(v.to_string()),
        Some(Value::Null) => Ok(String::new()),
        Some(v) => Ok(serde_json::to_string(v)?),
        None => bail!("unknown configuration key {dotted}"),
    }
}

pub fn get_bool(root: &Value, dotted: &str) -> Result<bool> {
    get(root, dotted)
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("{dotted} must be boolean"))
}

pub fn get_u64(root: &Value, dotted: &str) -> Result<u64> {
    get(root, dotted)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("{dotted} must be an unsigned integer"))
}

fn set(root: &mut Value, dotted: &str, value: Value) -> Result<()> {
    let mut parts = dotted.split('.').peekable();
    let mut cur = root;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            let obj = cur
                .as_object_mut()
                .ok_or_else(|| anyhow!("configuration parent for {dotted} is not a mapping"))?;
            obj.insert(part.to_string(), value);
            return Ok(());
        }
        cur = cur
            .get_mut(part)
            .ok_or_else(|| anyhow!("unknown configuration path {dotted}"))?;
    }
    Ok(())
}

fn scalar_to_string(value: &Value) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Bool(v) => Ok(v.to_string()),
        Value::Number(v) => Ok(v.to_string()),
        Value::Null => Ok(String::new()),
        _ => bail!("configuration reference must target a scalar"),
    }
}

fn expand_string(input: &str, snapshot: &Value, root: &Path, config_dir: &Path) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            bail!("unterminated configuration reference in {input:?}");
        };
        let key = &after[..end];
        let replacement = if key == "root" {
            root.display().to_string()
        } else if key == "configDir" {
            config_dir.display().to_string()
        } else if key == "home" {
            env::var("HOME").unwrap_or_else(|_| String::from("/tmp"))
        } else if let Some(name) = key.strip_prefix("env:") {
            env::var(name)
                .with_context(|| format!("required environment variable {name} is missing"))?
        } else {
            let v = get(snapshot, key)
                .ok_or_else(|| anyhow!("unknown configuration reference {key}"))?;
            scalar_to_string(v)?
        };
        out.push_str(&replacement);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn expand_value(
    value: &mut Value,
    snapshot: &Value,
    root: &Path,
    config_dir: &Path,
) -> Result<bool> {
    let mut changed = false;
    match value {
        Value::String(s) => {
            let next = expand_string(s, snapshot, root, config_dir)?;
            if next != *s {
                *s = next;
                changed = true;
            }
        }
        Value::Array(xs) => {
            for x in xs {
                changed |= expand_value(x, snapshot, root, config_dir)?;
            }
        }
        Value::Object(map) => {
            for x in map.values_mut() {
                changed |= expand_value(x, snapshot, root, config_dir)?;
            }
        }
        _ => {}
    }
    Ok(changed)
}

fn contains_ref(value: &Value) -> bool {
    match value {
        Value::String(s) => s.contains("${"),
        Value::Array(xs) => xs.iter().any(contains_ref),
        Value::Object(m) => m.values().any(contains_ref),
        _ => false,
    }
}

fn resolve_references(value: &mut Value, root: &Path, config_dir: &Path) -> Result<()> {
    let mut seen = HashSet::new();
    for _ in 0..64 {
        let signature = serde_json::to_string(value)?;
        if !seen.insert(signature) {
            bail!("cyclic configuration reference")
        }
        let snapshot = value.clone();
        let changed = expand_value(value, &snapshot, root, config_dir)?;
        if !contains_ref(value) {
            return Ok(());
        }
        if !changed {
            bail!("unresolved configuration reference")
        }
    }
    bail!("configuration reference expansion exceeded limit")
}

fn check_shape_inner(
    selected: &Value,
    defaults: &Value,
    root_defaults: &Value,
    prefix: &str,
) -> Result<()> {
    let Some(sel) = selected.as_object() else {
        bail!("selected configuration must be a mapping")
    };
    let Some(def) = defaults.as_object() else {
        bail!("defaults configuration must be a mapping")
    };
    for (key, value) in sel {
        let name = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if name == "nativeSystem.environment" {
            let Some(m) = value.as_object() else {
                bail!("{name} must be a mapping")
            };
            for (k, v) in m {
                if k.is_empty() || !v.is_string() {
                    bail!("{name} must map environment names to strings")
                }
            }
            continue;
        }
        let Some(sample) = def.get(key) else {
            bail!("unknown configuration field {name}")
        };
        match (value, sample) {
            (Value::Object(_), Value::Object(_)) => {
                let shape = if name == "nativeBrowser.browser" {
                    root_defaults
                        .get("browser")
                        .ok_or_else(|| anyhow!("defaults.browser is missing"))?
                } else {
                    sample
                };
                check_shape_inner(value, shape, root_defaults, &name)?
            }
            (Value::Array(_), Value::Array(_)) => {}
            (Value::Null, Value::Null) => {}
            (Value::String(_), Value::String(_)) => {}
            (Value::Bool(_), Value::Bool(_)) => {}
            (Value::Number(_), Value::Number(_)) => {}
            (_, Value::Null) if value.is_string() => {}
            _ => bail!("configuration field {name} has the wrong type"),
        }
    }
    Ok(())
}

fn check_shape(selected: &Value, defaults: &Value, prefix: &str) -> Result<()> {
    check_shape_inner(selected, defaults, defaults, prefix)
}

fn convert_env(raw: &str, sample: &Value) -> Result<Value> {
    Ok(match sample {
        Value::Bool(_) => {
            let v = match raw.to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => true,
                "0" | "false" | "no" | "off" => false,
                _ => bail!("invalid boolean {raw:?}"),
            };
            Value::Bool(v)
        }
        Value::Number(n) if n.is_i64() => Value::from(raw.parse::<i64>()?),
        Value::Number(_) => Value::from(raw.parse::<f64>()?),
        Value::Array(_) | Value::Object(_) => serde_json::from_str(raw)?,
        _ => Value::String(raw.to_string()),
    })
}

fn apply_legacy_env(root: &Path, value: &mut Value) -> Result<()> {
    let path = root.join("config/environment.yaml");
    let mapping = parse_yaml_json(&path)?;
    let Some(map) = mapping.as_object() else {
        bail!("environment mapping must be a mapping")
    };
    for (name, key_value) in map {
        let Some(key) = key_value.as_str() else {
            continue;
        };
        let Ok(raw) = env::var(name) else { continue };
        if raw.is_empty() {
            continue;
        }
        let sample = get(value, key)
            .ok_or_else(|| anyhow!("environment mapping targets unknown key {key}"))?;
        set(value, key, convert_env(&raw, sample)?)?;
    }
    if let Ok(raw) = env::var("CUA_HEADFUL") {
        let v = matches!(
            raw.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        );
        set(value, "browser.headless", Value::Bool(!v))?;
    }
    Ok(())
}

fn resolve_path(config_dir: &Path, raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf().display().to_string()
    } else {
        config_dir.join(p).display().to_string()
    }
}

fn resolve_paths(config: &mut Value, config_dir: &Path) -> Result<()> {
    const FILE_PATHS: &[&str] = &[
        "rootDir",
        "runtimeDir",
        "artifactsDir",
        "outputDir",
        "profilesDir",
        "downloadsDir",
        "tmpDir",
        "logFile",
        "gui.publicDir",
        "gui.tokenFile",
        "gui.tls.certFile",
        "gui.tls.keyFile",
        "extension.extensionDir",
        "extension.socketPath",
        "native.socketPath",
        "native.environmentFile",
        "nativeSystem.runDir",
        "nativeSystem.stateDir",
        "nativeSystem.kwinLibraryPath",
        "nativeShell.configDir",
        "nativeShell.wlrootsIncludeDir",
        "deployment.unitsDir",
        "deployment.libexecDir",
        "deployment.controlBinary",
        "deployment.buildDir",
        "nativeBrowser.configPath",
        "nativeBrowser.profilesDir",
        "nativeBrowser.downloadsDir",
        "nativeBrowser.tmpDir",
        "nativeBrowser.logFile",
        "nativePlasma.refreshShim",
        "nativePlasma.environmentFile",
        "nativePlasma.audioRuntimeDir",
        "nativePlasma.configDir",
        "nativePlasma.dataDir",
        "nativePlasma.cacheDir",
        "testing.extensionChrome",
    ];
    for key in FILE_PATHS {
        if let Some(Value::String(raw)) = get(config, key).cloned() {
            if !raw.is_empty() {
                set(config, key, Value::String(resolve_path(config_dir, &raw)))?;
            }
        }
    }
    if let Some(Value::String(raw)) = get(config, "nativeSystem.kwinBinary").cloned() {
        if raw.contains('/') {
            set(
                config,
                "nativeSystem.kwinBinary",
                Value::String(resolve_path(config_dir, &raw)),
            )?;
        }
    }
    if let Some(tools) = get(config, "tools").and_then(Value::as_object).cloned() {
        for (key, value) in tools {
            if key == "chromeCandidates" {
                continue;
            }
            if let Value::String(raw) = value {
                if raw.contains('/') {
                    set(
                        config,
                        &format!("tools.{key}"),
                        Value::String(resolve_path(config_dir, &raw)),
                    )?;
                }
            }
        }
    }
    if let Some(Value::Array(xs)) = get(config, "extension.nativeHostRoots").cloned() {
        set(
            config,
            "extension.nativeHostRoots",
            Value::Array(
                xs.into_iter()
                    .map(|v| match v {
                        Value::String(s) => Value::String(resolve_path(config_dir, &s)),
                        other => other,
                    })
                    .collect(),
            ),
        )?;
    }
    if let Some(Value::Array(xs)) = get(config, "tools.chromeCandidates").cloned() {
        set(
            config,
            "tools.chromeCandidates",
            Value::Array(
                xs.into_iter()
                    .map(|v| match v {
                        Value::String(s) if s.contains('/') => {
                            Value::String(resolve_path(config_dir, &s))
                        }
                        other => other,
                    })
                    .collect(),
            ),
        )?;
    }
    Ok(())
}

pub fn find_executable(command: &str) -> Option<PathBuf> {
    if command.is_empty() {
        return None;
    }
    if command.contains('/') {
        let p = PathBuf::from(command);
        return is_executable(&p).then_some(p);
    }
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let p = dir.join(command);
        if is_executable(&p) {
            return Some(p);
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.is_file() && (m.permissions().mode() & 0o111) != 0)
        .unwrap_or(false)
}

pub fn extension_id_from_manifest_key(key: &str) -> Result<Option<String>> {
    let normalized: String = key.chars().filter(|c| !c.is_whitespace()).collect();
    if normalized.is_empty() {
        return Ok(None);
    }
    let der = base64::engine::general_purpose::STANDARD
        .decode(normalized.as_bytes())
        .context("extension.manifestKey must be base64 DER public-key data")?;
    let hex = format!("{:x}", Sha256::digest(der));
    let id: String = hex[..32]
        .chars()
        .map(|c| {
            let n = c.to_digit(16).unwrap();
            char::from_u32('a' as u32 + n).unwrap()
        })
        .collect();
    Ok(Some(id))
}

fn number(config: &Value, key: &str) -> Result<f64> {
    get(config, key)
        .and_then(Value::as_f64)
        .ok_or_else(|| anyhow!("{key} must be numeric"))
}

fn bounded(config: &Value, key: &str, min: i64, max: i64) -> Result<()> {
    let value = number(config, key)?;
    if !value.is_finite() || value.fract() != 0.0 || value < min as f64 || value > max as f64 {
        bail!("{key} must be an integer in {min}..{max}")
    }
    Ok(())
}

fn optional_bounded(config: &Value, key: &str, min: i64, max: i64) -> Result<()> {
    let Some(value) = get(config, key) else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    bounded(config, key, min, max)
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

fn validate_string_array(config: &Value, key: &str) -> Result<()> {
    let Some(values) = get(config, key).and_then(Value::as_array) else {
        bail!("{key} must be an array")
    };
    for value in values {
        let Some(value) = value.as_str() else {
            bail!("{key} must contain only strings without control characters")
        };
        if value.chars().any(|c| matches!(c, '\r' | '\n' | '\0')) {
            bail!("{key} must contain only strings without control characters")
        }
    }
    Ok(())
}

fn validate_http_origin(config: &Value, key: &str) -> Result<()> {
    let value = get_string(config, key)?;
    if value.is_empty() {
        return Ok(());
    }
    let url = Url::parse(&value).with_context(|| format!("{key} must be an HTTP(S) origin"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("{key} must be an HTTP(S) origin without credentials/path")
    }
    if url.scheme() == "http"
        && !url.host_str().is_some_and(is_loopback)
        && !get_bool(config, "gui.allowInsecureRemote")?
    {
        bail!("{key}: remote HTTP requires explicit gui.allowInsecureRemote; prefer built-in TLS")
    }
    Ok(())
}

pub fn validate(config: &Value) -> Result<()> {
    if get_u64(config, "schemaVersion")? != 1 {
        bail!("unsupported schemaVersion")
    }
    for key in ["gui.port", "nativeLive.port"] {
        bounded(config, key, 0, 65535)?;
    }
    for scope in [
        "browser.viewport",
        "browser.surface",
        "browser.xvfbScreen",
        "nativeSystem",
    ] {
        for axis in ["width", "height"] {
            bounded(config, &format!("{scope}.{axis}"), 200, 16384)?;
        }
    }
    bounded(config, "nativeSystem.fps", 1, 240)?;
    bounded(config, "nativeLive.maxFps", 1, 240)?;
    bounded(
        config,
        "nativeLive.idleFps",
        0,
        number(config, "nativeLive.maxFps")? as i64,
    )?;
    for profile in ["browser", "native"] {
        let base = format!("video.{profile}");
        if get_string(config, &format!("{base}.codec"))? != "av1" {
            bail!("{base}.codec must be av1")
        }
        bounded(config, &format!("{base}.gop.pictures"), 1, 65535)?;
        bounded(config, &format!("{base}.gop.refDistance"), 1, 65535)?;
        bounded(config, &format!("{base}.gop.idrInterval"), 0, 65535)?;
        if number(config, &format!("{base}.gop.refDistance"))?
            > number(config, &format!("{base}.gop.pictures"))?
        {
            bail!("{base}.gop.refDistance must be <= pictures")
        }
        if !get(config, &format!("{base}.gop.strict")).is_some_and(Value::is_boolean) {
            bail!("{base}.gop.strict must be boolean")
        }
        let mode = get_string(config, &format!("{base}.rateControl.mode"))?;
        if !matches!(mode.as_str(), "cbr" | "vbr" | "cqp" | "icq") {
            bail!("{base}.rateControl.mode must be cbr, vbr, cqp or icq")
        }
        let selectable = get(
            config,
            &format!("{base}.oneVplCapabilities.selectableModes"),
        )
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("{base}.oneVplCapabilities.selectableModes must be an array"))?;
        if !selectable.iter().any(|value| value.as_str() == Some(&mode)) {
            bail!("{base}.rateControl.mode is not reported by oneVPL")
        }
        bounded(config, &format!("{base}.rateControl.targetUsage"), 1, 7)?;
        bounded(
            config,
            &format!("{base}.rateControl.cbr.targetKbps"),
            100,
            200000,
        )?;
        bounded(
            config,
            &format!("{base}.rateControl.cbr.bufferFrames"),
            1,
            16,
        )?;
        bounded(
            config,
            &format!("{base}.rateControl.cbr.initialDelayFrames"),
            0,
            16,
        )?;
        optional_bounded(
            config,
            &format!("{base}.rateControl.cbr.bufferSizeKb"),
            1,
            1_000_000,
        )?;
        optional_bounded(
            config,
            &format!("{base}.rateControl.cbr.initialDelayKb"),
            0,
            1_000_000,
        )?;
        if let (Some(buffer), Some(delay)) = (
            get(config, &format!("{base}.rateControl.cbr.bufferSizeKb")).and_then(Value::as_f64),
            get(config, &format!("{base}.rateControl.cbr.initialDelayKb")).and_then(Value::as_f64),
        ) {
            if delay > buffer {
                bail!("{base}.rateControl.cbr.initialDelayKb must be <= bufferSizeKb")
            }
        }
        bounded(
            config,
            &format!("{base}.rateControl.vbr.targetKbps"),
            100,
            200000,
        )?;
        bounded(
            config,
            &format!("{base}.rateControl.vbr.maxKbps"),
            100,
            200000,
        )?;
        if number(config, &format!("{base}.rateControl.vbr.maxKbps"))?
            < number(config, &format!("{base}.rateControl.vbr.targetKbps"))?
        {
            bail!("{base}.rateControl.vbr.maxKbps must be >= targetKbps")
        }
        bounded(
            config,
            &format!("{base}.rateControl.vbr.bufferFrames"),
            1,
            16,
        )?;
        bounded(
            config,
            &format!("{base}.rateControl.vbr.initialDelayFrames"),
            0,
            16,
        )?;
        optional_bounded(
            config,
            &format!("{base}.rateControl.vbr.bufferSizeKb"),
            1,
            1_000_000,
        )?;
        optional_bounded(
            config,
            &format!("{base}.rateControl.vbr.initialDelayKb"),
            0,
            1_000_000,
        )?;
        if let (Some(buffer), Some(delay)) = (
            get(config, &format!("{base}.rateControl.vbr.bufferSizeKb")).and_then(Value::as_f64),
            get(config, &format!("{base}.rateControl.vbr.initialDelayKb")).and_then(Value::as_f64),
        ) {
            if delay > buffer {
                bail!("{base}.rateControl.vbr.initialDelayKb must be <= bufferSizeKb")
            }
        }
        optional_bounded(
            config,
            &format!("{base}.rateControl.vbr.maxFrameSizeIBytes"),
            1,
            10_000_000,
        )?;
        optional_bounded(
            config,
            &format!("{base}.rateControl.vbr.maxFrameSizePBytes"),
            1,
            10_000_000,
        )?;
        let max_i = get(
            config,
            &format!("{base}.rateControl.vbr.maxFrameSizeIBytes"),
        );
        let max_p = get(
            config,
            &format!("{base}.rateControl.vbr.maxFrameSizePBytes"),
        );
        if max_p.is_some_and(|v| !v.is_null()) && !max_i.is_some_and(|v| !v.is_null()) {
            bail!(
                "{base}.rateControl.vbr.maxFrameSizeIBytes is required when maxFrameSizePBytes is set"
            )
        }
        if !get(config, &format!("{base}.rateControl.vbr.lowDelayBrc"))
            .is_some_and(Value::is_boolean)
        {
            bail!("{base}.rateControl.vbr.lowDelayBrc must be boolean")
        }
        for key in ["qpi", "qpp", "qpb"] {
            bounded(config, &format!("{base}.rateControl.cqp.{key}"), 0, 255)?;
        }
        bounded(config, &format!("{base}.rateControl.icq.quality"), 1, 51)?;
    }
    bounded(config, "video.native.oneVpl.vendorImplId", 0, 65535)?;
    for key in ["nativeSystem.scale", "nativePlasma.scale"] {
        let value = number(config, key)?;
        if !value.is_finite() || !(0.5..=4.0).contains(&value) {
            bail!("{key} must be in 0.5..4")
        }
    }
    bounded(config, "viewer.screenshotIntervalMs", 100, 60000)?;
    bounded(config, "viewer.tokenTtlSec", 300, 7200)?;
    if ![16.0, 24.0, 32.0].contains(&number(config, "browser.xvfbScreen.depth")?) {
        bail!("browser.xvfbScreen.depth must be 16, 24 or 32")
    }
    let native_live_host = get_string(config, "nativeLive.host")?;
    if !is_loopback(&native_live_host) {
        bail!(
            "nativeLive.host must remain loopback; expose authenticated signaling through the GUI listener"
        )
    }
    if get_bool(config, "nativeLive.enabled")?
        && get_string(config, "nativeLive.publicHost")?.is_empty()
    {
        bail!("nativeLive.publicHost is required when Native Live is enabled")
    }
    let rtc_bind = get_string(config, "nativeLive.rtcBind")?;
    if !Regex::new(r"^([^\s:]+|\[[0-9a-fA-F:]+\]):\d+$")?.is_match(&rtc_bind) {
        bail!("nativeLive.rtcBind must be host:port or [IPv6]:port")
    }
    if get_string(config, "nativeSystem.desktopUnit")?
        != get_string(config, "deployment.units.desktop")?
    {
        bail!("nativeSystem.desktopUnit and deployment.units.desktop must match")
    }
    if !Regex::new(r"^[-A-Za-z0-9_.]+-$")?.is_match(&get_string(config, "nativeSystem.appPrefix")?)
    {
        bail!("nativeSystem.appPrefix must be a unit-safe prefix ending with a hyphen")
    }
    for key in [
        "gui.allowedHosts",
        "gui.allowedOrigins",
        "viewer.frameAncestors",
        "extension.nativeHostRoots",
        "tools.chromeCandidates",
        "browser.args",
        "nativeShell.launcher",
        "nativeShell.terminalArgs",
        "nativeShell.fileManagerArgs",
    ] {
        validate_string_array(config, key)?;
    }
    for ancestor in get(config, "viewer.frameAncestors")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("viewer.frameAncestors must be an array"))?
    {
        let ancestor = ancestor
            .as_str()
            .ok_or_else(|| anyhow!("viewer.frameAncestors must contain strings"))?;
        if matches!(ancestor, "'self'" | "'none'") {
            continue;
        }
        let url = Url::parse(ancestor).context("invalid viewer.frameAncestors origin")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.origin().ascii_serialization() != ancestor
        {
            bail!("viewer.frameAncestors must contain origins or quoted self/none")
        }
    }
    for key in [
        "repl.timeoutMs",
        "repl.maxTimeoutMs",
        "native.timeoutMs",
        "extension.requestTimeoutMs",
    ] {
        bounded(config, key, 1, 3_600_000)?;
    }
    bounded(config, "repl.maxQueuedCalls", 1, 1024)?;
    bounded(config, "repl.maxOutputBlocks", 1, 4096)?;
    for key in [
        "repl.maxTextChars",
        "repl.maxImageBytes",
        "repl.maxOutputBytes",
        "security.maxAssetBytes",
        "security.maxBundleBytes",
        "security.maxClipboardBytes",
    ] {
        bounded(config, key, 1, 1024 * 1024 * 1024)?;
    }
    if number(config, "repl.timeoutMs")? > number(config, "repl.maxTimeoutMs")? {
        bail!("repl.timeoutMs exceeds repl.maxTimeoutMs")
    }
    if !matches!(
        get_string(config, "webmcp.nativeArguments")?.as_str(),
        "object" | "json"
    ) {
        bail!("webmcp.nativeArguments must be object or json")
    }
    let viewer_mode = get_string(config, "viewer.mode")?;
    if !matches!(viewer_mode.as_str(), "standalone" | "external") {
        bail!("viewer.mode must be standalone or external")
    }
    if viewer_mode == "external" && get_string(config, "viewer.publicOrigin")?.is_empty() {
        bail!("viewer.publicOrigin is required in external mode")
    }
    validate_http_origin(config, "gui.publicOrigin")?;
    validate_http_origin(config, "viewer.publicOrigin")?;
    let gui_host = get_string(config, "gui.host")?;
    if !is_loopback(&gui_host)
        && !get_bool(config, "gui.tls.enabled")?
        && !get_bool(config, "gui.allowInsecureRemote")?
    {
        bail!("Non-loopback HTTP requires TLS or explicit gui.allowInsecureRemote")
    }
    if get_bool(config, "gui.tls.enabled")?
        && (get_string(config, "gui.tls.certFile")?.is_empty()
            || get_string(config, "gui.tls.keyFile")?.is_empty())
    {
        bail!("TLS requires gui.tls.certFile and gui.tls.keyFile")
    }
    let base_path = get_string(config, "gui.basePath")?;
    if !Regex::new(r"^$|^/[A-Za-z0-9_/-]*[A-Za-z0-9_-]$")?.is_match(&base_path)
        || base_path.contains("//")
        || base_path.contains("..")
    {
        bail!("gui.basePath must be empty or /path without a trailing slash")
    }
    for key in ["viewer.path", "nativeLive.publicPath"] {
        let value = get_string(config, key)?;
        if !Regex::new(r"^/[A-Za-z0-9_/-]+/$")?.is_match(&value) || value.contains("//") {
            bail!("{key} must be an absolute /path/")
        }
    }
    let user_re = Regex::new(r"^[a-z_][a-z0-9_-]*[$]?$|^[0-9]+$")?;
    let group_re = Regex::new(r"^[a-z_][a-z0-9_-]*$|^[0-9]+$")?;
    if !user_re.is_match(&get_string(config, "deployment.user")?)
        || !group_re.is_match(&get_string(config, "deployment.group")?)
    {
        bail!("invalid deployment user/group")
    }
    let unit_re = Regex::new(r"^[A-Za-z0-9_.@-]+\.(service|socket)$")?;
    let units = get(config, "deployment.units")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("deployment.units must be a mapping"))?;
    for value in units.values() {
        let Some(value) = value.as_str() else {
            bail!("invalid systemd unit name")
        };
        if !unit_re.is_match(value) {
            bail!("invalid systemd unit name")
        }
    }
    let simple_name = Regex::new(r"^[A-Za-z0-9_-]+$")?;
    for key in [
        "nativeSystem.output",
        "nativeSystem.seat",
        "browser.profileName",
        "nativePlasma.socketName",
    ] {
        if !simple_name.is_match(&get_string(config, key)?) {
            bail!("invalid value for {key}")
        }
    }
    if !Regex::new(r"^[a-z0-9_]+(?:\.[a-z0-9_]+)*$")?
        .is_match(&get_string(config, "extension.hostName")?)
    {
        bail!("invalid extension native host name")
    }
    let ext_id = get_string(config, "extension.extensionId")?;
    let ext_key = get_string(config, "extension.manifestKey")?;
    let derived = extension_id_from_manifest_key(&ext_key)?;
    if ext_id == "auto" && derived.is_none() {
        bail!("extension.manifestKey is required when extension.extensionId is auto")
    }
    if !ext_id.is_empty() && ext_id != "auto" {
        if ext_id.len() != 32 || !ext_id.chars().all(|c| ('a'..='p').contains(&c)) {
            bail!("extension.extensionId must be empty, auto, or a Chrome extension ID")
        }
        if let Some(derived) = &derived {
            if &ext_id != derived {
                bail!("extension.extensionId does not match extension.manifestKey")
            }
        }
    }
    if (get_bool(config, "extension.enabled")? || get_bool(config, "extension.autoLoad")?)
        && ext_id.is_empty()
    {
        bail!(
            "extension.enabled/autoLoad requires extension.manifestKey or extension.extensionId in deployment YAML"
        )
    }
    for axis in ["width", "height"] {
        bounded(config, &format!("nativePlasma.{axis}"), 200, 16384)?;
    }
    bounded(config, "nativePlasma.refreshHz", 1, 240)?;
    Ok(())
}

pub fn load_config(root: &Path, selected: Option<&Path>) -> Result<LoadedConfig> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let defaults_path = root.join("config/defaults.yaml");
    let defaults = parse_yaml_json(&defaults_path)?;
    let explicit_env = env::var("CUA_CONFIG")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let explicit = selected.map(Path::to_path_buf).or(explicit_env);
    let config_path = if let Some(path) = explicit {
        let resolved = if path.is_absolute() {
            path
        } else {
            env::current_dir()?.join(path)
        };
        if !resolved.exists() {
            bail!("config file does not exist: {}", resolved.display());
        }
        Some(resolved)
    } else {
        ["cua.config.yaml", "cua.config.yml", "cua.config.json"]
            .into_iter()
            .map(|name| root.join(name))
            .find(|p| p.exists())
    };
    let legacy = config_path
        .as_ref()
        .is_some_and(|path| path.extension().and_then(|x| x.to_str()) == Some("json"));
    let mut base = defaults.clone();
    if legacy {
        let compatibility = root.join("config/local-compatibility.yaml");
        if compatibility.exists() {
            let compatibility = parse_yaml_json(&compatibility)?;
            deep_merge(&mut base, &compatibility);
        }
    }
    let mut merged = base;
    apply_legacy_env(&root, &mut merged)?;
    if let Some(path) = &config_path {
        let selected_value = parse_yaml_json(path)?;
        if !legacy {
            check_shape(&selected_value, &defaults, "")?;
        }
        deep_merge(&mut merged, &selected_value);
    }
    let config_dir = config_path
        .as_deref()
        .and_then(Path::parent)
        .unwrap_or(&root)
        .to_path_buf();
    resolve_references(&mut merged, &root, &config_dir)?;
    resolve_paths(&mut merged, &config_dir)?;

    if get_string(&merged, "tools.node")? == "auto" {
        let mut node = None;
        for candidate in ["node-24", "node"] {
            let Some(path) = find_executable(candidate) else {
                continue;
            };
            let is_node_24 = Command::new(&path)
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .trim_start_matches('v')
                        .starts_with("24.")
                })
                .unwrap_or(false);
            if is_node_24 {
                node = Some(path);
                break;
            }
        }
        let node = node
            .or_else(|| find_executable("node"))
            .unwrap_or_else(|| PathBuf::from("node"));
        set(
            &mut merged,
            "tools.node",
            Value::String(node.display().to_string()),
        )?;
    }
    if get_string(&merged, "browser.executablePath")? == "auto" {
        let mut chosen = None;
        if let Some(xs) = get(&merged, "tools.chromeCandidates").and_then(Value::as_array) {
            for value in xs {
                if let Some(s) = value.as_str() {
                    if let Some(path) = find_executable(s) {
                        chosen = Some(path.display().to_string());
                        break;
                    }
                    chosen = Some(s.to_string());
                }
            }
        }
        if let Some(chosen) = chosen {
            set(&mut merged, "browser.executablePath", Value::String(chosen))?;
        }
    }
    let ext_key = get_string(&merged, "extension.manifestKey")?;
    let ext_id = get_string(&merged, "extension.extensionId")?;
    let derived = extension_id_from_manifest_key(&ext_key)?;
    if ext_id == "auto" || (ext_id.is_empty() && derived.is_some()) {
        if let Some(id) = derived {
            set(&mut merged, "extension.extensionId", Value::String(id))?;
        }
    }
    validate(&merged)?;
    Ok(LoadedConfig {
        root,
        config_path,
        value: merged,
    })
}

fn env_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(v) => Some(if *v { "true" } else { "false" }.into()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i.to_string())
            } else if let Some(u) = n.as_u64() {
                Some(u.to_string())
            } else if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 {
                    Some(format!("{f:.0}"))
                } else {
                    Some(f.to_string())
                }
            } else {
                Some(n.to_string())
            }
        }
        other => serde_json::to_string(other).ok(),
    }
}

fn insert_env(
    out: &mut BTreeMap<String, String>,
    name: &str,
    config: &Value,
    key: &str,
) -> Result<()> {
    if let Some(value) = get(config, key).and_then(env_string) {
        out.insert(name.to_string(), value);
    }
    Ok(())
}

fn tool_env_name(key: &str) -> String {
    let mut out = String::from("MCPBROWSER_TOOL_");
    for ch in key.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch);
        } else {
            out.push(ch.to_ascii_uppercase());
        }
    }
    out
}

pub fn native_environment(config: &LoadedConfig) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    if let Some(map) = get(&config.value, "nativeSystem.environment").and_then(Value::as_object) {
        for (key, value) in map {
            if let Some(value) = value.as_str() {
                out.insert(key.clone(), value.to_string());
            }
        }
    }
    insert_env(&mut out, "MCPBROWSER_ROOT", &config.value, "rootDir")?;
    out.insert(
        "CUA_CONFIG".into(),
        config
            .config_path
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    );
    for (name, key) in [
        ("MCPBROWSER_NATIVE_RUN", "nativeSystem.runDir"),
        ("MCPBROWSER_NATIVE_STATE", "nativeSystem.stateDir"),
        ("MCPBROWSER_NATIVE_WIDTH", "nativeSystem.width"),
        ("MCPBROWSER_NATIVE_HEIGHT", "nativeSystem.height"),
        ("MCPBROWSER_NATIVE_FPS", "nativeSystem.fps"),
        ("MCPBROWSER_NATIVE_SCALE", "nativeSystem.scale"),
        ("MCPBROWSER_NATIVE_OUTPUT", "nativeSystem.output"),
        ("MCPBROWSER_NATIVE_SEAT", "nativeSystem.seat"),
        ("MCPBROWSER_NATIVE_RENDER_NODE", "nativeSystem.renderNode"),
        ("MCPBROWSER_NATIVE_RENDERER", "nativeSystem.renderer"),
        ("MCPBROWSER_NATIVE_KWIN", "nativeSystem.kwinBinary"),
        (
            "MCPBROWSER_NATIVE_KWIN_LIBRARY_PATH",
            "nativeSystem.kwinLibraryPath",
        ),
        (
            "MCPBROWSER_NATIVE_CAPTURE_MODIFIER",
            "nativeSystem.captureModifier",
        ),
        (
            "MCPBROWSER_NATIVE_WAYLAND_SOCKET",
            "nativePlasma.socketName",
        ),
        ("MCPBROWSER_CUA_INPUT_SOCKET", "nativeSystem.inputSocket"),
        ("MCPBROWSER_NATIVE_DESKTOP_UNIT", "nativeSystem.desktopUnit"),
        ("MCPBROWSER_NATIVE_APP_PREFIX", "nativeSystem.appPrefix"),
        ("MCPBROWSER_NATIVE_ATSPI_REGISTRY", "tools.atspiRegistry"),
        ("MCPBROWSER_NATIVE_LIVE_RTC_BIND", "nativeLive.rtcBind"),
        (
            "MCPBROWSER_NATIVE_LIVE_RTC_PUBLIC_HOST",
            "nativeLive.publicHost",
        ),
        ("MCPBROWSER_NATIVE_LIVE_CODEC", "video.native.codec"),
        ("MCPBROWSER_NATIVE_LIVE_MAX_FPS", "nativeLive.maxFps"),
        ("MCPBROWSER_NATIVE_LIVE_IDLE_FPS", "nativeLive.idleFps"),
        (
            "MCPBROWSER_NATIVE_LIVE_RC_MODE",
            "video.native.rateControl.mode",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_TARGET_USAGE",
            "video.native.rateControl.targetUsage",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_CBR_TARGET_KBPS",
            "video.native.rateControl.cbr.targetKbps",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_CBR_BUFFER_FRAMES",
            "video.native.rateControl.cbr.bufferFrames",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_CBR_INITIAL_DELAY_FRAMES",
            "video.native.rateControl.cbr.initialDelayFrames",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_VBR_TARGET_KBPS",
            "video.native.rateControl.vbr.targetKbps",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_VBR_MAX_KBPS",
            "video.native.rateControl.vbr.maxKbps",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_VBR_BUFFER_FRAMES",
            "video.native.rateControl.vbr.bufferFrames",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_VBR_INITIAL_DELAY_FRAMES",
            "video.native.rateControl.vbr.initialDelayFrames",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_CQP_QPI",
            "video.native.rateControl.cqp.qpi",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_CQP_QPP",
            "video.native.rateControl.cqp.qpp",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_CQP_QPB",
            "video.native.rateControl.cqp.qpb",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_ICQ_QUALITY",
            "video.native.rateControl.icq.quality",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_BITRATE_KBPS",
            "video.native.rateControl.vbr.targetKbps",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_MAX_BITRATE_KBPS",
            "video.native.rateControl.vbr.maxKbps",
        ),
        ("MCPBROWSER_NATIVE_LIVE_MAX_LAG_MS", "nativeLive.maxLagMs"),
        (
            "MCPBROWSER_PLASMA_ENVIRONMENT_FILE",
            "nativePlasma.environmentFile",
        ),
        (
            "MCPBROWSER_PLASMA_AUDIO_RUNTIME",
            "nativePlasma.audioRuntimeDir",
        ),
        ("MCPBROWSER_PLASMA_CONFIG_DIR", "nativePlasma.configDir"),
        ("MCPBROWSER_PLASMA_DATA_DIR", "nativePlasma.dataDir"),
        ("MCPBROWSER_PLASMA_CACHE_DIR", "nativePlasma.cacheDir"),
    ] {
        insert_env(&mut out, name, &config.value, key)?;
    }
    let host = get_string(&config.value, "nativeLive.host")?;
    let port = get_u64(&config.value, "nativeLive.port")?;
    out.insert(
        "MCPBROWSER_NATIVE_LIVE_LISTEN".into(),
        if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        },
    );
    let render = get_string(&config.value, "nativeSystem.renderNode")?;
    let capture = get_string(&config.value, "nativeLive.captureNode")?;
    let encoder = get_string(&config.value, "nativeLive.encoderNode")?;
    out.insert(
        "MCPBROWSER_NATIVE_LIVE_CAPTURE_NODE".into(),
        if capture.is_empty() {
            render.clone()
        } else {
            capture
        },
    );
    out.insert(
        "MCPBROWSER_NATIVE_LIVE_ENCODER_NODE".into(),
        if encoder.is_empty() { render } else { encoder },
    );
    out.insert(
        "MCPBROWSER_NATIVE_LIVE_VBR_LOW_DELAY_BRC".into(),
        if get_bool(&config.value, "video.native.rateControl.vbr.lowDelayBrc")? {
            "1"
        } else {
            "0"
        }
        .into(),
    );
    out.insert(
        "MCPBROWSER_NATIVE_LIVE_NV12_REUSE".into(),
        if get_bool(&config.value, "nativeLive.nv12Reuse")? {
            "1"
        } else {
            "0"
        }
        .into(),
    );
    for (name, key) in [
        (
            "MCPBROWSER_NATIVE_LIVE_CBR_BUFFER_SIZE_KB",
            "video.native.rateControl.cbr.bufferSizeKb",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_CBR_INITIAL_DELAY_KB",
            "video.native.rateControl.cbr.initialDelayKb",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_VBR_BUFFER_SIZE_KB",
            "video.native.rateControl.vbr.bufferSizeKb",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_VBR_INITIAL_DELAY_KB",
            "video.native.rateControl.vbr.initialDelayKb",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_VBR_MAX_FRAME_SIZE_I_BYTES",
            "video.native.rateControl.vbr.maxFrameSizeIBytes",
        ),
        (
            "MCPBROWSER_NATIVE_LIVE_VBR_MAX_FRAME_SIZE_P_BYTES",
            "video.native.rateControl.vbr.maxFrameSizePBytes",
        ),
    ] {
        if let Some(value) = get(&config.value, key)
            .filter(|value| !value.is_null())
            .and_then(env_string)
        {
            out.insert(name.into(), value);
        }
    }
    let libva = get_string(&config.value, "nativeSystem.libvaDriver")?;
    if !libva.is_empty() {
        out.insert("LIBVA_DRIVER_NAME".into(), libva);
    }
    if let Some(tools) = get(&config.value, "tools").and_then(Value::as_object) {
        for (key, value) in tools {
            if let Some(value) = value.as_str() {
                out.insert(tool_env_name(key), value.to_string());
            }
        }
    }
    Ok(out)
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    Ok(())
}

pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    ensure_parent(path)?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    let mut permissions = fs::metadata(&tmp)?.permissions();
    permissions.set_mode(mode);
    fs::set_permissions(&tmp, permissions)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn object() -> Value {
    Value::Object(Map::new())
}

pub mod package;
