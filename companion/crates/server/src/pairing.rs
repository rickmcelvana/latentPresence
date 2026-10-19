//! The desktop app's pairing token (P8-T01, ADR-60).
//!
//! The origin allowlist (`relay::cors`) keeps other web sites off the companion, but it lets in
//! any page on `localhost` and the hosted app, and anything that sends no `Origin` at all — every
//! other program on the machine. The desktop app runs its companion with a token made fresh at
//! each launch and held only in its own memory; the webview is handed it through the shell, and
//! every request must carry it in `x-lp-companion-token`. Without it: 401, and nothing runs.
//!
//! A preflight passes untouched: browsers never send custom headers on one, and `relay::cors`,
//! outside this layer, answers it.
//!
//! The standalone binary (`pnpm companion`) answers pages on this machine as before, but **the
//! hosted app only with its pairing code** (P8-T03, ADR-64): a code kept in a file beside
//! `mcp.json`, printed at start, pasted once into the page. A browser's own permission for the
//! site to reach this machine is granted for Ollama too, so it is not the companion's consent.

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

/// The text the page reads to know it needs (or has the wrong) pairing code. Matches
/// `PAIRING_NEEDED` in `apps/web/src/settings/companion-pairing.ts`.
pub const PAIRING_NEEDED: &str = "pairing code needed";

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// 120 random bits as six groups of four (`K7QM-2XPA-…`): typed or pasted once.
pub fn new_code() -> String {
    let bytes: [u8; 15] = rand::random();
    let mut letters = String::with_capacity(29);
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            if !letters.is_empty() && (letters.len() + 1).is_multiple_of(5) {
                letters.push('-');
            }
            letters.push(BASE32[((buffer >> bits) & 31) as usize] as char);
        }
    }
    letters
}

/// A code as the person may have pasted it: any case, with or without its dashes and spaces.
pub fn normalise(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// The code in `path`, or a new one written there. A file that cannot be read or written leaves a
/// code for this run only (said in the error), so the hosted app is still never let in unpaired.
pub fn load_or_create_code(path: &std::path::Path) -> Result<String, (String, String)> {
    if let Ok(text) = std::fs::read_to_string(path) {
        let code = text.trim().to_owned();
        if normalise(&code).len() >= 16 {
            return Ok(code);
        }
    }
    let code = new_code();
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(path, format!("{code}\n")));
    match written {
        Ok(()) => Ok(code),
        Err(error) => Err((code, format!("{}: {error}", path.display()))),
    }
}

/// `router` with requests from a page that is not on this machine required to carry `code`.
/// Pages on this machine, requests with no `Origin` and preflights pass as before.
pub fn require_from_elsewhere(router: Router, code: &str) -> Router {
    let expected = std::sync::Arc::new(normalise(code));
    router.layer(middleware::from_fn(move |request: Request, next: Next| {
        let expected = expected.clone();
        async move {
            let from_elsewhere = request
                .headers()
                .get(axum::http::header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|origin| !crate::relay::page_origin_on_this_machine(origin));
            if request.method() == Method::OPTIONS || !from_elsewhere {
                return next.run(request).await;
            }
            let given = request
                .headers()
                .get(TOKEN_HEADER)
                .and_then(|value| value.to_str().ok())
                .map(normalise);
            if given.is_some_and(|given| same(given.as_bytes(), expected.as_bytes())) {
                next.run(request).await
            } else {
                (StatusCode::UNAUTHORIZED, PAIRING_NEEDED).into_response()
            }
        }
    }))
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

    fn from_elsewhere() -> Router {
        crate::with_cors(require_from_elsewhere(
            Router::new().route("/health", get(|| async { "ok" })),
            "ABCD-EFGH-2345-6723-QRST-WXYZ",
        ))
    }

    async fn answer(origin: Option<&str>, code: Option<&str>) -> (StatusCode, String) {
        let mut request = Request::get("/health");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        if let Some(code) = code {
            request = request.header(TOKEN_HEADER, code);
        }
        let response = from_elsewhere()
            .oneshot(request.body(Body::empty()).expect("a request"))
            .await
            .expect("the router answers");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .expect("a body");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn the_hosted_app_needs_the_code_and_this_machine_does_not() {
        let hosted = Some("https://app.latentpresence.com");
        assert_eq!(
            answer(hosted, None).await,
            (StatusCode::UNAUTHORIZED, PAIRING_NEEDED.to_owned())
        );
        assert_eq!(
            answer(hosted, Some("ABCD-EFGH-2345-6723-QRST-WXYA"))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        // However it was pasted.
        for code in [
            "ABCD-EFGH-2345-6723-QRST-WXYZ",
            "abcdefgh23456723qrstwxyz",
            " abcd efgh 2345 6723 qrst wxyz ",
        ] {
            assert_eq!(answer(hosted, Some(code)).await.0, StatusCode::OK, "{code}");
        }
        for here in [
            None,
            Some("http://localhost:5173"),
            Some("http://127.0.0.1:4173"),
            Some("http://tauri.localhost"),
        ] {
            assert_eq!(answer(here, None).await.0, StatusCode::OK, "{here:?}");
        }
        // Any other site is still refused by CORS before the code is asked.
        assert_eq!(
            answer(
                Some("https://evil.example"),
                Some("ABCDEFGH23456723QRSTWXYZ")
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn a_code_is_six_groups_of_four_kept_in_its_file() {
        let code = new_code();
        assert_eq!(code.len(), 29, "{code}");
        assert!(code.split('-').all(|group| group.len() == 4));
        assert_eq!(normalise(&code).len(), 24);
        assert_ne!(code, new_code());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deeper").join("pairing-code.txt");
        let first = load_or_create_code(&path).unwrap();
        assert_eq!(load_or_create_code(&path).unwrap(), first);
        std::fs::write(&path, "short\n").unwrap();
        assert_ne!(load_or_create_code(&path).unwrap(), "short");
    }

    #[test]
    fn a_new_token_is_64_hex_characters_and_not_repeated() {
        let first = new_token();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, new_token());
    }
}
