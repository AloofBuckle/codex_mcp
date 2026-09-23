//! In-process adapter over the copied official Codex PTY and pipe libraries.
use crate::{Config, unified_exec::head_tail_buffer::HeadTailBuffer};
use anyhow::{Context, Result};
use codex_utils_pty::{ProcessHandle, SpawnedProcess, TerminalSize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Notify};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecArgs {
    pub cmd: String,
    pub workdir: Option<String>,
    #[serde(default)]
    pub tty: bool,
    pub yield_time_ms: Option<u64>,
    pub max_output_tokens: Option<usize>,
    pub shell: Option<String>,
    pub login: Option<bool>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StdinArgs {
    pub session_id: u64,
    #[serde(default)]
    pub chars: String,
    pub yield_time_ms: Option<u64>,
    pub max_output_tokens: Option<usize>,
}
#[derive(Debug, Serialize)]
pub struct Output {
    pub chunk_id: String,
    pub wall_time_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub output: String,
    pub original_token_count: usize,
}
struct StreamState {
    output: HeadTailBuffer<1048576>,
    closed: bool,
    exit_code: Option<i32>,
    error: Option<String>,
    last_use: Instant,
    handle: Option<Arc<ProcessHandle>>,
}
struct Session {
    id: u64,
    owner: String,
    state: Mutex<StreamState>,
    interaction: Mutex<()>,
    changed: Notify,
    observation: Option<crate::observe::CallRef>,
}
pub struct Processes {
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    config: Config,
    default_shell: String,
    stopping: AtomicBool,
    observer: Arc<crate::observe::Observer>,
}
impl Processes {
    pub fn new(config: &Config, observer: Arc<crate::observe::Observer>) -> Self {
        let default_shell = config.shell.clone().unwrap_or_else(|| {
            crate::shell_detect::default_user_shell()
                .shell_path
                .to_string_lossy()
                .into_owned()
        });
        Self {
            sessions: Default::default(),
            config: config.clone(),
            default_shell,
            stopping: AtomicBool::new(false),
            observer,
        }
    }
    pub fn alive(&self) -> bool {
        !self.stopping.load(Ordering::Acquire)
    }
    pub async fn exec(
        &self,
        owner: &str,
        args: ExecArgs,
        observation: Option<crate::observe::CallRef>,
    ) -> Result<Output> {
        anyhow::ensure!(self.alive(), "codex-mcp is shutting down");
        anyhow::ensure!(!args.cmd.contains('\0'), "cmd contains NUL");
        anyhow::ensure!(
            self.config.expose_shell || args.shell.is_none(),
            "shell selection is disabled by configuration"
        );
        let cwd = resolve_path(&self.config.workdir, args.workdir.as_deref().unwrap_or("."));
        anyhow::ensure!(
            cwd.is_dir(),
            "workdir is not a directory: {}",
            cwd.display()
        );
        let shell = args.shell.as_deref().unwrap_or(&self.default_shell);
        let argv = shell_argv(shell, &args.cmd, args.login.unwrap_or(self.config.login))?;
        let session = loop {
            let id = rand::random::<u32>() as u64 & 0x7fff_ffff;
            if id == 0 {
                continue;
            }
            let mut sessions = self.sessions.lock().await;
            anyhow::ensure!(self.alive(), "codex-mcp is shutting down");
            if self.config.max_sessions != 0 {
                anyhow::ensure!(
                    sessions.len() < self.config.max_sessions,
                    "maximum active or uncollected sessions reached ({})",
                    self.config.max_sessions
                );
            }
            if sessions.contains_key(&id) {
                continue;
            }
            let session = Arc::new(Session {
                id,
                owner: owner.into(),
                state: Mutex::new(StreamState {
                    output: Default::default(),
                    closed: false,
                    exit_code: None,
                    error: None,
                    last_use: Instant::now(),
                    handle: None,
                }),
                interaction: Mutex::new(()),
                changed: Notify::new(),
                observation: observation.clone(),
            });
            sessions.insert(id, session.clone());
            break session;
        };
        let _interaction = session.interaction.lock().await;
        let result = async {
            // The actual spawn/PTY/pipe/syscall implementation is the unchanged Codex crate.
            let env: HashMap<String, String> = std::env::vars().collect();
            let spawned = if args.tty {
                codex_utils_pty::spawn_pty_process(
                    &argv[0],
                    &argv[1..],
                    &cwd,
                    &env,
                    &None,
                    TerminalSize::default(),
                    &[],
                )
                .await?
            } else {
                codex_utils_pty::spawn_pipe_process_no_stdin(
                    &argv[0],
                    &argv[1..],
                    &cwd,
                    &env,
                    &None,
                    &[],
                )
                .await?
            };
            self.observer.process(&observation, session.id);
            Self::watch(session.clone(), spawned, self.observer.clone()).await;
            if !self.alive() {
                if let Some(handle) = &session.state.lock().await.handle {
                    handle.request_terminate();
                }
                anyhow::bail!("codex-mcp is shutting down");
            }
            Self::collect(
                &session,
                args.yield_time_ms.unwrap_or(10_000).clamp(250, 30_000),
                args.max_output_tokens,
            )
            .await
        }
        .await;
        if result.is_err()
            && let Some(handle) = &session.state.lock().await.handle
        {
            handle.request_terminate();
        }
        if session.state.lock().await.closed || result.is_err() {
            self.sessions.lock().await.remove(&session.id);
        }
        result
    }
    pub async fn stdin(&self, owner: &str, args: StdinArgs) -> Result<Output> {
        let session = self
            .sessions
            .lock()
            .await
            .get(&args.session_id)
            .cloned()
            .context("unknown or completed session_id")?;
        anyhow::ensure!(session.owner == owner, "unknown or completed session_id");
        let _interaction = session.interaction.lock().await;
        anyhow::ensure!(
            self.sessions.lock().await.contains_key(&args.session_id),
            "session already completed"
        );
        if !args.chars.is_empty() {
            let writer = {
                let state = session.state.lock().await;
                anyhow::ensure!(
                    !state.closed,
                    "session stdin is already closed; poll with empty chars for remaining output"
                );
                state
                    .handle
                    .as_ref()
                    .context("session is starting")?
                    .writer_sender()
            };
            tokio::time::timeout(
                Duration::from_secs(10),
                writer.send(args.chars.clone().into_bytes()),
            )
            .await
            .context("stdin queue is full; command has not consumed the input")?
            .context("stdin is unavailable; use tty=true for interactive input")?;
        }
        let wait = if args.chars.is_empty() {
            args.yield_time_ms.unwrap_or(250).clamp(5000, 300000)
        } else {
            args.yield_time_ms.unwrap_or(250).clamp(250, 30000)
        };
        let result = Self::collect(&session, wait, args.max_output_tokens).await;
        if session.state.lock().await.closed {
            self.sessions.lock().await.remove(&args.session_id);
        }
        result
    }
    async fn watch(
        session: Arc<Session>,
        spawned: SpawnedProcess,
        observer: Arc<crate::observe::Observer>,
    ) {
        let SpawnedProcess {
            session: handle,
            mut stdout_rx,
            mut stderr_rx,
            mut exit_rx,
        } = spawned;
        session.state.lock().await.handle = Some(Arc::new(handle));
        tokio::spawn(async move {
            let mut stdout_open = true;
            let mut stderr_open = true;
            let mut waiting_exit = true;
            while stdout_open || stderr_open || waiting_exit {
                // These are in-process bounded Rust channels from the Codex library.
                let chunk = tokio::select! {
                    chunk=stdout_rx.recv(), if stdout_open=>{if chunk.is_none(){stdout_open=false;}chunk},
                    chunk=stderr_rx.recv(), if stderr_open=>{if chunk.is_none(){stderr_open=false;}chunk},
                    result=&mut exit_rx, if waiting_exit=>{
                        waiting_exit=false;
                        let mut state=session.state.lock().await;
                        match result {Ok(code)=>state.exit_code=Some(code),Err(e)=>state.error=Some(format!("process exit status unavailable: {e}"))}
                        None
                    }
                };
                if let Some(chunk) = chunk {
                    observer.output(&session.observation, &chunk);
                    session.state.lock().await.output.push_chunk(&chunk);
                }
                session.changed.notify_waiters();
            }
            let mut state = session.state.lock().await;
            state.closed = true;
            observer.process_exit(&session.observation, state.exit_code);
            // Release the native handle promptly, retaining only unread output and status.
            // This also avoids keeping a stale OS process-group identifier for idle handles.
            let handle = state.handle.take();
            drop(state);
            drop(handle);
            session.changed.notify_waiters();
        });
    }
    async fn collect(session: &Session, wait_ms: u64, max: Option<usize>) -> Result<Output> {
        let start = Instant::now();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
        loop {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            let changed = session.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if session.state.lock().await.closed {
                break;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                break;
            }
        }
        let mut state = session.state.lock().await;
        if let Some(error) = state.error.as_ref() {
            anyhow::bail!("{error}");
        }
        let buffer = std::mem::take(&mut state.output);
        state.last_use = Instant::now();
        let full = String::from_utf8_lossy(&buffer.to_bytes_with_omission_marker()).into_owned();
        let (output, _) = codex_utils_string::truncate_middle_with_token_budget(
            &full,
            max.unwrap_or(10000).min(262144),
        );
        Ok(Output {
            chunk_id: uuid::Uuid::new_v4().simple().to_string()[..6].into(),
            wall_time_seconds: start.elapsed().as_secs_f64(),
            session_id: if state.closed { None } else { Some(session.id) },
            exit_code: if state.closed { state.exit_code } else { None },
            output,
            original_token_count: buffer.total_bytes().div_ceil(4),
        })
    }
    pub async fn reap(&self) {
        let list: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        for session in list {
            if let Ok(_interaction) = session.interaction.try_lock() {
                let state = session.state.lock().await;
                if state.last_use.elapsed() <= Duration::from_secs(24 * 3600) {
                    continue;
                }
                if let Some(handle) = &state.handle {
                    handle.request_terminate();
                }
                drop(state);
                self.sessions.lock().await.remove(&session.id);
            }
        }
    }
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        let list: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        for session in &list {
            if let Some(handle) = &session.state.lock().await.handle {
                handle.request_terminate();
            }
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let mut all_closed = true;
            for session in &list {
                all_closed &= session.state.lock().await.closed;
            }
            if all_closed || Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        for session in list {
            let mut state = session.state.lock().await;
            if let Some(handle) = state.handle.take() {
                handle.terminate();
            }
            state.closed = true;
            drop(state);
            session.changed.notify_waiters();
        }
        self.sessions.lock().await.clear();
    }
}
pub fn resolve_path(cwd: &Path, raw: &str) -> PathBuf {
    let p = PathBuf::from(raw);
    if p.is_absolute() { p } else { cwd.join(p) }
}
// Adapted directly from Codex core/src/shell.rs::Shell::derive_exec_args.
fn shell_argv(shell: &str, command: &str, login: bool) -> Result<Vec<String>> {
    let name = Path::new(shell)
        .file_stem()
        .and_then(|x| x.to_str())
        .unwrap_or(shell)
        .to_lowercase();
    Ok(match name.as_str() {
        "zsh" | "bash" | "sh" | "dash" => vec![
            shell.into(),
            if login { "-lc" } else { "-c" }.into(),
            command.into(),
        ],
        "pwsh" | "powershell" => {
            let mut v = vec![shell.into()];
            if !login {
                v.push("-NoProfile".into());
            }
            v.extend(["-Command".into(), command.into()]);
            v
        }
        "cmd" => vec![shell.into(), "/c".into(), command.into()],
        _ => anyhow::bail!("unsupported shell: {shell}"),
    })
}
