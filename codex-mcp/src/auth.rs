use crate::App;
use anyhow::Result;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::{Form, Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Auth {
    db: Mutex<Connection>,
    pending: Mutex<HashMap<String, Pending>>,
    gate: Mutex<(u64, u32)>,
    verify_slots: Arc<tokio::sync::Semaphore>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Client {
    redirects: Vec<String>,
    method: String,
    secret_hash: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Authorization {
    client_id: String,
    redirect_uri: String,
    challenge: String,
    resource: String,
    scope: String,
    state: Option<String>,
}
struct Pending {
    authorization: Authorization,
    cookie_hash: String,
    expires: u64,
}
#[derive(Clone)]
pub struct Principal {
    pub family: String,
}
impl Auth {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY, authorization TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS oauth_tokens(hash TEXT PRIMARY KEY, kind TEXT NOT NULL, family TEXT NOT NULL, client_id TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family);")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self {
            db: Mutex::new(db),
            pending: Default::default(),
            gate: Mutex::new((0, 0)),
            verify_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        })
    }
    pub fn principal(&self, token: &str, resource: &str) -> Result<Option<Principal>> {
        Ok(self.db.lock().unwrap().query_row("SELECT family FROM oauth_tokens WHERE hash=? AND kind='access' AND resource=? AND (expires=0 OR expires>?)",params![hash(token),resource,now()],|r|Ok(Principal{family:r.get(0)?})).optional()?)
    }
    pub fn revoke_all(&self) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM oauth_codes", [])?;
        tx.execute("DELETE FROM oauth_tokens", [])?;
        tx.commit()?;
        Ok(())
    }
    fn client(&self, id: &str) -> Result<Option<Client>> {
        let data: Option<String> = self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT metadata FROM oauth_clients WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()?;
        data.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    fn allow_public_request(&self) -> bool {
        let mut gate = self.gate.lock().unwrap();
        let window = now() / 60;
        if gate.0 != window {
            *gate = (window, 0);
        }
        gate.1 += 1;
        gate.1 <= 120
    }
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}
pub fn random() -> String {
    let mut bytes = [0; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn same(a: &str, b: &str) -> bool {
    let a = Sha256::digest(a.as_bytes());
    let b = Sha256::digest(b.as_bytes());
    a.iter().zip(b.iter()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}
pub fn hash_password(password: &str) -> Result<String> {
    anyhow::ensure!(
        password.len() >= 12,
        "password must contain at least 12 characters"
    );
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("{e}"))
}
fn error(code: &str, description: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({"error":code,"error_description":description})),
    )
        .into_response()
}
fn failure(e: anyhow::Error) -> Response {
    tracing::error!(error=%e,"OAuth storage failure");
    error(
        "server_error",
        "authorization storage unavailable",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}
fn bad(code: &str, description: &str) -> Response {
    error(code, description, StatusCode::BAD_REQUEST)
}
pub async fn resource_metadata(State(a): State<Arc<App>>) -> Json<Value> {
    resource_metadata_for(&a, a.config.resource())
}
pub async fn cua_resource_metadata(State(a): State<Arc<App>>) -> Response {
    if a.config.cua.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    resource_metadata_for(&a, a.config.cua_resource()).into_response()
}
fn resource_metadata_for(a: &App, resource: String) -> Json<Value> {
    Json(
        json!({"resource":resource,"authorization_servers":[a.config.issuer],"scopes_supported":["mcp"],"bearer_methods_supported":["header"]}),
    )
}
pub async fn server_metadata(State(a): State<Arc<App>>) -> Json<Value> {
    Json(json!({"issuer":a.config.issuer,
        "authorization_endpoint":format!("{}/mcp/oauth/authorize",a.config.issuer),
        "token_endpoint":format!("{}/mcp/oauth/token",a.config.issuer),
        "registration_endpoint":format!("{}/mcp/oauth/register",a.config.issuer),
        "revocation_endpoint":format!("{}/mcp/oauth/revoke",a.config.issuer),
        "response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],
        "code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","client_secret_post","client_secret_basic"],
        "revocation_endpoint_auth_methods_supported":["none","client_secret_post","client_secret_basic"],
        "scopes_supported":["mcp","offline_access"],"authorization_response_iss_parameter_supported":true}))
}
#[derive(Deserialize)]
pub struct Registration {
    redirect_uris: Vec<String>,
    token_endpoint_auth_method: Option<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
}
pub async fn register(State(a): State<Arc<App>>, Json(r): Json<Registration>) -> Response {
    if !a.auth.allow_public_request() {
        return error(
            "temporarily_unavailable",
            "rate limit",
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    let method = r
        .token_endpoint_auth_method
        .unwrap_or_else(|| "client_secret_basic".into());
    if !["none", "client_secret_post", "client_secret_basic"].contains(&method.as_str()) {
        return bad(
            "invalid_client_metadata",
            "unsupported token endpoint authentication method",
        );
    }
    if r.redirect_uris.is_empty()
        || r.redirect_uris.len() > 16
        || !r.redirect_uris.iter().all(|s| valid_redirect(s))
    {
        return bad(
            "invalid_redirect_uri",
            "provide exact HTTPS redirects or HTTP loopback redirects",
        );
    }
    if r.grant_types.as_ref().is_some_and(|v| {
        v.iter()
            .any(|s| s != "authorization_code" && s != "refresh_token")
    }) || r.response_types.as_ref().is_some_and(|v| v != &["code"])
    {
        return bad(
            "invalid_client_metadata",
            "only authorization_code and refresh_token are supported",
        );
    }
    let id = random();
    let secret = if method == "none" {
        None
    } else {
        Some(random())
    };
    let client = Client {
        redirects: r.redirect_uris.clone(),
        method: method.clone(),
        secret_hash: secret.as_ref().map(|s| hash(s)),
    };
    let stored = (|| -> Result<()> {
        let db = a.auth.db.lock().unwrap();
        anyhow::ensure!(
            db.query_row("SELECT count(*) FROM oauth_clients", [], |r| r
                .get::<_, u64>(0))?
                < 4096,
            "client registry full"
        );
        db.execute(
            "INSERT INTO oauth_clients VALUES(?,?)",
            params![id, serde_json::to_string(&client)?],
        )?;
        Ok(())
    })();
    if let Err(e) = stored {
        return failure(e);
    }
    let mut out = json!({"client_id":id,"client_id_issued_at":now(),"redirect_uris":r.redirect_uris,"token_endpoint_auth_method":method,"grant_types":["authorization_code","refresh_token"],"response_types":["code"]});
    if let Some(secret) = secret {
        out["client_secret"] = json!(secret);
        out["client_secret_expires_at"] = json!(0);
    }
    (StatusCode::CREATED, Json(out)).into_response()
}
fn valid_redirect(s: &str) -> bool {
    if s.len() > 2048 {
        return false;
    }
    let Ok(u) = url::Url::parse(s) else {
        return false;
    };
    u.username().is_empty()
        && u.password().is_none()
        && u.fragment().is_none()
        && (u.scheme() == "https" && u.host_str().is_some()
            || u.scheme() == "http"
                && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
}
#[derive(Deserialize)]
pub struct AuthorizeQuery {
    client_id: String,
    redirect_uri: String,
    response_type: String,
    code_challenge: String,
    code_challenge_method: String,
    state: Option<String>,
    resource: Option<String>,
    scope: Option<String>,
}
fn scope(raw: Option<&str>) -> Option<String> {
    let raw = raw.unwrap_or("mcp");
    if raw
        .split_whitespace()
        .any(|s| s != "mcp" && s != "offline_access")
    {
        return None;
    }
    if !raw.split_whitespace().any(|s| s == "mcp") {
        return None;
    }
    Some(
        if raw.split_whitespace().any(|s| s == "offline_access") {
            "mcp offline_access"
        } else {
            "mcp"
        }
        .into(),
    )
}
pub async fn authorize_get(State(a): State<Arc<App>>, Query(q): Query<AuthorizeQuery>) -> Response {
    if !a.auth.allow_public_request() {
        return error(
            "temporarily_unavailable",
            "rate limit",
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    let client = match a.auth.client(&q.client_id) {
        Ok(Some(c)) => c,
        Ok(None) => return bad("invalid_client", "client must be registered"),
        Err(e) => return failure(e),
    };
    if !client.redirects.contains(&q.redirect_uri) {
        return bad(
            "invalid_request",
            "redirect_uri does not match registration",
        );
    }
    if q.response_type != "code" {
        return authorization_error(
            &q,
            &a.config.issuer,
            "unsupported_response_type",
            "only code is supported",
        );
    }
    if q.code_challenge_method != "S256"
        || q.code_challenge.len() != 43
        || URL_SAFE_NO_PAD
            .decode(&q.code_challenge)
            .map_or(true, |b| b.len() != 32)
    {
        return authorization_error(
            &q,
            &a.config.issuer,
            "invalid_request",
            "S256 PKCE challenge is required",
        );
    }
    let resource = q.resource.clone().unwrap_or_else(|| a.config.resource());
    if !a.config.allows_resource(&resource) {
        return authorization_error(
            &q,
            &a.config.issuer,
            "invalid_target",
            "resource does not match an enabled MCP server",
        );
    }
    let Some(scope) = scope(q.scope.as_deref()) else {
        return authorization_error(
            &q,
            &a.config.issuer,
            "invalid_scope",
            "supported scopes: mcp offline_access",
        );
    };
    if q.state.as_ref().is_some_and(|s| s.len() > 4096) {
        return bad("invalid_request", "state too long");
    }
    let request_id = random();
    let redirect_uri = q.redirect_uri.clone();
    let cookie = random();
    let mut pending = a.auth.pending.lock().unwrap();
    pending.retain(|_, v| v.expires > now());
    if pending.len() >= 256 {
        return error(
            "temporarily_unavailable",
            "too many pending authorizations",
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    pending.insert(
        request_id.clone(),
        Pending {
            authorization: Authorization {
                client_id: q.client_id,
                redirect_uri: q.redirect_uri,
                challenge: q.code_challenge,
                resource,
                scope,
                state: q.state,
            },
            cookie_hash: hash(&cookie),
            expires: now() + 300,
        },
    );
    let mut response = login_page(&request_id, "", &redirect_uri);
    response.headers_mut().insert("set-cookie",format!("mcpx_auth={cookie}; Path=/mcp/oauth/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=300").parse().unwrap());
    response
}
// Only used after client and exact redirect validation. RFC 9207 issuer identification
// accompanies error redirects as well as successful authorization-code redirects.
fn authorization_error(q: &AuthorizeQuery, issuer: &str, code: &str, message: &str) -> Response {
    let mut uri = url::Url::parse(&q.redirect_uri).expect("validated redirect");
    {
        let mut query = uri.query_pairs_mut();
        query
            .append_pair("error", code)
            .append_pair("error_description", message)
            .append_pair("iss", issuer);
        if let Some(state) = q.state.as_ref().filter(|s| s.len() <= 4096) {
            query.append_pair("state", state);
        }
    }
    (StatusCode::SEE_OTHER, [("location", uri.as_str())]).into_response()
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn authorization_csp(mut response: Response, redirect_uri: &str) -> Response {
    let origin = url::Url::parse(redirect_uri)
        .expect("validated redirect")
        .origin()
        .ascii_serialization();
    response.headers_mut().insert("content-security-policy", format!(
        "default-src 'none'; form-action 'self' {origin}; frame-ancestors 'none'; base-uri 'none'"
    ).parse().expect("validated redirect origin"));
    response
}
fn login_page(request_id: &str, message: &str, redirect_uri: &str) -> Response {
    authorization_csp(Html(format!(
        "<!doctype html><html lang=zh><meta charset=utf-8><meta name=viewport content='width=device-width'><title>codex-mcp 授权</title><body><main><h1>codex-mcp 授权</h1><p>允许此客户端以服务账户权限执行命令、修改文件和读取图像。</p><p>{}</p><form method=post action='/mcp/oauth/authorize'><input type=hidden name=request_id value='{}'><label>授权密码 <input type=password name=password autocomplete=current-password required maxlength=4096 autofocus></label><button type=submit>授权并连接</button></form><p>授权凭证会保存，直到撤销。关闭此窗口可取消。</p></main></body></html>",
        escape(message),
        escape(request_id)
    )).into_response(), redirect_uri)
}
#[derive(Deserialize)]
pub struct LoginForm {
    request_id: String,
    password: String,
}
pub async fn authorize_post(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Form(f): Form<LoginForm>,
) -> Response {
    if !a.auth.allow_public_request() {
        return error(
            "temporarily_unavailable",
            "rate limit",
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    let cookie = headers
        .get("cookie")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .find_map(|p| p.trim().strip_prefix("mcpx_auth="))
        })
        .unwrap_or("");
    let redirect_uri = {
        let pending = a.auth.pending.lock().unwrap();
        if !pending
            .get(&f.request_id)
            .is_some_and(|p| p.expires > now() && same(&p.cookie_hash, &hash(cookie)))
        {
            return bad(
                "invalid_request",
                "authorization expired or browser session mismatch",
            );
        }
        pending[&f.request_id].authorization.redirect_uri.clone()
    };
    if f.password.len() > 4096 {
        return bad("invalid_request", "password too long");
    }
    let permit = match a.auth.verify_slots.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return error(
                "temporarily_unavailable",
                "login busy",
                StatusCode::TOO_MANY_REQUESTS,
            );
        }
    };
    let password_hash = a.config.password_hash.clone();
    let good = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&password_hash).is_ok_and(|h| {
            Argon2::default()
                .verify_password(f.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !good {
        return (
            StatusCode::UNAUTHORIZED,
            login_page(&f.request_id, "密码不正确，请重试。", &redirect_uri),
        )
            .into_response();
    }
    let Some(p) = a.auth.pending.lock().unwrap().remove(&f.request_id) else {
        return bad("invalid_request", "authorization already used");
    };
    if p.expires <= now() {
        return bad("invalid_request", "authorization expired");
    }
    let code = random();
    let auth = p.authorization;
    let stored = (|| -> Result<()> {
        let db = a.auth.db.lock().unwrap();
        db.execute("DELETE FROM oauth_codes WHERE expires<=?", [now()])?;
        db.execute(
            "INSERT INTO oauth_codes VALUES(?,?,?)",
            params![hash(&code), serde_json::to_string(&auth)?, now() + 300],
        )?;
        Ok(())
    })();
    if let Err(e) = stored {
        return failure(e);
    }
    let mut redirect = url::Url::parse(&auth.redirect_uri).expect("validated redirect");
    {
        let mut query = redirect.query_pairs_mut();
        query
            .append_pair("code", &code)
            .append_pair("iss", &a.config.issuer);
        if let Some(state) = auth.state {
            query.append_pair("state", &state);
        }
    }
    let mut response = (StatusCode::SEE_OTHER, [("location", redirect.as_str())]).into_response();
    response.headers_mut().insert(
        "set-cookie",
        "mcpx_auth=; Path=/mcp/oauth/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
            .parse()
            .unwrap(),
    );
    authorization_csp(response, &auth.redirect_uri)
}
fn authenticate_client(
    a: &App,
    headers: &HeaderMap,
    form: &HashMap<String, String>,
) -> Result<Option<String>> {
    let mut id = form.get("client_id").cloned().unwrap_or_default();
    let mut secret = form.get("client_secret").cloned().unwrap_or_default();
    let method = if let Some(h) = headers.get("authorization") {
        if form.contains_key("client_secret") {
            return Ok(None);
        }
        let Some(b) = h.to_str().ok().and_then(|h| h.strip_prefix("Basic ")) else {
            return Ok(None);
        };
        let Ok(decoded) = STANDARD.decode(b) else {
            return Ok(None);
        };
        let Ok(decoded) = String::from_utf8(decoded) else {
            return Ok(None);
        };
        let Some((client_id, client_secret)) = decoded.split_once(':') else {
            return Ok(None);
        };
        let decode = |s: &str| {
            url::form_urlencoded::parse(format!("v={s}").as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        };
        let basic_id = decode(client_id);
        if !id.is_empty() && id != basic_id {
            return Ok(None);
        }
        id = basic_id;
        secret = decode(client_secret);
        "client_secret_basic"
    } else if form.contains_key("client_secret") {
        "client_secret_post"
    } else {
        "none"
    };
    let Some(client) = a.auth.client(&id)? else {
        return Ok(None);
    };
    if client.method != method {
        return Ok(None);
    }
    if method != "none"
        && !client
            .secret_hash
            .as_ref()
            .is_some_and(|h| same(h, &hash(&secret)))
    {
        return Ok(None);
    }
    Ok(Some(id))
}
pub async fn token(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let client = match authenticate_client(&a, &headers, &form) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return error(
                "invalid_client",
                "client authentication failed",
                StatusCode::UNAUTHORIZED,
            );
        }
        Err(e) => return failure(e),
    };
    match exchange(&a, &client, &form) {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            if let Some(e) = e.downcast_ref::<GrantError>() {
                return bad(e.0, e.1);
            }
            failure(e)
        }
    }
}
#[derive(Debug)]
struct GrantError(&'static str, &'static str);
impl std::fmt::Display for GrantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.0, self.1)
    }
}
impl std::error::Error for GrantError {}
fn invalid() -> anyhow::Error {
    GrantError(
        "invalid_grant",
        "grant is invalid, expired, already used, or bound to another client",
    )
    .into()
}
fn exchange(a: &App, client: &str, f: &HashMap<String, String>) -> Result<Value> {
    let get = |key: &str| f.get(key).map(String::as_str).unwrap_or("");
    let mut db = a.auth.db.lock().unwrap();
    let tx = db.transaction()?;
    let (family, resource, scope) = match get("grant_type") {
        "authorization_code" => {
            let row: Option<(String, u64)> = tx
                .query_row(
                    "SELECT authorization,expires FROM oauth_codes WHERE hash=?",
                    [hash(get("code"))],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (data, expires) = row.ok_or_else(invalid)?;
            let code: Authorization = serde_json::from_str(&data)?;
            let verifier = get("code_verifier");
            if expires <= now()
                || code.client_id != client
                || code.redirect_uri != get("redirect_uri")
                || verifier.len() < 43
                || verifier.len() > 128
                || !verifier
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
                || !same(
                    &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
                    &code.challenge,
                )
            {
                return Err(invalid());
            }
            if f.get("resource").is_some_and(|r| r != &code.resource) {
                return Err(GrantError("invalid_target", "resource mismatch").into());
            }
            tx.execute("DELETE FROM oauth_codes WHERE hash=?", [hash(get("code"))])?;
            (random(), code.resource, code.scope)
        }
        "refresh_token" => {
            let row:Option<(String,String,String,String)>=tx.query_row("SELECT family,client_id,resource,scope FROM oauth_tokens WHERE hash=? AND kind='refresh' AND (expires=0 OR expires>?)",params![hash(get("refresh_token")),now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            let (family, cid, resource, granted_scope) = row.ok_or_else(invalid)?;
            if cid != client {
                return Err(invalid());
            }
            if f.get("resource").is_some_and(|r| r != &resource) {
                return Err(GrantError("invalid_target", "resource mismatch").into());
            }
            let requested = f
                .get("scope")
                .cloned()
                .unwrap_or_else(|| granted_scope.clone());
            if requested
                .split_whitespace()
                .any(|s| !granted_scope.split_whitespace().any(|g| g == s))
                || !requested.split_whitespace().any(|s| s == "mcp")
            {
                return Err(GrantError("invalid_scope", "scope cannot be expanded").into());
            }
            // Rotate atomically. The stable family keeps process ownership across refreshes.
            tx.execute("DELETE FROM oauth_tokens WHERE family=?", [&family])?;
            (family, resource, requested)
        }
        _ => {
            return Err(GrantError(
                "unsupported_grant_type",
                "supported grants: authorization_code refresh_token",
            )
            .into());
        }
    };
    let access = random();
    let refresh = random();
    let ttl = a.config.access_ttl_seconds;
    let expires = if ttl == 0 { 0 } else { now() + ttl };
    tx.execute(
        "DELETE FROM oauth_tokens WHERE expires>0 AND expires<=?",
        [now()],
    )?;
    tx.execute(
        "INSERT INTO oauth_tokens VALUES(?,'access',?,?,?,?,?)",
        params![hash(&access), family, client, resource, scope, expires],
    )?;
    tx.execute(
        "INSERT INTO oauth_tokens VALUES(?,'refresh',?,?,?,?,0)",
        params![hash(&refresh), family, client, resource, scope],
    )?;
    tx.commit()?;
    let mut response =
        json!({"access_token":access,"token_type":"Bearer","refresh_token":refresh,"scope":scope});
    if ttl > 0 {
        response["expires_in"] = json!(ttl);
    } // RFC 6749: omit when no expiry; never send null.
    Ok(response)
}
pub async fn revoke(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let client = match authenticate_client(&a, &headers, &form) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return error(
                "invalid_client",
                "client authentication failed",
                StatusCode::UNAUTHORIZED,
            );
        }
        Err(e) => return failure(e),
    };
    let Some(token) = form.get("token") else {
        return bad("invalid_request", "token is required");
    };
    let result=a.auth.db.lock().unwrap().execute("DELETE FROM oauth_tokens WHERE family IN (SELECT family FROM oauth_tokens WHERE hash=? AND client_id=?)",params![hash(token),client]);
    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => failure(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redirect_validation() {
        assert!(valid_redirect("https://chatgpt.com/connector/oauth/abc"));
        assert!(!valid_redirect("https://x@chatgpt.com/cb"));
        assert!(!valid_redirect("javascript:alert(1)"));
        assert!(!valid_redirect("https://example.com/#fragment"));
        assert!(valid_redirect("http://127.0.0.1:8765/callback"));
    }
    #[test]
    fn escaping() {
        assert_eq!(escape("'\"<>&"), "&#39;&quot;&lt;&gt;&amp;");
    }
    #[test]
    fn passwords() {
        let hash = hash_password("test-password-123").unwrap();
        let h = PasswordHash::new(&hash).unwrap();
        assert!(
            Argon2::default()
                .verify_password(b"test-password-123", &h)
                .is_ok()
        );
        assert!(Argon2::default().verify_password(b"wrong", &h).is_err());
    }
}
