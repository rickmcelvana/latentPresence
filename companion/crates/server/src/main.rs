//! latentPresence companion.
//!
//! Optional local service: MariaDB vector memory (P0-T06), document ingest and MCP
//! tools land later. For now it answers `/health` so the web app, the gate and CI
//! have something real to talk to.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::{Json, Router, routing::get};
use serde::Serialize;

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
    Router::new().route("/health", get(health))
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
