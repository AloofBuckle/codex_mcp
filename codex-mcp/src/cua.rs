//! Authenticated reverse proxy for the CUA MCP resource.
//!
//! `/cua` is a distinct OAuth protected resource and MCP server, but the
//! browser implementation remains the existing Node/Playwright runtime. The
//! Rust daemon owns the public endpoint and, optionally, the worker process.

use crate::{App, CuaConfig, observe};
use anyhow::{Context, Result};
use axum::{
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use std::{path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

const ACTIVITY_STDOUT_PREFIX: &str = "MCPBROWSER_ACTIVITY ";

const REQUEST_HEADERS: &[&str] = &[
    "accept",
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
    "last-event-id",
];
const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
    "allow",
    "cache-control",
];

pub struct CuaProxy {
    client: reqwest::Client,
    upstream: String,
    token: String,
    command: Option<String>,
    args: Vec<String>,
    workdir: Option<std::path::PathBuf>,
    observer: Arc<observe::Observer>,
    child: Mutex<Option<Child>>,
    restart: Mutex<()>,
}

impl CuaProxy {
    pub async fn start(config: &CuaConfig, observer: Arc<observe::Observer>) -> Result<Self> {
        let child = Self::spawn_worker(
            config.command.as_deref(),
            &config.args,
            config.workdir.as_deref(),
            observer.clone(),
        )?;

        let token = wait_for_token(&config.token_file, child.is_some()).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .context("build CUA HTTP client")?;
        let proxy = Self {
            client,
            upstream: config.upstream.clone(),
            token,
            command: config.command.clone(),
            args: config.args.clone(),
            workdir: config.workdir.clone(),
            observer,
            child: Mutex::new(child),
            restart: Mutex::new(()),
        };
        proxy.wait_until_ready().await?;
        {
            let mut child = proxy.child.lock().await;
            if let Some(worker) = child.as_mut()
                && let Some(status) = worker.try_wait().context("inspect CUA worker")?
            {
                anyhow::bail!("CUA worker exited during startup with {status}");
            }
        }
        Ok(proxy)
    }

    fn spawn_worker(
        command: Option<&str>,
        args: &[String],
        workdir: Option<&Path>,
        observer: Arc<observe::Observer>,
    ) -> Result<Option<Child>> {
        let Some(command) = command else {
            return Ok(None);
        };
        let mut cmd = Command::new(command);
        cmd.args(args);
        if let Some(workdir) = workdir {
            cmd.current_dir(workdir);
        }
        // The worker's stdout is a private parent/child observability channel.
        // Normal MCP traffic uses loopback HTTP, so line-delimited semantic
        // input events cannot corrupt protocol traffic.
        cmd.env("MCPBROWSER_ACTIVITY_STDOUT", "1");
        cmd.stdout(Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0);
        cmd.kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .with_context(|| format!("start CUA worker {command}"))?;
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(raw) = line.strip_prefix(ACTIVITY_STDOUT_PREFIX) {
                        match serde_json::from_str::<serde_json::Value>(raw) {
                            Ok(value) => observer.browser_activity(&value),
                            Err(error) => {
                                tracing::warn!(%error, "invalid CUA browser activity event")
                            }
                        }
                    } else if !line.trim().is_empty() {
                        tracing::debug!(target: "codex_mcp::cua_worker", %line, "CUA worker stdout");
                    }
                }
            });
        }
        Ok(Some(child))
    }

    #[cfg(unix)]
    async fn terminate_worker_group(worker: &mut Child) -> Result<()> {
        let Some(pid) = worker.id().map(|pid| pid as i32) else {
            return Ok(());
        };
        let pgid = pid;

        // The Node worker owns the graceful shutdown sequence: its SIGTERM
        // handler closes the GUI, asks Chromium to exit through CDP
        // Browser.close(), and only then exits. Do not signal the whole process
        // group here: doing so delivers SIGTERM to Chrome at the same instant
        // as Node and marks the persistent profile as crashed.
        let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
        if rc != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error).context("terminate CUA worker");
            }
        }

        match tokio::time::timeout(Duration::from_secs(8), worker.wait()).await {
            Ok(result) => {
                let _ = result.context("wait for CUA worker")?;
            }
            Err(_) => {
                tracing::warn!(
                    pid,
                    "CUA worker graceful shutdown timed out; terminating process group"
                );
                let _ = unsafe { libc::kill(-pgid, libc::SIGTERM) };
                match tokio::time::timeout(Duration::from_secs(2), worker.wait()).await {
                    Ok(result) => {
                        let _ = result.context("wait for terminated CUA worker")?;
                    }
                    Err(_) => {
                        let _ = unsafe { libc::kill(-pgid, libc::SIGKILL) };
                        let _ = worker.wait().await.context("reap killed CUA worker")?;
                    }
                }
            }
        }

        // A clean Node exit should also have reaped Chromium. Keep the process
        // group cleanup as a safety net for crashed helpers, but give normal
        // descendants a short interval to disappear first.
        tokio::time::sleep(Duration::from_millis(500)).await;
        if unsafe { libc::kill(-pgid, 0) } == 0 {
            let _ = unsafe { libc::kill(-pgid, libc::SIGTERM) };
            tokio::time::sleep(Duration::from_millis(500)).await;
            if unsafe { libc::kill(-pgid, 0) } == 0 {
                let _ = unsafe { libc::kill(-pgid, libc::SIGKILL) };
            }
        }
        Ok(())
    }

    #[cfg(not(unix))]
    async fn terminate_worker_group(worker: &mut Child) -> Result<()> {
        if worker.try_wait().context("inspect CUA worker")?.is_none() {
            worker.kill().await.context("kill CUA worker")?;
        }
        let _ = worker.wait().await.context("wait for CUA worker")?;
        Ok(())
    }

    async fn wait_until_ready(&self) -> Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            match self
                .client
                .get(&self.upstream)
                .bearer_auth(&self.token)
                .send()
                .await
            {
                Ok(_) => return Ok(()),
                Err(error) if tokio::time::Instant::now() < deadline => {
                    tracing::debug!(%error, "waiting for CUA worker");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(error) => return Err(error).context("CUA worker did not become ready"),
            }
        }
    }

    async fn forward_once(
        &self,
        parts: &axum::http::request::Parts,
        body: &[u8],
    ) -> Result<Response> {
        let mut upstream = self
            .client
            .request(parts.method.clone(), &self.upstream)
            .bearer_auth(&self.token)
            .body(body.to_vec());
        for name in REQUEST_HEADERS {
            if let Some(value) = parts.headers.get(*name) {
                upstream = upstream.header(*name, value);
            }
        }
        let response = upstream.send().await.context("CUA upstream request")?;
        let status = response.status();
        let headers = response.headers().clone();
        let stream = response.bytes_stream();
        let mut out = Response::builder()
            .status(status)
            .body(Body::from_stream(stream))?;
        for name in RESPONSE_HEADERS {
            if let Some(value) = headers.get(*name)
                && let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_bytes(value.as_bytes()),
                )
            {
                out.headers_mut().insert(name, value);
            }
        }
        Ok(out)
    }

    async fn restart_worker_if_needed(&self) -> Result<()> {
        let _restart = self.restart.lock().await;

        // Another request may already have repaired the worker while we were
        // waiting for the restart lock. Probe the upstream first and avoid a
        // duplicate restart in that case.
        if self
            .client
            .get(&self.upstream)
            .bearer_auth(&self.token)
            .send()
            .await
            .is_ok()
        {
            return Ok(());
        }

        let mut child = self.child.lock().await;
        if let Some(worker) = child.as_mut() {
            Self::terminate_worker_group(worker).await?;
        }
        *child = Self::spawn_worker(
            self.command.as_deref(),
            &self.args,
            self.workdir.as_deref(),
            self.observer.clone(),
        )?;
        drop(child);

        self.wait_until_ready()
            .await
            .context("restart CUA worker")?;
        tracing::info!("CUA worker restarted and is accepting requests");
        Ok(())
    }

    async fn forward(&self, req: Request) -> Result<Response> {
        let (parts, body) = req.into_parts();
        let body = to_bytes(body, 2 * 1024 * 1024)
            .await
            .context("read CUA MCP request")?;
        match self.forward_once(&parts, &body).await {
            Ok(response) => Ok(response),
            Err(first_error) if self.command.is_some() => {
                tracing::warn!(%first_error, "CUA upstream failed; restarting worker");
                self.restart_worker_if_needed().await?;
                // Do not transparently replay the failed MCP request. It may
                // have reached the old worker before the connection failed,
                // and action requests can have side effects. A worker restart
                // also invalidates the old MCP session id. Return an error so
                // the client reconnects and initializes a fresh session.
                Err(first_error.context("CUA worker recovered; MCP session must reconnect"))
            }
            Err(error) => Err(error),
        }
    }

    pub async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        if let Some(child) = child.as_mut() {
            let _ = Self::terminate_worker_group(child).await;
        }
        *child = None;
    }
}

async fn wait_for_token(path: &Path, worker_started: bool) -> Result<String> {
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs(if worker_started { 10 } else { 0 });
    loop {
        if let Ok(raw) = tokio::fs::read_to_string(path).await {
            let token = raw.trim().to_owned();
            anyhow::ensure!(token.len() >= 32, "CUA internal token is too short");
            return Ok(token);
        }
        if !worker_started || tokio::time::Instant::now() >= deadline {
            return Err(anyhow::anyhow!(
                "cannot read CUA token file {}",
                path.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn proxy(State(app): State<Arc<App>>, req: Request) -> Response {
    let Some(cua) = &app.cua else {
        return (StatusCode::SERVICE_UNAVAILABLE, "CUA backend is disabled").into_response();
    };
    match cua.forward(req).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "CUA proxy failed");
            (StatusCode::BAD_GATEWAY, "CUA backend unavailable").into_response()
        }
    }
}
