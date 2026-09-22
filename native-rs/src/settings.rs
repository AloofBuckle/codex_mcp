//! Native processes receive YAML-derived values from mcpbrowserctl. Direct
//! invocation falls back to the same Rust YAML loader; no shell/Node adapter
//! or build-host defaults are embedded.
use anyhow::{Context, Result};
use mcpbrowser_control::{discover_root, get, load_config, native_environment};
use serde_yaml::Value;
use std::{collections::BTreeMap, path::PathBuf, sync::OnceLock};

fn resolved_environment() -> &'static BTreeMap<String, String> {
    static ENVIRONMENT: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    ENVIRONMENT.get_or_init(|| {
        let root = discover_root().expect("locate MCPBrowser root");
        let selected = std::env::var("CUA_CONFIG")
            .ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let config = load_config(&root, selected.as_deref()).expect("load MCPBrowser YAML");
        native_environment(&config).expect("resolve Native environment from YAML")
    })
}

pub fn setting(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| resolved_environment().get(name).cloned())
        .unwrap_or_default()
}

pub fn tool(name: &str) -> String {
    if name.contains('/') {
        return name.into();
    }
    let key = format!("MCPBROWSER_TOOL_{}", name.replace('-', "_").to_uppercase());
    let value = setting(&key);
    if value.is_empty() { name.into() } else { value }
}

/// Read the shared YAML directly through the Rust control-plane loader.
pub fn video_profile(profile: &str) -> Result<Option<Value>> {
    let root = discover_root().context("resolve mcpbrowser root")?;
    let selected = std::env::var("CUA_CONFIG")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let config = load_config(&root, selected.as_deref())?;
    let value = get(&config.value, &format!("video.{profile}"))
        .ok_or_else(|| anyhow::anyhow!("shared YAML is missing video.{profile}"))?;
    Ok(Some(serde_yaml::to_value(value)?))
}
