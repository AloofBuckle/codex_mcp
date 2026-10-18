use crate::{App, observe::Observer};
use anyhow::{Context, bail, ensure};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;

pub const RESOURCE_URI: &str = "ui://codex/user-input-v1.html";
pub const RESOURCE_MIME: &str = "text/html;profile=mcp-app";
const TERMINAL_RETENTION_MS: u64 = 60 * 60 * 1000;
const MAX_ACTIVE_REQUESTS: usize = 128;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UserInputConfig {
    #[serde(default)]
    pub public_origin: Option<String>,
    #[serde(default = "default_sync_timeout")]
    pub sync_unseen_timeout_seconds: u64,
    #[serde(default = "default_async_timeout")]
    pub async_timeout_seconds: u64,
    #[serde(default = "default_poll_wait")]
    pub async_poll_wait_ms: u64,
}

impl Default for UserInputConfig {
    fn default() -> Self {
        Self {
            public_origin: None,
            sync_unseen_timeout_seconds: default_sync_timeout(),
            async_timeout_seconds: default_async_timeout(),
            async_poll_wait_ms: default_poll_wait(),
        }
    }
}

impl UserInputConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        if let Some(origin) = self.public_origin.as_deref() {
            let parsed = url::Url::parse(origin).context("user_input.public_origin")?;
            ensure!(
                parsed.scheme() == "https"
                    && parsed.host_str().is_some()
                    && parsed.path() == "/"
                    && parsed.query().is_none()
                    && parsed.fragment().is_none()
                    && parsed.username().is_empty()
                    && parsed.password().is_none(),
                "user_input.public_origin must be an HTTPS origin"
            );
        }
        ensure!(
            (5..=3600).contains(&self.sync_unseen_timeout_seconds),
            "user_input.sync_unseen_timeout_seconds must be 5..3600"
        );
        ensure!(
            (60..=86400).contains(&self.async_timeout_seconds),
            "user_input.async_timeout_seconds must be 60..86400"
        );
        ensure!(
            (250..=30000).contains(&self.async_poll_wait_ms),
            "user_input.async_poll_wait_ms must be 250..30000"
        );
        Ok(())
    }

    pub fn public_origin<'a>(&'a self, fallback: &'a str) -> &'a str {
        self.public_origin.as_deref().unwrap_or(fallback)
    }
}

fn default_sync_timeout() -> u64 {
    60
}
fn default_async_timeout() -> u64 {
    10 * 60
}
fn default_poll_wait() -> u64 {
    30_000
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    #[serde(rename = "isOther", default)]
    pub is_other: bool,
    #[serde(rename = "isSecret", default)]
    pub is_secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<QuestionOption>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UserAnswer {
    pub answers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UserResponse {
    pub answers: HashMap<String, UserAnswer>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncArgs {
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AsyncQuestion {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AsyncArgs {
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub questions: Option<Vec<AsyncQuestion>>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub yield_time_ms: Option<u64>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Sync,
    Async,
}
impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sync => "sync",
            Self::Async => "async",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Unseen,
    Opened,
    Answered,
    AutoSelected,
    Closed,
    Expired,
}
impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unseen => "unseen",
            Self::Opened => "opened",
            Self::Answered => "answered",
            Self::AutoSelected => "auto_selected",
            Self::Closed => "closed",
            Self::Expired => "expired",
        }
    }
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Answered | Self::AutoSelected | Self::Closed | Self::Expired
        )
    }
    fn model_status(self) -> &'static str {
        match self {
            Self::Unseen => "未查看",
            Self::Opened => "思考中",
            Self::Answered | Self::AutoSelected => "已回答",
            Self::Closed => "已关闭",
            Self::Expired => "已超时",
        }
    }
}

struct RequestData {
    id: String,
    owner: String,
    tool: String,
    mode: Mode,
    questions: Vec<Question>,
    match_key: String,
    capability: String,
    created_at: u64,
    expires_at: Option<u64>,
    terminal_at: Option<u64>,
    status: Status,
    response: Option<UserResponse>,
    resolution: Option<String>,
}

struct RequestEntry {
    data: Mutex<RequestData>,
    changed: Notify,
}

#[derive(Clone)]
pub struct UserInputs {
    config: UserInputConfig,
    observer: Arc<Observer>,
    requests: Arc<Mutex<HashMap<String, Arc<RequestEntry>>>>,
}

pub struct ToolReply {
    pub data: Value,
    pub meta: Option<Value>,
}

impl UserInputs {
    pub fn new(config: UserInputConfig, observer: Arc<Observer>) -> Arc<Self> {
        Arc::new(Self {
            config,
            observer,
            requests: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn sync(
        self: &Arc<Self>,
        owner: &str,
        raw_args: &Value,
        mut args: SyncArgs,
    ) -> anyhow::Result<ToolReply> {
        normalize_sync_questions(&mut args.questions)?;
        let entry = self.create_request(
            owner,
            "request_user_input",
            Mode::Sync,
            args.questions,
            raw_args,
            None,
        )?;
        let unseen_deadline = tokio::time::Instant::now()
            + Duration::from_secs(self.config.sync_unseen_timeout_seconds);

        loop {
            let status = entry.data.lock().unwrap_or_else(|e| e.into_inner()).status;
            match status {
                Status::Answered | Status::AutoSelected => {
                    let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                    let response = data
                        .response
                        .clone()
                        .context("user input response missing")?;
                    return Ok(ToolReply {
                        data: serde_json::to_value(response)?,
                        meta: Some(session_meta(&data)),
                    });
                }
                Status::Closed => bail!("user input request was closed"),
                Status::Expired => bail!("user input request expired"),
                Status::Opened => {
                    entry.changed.notified().await;
                }
                Status::Unseen => {
                    tokio::select! {
                        _ = entry.changed.notified() => {},
                        _ = tokio::time::sleep_until(unseen_deadline) => {
                            let response = {
                                let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                                if data.status != Status::Unseen {
                                    continue;
                                }
                                recommended_response(&data.questions)?
                            };
                            self.resolve_if_status(
                                &entry,
                                Some(Status::Unseen),
                                Status::AutoSelected,
                                Some(response),
                                "sync_unseen_timeout",
                            )?;
                        }
                    }
                }
            }
        }
    }

    pub async fn async_tool(
        self: &Arc<Self>,
        owner: &str,
        raw_args: &Value,
        args: AsyncArgs,
    ) -> anyhow::Result<ToolReply> {
        let action = args.action.as_deref().unwrap_or("create");
        match action {
            "create" => {
                let questions = args
                    .questions
                    .context("questions are required for create")?;
                let questions = normalize_async_questions(questions)?;
                let expires_at = now().saturating_add(self.config.async_timeout_seconds * 1000);
                let entry = self.create_request(
                    owner,
                    "request_user_input_async",
                    Mode::Async,
                    questions,
                    raw_args,
                    Some(expires_at),
                )?;
                self.spawn_async_expiry(entry.clone(), expires_at);
                let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                Ok(ToolReply {
                    data: async_status_value(&data),
                    meta: Some(widget_session_meta(&data)),
                })
            }
            "poll" => {
                let id = args.request_id.context("request_id is required for poll")?;
                let entry = self.owned_request(owner, &id)?;
                let before = entry.data.lock().unwrap_or_else(|e| e.into_inner()).status;
                if !before.terminal() {
                    let wait = args
                        .yield_time_ms
                        .unwrap_or(self.config.async_poll_wait_ms)
                        .clamp(250, 30_000);
                    let _ =
                        tokio::time::timeout(Duration::from_millis(wait), entry.changed.notified())
                            .await;
                }
                let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                Ok(ToolReply {
                    data: async_status_value(&data),
                    meta: None,
                })
            }
            "close" => {
                let id = args
                    .request_id
                    .context("request_id is required for close")?;
                let entry = self.owned_request(owner, &id)?;
                let reason = args.reason.as_deref().unwrap_or("model_closed");
                self.resolve(&entry, Status::Closed, None, reason)?;
                let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                Ok(ToolReply {
                    data: async_status_value(&data),
                    meta: None,
                })
            }
            _ => bail!("action must be create, poll, or close"),
        }
    }

    fn create_request(
        &self,
        owner: &str,
        tool: &str,
        mode: Mode,
        questions: Vec<Question>,
        raw_args: &Value,
        expires_at: Option<u64>,
    ) -> anyhow::Result<Arc<RequestEntry>> {
        let active = self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|entry| {
                !entry
                    .data
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .status
                    .terminal()
            })
            .count();
        ensure!(
            active < MAX_ACTIVE_REQUESTS,
            "too many active user input requests"
        );

        let id = uuid::Uuid::new_v4().to_string();
        let capability = random_token();
        let created_at = now();
        let match_key = match_key(tool, raw_args);
        let entry = Arc::new(RequestEntry {
            data: Mutex::new(RequestData {
                id: id.clone(),
                owner: owner.to_string(),
                tool: tool.to_string(),
                mode,
                questions,
                match_key,
                capability,
                created_at,
                expires_at,
                terminal_at: None,
                status: Status::Unseen,
                response: None,
                resolution: None,
            }),
            changed: Notify::new(),
        });
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), entry.clone());

        self.observer
            .begin_user_input(&id, tool, raw_args, created_at);
        self.observer.user_input_notify(&snapshot_value(
            &entry.data.lock().unwrap_or_else(|e| e.into_inner()),
            true,
        ));
        Ok(entry)
    }

    fn spawn_async_expiry(self: &Arc<Self>, entry: Arc<RequestEntry>, expires_at: u64) {
        let this = self.clone();
        tokio::spawn(async move {
            let delay = expires_at.saturating_sub(now());
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let should_expire = {
                let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                data.mode == Mode::Async && !data.status.terminal()
            };
            if should_expire {
                let _ = this.resolve(&entry, Status::Expired, None, "async_timeout");
            }
        });
    }

    fn owned_request(&self, owner: &str, id: &str) -> anyhow::Result<Arc<RequestEntry>> {
        let entry = self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .context("user input request not found")?;
        let matches = entry.data.lock().unwrap_or_else(|e| e.into_inner()).owner == owner;
        ensure!(matches, "user input request belongs to another session");
        Ok(entry)
    }

    fn resolve(
        &self,
        entry: &Arc<RequestEntry>,
        status: Status,
        response: Option<UserResponse>,
        resolution: &str,
    ) -> anyhow::Result<bool> {
        self.resolve_if_status(entry, None, status, response, resolution)
    }

    fn resolve_if_status(
        &self,
        entry: &Arc<RequestEntry>,
        expected: Option<Status>,
        status: Status,
        response: Option<UserResponse>,
        resolution: &str,
    ) -> anyhow::Result<bool> {
        ensure!(status.terminal(), "resolution status must be terminal");
        let (id, output, changed) = {
            let mut data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
            if data.status.terminal() {
                return Ok(false);
            }
            if expected.is_some_and(|expected| data.status != expected) {
                return Ok(false);
            }
            if let Some(response) = &response {
                validate_response(&data.questions, response)?;
            }
            data.status = status;
            data.response = response;
            data.resolution = Some(resolution.to_string());
            data.terminal_at = Some(now());
            let output = terminal_output(&data);
            (data.id.clone(), output, true)
        };
        if changed {
            entry.changed.notify_waiters();
            self.observer.finish_user_input(&id, &output);
            self.observer.user_input_notify(&json!({
                "id": id,
                "status": status.as_str(),
                "terminal": true,
                "resolution": resolution,
            }));
        }
        Ok(true)
    }

    pub fn mark_opened(&self, id: &str) -> anyhow::Result<Value> {
        let entry = self.request(id)?;
        let changed = {
            let mut data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
            if data.status == Status::Unseen {
                data.status = Status::Opened;
                true
            } else {
                false
            }
        };
        if changed {
            entry.changed.notify_waiters();
            self.observer.user_input_state(id, "opened");
        }
        Ok(snapshot_value(
            &entry.data.lock().unwrap_or_else(|e| e.into_inner()),
            false,
        ))
    }

    pub fn answer(&self, id: &str, response: UserResponse) -> anyhow::Result<Value> {
        let entry = self.request(id)?;
        ensure!(
            self.resolve(&entry, Status::Answered, Some(response), "user_answered")?,
            "user input request is already resolved"
        );
        Ok(snapshot_value(
            &entry.data.lock().unwrap_or_else(|e| e.into_inner()),
            false,
        ))
    }

    pub fn snapshot(&self, id: &str) -> anyhow::Result<Value> {
        let entry = self.request(id)?;
        Ok(snapshot_value(
            &entry.data.lock().unwrap_or_else(|e| e.into_inner()),
            false,
        ))
    }

    pub fn snapshot_with_capability(&self, id: &str) -> anyhow::Result<Value> {
        let entry = self.request(id)?;
        Ok(snapshot_value(
            &entry.data.lock().unwrap_or_else(|e| e.into_inner()),
            true,
        ))
    }

    pub async fn wait_snapshot(&self, id: &str, wait_ms: u64) -> anyhow::Result<Value> {
        let entry = self.request(id)?;
        let before = entry.data.lock().unwrap_or_else(|e| e.into_inner()).status;
        if !before.terminal() && wait_ms > 0 {
            let _ = tokio::time::timeout(
                Duration::from_millis(wait_ms.clamp(1, 30_000)),
                entry.changed.notified(),
            )
            .await;
        }
        Ok(snapshot_value(
            &entry.data.lock().unwrap_or_else(|e| e.into_inner()),
            false,
        ))
    }

    pub async fn wait_snapshot_with_capability(
        &self,
        id: &str,
        wait_ms: u64,
    ) -> anyhow::Result<Value> {
        let entry = self.request(id)?;
        let before = entry.data.lock().unwrap_or_else(|e| e.into_inner()).status;
        if !before.terminal() && wait_ms > 0 {
            let _ = tokio::time::timeout(
                Duration::from_millis(wait_ms.clamp(1, 30_000)),
                entry.changed.notified(),
            )
            .await;
        }
        Ok(snapshot_value(
            &entry.data.lock().unwrap_or_else(|e| e.into_inner()),
            true,
        ))
    }

    pub fn bind(&self, tool: &str, arguments: &Value) -> anyhow::Result<Value> {
        let wanted = match_key(tool, arguments);
        let mut matches = self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|entry| {
                let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                (!data.status.terminal() && data.tool == tool && data.match_key == wanted)
                    .then_some((data.created_at, entry.clone()))
            })
            .collect::<Vec<_>>();
        matches.sort_by_key(|(created, _)| *created);
        let entry = matches
            .pop()
            .map(|(_, entry)| entry)
            .context("active user input request not found")?;
        let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
        Ok(json!({
            "session": session_meta(&data)["userInputSession"].clone(),
            "request": snapshot_value(&data, false),
        }))
    }

    pub fn capability_matches(&self, id: &str, capability: &str) -> bool {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .is_some_and(|entry| {
                entry
                    .data
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .capability
                    == capability
            })
    }

    fn request(&self, id: &str) -> anyhow::Result<Arc<RequestEntry>> {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .context("user input request not found")
    }

    pub fn reap(&self) {
        let cutoff = now().saturating_sub(TERMINAL_RETENTION_MS);
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, entry| {
                entry
                    .data
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .terminal_at
                    .is_none_or(|terminal| terminal >= cutoff)
            });
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn normalize_sync_questions(questions: &mut [Question]) -> anyhow::Result<()> {
    ensure!(
        !questions.is_empty() && questions.len() <= 3,
        "questions must contain 1..3 items"
    );
    for question in questions {
        ensure!(
            !question.id.trim().is_empty(),
            "question id must not be empty"
        );
        ensure!(
            !question.question.trim().is_empty(),
            "question must not be empty"
        );
        let options = question
            .options
            .as_ref()
            .filter(|options| !options.is_empty())
            .context("request_user_input requires non-empty options for every question")?;
        ensure!(
            options.iter().all(|option| !option.label.trim().is_empty()),
            "option labels must not be empty"
        );
        question.is_other = true;
    }
    Ok(())
}

fn normalize_async_questions(questions: Vec<AsyncQuestion>) -> anyhow::Result<Vec<Question>> {
    ensure!(!questions.is_empty(), "questions must not be empty");
    questions
        .into_iter()
        .enumerate()
        .map(|(index, question)| {
            ensure!(
                !question.title.trim().is_empty(),
                "question titles must not be empty"
            );
            let options = question
                .options
                .map(|options| {
                    ensure!(
                        !options.is_empty()
                            && options.iter().all(|option| !option.trim().is_empty()),
                        "options must contain at least one non-empty answer"
                    );
                    Ok::<_, anyhow::Error>(
                        options
                            .into_iter()
                            .map(|label| QuestionOption {
                                label,
                                description: String::new(),
                            })
                            .collect::<Vec<_>>(),
                    )
                })
                .transpose()?;
            Ok(Question {
                id: format!("q{}", index + 1),
                header: String::new(),
                question: question.title,
                is_other: options.is_some(),
                is_secret: false,
                options,
            })
        })
        .collect()
}

fn recommended_response(questions: &[Question]) -> anyhow::Result<UserResponse> {
    let mut answers = HashMap::new();
    for question in questions {
        let label = question
            .options
            .as_ref()
            .and_then(|options| options.first())
            .map(|option| option.label.clone())
            .context("recommended option is missing")?;
        answers.insert(
            question.id.clone(),
            UserAnswer {
                answers: vec![label],
            },
        );
    }
    Ok(UserResponse { answers })
}

fn validate_response(questions: &[Question], response: &UserResponse) -> anyhow::Result<()> {
    for question in questions {
        let answer = response
            .answers
            .get(&question.id)
            .with_context(|| format!("missing answer for {}", question.id))?;
        ensure!(
            !answer.answers.is_empty()
                && answer.answers.iter().any(|value| !value.trim().is_empty()),
            "answer for {} must not be empty",
            question.id
        );
    }
    Ok(())
}

fn async_status_value(data: &RequestData) -> Value {
    let message = match data.status {
        Status::Unseen => "用户没有看到提问",
        Status::Opened => "用户正在思考",
        Status::Answered => "用户已回答",
        Status::AutoSelected => "已自动选择推荐项",
        Status::Closed => "提问已由模型结束",
        Status::Expired => "提问已超时，用户没有回复",
    };
    json!({
        "request_id": data.id,
        "status": data.status.model_status(),
        "state": data.status.as_str(),
        "message": message,
        "answers": data.response.as_ref().map(|response| &response.answers),
        "expires_at": data.expires_at,
    })
}

fn terminal_output(data: &RequestData) -> Value {
    json!({
        "request_id": data.id,
        "mode": data.mode.as_str(),
        "status": data.status.as_str(),
        "resolution": data.resolution,
        "answers": data.response.as_ref().map(|response| &response.answers),
    })
}

fn snapshot_value(data: &RequestData, include_capability: bool) -> Value {
    let mut value = json!({
        "id": data.id,
        "tool": data.tool,
        "mode": data.mode.as_str(),
        "status": data.status.as_str(),
        "model_status": data.status.model_status(),
        "created_at": data.created_at,
        "expires_at": data.expires_at,
        "questions": data.questions,
        "answers": data.response.as_ref().map(|response| &response.answers),
        "resolution": data.resolution,
        "terminal": data.status.terminal(),
    });
    if include_capability {
        value["capability"] = json!(data.capability);
    }
    value
}

fn session_meta(data: &RequestData) -> Value {
    json!({
        "userInputSession": {
            "requestId": data.id,
            "capability": data.capability,
            "status": data.status.as_str(),
            "createdAt": data.created_at,
            "expiresAt": data.expires_at,
        }
    })
}

fn widget_session_meta(data: &RequestData) -> Value {
    let mut meta = session_meta(data);
    meta["ui"] = json!({"resourceUri": RESOURCE_URI});
    meta["openai/outputTemplate"] = json!(RESOURCE_URI);
    meta["openai/widgetAccessible"] = json!(true);
    meta["openai/toolInvocation/invoking"] = json!("已创建异步提问");
    meta["openai/toolInvocation/invoked"] = json!("等待你的回答");
    meta
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize(&object[&key]));
            }
            Value::Object(sorted)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonicalize).collect()),
        _ => value.clone(),
    }
}

fn match_key(tool: &str, args: &Value) -> String {
    let mut normalized = canonicalize(args);
    if tool == "request_user_input_async"
        && let Some(object) = normalized.as_object_mut()
        && object
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|v| v == "create")
    {
        object.remove("action");
    }
    format!("{tool}:{}", normalized)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindRequest {
    pub tool: String,
    pub arguments: Value,
}

#[derive(Deserialize, Default)]
pub struct WaitQuery {
    pub wait_ms: Option<u64>,
    #[serde(default)]
    pub include_capability: bool,
}

fn monitor_allowed(app: &App, headers: &HeaderMap) -> bool {
    app.observer.allowed(headers)
}

fn capability_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-user-input-capability")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn authorize_request(app: &App, headers: &HeaderMap, id: &str) -> bool {
    if !monitor_allowed(app, headers) {
        return false;
    }
    capability_header(headers)
        .is_none_or(|capability| app.user_inputs.capability_matches(id, capability))
}

pub async fn monitor_bind(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<BindRequest>,
) -> Response {
    if !monitor_allowed(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match app.user_inputs.bind(&body.tool, &body.arguments) {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn monitor_get(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Query(query): Query<WaitQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorize_request(&app, &headers, &id) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let result = if let Some(wait) = query.wait_ms {
        if query.include_capability {
            app.user_inputs
                .wait_snapshot_with_capability(&id, wait)
                .await
        } else {
            app.user_inputs.wait_snapshot(&id, wait).await
        }
    } else if query.include_capability {
        app.user_inputs.snapshot_with_capability(&id)
    } else {
        app.user_inputs.snapshot(&id)
    };
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn monitor_opened(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorize_request(&app, &headers, &id) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match app.user_inputs.mark_opened(&id) {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn monitor_answer(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(response): Json<UserResponse>,
) -> Response {
    if !authorize_request(&app, &headers, &id) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match app.user_inputs.answer(&id, response) {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::CONFLICT,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}

pub fn resource_descriptor(public_origin: &str) -> Value {
    json!({
        "uri": RESOURCE_URI,
        "name": "Codex User Input",
        "description": "Inline response UI for Codex user-input requests.",
        "mimeType": RESOURCE_MIME,
        "_meta": {
            "ui": {
                "prefersBorder": true,
                "csp": {
                    "connectDomains": [public_origin]
                }
            },
            "openai/widgetDescription": "Answer the active Codex question inline without leaving ChatGPT."
        }
    })
}

pub fn resource_contents(public_origin: &str, widget_key: &str) -> Value {
    let html = include_str!("user_input_widget.html")
        .replace(
            "__MWS_PUBLIC_ORIGIN__",
            &serde_json::to_string(public_origin).unwrap(),
        )
        .replace(
            "__MWS_WIDGET_KEY__",
            &serde_json::to_string(widget_key).unwrap(),
        );
    let descriptor = resource_descriptor(public_origin);
    json!({
        "contents": [{
            "uri": RESOURCE_URI,
            "mimeType": RESOURCE_MIME,
            "text": html,
            "_meta": descriptor["_meta"].clone()
        }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_inputs(sync_timeout_seconds: u64) -> Arc<UserInputs> {
        UserInputs::new(
            UserInputConfig {
                public_origin: None,
                sync_unseen_timeout_seconds: sync_timeout_seconds,
                async_timeout_seconds: 600,
                async_poll_wait_ms: 250,
            },
            Arc::new(Observer::new(None)),
        )
    }

    fn sync_args() -> (Value, SyncArgs) {
        let raw = json!({
            "questions":[{
                "id":"choice",
                "header":"Test",
                "question":"Choose?",
                "options":[
                    {"label":"First (Recommended)","description":"first"},
                    {"label":"Second","description":"second"}
                ]
            }]
        });
        let args = serde_json::from_value(raw.clone()).unwrap();
        (raw, args)
    }

    async fn first_request_id(inputs: &UserInputs) -> String {
        for _ in 0..100 {
            if let Some(id) = inputs
                .requests
                .lock()
                .unwrap()
                .values()
                .next()
                .map(|entry| entry.data.lock().unwrap().id.clone())
            {
                return id;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("request was not created");
    }

    #[test]
    fn canonical_match_ignores_explicit_async_create() {
        let a = json!({"questions":[{"title":"Q"}]});
        let b = json!({"action":"create","questions":[{"title":"Q"}]});
        assert_eq!(
            match_key("request_user_input_async", &a),
            match_key("request_user_input_async", &b)
        );
    }

    #[test]
    fn sync_normalization_adds_other() {
        let mut questions = vec![Question {
            id: "target".into(),
            header: "Target".into(),
            question: "Where?".into(),
            is_other: false,
            is_secret: false,
            options: Some(vec![QuestionOption {
                label: "A".into(),
                description: "A".into(),
            }]),
        }];
        normalize_sync_questions(&mut questions).unwrap();
        assert!(questions[0].is_other);
    }

    #[tokio::test]
    async fn sync_unseen_timeout_selects_first_option() {
        let inputs = test_inputs(1);
        let (raw, args) = sync_args();
        let result = inputs.sync("owner", &raw, args).await.unwrap();
        assert_eq!(
            result.data["answers"]["choice"]["answers"][0],
            "First (Recommended)"
        );
    }

    #[tokio::test]
    async fn opening_sync_request_cancels_automatic_selection() {
        let inputs = test_inputs(1);
        let (raw, args) = sync_args();
        let worker = {
            let inputs = inputs.clone();
            tokio::spawn(async move { inputs.sync("owner", &raw, args).await })
        };
        let id = first_request_id(&inputs).await;
        inputs.mark_opened(&id).unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!worker.is_finished());
        inputs
            .answer(
                &id,
                UserResponse {
                    answers: HashMap::from([(
                        "choice".into(),
                        UserAnswer {
                            answers: vec!["Second".into()],
                        },
                    )]),
                },
            )
            .unwrap();
        let result = worker.await.unwrap().unwrap();
        assert_eq!(result.data["answers"]["choice"]["answers"][0], "Second");
    }

    #[tokio::test]
    async fn sync_timeout_cannot_win_after_opened_transition() {
        let inputs = test_inputs(60);
        let (raw, mut args) = sync_args();
        normalize_sync_questions(&mut args.questions).unwrap();
        let entry = inputs
            .create_request(
                "owner",
                "request_user_input",
                Mode::Sync,
                args.questions,
                &raw,
                None,
            )
            .unwrap();
        let id = entry.data.lock().unwrap().id.clone();
        inputs.mark_opened(&id).unwrap();
        let response = {
            let data = entry.data.lock().unwrap();
            recommended_response(&data.questions).unwrap()
        };
        assert!(
            !inputs
                .resolve_if_status(
                    &entry,
                    Some(Status::Unseen),
                    Status::AutoSelected,
                    Some(response),
                    "sync_unseen_timeout",
                )
                .unwrap()
        );
        assert_eq!(entry.data.lock().unwrap().status, Status::Opened);
    }

    #[tokio::test]
    async fn second_answer_does_not_overwrite_first_answer() {
        let inputs = test_inputs(60);
        let (raw, mut args) = sync_args();
        normalize_sync_questions(&mut args.questions).unwrap();
        let entry = inputs
            .create_request(
                "owner",
                "request_user_input",
                Mode::Sync,
                args.questions,
                &raw,
                None,
            )
            .unwrap();
        let id = entry.data.lock().unwrap().id.clone();
        let first = UserResponse {
            answers: HashMap::from([(
                "choice".into(),
                UserAnswer {
                    answers: vec!["First (Recommended)".into()],
                },
            )]),
        };
        let second = UserResponse {
            answers: HashMap::from([(
                "choice".into(),
                UserAnswer {
                    answers: vec!["Second".into()],
                },
            )]),
        };
        inputs.answer(&id, first).unwrap();
        assert!(inputs.answer(&id, second).is_err());
        let snapshot = inputs.snapshot(&id).unwrap();
        assert_eq!(
            snapshot["answers"]["choice"]["answers"][0],
            "First (Recommended)"
        );
    }
}
