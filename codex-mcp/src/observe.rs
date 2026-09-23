//! Authenticated observation stream for mcpmonitor.
//!
//! codex-mcp owns only live tool-call state. Historical retention belongs to the
//! monitor. The v2 endpoint streams lifecycle deltas and keeps no completed-call
//! history in this process.
use crate::{App, redact};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

const IMAGE_BYTES: usize = 2 * 1024 * 1024;
use tokio::sync::broadcast;

const ARGUMENT_BYTES: usize = 32 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MonitorConfig {
    pub token_file: PathBuf,
    /// Accepted for rolling upgrades from the v1 snapshot protocol. It no
    /// longer controls retention and is intentionally ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_calls: Option<usize>,
    #[serde(default = "default_output")]
    pub output_bytes: usize,
    #[serde(default = "default_event_buffer")]
    pub event_buffer: usize,
}

fn default_output() -> usize {
    32768
}
fn default_event_buffer() -> usize {
    1024
}

impl MonitorConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.token_file.is_absolute(),
            "monitor token_file must be absolute"
        );
        let token = std::fs::read_to_string(&self.token_file)?;
        anyhow::ensure!(
            token.trim().len() >= 32,
            "monitor token must have at least 32 characters"
        );
        anyhow::ensure!(
            (4096..=65536).contains(&self.output_bytes),
            "monitor output_bytes must be 4096..65536"
        );
        anyhow::ensure!(
            (64..=8192).contains(&self.event_buffer),
            "monitor event_buffer must be 64..8192"
        );
        Ok(())
    }
}

#[derive(Clone)]
pub struct CallRef {
    pub id: String,
}

#[derive(Clone, Serialize)]
struct CallState {
    id: String,
    tool: String,
    kind: String,
    status: String,
    arguments: Value,
    #[serde(skip)]
    raw_output: Vec<u8>,
    truncated: bool,
    started_at: u64,
    ended_at: Option<u64>,
    duration_ms: Option<u64>,
    background: bool,
    process_id: Option<u64>,
    exit_code: Option<i32>,
    image: Option<String>,
}

pub struct Observer {
    config: Option<MonitorConfig>,
    token_hash: Option<[u8; 32]>,
    boot: String,
    sequence: AtomicU64,
    active: Mutex<HashMap<String, CallState>>,
    events: broadcast::Sender<Arc<Value>>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
fn bound(value: &str, bytes: usize) -> String {
    codex_utils_string::truncate_middle_chars(value, bytes)
}

impl Observer {
    pub fn new(config: Option<MonitorConfig>) -> Self {
        let token_hash = config
            .as_ref()
            .and_then(|c| std::fs::read_to_string(&c.token_file).ok())
            .map(|v| digest(v.trim()));
        let capacity = config
            .as_ref()
            .map(|c| c.event_buffer)
            .unwrap_or_else(default_event_buffer);
        let (events, _) = broadcast::channel(capacity);
        Self {
            config,
            token_hash,
            boot: uuid::Uuid::new_v4().to_string(),
            sequence: AtomicU64::new(0),
            active: Mutex::new(HashMap::new()),
            events,
        }
    }

    pub fn enabled(&self) -> bool {
        self.config.is_some()
    }

    fn allowed(&self, headers: &HeaderMap) -> bool {
        let token = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or("");
        self.token_hash.is_some_and(|expected| {
            expected
                .iter()
                .zip(digest(token))
                .fold(0u8, |n, (a, b)| n | (a ^ b))
                == 0
        })
    }

    fn output_budget(&self) -> usize {
        self.config.as_ref().map_or(0, |c| c.output_bytes)
    }

    fn emit(&self, call_id: Option<&str>, kind: &str, data: Value) {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let value = Arc::new(json!({
            "schema_version": 3,
            "service": "codex-mcp",
            "version": env!("CARGO_PKG_VERSION"),
            "boot_id": self.boot,
            "sequence": sequence,
            "emitted_at": now(),
            "event": kind,
            "call_id": call_id,
            "data": data,
        }));
        // No receiver is normal when mcpmonitor is offline. The stream is a
        // transport, not a history store.
        let _ = self.events.send(value);
    }

    fn sanitize_args(&self, args: &Value) -> Value {
        let mut input = serde_json::Map::new();
        let mut budget = ARGUMENT_BYTES;
        for key in [
            "cmd",
            "input",
            "path",
            "workdir",
            "session_id",
            "chars",
            "tty",
            "shell",
            "login",
            "yield_time_ms",
            "max_output_tokens",
            "detail",
        ] {
            if let Some(value) = args.get(key) {
                if let Some(text) = value.as_str() {
                    let text = redact::text(text);
                    let text = bound(&text, budget.min(16384));
                    budget = budget.saturating_sub(text.len());
                    input.insert(key.into(), json!(text));
                } else if value.is_number() || value.is_boolean() {
                    input.insert(key.into(), value.clone());
                }
            }
        }
        redact::value(Value::Object(input))
    }

    fn sanitize_browser_args(&self, args: &Value) -> Value {
        let mut input = serde_json::Map::new();
        for key in [
            "x",
            "y",
            "from_x",
            "from_y",
            "to_x",
            "to_y",
            "button",
            "click_count",
            "key",
            "direction",
            "pages",
            "chars",
            "index",
            "mode",
            "action",
            "locator",
            "selection_type",
            "format",
            "tab_id",
            "title",
            "timeout_ms",
        ] {
            let Some(value) = args.get(key) else { continue };
            if let Some(text) = value.as_str() {
                let text = redact::text(text);
                input.insert(key.into(), json!(bound(&text, 1024)));
            } else if value.is_number() || value.is_boolean() {
                input.insert(key.into(), value.clone());
            }
        }
        redact::value(Value::Object(input))
    }

    /// Accept CUA tool and legacy browser-input lifecycle events emitted by the managed
    /// CUA worker. They are folded into the same observation stream as shell,
    /// patch and image calls so mcpmonitor can render one chronological feed.
    pub fn browser_activity(&self, event: &Value) {
        if self.config.is_none() {
            return;
        }
        let Some(id) = event["id"].as_str().filter(|v| !v.is_empty()) else {
            return;
        };
        let Some(tool) = event["tool"]
            .as_str()
            .filter(|v| v.starts_with("browser_") || v.starts_with("cua_repl."))
        else {
            return;
        };
        let kind = if tool.starts_with("cua_repl.") {
            "cuaCall"
        } else {
            "browserInput"
        };
        let phase = event["phase"].as_str().unwrap_or("");
        let mut raw_args = event.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if let Some(tab_id) = event["tab_id"].as_str()
            && let Some(object) = raw_args.as_object_mut()
        {
            object.insert("tab_id".into(), json!(tab_id));
        }
        let arguments = self.sanitize_browser_args(&raw_args);
        let started_at = event["started_at"].as_u64().unwrap_or_else(now);

        if phase == "started" {
            let state = CallState {
                id: id.to_string(),
                tool: tool.to_string(),
                kind: kind.into(),
                status: "running".into(),
                arguments: arguments.clone(),
                raw_output: Vec::new(),
                truncated: false,
                started_at,
                ended_at: None,
                duration_ms: None,
                background: false,
                process_id: None,
                exit_code: None,
                image: None,
            };
            self.active
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.to_string(), state);
            self.emit(
                Some(id),
                "call_started",
                json!({
                    "tool": tool,
                    "kind": kind,
                    "status": "running",
                    "arguments": arguments,
                    "started_at": started_at,
                    "background": false,
                }),
            );
            return;
        }

        if phase != "finished" {
            return;
        }
        let finished = {
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            let Some(mut c) = active.remove(id) else {
                return;
            };
            let ended_at = event["ended_at"].as_u64().unwrap_or_else(now);
            c.status = if event["status"].as_str() == Some("failed") {
                "failed"
            } else {
                "completed"
            }
            .into();
            c.ended_at = Some(ended_at);
            c.duration_ms = event["duration_ms"]
                .as_u64()
                .or_else(|| Some(ended_at.saturating_sub(c.started_at)));
            if c.status == "failed"
                && let Some(error) = event["error"].as_str()
            {
                c.raw_output = bound(&redact::text(error), 4096).into_bytes();
            }
            c
        };
        self.emit_finished(finished);
    }

    pub fn begin(&self, tool: &str, args: &Value) -> Option<CallRef> {
        self.config.as_ref()?;
        let id = uuid::Uuid::new_v4().to_string();
        let started_at = now();
        let arguments = self.sanitize_args(args);
        let kind = match tool {
            "exec_command" => "commandExecution",
            "apply_patch" => "fileChange",
            "view_image" => "imageView",
            _ => "stdin",
        }
        .to_string();
        let state = CallState {
            id: id.clone(),
            tool: tool.into(),
            kind: kind.clone(),
            status: "running".into(),
            arguments: arguments.clone(),
            raw_output: Vec::new(),
            truncated: false,
            started_at,
            ended_at: None,
            duration_ms: None,
            background: false,
            process_id: None,
            exit_code: None,
            image: None,
        };
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), state);
        self.emit(
            Some(&id),
            "call_started",
            json!({
                "tool": tool,
                "kind": kind,
                "status": "running",
                "arguments": arguments,
                "started_at": started_at,
                "background": false,
            }),
        );
        Some(CallRef { id })
    }

    pub fn process(&self, call: &Option<CallRef>, process: u64) {
        let Some(call) = call else { return };
        let changed = {
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            active
                .get_mut(&call.id)
                .map(|c| c.process_id = Some(process))
                .is_some()
        };
        if changed {
            self.emit(Some(&call.id), "call_state", json!({"process_id": process}));
        }
    }

    pub fn output(&self, call: &Option<CallRef>, chunk: &[u8]) {
        let Some(call) = call else { return };
        let budget = self.output_budget();
        let changed = {
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            let Some(c) = active.get_mut(&call.id) else {
                return;
            };
            c.raw_output.extend_from_slice(chunk);
            if c.raw_output.len() > budget {
                c.truncated = true;
                let excess = c.raw_output.len() - budget;
                c.raw_output.drain(budget / 2..budget / 2 + excess);
            }
            true
        };
        if changed {
            // Deliberately content-free. Output is emitted only in the final
            // detail event so secrets split across process chunks cannot leak.
            self.emit(Some(&call.id), "call_activity", json!({}));
        }
    }

    pub fn process_exit(&self, call: &Option<CallRef>, code: Option<i32>) {
        let Some(call) = call else { return };
        let finished = {
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            let Some(mut c) = active.remove(&call.id) else {
                return;
            };
            let ended_at = now();
            c.exit_code = code;
            c.status = if code == Some(0) {
                "completed"
            } else {
                "failed"
            }
            .into();
            c.ended_at = Some(ended_at);
            c.duration_ms = Some(ended_at.saturating_sub(c.started_at));
            c
        };
        self.emit_finished(finished);
    }

    pub fn finish(&self, call: &Option<CallRef>, result: &anyhow::Result<Value>) {
        let Some(call) = call else { return };

        if let Ok(value) = result {
            let data = &value["structuredContent"];
            let error = value["isError"].as_bool().unwrap_or(false);
            if data["session_id"].is_number() && !error {
                let session_id = data["session_id"].as_u64();
                let background = {
                    let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(c) = active.get_mut(&call.id) {
                        if c.tool == "exec_command" {
                            c.background = true;
                            c.process_id = session_id.or(c.process_id);
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };
                if background {
                    self.emit(
                        Some(&call.id),
                        "call_state",
                        json!({"background": true, "process_id": session_id}),
                    );
                    return;
                }
            }
        }

        let finished = {
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            let Some(mut c) = active.remove(&call.id) else {
                // exec_command normally finishes in process_exit before the MCP
                // response is serialized.
                return;
            };
            let budget = self.output_budget();
            match result {
                Ok(value) => {
                    let data = &value["structuredContent"];
                    let error = value["isError"].as_bool().unwrap_or(false);
                    if c.tool != "exec_command" || c.raw_output.is_empty() {
                        let text = data["output"]
                            .as_str()
                            .or_else(|| value["content"][0]["text"].as_str())
                            .unwrap_or("");
                        c.truncated |= text.len() > budget;
                        c.raw_output = bound(text, budget).into_bytes();
                    }
                    c.exit_code = data["exit_code"].as_i64().map(|v| v as i32).or(c.exit_code);
                    c.process_id = data["session_id"]
                        .as_u64()
                        .or(c.arguments["session_id"].as_u64())
                        .or(c.process_id);
                    c.status = if error || c.exit_code.is_some_and(|n| n != 0) {
                        "failed"
                    } else {
                        "completed"
                    }
                    .into();
                    if c.tool == "view_image"
                        && let Some(image) = value["content"]
                            .as_array()
                            .and_then(|items| items.iter().find(|item| item["type"] == "image"))
                        && let (Some(encoded), Some(mime)) =
                            (image["data"].as_str(), image["mimeType"].as_str())
                        && encoded.len() <= IMAGE_BYTES
                        && matches!(
                            mime,
                            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                        )
                    {
                        c.image = Some(format!("data:{mime};base64,{encoded}"));
                    }
                }
                Err(e) => {
                    c.status = "failed".into();
                    c.raw_output = bound(&e.to_string(), budget.min(4096)).into_bytes();
                }
            }
            let ended_at = now();
            c.ended_at = Some(ended_at);
            c.duration_ms = Some(ended_at.saturating_sub(c.started_at));
            c
        };
        self.emit_finished(finished);
    }

    fn emit_finished(&self, mut c: CallState) {
        let output = redact::text(&String::from_utf8_lossy(&c.raw_output));
        c.raw_output.clear();
        self.emit(
            Some(&c.id),
            "call_finished",
            json!({
                "tool": c.tool,
                "kind": c.kind,
                "arguments": c.arguments,
                "started_at": c.started_at,
                "status": c.status,
                "ended_at": c.ended_at,
                "duration_ms": c.duration_ms,
                "background": c.background,
                "process_id": c.process_id,
                "exit_code": c.exit_code,
                "output": output,
                "truncated": c.truncated,
                "image": c.image,
            }),
        );
    }

    fn active_sync(&self) -> Vec<Value> {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        active
            .values()
            .map(|c| {
                json!({
                    "schema_version": 3,
                    "service": "codex-mcp",
                    "version": env!("CARGO_PKG_VERSION"),
                    "boot_id": self.boot,
                    "sequence": self.sequence.load(Ordering::Relaxed),
                    "emitted_at": now(),
                    "event": "call_sync",
                    "call_id": c.id,
                    "data": {
                        "tool": c.tool,
                        "kind": c.kind,
                        "status": c.status,
                        "arguments": c.arguments,
                        "started_at": c.started_at,
                        "background": c.background,
                        "process_id": c.process_id,
                    }
                })
            })
            .collect()
    }

    fn active_snapshot(&self) -> Value {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let mut calls = Vec::with_capacity(active.len());
        for c in active.values() {
            let mut c = c.clone();
            c.raw_output.clear();
            calls.push(c);
        }
        json!({
            "schema_version": 3,
            "service": "codex-mcp",
            "version": env!("CARGO_PKG_VERSION"),
            "boot_id": self.boot,
            "sequence": self.sequence.load(Ordering::Relaxed),
            "captured_at": now(),
            "retention": "active_only",
            "calls": calls,
        })
    }
}

/// Transitional v1-shaped endpoint. It intentionally exposes active calls only;
/// completed-call history is no longer retained by codex-mcp.
pub async fn snapshot(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !app.observer.enabled() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !app.observer.allowed(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    (
        [("cache-control", "no-store")],
        Json(app.observer.active_snapshot()),
    )
        .into_response()
}

pub async fn events(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !app.observer.enabled() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !app.observer.allowed(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut receiver = app.observer.events.subscribe();
    let mut shutdown = app.shutdown.subscribe();
    let sync_sequence = app.observer.sequence.load(Ordering::Relaxed);
    let active = app.observer.active_sync();
    let boot = app.observer.boot.clone();
    let stream = async_stream::stream! {
        let hello = json!({
            "schema_version": 3,
            "service": "codex-mcp",
            "version": env!("CARGO_PKG_VERSION"),
            "boot_id": boot,
            "sequence": sync_sequence,
            "emitted_at": now(),
            "event": "hello",
            "call_id": null,
            "data": {"retention":"active_only"},
        });
        yield Ok::<_, Infallible>(Event::default().event("observation").data(hello.to_string()));
        for item in active {
            yield Ok(Event::default().event("observation").data(item.to_string()));
        }
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                incoming = receiver.recv() => match incoming {
                    Ok(value) => {
                        let sequence = value["sequence"].as_u64().unwrap_or(0);
                        let kind = value["event"].as_str().unwrap_or("");
                        // A call may finish between the sequence snapshot and
                        // active-state capture. Final events are self-contained
                        // and idempotent, so replay them even when their
                        // sequence is at/before the sync watermark. Older
                        // partial lifecycle events are represented by call_sync.
                        if sequence <= sync_sequence && kind != "call_finished" { continue; }
                        yield Ok(Event::default().event("observation").data(value.to_string()));
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        let gap = json!({
                            "schema_version":3,"service":"codex-mcp","version":env!("CARGO_PKG_VERSION"),
                            "boot_id":boot,"sequence":app.observer.sequence.load(Ordering::Relaxed),"emitted_at":now(),
                            "event":"gap","call_id":null,"data":{"skipped":skipped}
                        });
                        yield Ok(Event::default().event("observation").data(gap.to_string()));
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    };
    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(10))
                .text("live"),
        )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn observer() -> (Observer, TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let token = temp.path().join("token");
        std::fs::write(&token, "test-observation-token-01234567890123").unwrap();
        let o = Observer::new(Some(MonitorConfig {
            token_file: token,
            max_calls: Some(16),
            output_bytes: 4096,
            event_buffer: 64,
        }));
        (o, temp)
    }

    #[tokio::test]
    async fn completed_calls_leave_no_history_and_emit_final_detail() {
        let (o, _temp) = observer();
        let mut rx = o.events.subscribe();
        let call = o.begin("exec_command", &json!({"cmd":"printf hi"}));
        let started = rx.recv().await.unwrap();
        assert_eq!(started["event"], "call_started");
        o.output(&call, "password='hide this value'\n中文🙂\n".as_bytes());
        let _activity = rx.recv().await.unwrap();
        o.process(&call, 123);
        let _state = rx.recv().await.unwrap();
        o.process_exit(&call, Some(0));
        let finished = rx.recv().await.unwrap();
        assert_eq!(finished["event"], "call_finished");
        assert_eq!(finished["data"]["process_id"], 123);
        assert!(
            finished["data"]["output"]
                .as_str()
                .unwrap()
                .contains("中文🙂")
        );
        assert!(
            !finished["data"]["output"]
                .as_str()
                .unwrap()
                .contains("hide this value")
        );
        assert!(o.active.lock().unwrap().is_empty());
        assert_eq!(o.active_snapshot()["calls"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn background_is_only_marked_after_live_session_response() {
        let (o, _temp) = observer();
        let mut rx = o.events.subscribe();
        let call = o.begin("exec_command", &json!({"cmd":"sleep 60"}));
        let _ = rx.recv().await.unwrap();
        o.process(&call, 22);
        let _ = rx.recv().await.unwrap();
        o.finish(
            &call,
            &Ok(json!({"structuredContent":{"session_id":22,"output":""},"isError":false})),
        );
        let state = rx.recv().await.unwrap();
        assert_eq!(state["event"], "call_state");
        assert_eq!(state["data"]["background"], true);
        assert!(o.active.lock().unwrap()[&call.unwrap().id].background);
    }

    #[tokio::test]
    async fn browser_activity_joins_normal_call_stream_without_text_payloads() {
        let (o, _temp) = observer();
        let mut rx = o.events.subscribe();
        o.browser_activity(&json!({
            "phase":"started","id":"browser-1","tool":"browser_click","tab_id":"tab-7",
            "arguments":{"x":321,"y":456,"button":"left","click_count":1,"secret":"do-not-store"},
            "started_at":1000
        }));
        let started = rx.recv().await.unwrap();
        assert_eq!(started["event"], "call_started");
        assert_eq!(started["data"]["tool"], "browser_click");
        assert_eq!(started["data"]["kind"], "browserInput");
        assert_eq!(started["data"]["arguments"]["x"], 321);
        assert_eq!(started["data"]["arguments"]["tab_id"], "tab-7");
        assert!(started["data"]["arguments"].get("secret").is_none());

        o.browser_activity(&json!({
            "phase":"finished","id":"browser-1","tool":"browser_click","tab_id":"tab-7",
            "arguments":{"x":321,"y":456,"button":"left","click_count":1},
            "started_at":1000,"ended_at":1012,"duration_ms":12,"status":"completed"
        }));
        let finished = rx.recv().await.unwrap();
        assert_eq!(finished["event"], "call_finished");
        assert_eq!(finished["data"]["duration_ms"], 12);
        assert_eq!(finished["data"]["status"], "completed");
        assert!(o.active.lock().unwrap().is_empty());
    }

    #[test]
    fn legacy_max_calls_is_accepted_but_not_a_retention_limit() {
        let (o, _temp) = observer();
        for _ in 0..40 {
            o.begin("exec_command", &json!({"cmd":"true"}));
        }
        assert_eq!(o.active.lock().unwrap().len(), 40);
    }
    #[tokio::test]
    async fn cua_tool_lifecycle_accepts_all_tools_without_code_payloads() {
        let (o, _temp) = observer();
        let mut rx = o.events.subscribe();
        for tool in [
            "cua_repl.js",
            "cua_repl.js_reset",
            "cua_repl.js_add_node_module_dir",
            "cua_repl.turn_ended",
            "cua_repl.cua_live",
            "cua_repl.viewer_session",
        ] {
            o.browser_activity(&json!({"id":tool,"tool":tool,"phase":"started","started_at":100,"arguments":{"title":"CUA check","code":"private source","timeout_ms":1000}}));
            let started = rx.recv().await.unwrap();
            assert_eq!(started["event"], "call_started");
            assert_eq!(started["data"]["kind"], "cuaCall");
            assert_eq!(started["data"]["arguments"]["title"], "CUA check");
            assert!(started["data"]["arguments"].get("code").is_none());
            o.browser_activity(&json!({"id":tool,"tool":tool,"phase":"finished","ended_at":130,"status":"failed","error":"test error"}));
            let finished = rx.recv().await.unwrap();
            assert_eq!(finished["event"], "call_finished");
            assert_eq!(finished["data"]["status"], "failed");
            assert_eq!(finished["data"]["duration_ms"], 30);
        }
    }
}
