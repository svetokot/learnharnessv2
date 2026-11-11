"use strict";
/**
 * Server connection (remote-client wave): which LearnHarness server this
 * desktop window talks to. "local" = the bundled server child on 127.0.0.1
 * (the default, unchanged behavior). "remote" = an already-running server
 * elsewhere on the LAN/VPN, loaded directly with no spawned child.
 *
 * Stored per CLIENT in userData/connection.json — never on the server, whose
 * settings are shared by every client that connects.
 *
 * A remote server is trusted the way the network is trusted: no access
 * token, no TLS (owner decision — LAN/VPN only).
 */
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const FILE = "connection.json";
const LOCAL = Object.freeze({ mode: "local", url: null });

/** A remote server URL is an origin only: http(s), no credentials, no
 *  path/query/fragment. Returns the canonical origin or null. */
function normalizeServerURL(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 2048) return null;
	let url;
	try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`); } catch { return null; }
	if (!["http:", "https:"].includes(url.protocol)) return null;
	if (url.username || url.password || url.search || url.hash) return null;
	if (url.pathname !== "/" && url.pathname !== "") return null;
	if (!url.hostname) return null;
	return url.origin;
}

function normalizeConnection(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...LOCAL };
	const url = normalizeServerURL(raw.url);
	if (raw.mode === "remote" && url) return { mode: "remote", url };
	// A local record may remember the last remote URL for the settings field.
	return { mode: "local", url: url ?? null };
}

/** Absent/corrupt/unreadable → local: a broken file must never strand the app. */
function readConnection(userData) {
	try {
		return normalizeConnection(JSON.parse(fs.readFileSync(path.join(userData, FILE), "utf8")));
	} catch {
		return { ...LOCAL };
	}
}

/** Atomic write (temp + rename). Throws on an invalid remote record. */
function writeConnection(userData, next) {
	const record = normalizeConnection(next);
	if (next?.mode === "remote" && record.mode !== "remote") throw new Error("Enter a server address like http://192.168.1.20:3000");
	fs.mkdirSync(userData, { recursive: true });
	const file = path.join(userData, FILE);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(record, null, "\t") + "\n", { mode: 0o600 });
	fs.renameSync(temp, file);
	return record;
}

/** Plain-HTTP remote origins are not secure contexts, so Chromium would hide
 *  getUserMedia (dictation). Loopback is already secure; https needs nothing. */
function needsInsecureOriginGrant(origin) {
	try {
		const url = new URL(origin);
		if (url.protocol !== "http:") return false;
		const host = url.hostname.replace(/^\[|\]$/g, "");
		return !(host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host));
	} catch { return false; }
}

/** Is a LearnHarness server answering at this origin? Any HTTP response from
 *  GET /api/settings with JSON counts; a timeout/refusal/non-JSON does not. */
function probeServer(origin, { timeoutMs = 4000 } = {}) {
	return new Promise((resolve) => {
		let target;
		try { target = new URL("/api/settings", origin); } catch { resolve({ ok: false, error: "Invalid server address." }); return; }
		const client = target.protocol === "https:" ? https : http;
		const req = client.get(target, { timeout: timeoutMs, headers: { Accept: "application/json" } }, (res) => {
			const type = String(res.headers["content-type"] ?? "");
			res.resume();
			if (res.statusCode === 200 && type.includes("application/json")) resolve({ ok: true });
			else if (res.statusCode === 403) resolve({ ok: false, error: "The server refused this address. Use its IP address, or add the name to LH_ALLOWED_HOSTS on the server." });
			else resolve({ ok: false, error: `Not a LearnHarness server (HTTP ${res.statusCode}).` });
		});
		req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "The server did not answer in time." }); });
		req.on("error", (err) => resolve({ ok: false, error: err?.code === "ECONNREFUSED" ? "Connection refused. Is the server running?" : "The server could not be reached." }));
	});
}

module.exports = { normalizeServerURL, normalizeConnection, readConnection, writeConnection, needsInsecureOriginGrant, probeServer, FILE };
