use crate::{App, oidc};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Redirect, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Clone, Copy)]
pub struct PushSession {
    pub key: [u8; 32],
    pub expires_at: i64,
}
pub async fn authenticated(app: &App, headers: &HeaderMap) -> bool {
    let Some(oidc) = &app.oidc else {
        return false;
    };
    oidc.authenticated(headers.get("cookie").and_then(|h| h.to_str().ok()))
        .await
}

pub fn push_session(app: &App, headers: &HeaderMap) -> Option<PushSession> {
    let oidc = app.oidc.as_ref()?;
    let cookie = headers
        .get("cookie")
        .and_then(|header| header.to_str().ok());
    oidc.session_binding(cookie)
        .map(|(key, expires_at)| PushSession { key, expires_at })
}
pub async fn logout(State(a): State<Arc<App>>, headers: HeaderMap) -> Response {
    let push_session = push_session(&a, &headers);
    if let Some(session) = push_session
        && let Err(error) = a.push.delete_auth_session(session.key).await
    {
        tracing::warn!(%error, "delete Web Push subscriptions for logout failed");
    }
    if let Some(oidc) = &a.oidc {
        oidc.revoke_session(headers.get("cookie").and_then(|h| h.to_str().ok()));
    }
    let mut r = Json(json!({"ok":true})).into_response();
    // Expire obsolete local-password cookies; they can no longer authenticate.
    r.headers_mut().append(
        "set-cookie",
        "mcpmonitor_local=; Path=/mcpmonitor/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
            .parse()
            .unwrap(),
    );
    r.headers_mut().append(
        "set-cookie",
        format!(
            "mcpmonitor_session=; Path=/mcpmonitor/; HttpOnly; {}SameSite=Lax; Max-Age=0",
            if a.config.secure_cookie {
                "Secure; "
            } else {
                ""
            }
        )
        .parse()
        .unwrap(),
    );
    r
}
pub async fn me(State(a): State<Arc<App>>, headers: HeaderMap) -> Json<serde_json::Value> {
    Json(json!({"authenticated":authenticated(&a,&headers).await,"auth_mode":"oidc"}))
}

#[derive(Default, Deserialize)]
pub struct StartQuery {
    #[serde(default)]
    request: Option<String>,
}

pub fn requested_id(uri: &Uri) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()).find_map(
        |(key, value)| {
            (key == "request" && oidc::valid_return_request(&value)).then(|| value.into_owned())
        },
    )
}

pub fn login_start_location(uri: &Uri) -> String {
    match requested_id(uri) {
        Some(id) => format!("/mcpmonitor/auth/start?request={id}"),
        None => "/mcpmonitor/auth/start".to_owned(),
    }
}

pub async fn oidc_start(State(a): State<Arc<App>>, Query(q): Query<StartQuery>) -> Response {
    let Some(oidc) = &a.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match oidc.begin_for(q.request.as_deref()) {
        Ok((location, state)) => {
            let mut r = Redirect::to(&location).into_response();
            r.headers_mut()
                .insert("set-cookie", oidc.state_cookie(&state).parse().unwrap());
            r
        }
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
pub async fn oidc_callback(
    State(a): State<Arc<App>>,
    Query(q): Query<oidc::CallbackQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(oidc) = &a.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cookie = headers
        .get("cookie")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| oidc::cookie_value(h, oidc::STATE_COOKIE_NAME));
    let mut r = if q.error.is_empty() {
        match oidc.complete(&q.state, cookie, &q.code).await {
            Ok(credential) => {
                let target = oidc::return_location(credential.return_request.as_deref());
                let mut r = Redirect::to(&target).into_response();
                r.headers_mut().append(
                    "set-cookie",
                    oidc.session_cookie(&credential.token, credential.max_age)
                        .parse()
                        .unwrap(),
                );
                r
            }
            Err(_) => StatusCode::UNAUTHORIZED.into_response(),
        }
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    };
    r.headers_mut()
        .append("set-cookie", oidc.expired_state_cookie().parse().unwrap());
    r
}

#[derive(Deserialize, Default)]
pub struct MobileSessionQuery {
    #[serde(default)]
    request: Option<String>,
}

pub async fn mobile_session(
    State(a): State<Arc<App>>,
    Query(query): Query<MobileSessionQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(oidc) = &a.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(token) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !oidc.authenticated_bearer(token).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(cookie) = oidc.bearer_cookie(token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let location = query
        .request
        .as_deref()
        .filter(|request| {
            !request.is_empty()
                && request.len() <= 128
                && request
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .map(|request| {
            let encoded =
                url::form_urlencoded::byte_serialize(request.as_bytes()).collect::<String>();
            format!("/mcpmonitor/?request={encoded}")
        })
        .unwrap_or_else(|| "/mcpmonitor/".to_owned());
    let mut response = Redirect::to(&location).into_response();
    response
        .headers_mut()
        .append("set-cookie", cookie.parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_deep_link_without_accepting_external_redirects() {
        let uri: Uri = "/mcpmonitor/?request=run_12%2Dabc".parse().unwrap();
        assert_eq!(
            login_start_location(&uri),
            "/mcpmonitor/auth/start?request=run_12-abc"
        );
        let from_bare_root: Uri = "/mcpmonitor?request=run_12".parse().unwrap();
        assert_eq!(
            login_start_location(&from_bare_root),
            "/mcpmonitor/auth/start?request=run_12"
        );
        for unsafe_query in [
            "request=%2F%2Fbad.example",
            "request=..%2Fkeys",
            "next=https://bad.example",
        ] {
            let uri: Uri = format!("/mcpmonitor/?{unsafe_query}").parse().unwrap();
            assert_eq!(login_start_location(&uri), "/mcpmonitor/auth/start");
        }
    }
}
