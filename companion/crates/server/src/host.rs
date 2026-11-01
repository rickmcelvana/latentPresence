//! The `Host` a request names (P9-T03, ADR-69): an address, or `localhost`, and nothing else.
//!
//! **DNS rebinding.** A web site can make its own name resolve to `127.0.0.1` after its page has
//! loaded; the page's requests then reach this companion as *same-origin* requests to that name.
//! A same-origin `GET` carries no `Origin`, so the CORS layer and the pairing check, which both
//! read `Origin`, let it through — and the page can read the answer: her memory, the schedules,
//! the tools. Browsers that ask before a public site reaches this machine (ADR-64) stop most of
//! it; this stops all of it, whatever the browser.
//!
//! What the attack cannot change is the name in `Host`: it is the attacker's own, because that is
//! the name the browser resolved. Every page that really uses the companion names it by address
//! (`127.0.0.1:8787`, the desktop app's port) or as `localhost`, so a request naming anything
//! else is refused before any route sees it. An IP literal cannot be rebound.

use axum::{
    Router,
    extract::Request,
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};

/// The host part of a `Host` value or a URI authority, without its port or IPv6 brackets; `None`
/// when what follows the host is not a port (`[::1].evil.example`).
fn hostname(authority: &str) -> Option<&str> {
    let (host, port) = match authority.strip_prefix('[') {
        Some(rest) => {
            let (inside, after) = rest.split_once(']')?;
            (
                inside,
                if after.is_empty() {
                    None
                } else {
                    Some(after.strip_prefix(':')?)
                },
            )
        }
        None => match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    match port {
        Some(port) if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) => None,
        _ => Some(host),
    }
}

/// True for `localhost` and for an IP address, the names a rebinding site cannot use.
pub fn host_allowed(authority: &str) -> bool {
    hostname(authority.trim()).is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok()
    })
}

/// `router` with every request whose `Host` (or, over HTTP/2, authority) names anything but an
/// address or `localhost` refused, and one naming nothing refused too.
pub fn require_address_or_localhost(router: Router) -> Router {
    router.layer(middleware::from_fn(
        |request: Request, next: Next| async move {
            let named = request
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
                .or_else(|| {
                    request
                        .uri()
                        .authority()
                        .map(|authority| authority.as_str().to_owned())
                });
            if named.as_deref().is_some_and(host_allowed) {
                next.run(request).await
            } else {
                refused()
            }
        },
    ))
}

fn refused() -> Response {
    (
        StatusCode::MISDIRECTED_REQUEST,
        "this companion answers only requests to 127.0.0.1, [::1] or localhost",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    async fn status(host: Option<&str>) -> StatusCode {
        let app = require_address_or_localhost(
            Router::new().route("/db/facts", get(|| async { "her memory" })),
        );
        let mut request = Request::get("/db/facts");
        if let Some(host) = host {
            request = request.header("host", host);
        }
        app.oneshot(request.body(Body::empty()).expect("a request"))
            .await
            .expect("the router answers")
            .status()
    }

    #[tokio::test]
    async fn answers_a_request_naming_this_machine_by_address_or_as_localhost() {
        for host in [
            "127.0.0.1:8787",
            "localhost:8787",
            "LOCALHOST",
            "[::1]:8787",
            "192.168.40.12:8787",
            "127.0.0.1",
        ] {
            assert_eq!(status(Some(host)).await, StatusCode::OK, "{host}");
        }
    }

    #[tokio::test]
    async fn refuses_a_rebound_name_and_a_request_naming_nothing() {
        for host in [
            "evil.example:8787",
            "evil.example",
            "127.0.0.1.nip.io:8787",
            "localhost.evil.example",
            "[::1].evil.example",
        ] {
            assert_eq!(
                status(Some(host)).await,
                StatusCode::MISDIRECTED_REQUEST,
                "{host}"
            );
        }
        assert_eq!(status(None).await, StatusCode::MISDIRECTED_REQUEST);
    }

    #[test]
    fn reads_the_host_out_of_an_authority() {
        assert_eq!(hostname("127.0.0.1:8787"), Some("127.0.0.1"));
        assert_eq!(hostname("[::1]:8787"), Some("::1"));
        assert_eq!(hostname("[::1]"), Some("::1"));
        assert_eq!(hostname("localhost"), Some("localhost"));
        assert_eq!(hostname("[::1].evil.example"), None);
        assert_eq!(hostname("[::1]:"), None);
        assert_eq!(hostname("127.0.0.1:http"), None);
    }
}
