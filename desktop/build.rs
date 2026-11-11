const COMMANDS: &[&str] = &[
    "connect",
    "connect_info",
    "connection_get",
    "connection_test",
    "connection_apply",
    "open_subscription_browser",
    "expand_window",
    "set_appearance",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
