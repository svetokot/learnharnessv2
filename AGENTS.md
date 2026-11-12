<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

# Project context (fork additions, 2026-11)

Five features were added on top of upstream LearnHarness 0.6.0 and merged into `main` (fast-forward, 2026-11-12) from the stacked branches `feat/remote-client` → `feat/claude-cli-polish` → `feat/stt-engines` → `feat/ui-identity` → `feat/tauri-client`.

## Remote server + desktop client
- The server runs headless with `npm run build && npm run start:remote`, which binds `0.0.0.0`. There is **no auth** by owner decision: trusted LAN/VPN only. Host names other than IPs and localhost need `LH_ALLOWED_HOSTS`. Setup: `docs/remote.md`.
- Desktop: Settings → General → Server (`components/settings/server-connection.tsx`).
  - The choice is stored per client in `userData/connection.json` (`electron/connection.cjs`).
  - Remote launches spawn no server child.
  - A plain-HTTP origin gets `--unsafely-treat-insecure-origin-as-secure`, so the mic works. Verified in Electron 44 on Linux.
- Remote windows get `--lh-remote --lh-web-subscriptions`. Preload then withholds `getPathForFile` and `chooseAttachmentFolder`.
  - Subscriptions use the server's web owner (`src/server/web-subscriptions.ts`).
  - ChatGPT's loopback OAuth callback is relayed client → server by `electron/chatgpt-relay.cjs` and `POST /api/subscriptions/chatgpt-callback`.
- Uploads apply whenever there is no path bridge (browser or remote desktop). Code: `src/server/uploads.ts`, `components/uploads.ts`.
  - The route is `POST /api/uploads`, capped at 200 MB per batch.
  - Files land in `data/uploads/<chatId>/<batch>/`. Batches attached before a chat exists wait in `data/uploads-pending/`; they are claimed in `POST /api/chats`, which returns `opening`, and swept after 24h.
  - A chat's uploads are deleted with the chat. `data/uploads/` is always readable by the file tools, even when File access is restricted.
- Proxy-exempt routes are `/api/uploads` and `/api/stt/transcribe`, because Proxy truncates bodies at its clone limit. Each runs `apiRequestRefusal` inline. Keep `proxy.ts` matcher literals in sync.

## Claude
- The Claude Pro/Max subscription is used **only via the Claude Code CLI provider**, never OAuth in-app (Anthropic terms).
- The CLI must be installed and signed in on the server machine. The Providers panel shows the server host (`/api/claude-code` returns `host`). Docs: `docs/claude-code.md`.

## Dictation engines
- The `speech` settings section (`src/core/speech.ts`) is separate from `dictation`, because sections are replace-whole. Engines: `deepgram` (streaming, unchanged), `whisper-local`, `openai`.
- Batch engines record in `useDictation` (the `batchRef` seam in `components/dictation.tsx`), encode WAV (`components/speech-engine.ts`), and `POST /api/stt/transcribe` (`src/server/stt.ts`, 50 MB cap). The engine is read from `GET /api/stt/engine`.
- whisper-server:
  - Found on PATH or via `LH_WHISPER_SERVER`. Deliberately **not** a setting, since the API has no auth.
  - Spawned on 127.0.0.1 and health-gated (`/health`), with `/inference` multipart. Stopped after 10 idle minutes.
  - Models download from `huggingface.co/ggerganov/whisper.cpp` into `data/whisper/models/`. The default is `large-v3-turbo-q8_0` (benchmarked fastest-and-most-faithful on the 1660 Ti; f16 is ~3× slower without tensor cores). An optional `speech.prompt` (punctuated bilingual text) is sent as Whisper's initial prompt.
- The target server has a GTX 1660 Ti. Installed there: official `whisper-cpp` 1.9.5 + `ggml-cuda` (CUDA 13), giving `/usr/bin/whisper-server`. Owner setup: engine `whisper-local`, model q8_0, language `multi` (Russian + English), bilingual prompt.

## Visual identity
- `appearance.uiStyle` is `editorial` (default) or `classic`, stamped as `<html data-ui-style>`. `--font-ui` reads the runtime variable `--lh-font-ui`. Editorial overrides live at the end of `app/globals.css`.
- Default theme = warm charcoal with a brass accent; its emphasis inks equal the text color (owner ruling). `Paper` is the light preset; `Classic` is the original palette.
- `app/globals.css` `:root` must equal `themeVars(DEFAULT_THEME)` (`tests/themes.test.ts`), and `electron/appearance-chrome.cjs` `PRESET_APPEARANCE` must list every preset.

## Native desktop client (Tauri)
- `desktop/` (Rust, Tauri 2.12, pinned crates) replaces Electron on Windows and Linux by owner request. Electron is kept as-is. The client is **client only** (owner decision): it never spawns a server. "This computer" = `http://127.0.0.1:3000`. Docs: `docs/desktop-client.md`.
- The window loads a loopback reverse proxy (`desktop/src/proxy.rs`, persisted port), so LAN plain-HTTP servers are secure contexts and the mic works. This was verified in WebKitGTK; LAN origins are NOT secure there otherwise.
  - The proxy only accepts its own Host/Origin, and rewrites Origin/Referer/Location.
- `window.lh` is `desktop/src/bridge.js`. It reports `remote: true` and `subscriptionTransport: "web"`, and has no path bridge and no updater. Command access for the page is in `desktop/capabilities/*.json` and the command list in `desktop/build.rs`; keep them in sync.
- Builds and checks:
  - Linux: `desktop/scripts/install-linux.sh` (→ `~/.local`).
  - Windows: `.github/workflows/desktop-tauri.yml` (NSIS). Not built locally; it only type-checks with the official rustc plus the `x86_64-pc-windows-msvc` rust-std, because Arch's rustc can't use the official std.
  - TLS is `native-tls`; rustls' aws-lc needs a C toolchain for Windows.
  - Debug-only verification seams: `LH_DESKTOP_PROBE`, `LH_DESKTOP_SNAPSHOT`.
  - Keep `CARGO_TARGET_DIR` outside the repo (the install script uses `~/.cache/learnharness-desktop/target`). An in-repo `desktop/target` roughly doubles `next build` time through whole-project tracing.
- Note: `/api/events` sends no headers until its first frame (25 s heartbeat) under `next start`, so EventSource `onopen` fires late. This is pre-existing server behavior, not the proxy.

## Working notes
- Test baseline: `npm test` has **4 known failures**, the plugin-SDK type tests (`plugin-view-types`, `plugin-document-types`, ~44s each). They fail on clean upstream main too.
- `npm ci` blocks install scripts for esbuild, unrs-resolver, protobufjs, electron-winstaller and @google/genai. Nothing needed them so far; approving them is the owner's call.
- Run `npm run plugins:setup` after `npm ci`, or typecheck and tests fail.
- Only one `next dev` per checkout. `tests/fixtures/golden-data` is a full data dir, good for `LH_DATA_DIR` screenshots.
