//! Loopback reverse proxy: the window loads http://127.0.0.1:<port>/ and every
//! request is streamed to the configured LearnHarness server.
//!
//! Why: a plain-HTTP LAN origin is not a secure context, so WebKitGTK and
//! WebView2 hide getUserMedia/AudioWorklet (dictation). Loopback origins are
//! secure in both. The port is persisted, so the page origin and its
//! localStorage stay stable across restarts.
//!
//! Guard: any local process or browser tab can reach this port, so only
//! requests whose Host is this proxy and whose Origin (when sent) is this
//! proxy are forwarded. Origin/Referer are then rewritten to the server's
//! origin, so the server's own same-origin checks see a same-origin request.
//! Bodies stream both ways (SSE on /api/events, chat streams, 200 MB uploads).

use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, BodyDataStream, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::sync::Arc;

pub type Body = BoxBody<Bytes, std::io::Error>;

pub struct Proxy {
    pub port: u16,
    /// The server origin, e.g. http://192.168.40.165:3000 (no trailing slash).
    pub target: String,
    pub client: reqwest::Client,
}

impl Proxy {
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

const HOP_BY_HOP: &[&str] = &[
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "host",
];

fn text(status: StatusCode, body: &'static str) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())).map_err(|never| match never {}).boxed());
    *response.status_mut() = status;
    response.headers_mut().insert("content-type", HeaderValue::from_static("text/plain; charset=utf-8"));
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

/// Is this request addressed to the proxy itself, from its own page (or
/// from no page at all)?
pub fn accepts(headers: &HeaderMap, port: u16) -> bool {
    let own = |value: &str| value == format!("127.0.0.1:{port}") || value == format!("localhost:{port}");
    let host_ok = headers.get("host").and_then(|v| v.to_str().ok()).is_some_and(own);
    let origin_ok = match headers.get("origin").map(|v| v.to_str()) {
        None => true,
        Some(Ok(origin)) => origin.strip_prefix("http://").is_some_and(own),
        Some(Err(_)) => false,
    };
    host_ok && origin_ok
}

fn copy_headers(from: &HeaderMap, skip_extra: &[&str]) -> HeaderMap {
    // Header names listed in Connection are hop-by-hop too.
    let listed: Vec<String> = from
        .get_all("connection")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(',').map(|s| s.trim().to_ascii_lowercase()))
        .collect();
    let mut out = HeaderMap::new();
    for (name, value) in from {
        let lower = name.as_str();
        if HOP_BY_HOP.contains(&lower) || skip_extra.contains(&lower) || listed.iter().any(|l| l == lower) {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

fn rewrite_prefix(value: &HeaderValue, from: &str, to: &str) -> Option<HeaderValue> {
    let text = value.to_str().ok()?;
    let rest = text.strip_prefix(from)?;
    if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('?')) {
        return None;
    }
    HeaderValue::from_str(&format!("{to}{rest}")).ok()
}

async fn forward(proxy: Arc<Proxy>, req: Request<Incoming>) -> Response<Body> {
    if !accepts(req.headers(), proxy.port) {
        return text(StatusCode::FORBIDDEN, "This LearnHarness desktop proxy only serves its own window.");
    }
    if req.headers().contains_key("upgrade") {
        return text(StatusCode::NOT_IMPLEMENTED, "Protocol upgrades are not proxied.");
    }
    let own = proxy.origin();
    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url = format!("{}{}", proxy.target, path);

    let mut headers = copy_headers(req.headers(), &["origin", "referer"]);
    if req.headers().contains_key("origin") {
        if let Ok(v) = HeaderValue::from_str(&proxy.target) {
            headers.insert(HeaderName::from_static("origin"), v);
        }
    }
    if let Some(referer) = req.headers().get("referer").and_then(|v| rewrite_prefix(v, &own, &proxy.target)) {
        headers.insert(HeaderName::from_static("referer"), referer);
    }

    let method = req.method().clone();
    let has_body = req.headers().contains_key("content-length") || req.headers().contains_key("transfer-encoding");
    let mut upstream = proxy.client.request(method, url).headers(headers);
    if has_body {
        // Pump the incoming body through a channel: reqwest needs a Sync stream.
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(8);
        let mut data = BodyDataStream::new(req.into_body());
        tokio::spawn(async move {
            loop {
                match data.try_next().await {
                    Ok(Some(chunk)) => {
                        if tx.send(Ok(chunk)).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(err) => {
                        let _ = tx.send(Err(std::io::Error::other(err))).await;
                        break;
                    }
                }
            }
        });
        let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
        upstream = upstream.body(reqwest::Body::wrap_stream(stream));
    }

    let response = match upstream.send().await {
        Ok(response) => response,
        Err(err) => {
            eprintln!("learnharness: proxy → {}: {err}", proxy.target);
            return text(StatusCode::BAD_GATEWAY, "The LearnHarness server could not be reached.");
        }
    };
    let status = response.status();
    let mut out_headers = copy_headers(response.headers(), &[]);
    if let Some(location) = response.headers().get("location").and_then(|v| rewrite_prefix(v, &proxy.target, &own)) {
        out_headers.insert(HeaderName::from_static("location"), location);
    }
    let stream = response.bytes_stream().map_ok(Frame::data).map_err(std::io::Error::other);
    let mut out = Response::new(BodyExt::boxed(StreamBody::new(stream)));
    *out.status_mut() = status;
    *out.headers_mut() = out_headers;
    out
}

/// Serve forever on an already-bound loopback listener.
pub async fn serve(listener: std::net::TcpListener, proxy: Arc<Proxy>) {
    listener.set_nonblocking(true).expect("nonblocking listener");
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let proxy = proxy.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req| {
                let proxy = proxy.clone();
                async move { Ok::<_, std::convert::Infallible>(forward(proxy, req).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

/// Bind 127.0.0.1 on the preferred port, else any free port.
pub fn bind(preferred: Option<u16>) -> std::io::Result<std::net::TcpListener> {
    if let Some(port) = preferred.filter(|p| *p != 0) {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Ok(listener);
        }
    }
    std::net::TcpListener::bind(("127.0.0.1", 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_static(v));
        }
        map
    }

    #[test]
    fn accepts_only_own_host_and_origin() {
        assert!(accepts(&headers(&[("host", "127.0.0.1:4100")]), 4100));
        assert!(accepts(&headers(&[("host", "127.0.0.1:4100"), ("origin", "http://127.0.0.1:4100")]), 4100));
        assert!(!accepts(&headers(&[("host", "127.0.0.1:4100"), ("origin", "http://evil.example")]), 4100));
        assert!(!accepts(&headers(&[("host", "127.0.0.1:4100"), ("origin", "null")]), 4100));
        assert!(!accepts(&headers(&[("host", "rebind.example:4100")]), 4100));
        assert!(!accepts(&headers(&[]), 4100));
    }

    #[test]
    fn rewrites_only_whole_origin_prefixes() {
        let v = HeaderValue::from_static("http://10.0.0.2:3000/chat/1");
        assert_eq!(rewrite_prefix(&v, "http://10.0.0.2:3000", "http://127.0.0.1:4100").unwrap(), "http://127.0.0.1:4100/chat/1");
        let v = HeaderValue::from_static("http://10.0.0.2:30001/x");
        assert!(rewrite_prefix(&v, "http://10.0.0.2:3000", "http://127.0.0.1:4100").is_none());
    }
}
