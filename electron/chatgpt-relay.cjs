"use strict";
/**
 * ChatGPT sign-in relay for a REMOTE server (remote-client wave).
 *
 * ChatGPT's OAuth redirect targets http://127.0.0.1:<port>/auth/callback —
 * the loopback listener of the server that started the sign-in. With the
 * server on another machine, the learner's browser would hit THIS client's
 * loopback instead. So for the sign-in's lifetime this client listens on
 * the same port and forwards the callback query to the server's
 * /api/subscriptions/chatgpt-callback, which hands it to its waiting
 * listener. The server listener alone verifies state and code; this relay
 * only routes one request.
 */
const http = require("node:http");

const RELAY_TIMEOUT_MS = 10 * 60_000;

/** The redirect port of a ChatGPT authorize URL, or null if it is not a
 *  loopback /auth/callback target. */
function chatGPTRelayPort(target) {
	try {
		const authorize = new URL(target);
		if (authorize.protocol !== "https:") return null;
		const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
		if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/auth/callback" || !redirect.port) return null;
		const port = Number(redirect.port);
		return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
	} catch { return null; }
}

/** Listen on 127.0.0.1:port until one callback is relayed, the timeout
 *  passes, or close() is called. Resolves once listening (rejects if the
 *  port is taken on this client). */
function startChatGPTRelay({ port, origin, fetch: request = globalThis.fetch, timeoutMs = RELAY_TIMEOUT_MS, log = () => {} }) {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		let timer;
		const close = () => { clearTimeout(timer); server.close(); server.closeAllConnections?.(); };
		server.on("request", async (req, res) => {
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("Referrer-Policy", "no-referrer");
			let url;
			try { url = new URL(req.url || "/", `http://127.0.0.1:${port}`); } catch { res.writeHead(400).end(); return; }
			if (req.method !== "GET" || url.pathname !== "/auth/callback" || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(404).end(); return; }
			try {
				const relayed = await request(new URL("/api/subscriptions/chatgpt-callback", origin), {
					method: "POST",
					headers: { origin, "content-type": "application/json", "x-learnharness-subscriptions": "1" },
					body: JSON.stringify({ search: url.search }),
					signal: AbortSignal.timeout(30_000),
				});
				const result = await relayed.json().catch(() => ({}));
				if (relayed.ok && typeof result.status === "number") {
					res.writeHead(result.status, { "content-type": "text/plain; charset=utf-8" }).end(typeof result.body === "string" ? result.body : "");
					if (result.status === 200) close();
				} else {
					res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(result.error ?? "The sign-in could not be delivered to the LearnHarness server.");
				}
			} catch (err) {
				log(`chatgpt relay failed: ${err?.message ?? err}`);
				res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("The LearnHarness server could not be reached.");
			}
		});
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			timer = setTimeout(close, timeoutMs);
			resolve({ close, port });
		});
	});
}

module.exports = { chatGPTRelayPort, startChatGPTRelay, RELAY_TIMEOUT_MS };
