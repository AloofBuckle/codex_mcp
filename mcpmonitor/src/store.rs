use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub struct Store {
    db: Mutex<Connection>,
    stats_cache: Mutex<StatsCache>,
}

const STATS_CACHE_MAX_ENTRIES: usize = 32;
const STATS_CACHE_IDLE_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, Default)]
pub struct ListFilter {
    pub tool: Option<String>,
    pub since: Option<u64>,
    pub until: Option<u64>,
    pub query: Option<String>,
    pub limit: usize,
    pub offset: usize,
}

pub struct ListResult {
    pub calls: Vec<Value>,
    pub count: u64,
}

pub struct ListWindowResult {
    pub calls: Vec<Value>,
    pub count: u64,
    pub offset: usize,
    pub anchor_index: Option<usize>,
    pub pinned_count: u64,
}

#[derive(Default)]
pub struct ReconcileResult {
    pub removed_user_inputs: Vec<String>,
    pub interrupted_calls: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SessionStats {
    pub files_changed: u64,
    pub additions: u64,
    pub deletions: u64,
    pub command_calls: u64,
    pub browser_calls: u64,
    pub cua_calls: u64,
    pub tool_calls: u64,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub auth_key: Vec<u8>,
    pub auth_expires_at: i64,
}

impl Store {
    pub fn open(path: &Path) -> anyhow::Result<Arc<Self>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let mut db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA wal_autocheckpoint=1000;
             PRAGMA journal_size_limit=16777216;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS calls(
               id TEXT PRIMARY KEY,
               boot_id TEXT NOT NULL,
               tool TEXT NOT NULL,
               kind TEXT NOT NULL,
               title TEXT NOT NULL,
               status TEXT NOT NULL,
               started_at INTEGER NOT NULL,
               ended_at INTEGER,
               duration_ms INTEGER,
               background INTEGER NOT NULL DEFAULT 0,
               process_id INTEGER,
               exit_code INTEGER,
               arguments_json TEXT NOT NULL DEFAULT '{}',
               output TEXT NOT NULL DEFAULT '',
               truncated INTEGER NOT NULL DEFAULT 0,
               image TEXT,
               stats_materialized INTEGER NOT NULL DEFAULT 0,
               stats_additions INTEGER NOT NULL DEFAULT 0,
               stats_deletions INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS calls_started_at ON calls(started_at DESC);
             CREATE INDEX IF NOT EXISTS calls_tool_started ON calls(tool, started_at DESC);
             CREATE TABLE IF NOT EXISTS call_files(
               call_id TEXT NOT NULL,
               path TEXT NOT NULL,
               PRIMARY KEY(call_id,path)
             );
             CREATE INDEX IF NOT EXISTS call_files_call_id ON call_files(call_id);
             CREATE TABLE IF NOT EXISTS push_subscriptions(
               endpoint TEXT PRIMARY KEY,
               p256dh TEXT NOT NULL,
               auth TEXT NOT NULL,
               auth_key BLOB,
               auth_expires_at INTEGER,
               updated_at INTEGER NOT NULL
             );",
        )?;
        ensure_stats_columns(&db)?;
        ensure_push_auth_columns(&db)?;
        backfill_stats(&mut db)?;
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(Arc::new(Self {
            db: Mutex::new(db),
            stats_cache: Mutex::new(StatsCache::default()),
        }))
    }

    pub fn apply_observation(&self, event: &Value) -> anyhow::Result<Option<Value>> {
        anyhow::ensure!(
            event["schema_version"] == 3,
            "unsupported observation schema"
        );
        let kind = event["event"].as_str().unwrap_or("");
        if matches!(kind, "hello" | "gap") {
            return Ok(None);
        }
        let Some(id) = event["call_id"].as_str() else {
            return Ok(None);
        };
        let boot_id = event["boot_id"].as_str().unwrap_or("");
        let data = &event["data"];
        let updated_at = event["emitted_at"].as_u64().unwrap_or_else(now) as i64;
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());

        let changes_stats = matches!(kind, "call_started" | "call_sync" | "call_finished");
        let before = if changes_stats {
            contribution_by_id(&db, id)?
        } else {
            None
        };
        match kind {
            "call_started" | "call_sync" => {
                let tool = data["tool"].as_str().unwrap_or("unknown");
                let call_kind = data["kind"].as_str().unwrap_or("tool");
                let arguments = data.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let title = title_for(tool, &arguments);
                let started_at = data["started_at"].as_u64().unwrap_or_else(now) as i64;
                let background = data["background"].as_bool().unwrap_or(false) as i64;
                let process_id = data["process_id"].as_u64().map(|n| n as i64);
                db.execute(
                    "INSERT INTO calls(id,boot_id,tool,kind,title,status,started_at,background,process_id,arguments_json,stats_materialized,stats_additions,stats_deletions,updated_at)
                     VALUES(?,?,?,?,?,'running',?,?,?,?,1,0,0,?)
                     ON CONFLICT(id) DO UPDATE SET
                       boot_id=excluded.boot_id,tool=excluded.tool,kind=excluded.kind,title=excluded.title,
                       status='running',started_at=excluded.started_at,background=excluded.background,
                       process_id=COALESCE(excluded.process_id,calls.process_id),arguments_json=excluded.arguments_json,
                       stats_materialized=1,stats_additions=0,stats_deletions=0,
                       updated_at=excluded.updated_at",
                    params![
                        id, boot_id, tool, call_kind, title, started_at, background, process_id,
                        arguments.to_string(), updated_at
                    ],
                )?;
                db.execute("DELETE FROM call_files WHERE call_id=?", [id])?;
            }
            "call_state" => {
                if let Some(background) = data["background"].as_bool() {
                    db.execute(
                        "UPDATE calls SET background=?,updated_at=? WHERE id=?",
                        params![background as i64, updated_at, id],
                    )?;
                }
                if let Some(process_id) = data["process_id"].as_u64() {
                    db.execute(
                        "UPDATE calls SET process_id=?,updated_at=? WHERE id=?",
                        params![process_id as i64, updated_at, id],
                    )?;
                }
            }
            "call_activity" => {
                db.execute(
                    "UPDATE calls SET updated_at=? WHERE id=?",
                    params![updated_at, id],
                )?;
                return Ok(None);
            }
            "call_finished" => {
                let tool = data["tool"].as_str().unwrap_or("unknown");
                let call_kind = data["kind"].as_str().unwrap_or("tool");
                let arguments = data.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let title = title_for(tool, &arguments);
                let started_at = data["started_at"].as_u64().unwrap_or_else(now) as i64;
                let status = data["status"].as_str().unwrap_or("completed");
                let ended_at = data["ended_at"].as_u64().map(|n| n as i64);
                let duration_ms = data["duration_ms"].as_u64().map(|n| n as i64);
                let background = data["background"].as_bool().unwrap_or(false) as i64;
                let process_id = data["process_id"].as_u64().map(|n| n as i64);
                let exit_code = data["exit_code"].as_i64();
                let output = data["output"].as_str().unwrap_or("");
                let truncated = data["truncated"].as_bool().unwrap_or(false) as i64;
                let image = data["image"].as_str();
                let (stats_additions, stats_deletions, stats_files) =
                    materialize_patch_stats(tool, status, &arguments);
                db.execute(
                    "INSERT INTO calls(id,boot_id,tool,kind,title,status,started_at,ended_at,duration_ms,background,process_id,exit_code,arguments_json,output,truncated,image,stats_materialized,stats_additions,stats_deletions,updated_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
                     ON CONFLICT(id) DO UPDATE SET
                       boot_id=excluded.boot_id,tool=excluded.tool,kind=excluded.kind,title=excluded.title,
                       status=excluded.status,started_at=excluded.started_at,ended_at=excluded.ended_at,
                       duration_ms=excluded.duration_ms,background=excluded.background,process_id=excluded.process_id,
                       exit_code=excluded.exit_code,arguments_json=excluded.arguments_json,output=excluded.output,
                       truncated=excluded.truncated,image=excluded.image,stats_materialized=1,
                       stats_additions=excluded.stats_additions,stats_deletions=excluded.stats_deletions,
                       updated_at=excluded.updated_at",
                    params![
                        id, boot_id, tool, call_kind, title, status, started_at, ended_at, duration_ms,
                        background, process_id, exit_code, arguments.to_string(), output, truncated, image,
                        stats_additions as i64, stats_deletions as i64, updated_at
                    ],
                )?;
                replace_call_files(&db, id, &stats_files)?;
            }
            _ => return Ok(None),
        }
        if changes_stats {
            let after = contribution_by_id(&db, id)?;
            let mut cache = self.stats_cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.prune_idle();
            for (&(since, until), entry) in &mut cache.entries {
                if let Some(previous) = &before {
                    if previous.in_window(since, until) {
                        entry.stats.adjust(previous, false);
                    }
                }
                if let Some(current) = &after {
                    if current.in_window(since, until) {
                        entry.stats.adjust(current, true);
                    }
                }
            }
        }
        summary_by_id(&db, id)
    }

    pub fn list(&self, filter: &ListFilter) -> anyhow::Result<ListResult> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let (where_sql, values) = list_filter_sql(filter);
        let count_sql = format!("SELECT count(*) FROM calls {where_sql}");
        let count: u64 = db.query_row(&count_sql, params_from_iter(values.clone()), |row| {
            unsigned_column(row, 0)
        })?;
        let limit = filter.limit.clamp(1, 5000) as i64;
        let offset = filter.offset.min(i64::MAX as usize) as i64;
        let list_sql = format!(
            "SELECT id,tool,kind,title,status,started_at,ended_at,duration_ms,background FROM calls {where_sql} ORDER BY CASE WHEN kind='userInput' AND status='running' THEN 0 ELSE 1 END,started_at DESC,id DESC LIMIT ? OFFSET ?"
        );
        let mut list_values = values;
        list_values.push(SqlValue::Integer(limit));
        list_values.push(SqlValue::Integer(offset));
        let mut stmt = db.prepare(&list_sql)?;
        let calls = stmt
            .query_map(params_from_iter(list_values), summary_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ListResult { calls, count })
    }

    pub fn list_around(
        &self,
        filter: &ListFilter,
        anchor_id: &str,
        before: usize,
    ) -> anyhow::Result<ListWindowResult> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let (where_sql, values) = list_filter_sql(filter);
        let count_sql = format!("SELECT count(*) FROM calls {where_sql}");
        let count: u64 = db.query_row(&count_sql, params_from_iter(values.clone()), |row| {
            unsigned_column(row, 0)
        })?;

        let pinned_sql = if where_sql.is_empty() {
            "SELECT count(*) FROM calls WHERE kind='userInput' AND status='running'".to_string()
        } else {
            format!(
                "SELECT count(*) FROM calls {where_sql} AND kind='userInput' AND status='running'"
            )
        };
        let pinned_count: u64 =
            db.query_row(&pinned_sql, params_from_iter(values.clone()), |row| {
                unsigned_column(row, 0)
            })?;

        let anchor_sql = format!(
            "WITH filtered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY CASE WHEN kind='userInput' AND status='running' THEN 0 ELSE 1 END, started_at DESC, id DESC) - 1 AS list_index FROM calls {where_sql}) SELECT list_index FROM filtered WHERE id=? LIMIT 1"
        );
        let mut anchor_values = values.clone();
        anchor_values.push(SqlValue::Text(anchor_id.to_string()));
        let anchor_index = db
            .query_row(&anchor_sql, params_from_iter(anchor_values), |row| {
                row.get::<_, i64>(0)
            })
            .optional()?
            .and_then(|value| usize::try_from(value).ok());

        let limit = filter.limit.clamp(1, 5000);
        let max_offset = usize::try_from(count.saturating_sub(limit as u64)).unwrap_or(usize::MAX);
        let offset = anchor_index
            .map(|index| index.saturating_sub(before).min(max_offset))
            .unwrap_or(0);
        let list_sql = format!(
            "SELECT id,tool,kind,title,status,started_at,ended_at,duration_ms,background FROM calls {where_sql} ORDER BY CASE WHEN kind='userInput' AND status='running' THEN 0 ELSE 1 END,started_at DESC,id DESC LIMIT ? OFFSET ?"
        );
        let mut list_values = values;
        list_values.push(SqlValue::Integer(limit.min(i64::MAX as usize) as i64));
        list_values.push(SqlValue::Integer(offset.min(i64::MAX as usize) as i64));
        let mut stmt = db.prepare(&list_sql)?;
        let calls = stmt
            .query_map(params_from_iter(list_values), summary_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ListWindowResult {
            calls,
            count,
            offset,
            anchor_index,
            pinned_count,
        })
    }

    pub fn count_for_list(&self, filter: &ListFilter) -> anyhow::Result<u64> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let (where_sql, values) = list_filter_sql(filter);
        let sql = format!("SELECT count(*) FROM calls {where_sql}");
        Ok(db.query_row(&sql, params_from_iter(values), |row| {
            unsigned_column(row, 0)
        })?)
    }

    pub fn stats(&self, filter: &ListFilter) -> anyhow::Result<SessionStats> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        // Hold the DB lock before the cache lock, just as apply_observation does,
        // so snapshots and deltas are atomic and concurrent SSE clients share work.
        let mut cache = self.stats_cache.lock().unwrap_or_else(|e| e.into_inner());
        let key = (filter.since, filter.until);
        cache.prune_idle();
        if let Some(entry) = cache.entries.get_mut(&key) {
            entry.last_used = Instant::now();
            return Ok(entry.stats.stats.clone());
        }
        let stats = session_stats(&db, filter)?;
        cache.insert(key, stats);
        Ok(cache.entries[&key].stats.stats.clone())
    }

    pub fn matches_id(&self, id: &str, filter: &ListFilter) -> anyhow::Result<bool> {
        self.matches_id_with(id, filter, false)
    }

    pub fn matches_id_for_list(&self, id: &str, filter: &ListFilter) -> anyhow::Result<bool> {
        self.matches_id_with(id, filter, true)
    }

    fn matches_id_with(
        &self,
        id: &str,
        filter: &ListFilter,
        pin_running_user_input: bool,
    ) -> anyhow::Result<bool> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let (where_sql, mut values) = if pin_running_user_input {
            list_filter_sql(filter)
        } else {
            filter_sql(filter)
        };
        let sql = if where_sql.is_empty() {
            "SELECT 1 FROM calls WHERE id=? LIMIT 1".to_string()
        } else {
            format!(
                "SELECT 1 FROM calls WHERE id=? AND {} LIMIT 1",
                where_sql.trim_start_matches("WHERE ")
            )
        };
        values.insert(0, SqlValue::Text(id.to_string()));
        Ok(db
            .query_row(&sql, params_from_iter(values), |_| Ok(()))
            .optional()?
            .is_some())
    }

    pub fn reconcile_running_calls(
        &self,
        boot_id: &str,
        active_call_ids: &HashSet<String>,
        ended_at: u64,
    ) -> anyhow::Result<ReconcileResult> {
        let mut db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let stale = {
            let mut stmt =
                db.prepare("SELECT id,boot_id,kind FROM calls WHERE status='running'")?;
            stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .filter_map(|row| match row {
                Ok((id, row_boot, kind))
                    if row_boot != boot_id || !active_call_ids.contains(&id) =>
                {
                    Some(Ok((id, kind)))
                }
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()?
        };
        if stale.is_empty() {
            return Ok(ReconcileResult::default());
        }
        let transaction = db.transaction()?;
        let mut result = ReconcileResult::default();
        for (id, kind) in stale {
            if kind == "userInput" {
                transaction.execute(
                    "DELETE FROM calls WHERE id=? AND kind='userInput' AND status='running'",
                    [&id],
                )?;
                result.removed_user_inputs.push(id);
            } else {
                let ended_at = ended_at as i64;
                transaction.execute(
                    "UPDATE calls SET status='interrupted',ended_at=?,duration_ms=NULL,updated_at=? WHERE id=? AND status='running'",
                    params![ended_at, ended_at, id],
                )?;
                result.interrupted_calls.push(id);
            }
        }
        transaction.commit()?;
        self.stats_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        Ok(result)
    }

    pub fn detail(&self, id: &str) -> anyhow::Result<Option<Value>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.query_row(
            "SELECT id,tool,kind,title,status,started_at,ended_at,duration_ms,background,process_id,exit_code,arguments_json,output,truncated,image FROM calls WHERE id=?",
            [id],
            |row| {
                let arguments: String = row.get(11)?;
                Ok(json!({
                    "id": row.get::<_,String>(0)?,
                    "tool": row.get::<_,String>(1)?,
                    "kind": row.get::<_,String>(2)?,
                    "title": row.get::<_,String>(3)?,
                    "status": row.get::<_,String>(4)?,
                    "started_at": row.get::<_,i64>(5)?,
                    "ended_at": row.get::<_,Option<i64>>(6)?,
                    "duration_ms": row.get::<_,Option<i64>>(7)?,
                    "background": row.get::<_,i64>(8)? != 0,
                    "process_id": row.get::<_,Option<i64>>(9)?,
                    "exit_code": row.get::<_,Option<i64>>(10)?,
                    "arguments": serde_json::from_str::<Value>(&arguments).unwrap_or_else(|_| json!({})),
                    "output": row.get::<_,String>(12)?,
                    "truncated": row.get::<_,i64>(13)? != 0,
                    "image": row.get::<_,Option<String>>(14)?,
                }))
            },
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn save_push_subscription(&self, subscription: &PushSubscription) -> anyhow::Result<()> {
        anyhow::ensure!(
            subscription.endpoint.starts_with("https://"),
            "push endpoint must use HTTPS"
        );
        anyhow::ensure!(
            subscription.endpoint.len() <= 4096,
            "push endpoint is too long"
        );
        anyhow::ensure!(
            !subscription.p256dh.is_empty() && subscription.p256dh.len() <= 1024,
            "invalid p256dh"
        );
        anyhow::ensure!(
            !subscription.auth.is_empty() && subscription.auth.len() <= 1024,
            "invalid push auth"
        );
        anyhow::ensure!(
            subscription.auth_key.len() == 32,
            "invalid push session binding"
        );
        anyhow::ensure!(
            subscription.auth_expires_at > unix_seconds(),
            "push session is expired"
        );
        self.db.lock().unwrap_or_else(|e| e.into_inner()).execute(
            "INSERT INTO push_subscriptions(endpoint,p256dh,auth,auth_key,auth_expires_at,updated_at) VALUES(?,?,?,?,?,?)
             ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,auth_key=excluded.auth_key,auth_expires_at=excluded.auth_expires_at,updated_at=excluded.updated_at",
            params![
                subscription.endpoint,
                subscription.p256dh,
                subscription.auth,
                subscription.auth_key,
                subscription.auth_expires_at,
                now() as i64
            ],
        )?;
        Ok(())
    }

    pub fn delete_push_subscription(&self, endpoint: &str) -> anyhow::Result<()> {
        self.db.lock().unwrap_or_else(|e| e.into_inner()).execute(
            "DELETE FROM push_subscriptions WHERE endpoint=?",
            [endpoint],
        )?;
        Ok(())
    }

    pub fn delete_push_subscriptions_for_auth(&self, auth_key: &[u8]) -> anyhow::Result<()> {
        anyhow::ensure!(auth_key.len() == 32, "invalid push session binding");
        self.db.lock().unwrap_or_else(|e| e.into_inner()).execute(
            "DELETE FROM push_subscriptions WHERE auth_key=?",
            [auth_key],
        )?;
        Ok(())
    }

    pub fn push_subscriptions(&self) -> anyhow::Result<Vec<PushSubscription>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let now = unix_seconds();
        db.execute(
            "DELETE FROM push_subscriptions WHERE auth_key IS NULL OR auth_expires_at IS NULL OR auth_expires_at<=?",
            [now],
        )?;
        let mut stmt = db.prepare(
            "SELECT endpoint,p256dh,auth,auth_key,auth_expires_at FROM push_subscriptions WHERE auth_expires_at>? ORDER BY updated_at DESC LIMIT 64",
        )?;
        Ok(stmt
            .query_map([now], |row| {
                Ok(PushSubscription {
                    endpoint: row.get(0)?,
                    p256dh: row.get(1)?,
                    auth: row.get(2)?,
                    auth_key: row.get(3)?,
                    auth_expires_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn running_user_input_ids(&self) -> anyhow::Result<Vec<String>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT id FROM calls WHERE kind='userInput' AND status='running' ORDER BY started_at ASC,id ASC",
        )?;
        Ok(stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }
}

fn summary_by_id(db: &Connection, id: &str) -> anyhow::Result<Option<Value>> {
    db.query_row(
        "SELECT id,tool,kind,title,status,started_at,ended_at,duration_ms,background FROM calls WHERE id=?",
        [id],
        summary_row,
    )
    .optional()
    .map_err(Into::into)
}

fn summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_,String>(0)?,
        "tool": row.get::<_,String>(1)?,
        "kind": row.get::<_,String>(2)?,
        "title": row.get::<_,String>(3)?,
        "status": row.get::<_,String>(4)?,
        "started_at": row.get::<_,i64>(5)?,
        "ended_at": row.get::<_,Option<i64>>(6)?,
        "duration_ms": row.get::<_,Option<i64>>(7)?,
        "background": row.get::<_,i64>(8)? != 0,
    }))
}

#[derive(Default)]
struct CachedStats {
    stats: SessionStats,
    files: HashMap<String, u64>,
}

#[derive(Default)]
struct StatsCache {
    entries: HashMap<(Option<u64>, Option<u64>), StatsCacheEntry>,
}

struct StatsCacheEntry {
    stats: CachedStats,
    last_used: Instant,
}

impl StatsCache {
    fn clear(&mut self) {
        self.entries.clear();
    }

    fn prune_idle(&mut self) {
        let now = Instant::now();
        self.entries
            .retain(|_, entry| now.duration_since(entry.last_used) < STATS_CACHE_IDLE_TTL);
    }

    fn insert(&mut self, key: (Option<u64>, Option<u64>), stats: CachedStats) {
        while self.entries.len() >= STATS_CACHE_MAX_ENTRIES {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| *key)
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            key,
            StatsCacheEntry {
                stats,
                last_used: Instant::now(),
            },
        );
    }
}

struct Contribution {
    started_at: u64,
    tool: String,
    files: HashSet<String>,
    additions: u64,
    deletions: u64,
}

impl Contribution {
    fn from_row_without_files(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let tool: String = row.get(0)?;
        Ok(Self {
            tool,
            started_at: unsigned_column(row, 1)?,
            files: HashSet::new(),
            additions: row.get::<_, i64>(2)?.max(0) as u64,
            deletions: row.get::<_, i64>(3)?.max(0) as u64,
        })
    }

    fn in_window(&self, since: Option<u64>, until: Option<u64>) -> bool {
        since.is_none_or(|v| self.started_at >= v) && until.is_none_or(|v| self.started_at < v)
    }
}

fn contribution_by_id(db: &Connection, id: &str) -> anyhow::Result<Option<Contribution>> {
    let Some(mut contribution) = db
        .query_row(
            "SELECT tool,started_at,stats_additions,stats_deletions FROM calls WHERE id=?",
            [id],
            Contribution::from_row_without_files,
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut stmt = db.prepare("SELECT path FROM call_files WHERE call_id=?")?;
    contribution.files = stmt
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(Some(contribution))
}

impl CachedStats {
    fn adjust(&mut self, call: &Contribution, add: bool) {
        fn change(value: &mut u64, amount: u64, add: bool) {
            if add {
                *value += amount;
            } else {
                *value -= amount;
            }
        }
        change(&mut self.stats.tool_calls, 1, add);
        if call.tool == "exec_command" {
            change(&mut self.stats.command_calls, 1, add);
        }
        if call.tool.starts_with("cua_repl.") || call.tool.starts_with("browser_") {
            change(&mut self.stats.cua_calls, 1, add);
            // Keep older open frontends compatible until they reload.
            self.stats.browser_calls = self.stats.cua_calls;
        }
        change(&mut self.stats.additions, call.additions, add);
        change(&mut self.stats.deletions, call.deletions, add);
        for file in &call.files {
            let count = self.files.entry(file.clone()).or_default();
            change(count, 1, add);
            if *count == 0 {
                self.files.remove(file);
            }
        }
        self.stats.files_changed = self.files.len() as u64;
    }
}

fn session_stats(db: &Connection, filter: &ListFilter) -> anyhow::Result<CachedStats> {
    let stats_filter = ListFilter {
        since: filter.since,
        until: filter.until,
        ..Default::default()
    };
    let (where_sql, values) = filter_sql(&stats_filter);
    let sql = format!(
        "SELECT
           count(*),
           coalesce(sum(CASE WHEN tool='exec_command' THEN 1 ELSE 0 END),0),
           coalesce(sum(CASE WHEN tool GLOB 'cua_repl.*' OR tool GLOB 'browser_*' THEN 1 ELSE 0 END),0),
           coalesce(sum(stats_additions),0),
           coalesce(sum(stats_deletions),0)
         FROM calls {where_sql}"
    );
    let mut entry = db.query_row(&sql, params_from_iter(values.clone()), |row| {
        let tool_calls = row.get::<_, i64>(0)?.max(0) as u64;
        let command_calls = row.get::<_, i64>(1)?.max(0) as u64;
        let cua_calls = row.get::<_, i64>(2)?.max(0) as u64;
        Ok(CachedStats {
            stats: SessionStats {
                files_changed: 0,
                additions: row.get::<_, i64>(3)?.max(0) as u64,
                deletions: row.get::<_, i64>(4)?.max(0) as u64,
                command_calls,
                browser_calls: cua_calls,
                cua_calls,
                tool_calls,
            },
            files: HashMap::new(),
        })
    })?;
    let file_sql = format!(
        "SELECT call_files.path,count(*)
         FROM call_files JOIN calls ON calls.id=call_files.call_id
         {where_sql}
         GROUP BY call_files.path"
    );
    let mut stmt = db.prepare(&file_sql)?;
    for row in stmt.query_map(params_from_iter(values), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?.max(0) as u64,
        ))
    })? {
        let (path, count) = row?;
        entry.files.insert(path, count);
    }
    entry.stats.files_changed = entry.files.len() as u64;
    Ok(entry)
}

fn materialize_patch_stats(
    tool: &str,
    status: &str,
    arguments: &Value,
) -> (u64, u64, HashSet<String>) {
    if tool != "apply_patch" || status != "completed" {
        return (0, 0, HashSet::new());
    }
    let mut files = HashSet::new();
    let mut stats = SessionStats::default();
    if let Some(input) = arguments["input"].as_str() {
        accumulate_patch_stats(input, &mut files, &mut stats);
    }
    (stats.additions, stats.deletions, files)
}

fn replace_call_files(db: &Connection, id: &str, files: &HashSet<String>) -> rusqlite::Result<()> {
    db.execute("DELETE FROM call_files WHERE call_id=?", [id])?;
    if files.is_empty() {
        return Ok(());
    }
    let mut insert = db.prepare("INSERT OR IGNORE INTO call_files(call_id,path) VALUES(?,?)")?;
    for path in files {
        insert.execute(params![id, path])?;
    }
    Ok(())
}

fn ensure_stats_columns(db: &Connection) -> anyhow::Result<()> {
    let mut stmt = db.prepare("PRAGMA table_info(calls)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    for (name, declaration) in [
        ("stats_materialized", "INTEGER NOT NULL DEFAULT 0"),
        ("stats_additions", "INTEGER NOT NULL DEFAULT 0"),
        ("stats_deletions", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.contains(name) {
            db.execute(
                &format!("ALTER TABLE calls ADD COLUMN {name} {declaration}"),
                [],
            )?;
        }
    }
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS call_files(
           call_id TEXT NOT NULL,
           path TEXT NOT NULL,
           PRIMARY KEY(call_id,path)
         );
         CREATE INDEX IF NOT EXISTS call_files_call_id ON call_files(call_id);",
    )?;
    Ok(())
}

fn ensure_push_auth_columns(db: &Connection) -> anyhow::Result<()> {
    let mut stmt = db.prepare("PRAGMA table_info(push_subscriptions)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    for (name, declaration) in [("auth_key", "BLOB"), ("auth_expires_at", "INTEGER")] {
        if !columns.contains(name) {
            db.execute(
                &format!("ALTER TABLE push_subscriptions ADD COLUMN {name} {declaration}"),
                [],
            )?;
        }
    }
    // Legacy subscriptions were not bound to a browser login session. They
    // must not survive the migration because they could outlive OIDC state.
    db.execute(
        "DELETE FROM push_subscriptions WHERE auth_key IS NULL OR auth_expires_at IS NULL",
        [],
    )?;
    Ok(())
}

fn backfill_stats(db: &mut Connection) -> anyhow::Result<()> {
    let mut stmt =
        db.prepare("SELECT id,tool,status,arguments_json FROM calls WHERE stats_materialized=0")?;
    let pending = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if pending.is_empty() {
        return Ok(());
    }
    let transaction = db.transaction()?;
    for (id, tool, status, raw) in pending {
        let arguments = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}));
        let (additions, deletions, files) = materialize_patch_stats(&tool, &status, &arguments);
        transaction.execute(
            "UPDATE calls SET stats_materialized=1,stats_additions=?,stats_deletions=? WHERE id=?",
            params![additions as i64, deletions as i64, id],
        )?;
        replace_call_files(&transaction, &id, &files)?;
    }
    transaction.commit()?;
    Ok(())
}

fn accumulate_patch_stats(input: &str, files: &mut HashSet<String>, stats: &mut SessionStats) {
    for line in input.lines() {
        for prefix in ["*** Add File:", "*** Update File:", "*** Delete File:"] {
            if let Some(path) = line.strip_prefix(prefix) {
                let path = path.trim();
                if !path.is_empty() {
                    files.insert(path.to_string());
                }
            }
        }
        if line.starts_with('+') && !line.starts_with("+++") {
            stats.additions += 1;
        }
        if line.starts_with('-') && !line.starts_with("---") {
            stats.deletions += 1;
        }
    }
}

fn filter_sql(filter: &ListFilter) -> (String, Vec<SqlValue>) {
    filter_sql_inner(filter, false)
}

fn list_filter_sql(filter: &ListFilter) -> (String, Vec<SqlValue>) {
    filter_sql_inner(filter, true)
}

fn filter_sql_inner(
    filter: &ListFilter,
    pin_running_user_input_outside_time: bool,
) -> (String, Vec<SqlValue>) {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    if let Some(tool) = filter
        .tool
        .as_deref()
        .filter(|v| !v.is_empty() && *v != "all")
    {
        if tool == "browser" || tool == "cua" {
            clauses.push("(tool GLOB 'browser_*' OR tool GLOB 'cua_repl.*')".to_string());
        } else {
            clauses.push("tool=?".to_string());
            values.push(SqlValue::Text(tool.to_string()));
        }
    }
    if let Some(query) = filter
        .query
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        clauses.push("(title LIKE ? OR arguments_json LIKE ? OR output LIKE ?)".to_string());
        let pattern = format!("%{query}%");
        values.push(SqlValue::Text(pattern.clone()));
        values.push(SqlValue::Text(pattern.clone()));
        values.push(SqlValue::Text(pattern));
    }
    let mut time_clauses = Vec::new();
    if let Some(since) = filter.since {
        time_clauses.push("started_at>=?".to_string());
        values.push(SqlValue::Integer(since as i64));
    }
    if let Some(until) = filter.until {
        time_clauses.push("started_at<?".to_string());
        values.push(SqlValue::Integer(until as i64));
    }
    if !time_clauses.is_empty() {
        let time_sql = time_clauses.join(" AND ");
        if pin_running_user_input_outside_time {
            clauses.push(format!(
                "((kind='userInput' AND status='running') OR ({time_sql}))"
            ));
        } else {
            clauses.push(time_sql);
        }
    }
    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    (sql, values)
}

fn title_for(tool: &str, args: &Value) -> String {
    let raw = match tool {
        "exec_command" => args["cmd"]
            .as_str()
            .unwrap_or("命令")
            .lines()
            .next()
            .unwrap_or("命令")
            .to_string(),
        "apply_patch" => patch_title(args["input"].as_str().unwrap_or("")),
        "view_image" => basename(args["path"].as_str().unwrap_or("图像")).to_string(),
        "write_stdin" => {
            let chars = args["chars"].as_str().unwrap_or("");
            if chars.trim().is_empty() {
                "进程轮询".to_string()
            } else {
                chars.replace(['\r', '\n', '\t'], " ")
            }
        }
        "request_user_input" | "request_user_input_async" => args["questions"]
            .as_array()
            .and_then(|questions| questions.first())
            .and_then(|question| {
                question["question"]
                    .as_str()
                    .or_else(|| question["title"].as_str())
            })
            .unwrap_or("等待用户输入")
            .to_string(),
        "browser_click" => {
            let button = match args["button"].as_str().unwrap_or("left") {
                "right" => "右键",
                "middle" => "中键",
                _ => "左键",
            };
            let clicks = args["click_count"].as_u64().unwrap_or(1);
            let action = args["action"].as_str().unwrap_or("");
            let lead = if !action.is_empty() {
                match action {
                    "check" => "勾选".to_string(),
                    "uncheck" => "取消勾选".to_string(),
                    "select_option" | "selectOption" => "选择选项".to_string(),
                    "activate" => "激活".to_string(),
                    "expand" => "展开".to_string(),
                    "collapse" => "折叠".to_string(),
                    _ => action.replace('_', " "),
                }
            } else if clicks > 1 {
                format!("{button}双击")
            } else {
                button.to_string()
            };
            if let (Some(x), Some(y)) = (args["x"].as_i64(), args["y"].as_i64()) {
                format!("{lead} ({x}, {y})")
            } else if let Some(locator) = args["locator"].as_str() {
                format!("{lead} · {locator}")
            } else {
                lead
            }
        }
        "browser_drag" => format!(
            "({}, {}) → ({}, {})",
            args["from_x"].as_i64().unwrap_or(0),
            args["from_y"].as_i64().unwrap_or(0),
            args["to_x"].as_i64().unwrap_or(0),
            args["to_y"].as_i64().unwrap_or(0),
        ),
        "browser_scroll" => {
            let direction = match args["direction"].as_str().unwrap_or("down") {
                "up" | "u" => "向上",
                "left" | "l" => "向左",
                "right" | "r" => "向右",
                _ => "向下",
            };
            let pages = args["pages"].as_f64().unwrap_or(1.0);
            let pages_text = if pages.fract() == 0.0 {
                format!("{}", pages as i64)
            } else {
                format!("{pages:.1}")
            };
            format!("{direction} {pages_text} 页")
        }
        "browser_key" => args["key"].as_str().unwrap_or("按键").to_string(),
        "browser_type" => {
            let chars = args["chars"].as_u64().unwrap_or(0);
            let mode = match args["mode"].as_str().unwrap_or("type_text") {
                "fill" => "填入",
                "paste" => "粘贴",
                "set_value" => "设置值",
                "press_sequentially" => "逐字输入",
                _ => "键入",
            };
            if let Some(locator) = args["locator"].as_str() {
                format!("{mode} {chars} 字符 · {locator}")
            } else {
                format!("{mode} {chars} 字符")
            }
        }
        "browser_action" => {
            let action = args["action"].as_str().unwrap_or("浏览器操作");
            match action {
                "select_text" => format!("选择文本 · {} 字符", args["chars"].as_u64().unwrap_or(0)),
                "focus" => "聚焦元素".to_string(),
                _ => action.replace('_', " "),
            }
        }
        _ if tool.starts_with("cua_repl.") => args["title"].as_str().unwrap_or(tool).to_string(),
        _ => tool.to_string(),
    };
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 240 {
        collapsed.chars().take(237).collect::<String>() + "..."
    } else if collapsed.is_empty() {
        tool.to_string()
    } else {
        collapsed
    }
}

fn patch_title(input: &str) -> String {
    let mut files = Vec::new();
    let mut adds = 0usize;
    let mut removes = 0usize;
    for line in input.lines() {
        for prefix in ["*** Add File:", "*** Update File:", "*** Delete File:"] {
            if let Some(path) = line.strip_prefix(prefix) {
                files.push(basename(path.trim()).to_string());
            }
        }
        if line.starts_with('+') && !line.starts_with("+++") {
            adds += 1;
        }
        if line.starts_with('-') && !line.starts_with("---") {
            removes += 1;
        }
    }
    let name = files
        .first()
        .cloned()
        .unwrap_or_else(|| "apply_patch".into());
    let more = if files.len() > 1 {
        format!(" +{} files", files.len() - 1)
    } else {
        String::new()
    };
    let add = if adds > 0 {
        format!(" +{adds}")
    } else {
        String::new()
    };
    let remove = if removes > 0 {
        format!(" -{removes}")
    } else {
        String::new()
    };
    format!("{name}{more}{add}{remove}")
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|v| !v.is_empty())
        .unwrap_or(path)
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, id: &str, data: Value) -> Value {
        json!({"schema_version":3,"boot_id":"boot","event":kind,"call_id":id,"emitted_at":1000,"data":data})
    }

    #[test]
    fn persists_full_detail_but_lists_only_summary() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        store.apply_observation(&event("call_started","a",json!({"tool":"exec_command","kind":"commandExecution","arguments":{"cmd":"printf secret"},"started_at":100,"background":false}))).unwrap();
        store.apply_observation(&event("call_finished","a",json!({"tool":"exec_command","kind":"commandExecution","arguments":{"cmd":"printf secret"},"started_at":100,"status":"completed","ended_at":200,"duration_ms":100,"background":false,"process_id":7,"exit_code":0,"output":"detail-output","truncated":false,"image":null}))).unwrap();
        let list = store
            .list(&ListFilter {
                limit: 100,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(list.count, 1);
        assert!(list.calls[0].get("output").is_none());
        assert!(list.calls[0].get("arguments").is_none());
        let detail = store.detail("a").unwrap().unwrap();
        assert_eq!(detail["output"], "detail-output");
        assert_eq!(detail["arguments"]["cmd"], "printf secret");
    }

    #[test]
    fn filters_history_server_side() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        for (id, tool, started, title) in [
            ("a", "exec_command", 100, "echo alpha"),
            ("b", "view_image", 200, "image.png"),
        ] {
            store.apply_observation(&event("call_started",id,json!({"tool":tool,"kind":"tool","arguments": if tool=="exec_command" {json!({"cmd":title})} else {json!({"path":title})},"started_at":started,"background":false}))).unwrap();
        }
        let list = store
            .list(&ListFilter {
                tool: Some("exec_command".into()),
                since: Some(50),
                until: Some(150),
                query: Some("alpha".into()),
                limit: 100,
                offset: 0,
            })
            .unwrap();
        assert_eq!(list.count, 1);
        assert_eq!(list.calls[0]["id"], "a");
    }

    #[test]
    fn running_user_input_is_pinned_outside_the_time_window() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        store
            .apply_observation(&event(
                "call_started",
                "question",
                json!({
                    "tool":"request_user_input_async","kind":"userInput",
                    "arguments":{"questions":[{"title":"old question"}]},
                    "started_at":100,"background":false
                }),
            ))
            .unwrap();
        store
            .apply_observation(&event(
                "call_started",
                "shell",
                json!({
                    "tool":"exec_command","kind":"commandExecution",
                    "arguments":{"cmd":"echo recent"},"started_at":250,"background":false
                }),
            ))
            .unwrap();

        let filter = ListFilter {
            since: Some(200),
            limit: 100,
            ..Default::default()
        };
        let list = store.list(&filter).unwrap();
        assert_eq!(list.count, 2);
        assert_eq!(list.calls[0]["id"], "question");
        assert_eq!(store.stats(&filter).unwrap().tool_calls, 1);

        let shell_only = store
            .list(&ListFilter {
                tool: Some("exec_command".into()),
                since: Some(200),
                limit: 100,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(shell_only.count, 1);
        assert_eq!(shell_only.calls[0]["id"], "shell");
    }

    #[test]
    fn reconciles_orphaned_running_calls_against_live_source() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        for (id, boot) in [
            ("live", "boot-current"),
            ("old-boot", "boot-old"),
            ("missing", "boot-current"),
        ] {
            let mut started = event(
                "call_started",
                id,
                json!({
                    "tool":"request_user_input_async","kind":"userInput",
                    "arguments":{"questions":[{"title":id}]},
                    "started_at":100,"background":false
                }),
            );
            started["boot_id"] = json!(boot);
            store.apply_observation(&started).unwrap();
        }
        assert_eq!(store.stats(&ListFilter::default()).unwrap().tool_calls, 3);
        let active = HashSet::from(["live".to_string()]);
        let mut result = store
            .reconcile_running_calls("boot-current", &active, 250)
            .unwrap();
        result.removed_user_inputs.sort();
        assert_eq!(
            result.removed_user_inputs,
            vec!["missing".to_string(), "old-boot".to_string()]
        );
        assert!(result.interrupted_calls.is_empty());
        assert!(store.detail("live").unwrap().is_some());
        assert!(store.detail("missing").unwrap().is_none());
        assert!(store.detail("old-boot").unwrap().is_none());
        assert_eq!(store.stats(&ListFilter::default()).unwrap().tool_calls, 1);
    }

    #[test]
    fn reconciles_orphaned_tool_calls_as_interrupted() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        for (id, boot) in [
            ("live", "boot-current"),
            ("old-boot", "boot-old"),
            ("missing", "boot-current"),
        ] {
            let mut started = event(
                "call_started",
                id,
                json!({
                    "tool":"exec_command","kind":"commandExecution",
                    "arguments":{"cmd":id},"started_at":100,"background":false
                }),
            );
            started["boot_id"] = json!(boot);
            store.apply_observation(&started).unwrap();
        }
        let active = HashSet::from(["live".to_string()]);
        let mut result = store
            .reconcile_running_calls("boot-current", &active, 250)
            .unwrap();
        result.interrupted_calls.sort();
        assert_eq!(
            result.interrupted_calls,
            vec!["missing".to_string(), "old-boot".to_string()]
        );
        assert_eq!(store.detail("live").unwrap().unwrap()["status"], "running");
        for id in ["missing", "old-boot"] {
            let detail = store.detail(id).unwrap().unwrap();
            assert_eq!(detail["status"], "interrupted");
            assert_eq!(detail["ended_at"], 250);
            assert!(detail["duration_ms"].is_null());
        }
    }

    #[test]
    fn browser_filter_groups_semantic_input_tools_and_titles_them() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        for (id, tool, args) in [
            (
                "click",
                "browser_click",
                json!({"x":321,"y":456,"button":"left","click_count":1}),
            ),
            ("key", "browser_key", json!({"key":"Control+L"})),
            ("shell", "exec_command", json!({"cmd":"true"})),
        ] {
            store.apply_observation(&event("call_started",id,json!({
                "tool":tool,"kind":"browserInput","arguments":args,"started_at":100,"background":false
            }))).unwrap();
        }
        let list = store
            .list(&ListFilter {
                tool: Some("browser".into()),
                limit: 100,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(list.count, 2);
        assert!(
            list.calls
                .iter()
                .any(|call| call["title"] == "左键 (321, 456)")
        );
        assert!(list.calls.iter().any(|call| call["title"] == "Control+L"));
    }

    #[test]
    fn session_stats_ignore_tool_filter_and_count_patch_lines() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        store.apply_observation(&event("call_started","cmd",json!({"tool":"exec_command","kind":"commandExecution","arguments":{"cmd":"echo alpha"},"started_at":100,"background":false}))).unwrap();
        store.apply_observation(&event("call_started","patch",json!({"tool":"apply_patch","kind":"fileChange","arguments":{"input":"*** Begin Patch\n*** Update File: src/a.rs\n@@\n-old\n+new\n*** Add File: src/b.rs\n+x\n*** End Patch"},"started_at":110,"background":false}))).unwrap();
        store.apply_observation(&event("call_finished","patch",json!({"tool":"apply_patch","kind":"fileChange","arguments":{"input":"*** Begin Patch\n*** Update File: src/a.rs\n@@\n-old\n+new\n*** Add File: src/b.rs\n+x\n*** End Patch"},"started_at":110,"status":"completed","ended_at":115,"duration_ms":5,"background":false,"output":"Success. Updated the following files:"}))).unwrap();
        store.apply_observation(&event("call_started","image",json!({"tool":"view_image","kind":"imageView","arguments":{"path":"shot.png"},"started_at":120,"background":false}))).unwrap();
        store.apply_observation(&event("call_started","browser",json!({"tool":"browser_click","kind":"browserInput","arguments":{"x":10,"y":20},"started_at":130,"background":false}))).unwrap();

        let stats = store
            .stats(&ListFilter {
                tool: Some("exec_command".into()),
                since: Some(50),
                until: Some(150),
                limit: 100,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(stats.tool_calls, 4);
        assert_eq!(stats.command_calls, 1);
        assert_eq!(stats.browser_calls, 1);
        assert_eq!(stats.files_changed, 2);
        assert_eq!(stats.additions, 2);
        assert_eq!(stats.deletions, 1);
    }

    #[test]
    fn session_stats_exclude_failed_and_running_patch_changes() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        let completed =
            "*** Begin Patch\n*** Update File: src/ok.rs\n@@\n-old\n+new\n*** End Patch";
        let failed =
            "*** Begin Patch\n*** Update File: src/failed.rs\n@@\n-before\n+after\n*** End Patch";
        let running = "*** Begin Patch\n*** Add File: src/running.rs\n+pending\n*** End Patch";

        store.apply_observation(&event("call_finished","ok",json!({"tool":"apply_patch","kind":"fileChange","arguments":{"input":completed},"started_at":100,"status":"completed","ended_at":101,"duration_ms":1,"background":false,"output":"Success. Updated the following files:"}))).unwrap();
        store.apply_observation(&event("call_finished","failed",json!({"tool":"apply_patch","kind":"fileChange","arguments":{"input":failed},"started_at":110,"status":"failed","ended_at":111,"duration_ms":1,"background":false,"output":"Failed to find expected lines"}))).unwrap();
        store.apply_observation(&event("call_started","running",json!({"tool":"apply_patch","kind":"fileChange","arguments":{"input":running},"started_at":120,"background":false}))).unwrap();

        let stats = store
            .stats(&ListFilter {
                limit: 100,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(stats.tool_calls, 3);
        assert_eq!(stats.files_changed, 1);
        assert_eq!(stats.additions, 1);
        assert_eq!(stats.deletions, 1);
    }

    #[test]
    fn lists_history_by_offset_without_loading_the_whole_result() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        for (id, started) in [("a", 100), ("b", 200), ("c", 300), ("d", 400)] {
            store.apply_observation(&event("call_started",id,json!({"tool":"exec_command","kind":"commandExecution","arguments":{"cmd":id},"started_at":started,"background":false}))).unwrap();
        }
        let page = store
            .list(&ListFilter {
                limit: 2,
                offset: 1,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.count, 4);
        assert_eq!(page.calls.len(), 2);
        assert_eq!(page.calls[0]["id"], "c");
        assert_eq!(page.calls[1]["id"], "b");
    }

    #[test]
    fn list_around_returns_stable_anchor_position_and_pinned_count() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        store
            .apply_observation(&event(
                "call_started",
                "question",
                json!({
                    "tool":"request_user_input_async","kind":"userInput",
                    "arguments":{"questions":[{"title":"question"}]},
                    "started_at":50,"background":false
                }),
            ))
            .unwrap();
        for (id, started) in [("a", 100), ("b", 200), ("c", 300), ("d", 400)] {
            store
                .apply_observation(&event(
                    "call_started",
                    id,
                    json!({
                        "tool":"exec_command","kind":"commandExecution","arguments":{"cmd":id},
                        "started_at":started,"background":false
                    }),
                ))
                .unwrap();
        }
        let window = store
            .list_around(
                &ListFilter {
                    limit: 3,
                    ..Default::default()
                },
                "b",
                1,
            )
            .unwrap();
        assert_eq!(window.count, 5);
        assert_eq!(window.pinned_count, 1);
        assert_eq!(window.anchor_index, Some(3));
        assert_eq!(window.offset, 2);
        assert_eq!(window.calls[0]["id"], "c");
        assert_eq!(window.calls[1]["id"], "b");
        assert_eq!(window.calls[2]["id"], "a");
    }

    #[test]
    fn cua_stats_cache_counts_invocations_and_replays_once() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        let all = ListFilter::default();
        let window = ListFilter {
            since: Some(100),
            until: Some(200),
            ..Default::default()
        };
        assert_eq!(store.stats(&all).unwrap().cua_calls, 0);
        assert_eq!(store.stats(&window).unwrap().cua_calls, 0);
        for (id, tool, started) in [
            ("read", "cua_repl.js", 100),
            ("reset", "cua_repl.js_reset", 199),
            ("native", "cua_repl.js", 200),
            ("legacy", "browser_click", 90),
        ] {
            let data = json!({"tool":tool,"kind":"cuaCall","arguments":{"title":"CUA read"},"started_at":started,"status":"failed","ended_at":210});
            store
                .apply_observation(&event("call_started", id, data.clone()))
                .unwrap();
            // Starts count immediately, regardless of completion or failure.
            let before = store.stats(&all).unwrap().cua_calls;
            store
                .apply_observation(&event("call_finished", id, data.clone()))
                .unwrap();
            store
                .apply_observation(&event("call_finished", id, data.clone()))
                .unwrap();
            store
                .apply_observation(&event("call_sync", id, data))
                .unwrap();
            assert_eq!(store.stats(&all).unwrap().cua_calls, before);
        }
        assert_eq!(store.stats(&all).unwrap().cua_calls, 4);
        assert_eq!(store.stats(&window).unwrap().cua_calls, 2);
        assert_eq!(store.stats(&all).unwrap().browser_calls, 4);
        for category in ["browser", "cua"] {
            assert_eq!(
                store
                    .list(&ListFilter {
                        tool: Some(category.into()),
                        limit: 100,
                        ..Default::default()
                    })
                    .unwrap()
                    .count,
                4
            );
        }
        assert_eq!(store.detail("read").unwrap().unwrap()["title"], "CUA read");
        store.stats_cache.lock().unwrap().clear();
        assert_eq!(store.stats(&all).unwrap().cua_calls, 4);
        assert_eq!(store.stats(&window).unwrap().cua_calls, 2);
    }

    #[test]
    fn stats_cache_tracks_patch_completion_replay_and_shared_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        let filter = ListFilter::default();
        store.stats(&filter).unwrap();
        let patch = json!({"tool":"apply_patch","kind":"fileChange","arguments":{"input":"*** Begin Patch\n*** Update File: a.rs\n-old\n+new\n*** End Patch"},"started_at":100,"status":"completed","ended_at":110});
        store
            .apply_observation(&event("call_started", "a", patch.clone()))
            .unwrap();
        assert_eq!(store.stats(&filter).unwrap().files_changed, 0);
        for id in ["a", "a", "b"] {
            store
                .apply_observation(&event("call_finished", id, patch.clone()))
                .unwrap();
        }
        let stats = store.stats(&filter).unwrap();
        assert_eq!(
            (
                stats.tool_calls,
                stats.files_changed,
                stats.additions,
                stats.deletions
            ),
            (2, 1, 2, 2)
        );
        let mut failed = patch;
        failed["status"] = json!("failed");
        store
            .apply_observation(&event("call_finished", "a", failed))
            .unwrap();
        let cached = serde_json::to_value(store.stats(&filter).unwrap()).unwrap();
        assert_eq!(cached["files_changed"], 1);
        assert_eq!(cached["additions"], 1);
        store.stats_cache.lock().unwrap().clear();
        assert_eq!(
            cached,
            serde_json::to_value(store.stats(&filter).unwrap()).unwrap()
        );
    }

    #[test]
    fn push_subscriptions_require_live_auth_and_are_removed_with_session() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("history.sqlite")).unwrap();
        let auth_key = vec![7_u8; 32];
        let subscription = PushSubscription {
            endpoint: "https://push.example.test/subscription".into(),
            p256dh: "p256dh".into(),
            auth: "auth".into(),
            auth_key: auth_key.clone(),
            auth_expires_at: unix_seconds() + 60,
        };

        store.save_push_subscription(&subscription).unwrap();
        let active = store.push_subscriptions().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].auth_key, auth_key);

        store
            .delete_push_subscriptions_for_auth(&subscription.auth_key)
            .unwrap();
        assert!(store.push_subscriptions().unwrap().is_empty());

        let expired = PushSubscription {
            auth_expires_at: unix_seconds() - 1,
            ..subscription
        };
        assert!(store.save_push_subscription(&expired).is_err());
    }

    #[test]
    fn legacy_push_subscriptions_are_dropped_during_auth_binding_migration() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history.sqlite");
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE push_subscriptions(
                    endpoint TEXT PRIMARY KEY,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO push_subscriptions(endpoint,p256dh,auth,updated_at)
                 VALUES('https://push.example.test/legacy','key','auth',1);",
            )
            .unwrap();
        }

        let store = Store::open(&path).unwrap();
        assert!(store.push_subscriptions().unwrap().is_empty());
        let db = store.db.lock().unwrap();
        let columns = db
            .prepare("PRAGMA table_info(push_subscriptions)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<HashSet<_>, _>>()
            .unwrap();
        assert!(columns.contains("auth_key"));
        assert!(columns.contains("auth_expires_at"));
    }
}

fn unsigned_column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
