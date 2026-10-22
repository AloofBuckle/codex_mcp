use axum::http::{HeaderMap, header::SEC_WEBSOCKET_PROTOCOL};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

pub const WS_PROTOCOL: &str = "mcpmonitor-widget-v1";
const WS_TOKEN_PREFIX: &str = "mcpmonitor-widget-token.";
const MAX_TOKEN_BYTES: usize = 4096;
const MAX_LIFETIME_SECS: u64 = 2 * 60 * 60 + 60;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    v: u8,
    iat: u64,
    exp: u64,
    nonce: String,
    scopes: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut normalized = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        normalized[..digest.len()].copy_from_slice(&digest);
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36u8; BLOCK];
    let mut outer_pad = [0x5cu8; BLOCK];
    for index in 0..BLOCK {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    outer.finalize().into()
}

pub fn verify(token: &str, secret: &str, required_scope: &str) -> bool {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES || secret.len() < 32 {
        return false;
    }
    let mut parts = token.split('.');
    let (Some(version), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if version != "v1" {
        return false;
    }
    let unsigned = format!("{version}.{payload}");
    let expected = hmac_sha256(secret.as_bytes(), unsigned.as_bytes());
    let Ok(provided) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    if provided.len() != expected.len()
        || !bool::from(provided.as_slice().ct_eq(expected.as_slice()))
    {
        return false;
    }
    let Ok(payload) = URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let Ok(claims) = serde_json::from_slice::<Claims>(&payload) else {
        return false;
    };
    let current = now();
    if claims.v != 1
        || claims.nonce.len() < 8
        || claims.iat > current.saturating_add(60)
        || claims.exp <= current
        || claims.exp <= claims.iat
        || claims.exp.saturating_sub(claims.iat) > MAX_LIFETIME_SECS
    {
        return false;
    }
    claims.scopes.iter().any(|scope| scope == required_scope)
}

pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get("authorization")?.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub fn authenticated(headers: &HeaderMap, secret: &str, scope: &str) -> bool {
    bearer(headers).is_some_and(|token| verify(token, secret, scope))
}

pub fn websocket_token(headers: &HeaderMap) -> Option<&str> {
    let protocols = headers.get(SEC_WEBSOCKET_PROTOCOL)?.to_str().ok()?;
    protocols
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix(WS_TOKEN_PREFIX))
        .filter(|token| !token.is_empty())
}

pub fn websocket_authenticated(headers: &HeaderMap, secret: &str, scope: &str) -> bool {
    websocket_token(headers).is_some_and(|token| verify(token, secret, scope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token(secret: &str, scope: &str, issued_at: u64, expires_at: u64) -> String {
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "v": 1,
                "iat": issued_at,
                "exp": expires_at,
                "nonce": "abcdefgh1234",
                "scopes": [scope]
            }))
            .unwrap(),
        );
        let unsigned = format!("v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(hmac_sha256(secret.as_bytes(), unsigned.as_bytes()));
        format!("{unsigned}.{signature}")
    }

    #[test]
    fn accepts_current_scoped_capability_and_rejects_wrong_scope_or_signature() {
        let secret = "0123456789012345678901234567890123456789";
        let current = now();
        let valid = token(secret, "browser", current - 1, current + 60);
        assert!(verify(&valid, secret, "browser"));
        assert!(!verify(&valid, secret, "native"));
        let mut tampered = valid.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        assert!(!verify(
            std::str::from_utf8(&tampered).unwrap(),
            secret,
            "browser"
        ));
    }

    #[test]
    fn rejects_expired_and_excessive_lifetime_tokens() {
        let secret = "0123456789012345678901234567890123456789";
        let current = now();
        assert!(!verify(
            &token(secret, "browser", current - 120, current - 1),
            secret,
            "browser"
        ));
        assert!(!verify(
            &token(secret, "browser", current, current + MAX_LIFETIME_SECS + 1),
            secret,
            "browser"
        ));
    }
}
