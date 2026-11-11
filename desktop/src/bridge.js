// window.lh for the LearnHarness page (Tauri client). The subset of the
// Electron preload (electron/preload.cjs) that a client-only shell can honor:
//   - remote: true and NO getPathForFile/chooseAttachmentFolder, so
//     attachments upload to the server (components/uploads.ts);
//   - subscriptionTransport "web": sign-ins use the server's web owner and
//     openSubscriptionBrowser resolves the action in Rust;
//   - connection get/test/apply for Settings → General → Server.
// Absent on purpose: updates, zoom pushes, chatgpt/subscriptions IPC.
// Installed only on the proxy origin; injected into the main frame only.
(() => {
	if (location.origin !== "__LH_ORIGIN__") return;
	const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
	const quiet = (promise) => { promise.catch(() => {}); };
	Object.defineProperty(window, "lh", {
		value: Object.freeze({
			platform: "__LH_PLATFORM__",
			shell: "tauri",
			remote: true,
			connection: Object.freeze({
				get: () => invoke("connection_get"),
				test: (url) => invoke("connection_test", { url }),
				apply: (next) => invoke("connection_apply", { next }),
			}),
			subscriptionTransport: "web",
			openSubscriptionBrowser: (action) => invoke("open_subscription_browser", { action }),
			expandWindow: () => quiet(invoke("expand_window")),
			setAppearance: (appearance) => quiet(invoke("set_appearance", { appearance })),
		}),
		configurable: false,
		writable: false,
	});
})();
