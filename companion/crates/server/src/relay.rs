//! The relay for endpoints that refuse browser origins (P1-T10, ADR-29).
//!
//! NVIDIA's API sends no CORS headers at all (measured 2026-09-14), so no page can read its
//! answers. The web app hands such calls to `POST|GET /relay` here, naming the real URL in
//! `x-lp-target`; this forwards the request and streams the answer back with CORS headers.
//!
//! What keeps it from being an open proxy on the user's machine:
//! - **Targets are an allowlist of exact origins and a path prefix**, compiled in. Nothing
//!   on the LAN, nothing the page names that is not on the list.
//! - **Pages are an allowlist of origins** (local dev, the hosted app, the Tauri webview).
//!   A request from any other page is refused before anything is forwarded.
//! - **It holds no key.** `Authorization` travels on each request, as it would directly, and
//!   only `authorization`, `content-type` and `accept` are forwarded. Nothing is logged.
//!
//! Cancellation is structural: when the page aborts, axum drops the response body, which
//! drops reqwest's stream, which closes the upstream connection.

use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use reqwest::Url;

/// The header naming the real URL. Matches `RELAY_TARGET_HEADER` in `packages/providers`.
pub const TARGET_HEADER: &str = "x-lp-target";

/// Request headers forwarded upstream. Everything else - cookies, the page's origin, the
/// target header itself - stays here.
const FORWARDED_REQUEST_HEADERS: [HeaderName; 3] =
    [header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT];

/// One allowed destination: an exact origin (`scheme://host[:port]`) and a path prefix.
#[derive(Debug, Clone)]
pub struct AllowedTarget {
    pub origin: String,
    pub path_prefix: String,
}

/// What the relay may reach, and the client it reaches it with.
#[derive(Debug, Clone)]
pub struct Relay {
    targets: Vec<AllowedTarget>,
    client: reqwest::Client,
}

impl Relay {
    /// The endpoints measured to refuse browser origins (`browserAccess` = `relay`).
    pub fn measured() -> Self {
        Self::with_targets(vec![AllowedTarget {
            origin: "https://integrate.api.nvidia.com".to_owned(),
            path_prefix: "/v1/".to_owned(),
        }])
    }

    pub fn with_targets(targets: Vec<AllowedTarget>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            // Redirects would let an allowed host send the key somewhere that is not.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("a client with no custom TLS or proxy settings builds");
        Self { targets, client }
    }

    /// The target, if it parses and is on the list. Userinfo, a different port or a host
    /// that merely starts with an allowed one are all refused.
    fn allowed(&self, raw: &str) -> Option<Url> {
        let url = Url::parse(raw).ok()?;
        if !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        let origin = url.origin().ascii_serialization();
        let path = url.path();
        self.targets
            .iter()
            .any(|target| target.origin == origin && path.starts_with(&target.path_prefix))
            .then_some(url)
    }
}

/// True for a page this companion answers: localhost on any port (the dev server moves),
/// the hosted app, and the Tauri webview on Windows and elsewhere.
pub fn page_origin_allowed(origin: &str) -> bool {
    if matches!(
        origin,
        "https://app.latentpresence.com"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "tauri://localhost"
    ) {
        return true;
    }
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    let host = match rest.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => rest,
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

fn text(status: StatusCode, message: &'static str) -> Response {
    (status, message).into_response()
}

/// CORS for the whole companion. A preflight from an allowed page is answered here; any
/// request carrying another page's origin is refused before it reaches a handler. A request
/// with no `Origin` (curl, the gate's own tests) passes: it is not a page, and CORS is a
/// browser's rule.
pub async fn cors(request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let Some(origin) = origin else {
        return next.run(request).await;
    };
    if !page_origin_allowed(&origin) {
        return text(StatusCode::FORBIDDEN, "origin not allowed");
    }
    let allow_origin = HeaderValue::from_str(&origin).expect("an allowed origin is ASCII");

    if request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("authorization, content-type, accept, x-lp-target"),
        );
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        // Chrome's Local Network Access asks this of the hosted app. Unverified until P8-T03.
        if request
            .headers()
            .get("access-control-request-private-network")
            .is_some_and(|value| value == "true")
        {
            headers.insert(
                "access-control-allow-private-network",
                HeaderValue::from_static("true"),
            );
        }
        return response;
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    response
}

/// `GET|POST /relay`: forward to `x-lp-target` if it is allowed, stream the answer back.
pub async fn relay(
    State(relay): State<Relay>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(raw) = headers
        .get(TARGET_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return text(StatusCode::BAD_REQUEST, "missing x-lp-target");
    };
    let Some(url) = relay.allowed(raw) else {
        return text(StatusCode::FORBIDDEN, "target not allowed");
    };
    if method != Method::GET && method != Method::POST {
        return text(StatusCode::METHOD_NOT_ALLOWED, "GET or POST only");
    }

    let mut upstream = relay.client.request(method.clone(), url);
    for name in &FORWARDED_REQUEST_HEADERS {
        if let Some(value) = headers.get(name) {
            upstream = upstream.header(name, value);
        }
    }
    if method == Method::POST {
        upstream = upstream.body(body);
    }

    let answer = match upstream.send().await {
        Ok(answer) => answer,
        // The error's text names the host and the failure, never a header.
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("relay could not reach the target: {error}"),
            )
                .into_response();
        }
    };

    let status = answer.status();
    let content_type = answer.headers().get(header::CONTENT_TYPE).cloned();
    let mut response = Response::new(Body::from_stream(answer.bytes_stream()));
    *response.status_mut() = status;
    if let Some(content_type) = content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_origins_are_local_the_hosted_app_or_tauri_and_nothing_that_looks_like_them() {
        for allowed in [
            "http://localhost:5173",
            "http://localhost",
            "http://127.0.0.1:4173",
            "http://[::1]:5173",
            "https://app.latentpresence.com",
            "http://tauri.localhost",
            "tauri://localhost",
        ] {
            assert!(page_origin_allowed(allowed), "{allowed}");
        }
        for refused in [
            "https://evil.example",
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example:80",
            "https://localhost:5173",
            "http://app.latentpresence.com",
            "https://app.latentpresence.com.evil.example",
            "http://localhost:abc",
            "null",
            "",
        ] {
            assert!(!page_origin_allowed(refused), "{refused}");
        }
    }

    #[test]
    fn targets_must_match_an_allowed_origin_and_path_exactly() {
        let relay = Relay::measured();
        assert!(
            relay
                .allowed("https://integrate.api.nvidia.com/v1/chat/completions")
                .is_some()
        );
        assert!(
            relay
                .allowed("https://integrate.api.nvidia.com/v1/models")
                .is_some()
        );
        for refused in [
            "http://integrate.api.nvidia.com/v1/models",
            "https://integrate.api.nvidia.com:8443/v1/models",
            "https://integrate.api.nvidia.com.evil.example/v1/models",
            "https://user:pass@integrate.api.nvidia.com/v1/models",
            "https://integrate.api.nvidia.com/admin",
            "https://integrate.api.nvidia.com/v1",
            "http://127.0.0.1:11434/v1/models",
            "http://192.168.1.1/v1/models",
            "not a url",
        ] {
            assert!(relay.allowed(refused).is_none(), "{refused}");
        }
    }
}
