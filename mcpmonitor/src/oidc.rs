//! Independent OIDC client for mcpmonitor.
//!
//! Authentication uses standard HTTPS OIDC token and userinfo endpoints.
//! No MWS-specific identity RPC or Unix socket is needed. The browser
//! credential is a short-lived JWT access token issued by the OIDC provider.
//! A short in-memory cache only memoizes successful local JWT validation;
//! it is never an authentication source of truth and is safe to lose on restart.

use std::{
    collections::HashMap,
    fs::File,
    io::BufReader,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose};
use rand::{TryRng, rngs::SysRng};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;

pub const SESSION_COOKIE_NAME: &str = "mcpmonitor_session";
pub const STATE_COOKIE_NAME: &str = "mcpmonitor_oidc_state";

const AUTH_BASE_PATH: &str = "/mcpmonitor/auth/";
const SESSION_PATH: &str = "/mcpmonitor/";
const PENDING_TTL_SECONDS: i64 = 10 * 60;
const MAX_PENDING_AUTHORIZATIONS: usize = 128;
const MAX_VALIDATION_CACHE: usize = 4096;
const VALIDATION_CACHE_SECONDS: i64 = 30;
const DEFAULT_SESSION_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Clone, Deserialize)]
pub struct OidcConfig {
    pub issuer: String,
    #[serde(default)]
    pub authorization_endpoint: Option<String>,
    #[serde(default)]
    pub token_endpoint: Option<String>,
    #[serde(default)]
    pub userinfo_endpoint: Option<String>,
    #[serde(default = "default_secure_cookie")]
    pub secure_cookie: bool,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub subject: String,
    #[serde(default = "default_scopes")]
    pub scopes: String,
    #[serde(default = "default_session_ttl")]
    pub session_ttl_seconds: i64,
}

pub struct OidcAuth {
    config: OidcConfig,
    http: reqwest::Client,
    pending: Mutex<HashMap<String, PendingAuthorization>>,
    validated_tokens: Mutex<HashMap<[u8; 32], i64>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: i64,
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
}

struct PendingAuthorization {
    code_verifier: String,
    expires_at: i64,
    return_request: Option<String>,
}

#[derive(Default, Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub error: String,
}

pub struct BrowserCredential {
    pub token: String,
    pub max_age: i64,
    pub return_request: Option<String>,
}

// This is an application request ID, not a caller-controlled redirect URL.
// Restrict it to the same format accepted by the mobile session endpoint.
pub fn valid_return_request(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn return_location(request: Option<&str>) -> String {
    match request.filter(|value| valid_return_request(value)) {
        Some(id) => format!("/mcpmonitor/?request={id}"),
        None => "/mcpmonitor/".to_owned(),
    }
}

#[derive(Deserialize)]
struct JwtLifetime {
    exp: i64,
    #[serde(default)]
    iat: i64,
}

impl OidcConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let file = File::open(path)
            .with_context(|| format!("open OIDC configuration {}", path.display()))?;
        let mut config: Self = serde_json::from_reader(BufReader::new(file))
            .with_context(|| format!("parse OIDC configuration {}", path.display()))?;
        config.normalize_and_validate()?;
        Ok(config)
    }

    fn authorization_endpoint(&self) -> String {
        self.authorization_endpoint
            .clone()
            .unwrap_or_else(|| format!("{}/authorize", self.issuer))
    }

    fn normalize_and_validate(&mut self) -> Result<()> {
        self.issuer = self.issuer.trim().trim_end_matches('/').to_owned();
        self.client_id = self.client_id.trim().to_owned();
        self.client_secret = self.client_secret.trim().to_owned();
        self.redirect_uri = self.redirect_uri.trim().to_owned();
        self.subject = self.subject.trim().to_owned();
        self.scopes = self.scopes.trim().to_owned();

        validate_endpoint(&self.issuer, "issuer", true)?;
        for (name, endpoint) in [
            (
                "authorization_endpoint",
                self.authorization_endpoint.as_deref(),
            ),
            ("token_endpoint", self.token_endpoint.as_deref()),
            ("userinfo_endpoint", self.userinfo_endpoint.as_deref()),
        ] {
            if let Some(endpoint) = endpoint {
                validate_endpoint(endpoint, name, true)?;
                let provider = Url::parse(&self.issuer)?;
                let explicit = Url::parse(endpoint)?;
                anyhow::ensure!(
                    provider.origin() == explicit.origin(),
                    "OIDC {name} must share issuer origin"
                );
            }
        }
        validate_endpoint(&self.redirect_uri, "redirect_uri", !self.secure_cookie)?;
        if self.client_id.is_empty() {
            bail!("OIDC client_id is required");
        }
        if self.client_secret.len() < 32 {
            bail!("OIDC client_secret must contain at least 32 characters");
        }
        if self.subject.is_empty() {
            bail!("OIDC subject is required");
        }
        if self.scopes.is_empty() {
            bail!("OIDC scopes are required");
        }
        if !(5 * 60..=400 * 24 * 60 * 60).contains(&self.session_ttl_seconds) {
            bail!("session_ttl_seconds is outside the supported range");
        }
        Ok(())
    }
}

impl OidcAuth {
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self> {
        Self::new(OidcConfig::load(path)?)
    }

    pub fn new(mut config: OidcConfig) -> Result<Self> {
        config.normalize_and_validate()?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        Ok(Self {
            http,
            config,
            pending: Mutex::new(HashMap::new()),
            validated_tokens: Mutex::new(HashMap::new()),
        })
    }

    async fn exchange_code(&self, code: &str, verifier: &str) -> Result<TokenResponse> {
        let url = self
            .config
            .token_endpoint
            .clone()
            .unwrap_or_else(|| format!("{}/token", self.config.issuer));
        let response = self
            .http
            .post(url)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("code", code),
                ("redirect_uri", self.config.redirect_uri.as_str()),
                ("code_verifier", verifier),
            ])
            .send()
            .await
            .context("OIDC token endpoint")?
            .error_for_status()
            .context("OIDC token exchange rejected")?;
        Ok(response.json::<TokenResponse>().await?)
    }

    async fn verify_access(&self, token: &str) -> Result<String> {
        let url = self
            .config
            .userinfo_endpoint
            .clone()
            .unwrap_or_else(|| format!("{}/userinfo", self.config.issuer));
        let response = self
            .http
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .context("OIDC userinfo endpoint")?
            .error_for_status()
            .context("OIDC userinfo rejected")?;
        Ok(response.json::<UserInfo>().await?.sub)
    }

    pub fn redirect_uri(&self) -> &str {
        &self.config.redirect_uri
    }

    pub fn secure_cookie(&self) -> bool {
        self.config.secure_cookie
    }

    pub fn begin(&self) -> Result<(String, String)> {
        self.begin_for(None)
    }

    pub fn begin_for(&self, return_request: Option<&str>) -> Result<(String, String)> {
        let state = random_token(32)?;
        let verifier = random_token(48)?;
        let challenge =
            general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let now = now_unix();
        {
            let mut pending = lock(&self.pending);
            pending.retain(|_, entry| entry.expires_at > now);
            if pending.len() >= MAX_PENDING_AUTHORIZATIONS {
                bail!("too many pending OIDC authorizations");
            }
            pending.insert(
                state.clone(),
                PendingAuthorization {
                    code_verifier: verifier,
                    expires_at: now + PENDING_TTL_SECONDS,
                    return_request: return_request
                        .filter(|value| valid_return_request(value))
                        .map(str::to_owned),
                },
            );
        }

        let mut authorize = Url::parse(&self.config.authorization_endpoint())?;
        authorize
            .query_pairs_mut()
            .append_pair("client_id", &self.config.client_id)
            .append_pair("redirect_uri", &self.config.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &self.config.scopes)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        Ok((authorize.into(), state))
    }

    pub async fn complete(
        &self,
        state: &str,
        presented_state_cookie: Option<&str>,
        code: &str,
    ) -> Result<BrowserCredential> {
        if state.is_empty()
            || presented_state_cookie
                .is_none_or(|cookie| !constant_time_equal(cookie.as_bytes(), state.as_bytes()))
        {
            bail!("OIDC state mismatch");
        }
        if code.is_empty() {
            bail!("missing authorization code");
        }
        let pending = {
            let mut pending = lock(&self.pending);
            pending.retain(|_, entry| entry.expires_at > now_unix());
            pending
                .remove(state)
                .ok_or_else(|| anyhow!("OIDC authorization request expired"))?
        };

        let token = self.exchange_code(code, &pending.code_verifier).await?;
        if token.access_token.is_empty() || !token.token_type.eq_ignore_ascii_case("bearer") {
            bail!("OIDC returned an incomplete token response");
        }
        // Verify the access token's subject before setting a browser cookie.
        if !self.authenticated_token(&token.access_token).await {
            bail!("OIDC access token was rejected");
        }
        let max_age = if token.expires_in > 0 {
            token.expires_in.min(self.config.session_ttl_seconds)
        } else {
            60_i64.min(self.config.session_ttl_seconds)
        };
        Ok(BrowserCredential {
            token: token.access_token,
            max_age,
            return_request: pending.return_request,
        })
    }

    pub async fn authenticated(&self, cookie_header: Option<&str>) -> bool {
        let Some(token) =
            cookie_header.and_then(|header| cookie_value(header, SESSION_COOKIE_NAME))
        else {
            return false;
        };
        self.authenticated_token(token).await
    }

    pub async fn authenticated_bearer(&self, token: &str) -> bool {
        if token.is_empty() || token.len() > 16 * 1024 {
            return false;
        }
        self.authenticated_token(token).await
    }

    async fn authenticated_token(&self, token: &str) -> bool {
        let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let now = now_unix();
        {
            let cache = lock(&self.validated_tokens);
            if cache
                .get(&digest)
                .is_some_and(|expires_at| *expires_at > now)
            {
                return true;
            }
        }

        let Ok(subject) = self.verify_access(token).await else {
            return false;
        };
        if subject != self.config.subject {
            return false;
        }
        let Some(expires_at) = token_expiry(token) else {
            return false;
        };
        if expires_at <= now {
            return false;
        }
        let mut cache = lock(&self.validated_tokens);
        cache.retain(|_, until| *until > now);
        if cache.len() >= MAX_VALIDATION_CACHE {
            cache.clear();
        }
        cache.insert(digest, expires_at.min(now + VALIDATION_CACHE_SECONDS));
        true
    }

    pub fn bearer_cookie(&self, token: &str) -> Result<String> {
        let now = now_unix();
        let expires_at = token_expiry(token).unwrap_or(now + 60);
        if expires_at <= now {
            bail!("access token expired");
        }
        let max_age = (expires_at - now).min(self.config.session_ttl_seconds);
        Ok(self.session_cookie(token, max_age))
    }

    pub fn session_binding(&self, cookie_header: Option<&str>) -> Option<([u8; 32], i64)> {
        let token = cookie_header.and_then(|header| cookie_value(header, SESSION_COOKIE_NAME))?;
        let lifetime = token_lifetime(token)?;
        let now = now_unix();
        let session_expires_at = if lifetime.iat > 0 {
            lifetime
                .iat
                .saturating_add(self.config.session_ttl_seconds)
                .min(lifetime.exp)
        } else {
            lifetime
                .exp
                .min(now.saturating_add(self.config.session_ttl_seconds))
        };
        if session_expires_at <= now {
            return None;
        }
        Some((Sha256::digest(token.as_bytes()).into(), session_expires_at))
    }

    pub fn revoke_session(&self, cookie_header: Option<&str>) {
        if let Some(token) = cookie_header.and_then(|h| cookie_value(h, SESSION_COOKIE_NAME)) {
            let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
            lock(&self.validated_tokens).remove(&digest);
        }
    }

    pub fn state_cookie(&self, state: &str) -> String {
        let secure = if self.config.secure_cookie {
            "Secure; "
        } else {
            ""
        };
        format!(
            "{STATE_COOKIE_NAME}={state}; Max-Age={PENDING_TTL_SECONDS}; Path={AUTH_BASE_PATH}; {secure}HttpOnly; SameSite=Lax"
        )
    }

    pub fn expired_state_cookie(&self) -> String {
        let secure = if self.config.secure_cookie {
            "Secure; "
        } else {
            ""
        };
        format!(
            "{STATE_COOKIE_NAME}=; Max-Age=0; Path={AUTH_BASE_PATH}; {secure}HttpOnly; SameSite=Lax"
        )
    }

    pub fn session_cookie(&self, token: &str, max_age: i64) -> String {
        let secure = if self.config.secure_cookie {
            "Secure; "
        } else {
            ""
        };
        format!(
            "{SESSION_COOKIE_NAME}={token}; Max-Age={max_age}; Path={SESSION_PATH}; {secure}HttpOnly; SameSite=Lax"
        )
    }
}

pub fn cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find_map(|(key, value)| (key == name && !value.is_empty()).then_some(value))
}

fn validate_endpoint(raw: &str, name: &str, allow_loopback_http: bool) -> Result<Url> {
    let url = Url::parse(raw).with_context(|| format!("invalid OIDC {name}"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.fragment().is_some()
    {
        bail!("OIDC {name} must be an absolute URL without credentials or fragment");
    }
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if url.scheme() != "https" && !(allow_loopback_http && url.scheme() == "http" && loopback) {
        bail!("OIDC {name} must use HTTPS or the local authentication service");
    }
    Ok(url)
}

fn random_token(bytes: usize) -> Result<String> {
    let mut value = vec![0_u8; bytes];
    SysRng
        .try_fill_bytes(&mut value)
        .map_err(|error| anyhow!("random source unavailable: {error}"))?;
    Ok(general_purpose::URL_SAFE_NO_PAD.encode(value))
}

fn token_lifetime(token: &str) -> Option<JwtLifetime> {
    let mut parts = token.split('.');
    parts.next()?;
    let payload = parts.next()?;
    parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let decoded = general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice::<JwtLifetime>(&decoded).ok()
}

fn token_expiry(token: &str) -> Option<i64> {
    token_lifetime(token).map(|claims| claims.exp)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn default_scopes() -> String {
    "openid profile email".to_owned()
}

fn default_secure_cookie() -> bool {
    true
}

const fn default_session_ttl() -> i64 {
    DEFAULT_SESSION_TTL_SECONDS
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> OidcConfig {
        OidcConfig {
            issuer: "https://example.test/oidc".to_owned(),
            authorization_endpoint: None,
            token_endpoint: None,
            userinfo_endpoint: None,
            secure_cookie: true,
            client_id: "mcpmonitor-web".to_owned(),
            client_secret: "0123456789abcdef0123456789abcdef".to_owned(),
            redirect_uri: "https://example.test/mcpmonitor/auth/callback".to_owned(),
            subject: "subject-1".to_owned(),
            scopes: "openid profile email".to_owned(),
            session_ttl_seconds: 3600,
        }
    }

    #[test]
    fn begins_pkce_authorization_without_keys() {
        let auth = OidcAuth::new(config()).unwrap();
        let (location, state) = auth.begin().unwrap();
        let url = Url::parse(&location).unwrap();
        let query = url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(url.path(), "/oidc/authorize");
        assert_eq!(
            query.get("client_id").map(|v| v.as_ref()),
            Some("mcpmonitor-web")
        );
        assert_eq!(query.get("state").map(|v| v.as_ref()), Some(state.as_str()));
        assert_eq!(
            query.get("code_challenge_method").map(|v| v.as_ref()),
            Some("S256")
        );
        assert!(query.contains_key("code_challenge"));
        assert!(!location.contains("/keys"));
    }

    #[test]
    fn keeps_only_safe_mcpmonitor_deep_links_bound_to_oidc_state() {
        let auth = OidcAuth::new(config()).unwrap();
        let (_, state) = auth.begin_for(Some("request_A-42")).unwrap();
        assert_eq!(
            lock(&auth.pending)
                .get(&state)
                .unwrap()
                .return_request
                .as_deref(),
            Some("request_A-42")
        );
        assert_eq!(
            return_location(Some("request_A-42")),
            "/mcpmonitor/?request=request_A-42"
        );
        for invalid in [
            "",
            "/keys",
            "//other.example",
            "../keys",
            "evil?x=1",
            "aa/bb",
        ] {
            let (_, state) = auth.begin_for(Some(invalid)).unwrap();
            assert!(
                lock(&auth.pending)
                    .get(&state)
                    .unwrap()
                    .return_request
                    .is_none()
            );
            assert_eq!(return_location(Some(invalid)), "/mcpmonitor/");
        }
    }

    #[tokio::test]
    async fn callback_rejects_missing_state_without_fetching_network() {
        let auth = OidcAuth::new(config()).unwrap();
        let (_, state) = auth.begin_for(Some("pending-123")).unwrap();
        assert!(auth.complete(&state, None, "test-code").await.is_err());
        assert!(
            auth.complete(&state, Some("wrong-state"), "test-code")
                .await
                .is_err()
        );
        assert!(auth.complete(&state, Some(&state), "").await.is_err());
    }

    #[test]
    fn cookies_are_scoped_to_mcpmonitor() {
        let auth = OidcAuth::new(config()).unwrap();
        let state = auth.state_cookie("state");
        let session = auth.session_cookie("session", 3600);
        assert!(state.contains("Path=/mcpmonitor/auth/"));
        assert!(session.contains("Path=/mcpmonitor/"));
        assert!(!session.contains("keys_remember"));
        assert_eq!(
            cookie_value("a=1; mcpmonitor_session=token; b=2", SESSION_COOKIE_NAME),
            Some("token")
        );
    }

    fn unsigned_test_token(iat: i64, exp: i64) -> String {
        let header = general_purpose::URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let payload = general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&serde_json::json!({"iat":iat,"exp":exp})).unwrap());
        format!("{header}.{payload}.signature")
    }

    #[test]
    fn push_session_binding_is_bounded_by_oidc_session_ttl_and_jwt_expiry() {
        let now = now_unix();
        let auth = OidcAuth::new(config()).unwrap();
        let ttl_limited = unsigned_test_token(now - 10, now + 7200);
        let (_, expires_at) = auth
            .session_binding(Some(&format!("{SESSION_COOKIE_NAME}={ttl_limited}")))
            .unwrap();
        assert_eq!(expires_at, now - 10 + 3600);

        let jwt_limited = unsigned_test_token(now - 10, now + 120);
        let (_, expires_at) = auth
            .session_binding(Some(&format!("{SESSION_COOKIE_NAME}={jwt_limited}")))
            .unwrap();
        assert_eq!(expires_at, now + 120);

        let expired = unsigned_test_token(now - 7200, now - 1);
        assert!(
            auth.session_binding(Some(&format!("{SESSION_COOKIE_NAME}={expired}")))
                .is_none()
        );
    }
}
