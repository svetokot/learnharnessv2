//! LearnHarness desktop client (Tauri 2). Client only: it never starts a
//! server. It shows the server's web UI through a loopback proxy
//! (src/proxy.rs) in the system web view: WebView2 on Windows, WebKitGTK on
//! Linux. Until the server answers, the bundled connect page (ui/index.html)
//! is shown instead.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connection;
mod proxy;
mod signin;

use connection::ServerConnection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::webview::{DownloadEvent, NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::window::Color;
use tauri::{AppHandle, Manager, State, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
/// Sidebar auto-close threshold in the web UI (components/sidebar.tsx).
const EXPAND_WIDTH: f64 = 928.0;
const PLATFORM: &str = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };

struct AppState {
    dir: PathBuf,
    /// What this launch uses (a saved change applies on restart).
    active: ServerConnection,
    saved: Mutex<ServerConnection>,
    proxy: Arc<proxy::Proxy>,
    relay: Mutex<Option<signin::Relay>>,
}

#[derive(Serialize)]
struct Snapshot {
    saved: ServerConnection,
    active: ServerConnection,
    dev: bool,
}

#[derive(Serialize)]
struct TestResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

#[derive(Serialize)]
struct ConnectInfo {
    saved: ServerConnection,
    target: String,
    local: &'static str,
}

#[derive(Deserialize)]
struct Appearance {
    mode: Option<String>,
    background: Option<String>,
}

fn same_origin(url: &Url, origin: &str) -> bool {
    url.origin().ascii_serialization() == origin
}

fn is_app_page(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn parse_hex(value: &str) -> Option<Color> {
    let hex = value.strip_prefix('#')?;
    let expanded: String = match hex.len() {
        3 => hex.chars().flat_map(|c| [c, c]).collect(),
        6 => hex.to_string(),
        _ => return None,
    };
    let n = u32::from_str_radix(&expanded, 16).ok()?;
    Some(Color((n >> 16) as u8, (n >> 8) as u8, n as u8, 255))
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("learnharness: could not open {url}: {err}");
        }
    }
}

/// Connect page: probe the active server; on success load it.
#[tauri::command]
async fn connect(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    connection::probe(&state.proxy.client, &state.proxy.target).await?;
    let url = Url::parse(&format!("{}/", state.proxy.origin())).map_err(|e| e.to_string())?;
    window.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
fn connect_info(state: State<'_, AppState>) -> ConnectInfo {
    ConnectInfo { saved: state.saved.lock().unwrap().clone(), target: state.proxy.target.clone(), local: connection::LOCAL_ORIGIN }
}

#[tauri::command]
fn connection_get(state: State<'_, AppState>) -> Snapshot {
    Snapshot { saved: state.saved.lock().unwrap().clone(), active: state.active.clone(), dev: false }
}

#[tauri::command]
async fn connection_test(url: String, state: State<'_, AppState>) -> Result<TestResult, String> {
    let Some(origin) = connection::normalize_server_url(&url) else {
        return Ok(TestResult { ok: false, error: Some("Enter a server address like http://192.168.1.20:3000".into()), url: None });
    };
    Ok(match connection::probe(&state.proxy.client, &origin).await {
        Ok(()) => TestResult { ok: true, error: None, url: Some(origin) },
        Err(error) => TestResult { ok: false, error: Some(error), url: Some(origin) },
    })
}

/// Save, then restart so the proxy targets the new server.
#[tauri::command]
fn connection_apply(next: ServerConnection, app: AppHandle, state: State<'_, AppState>) -> Result<ServerConnection, String> {
    let record = connection::validate(&next)?;
    connection::write(&state.dir, &record, None).map_err(|e| format!("The connection could not be saved: {e}"))?;
    *state.saved.lock().unwrap() = record.clone();
    if let Some(relay) = state.relay.lock().unwrap().take() {
        relay.close();
    }
    app.restart();
}

#[tauri::command]
async fn open_subscription_browser(action: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let origin = state.proxy.target.clone();
    let target = signin::resolve_action(&state.proxy.client, &origin, &action).await?;
    // A server on this computer receives its own loopback callback.
    if !connection::is_loopback_origin(&origin) {
        if let Some(port) = signin::chatgpt_relay_port(&target) {
            if let Some(previous) = state.relay.lock().unwrap().take() {
                previous.close();
            }
            match signin::start_relay(state.proxy.client.clone(), origin.clone(), port).await {
                Ok(relay) => {
                    eprintln!("learnharness: chatgpt relay listening on 127.0.0.1:{port} → {origin}");
                    *state.relay.lock().unwrap() = Some(relay);
                }
                Err(err) => eprintln!("learnharness: chatgpt relay could not listen on {port}: {err}"),
            }
        }
    }
    app.opener().open_url(target.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn expand_window(window: WebviewWindow) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    if size.width < EXPAND_WIDTH {
        window.set_size(tauri::LogicalSize::new(EXPAND_WIDTH, size.height)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_appearance(appearance: Appearance, window: WebviewWindow) {
    let theme = if appearance.mode.as_deref() == Some("light") { Theme::Light } else { Theme::Dark };
    let _ = window.set_theme(Some(theme));
    if let Some(color) = appearance.background.as_deref().and_then(parse_hex) {
        let _ = window.set_background_color(Some(color));
    }
}

fn unique_download_path(dir: PathBuf, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("download");
    let ext = path.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (1..1000)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(candidate)
}

fn create_window(app: &AppHandle, proxy_origin: String) -> tauri::Result<WebviewWindow> {
    let bridge = include_str!("bridge.js").replace("__LH_ORIGIN__", &proxy_origin).replace("__LH_PLATFORM__", PLATFORM);
    let nav_app = app.clone();
    let nav_origin = proxy_origin.clone();
    let popup_app = app.clone();
    let mic_origin = proxy_origin.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()));
    // Debug builds only: LH_DESKTOP_PROBE=<file.js> runs a check script on the
    // server page; it reports by navigating to http://lh-report.invalid/?<text>,
    // which is printed to stdout and exits (verification without devtools).
    #[cfg(debug_assertions)]
    let builder = match std::env::var("LH_DESKTOP_PROBE").ok().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(probe) => builder.initialization_script(format!("if (location.origin === {proxy_origin:?}) {{ {probe} }}")),
        None => builder,
    };
    let window = builder
        .title("LearnHarness")
        .inner_size(1280.0, 820.0)
        .min_inner_size(420.0, 360.0)
        .theme(Some(Theme::Dark))
        .background_color(Color(0x1b, 0x1a, 0x17, 255))
        .initialization_script(bridge)
        .zoom_hotkeys_enabled(true)
        // HTML5 drops (File objects) must reach the page: attachments upload.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            #[cfg(debug_assertions)]
            if url.host_str() == Some("lh-report.invalid") {
                println!("LH-REPORT {}", url.query().map(|q| url::form_urlencoded::parse(format!("r={q}").as_bytes()).map(|(_, v)| v.into_owned()).collect::<String>()).unwrap_or_default());
                std::process::exit(0);
            }
            if same_origin(url, &nav_origin) || is_app_page(url) || matches!(url.scheme(), "about" | "blob" | "data") {
                return true;
            }
            open_external(&nav_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&popup_app, &url);
            NewWindowResponse::Deny
        })
        .on_permission_request(move |webview, kind| {
            let ours = webview.url().map(|u| same_origin(&u, &mic_origin)).unwrap_or(false);
            match kind {
                PermissionKind::Microphone if ours => PermissionResponse::Allow,
                _ => PermissionResponse::Default,
            }
        })
        .on_download(|webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let name = destination
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(str::to_string)
                        .or_else(|| url.path_segments().and_then(|mut s| s.next_back()).filter(|s| !s.is_empty()).map(str::to_string))
                        .unwrap_or_else(|| "download".into());
                    let dir = webview.path().download_dir().unwrap_or_else(|_| std::env::temp_dir());
                    *destination = unique_download_path(dir, &name);
                    eprintln!("learnharness: downloading to {}", destination.display());
                }
                DownloadEvent::Finished { path, success, .. } => {
                    eprintln!("learnharness: download {} {:?}", if success { "finished" } else { "failed" }, path);
                }
                _ => {}
            }
            true
        })
        .build()?;
    #[cfg(target_os = "linux")]
    window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = webview.inner().settings() {
            // getUserMedia (dictation); the permission itself is gated above.
            settings.set_enable_media_stream(true);
        }
    })?;
    #[cfg(all(debug_assertions, target_os = "linux"))]
    debug_snapshot(&window);
    Ok(window)
}

/// Debug builds only: LH_DESKTOP_SNAPSHOT=<file.png> writes the visible page
/// after LH_DESKTOP_SNAPSHOT_DELAY ms (default 8000), then exits.
#[cfg(all(debug_assertions, target_os = "linux"))]
fn debug_snapshot(window: &WebviewWindow) {
    let Ok(path) = std::env::var("LH_DESKTOP_SNAPSHOT") else { return };
    let delay = std::env::var("LH_DESKTOP_SNAPSHOT_DELAY").ok().and_then(|d| d.parse().ok()).unwrap_or(8000);
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay));
        let _ = window.with_webview(move |webview| {
            use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
            webview.inner().snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gtk::gio::Cancellable>, move |result| {
                match result.map_err(|e| e.to_string()).and_then(|s| cairo::ImageSurface::try_from(s).map_err(|_| "not an image surface".to_string())) {
                    Ok(image) => match std::fs::File::create(&path) {
                        Ok(mut file) => { let _ = image.write_to_png(&mut file); println!("LH-SNAPSHOT {path}"); }
                        Err(err) => eprintln!("snapshot: {err}"),
                    },
                    Err(err) => eprintln!("snapshot: {err}"),
                }
                std::process::exit(0);
            });
        });
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            connect,
            connect_info,
            connection_get,
            connection_test,
            connection_apply,
            open_subscription_browser,
            expand_window,
            set_appearance,
        ])
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let (saved, stored_port) = connection::read(&dir);
            let listener = proxy::bind(stored_port)?;
            let port = listener.local_addr()?.port();
            if stored_port != Some(port) {
                if let Err(err) = connection::write(&dir, &saved, Some(port)) {
                    eprintln!("learnharness: could not save the proxy port: {err}");
                }
            }
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(10))
                .no_proxy()
                .build()?;
            let proxy = Arc::new(proxy::Proxy { port, target: saved.origin(), client });
            eprintln!("learnharness: {} → {}", proxy.origin(), proxy.target);
            tauri::async_runtime::spawn(proxy::serve(listener, proxy.clone()));
            let proxy_origin = proxy.origin();
            app.manage(AppState { dir, active: saved.clone(), saved: Mutex::new(saved), proxy, relay: Mutex::new(None) });
            create_window(app.handle(), proxy_origin)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LearnHarness");
}
