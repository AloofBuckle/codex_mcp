use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (
                Regex::new(r#"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+"#)
                    .expect("valid authorization regex"),
                "$1<redacted>",
            ),
            (
                Regex::new(
                    r#"(?i)((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)"#,
                )
                .expect("valid assignment regex"),
                "$1<redacted>",
            ),
            (
                Regex::new(
                    r"(?i)((?:--password|--passwd|--token|--secret|--api-key)\s+)[^\s]+",
                )
                .expect("valid argument regex"),
                "$1<redacted>",
            ),
            (
                Regex::new(r#"(?i)(\s-[pP]\s+)(?:'[^']*'|"[^"]*"|[^\s]+)"#)
                    .expect("valid short password argument regex"),
                "$1<redacted>",
            ),
            (
                Regex::new(r"(?i)(https?://[^\s/:@]+:)[^\s/@]+(@)")
                    .expect("valid URL credential regex"),
                "$1<redacted>$2",
            ),
            (
                Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("valid AWS key regex"),
                "<redacted-key>",
            ),
            (
                Regex::new(r"\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b")
                    .expect("valid common token regex"),
                "<redacted-token>",
            ),
            (
                Regex::new(
                    r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
                )
                .expect("valid JWT regex"),
                "<redacted-jwt>",
            ),
        ]
    })
}

pub fn text(input: &str) -> String {
    let mut output = input.to_owned();
    for (pattern, replacement) in patterns() {
        output = pattern.replace_all(&output, *replacement).into_owned();
    }
    output
}

pub fn value(mut frame: Value) -> Value {
    redact_value(&mut frame, None);
    frame
}

fn redact_value(value: &mut Value, key: Option<&str>) {
    if key.is_some_and(is_sensitive_key) {
        if !value.is_null() {
            *value = Value::String("<redacted>".to_owned());
        }
        return;
    }

    match value {
        Value::String(item) => *item = text(item),
        Value::Array(items) => {
            for item in items {
                redact_value(item, None);
            }
        }
        Value::Object(items) => {
            for (name, item) in items {
                redact_value(item, Some(name));
            }
        }
        _ => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "authorization",
        "password",
        "passwd",
        "token",
        "secret",
        "api_key",
        "api-key",
        "credential",
    ]
    .iter()
    .any(|needle| normalized == *needle || normalized.ends_with(&format!("_{needle}")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn redacts_command_credentials() {
        let input = "curl -H 'Authorization: Bearer abc123' --token xyz password=hunter2; tool -p 'short-secret'; curl https://user:url-secret@example.test";
        let output = text(input);
        assert!(!output.contains("abc123"));
        assert!(!output.contains("xyz"));
        assert!(!output.contains("hunter2"));
        assert!(!output.contains("short-secret"));
        assert!(!output.contains("url-secret"));
        assert!(output.contains("<redacted>"));
    }

    #[test]
    fn redacts_sensitive_keys() {
        let frame = json!({
            "event": {
                "input": {"token": "do-not-emit"},
                "output": {"text": "token=still-secret"},
                "command": "echo password=hidden"
            }
        });
        let rendered = value(frame).to_string();
        assert!(!rendered.contains("do-not-emit"));
        assert!(!rendered.contains("still-secret"));
        assert!(!rendered.contains("hidden"));
    }
}
