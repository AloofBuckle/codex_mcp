use crate::{Config, push::PushHub, store::Store};
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{broadcast, watch};

const BROWSER_REPLAY_CAPACITY: usize = 4096;

#[derive(Clone)]
pub struct HubEvent {
    pub revision: u64,
    pub value: Arc<Value>,
}

#[derive(Default)]
struct ReplayState {
    head: u64,
    events: VecDeque<Arc<HubEvent>>,
}

pub enum ReplayAfter {
    Available {
        head: u64,
        events: Vec<Arc<HubEvent>>,
    },
    TooOld {
        head: u64,
        oldest: Option<u64>,
    },
}

pub struct Hub {
    events: broadcast::Sender<Arc<HubEvent>>,
    replay: Mutex<ReplayState>,
    pub connection: watch::Sender<Arc<Value>>,
    push: Arc<PushHub>,
}

impl Hub {
    pub fn start(
        config: &Config,
        token: String,
        store: Arc<Store>,
        push: Arc<PushHub>,
        client: crate::upstream::Client,
    ) -> anyhow::Result<Arc<Self>> {
        let _ = config;
        let (events, _) = broadcast::channel(1024);
        let (connection, _) = watch::channel(Arc::new(connection_value(
            "connecting",
            "正在连接 codex-mcp",
        )));
        let hub = Arc::new(Self {
            events,
            replay: Mutex::new(ReplayState::default()),
            connection,
            push,
        });
        let weak = Arc::downgrade(&hub);
        tokio::spawn(async move {
            let mut last_boot = String::new();
            let mut last_sequence = 0u64;
            loop {
                let Some(hub) = weak.upgrade() else { break };
                hub.set_connection("connecting", "正在连接 codex-mcp");
                let result: anyhow::Result<()> = async {
                    let mut response = client
                        .request(
                            "GET",
                            "/monitor/v2/events",
                            vec![
                                crate::upstream::header("authorization", format!("Bearer {token}")),
                                crate::upstream::header("accept", "text/event-stream"),
                            ],
                            Vec::new(),
                        )
                        .await?;
                    anyhow::ensure!(
                        (200..300).contains(&response.status()),
                        "upstream RPC status {}",
                        response.status()
                    );
                    let content_type = response
                        .header("content-type")
                        .and_then(|v| std::str::from_utf8(v).ok())
                        .unwrap_or("");
                    anyhow::ensure!(
                        content_type.starts_with("text/event-stream"),
                        "upstream is not SSE"
                    );
                    hub.set_connection("online", "已连接");
                    let mut buffer = Vec::<u8>::new();
                    while let Some(chunk) = response.chunk().await? {
                        buffer.extend_from_slice(&chunk);
                        let mut consumed = 0;
                        while let Some((relative_end, separator_len)) =
                            find_event_end(&buffer[consumed..])
                        {
                            let end = consumed + relative_end;
                            if let Some(value) = parse_sse_data(&buffer[consumed..end])? {
                                handle_observation(
                                    &hub,
                                    store.clone(),
                                    Some((&client, &token)),
                                    value,
                                    &mut last_boot,
                                    &mut last_sequence,
                                )
                                .await?;
                            }
                            consumed = end + separator_len;
                        }
                        if consumed != 0 {
                            buffer.drain(..consumed);
                        }
                    }
                    anyhow::bail!("upstream event stream ended")
                }
                .await;
                if result.is_err() {
                    hub.set_connection("offline", "暂时无法连接 codex-mcp，正在重试");
                }
                drop(hub);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        Ok(hub)
    }

    fn set_connection(&self, state: &str, message: &str) {
        let value = Arc::new(connection_value(state, message));
        if self.connection.borrow().as_ref() != value.as_ref() {
            self.connection.send_replace(value.clone());
            self.publish(json!({
                "event":"connection",
                "connection":state,
                "message":message,
                "received_at":now(),
            }));
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<HubEvent>> {
        self.events.subscribe()
    }

    pub fn head_revision(&self) -> u64 {
        self.replay
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .head
    }

    pub fn replay_after(&self, revision: u64) -> ReplayAfter {
        let replay = self
            .replay
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let head = replay.head;
        let oldest = replay.events.front().map(|event| event.revision);
        if revision > head
            || (revision < head
                && oldest
                    .is_some_and(|oldest_revision| revision.saturating_add(1) < oldest_revision))
        {
            return ReplayAfter::TooOld { head, oldest };
        }
        ReplayAfter::Available {
            head,
            events: replay
                .events
                .iter()
                .filter(|event| event.revision > revision)
                .cloned()
                .collect(),
        }
    }

    fn publish(&self, value: Value) -> u64 {
        let event = {
            let mut replay = self
                .replay
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            replay.head = replay.head.saturating_add(1);
            let event = Arc::new(HubEvent {
                revision: replay.head,
                value: Arc::new(value),
            });
            replay.events.push_back(event.clone());
            while replay.events.len() > BROWSER_REPLAY_CAPACITY {
                replay.events.pop_front();
            }
            event
        };
        let revision = event.revision;
        let _ = self.events.send(event);
        revision
    }
}

async fn handle_observation(
    hub: &Hub,
    store: Arc<Store>,
    ack: Option<(&crate::upstream::Client, &str)>,
    value: Value,
    last_boot: &mut String,
    last_sequence: &mut u64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        value["schema_version"] == 3,
        "unsupported observation protocol"
    );
    anyhow::ensure!(
        value["service"] == "codex-mcp",
        "unexpected observation service"
    );
    let event = value["event"].as_str().unwrap_or("");
    let boot = value["boot_id"].as_str().unwrap_or("");
    let sequence = value["sequence"].as_u64().unwrap_or(0);

    if event == "hello" {
        let reconciliation = if let Some(active_call_ids) = value["data"]
            .get("active_call_ids")
            .and_then(Value::as_array)
        {
            let mut active_call_ids = active_call_ids
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<HashSet<_>>();
            if let Some(pending_terminal_call_ids) = value["data"]
                .get("terminal_replay_call_ids")
                .and_then(Value::as_array)
            {
                active_call_ids.extend(
                    pending_terminal_call_ids
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned),
                );
            }
            let reconcile_store = store.clone();
            let reconcile_boot = boot.to_string();
            tokio::task::spawn_blocking(move || {
                reconcile_store.reconcile_running_calls(&reconcile_boot, &active_call_ids, now())
            })
            .await
            .map_err(|error| anyhow::anyhow!("history database worker failed: {error}"))??
        } else {
            Default::default()
        };
        let restarted = !last_boot.is_empty() && *last_boot != boot;
        *last_boot = boot.to_string();
        *last_sequence = sequence;
        if !reconciliation.removed_user_inputs.is_empty() {
            for id in &reconciliation.removed_user_inputs {
                let request = json!({
                    "id":id,
                    "status":"closed",
                    "terminal":true,
                    "resolution":"source_lost",
                });
                let push = hub.push.clone();
                let notification = request.clone();
                tokio::spawn(async move {
                    push.notify_user_input(notification).await;
                });
                hub.publish(json!({
                    "event":"user_input_notify",
                    "request":request,
                    "received_at":now(),
                }));
            }
        }
        if !reconciliation.removed_user_inputs.is_empty()
            || !reconciliation.interrupted_calls.is_empty()
        {
            hub.publish(json!({
                "event":"list_reset",
                "reason":"source_reconcile",
                "removed":reconciliation.removed_user_inputs,
                "interrupted":reconciliation.interrupted_calls,
            }));
        }
        if let Some(gap) = value["data"]
            .get("terminal_replay_gap")
            .filter(|gap| !gap.is_null())
        {
            hub.publish(json!({
                "event":"gap",
                "message":"终态重放缓冲发生溢出，无法恢复的调用已标记为已中断",
                "terminal_replay_gap":gap,
            }));
            if let Some((client, token)) = ack
                && let Some(gap_through) = gap["to_sequence"].as_u64()
            {
                acknowledge_gap(client, token, boot, gap_through).await?;
            }
        }
        if restarted {
            hub.publish(json!({"event":"source_restart","boot_id":boot}));
        }
        return Ok(());
    }

    // call_sync intentionally shares the hello sequence and reconstructs only
    // currently active calls after a monitor reconnect.
    if event != "call_sync" {
        if !last_boot.is_empty() && *last_boot == boot && sequence > last_sequence.saturating_add(1)
        {
            hub.publish(json!({
                "event":"gap",
                "message":"观察流存在缺口",
                "from":last_sequence.saturating_add(1),
                "to":sequence.saturating_sub(1),
            }));
            anyhow::bail!("observation sequence gap; reconnecting for terminal replay");
        }
        if *last_boot == boot && sequence <= *last_sequence && event != "call_finished" {
            return Ok(());
        }
        *last_boot = boot.to_string();
        *last_sequence = (*last_sequence).max(sequence);
    }

    if event == "gap" {
        hub.publish(json!({
            "event":"gap",
            "message":"codex-mcp 观察缓冲区发生丢帧",
            "skipped":value["data"]["skipped"],
        }));
        anyhow::bail!("codex-mcp observation buffer lagged; reconnecting for terminal replay");
    }

    if event == "user_input_notify" {
        let notification = value["data"].clone();
        let push = hub.push.clone();
        tokio::spawn(async move {
            push.notify_user_input(notification).await;
        });
        let mut request = value["data"].clone();
        if let Some(object) = request.as_object_mut() {
            object.remove("capability");
        }
        hub.publish(json!({
            "event":"user_input_notify",
            "request":request,
            "received_at":now(),
        }));
        return Ok(());
    }

    let source_event = event.to_owned();
    let ack_boot = boot.to_string();
    let ack_sequence = sequence;
    let summary = tokio::task::spawn_blocking(move || store.apply_observation(&value))
        .await
        .map_err(|error| anyhow::anyhow!("history database worker failed: {error}"))??;
    if source_event == "call_finished"
        && let Some((client, token)) = ack
    {
        acknowledge_terminal(client, token, &ack_boot, ack_sequence).await?;
    }
    if let Some(summary) = summary {
        hub.publish(json!({
            "event":"summary",
            "source_event":source_event,
            "call":summary
        }));
    }
    Ok(())
}

async fn acknowledge_terminal(
    client: &crate::upstream::Client,
    token: &str,
    boot_id: &str,
    sequence: u64,
) -> anyhow::Result<()> {
    let payload = serde_json::to_vec(&json!({"boot_id":boot_id,"sequence":sequence}))?;
    let response = client
        .request(
            "POST",
            "/monitor/v2/ack",
            vec![
                crate::upstream::header("authorization", format!("Bearer {token}")),
                crate::upstream::header("content-type", "application/json"),
                crate::upstream::header("accept", "application/json"),
            ],
            payload,
        )
        .await?;
    anyhow::ensure!(
        (200..300).contains(&response.status()),
        "terminal ACK status {}",
        response.status()
    );
    let _ = response.bytes().await?;
    Ok(())
}

async fn acknowledge_gap(
    client: &crate::upstream::Client,
    token: &str,
    boot_id: &str,
    gap_through: u64,
) -> anyhow::Result<()> {
    let payload = serde_json::to_vec(&json!({
        "boot_id":boot_id,
        "gap_through":gap_through,
    }))?;
    let response = client
        .request(
            "POST",
            "/monitor/v2/ack",
            vec![
                crate::upstream::header("authorization", format!("Bearer {token}")),
                crate::upstream::header("content-type", "application/json"),
                crate::upstream::header("accept", "application/json"),
            ],
            payload,
        )
        .await?;
    anyhow::ensure!(
        (200..300).contains(&response.status()),
        "terminal gap ACK status {}",
        response.status()
    );
    let _ = response.bytes().await?;
    Ok(())
}

fn find_event_end(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|window| window == b"\n\n");
    let crlf = buffer.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(lf), Some(crlf)) if lf < crlf => Some((lf, 2)),
        (Some(_), Some(crlf)) => Some((crlf, 4)),
        (Some(lf), None) => Some((lf, 2)),
        (None, Some(crlf)) => Some((crlf, 4)),
        (None, None) => None,
    }
}

fn parse_sse_data(block: &[u8]) -> anyhow::Result<Option<Value>> {
    let text = std::str::from_utf8(block)?;
    let mut data = String::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&data)?))
}

fn connection_value(state: &str, message: &str) -> Value {
    json!({"event":"connection","connection":state,"message":message,"received_at":now()})
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    #[test]
    fn parses_split_safe_sse_blocks() {
        let block = b"event: observation\ndata: {\"schema_version\":3,\"service\":\"codex-mcp\"}";
        let value = parse_sse_data(block).unwrap().unwrap();
        assert_eq!(value["schema_version"], 3);
        assert_eq!(find_event_end(b"data: x\n\nrest"), Some((7, 2)));
        assert_eq!(find_event_end(b"data: x\r\n\r\nrest"), Some((7, 4)));
        assert_eq!(
            find_event_end(b"data: first\r\n\r\ndata: second\n\n"),
            Some((11, 4))
        );
    }

    #[test]
    fn browser_replay_preserves_revision_order() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        let (events, _) = broadcast::channel(8);
        let (connection, _) = watch::channel(Arc::new(connection_value("online", "ok")));
        let push = crate::push::PushHub::new(None, store).unwrap();
        let hub = Hub {
            events,
            replay: Mutex::new(ReplayState::default()),
            connection,
            push,
        };
        assert_eq!(hub.publish(json!({"event":"one"})), 1);
        assert_eq!(hub.publish(json!({"event":"two"})), 2);
        assert_eq!(hub.publish(json!({"event":"three"})), 3);
        match hub.replay_after(1) {
            ReplayAfter::Available { head, events } => {
                assert_eq!(head, 3);
                assert_eq!(
                    events
                        .iter()
                        .map(|event| event.revision)
                        .collect::<Vec<_>>(),
                    vec![2, 3]
                );
            }
            ReplayAfter::TooOld { .. } => panic!("recent revisions must be replayable"),
        }
        assert!(matches!(
            hub.replay_after(4),
            ReplayAfter::TooOld { head: 3, .. }
        ));
    }

    #[tokio::test]
    async fn old_sequence_final_event_is_still_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        let (events, _) = broadcast::channel(8);
        let (connection, _) = watch::channel(Arc::new(connection_value("online", "ok")));
        let push = crate::push::PushHub::new(None, store.clone()).unwrap();
        let hub = Hub {
            events,
            replay: Mutex::new(ReplayState::default()),
            connection,
            push,
        };
        let mut boot = "boot".to_string();
        let mut sequence = 10;
        let value = json!({
            "schema_version":3,"service":"codex-mcp","boot_id":"boot","sequence":9,"emitted_at":1000,
            "event":"call_finished","call_id":"late-final","data":{
                "tool":"exec_command","kind":"commandExecution","arguments":{"cmd":"true"},"started_at":900,
                "status":"completed","ended_at":1000,"duration_ms":100,"background":false,
                "process_id":1,"exit_code":0,"output":"","truncated":false,"image":null
            }
        });
        handle_observation(&hub, store.clone(), None, value, &mut boot, &mut sequence)
            .await
            .unwrap();
        assert!(store.detail("late-final").unwrap().is_some());
        assert_eq!(sequence, 10);
    }

    #[tokio::test]
    async fn hello_does_not_interrupt_a_call_with_pending_terminal_replay() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        store
            .apply_observation(&json!({
                "schema_version":3,"boot_id":"boot","event":"call_started","call_id":"pending",
                "emitted_at":1000,"data":{
                    "tool":"exec_command","kind":"commandExecution","arguments":{"cmd":"true"},
                    "started_at":900,"background":false
                }
            }))
            .unwrap();
        let (events, _) = broadcast::channel(8);
        let (connection, _) = watch::channel(Arc::new(connection_value("online", "ok")));
        let push = crate::push::PushHub::new(None, store.clone()).unwrap();
        let hub = Hub {
            events,
            replay: Mutex::new(ReplayState::default()),
            connection,
            push,
        };
        let mut boot = String::new();
        let mut sequence = 0;
        handle_observation(
            &hub,
            store.clone(),
            None,
            json!({
                "schema_version":3,"service":"codex-mcp","boot_id":"boot","sequence":4,
                "emitted_at":1000,"event":"hello","call_id":null,
                "data":{
                    "active_call_ids":[],
                    "terminal_replay_call_ids":["pending"],
                    "terminal_replay_pending":1,
                    "terminal_replay_gap":null
                }
            }),
            &mut boot,
            &mut sequence,
        )
        .await
        .unwrap();
        assert_eq!(
            store.detail("pending").unwrap().unwrap()["status"],
            "running"
        );
    }
}
