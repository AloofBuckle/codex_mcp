pub mod live;
pub mod settings;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub fn desktop_unit() -> String {
    settings::setting("MCPBROWSER_NATIVE_DESKTOP_UNIT")
}
pub fn app_prefix() -> String {
    settings::setting("MCPBROWSER_NATIVE_APP_PREFIX")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopInfo {
    pub env: HashMap<String, String>,
    pub pid: u32,
    pub epoch: String,
    pub width: u32,
    pub height: u32,
    pub renderer: String,
    #[serde(rename = "renderNode")]
    pub render_node: String,
}

pub fn run_dir() -> PathBuf {
    PathBuf::from(settings::setting("MCPBROWSER_NATIVE_RUN"))
}

pub fn state_dir() -> PathBuf {
    PathBuf::from(settings::setting("MCPBROWSER_NATIVE_STATE"))
}

pub fn read_desktop_info() -> Result<DesktopInfo> {
    let path = run_dir().join("environment.json");
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
}

pub fn command_output(
    program: &str,
    args: &[String],
    env: Option<&HashMap<String, String>>,
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<Vec<u8>> {
    let mut cmd = Command::new(settings::tool(program));
    cmd.args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = env {
        cmd.env_clear().envs(env);
    }
    let mut child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    if let Some(input) = input {
        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input)?;
        }
    }
    let start = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            let out = child.wait_with_output()?;
            if out.status.success() {
                return Ok(out.stdout);
            }
            let err = String::from_utf8_lossy(&out.stderr);
            bail!(
                "{program}: {}",
                err.chars()
                    .rev()
                    .take(1500)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            );
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{program} timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn json_command(
    program: &str,
    args: &[String],
    env: Option<&HashMap<String, String>>,
    timeout: Duration,
) -> Result<Value> {
    let bytes = command_output(program, args, env, None, timeout)?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {program}"))
}

pub fn ensure_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
