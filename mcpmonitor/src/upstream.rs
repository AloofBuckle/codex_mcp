//! HTTP-only adapter for the standalone codex-mcp /monitor/v2 protocol.
//! Replaces MWS's binary framed UDS transport; no MWS IPC crate is linked.
use anyhow::{Context, Result, ensure};

#[derive(Clone)]
pub struct Client {
    base: String,
    http: reqwest::Client,
}

pub fn header(name: &str, value: impl Into<String>) -> (String, String) {
    (name.to_owned(), value.into())
}

pub struct Response(reqwest::Response);

impl Response {
    pub fn status(&self) -> u16 {
        self.0.status().as_u16()
    }

    pub fn header(&self, name: &str) -> Option<&[u8]> {
        self.0.headers().get(name).map(|value| value.as_bytes())
    }

    pub async fn chunk(&mut self) -> reqwest::Result<Option<axum::body::Bytes>> {
        self.0.chunk().await
    }

    pub async fn bytes(self) -> reqwest::Result<axum::body::Bytes> {
        self.0.bytes().await
    }

    pub async fn json<T: serde::de::DeserializeOwned>(self) -> reqwest::Result<T> {
        self.0.json::<T>().await
    }
}

impl Client {
    pub fn new(base: &str) -> Result<Self> {
        let parsed = url::Url::parse(base).context("codex_http_url")?;
        ensure!(
            parsed.scheme() == "http"
                && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
                && parsed.path() == "/"
                && parsed.query().is_none()
                && parsed.fragment().is_none()
                && parsed.username().is_empty()
                && parsed.password().is_none(),
            "codex_http_url must be a loopback HTTP origin (no path, query or credentials)"
        );
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(3))
            .build()?;
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            http,
        })
    }

    pub async fn request(
        &self,
        method: &str,
        target: impl AsRef<str>,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<Response> {
        let target = target.as_ref();
        ensure!(
            target.starts_with("/monitor/v2/") && !target.contains("//") && !target.contains('#'),
            "unsupported upstream target"
        );
        let url = format!("{}{target}", self.base);
        let mut request = self.http.request(method.parse()?, url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        Ok(Response(request.body(body).send().await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_service_to_loopback() {
        assert!(Client::new("http://127.0.0.1:35121").is_ok());
        for base in [
            "http://8.8.8.8:443",
            "https://example.test",
            "http://localhost:42/path",
            "http://user@localhost:42",
            "unix:///tmp/mcp.sock",
        ] {
            assert!(Client::new(base).is_err(), "{base}");
        }
    }
}
