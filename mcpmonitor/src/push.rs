use crate::store::{PushSubscription, Store};
use anyhow::{Context, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs::File, path::PathBuf, sync::Arc};
use web_push::{
    ContentEncoding, IsahcWebPushClient, PartialVapidSignatureBuilder, SubscriptionInfo, Urgency,
    VapidSignatureBuilder, WebPushClient, WebPushError, WebPushMessageBuilder,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebPushConfig {
    pub private_key: PathBuf,
    pub subject: String,
}

impl WebPushConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            self.private_key.is_absolute(),
            "web_push.private_key must be absolute"
        );
        ensure!(
            self.private_key.is_file(),
            "web_push.private_key does not exist"
        );
        ensure!(
            self.subject.starts_with("mailto:") || self.subject.starts_with("https://"),
            "web_push.subject must use mailto: or https://"
        );
        Ok(())
    }
}

pub struct PushHub {
    store: Arc<Store>,
    client: Option<IsahcWebPushClient>,
    vapid: Option<PartialVapidSignatureBuilder>,
    public_key: Option<String>,
    subject: String,
}

impl PushHub {
    pub fn new(config: Option<&WebPushConfig>, store: Arc<Store>) -> anyhow::Result<Arc<Self>> {
        let Some(config) = config else {
            return Ok(Arc::new(Self {
                store,
                client: None,
                vapid: None,
                public_key: None,
                subject: String::new(),
            }));
        };
        config.validate()?;
        let file = File::open(&config.private_key)
            .with_context(|| format!("open {}", config.private_key.display()))?;
        let vapid = VapidSignatureBuilder::from_pem_no_sub(file)
            .map_err(|error| anyhow::anyhow!("parse VAPID key: {error}"))?;
        let public_key = URL_SAFE_NO_PAD.encode(vapid.get_public_key());
        let client = IsahcWebPushClient::new()
            .map_err(|error| anyhow::anyhow!("create Web Push client: {error}"))?;
        Ok(Arc::new(Self {
            store,
            client: Some(client),
            vapid: Some(vapid),
            public_key: Some(public_key),
            subject: config.subject.clone(),
        }))
    }

    pub fn public_key(&self) -> Option<&str> {
        self.public_key.as_deref()
    }

    pub async fn notify_user_input(&self, request: Value) {
        let id = request["id"].as_str().unwrap_or("");
        if id.is_empty() {
            return;
        }
        if request["terminal"].as_bool() == Some(true) {
            self.send_payload(
                json!({
                    "type":"user_input_resolved",
                    "id":id,
                    "status":request["status"],
                }),
                id,
                60,
                Urgency::Normal,
            )
            .await;
            return;
        }
        // Keep Web Push opaque. The service worker re-checks the browser's
        // current authenticated session and fetches the question only after
        // that succeeds, so a stale PushSubscription never receives question
        // text or a user-input capability.
        self.send_payload(
            json!({
                "type":"user_input",
                "id":id,
            }),
            id,
            15 * 60,
            Urgency::High,
        )
        .await;
    }

    async fn send_payload(&self, payload: Value, id: &str, ttl: u32, urgency: Urgency) {
        let (Some(client), Some(vapid)) = (&self.client, &self.vapid) else {
            return;
        };
        let store = Arc::clone(&self.store);
        let subscriptions = match tokio::task::spawn_blocking(move || store.push_subscriptions())
            .await
            .map_err(anyhow::Error::from)
            .and_then(|result| result)
        {
            Ok(subscriptions) => subscriptions,
            Err(error) => {
                tracing::warn!(%error, "load Web Push subscriptions failed");
                return;
            }
        };
        if subscriptions.is_empty() {
            return;
        }
        let bytes = match serde_json::to_vec(&payload) {
            Ok(bytes) if bytes.len() <= 3000 => bytes,
            Ok(_) => {
                tracing::warn!(request_id = id, "Web Push payload is too large");
                return;
            }
            Err(error) => {
                tracing::warn!(%error, "serialize Web Push payload failed");
                return;
            }
        };
        let topic = id.replace('-', "").chars().take(32).collect::<String>();
        for subscription in subscriptions {
            let info = SubscriptionInfo::new(
                subscription.endpoint.clone(),
                subscription.p256dh.clone(),
                subscription.auth.clone(),
            );
            let mut signature = vapid.clone().add_sub_info(&info);
            signature.add_claim("sub", self.subject.clone());
            let signature = match signature.build() {
                Ok(signature) => signature,
                Err(error) => {
                    tracing::warn!(%error, endpoint=%subscription.endpoint, "build VAPID signature failed");
                    continue;
                }
            };
            let mut builder = WebPushMessageBuilder::new(&info);
            builder.set_payload(ContentEncoding::Aes128Gcm, &bytes);
            builder.set_vapid_signature(signature);
            builder.set_ttl(ttl);
            builder.set_urgency(urgency);
            if !topic.is_empty() {
                builder.set_topic(topic.clone());
            }
            let message = match builder.build() {
                Ok(message) => message,
                Err(error) => {
                    tracing::warn!(%error, endpoint=%subscription.endpoint, "build Web Push message failed");
                    continue;
                }
            };
            match client.send(message).await {
                Ok(()) => {}
                Err(
                    error @ (WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)),
                ) => {
                    tracing::info!(%error, endpoint=%subscription.endpoint, "removing expired Web Push subscription");
                    let store = Arc::clone(&self.store);
                    let endpoint = subscription.endpoint.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        store.delete_push_subscription(&endpoint)
                    })
                    .await;
                }
                Err(error) => {
                    tracing::warn!(%error, endpoint=%subscription.endpoint, "Web Push send failed");
                }
            }
        }
    }

    pub async fn save_subscription(&self, subscription: PushSubscription) -> anyhow::Result<()> {
        ensure!(self.public_key.is_some(), "Web Push is disabled");
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.save_push_subscription(&subscription))
            .await
            .context("save push subscription worker failed")?
    }

    pub async fn delete_subscription(&self, endpoint: String) -> anyhow::Result<()> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.delete_push_subscription(&endpoint))
            .await
            .context("delete push subscription worker failed")?
    }

    pub async fn delete_auth_session(&self, auth_key: [u8; 32]) -> anyhow::Result<()> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.delete_push_subscriptions_for_auth(&auth_key))
            .await
            .context("delete push session subscriptions worker failed")?
    }
}
