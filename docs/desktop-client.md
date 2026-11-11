# Desktop client (Tauri)

`desktop/` is a small native client for Windows and Linux, written in Rust with [Tauri 2](https://tauri.app). It replaces the Electron app for connecting to a LearnHarness server.

- **Client only.** It never starts a server. It connects to the server on this computer (`http://127.0.0.1:3000`) or to one on your network or VPN; see [Remote server](remote.md).
- **System web view.** The server's interface is shown in the operating system's own web view: WebView2 on Windows, WebKitGTK on Linux. There is no bundled Chromium. The binary is about 7.5 MB.
- **Electron stays.** The Electron app in `electron/` is unchanged and still works, including the macOS build.

## Install

### CachyOS / Arch

```sh
sudo pacman -S --needed rust webkit2gtk-4.1 gtk3   # usually already present
desktop/scripts/install-linux.sh
```

This builds a release binary (cargo output goes to `~/.cache/learnharness-desktop/target`, outside the checkout) and installs it for your user only:
- `~/.local/bin/learnharness`;
- a **LearnHarness** launcher entry;
- the icon.

To remove it, run `desktop/scripts/install-linux.sh --uninstall`.

### Windows

Build the installer on GitHub Actions: **Actions → Desktop client (Tauri) → Run workflow** (`.github/workflows/desktop-tauri.yml`). Download the `learnharness-desktop-Windows` artifact and run the `*-setup.exe`.
- The installer is per-user and unsigned, so SmartScreen will warn once.
- WebView2 ships with Windows 10 and 11; the installer fetches it if it's missing.

To build on a Windows machine instead:
1. Install Rust (rustup, MSVC toolchain).
2. Run `cargo install tauri-cli --version =2.12.4 --locked`.
3. In `desktop/`, run `cargo tauri build --bundles nsis`.

## Use

1. Start the server, for example with `npm run build && npm run start:remote`, or as the systemd unit from [Remote server](remote.md).
2. Launch LearnHarness. If the server isn't answering, a connect page appears where you can:
   - choose **This computer** or **Remote server**;
   - enter the address;
   - use **Retry** or **Save & connect**.
3. Change servers later in **Settings → General → Server**. **Apply & restart** restarts the client.

The client stores its choice in `connection.json` in its config folder:
- Linux: `~/.config/dev.learnharness.desktop/`;
- Windows: `%APPDATA%\dev.learnharness.desktop\`.

## How it works

- **Loopback proxy.** The window loads `http://127.0.0.1:<port>/`, and the client streams every request to the server (`desktop/src/proxy.rs`).
  - Loopback addresses count as secure origins, so the microphone (dictation) works even when the server is plain HTTP on the LAN. That covers WebKitGTK, which has no "treat this origin as secure" switch.
  - The port is saved, so the page's origin and its local storage stay the same across restarts.
  - The proxy only forwards requests addressed to itself, and only from its own page. A request from another origin, or with another `Host`, gets a 403.
- **Bridge.** `window.lh` (`desktop/src/bridge.js`) is a subset of the Electron preload:
  - `remote: true`, so attachments are uploaded;
  - web-transport subscriptions;
  - the server connection;
  - window expansion;
  - the window theme and background.
  - Left out: update checks (update the client by rebuilding it) and the local path bridge.
- **Sign-in.** Provider pages open in your system browser. For ChatGPT with a server on another machine, the client briefly listens on the OAuth callback port and forwards the callback to the server, as the Electron app does.
- **Links and downloads.**
  - The window can only show the server (through the proxy) or the connect page; other links open in your browser.
  - Downloads are saved to your Downloads folder.
  - The microphone is granted only to the server page.

## Develop

```sh
cd desktop
export CARGO_TARGET_DIR=~/.cache/learnharness-desktop/target   # keep build output out of the repo
cargo test          # unit tests: address normalizing, proxy guard, sign-in parsing
cargo run           # debug build
```

Keep the cargo target directory outside the checkout. A `desktop/target` inside it makes `next build` much slower, because the build walks the whole project for file tracing; `desktop/` is excluded from the standalone output in `next.config.ts`.

Debug builds also accept two variables for checking a live window without devtools:
- `LH_DESKTOP_PROBE=<file.js>` runs a script on the server page. It reports by navigating to `http://lh-report.invalid/?<text>`, which is printed to stdout.
- `LH_DESKTOP_SNAPSHOT=<file.png>` saves a screenshot of the page after `LH_DESKTOP_SNAPSHOT_DELAY` ms (Linux only).

Release builds ignore both variables.
