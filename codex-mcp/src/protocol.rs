use crate::{
    App,
    auth::Principal,
    media,
    process::{ExecArgs, StdinArgs},
    schema,
};
use axum::{
    Extension, Json,
    body::Bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::sync::Arc;

pub async fn http_guard(State(app): State<Arc<App>>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let origin = req
        .headers()
        .get("origin")
        .and_then(|h| h.to_str().ok())
        .map(String::from);
    if origin.as_ref().is_some_and(|o| {
        !crate::origin::allowed(o, &app.config.issuer, &app.config.allowed_origins)
    }) {
        return (StatusCode::FORBIDDEN, "Origin is not allowed").into_response();
    }
    if req.method() == axum::http::Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        cors(&mut response, origin.as_deref());
        return response;
    }
    let protected = match path.as_str() {
        "/mcp" => Some((
            app.config.resource(),
            "/.well-known/oauth-protected-resource/mcp",
        )),
        "/cua" if app.config.cua.is_some() => Some((
            app.config.cua_resource(),
            "/.well-known/oauth-protected-resource/cua",
        )),
        _ => None,
    };
    if let Some((resource, metadata_path)) = protected {
        let token = req
            .headers()
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.split_once(' '))
            .filter(|(s, _)| s.eq_ignore_ascii_case("bearer"))
            .map(|(_, v)| v)
            .unwrap_or("");
        match app.auth.principal(token, &resource) {
            Ok(Some(p)) => {
                req.extensions_mut().insert(p);
            }
            Ok(None) => {
                let mut response = (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({"error":"unauthorized"})),
                )
                    .into_response();
                response.headers_mut().insert(
                    "www-authenticate",
                    format!(
                        "Bearer resource_metadata=\"{}{metadata_path}\", scope=\"mcp\"",
                        app.config.issuer
                    )
                    .parse()
                    .unwrap(),
                );
                cors(&mut response, origin.as_deref());
                return response;
            }
            Err(e) => {
                tracing::error!(error=%e,"token lookup failed");
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
        }
    }
    let mut response = next.run(req).await;
    cors(&mut response, origin.as_deref());
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("pragma", "no-cache".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response.headers_mut().insert(
        "referrer-policy",
        if path == "/mcp/oauth/authorize" {
            "same-origin"
        } else {
            "no-referrer"
        }
        .parse()
        .unwrap(),
    );
    if !response.headers().contains_key("content-security-policy") {
        response.headers_mut().insert(
            "content-security-policy",
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
                .parse()
                .unwrap(),
        );
    }
    response
}
fn cors(response: &mut Response, origin: Option<&str>) {
    if let Some(origin) = origin
        && let Ok(value) = origin.parse()
    {
        response
            .headers_mut()
            .insert("access-control-allow-origin", value);
    }
    response
        .headers_mut()
        .insert("vary", "Origin".parse().unwrap());
    response.headers_mut().insert(
        "access-control-allow-methods",
        "POST, GET, DELETE, OPTIONS".parse().unwrap(),
    );
    response.headers_mut().insert(
        "access-control-allow-headers",
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id"
            .parse()
            .unwrap(),
    );
    response.headers_mut().insert(
        "access-control-expose-headers",
        "WWW-Authenticate, MCP-Protocol-Version".parse().unwrap(),
    );
}
pub async fn health(State(a): State<Arc<App>>) -> Response {
    let alive = a.processes.alive();
    (if alive{StatusCode::OK}else{StatusCode::SERVICE_UNAVAILABLE},Json(json!({"status":if alive{"ok"}else{"shutting_down"},"version":env!("CARGO_PKG_VERSION")}))).into_response()
}
pub async fn no_stream() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [("allow", "POST, OPTIONS")]).into_response()
}
const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
fn rpc_error(id: Value, code: i32, message: &str) -> Response {
    Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})).into_response()
}
pub async fn mcp(
    State(a): State<Arc<App>>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if headers
        .get("mcp-protocol-version")
        .is_some_and(|h| !h.to_str().is_ok_and(|s| VERSIONS.contains(&s)))
    {
        return (StatusCode::BAD_REQUEST, "Unsupported MCP protocol version").into_response();
    }
    if !headers
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| s.starts_with("application/json"))
    {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    if headers.get("accept").is_some_and(|h| {
        !h.to_str()
            .is_ok_and(|s| s.contains("application/json") || s.contains("*/*"))
    }) {
        return StatusCode::NOT_ACCEPTABLE.into_response();
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return rpc_error(Value::Null, -32700, "Parse error"),
    };
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    if !value.is_object()
        || value["jsonrpc"] != "2.0"
        || !value["method"].is_string()
        || (!id.is_null() && !id.is_string() && !id.is_number())
    {
        return rpc_error(id, -32600, "Invalid Request");
    }
    if value.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let method = value["method"].as_str().unwrap();
    let result = match method {
        "initialize" => {
            let requested = value["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = if VERSIONS.contains(&requested) {
                requested
            } else {
                VERSIONS[0]
            };
            json!({"protocolVersion":version,"serverInfo":{"name":"codex-mcp","version":env!("CARGO_PKG_VERSION")},"capabilities":{"tools":{"listChanged":false}},"instructions":schema::instructions(&a.config.workdir)})
        }
        "ping" => json!({}),
        "tools/list" => {
            if value["params"].get("cursor").is_some() {
                return rpc_error(
                    id,
                    -32602,
                    "This static four-tool catalog does not use cursors",
                );
            }
            schema::tools(a.config.expose_shell, a.config.login)
        }
        "tools/call" => {
            let Some(name) = value["params"]["name"].as_str() else {
                return rpc_error(id, -32602, "Tool name is required");
            };
            if !["apply_patch", "exec_command", "view_image", "write_stdin"].contains(&name) {
                return rpc_error(id, -32602, "Unknown tool");
            }
            let args = value["params"]
                .get("arguments")
                .cloned()
                .unwrap_or(json!({}));
            let observation = a.observer.begin(name, &args);
            let call = call_tool(a.clone(), p.family, name.to_owned(), args, observation).await;
            match call {
                Ok(v) => v,
                Err(e) => json!({"content":[{"type":"text","text":e.to_string()}],"isError":true}),
            }
        }
        _ => return rpc_error(id, -32601, "Method not found"),
    };
    Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
}
async fn call_tool(
    a: Arc<App>,
    owner: String,
    name: String,
    args: Value,
    observation: Option<crate::observe::CallRef>,
) -> anyhow::Result<Value> {
    // Keep an accepted call alive across transient HTTP disconnects. Never retry a mutation.
    tokio::spawn(async move {
        let result = async {
            let output = match name.as_str() {
                "exec_command" => {
                    let args: ExecArgs = serde_json::from_value(args)?;
                    text_result(
                        serde_json::to_value(
                            a.processes.exec(&owner, args, observation.clone()).await?,
                        )?,
                        false,
                    )
                }
                "write_stdin" => {
                    let args: StdinArgs = serde_json::from_value(args)?;
                    text_result(
                        serde_json::to_value(a.processes.stdin(&owner, args).await?)?,
                        false,
                    )
                }
                "apply_patch" => {
                    let args: media::PatchArgs = serde_json::from_value(args)?;
                    let result = media::patch(&a.config, args).await?;
                    let error = result["exit_code"] != 0;
                    text_result(result, error)
                }
                "view_image" => {
                    let args: media::ImageArgs = serde_json::from_value(args)?;
                    media::image(&a.config, args).await?
                }
                _ => unreachable!(),
            };
            Ok::<Value, anyhow::Error>(output)
        }
        .await;
        a.observer.finish(&observation, &result);
        result
    })
    .await?
}
fn text_result(data: Value, error: bool) -> Value {
    json!({"content":[{"type":"text","text":data.to_string()}],"structuredContent":data,"isError":error})
}
