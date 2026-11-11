//! Web-transport subscription sign-in (port of electron/web-subscription-browser.cjs
//! and electron/chatgpt-relay.cjs).
//!
//! The page asks the server for an opaque one-use action; this resolves it
//! to the provider page and opens that in the system browser. For ChatGPT
//! with a non-loopback server, the OAuth redirect lands on THIS machine's
//! 127.0.0.1:<port>/auth/callback, so for the sign-in's lifetime we listen
//! there and forward the query to the server's
//! /api/subscriptions/chatgpt-callback. The server's own listener alone
//! verifies state and code; this only routes one request.

use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use url::Url;

pub const RELAY_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// `/api/subscriptions/browser?id=<uuid>` exactly.
pub fn valid_action(action: &str) -> bool {
    action
        .strip_prefix("/api/subscriptions/browser?id=")
        .is_some_and(|id| id.len() == 36 && id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-'))
}

/// Resolve the action on the server: it answers 303 with the provider page.
pub async fn resolve_action(client: &reqwest::Client, origin: &str, action: &str) -> Result<Url, String> {
    if !valid_action(action) {
        return Err("Invalid sign-in action.".into());
    }
    let response = client
        .post(format!("{origin}{action}"))
        .header("origin", origin)
        .header("x-learnharness-subscriptions", "1")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "The LearnHarness server could not be reached.".to_string())?;
    let location = response.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string);
    let (303, Some(location)) = (response.status().as_u16(), location) else {
        return Err("Sign-in action expired.".into());
    };
    let target = Url::parse(&location).map_err(|_| "Invalid provider page.".to_string())?;
    if target.scheme() != "https" || !target.username().is_empty() || target.password().is_some() {
        return Err("Invalid provider page.".into());
    }
    Ok(target)
}

/// The redirect port of a ChatGPT authorize URL, or None if it is not a
/// loopback /auth/callback target.
pub fn chatgpt_relay_port(target: &Url) -> Option<u16> {
    if target.scheme() != "https" {
        return None;
    }
    let redirect = target.query_pairs().find(|(k, _)| k == "redirect_uri")?.1;
    let redirect = Url::parse(&redirect).ok()?;
    if redirect.scheme() != "http" || redirect.host_str() != Some("127.0.0.1") || redirect.path() != "/auth/callback" {
        return None;
    }
    redirect.port().filter(|p| *p > 0)
}

pub struct Relay {
    stop: Arc<Notify>,
}

impl Relay {
    pub fn close(&self) {
        self.stop.notify_one();
    }
}

fn reply(status: u16, body: String) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers_mut();
    headers.insert("content-type", "text/plain; charset=utf-8".parse().unwrap());
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    response
}

async fn relay_one(client: &reqwest::Client, origin: &str, port: u16, req: Request<hyper::body::Incoming>) -> (Response<Full<Bytes>>, bool) {
    let host_ok = req.headers().get("host").and_then(|v| v.to_str().ok()) == Some(&format!("127.0.0.1:{port}"));
    if req.method() != hyper::Method::GET || req.uri().path() != "/auth/callback" || !host_ok {
        return (reply(404, String::new()), false);
    }
    let search = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let sent = client
        .post(format!("{origin}/api/subscriptions/chatgpt-callback"))
        .header("origin", origin)
        .header("content-type", "application/json")
        .header("x-learnharness-subscriptions", "1")
        .body(serde_json::json!({ "search": search }).to_string())
        .timeout(Duration::from_secs(30))
        .send()
        .await;
    let Ok(response) = sent else {
        return (reply(502, "The LearnHarness server could not be reached.".into()), false);
    };
    let ok = response.status().is_success();
    let body: serde_json::Value = response.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    match (ok, body.get("status").and_then(|s| s.as_u64())) {
        (true, Some(status)) => {
            let text = body.get("body").and_then(|b| b.as_str()).unwrap_or_default().to_string();
            (reply(status as u16, text), status == 200)
        }
        _ => {
            let error = body.get("error").and_then(|e| e.as_str()).unwrap_or("The sign-in could not be delivered to the LearnHarness server.");
            (reply(502, error.to_string()), false)
        }
    }
}

/// Listen on 127.0.0.1:port until one callback is relayed, the timeout
/// passes, or close() is called. Errors if the port is taken here.
pub async fn start_relay(client: reqwest::Client, origin: String, port: u16) -> std::io::Result<Relay> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let stop = Arc::new(Notify::new());
    let relay = Relay { stop: stop.clone() };
    tokio::spawn(async move {
        let deadline = tokio::time::sleep(RELAY_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            let stream = tokio::select! {
                _ = &mut deadline => break,
                _ = stop.notified() => break,
                accepted = listener.accept() => match accepted { Ok((s, _)) => s, Err(_) => continue },
            };
            let client = client.clone();
            let origin = origin.clone();
            let stop = stop.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req| {
                    let client = client.clone();
                    let origin = origin.clone();
                    let stop = stop.clone();
                    async move {
                        let (response, done) = relay_one(&client, &origin, port, req).await;
                        if done {
                            stop.notify_one();
                        }
                        Ok::<_, std::convert::Infallible>(response)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
        eprintln!("learnharness: chatgpt relay on 127.0.0.1:{port} closed");
    });
    Ok(relay)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_shape() {
        assert!(valid_action("/api/subscriptions/browser?id=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"));
        assert!(!valid_action("/api/subscriptions/browser?id=../../etc"));
        assert!(!valid_action("https://evil.example/api/subscriptions/browser?id=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"));
    }

    #[test]
    fn relay_port_from_authorize_url() {
        let url = Url::parse("https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=x").unwrap();
        assert_eq!(chatgpt_relay_port(&url), Some(1455));
        let other = Url::parse("https://github.com/login/device?redirect_uri=http%3A%2F%2Fevil%3A1455%2Fauth%2Fcallback").unwrap();
        assert_eq!(chatgpt_relay_port(&other), None);
    }
}
