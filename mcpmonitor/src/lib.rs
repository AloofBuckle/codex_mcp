//! Independent MCP Monitor HTTP service; no Pingora or UDS IPC dependencies.
mod access;
mod hub;
mod oidc;
mod push;
mod store;
mod upstream;
mod web;
mod widget_auth;
use anyhow::{Context, ensure};
use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

fn codex_http_url() -> String {
    "http://127.0.0.1:35121".to_owned()
}
fn secure() -> bool {
    true
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub public_origin: String,
    #[serde(default = "codex_http_url")]
    pub codex_http_url: String,
    pub upstream_token_file: PathBuf,
    pub oidc_config: PathBuf,
    #[serde(default = "secure")]
    pub secure_cookie: bool,
    pub database: PathBuf,
    /// Optional browser GUI websocket (loopback WS). Omit when not installed.
    #[serde(default)]
    pub browser_ws_url: Option<String>,
    #[serde(default)]
    pub browser_token_file: Option<PathBuf>,
    /// Optional standalone native-live loopback HTTP origin (GET /health, POST /dc).
    #[serde(default)]
    pub native_live_url: Option<String>,
    #[serde(default)]
    pub native_user_input_token_file: Option<PathBuf>,
    #[serde(default)]
    pub web_push: Option<push::WebPushConfig>,
}

pub struct App {
    pub config: Config,
    pub hub: Arc<hub::Hub>,
    pub store: Arc<store::Store>,
    pub oidc: Option<oidc::OidcAuth>,
    pub upstream_token: String,
    pub codex_rpc: upstream::Client,
    pub local_http: reqwest::Client,
    pub user_input_widget_key: String,
    pub native_user_input_token: Option<String>,
    pub push: Arc<push::PushHub>,
    pub browser_token: String,
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

pub struct ControlPlane {
    router: Router,
    app: Arc<App>,
}
impl ControlPlane {
    pub fn router(&self) -> Router {
        self.router.clone()
    }
    pub fn app(&self) -> Arc<App> {
        Arc::clone(&self.app)
    }
}
impl Drop for ControlPlane {
    fn drop(&mut self) {
        self.app.shutdown.send_replace(true);
    }
}

/// Build the standalone HTTP control plane, loading config and persistent history.
pub async fn build_control_plane(config_path: impl AsRef<Path>) -> anyhow::Result<ControlPlane> {
    let mut config: Config = serde_json::from_slice(&tokio::fs::read(config_path).await?)?;
    config.public_origin = config.public_origin.trim_end_matches('/').to_owned();
    let public = url::Url::parse(&config.public_origin)?;
    ensure!(
        public.path() == "/"
            && public.query().is_none()
            && public.fragment().is_none()
            && public.username().is_empty()
            && public.password().is_none(),
        "public_origin must be an origin"
    );
    ensure!(
        public.scheme() == "https"
            || (!config.secure_cookie
                && public.scheme() == "http"
                && matches!(public.host_str(), Some("127.0.0.1" | "localhost" | "::1"))),
        "HTTPS required except explicit loopback development"
    );
    ensure!(
        config.database.is_absolute(),
        "database must be an absolute path"
    );
    ensure!(
        config.upstream_token_file.is_absolute(),
        "upstream_token_file must be absolute"
    );
    ensure!(
        config.oidc_config.is_absolute(),
        "oidc_config must be absolute"
    );
    if let Some(url) = &config.browser_ws_url {
        let parsed = url::Url::parse(url)?;
        ensure!(
            parsed.scheme() == "ws"
                && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.query().is_none()
                && parsed.fragment().is_none(),
            "browser_ws_url must be loopback ws:// without credentials"
        );
        ensure!(
            config.browser_token_file.is_some(),
            "browser_token_file required with browser_ws_url"
        );
    }
    if let Some(url) = &config.native_live_url {
        let parsed = url::Url::parse(url)?;
        ensure!(
            parsed.scheme() == "http"
                && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
                && parsed.path() == "/"
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.query().is_none()
                && parsed.fragment().is_none(),
            "native_live_url must be a loopback HTTP origin"
        );
    }
    let token = tokio::fs::read_to_string(&config.upstream_token_file).await?;
    ensure!(
        token.trim().len() >= 32,
        "upstream observation token is too short"
    );
    let browser_token = match &config.browser_token_file {
        Some(path) => {
            ensure!(path.is_absolute(), "browser_token_file must be absolute");
            let token = tokio::fs::read_to_string(path).await?;
            ensure!(token.trim().len() >= 32, "browser GUI token is too short");
            token.trim().to_owned()
        }
        None => String::new(),
    };
    let native_user_input_token = match &config.native_user_input_token_file {
        Some(path) => {
            ensure!(
                path.is_absolute(),
                "native_user_input_token_file must be absolute"
            );
            let token = tokio::fs::read_to_string(path).await?;
            let token = token.trim().to_owned();
            ensure!(
                token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "native user-input token must contain 64 hexadecimal characters"
            );
            Some(token)
        }
        None => None,
    };
    let oidc_config = config.oidc_config.clone();
    let oidc =
        tokio::task::spawn_blocking(move || oidc::OidcAuth::from_path(oidc_config)).await??;
    ensure!(
        oidc.redirect_uri() == format!("{}/mcpmonitor/auth/callback", config.public_origin),
        "OIDC redirect_uri must match public_origin and /mcpmonitor/auth/callback"
    );
    ensure!(
        oidc.secure_cookie() == config.secure_cookie,
        "OIDC secure_cookie must match monitor secure_cookie"
    );
    let db_path = config.database.clone();
    let store = tokio::task::spawn_blocking(move || store::Store::open(&db_path)).await??;
    let push_config = config.web_push.clone();
    let push_store = store.clone();
    let push =
        tokio::task::spawn_blocking(move || push::PushHub::new(push_config.as_ref(), push_store))
            .await??;
    let upstream_token = token.trim().to_owned();
    let user_input_widget_key = user_input_widget_key(&upstream_token);
    let codex_rpc = upstream::Client::new(&config.codex_http_url).context("codex upstream URL")?;
    let hub = hub::Hub::start(
        &config,
        upstream_token.clone(),
        store.clone(),
        push.clone(),
        codex_rpc.clone(),
    )?;
    let local_http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()?;
    let (shutdown, _) = tokio::sync::watch::channel(false);
    let app = Arc::new(App {
        config,
        hub,
        store,
        oidc: Some(oidc),
        upstream_token,
        codex_rpc,
        local_http,
        user_input_widget_key,
        native_user_input_token,
        push,
        browser_token,
        shutdown,
    });
    Ok(ControlPlane {
        router: build_router(app.clone()),
        app,
    })
}

fn build_router(app: Arc<App>) -> Router {
    Router::new()
        .route("/", get(web::root))
        .route("/mcpmonitor", get(web::root))
        .route("/mcpmonitor/", get(web::index))
        .route("/mcpmonitor/app.css", get(web::css))
        .route("/mcpmonitor/app.js", get(web::js))
        .route("/mcpmonitor/sw.js", get(web::service_worker))
        .route("/mcpmonitor/widget", get(web::widget_root))
        .route("/mcpmonitor/widget/", get(web::widget_index))
        .route("/mcpmonitor/widget/widget.css", get(web::widget_css))
        .route("/mcpmonitor/widget/widget.js", get(web::widget_js))
        .route("/mcpmonitor/codex-pointer.png", get(web::codex_pointer_png))
        .route("/mcpmonitor/codex-pointer.svg", get(web::codex_pointer_svg))
        .route("/mcpmonitor/auth/logout", post(access::logout))
        .route("/mcpmonitor/auth/start", get(access::oidc_start))
        .route("/mcpmonitor/auth/callback", get(access::oidc_callback))
        .route("/mcpmonitor/auth/mobile", get(access::mobile_session))
        .route("/mcpmonitor/api/me", get(access::me))
        .route("/mcpmonitor/api/events", get(web::events))
        .route("/mcpmonitor/api/status", get(web::status))
        .route("/mcpmonitor/api/calls", get(web::call_list))
        .route("/mcpmonitor/api/calls/{id}", get(web::call_detail))
        .route("/mcpmonitor/api/push/key", get(web::push_key))
        .route(
            "/mcpmonitor/api/push/subscription",
            post(web::push_subscription).delete(web::delete_push_subscription),
        )
        .route(
            "/mcpmonitor/api/user-input/{id}",
            get(web::user_input_detail),
        )
        .route(
            "/mcpmonitor/api/user-input/{id}/opened",
            post(web::user_input_opened),
        )
        .route(
            "/mcpmonitor/api/user-input/{id}/answer",
            post(web::user_input_answer),
        )
        .route(
            "/mcpmonitor/api/video-telemetry",
            post(web::video_telemetry),
        )
        .route("/mcpmonitor/browser/ws", get(web::browser_ws))
        .route("/mcpmonitor/browser/restart", post(web::browser_restart))
        .route("/mcpmonitor/browser/video/dc", post(web::video_dc_offer))
        .route("/mcpmonitor/browser/audio/rtc", post(web::audio_rtc_offer))
        .route("/mcpmonitor/browser/video/health", get(web::media_health))
        .route("/mcpmonitor/native/health", get(web::native_live_health))
        .route(
            "/mcpmonitor/native/restart",
            post(web::native_desktop_restart),
        )
        .route("/mcpmonitor/native/dc", post(web::native_live_dc_offer))
        .route(
            "/mcpmonitor/native/user-input/ws",
            get(web::native_user_input_ws),
        )
        .route("/mcpmonitor/widget/browser/ws", get(web::widget_browser_ws))
        .route(
            "/mcpmonitor/widget/browser/video/dc",
            post(web::widget_video_dc_offer),
        )
        .route(
            "/mcpmonitor/widget/native/health",
            get(web::widget_native_live_health),
        )
        .route(
            "/mcpmonitor/widget/native/dc",
            post(web::widget_native_live_dc_offer),
        )
        .route(
            "/mcpmonitor/widget/user-input/bind",
            post(web::widget_user_input_bind).options(web::widget_user_input_options),
        )
        .route(
            "/mcpmonitor/widget/user-input/api/{id}",
            get(web::widget_user_input_detail).options(web::widget_user_input_options),
        )
        .route(
            "/mcpmonitor/widget/user-input/api/{id}/opened",
            post(web::widget_user_input_opened).options(web::widget_user_input_options),
        )
        .route(
            "/mcpmonitor/widget/user-input/api/{id}/answer",
            post(web::widget_user_input_answer).options(web::widget_user_input_options),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&app),
            web::guard,
        ))
        .with_state(app)
}
fn user_input_widget_key(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let token_hash = Sha256::digest(token.as_bytes());
    let mut hasher = Sha256::new();
    hasher.update(b"mws-user-input-widget-v1\0");
    hasher.update(token_hash);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
