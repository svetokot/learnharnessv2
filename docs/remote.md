# Remote server

Run LearnHarness on one machine (say, a desktop with a GPU) and use it from another computer's desktop app on your network.

There is **no login**. Anyone who can reach the server's port can read every chat and setting, change saved keys, use connected subscriptions, and start agent turns. Only run it on a LAN or VPN you trust (Tailscale, WireGuard, a home network). Do not expose it to the Internet.

## On the server

```sh
npm ci
npm run plugins:setup
npm run build
npm run start:remote          # listens on 0.0.0.0:3000
```

Pass `-- -p 4000` to choose another port. Data lives in the checkout's `data/`; keys are in `auth.json` (see [development](development.md#configuration)).

The API accepts IP addresses and `localhost` as host names. To connect by a name (`myserver.lan`, a Tailscale MagicDNS name), add it to `LH_ALLOWED_HOSTS` on the server:

```sh
LH_ALLOWED_HOSTS=myserver.lan,myserver.tailnet.ts.net npm run start:remote
```

### Run it as a service (systemd, user)

`~/.config/systemd/user/learnharness.service`:

```ini
[Unit]
Description=LearnHarness server
After=network-online.target

[Service]
WorkingDirectory=%h/Projects/learnharness
ExecStart=/usr/bin/npm run start:remote
Restart=on-failure
# Environment=LH_ALLOWED_HOSTS=myserver.lan

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now learnharness
loginctl enable-linger "$USER"   # keep it running while you are logged out
```

## On your computer

On Windows and Linux you can use the small native client instead of the Electron app: see [Desktop client (Tauri)](desktop-client.md). It shows a connect page on launch when the server is unreachable, and uses the same **Settings → General → Server** row.

1. Open the desktop app → **Settings → General → Server**.
2. Choose **Remote server**, enter the address (for example `http://192.168.1.20:3000`), and press **Test**.
3. Press **Apply & restart**.

The choice is stored on your computer, not on the server. To go back, choose **This computer** and apply again. If the server can't be reached at launch, the app offers **Retry**, **Edit URL** (starts locally and opens this setting), **Use local** (this launch only), or **Quit**.

## What changes in remote mode

- **Models, keys, and learning data** are the server's. Configure providers in Settings as usual. The changes are saved on the server.
- **Claude Code** runs on the server: install and sign in to the CLI there (over SSH is fine). See [Claude Code](claude-code.md).
- **Subscriptions.** ChatGPT, GitHub Copilot, and Grok connections are held and refreshed by the server. Sign in from Settings → Providers. The provider page opens in your computer's browser. For ChatGPT, the desktop app briefly listens on your computer's loopback port and forwards the sign-in callback to the server.
- **Dictation** works over plain HTTP: the desktop app treats the server's address as a secure origin for the microphone.
- **Files.** Your computer's paths don't exist on the server, so attachments are uploaded to the server instead.
- **Updates.** The desktop app updates itself. Update the server's checkout separately (`git pull`, `npm ci`, `npm run build`, restart). Keep both at the same version.
