use crate::{
    App, access,
    hub::{HubEvent, ReplayAfter},
    oidc,
    store::ListFilter,
    widget_auth,
};
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{
        IntoResponse, Redirect, Response, Sse,
        sse::{Event, KeepAlive},
    },
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{convert::Infallible, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::{
    Message as TungsteniteMessage, client::IntoClientRequest,
    http::HeaderValue as TungsteniteHeaderValue,
};

#[derive(Clone, Deserialize, Default)]
pub struct EventQuery {
    tool: Option<String>,
    since: Option<u64>,
    until: Option<u64>,
    q: Option<String>,
    range: Option<String>,
    utc_offset_minutes: Option<i32>,
    limit: Option<usize>,
    offset: Option<usize>,
    anchor: Option<String>,
    before: Option<usize>,
}

#[derive(Deserialize)]
pub struct RtcOffer {
    sdp: String,
}

impl EventQuery {
    fn filter(&self) -> ListFilter {
        ListFilter {
            tool: self.tool.clone(),
            since: self.since,
            until: self.until,
            query: self.q.clone(),
            limit: self.limit.unwrap_or(100).clamp(1, 5000),
            offset: self.offset.unwrap_or(0),
        }
    }

    fn stats_filter(&self) -> ListFilter {
        ListFilter {
            since: self.since,
            until: self.until,
            limit: 5000,
            offset: 0,
            ..Default::default()
        }
    }

    fn event_filter(&self) -> ListFilter {
        ListFilter {
            tool: None,
            since: self.since,
            until: self.until,
            query: self.q.clone(),
            limit: 1,
            offset: 0,
        }
    }

    fn rolling_range(&self) -> Option<&str> {
        self.range
            .as_deref()
            .filter(|range| matches!(*range, "1d" | "24h" | "3d" | "7d" | "1m"))
    }

    fn utc_offset_minutes(&self) -> i64 {
        i64::from(
            self.utc_offset_minutes
                .unwrap_or_default()
                .clamp(-1_439, 1_439),
        )
    }

    fn rolling_since_at(&self, now_ms: u64) -> Option<u64> {
        let range = self.rolling_range()?;
        let minute = 60_000_u64;
        let day = 24 * 60 * minute;
        let rounded = now_ms / minute * minute;
        match range {
            "24h" => Some(rounded.saturating_sub(day)),
            "3d" => Some(rounded.saturating_sub(3 * day)),
            "7d" => Some(rounded.saturating_sub(7 * day)),
            "1d" => {
                let offset_ms = self.utc_offset_minutes() * 60_000;
                let local_ms = i64::try_from(now_ms).ok()?.checked_add(offset_ms)?;
                let local_day = local_ms.div_euclid(i64::try_from(day).ok()?);
                u64::try_from(
                    local_day
                        .checked_mul(i64::try_from(day).ok()?)?
                        .checked_sub(offset_ms)?,
                )
                .ok()
            }
            "1m" => {
                let day_ms = i64::try_from(day).ok()?;
                let offset_ms = self.utc_offset_minutes() * 60_000;
                let local_ms = i64::try_from(rounded).ok()?.checked_add(offset_ms)?;
                let local_day = local_ms.div_euclid(day_ms);
                let time_of_day = local_ms.rem_euclid(day_ms);
                let (year, month, day_of_month) = civil_from_days(local_day);
                let (previous_year, previous_month) = if month == 1 {
                    (year - 1, 12)
                } else {
                    (year, month - 1)
                };
                let previous_day = day_of_month.min(days_in_month(previous_year, previous_month));
                let previous_local_day =
                    days_from_civil(previous_year, previous_month, previous_day);
                u64::try_from(
                    previous_local_day
                        .checked_mul(day_ms)?
                        .checked_add(time_of_day)?
                        .checked_sub(offset_ms)?,
                )
                .ok()
            }
            _ => None,
        }
    }

    fn event_filter_at(&self, now_ms: u64) -> ListFilter {
        let mut filter = self.event_filter();
        if self.rolling_range().is_some() {
            filter.since = self.rolling_since_at(now_ms);
            filter.until = None;
        }
        filter
    }

    fn stats_filter_at(&self, now_ms: u64) -> ListFilter {
        let mut filter = self.stats_filter();
        if self.rolling_range().is_some() {
            filter.since = self.rolling_since_at(now_ms);
            filter.until = None;
        }
        filter
    }

    fn list_filter_at(&self, tool: Option<&str>, now_ms: u64) -> ListFilter {
        let event = self.event_filter_at(now_ms);
        ListFilter {
            tool: tool.map(ToOwned::to_owned),
            since: event.since,
            until: event.until,
            query: self.q.clone(),
            limit: 1,
            offset: 0,
        }
    }

    fn next_window_tick_ms(&self, now_ms: u64) -> Option<u64> {
        match self.rolling_range()? {
            "1d" => {
                let day_ms = 86_400_000_i64;
                let offset_ms = self.utc_offset_minutes() * 60_000;
                let local_ms = i64::try_from(now_ms).ok()?.checked_add(offset_ms)?;
                let next_local_day = local_ms.div_euclid(day_ms).checked_add(1)?;
                u64::try_from(next_local_day.checked_mul(day_ms)?.checked_sub(offset_ms)?).ok()
            }
            _ => Some((now_ms / 60_000 + 1) * 60_000),
        }
    }
}

fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let mut year = i64::from(year);
    let month = i64::from(month);
    let day = i64::from(day);
    year -= i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

async fn rolling_window_snapshot(
    store: Arc<crate::store::Store>,
    query: EventQuery,
    now_ms: u64,
) -> Option<Value> {
    tokio::task::spawn_blocking(move || {
        let stats = store.stats(&query.stats_filter_at(now_ms))?;
        let mut counts = serde_json::Map::new();
        for (name, tool) in [
            ("all", None),
            ("exec_command", Some("exec_command")),
            ("apply_patch", Some("apply_patch")),
            ("view_image", Some("view_image")),
            ("write_stdin", Some("write_stdin")),
            ("browser", Some("browser")),
        ] {
            counts.insert(
                name.to_string(),
                json!(store.count_for_list(&query.list_filter_at(tool, now_ms))?),
            );
        }
        Ok::<_, anyhow::Error>(json!({
            "since": query.rolling_since_at(now_ms),
            "until": Value::Null,
            "counts": counts,
            "stats": stats,
        }))
    })
    .await
    .ok()
    .and_then(Result::ok)
}

pub async fn root(State(a): State<Arc<App>>, headers: HeaderMap, request: Request) -> Response {
    if !access::authenticated(&a, &headers).await {
        return Redirect::temporary(&access::login_start_location(request.uri())).into_response();
    }
    Redirect::permanent(&oidc::return_location(
        access::requested_id(request.uri()).as_deref(),
    ))
    .into_response()
}
pub async fn index(State(a): State<Arc<App>>, headers: HeaderMap, request: Request) -> Response {
    if !access::authenticated(&a, &headers).await {
        return Redirect::temporary(&access::login_start_location(request.uri())).into_response();
    }
    static_response(
        "text/html; charset=utf-8",
        include_str!("../static/index.html"),
    )
}
pub async fn css() -> Response {
    static_response("text/css; charset=utf-8", include_str!("../static/app.css"))
}
pub async fn js() -> Response {
    static_response(
        "text/javascript; charset=utf-8",
        include_str!("../static/app.js"),
    )
}
pub async fn service_worker() -> Response {
    let mut response = (
        [
            ("content-type", "application/javascript; charset=utf-8"),
            ("cache-control", "no-store"),
            ("service-worker-allowed", "/mcpmonitor/"),
            (
                "content-security-policy",
                "default-src 'none'; connect-src 'self'",
            ),
        ],
        include_str!("../static/sw.js"),
    )
        .into_response();
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPushKeys {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPushSubscription {
    endpoint: String,
    keys: BrowserPushKeys,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeletePushSubscription {
    endpoint: String,
}

pub async fn push_key(State(a): State<Arc<App>>) -> Json<Value> {
    Json(json!({
        "enabled": a.push.public_key().is_some(),
        "public_key": a.push.public_key(),
    }))
}

pub async fn push_subscription(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<BrowserPushSubscription>,
) -> Response {
    let Some(session) = access::push_session(&a, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let subscription = crate::store::PushSubscription {
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        auth_key: session.key.to_vec(),
        auth_expires_at: session.expires_at,
    };
    match a.push.save_subscription(subscription).await {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn delete_push_subscription(
    State(a): State<Arc<App>>,
    Json(body): Json<DeletePushSubscription>,
) -> Response {
    match a.push.delete_subscription(body.endpoint).await {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}
pub async fn widget_root() -> Redirect {
    Redirect::permanent("/mcpmonitor/widget/")
}
pub async fn widget_index() -> Response {
    static_response(
        "text/html; charset=utf-8",
        include_str!("../static/widget.html"),
    )
}
pub async fn widget_css() -> Response {
    static_response(
        "text/css; charset=utf-8",
        include_str!("../static/widget.css"),
    )
}
pub async fn widget_js() -> Response {
    static_response(
        "text/javascript; charset=utf-8",
        include_str!("../static/widget.js"),
    )
}

#[derive(Clone, Deserialize, Default)]
pub struct UserInputWaitQuery {
    wait_ms: Option<u64>,
}

fn valid_user_input_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn widget_capability(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty() && value.len() <= 4096)
}

fn widget_user_input_cors(mut response: Response) -> Response {
    for (name, value) in [
        ("access-control-allow-origin", "*"),
        ("access-control-allow-methods", "GET, POST, OPTIONS"),
        (
            "access-control-allow-headers",
            "Authorization, Content-Type, X-User-Input-Widget-Key",
        ),
        ("access-control-max-age", "600"),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}

fn widget_key_matches(app: &App, headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get("x-user-input-widget-key")
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    if value.len() != app.user_input_widget_key.len() {
        return false;
    }
    value
        .as_bytes()
        .iter()
        .zip(app.user_input_widget_key.as_bytes())
        .fold(0u8, |diff, (left, right)| diff | (left ^ right))
        == 0
}

pub async fn widget_user_input_options() -> Response {
    widget_user_input_cors(StatusCode::NO_CONTENT.into_response())
}

async fn user_input_upstream(
    a: &App,
    method: &'static str,
    path: &str,
    body: Option<Value>,
    wait_ms: Option<u64>,
    capability: Option<&str>,
) -> Response {
    let mut target = format!("/monitor/v2/user-input{path}");
    if let Some(wait_ms) = wait_ms {
        let wait_ms = wait_ms.clamp(1, 30_000);
        target.push_str(&format!("?wait_ms={wait_ms}"));
    }
    let mut headers = vec![crate::upstream::header(
        "authorization",
        format!("Bearer {}", a.upstream_token),
    )];
    if let Some(capability) = capability {
        headers.push(crate::upstream::header(
            "x-user-input-capability",
            capability,
        ));
    }
    let payload = match body {
        Some(body) => {
            headers.push(crate::upstream::header("content-type", "application/json"));
            match serde_json::to_vec(&body) {
                Ok(payload) => payload,
                Err(error) => {
                    tracing::warn!(%error, "user-input request serialization failed");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        }
        None => Vec::new(),
    };
    let response = match a.codex_rpc.request(method, target, headers, payload).await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, "user-input upstream request failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"user-input service unavailable"})),
            )
                .into_response();
        }
    };
    let status = StatusCode::from_u16(response.status()).unwrap_or(StatusCode::BAD_GATEWAY);
    match response.bytes().await {
        Ok(bytes) => (
            status,
            [("content-type", "application/json; charset=utf-8")],
            bytes,
        )
            .into_response(),
        Err(error) => {
            tracing::warn!(%error, "user-input upstream response read failed");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

pub async fn user_input_detail(
    State(a): State<Arc<App>>,
    Path(id): Path<String>,
    Query(query): Query<UserInputWaitQuery>,
) -> Response {
    if !valid_user_input_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    user_input_upstream(&a, "GET", &format!("/{id}"), None, query.wait_ms, None).await
}

pub async fn user_input_opened(State(a): State<Arc<App>>, Path(id): Path<String>) -> Response {
    if !valid_user_input_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    user_input_upstream(
        &a,
        "POST",
        &format!("/{id}/opened"),
        Some(json!({})),
        None,
        None,
    )
    .await
}

pub async fn user_input_answer(
    State(a): State<Arc<App>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if !valid_user_input_id(&id) || !body.is_object() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    user_input_upstream(&a, "POST", &format!("/{id}/answer"), Some(body), None, None).await
}

pub async fn widget_user_input_bind(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !widget_key_matches(&a, &headers) {
        return widget_user_input_cors(StatusCode::UNAUTHORIZED.into_response());
    }
    if !body.is_object() {
        return widget_user_input_cors(StatusCode::BAD_REQUEST.into_response());
    }
    let response = user_input_upstream(&a, "POST", "/bind", Some(body), None, None).await;
    widget_user_input_cors(response)
}

pub async fn widget_user_input_detail(
    State(a): State<Arc<App>>,
    Path(id): Path<String>,
    Query(query): Query<UserInputWaitQuery>,
    headers: HeaderMap,
) -> Response {
    if !valid_user_input_id(&id) {
        return widget_user_input_cors(StatusCode::BAD_REQUEST.into_response());
    }
    let Some(capability) = widget_capability(&headers) else {
        return widget_user_input_cors(StatusCode::UNAUTHORIZED.into_response());
    };
    let response = user_input_upstream(
        &a,
        "GET",
        &format!("/{id}"),
        None,
        query.wait_ms,
        Some(capability),
    )
    .await;
    widget_user_input_cors(response)
}

pub async fn widget_user_input_opened(
    State(a): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !valid_user_input_id(&id) {
        return widget_user_input_cors(StatusCode::BAD_REQUEST.into_response());
    }
    let Some(capability) = widget_capability(&headers) else {
        return widget_user_input_cors(StatusCode::UNAUTHORIZED.into_response());
    };
    let response = user_input_upstream(
        &a,
        "POST",
        &format!("/{id}/opened"),
        Some(json!({})),
        None,
        Some(capability),
    )
    .await;
    widget_user_input_cors(response)
}

pub async fn widget_user_input_answer(
    State(a): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !valid_user_input_id(&id) || !body.is_object() {
        return widget_user_input_cors(StatusCode::BAD_REQUEST.into_response());
    }
    let Some(capability) = widget_capability(&headers) else {
        return widget_user_input_cors(StatusCode::UNAUTHORIZED.into_response());
    };
    let response = user_input_upstream(
        &a,
        "POST",
        &format!("/{id}/answer"),
        Some(body),
        None,
        Some(capability),
    )
    .await;
    widget_user_input_cors(response)
}
pub async fn codex_pointer_png() -> Response {
    (
        [("content-type", "image/png")],
        Bytes::from_static(include_bytes!("../static/codex-pointer.png")),
    )
        .into_response()
}

pub async fn video_telemetry(headers: HeaderMap, Json(payload): Json<Value>) -> Response {
    if !payload.is_object() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let user_agent = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");
    tracing::info!(
        target: "mcpmonitor::video_telemetry",
        user_agent,
        telemetry = %payload,
        "browser video telemetry"
    );
    StatusCode::NO_CONTENT.into_response()
}
pub async fn codex_pointer_svg() -> Response {
    (
        [("content-type", "image/svg+xml")],
        Bytes::from_static(include_bytes!("../static/codex-pointer.svg")),
    )
        .into_response()
}
fn static_response(mime: &str, body: &'static str) -> Response {
    (
        [("content-type", mime), ("cache-control", "no-store")],
        body,
    )
        .into_response()
}

pub async fn guard(State(a): State<Arc<App>>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let widget = path == "/mcpmonitor/widget" || path.starts_with("/mcpmonitor/widget/");
    let native_user_input = path == "/mcpmonitor/native/user-input/ws";
    if !widget
        && req
            .headers()
            .get("origin")
            .is_some_and(|v| v.to_str().ok() != Some(&a.config.public_origin))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let protected = (path.starts_with("/mcpmonitor/api/") && path != "/mcpmonitor/api/me")
        || path.starts_with("/mcpmonitor/browser/")
        || path.starts_with("/mcpmonitor/native/");
    let native_authorized = native_user_input && native_user_input_authorized(&a, req.headers());
    if !widget && protected && !native_authorized && !access::authenticated(&a, req.headers()).await
    {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":"请先登录"}))).into_response();
    }
    let mut r = next.run(req).await;
    for (k, v) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
    ] {
        r.headers_mut().insert(k, HeaderValue::from_static(v));
    }
    if widget {
        let csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' wss:; form-action 'none'; base-uri 'none'; frame-ancestors https://chatgpt.com https://chat.openai.com https://*.oaiusercontent.com";
        r.headers_mut()
            .insert("content-security-policy", HeaderValue::from_static(csp));
    } else {
        let csp = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
        r.headers_mut()
            .insert("content-security-policy", HeaderValue::from_static(csp));
    }
    r
}

fn native_user_input_authorized(a: &App, headers: &HeaderMap) -> bool {
    let Some(expected) = a.native_user_input_token.as_deref() else {
        return false;
    };
    let Some(actual) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    expected.len() == actual.len() && bool::from(expected.as_bytes().ct_eq(actual.as_bytes()))
}

async fn user_input_upstream_json(
    a: &App,
    method: &'static str,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let target = format!("/monitor/v2/user-input{path}");
    let mut headers = vec![crate::upstream::header(
        "authorization",
        format!("Bearer {}", a.upstream_token),
    )];
    let payload = match body {
        Some(body) => {
            headers.push(crate::upstream::header("content-type", "application/json"));
            serde_json::to_vec(&body)?
        }
        None => Vec::new(),
    };
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        a.codex_rpc.request(method, target, headers, payload),
    )
    .await??;
    let status = StatusCode::from_u16(response.status())?;
    let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    Ok((status, body))
}

pub async fn native_user_input_ws(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !native_user_input_authorized(&a, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| native_user_input_socket(a, socket))
}

async fn running_user_input_ids(store: Arc<crate::store::Store>) -> anyhow::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || store.running_user_input_ids())
        .await
        .map_err(anyhow::Error::from)?
}

async fn native_user_input_socket(a: Arc<App>, socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    // Subscribe before replaying the current snapshot. Events that race with
    // replay stay queued in this receiver; duplicate request IDs are harmless
    // and are de-duplicated by the native client.
    let mut events = a.hub.subscribe();
    if send_native_user_input_message(
        &mut sender,
        &json!({"type":"hello","protocol":1,"server_time":now_millis()}),
    )
    .await
    .is_err()
    {
        return;
    }

    if let Ok(ids) = running_user_input_ids(Arc::clone(&a.store)).await {
        for id in ids {
            if let Ok((status, request)) =
                user_input_upstream_json(&a, "GET", &format!("/{id}?include_capability=true"), None)
                    .await
                && status.is_success()
                && !request["terminal"].as_bool().unwrap_or(false)
                && send_native_user_input_message(
                    &mut sender,
                    &json!({"type":"request","request":request,"sync":true}),
                )
                .await
                .is_err()
            {
                return;
            }
        }
    }
    if send_native_user_input_message(&mut sender, &json!({"type":"snapshot_end"}))
        .await
        .is_err()
    {
        return;
    }

    let mut keepalive = tokio::time::interval(Duration::from_secs(30));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    keepalive.tick().await;
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(message) = incoming else { return; };
                match message {
                    Ok(AxumWsMessage::Text(text)) => {
                        if text.len() > 64 * 1024 { return; }
                        let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else {
                            let _ = send_native_user_input_message(&mut sender, &json!({"type":"error","error":"invalid JSON"})).await;
                            continue;
                        };
                        if handle_native_user_input_message(&a, &mut sender, value).await.is_err() {
                            return;
                        }
                    }
                    Ok(AxumWsMessage::Ping(payload)) => {
                        if sender.send(AxumWsMessage::Pong(payload)).await.is_err() { return; }
                    }
                    Ok(AxumWsMessage::Pong(_)) => {}
                    Ok(AxumWsMessage::Close(_)) | Err(_) => return,
                    Ok(AxumWsMessage::Binary(_)) => return,
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) if event.value["event"] == "user_input_notify" => {
                        let request = event.value["request"].clone();
                        let terminal = request["terminal"].as_bool().unwrap_or(false);
                        if terminal {
                            if send_native_user_input_message(&mut sender, &json!({"type":"resolved","request":request})).await.is_err() { return; }
                        } else if let Some(id) = request["id"].as_str()
                            && let Ok((status, full_request)) = user_input_upstream_json(
                                &a,
                                "GET",
                                &format!("/{id}?include_capability=true"),
                                None,
                            ).await
                            && status.is_success()
                            && send_native_user_input_message(&mut sender, &json!({"type":"request","request":full_request})).await.is_err()
                        {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if send_native_user_input_message(&mut sender, &json!({"type":"resync"})).await.is_err() { return; }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
            _ = keepalive.tick() => {
                if sender.send(AxumWsMessage::Ping(Vec::new().into())).await.is_err() { return; }
            }
        }
    }
}

async fn handle_native_user_input_message(
    a: &App,
    sender: &mut futures_util::stream::SplitSink<WebSocket, AxumWsMessage>,
    value: Value,
) -> anyhow::Result<()> {
    let kind = value["type"].as_str().unwrap_or("");
    match kind {
        "hello" | "pong" => {}
        "opened" => {
            let id = value["id"].as_str().unwrap_or("");
            if !valid_user_input_id(id) {
                send_native_user_input_message(
                    sender,
                    &json!({"type":"ack","op":"opened","id":id,"ok":false,"error":"invalid request id"}),
                )
                .await?;
                return Ok(());
            }
            let (status, body) =
                user_input_upstream_json(a, "POST", &format!("/{id}/opened"), Some(json!({})))
                    .await?;
            send_native_user_input_message(
                sender,
                &json!({"type":"ack","op":"opened","id":id,"ok":status.is_success(),"status":status.as_u16(),"request":body}),
            )
            .await?;
        }
        "answer" => {
            let id = value["id"].as_str().unwrap_or("");
            let answers = value.get("answers").cloned().unwrap_or(Value::Null);
            if !valid_user_input_id(id) || !answers.is_object() {
                send_native_user_input_message(
                    sender,
                    &json!({"type":"ack","op":"answer","id":id,"ok":false,"error":"invalid answer"}),
                )
                .await?;
                return Ok(());
            }
            let (status, body) = user_input_upstream_json(
                a,
                "POST",
                &format!("/{id}/answer"),
                Some(json!({"answers":answers})),
            )
            .await?;
            send_native_user_input_message(
                sender,
                &json!({"type":"ack","op":"answer","id":id,"ok":status.is_success(),"status":status.as_u16(),"request":body}),
            )
            .await?;
        }
        _ => {
            send_native_user_input_message(
                sender,
                &json!({"type":"error","error":"unknown message type"}),
            )
            .await?;
        }
    }
    Ok(())
}

async fn send_native_user_input_message(
    sender: &mut futures_util::stream::SplitSink<WebSocket, AxumWsMessage>,
    value: &Value,
) -> anyhow::Result<()> {
    sender
        .send(AxumWsMessage::Text(value.to_string().into()))
        .await?;
    Ok(())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn widget_authorized(a: &App, headers: &HeaderMap, scope: &str) -> bool {
    !a.browser_token.is_empty() && widget_auth::authenticated(headers, &a.browser_token, scope)
}

fn widget_ws_authorized(a: &App, headers: &HeaderMap, scope: &str) -> bool {
    !a.browser_token.is_empty()
        && headers.get("origin").and_then(|value| value.to_str().ok())
            == Some(&a.config.public_origin)
        && widget_auth::websocket_authenticated(headers, &a.browser_token, scope)
}

pub async fn widget_browser_ws(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !widget_ws_authorized(&a, &headers, "browser") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if a.config.browser_ws_url.is_none() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.protocols([widget_auth::WS_PROTOCOL])
        .max_message_size(8 * 1024 * 1024)
        .max_frame_size(8 * 1024 * 1024)
        .on_upgrade(move |socket| proxy_browser_ws(a, socket))
}

pub async fn widget_video_dc_offer(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Json(_offer): Json<RtcOffer>,
) -> Response {
    if !widget_authorized(&a, &headers, "browser") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    media_not_available()
}

fn media_not_available() -> Response {
    (StatusCode::NOT_IMPLEMENTED, Json(json!({
        "error": "Standalone monitor has no Browser RTC media backend. Use an independent media service."
    }))).into_response()
}

async fn native_live_health_response(a: &App, _log_target: &'static str) -> Response {
    let Some(base) = &a.config.native_live_url else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Native Live not configured"})),
        )
            .into_response();
    };
    let url = format!("{}/health", base.trim_end_matches('/'));
    match a
        .local_http
        .get(url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            match response.json::<Value>().await {
                Ok(body) => (status, Json(body)).into_response(),
                Err(_) => StatusCode::BAD_GATEWAY.into_response(),
            }
        }
        Err(error) => {
            tracing::warn!(%error, "Native Live HTTP health failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"Native Live unavailable"})),
            )
                .into_response()
        }
    }
}

async fn native_live_dc_response(a: &App, sdp: String, _log_target: &'static str) -> Response {
    let Some(base) = &a.config.native_live_url else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Native Live not configured"})),
        )
            .into_response();
    };
    let url = format!("{}/dc", base.trim_end_matches('/'));
    match a
        .local_http
        .post(url)
        .header("x-native-live-public", "1")
        .timeout(Duration::from_secs(8))
        .json(&json!({"sdp":sdp}))
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            match response.json::<Value>().await {
                Ok(body) => (status, Json(body)).into_response(),
                Err(_) => StatusCode::BAD_GATEWAY.into_response(),
            }
        }
        Err(error) => {
            tracing::warn!(%error, "Native Live HTTP signaling failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"Native Live signaling unavailable"})),
            )
                .into_response()
        }
    }
}

pub async fn widget_native_live_health(State(a): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !widget_authorized(&a, &headers, "native") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    native_live_health_response(&a, "mcpmonitor::widget_native").await
}

pub async fn widget_native_live_dc_offer(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Json(offer): Json<RtcOffer>,
) -> Response {
    if !widget_authorized(&a, &headers, "native") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if offer.sdp.is_empty() || offer.sdp.len() > 64 * 1024 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid SDP offer"})),
        )
            .into_response();
    }
    native_live_dc_response(&a, offer.sdp, "mcpmonitor::widget_native").await
}

pub async fn browser_ws(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !access::authenticated(&a, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if a.config.browser_ws_url.is_none() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.max_message_size(8 * 1024 * 1024)
        .max_frame_size(8 * 1024 * 1024)
        .on_upgrade(move |socket| proxy_browser_ws(a, socket))
}

pub async fn browser_restart(State(a): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !access::authenticated(&a, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(browser_ws_url) = &a.config.browser_ws_url else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let mut url = match url::Url::parse(browser_ws_url) {
        Ok(url) => url,
        Err(error) => {
            tracing::warn!(%error, "browser restart URL build failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"Browser control URL unavailable"})),
            )
                .into_response();
        }
    };
    if url.set_scheme("http").is_err() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"Browser control URL unavailable"})),
        )
            .into_response();
    }
    let ws_path = url.path().trim_end_matches('/');
    let base = ws_path.strip_suffix("/ws").unwrap_or(ws_path);
    url.set_path(&format!("{base}/api/browser/restart"));
    url.set_query(None);
    url.set_fragment(None);

    let client = &a.local_http;
    let response = match client
        .post(url)
        .timeout(Duration::from_secs(20))
        .bearer_auth(&a.browser_token)
        .json(&json!({}))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, "browser restart request failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"Browser restart unavailable"})),
            )
                .into_response();
        }
    };
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    match response.json::<Value>().await {
        Ok(body) => (status, Json(body)).into_response(),
        Err(error) => {
            tracing::warn!(%error, "invalid Browser restart response");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"invalid Browser restart response"})),
            )
                .into_response()
        }
    }
}

pub async fn video_dc_offer(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Json(_offer): Json<RtcOffer>,
) -> Response {
    if !access::authenticated(&a, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    media_not_available()
}

pub async fn media_health(State(a): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !access::authenticated(&a, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({"enabled":false, "media_shm_connected":false,
        "error":"Browser media is not bundled with the standalone monitor"}))
    .into_response()
}

pub async fn native_live_health(State(a): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !access::authenticated(&a, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    native_live_health_response(&a, "mcpmonitor::native_live").await
}

pub async fn native_desktop_restart(State(a): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !access::authenticated(&a, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    (StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"Desktop service management is intentionally not embedded in the monitor"})))
        .into_response()
}

pub async fn native_live_dc_offer(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Json(offer): Json<RtcOffer>,
) -> Response {
    if !access::authenticated(&a, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if offer.sdp.is_empty() || offer.sdp.len() > 64 * 1024 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid SDP offer"})),
        )
            .into_response();
    }
    native_live_dc_response(&a, offer.sdp, "mcpmonitor::native_live").await
}

pub async fn audio_rtc_offer(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Json(_offer): Json<RtcOffer>,
) -> Response {
    if !access::authenticated(&a, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    media_not_available()
}

async fn proxy_browser_ws(a: Arc<App>, client: WebSocket) {
    let Some(browser_ws_url) = a.config.browser_ws_url.as_deref() else {
        return;
    };
    let mut request = match browser_ws_url.into_client_request() {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(%error, "browser websocket request build failed");
            return;
        }
    };
    let authorization =
        match TungsteniteHeaderValue::from_str(&format!("Bearer {}", a.browser_token)) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, "browser websocket authorization header failed");
                return;
            }
        };
    request.headers_mut().insert("authorization", authorization);
    let (upstream, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, "browser websocket upstream unavailable");
            return;
        }
    };

    relay_websockets(client, upstream).await;
}

async fn relay_websockets<S>(client: WebSocket, upstream: tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let client_to_upstream = async {
        while let Some(next) = client_rx.next().await {
            let Ok(message) = next else { break };
            let forwarded = match message {
                AxumWsMessage::Text(text) => TungsteniteMessage::Text(text.as_str().into()),
                AxumWsMessage::Binary(bytes) => TungsteniteMessage::Binary(bytes),
                AxumWsMessage::Ping(bytes) => TungsteniteMessage::Ping(bytes),
                AxumWsMessage::Pong(bytes) => TungsteniteMessage::Pong(bytes),
                AxumWsMessage::Close(_) => TungsteniteMessage::Close(None),
            };
            if upstream_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };
    let upstream_to_client = async {
        while let Some(next) = upstream_rx.next().await {
            let Ok(message) = next else { break };
            let forwarded = match message {
                TungsteniteMessage::Text(text) => AxumWsMessage::Text(text.as_str().into()),
                TungsteniteMessage::Binary(bytes) => AxumWsMessage::Binary(bytes),
                TungsteniteMessage::Ping(bytes) => AxumWsMessage::Ping(bytes),
                TungsteniteMessage::Pong(bytes) => AxumWsMessage::Pong(bytes),
                TungsteniteMessage::Close(_) => AxumWsMessage::Close(None),
                TungsteniteMessage::Frame(_) => continue,
            };
            if client_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = client_tx.close().await;
    };
    tokio::select! {
        _ = client_to_upstream => {},
        _ = upstream_to_client => {},
    }
}

pub async fn call_detail(State(a): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let store = a.store.clone();
    let result = tokio::task::spawn_blocking(move || store.detail(&id)).await;
    match result {
        Ok(Ok(Some(call))) => Json(call).into_response(),
        Ok(Ok(None)) => {
            (StatusCode::NOT_FOUND, Json(json!({"error":"调用不存在"}))).into_response()
        }
        Ok(Err(_)) | Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"读取调用失败"})),
        )
            .into_response(),
    }
}

pub async fn call_list(State(a): State<Arc<App>>, Query(query): Query<EventQuery>) -> Response {
    let store = a.store.clone();
    let filter = query.filter();
    let anchor = query.anchor.clone().filter(|value| !value.is_empty());
    let before = query.before.unwrap_or(0).min(5000);
    let result = tokio::task::spawn_blocking(move || {
        if let Some(anchor) = anchor {
            store.list_around(&filter, &anchor, before).map(|list| {
                json!({
                    "calls":list.calls,
                    "count":list.count,
                    "offset":list.offset,
                    "anchor_index":list.anchor_index,
                    "pinned_count":list.pinned_count,
                })
            })
        } else {
            store
                .list(&filter)
                .map(|list| json!({"calls":list.calls,"count":list.count,"offset":filter.offset}))
        }
    })
    .await;
    match result {
        Ok(Ok(list)) => Json(list).into_response(),
        Ok(Err(_)) | Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"读取历史记录失败"})),
        )
            .into_response(),
    }
}

pub async fn status(State(a): State<Arc<App>>) -> Json<serde_json::Value> {
    Json(a.hub.connection.borrow().as_ref().clone())
}

async fn browser_payloads_for_hub_event(
    a: &Arc<App>,
    query: &EventQuery,
    hub_event: &HubEvent,
) -> Vec<(&'static str, String)> {
    let value = hub_event.value.as_ref();
    match value["event"].as_str().unwrap_or("") {
        "summary" => {
            let call = value["call"].clone();
            let id = call["id"].as_str().unwrap_or("").to_owned();
            if id.is_empty() {
                return Vec::new();
            }
            let store = a.store.clone();
            let now_ms = now_millis();
            let stats_filter = query.stats_filter_at(now_ms);
            let event_filter = query.event_filter_at(now_ms);
            let database_update = tokio::task::spawn_blocking(move || {
                let stats = if store.matches_id(&id, &stats_filter).unwrap_or(false) {
                    store.stats(&stats_filter).ok()
                } else {
                    None
                };
                let event_matches = store
                    .matches_id_for_list(&id, &event_filter)
                    .unwrap_or(false);
                (stats, event_matches)
            })
            .await
            .ok();
            let Some((stats, event_matches)) = database_update else {
                return Vec::new();
            };
            let mut payloads = Vec::with_capacity(2);
            if let Some(stats) = stats {
                payloads.push(("stats", json!(stats).to_string()));
            }
            if event_matches {
                let change = json!({
                    "operation": if value["source_event"] == "call_started" { "insert" } else { "update" },
                    "call": call,
                });
                payloads.push(("list_change", change.to_string()));
            }
            payloads
        }
        "connection" => vec![("connection", value.to_string())],
        "gap" => vec![("gap", value.to_string())],
        "source_restart" => vec![("source_restart", value.to_string())],
        "list_reset" => vec![("list_reset", value.to_string())],
        "user_input_notify" => vec![("user_input_notify", value["request"].to_string())],
        _ => Vec::new(),
    }
}

fn revision_events(payloads: Vec<(&'static str, String)>, revision: u64) -> Vec<Event> {
    let revision = revision.to_string();
    if payloads.is_empty() {
        return vec![
            Event::default()
                .event("stream_cursor")
                .data("{}")
                .id(revision),
        ];
    }
    let last = payloads.len() - 1;
    payloads
        .into_iter()
        .enumerate()
        .map(|(index, (name, data))| {
            let event = Event::default().event(name).data(data);
            if index == last {
                event.id(revision.clone())
            } else {
                event
            }
        })
        .collect()
}

pub async fn events(
    State(a): State<Arc<App>>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Response {
    let mut receiver = a.hub.subscribe();
    let last_event_id = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let initial_replay = last_event_id.map(|revision| a.hub.replay_after(revision));
    let initial_head = a.hub.head_revision();
    let initial_connection = a.hub.connection.borrow().as_ref().clone();
    let initial_stats_store = a.store.clone();
    let initial_stats_filter = query.stats_filter_at(now_millis());
    let mut shutdown = a.shutdown.subscribe();
    let mut next_window_tick = query.next_window_tick_ms(now_millis());
    let stream = async_stream::stream! {
        yield Ok::<_, Infallible>(Event::default().event("connection").data(initial_connection.to_string()));
        let initial_stats =
            tokio::task::spawn_blocking(move || initial_stats_store.stats(&initial_stats_filter))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
        yield Ok(Event::default().event("stats").data(json!(initial_stats).to_string()));
        let mut delivered_revision = initial_head;
        if let Some(replay) = initial_replay {
            match replay {
                ReplayAfter::Available { head, events } => {
                    let from = last_event_id.unwrap_or(head);
                    if head > from {
                        yield Ok(Event::default().event("catchup_begin").data(json!({
                            "from":from,
                            "to":head,
                            "total":head.saturating_sub(from),
                            "reason":"reconnect",
                        }).to_string()));
                        for hub_event in events {
                            let revision = hub_event.revision;
                            let payloads =
                                browser_payloads_for_hub_event(&a, &query, &hub_event).await;
                            for event in revision_events(payloads, revision) {
                                yield Ok(event);
                            }
                        }
                        yield Ok(Event::default().event("catchup_end").data(json!({"to":head}).to_string()));
                    }
                    delivered_revision = head;
                }
                ReplayAfter::TooOld { head, oldest } => {
                    delivered_revision = head;
                    yield Ok(Event::default()
                        .event("reconcile_required")
                        .data(json!({
                            "reason":"replay_miss",
                            "requested_after":last_event_id,
                            "oldest":oldest,
                            "head":head,
                        }).to_string())
                        .id(head.to_string()));
                }
            }
        }
        yield Ok(Event::default()
            .event("bootstrap")
            .data(json!({
                "head_revision":delivered_revision,
            }).to_string())
            .id(delivered_revision.to_string()));
        loop {
            if *shutdown.borrow() { break; }
            tokio::select! {
                _ = shutdown.changed() => break,
                incoming = receiver.recv() => {
                    match incoming {
                        Ok(hub_event) => {
                            if hub_event.revision <= delivered_revision {
                                continue;
                            }
                            if !access::authenticated(&a,&headers).await {
                                yield Ok(Event::default().event("auth_expired").data("{}"));
                                break;
                            }
                            let revision = hub_event.revision;
                            let payloads = browser_payloads_for_hub_event(&a, &query, &hub_event).await;
                            for event in revision_events(payloads, revision) {
                                yield Ok(event);
                            }
                            delivered_revision = revision;
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            if !access::authenticated(&a,&headers).await {
                                yield Ok(Event::default().event("auth_expired").data("{}"));
                                break;
                            }
                            match a.hub.replay_after(delivered_revision) {
                                ReplayAfter::Available { head, events } => {
                                    if head > delivered_revision {
                                        let from = delivered_revision;
                                        yield Ok(Event::default().event("catchup_begin").data(json!({
                                            "from":from,
                                            "to":head,
                                            "total":head.saturating_sub(from),
                                            "reason":"browser_lag",
                                            "skipped":skipped,
                                        }).to_string()));
                                        for hub_event in events {
                                            let revision = hub_event.revision;
                                            let payloads = browser_payloads_for_hub_event(&a, &query, &hub_event).await;
                                            for event in revision_events(payloads, revision) {
                                                yield Ok(event);
                                            }
                                        }
                                        yield Ok(Event::default().event("catchup_end").data(json!({"to":head}).to_string()));
                                    }
                                    delivered_revision = head;
                                }
                                ReplayAfter::TooOld { head, oldest } => {
                                    delivered_revision = head;
                                    yield Ok(Event::default()
                                        .event("reconcile_required")
                                        .data(json!({
                                            "reason":"browser_lag_overflow",
                                            "skipped":skipped,
                                            "oldest":oldest,
                                            "head":head,
                                        }).to_string())
                                        .id(head.to_string()));
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = async {
                    if let Some(deadline) = next_window_tick {
                        tokio::time::sleep(Duration::from_millis(deadline.saturating_sub(now_millis()))).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {
                    if !access::authenticated(&a,&headers).await {
                        yield Ok(Event::default().event("auth_expired").data("{}"));
                        break;
                    }
                    let now_ms = now_millis();
                    if let Some(snapshot) = rolling_window_snapshot(a.store.clone(), query.clone(), now_ms).await {
                        yield Ok(Event::default().event("window_shift").data(snapshot.to_string()));
                    }
                    next_window_tick = query.next_window_tick_ms(now_millis());
                }
                _ = tokio::time::sleep(Duration::from_secs(20)) => {
                    if !access::authenticated(&a,&headers).await {
                        yield Ok(Event::default().event("auth_expired").data("{}"));
                        break;
                    }
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
mod rolling_window_tests {
    use super::*;

    const DAY_MS: i64 = 86_400_000;

    fn utc_millis(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> u64 {
        let value = days_from_civil(year, month, day) * DAY_MS
            + i64::from(hour) * 3_600_000
            + i64::from(minute) * 60_000
            + i64::from(second) * 1_000;
        u64::try_from(value).unwrap()
    }

    #[test]
    fn civil_date_conversion_round_trips_calendar_edges() {
        for (year, month, day) in [
            (1970, 1, 1),
            (2000, 2, 29),
            (2024, 2, 29),
            (2026, 9, 29),
            (2030, 12, 31),
        ] {
            assert_eq!(
                civil_from_days(days_from_civil(year, month, day)),
                (year, month, day)
            );
        }
    }

    #[test]
    fn rolling_24h_cutoff_moves_on_minute_boundaries() {
        let query = EventQuery {
            range: Some("24h".into()),
            ..Default::default()
        };
        let now = utc_millis(2026, 9, 29, 18, 23, 59) + 999;
        assert_eq!(
            query.rolling_since_at(now),
            Some(utc_millis(2026, 9, 28, 18, 23, 0))
        );
        assert_eq!(
            query.next_window_tick_ms(now),
            Some(utc_millis(2026, 9, 29, 18, 24, 0))
        );
    }

    #[test]
    fn today_uses_browser_utc_offset_without_reconnecting() {
        let query = EventQuery {
            range: Some("1d".into()),
            utc_offset_minutes: Some(8 * 60),
            ..Default::default()
        };
        let now = utc_millis(2026, 9, 29, 18, 23, 42);
        assert_eq!(
            query.rolling_since_at(now),
            Some(utc_millis(2026, 9, 29, 16, 0, 0))
        );
        assert_eq!(
            query.next_window_tick_ms(now),
            Some(utc_millis(2026, 9, 30, 16, 0, 0))
        );
    }

    #[test]
    fn one_month_cutoff_clamps_end_of_month_like_javascript_date_logic() {
        let query = EventQuery {
            range: Some("1m".into()),
            ..Default::default()
        };
        assert_eq!(
            query.rolling_since_at(utc_millis(2026, 3, 31, 10, 15, 59)),
            Some(utc_millis(2026, 2, 28, 10, 15, 0))
        );
        assert_eq!(
            query.rolling_since_at(utc_millis(2024, 3, 31, 10, 15, 59)),
            Some(utc_millis(2024, 2, 29, 10, 15, 0))
        );
    }
}
