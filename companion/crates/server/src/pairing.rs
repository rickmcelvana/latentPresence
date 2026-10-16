//! The desktop app's pairing token (P8-T01, ADR-60).
//!
//! The origin allowlist (`relay::cors`) keeps other web sites off the companion, but it lets in
//! any page on `localhost` and the hosted app, and anything that sends no `Origin` at all — every
//! other program on the machine. The desktop app runs its companion with a token made fresh at
//! each launch and held only in its own memory; the webview is handed it through the shell, and
//! every request must carry it in `x-lp-companion-token`. Without it: 401, and nothing runs.
//!
//! A preflight passes untouched: browsers never send custom headers on one, and `relay::cors`,
//! outside this layer, answers it. The standalone binary (`pnpm companion`) runs unpaired, as
//! before.

use axum::{
    Router,
    extract::Request,
    http::{HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};

/// The header every request to a paired companion carries. Matches `COMPANION_TOKEN_HEADER` in
/// `apps/web/src/desktop/desktop.ts`.
pub const TOKEN_HEADER: &str = "x-lp-companion-token";

/// 32 random bytes from the OS, as hex.
pub fn new_token() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// True when the two are equal, taking as long whatever the first differing byte.
fn same(given: &[u8], expected: &[u8]) -> bool {
    if given.len() != expected.len() {
        return false;
    }
    given
        .iter()
        .zip(expected)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// `router` with every request but a preflight required to carry `token`.
pub fn require(router: Router, token: String) -> Router {
    let expected = std::sync::Arc::new(token);
    router.layer(middleware::from_fn(move |request: Request, next: Next| {
        let expected = expected.clone();
        async move {
            if request.method() == Method::OPTIONS {
                return next.run(request).await;
            }
            let given = request
                .headers()
                .get(TOKEN_HEADER)
                .map(HeaderValue::as_bytes);
            if given.is_some_and(|given| same(given, expected.as_bytes())) {
                next.run(request).await
            } else {
                unpaired()
            }
        }
    }))
}

fn unpaired() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        "this companion belongs to the latentPresence app and answers only it",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use tower::ServiceExt;

    fn paired() -> Router {
        crate::with_cors(require(
            Router::new().route("/health", get(|| async { "ok" })),
            "s3cret".to_owned(),
        ))
    }

    async fn status(request: Request<Body>) -> (StatusCode, Option<String>) {
        let response = paired().oneshot(request).await.expect("the router answers");
        let allow = response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        (response.status(), allow)
    }

    #[tokio::test]
    async fn answers_only_a_request_carrying_the_token() {
        let with = Request::get("/health")
            .header(TOKEN_HEADER, "s3cret")
            .body(Body::empty())
            .expect("a request");
        assert_eq!(status(with).await.0, StatusCode::OK);

        for token in [None, Some("s3cre"), Some("s3cret!"), Some("S3CRET")] {
            let mut request = Request::get("/health");
            if let Some(token) = token {
                request = request.header(TOKEN_HEADER, token);
            }
            let request = request.body(Body::empty()).expect("a request");
            assert_eq!(
                status(request).await.0,
                StatusCode::UNAUTHORIZED,
                "{token:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_page_without_the_token_is_told_so_in_a_response_it_can_read() {
        // Inside CORS, so the webview sees 401 rather than a network error.
        let request = Request::get("/health")
            .header("origin", "http://tauri.localhost")
            .body(Body::empty())
            .expect("a request");
        assert_eq!(
            status(request).await,
            (
                StatusCode::UNAUTHORIZED,
                Some("http://tauri.localhost".to_owned())
            )
        );
    }

    #[tokio::test]
    async fn a_preflight_needs_no_token_and_allows_the_header() {
        let request = Request::builder()
            .method(Method::OPTIONS)
            .uri("/health")
            .header("origin", "http://tauri.localhost")
            .header("access-control-request-method", "GET")
            .header("access-control-request-headers", TOKEN_HEADER)
            .body(Body::empty())
            .expect("a request");
        let response = paired().oneshot(request).await.expect("the router answers");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let allowed = response
            .headers()
            .get("access-control-allow-headers")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(allowed.contains(TOKEN_HEADER), "{allowed}");
    }

    #[test]
    fn a_new_token_is_64_hex_characters_and_not_repeated() {
        let first = new_token();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, new_token());
    }
}
