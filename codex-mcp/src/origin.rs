use url::Url;

fn parse_origin(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

pub fn allowed(raw: &str, issuer: &str, rules: &[String]) -> bool {
    let Some(origin) = parse_origin(raw) else {
        return false;
    };
    std::iter::once(issuer)
        .chain(rules.iter().map(String::as_str))
        .any(|rule| {
            if let Some((scheme, host)) = rule.split_once("://*.") {
                let Some(base) = parse_origin(&format!("{scheme}://{host}")) else {
                    return false;
                };
                origin.scheme() == base.scheme()
                    && origin.port_or_known_default() == base.port_or_known_default()
                    && origin
                        .host_str()
                        .unwrap()
                        .strip_suffix(base.host_str().unwrap())
                        .is_some_and(|prefix| prefix.len() > 1 && prefix.ends_with('.'))
            } else {
                parse_origin(rule).is_some_and(|allowed| origin.origin() == allowed.origin())
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allows_configured_domain_and_subdomains() {
        let rules = vec![
            "https://aloofbuckle.cn".into(),
            "https://*.aloofbuckle.cn".into(),
            "https://*.aloofbuckle.cn:35000".into(),
        ];
        for origin in [
            "https://aloofbuckle.cn",
            "https://www.aloofbuckle.cn",
            "https://a.b.aloofbuckle.cn",
            "https://www.aloofbuckle.cn:443",
            "https://test.aloofbuckle.cn:35000",
        ] {
            assert!(
                allowed(origin, "https://www.aloofbuckle.cn", &rules),
                "{origin}"
            );
        }
        for origin in [
            "null",
            "http://www.aloofbuckle.cn",
            "https://badaloofbuckle.cn",
            "https://aloofbuckle.cn.evil.test",
            "https://evil.test/aloofbuckle.cn",
            "https://user@www.aloofbuckle.cn",
            "https://www.aloofbuckle.cn?x=1",
            "https://www.aloofbuckle.cn:1234",
        ] {
            assert!(
                !allowed(origin, "https://www.aloofbuckle.cn", &rules),
                "{origin}"
            );
        }
    }
}
