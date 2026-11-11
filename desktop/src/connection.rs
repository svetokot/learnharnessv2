//! Which LearnHarness server this client talks to. Mirrors the record shape
//! of electron/connection.cjs ({ mode, url }) so the Settings → General →
//! Server row works unchanged. Stored per client in the app config dir.
//!
//! "local" = the server on this computer (http://127.0.0.1:3000, started with
//! `npm run start:remote`, `npm start`, or the systemd unit). This client never
//! spawns a server itself. "remote" = a server on the LAN/VPN (no auth, owner
//! decision: trusted networks only).

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use url::Url;

pub const LOCAL_ORIGIN: &str = "http://127.0.0.1:3000";
const FILE: &str = "connection.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Remote,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerConnection {
    pub mode: Mode,
    pub url: Option<String>,
}

impl ServerConnection {
    #[cfg(test)]
    pub fn local() -> Self {
        Self { mode: Mode::Local, url: None }
    }
    /// The origin this record points at.
    pub fn origin(&self) -> String {
        match (&self.mode, &self.url) {
            (Mode::Remote, Some(url)) => url.clone(),
            _ => LOCAL_ORIGIN.to_string(),
        }
    }
}

/// On disk: the connection plus the loopback proxy port, kept stable so the
/// page origin (and with it localStorage) survives restarts.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proxy_port: Option<u16>,
}

/// A server URL is an origin only: http(s), no credentials, no
/// path/query/fragment. Returns the canonical origin or None.
pub fn normalize_server_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return None;
    }
    let has_scheme = trimmed
        .split_once("://")
        .map(|(scheme, _)| {
            !scheme.is_empty()
                && scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        })
        .unwrap_or(false);
    let candidate = if has_scheme { trimmed.to_string() } else { format!("http://{trimmed}") };
    let url = Url::parse(&candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    if url.path() != "/" && !url.path().is_empty() {
        return None;
    }
    url.host_str().filter(|h| !h.is_empty())?;
    Some(url.origin().ascii_serialization())
}

fn normalize(stored: &Stored) -> ServerConnection {
    let url = stored.url.as_deref().and_then(normalize_server_url);
    match (stored.mode.as_deref(), url) {
        (Some("remote"), Some(url)) => ServerConnection { mode: Mode::Remote, url: Some(url) },
        // A local record may remember the last remote URL for the settings field.
        (_, url) => ServerConnection { mode: Mode::Local, url },
    }
}

fn read_stored(dir: &Path) -> Stored {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Absent/corrupt/unreadable → local: a broken file must never strand the app.
pub fn read(dir: &Path) -> (ServerConnection, Option<u16>) {
    let stored = read_stored(dir);
    (normalize(&stored), stored.proxy_port)
}

/// Validate a record coming from the page. A remote record must carry a
/// valid server address.
pub fn validate(next: &ServerConnection) -> Result<ServerConnection, String> {
    let url = next.url.as_deref().and_then(normalize_server_url);
    match next.mode {
        Mode::Remote => url
            .map(|url| ServerConnection { mode: Mode::Remote, url: Some(url) })
            .ok_or_else(|| "Enter a server address like http://192.168.1.20:3000".to_string()),
        Mode::Local => Ok(ServerConnection { mode: Mode::Local, url }),
    }
}

/// Atomic write (temp + rename). Keeps the stored proxy port unless a new
/// one is given.
pub fn write(dir: &Path, next: &ServerConnection, proxy_port: Option<u16>) -> std::io::Result<()> {
    let previous = read_stored(dir);
    let stored = Stored {
        mode: Some(match next.mode { Mode::Local => "local", Mode::Remote => "remote" }.to_string()),
        url: next.url.clone(),
        proxy_port: proxy_port.or(previous.proxy_port),
    };
    std::fs::create_dir_all(dir)?;
    let file = dir.join(FILE);
    let temp = dir.join(format!("{FILE}.{}.tmp", std::process::id()));
    let mut text = serde_json::to_string_pretty(&stored).map_err(std::io::Error::other)?;
    text.push('\n');
    std::fs::write(&temp, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(temp, file)
}

pub fn is_loopback_origin(origin: &str) -> bool {
    Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase()))
        .is_some_and(|h| h == "localhost" || h.ends_with(".localhost") || h == "::1" || h.starts_with("127."))
}

fn refused(err: &reqwest::Error) -> bool {
    let mut source: Option<&dyn std::error::Error> = Some(err);
    while let Some(e) = source {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            if io.kind() == std::io::ErrorKind::ConnectionRefused {
                return true;
            }
        }
        source = e.source();
    }
    false
}

/// Is a LearnHarness server answering at this origin? GET /api/settings must
/// return JSON; a timeout/refusal/non-JSON does not count.
pub async fn probe(client: &reqwest::Client, origin: &str) -> Result<(), String> {
    let target = Url::parse(origin)
        .and_then(|u| u.join("/api/settings"))
        .map_err(|_| "Invalid server address.".to_string())?;
    let response = client
        .get(target)
        .header("accept", "application/json")
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|err| {
            if err.is_timeout() {
                "The server did not answer in time.".to_string()
            } else if refused(&err) {
                "Connection refused. Is the server running?".to_string()
            } else {
                "The server could not be reached.".to_string()
            }
        })?;
    let status = response.status().as_u16();
    let json = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("application/json"));
    match status {
        200 if json => Ok(()),
        403 => Err("The server refused this address. Use its IP address, or add the name to LH_ALLOWED_HOSTS on the server.".to_string()),
        _ => Err(format!("Not a LearnHarness server (HTTP {status}).")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses() {
        assert_eq!(normalize_server_url("192.168.1.20:3000").as_deref(), Some("http://192.168.1.20:3000"));
        assert_eq!(normalize_server_url(" http://host.lan:3000/ ").as_deref(), Some("http://host.lan:3000"));
        assert_eq!(normalize_server_url("https://box.example").as_deref(), Some("https://box.example"));
        assert_eq!(normalize_server_url("http://h:3000/path"), None);
        assert_eq!(normalize_server_url("http://u:p@h:3000"), None);
        assert_eq!(normalize_server_url("http://h:3000/?q=1"), None);
        assert_eq!(normalize_server_url("ftp://h"), None);
        assert_eq!(normalize_server_url(""), None);
    }

    #[test]
    fn remote_without_url_is_rejected_and_corrupt_reads_local() {
        assert!(validate(&ServerConnection { mode: Mode::Remote, url: Some("not a url/x".into()) }).is_err());
        let dir = std::env::temp_dir().join(format!("lh-conn-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "{not json").unwrap();
        assert_eq!(read(&dir).0, ServerConnection::local());
        write(&dir, &ServerConnection { mode: Mode::Remote, url: Some("http://10.0.0.2:3000".into()) }, Some(41234)).unwrap();
        let (conn, port) = read(&dir);
        assert_eq!(conn.origin(), "http://10.0.0.2:3000");
        assert_eq!(port, Some(41234));
        write(&dir, &ServerConnection::local(), None).unwrap();
        assert_eq!(read(&dir).1, Some(41234), "proxy port survives a connection change");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn loopback_detection() {
        assert!(is_loopback_origin("http://127.0.0.1:3000"));
        assert!(is_loopback_origin("http://localhost:3000"));
        assert!(!is_loopback_origin("http://192.168.40.165:3000"));
    }
}
