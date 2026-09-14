//! latentPresence companion.
//!
//! Optional local service: MariaDB vector memory (P0-T06), document ingest and MCP
//! tools land later. It answers `/health` so the web app, the gate and CI have something
//! real to talk to, and `/relay` for endpoints that refuse browser origins (ADR-29).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::{Json, Router, middleware, routing::get};
use serde::Serialize;

mod bench;
mod db;
mod relay;
mod vector;

const DEFAULT_PORT: u16 = 8787;

/// Matches `HealthResponseSchema` in `packages/protocol`. The browser parses this
/// answer to decide a companion is present and what it can do, so the two move together.
#[derive(Debug, Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    database: DatabaseHealth,
}

#[derive(Debug, Serialize)]
struct DatabaseHealth {
    /// `mariadb`, `sqlite` or `none`. Nothing is wired until P0-T06.
    kind: &'static str,
    connected: bool,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        service: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        database: DatabaseHealth {
            kind: "none",
            connected: false,
        },
    })
}

/// The whole HTTP surface, built without binding a socket so tests can call it.
fn router() -> Router {
    router_with(relay::Relay::measured())
}

/// The same surface with a chosen relay allowlist, so tests can point it at a local upstream.
fn router_with(relay: relay::Relay) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/relay", get(relay::relay).post(relay::relay))
        .with_state(relay)
        .layer(middleware::from_fn(relay::cors))
}

/// Bind address from `COMPANION_HOST` and `COMPANION_PORT`, loopback by default.
/// Unparseable values fall back rather than failing the process; the address that
/// was actually used is printed at startup.
fn resolve_address(host: Option<&str>, port: Option<&str>) -> SocketAddr {
    let host = host
        .and_then(|value| value.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let port = port
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    SocketAddr::new(host, port)
}

fn bind_address() -> SocketAddr {
    let host = std::env::var("COMPANION_HOST").ok();
    let port = std::env::var("COMPANION_PORT").ok();
    resolve_address(host.as_deref(), port.as_deref())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `bench` is P0-T06's measurement run, not part of serving. It is a subcommand rather
    // than a second binary so it shares the pool, the migrations and the encoding the
    // product actually uses - a benchmark against a copy of the code measures the copy.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("bench") {
        let rows = args
            .get(2)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(100_000);
        return bench::run(rows).await;
    }

    let address = bind_address();
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("latentpresence-companion listening on http://{address}");
    axum::serve(listener, router()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// A local stand-in for an upstream API: echoes what reached it, and streams forever
    /// on `/v1/stream`, reporting when that stream is dropped (the connection closed).
    async fn upstream() -> (
        String,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        tokio::sync::mpsc::UnboundedReceiver<()>,
    ) {
        use axum::http::HeaderMap;
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct DropSignal(tokio::sync::mpsc::UnboundedSender<()>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }

        let hits = std::sync::Arc::new(AtomicUsize::new(0));
        let (dropped_tx, dropped_rx) = tokio::sync::mpsc::unbounded_channel();
        let echo_hits = hits.clone();
        let stream_hits = hits.clone();
        let app = Router::new()
            .route(
                "/v1/echo",
                axum::routing::post(move |headers: HeaderMap, body: String| {
                    echo_hits.fetch_add(1, Ordering::SeqCst);
                    let seen = serde_json::json!({
                        "authorization": headers.get("authorization").and_then(|v| v.to_str().ok()),
                        "cookie": headers.contains_key("cookie"),
                        "origin": headers.contains_key("origin"),
                        "target": headers.contains_key(relay::TARGET_HEADER),
                        "body": body,
                    });
                    async move {
                        (
                            StatusCode::CREATED,
                            [
                                ("content-type", "application/json"),
                                ("x-upstream-secret", "no"),
                            ],
                            seen.to_string(),
                        )
                    }
                }),
            )
            .route(
                "/v1/redirect",
                get(|| async {
                    (
                        StatusCode::TEMPORARY_REDIRECT,
                        [("location", "https://elsewhere.example/steal")],
                    )
                }),
            )
            .route(
                "/v1/stream",
                get(move || {
                    stream_hits.fetch_add(1, Ordering::SeqCst);
                    let guard = DropSignal(dropped_tx.clone());
                    let ticks = futures_util::stream::unfold(guard, |guard| async move {
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        Some((Ok::<_, std::convert::Infallible>("data: tick\n\n"), guard))
                    });
                    async move {
                        (
                            [("content-type", "text/event-stream")],
                            Body::from_stream(ticks),
                        )
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream binds");
        let address = listener.local_addr().expect("upstream has an address");
        tokio::spawn(async move { axum::serve(listener, app).await });
        (format!("http://{address}"), hits, dropped_rx)
    }

    fn local_relay(origin: &str) -> Router {
        router_with(relay::Relay::with_targets(vec![relay::AllowedTarget {
            origin: origin.to_owned(),
            path_prefix: "/v1/".to_owned(),
        }]))
    }

    #[tokio::test]
    async fn a_page_on_an_allowed_origin_can_read_health_and_any_other_page_is_refused() {
        let allowed = Request::builder()
            .uri("/health")
            .header("origin", "http://localhost:5173")
            .body(Body::empty())
            .expect("request builds");
        let response = router().oneshot(allowed).await.expect("router answers");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "http://localhost:5173"
        );

        let refused = Request::builder()
            .uri("/health")
            .header("origin", "https://evil.example")
            .body(Body::empty())
            .expect("request builds");
        let response = router().oneshot(refused).await.expect("router answers");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(
            !response
                .headers()
                .contains_key("access-control-allow-origin")
        );
    }

    #[tokio::test]
    async fn a_relay_preflight_allows_the_headers_the_providers_send() {
        let preflight = Request::builder()
            .method("OPTIONS")
            .uri("/relay")
            .header("origin", "https://app.latentpresence.com")
            .header("access-control-request-method", "POST")
            .header(
                "access-control-request-headers",
                "authorization,content-type,x-lp-target",
            )
            .header("access-control-request-private-network", "true")
            .body(Body::empty())
            .expect("request builds");
        let response = router().oneshot(preflight).await.expect("router answers");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let headers = response.headers();
        assert_eq!(
            headers["access-control-allow-origin"],
            "https://app.latentpresence.com"
        );
        let allowed = headers["access-control-allow-headers"]
            .to_str()
            .expect("ascii");
        for name in ["authorization", "content-type", "x-lp-target"] {
            assert!(allowed.contains(name), "{name} in {allowed}");
        }
        assert!(
            headers["access-control-allow-methods"]
                .to_str()
                .expect("ascii")
                .contains("POST")
        );
        assert_eq!(headers["access-control-allow-private-network"], "true");
    }

    #[tokio::test]
    async fn the_relay_forwards_the_key_and_body_and_nothing_else_and_streams_the_answer_back() {
        let (base, hits, _dropped) = upstream().await;
        let request = Request::builder()
            .method("POST")
            .uri("/relay")
            .header("origin", "http://localhost:5173")
            .header(relay::TARGET_HEADER, format!("{base}/v1/echo"))
            .header("authorization", "Bearer test-key")
            .header("content-type", "application/json")
            .header("cookie", "session=nope")
            .body(Body::from(r#"{"model":"m"}"#))
            .expect("request builds");
        let response = local_relay(&base)
            .oneshot(request)
            .await
            .expect("router answers");

        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()["content-type"], "application/json");
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "http://localhost:5173"
        );
        // Upstream response headers other than the content type stay upstream.
        assert!(!response.headers().contains_key("x-upstream-secret"));
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let seen: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(seen["authorization"], "Bearer test-key");
        assert_eq!(seen["cookie"], false);
        assert_eq!(seen["origin"], false);
        assert_eq!(seen["target"], false);
        assert_eq!(seen["body"], r#"{"model":"m"}"#);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_target_off_the_list_is_refused_without_contacting_anything() {
        let (base, hits, _dropped) = upstream().await;
        // `router()` allows only NVIDIA, so the local upstream is off its list.
        for target in [
            format!("{base}/v1/echo"),
            "https://integrate.api.nvidia.com.evil.example/v1/models".to_owned(),
            "https://integrate.api.nvidia.com/v1/../admin".to_owned(),
            "https://integrate.api.nvidia.com/v1/%2e%2e/admin".to_owned(),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri("/relay")
                .header(relay::TARGET_HEADER, &target)
                .body(Body::empty())
                .expect("request builds");
            let response = router().oneshot(request).await.expect("router answers");
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{target}");
        }
        let missing = Request::builder()
            .method("POST")
            .uri("/relay")
            .body(Body::empty())
            .expect("request builds");
        let response = router().oneshot(missing).await.expect("router answers");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_redirect_is_handed_back_unfollowed_and_without_its_location() {
        // Following it would send the key to a host nobody allowed.
        let (base, _hits, _dropped) = upstream().await;
        let request = Request::builder()
            .uri("/relay")
            .header(relay::TARGET_HEADER, format!("{base}/v1/redirect"))
            .header("authorization", "Bearer test-key")
            .body(Body::empty())
            .expect("request builds");
        let response = local_relay(&base)
            .oneshot(request)
            .await
            .expect("router answers");
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert!(!response.headers().contains_key("location"));
    }

    #[tokio::test]
    async fn a_page_that_stops_reading_closes_the_upstream_call() {
        // Barge-in aborts the page's fetch; the model on the far side must stop too.
        let (base, _hits, mut dropped) = upstream().await;
        let request = Request::builder()
            .uri("/relay")
            .header(relay::TARGET_HEADER, format!("{base}/v1/stream"))
            .body(Body::empty())
            .expect("request builds");
        let response = local_relay(&base)
            .oneshot(request)
            .await
            .expect("router answers");
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let mut body = response.into_body();
        let first = body
            .frame()
            .await
            .expect("a frame")
            .expect("frame is ok")
            .into_data()
            .expect("data");
        assert_eq!(&first[..], b"data: tick\n\n");
        drop(body);
        tokio::time::timeout(std::time::Duration::from_secs(5), dropped.recv())
            .await
            .expect("the upstream stream was dropped within 5 s")
            .expect("signal sent");
    }

    #[tokio::test]
    async fn health_identifies_this_binary_and_its_version() {
        let request = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .expect("health request builds");

        let response = router().oneshot(request).await.expect("router answers");
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body collects")
            .to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).expect("body is json");

        // The web app checks these fields to decide a companion is present and
        // speaks a version it understands, so they are part of the contract.
        assert_eq!(body["status"], "ok");
        assert_eq!(body["service"], "latentpresence-companion");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        // The page needs to know whether memory is available before it offers it.
        assert_eq!(body["database"]["kind"], "none");
        assert_eq!(body["database"]["connected"], false);
    }

    #[test]
    fn address_falls_back_to_loopback_and_never_to_a_public_interface() {
        // The companion is reached at 127.0.0.1 by the web app and nothing else;
        // a missing or malformed COMPANION_HOST must not open it to the network.
        assert_eq!(
            resolve_address(None, None),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DEFAULT_PORT)
        );
        assert!(
            resolve_address(Some("not-an-address"), Some("not-a-port"))
                .ip()
                .is_loopback()
        );
        assert_eq!(
            resolve_address(Some("0.0.0.0"), Some("9000")).to_string(),
            "0.0.0.0:9000"
        );
    }
}
