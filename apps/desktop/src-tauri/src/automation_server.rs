use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rand::{rngs::OsRng, RngCore};
use tokio::net::TcpListener;

/// The automation API never listens on anything but loopback. The bind
/// address is a constant, not a setting, so no configuration or future
/// refactor can widen it to a LAN-facing socket by accident.
pub const AUTOMATION_LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

pub const AUTOMATION_DEFAULT_PORT: u16 = 37291;

const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const RATE_LIMIT_MAX_REQUESTS: u32 = 600;
const TOKEN_BYTES: usize = 32;

struct RateBucket {
    window_start: Instant,
    count: u32,
}

pub struct AutomationState {
    token: String,
    started_at: Instant,
    rate: Mutex<RateBucket>,
    pool: Option<sqlx::SqlitePool>,
}

impl AutomationState {
    pub fn with_pool(pool: Option<sqlx::SqlitePool>) -> Self {
        let mut bytes = [0u8; TOKEN_BYTES];
        OsRng.fill_bytes(&mut bytes);
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
        AutomationState {
            token,
            started_at: Instant::now(),
            rate: Mutex::new(RateBucket {
                window_start: Instant::now(),
                count: 0,
            }),
            pool,
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    fn check_auth(&self, headers: &hyper::HeaderMap) -> bool {
        let expected = format!("Bearer {}", self.token());
        headers
            .get(hyper::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == expected)
    }

    fn check_rate_limit(&self, now: Instant) -> bool {
        let mut bucket = match self.rate.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        if now.duration_since(bucket.window_start) >= RATE_LIMIT_WINDOW {
            bucket.window_start = now;
            bucket.count = 0;
        }
        bucket.count = bucket.count.saturating_add(1);
        bucket.count <= RATE_LIMIT_MAX_REQUESTS
    }
}

fn json_response(status: StatusCode, body: serde_json::Value) -> Response<Full<Bytes>> {
    let bytes = Bytes::from(body.to_string());
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(bytes))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Full::new(Bytes::new()))
                .expect("static fallback response builds")
        })
}

fn query_pairs(raw_query: Option<&str>) -> Vec<(String, String)> {
    url::form_urlencoded::parse(raw_query.unwrap_or_default().as_bytes())
        .into_owned()
        .collect()
}

fn parse_limit(raw_query: Option<&str>) -> i64 {
    query_pairs(raw_query)
        .iter()
        .find(|(key, _)| key == "limit")
        .and_then(|(_, value)| value.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 100)
}

fn parse_query(raw_query: Option<&str>) -> String {
    query_pairs(raw_query)
        .iter()
        .find(|(key, _)| key == "q")
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

async fn serve_meetings(
    state: &AutomationState,
    raw_query: Option<&str>,
    search: bool,
) -> (StatusCode, serde_json::Value) {
    let pool = match state.pool.clone() {
        Some(pool) => pool,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({ "error": "database_unavailable" }),
            )
        }
    };
    let limit = parse_limit(raw_query);
    let outcome = if search {
        let q = parse_query(raw_query);
        if q.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "missing_query" }),
            );
        }
        crate::db::meeting_queries::search_meetings(pool, &q, limit).await
    } else {
        crate::db::meeting_queries::fetch_meetings(pool, limit).await
    };
    match outcome {
        Ok(meetings) => (
            StatusCode::OK,
            serde_json::json!({ "meetings": meetings }),
        ),
        Err(err) => {
            log::warn!("automation meetings query failed: {err}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": "query_failed" }),
            )
        }
    }
}

fn route(
    method: &Method,
    path: &str,
    uptime_secs: u64,
) -> (StatusCode, serde_json::Value) {
    if *method == Method::GET && path == "/health" {
        (StatusCode::OK, serde_json::json!({ "status": "ok" }))
    } else if *method == Method::GET && path == "/api/v1/status" {
        (
            StatusCode::OK,
            serde_json::json!({ "status": "ok", "uptime_secs": uptime_secs }),
        )
    } else {
        (StatusCode::NOT_FOUND, serde_json::json!({ "error": "not_found" }))
    }
}

fn audit_log(method: &Method, path: &str, status: StatusCode) {
    log::info!("automation {method} {path} -> {status}");
}

async fn handle(
    req: Request<hyper::body::Incoming>,
    state: Arc<AutomationState>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    if !state.check_auth(req.headers()) {
        audit_log(&method, &path, StatusCode::UNAUTHORIZED);
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({ "error": "unauthorized" }),
        ));
    }
    if !state.check_rate_limit(Instant::now()) {
        audit_log(&method, &path, StatusCode::TOO_MANY_REQUESTS);
        return Ok(json_response(
            StatusCode::TOO_MANY_REQUESTS,
            serde_json::json!({ "error": "rate_limited" }),
        ));
    }

    let uptime_secs = state.started_at.elapsed().as_secs();
    let (status, body) = if method == Method::GET && path == "/api/v1/meetings" {
        serve_meetings(&state, req.uri().query(), false).await
    } else if method == Method::GET && path == "/api/v1/meetings/search" {
        serve_meetings(&state, req.uri().query(), true).await
    } else {
        route(&method, &path, uptime_secs)
    };
    audit_log(&method, &path, status);
    Ok(json_response(status, body))
}

pub async fn serve_automation_api(
    state: Arc<AutomationState>,
    port: u16,
) -> std::io::Result<SocketAddr> {
    let listener = TcpListener::bind(SocketAddr::new(AUTOMATION_LOOPBACK, port)).await?;
    let bound = listener.local_addr()?;
    log::info!("automation api listening on {bound}");

    tauri::async_runtime::spawn(async move {
        loop {
            let (stream, _peer) = match listener.accept().await {
                Ok(pair) => pair,
                Err(err) => {
                    log::warn!("automation accept failed: {err}");
                    continue;
                }
            };
            let state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                let io = TokioIo::new(stream);
                let service = service_fn(move |req| handle(req, Arc::clone(&state)));
                if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                    log::warn!("automation connection failed: {err}");
                }
            });
        }
    });

    Ok(bound)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authed_headers(state: &AutomationState) -> hyper::HeaderMap {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            hyper::header::AUTHORIZATION,
            format!("Bearer {}", state.token()).parse().expect("static header parses"),
        );
        headers
    }

    #[test]
    fn tokens_are_unique_per_state() {
        assert_ne!(
            AutomationState::with_pool(None).token(),
            AutomationState::with_pool(None).token()
        );
    }

    #[test]
    fn auth_rejects_missing_and_wrong_tokens() {
        let state = AutomationState::with_pool(None);
        assert!(!state.check_auth(&hyper::HeaderMap::new()));
        let mut wrong = authed_headers(&state);
        wrong.insert(
            hyper::header::AUTHORIZATION,
            "Bearer wrong".parse().expect("static header parses"),
        );
        assert!(!state.check_auth(&wrong));
        assert!(state.check_auth(&authed_headers(&state)));
    }

    #[test]
    fn rate_limit_trips_after_window_budget() {
        let state = AutomationState::with_pool(None);
        let start = Instant::now();
        for _ in 0..RATE_LIMIT_MAX_REQUESTS {
            assert!(state.check_rate_limit(start));
        }
        assert!(!state.check_rate_limit(start));
        assert!(state.check_rate_limit(start + RATE_LIMIT_WINDOW));
    }

    #[test]
    fn parse_limit_defaults_clamps_and_parses() {
        assert_eq!(parse_limit(None), 20);
        assert_eq!(parse_limit(Some("")), 20);
        assert_eq!(parse_limit(Some("limit=10")), 10);
        assert_eq!(parse_limit(Some("q=x&limit=5")), 5);
        assert_eq!(parse_limit(Some("limit=9999")), 100);
        assert_eq!(parse_limit(Some("limit=0")), 1);
        assert_eq!(parse_limit(Some("limit=abc")), 20);
    }

    #[test]
    fn parse_query_extracts_q() {
        assert_eq!(parse_query(None), "");
        assert_eq!(parse_query(Some("limit=5")), "");
        assert_eq!(parse_query(Some("q=sprint")), "sprint");
        assert_eq!(parse_query(Some("q=sprint%20planning")), "sprint planning");
        assert_eq!(parse_query(Some("freq=x")), "");
    }

    #[test]
    fn route_serves_health_status_and_404() {
        let (status, _) = route(&Method::GET, "/health", 0);
        assert_eq!(status, StatusCode::OK);
        let (status, body) = route(&Method::GET, "/api/v1/status", 7);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["uptime_secs"], serde_json::json!(7));
        let (status, _) = route(&Method::POST, "/health", 0);
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = route(&Method::GET, "/nope", 0);
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
