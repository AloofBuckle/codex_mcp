mod auth;
mod cua;
mod media;
mod observe;
mod origin;
mod process;
mod protocol;
mod redact;
mod schema;
#[allow(dead_code)]
mod shell_detect;
mod unified_exec;

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub issuer: String,
    pub password_hash: String,
    pub database: PathBuf,
    pub workdir: PathBuf,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default = "yes")]
    pub expose_shell: bool,
    #[serde(default = "yes")]
    pub login: bool,
    #[serde(default = "access_ttl")]
    pub access_ttl_seconds: u64,
    #[serde(default = "max_sessions")]
    pub max_sessions: usize,
    #[serde(default = "origins")]
    pub allowed_origins: Vec<String>,
    #[serde(default)]
    pub monitor: Option<observe::MonitorConfig>,
    #[serde(default)]
    pub cua: Option<CuaConfig>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuaConfig {
    pub upstream: String,
    pub token_file: PathBuf,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub workdir: Option<PathBuf>,
}
fn yes() -> bool {
    true
}
fn access_ttl() -> u64 {
    3600
}
fn max_sessions() -> usize {
    64
}
fn origins() -> Vec<String> {
    vec![
        "https://chatgpt.com".into(),
        "https://chat.openai.com".into(),
    ]
}
impl Config {
    pub fn resource(&self) -> String {
        format!("{}/mcp", self.issuer)
    }
    pub fn cua_resource(&self) -> String {
        format!("{}/cua", self.issuer)
    }
    pub fn allows_resource(&self, resource: &str) -> bool {
        resource == self.resource() || (self.cua.is_some() && resource == self.cua_resource())
    }
    pub fn validate(&mut self) -> Result<()> {
        self.issuer = self.issuer.trim_end_matches('/').into();
        let u = url::Url::parse(&self.issuer)?;
        anyhow::ensure!(
            u.scheme() == "https"
                && u.host_str().is_some()
                && u.path() == "/"
                && u.query().is_none()
                && u.fragment().is_none()
                && u.username().is_empty()
                && u.password().is_none(),
            "issuer must be an HTTPS origin"
        );
        self.workdir = self.workdir.canonicalize().context("workdir")?;
        anyhow::ensure!(self.workdir.is_dir(), "workdir is invalid");
        anyhow::ensure!(
            self.database.is_absolute(),
            "database must be an absolute path"
        );
        anyhow::ensure!(
            self.max_sessions == 0 || self.max_sessions <= 256,
            "max_sessions must be 0 (unlimited) or 1..256"
        );
        anyhow::ensure!(
            self.access_ttl_seconds <= 31_536_000,
            "access_ttl_seconds must be 0..31536000"
        );
        anyhow::ensure!(
            self.password_hash.starts_with("$argon2id$"),
            "Argon2id password hash required"
        );
        argon2::PasswordHash::new(&self.password_hash)
            .map_err(|e| anyhow::anyhow!("invalid password hash: {e}"))?;
        if let Some(monitor) = &self.monitor {
            monitor.validate()?;
        }
        if let Some(cua) = &mut self.cua {
            cua.validate()?;
        }
        Ok(())
    }
}

impl CuaConfig {
    fn validate(&mut self) -> Result<()> {
        let u = url::Url::parse(&self.upstream).context("cua upstream")?;
        anyhow::ensure!(u.scheme() == "http", "cua upstream must use loopback HTTP");
        anyhow::ensure!(
            matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "::1")),
            "cua upstream must be loopback"
        );
        anyhow::ensure!(
            u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none(),
            "cua upstream cannot contain credentials, query parameters or fragments"
        );
        anyhow::ensure!(
            self.token_file.is_absolute(),
            "cua token_file must be absolute"
        );
        if let Some(workdir) = &mut self.workdir {
            *workdir = workdir.canonicalize().context("cua workdir")?;
            anyhow::ensure!(workdir.is_dir(), "cua workdir is invalid");
        }
        if self.command.is_none() {
            anyhow::ensure!(self.args.is_empty(), "cua args require command");
        }
        Ok(())
    }
}
pub struct App {
    pub config: Config,
    pub auth: auth::Auth,
    pub processes: process::Processes,
    pub observer: Arc<observe::Observer>,
    pub cua: Option<cua::CuaProxy>,
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

#[tokio::main]
async fn main() -> Result<()> {
    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--version") => {
            println!("codex-mcp {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("hash-password") => {
            use std::io::Read;
            let mut p = String::new();
            std::io::stdin().take(4096).read_to_string(&mut p)?;
            println!("{}", auth::hash_password(p.trim_end())?);
            return Ok(());
        }
        _ => {}
    }
    let file = args.get(1).context(
        "usage: codex-mcp CONFIG.json [127.0.0.1:35121 | revoke-all] | hash-password | --version",
    )?;
    let mut config: Config = serde_json::from_slice(&std::fs::read(file)?)?;
    config.validate()?;
    let auth = auth::Auth::open(&config.database)?;
    let observer = Arc::new(observe::Observer::new(config.monitor.clone()));
    let cua = match config.cua.as_ref() {
        Some(c) => Some(cua::CuaProxy::start(c, observer.clone()).await?),
        None => None,
    };
    if args.get(2).map(String::as_str) == Some("revoke-all") {
        auth.revoke_all()?;
        println!("All OAuth grants revoked.");
        return Ok(());
    }
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let processes = process::Processes::new(&config, observer.clone());
    let (shutdown, _) = tokio::sync::watch::channel(false);
    let app = Arc::new(App {
        config,
        auth,
        processes,
        observer,
        cua,
        shutdown,
    });
    let weak = Arc::downgrade(&app);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let Some(app) = weak.upgrade() else {
                break;
            };
            app.processes.reap().await;
        }
    });
    let router = Router::new()
        .route(
            "/mcp",
            post(protocol::mcp)
                .get(protocol::no_stream)
                .delete(protocol::no_stream),
        )
        .route("/cua", post(cua::proxy).get(cua::proxy).delete(cua::proxy))
        .route("/mcp/health", get(protocol::health))
        .route("/monitor/v1/snapshot", get(observe::snapshot))
        .route("/monitor/v2/events", get(observe::events))
        .route(
            "/.well-known/oauth-protected-resource",
            get(auth::resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(auth::resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/cua",
            get(auth::cua_resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(auth::server_metadata),
        )
        .route("/mcp/oauth/register", post(auth::register))
        .route(
            "/mcp/oauth/authorize",
            get(auth::authorize_get).post(auth::authorize_post),
        )
        .route("/mcp/oauth/token", post(auth::token))
        .route("/mcp/oauth/revoke", post(auth::revoke))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            protocol::http_guard,
        ))
        .with_state(app.clone());
    let addr = args.get(2).map(String::as_str).unwrap_or("127.0.0.1:35121");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(addr, "codex-mcp ready");
    let stop = app.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM");
                tokio::select! {_ = term.recv()=>{}, _ = tokio::signal::ctrl_c()=>{}}
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            stop.shutdown.send_replace(true);
            if let Some(cua) = &stop.cua {
                cua.shutdown().await;
            }
            stop.processes.shutdown().await;
        })
        .await?;
    Ok(())
}
