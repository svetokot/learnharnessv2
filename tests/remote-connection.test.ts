import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { activeServerText, connectionChanged, SERVER_HINT_LOCAL } from "../components/settings/server-connection.tsx";

const require = createRequire(import.meta.url);
const { normalizeServerURL, normalizeConnection, readConnection, writeConnection, needsInsecureOriginGrant, probeServer } = require("../electron/connection.cjs");

describe("remote server address", () => {
	it("keeps only an http(s) origin", () => {
		assert.equal(normalizeServerURL("http://192.168.1.20:3000"), "http://192.168.1.20:3000");
		assert.equal(normalizeServerURL("http://192.168.1.20:3000/"), "http://192.168.1.20:3000");
		assert.equal(normalizeServerURL(" 10.0.0.5:3000 "), "http://10.0.0.5:3000");
		assert.equal(normalizeServerURL("https://lh.tailnet.ts.net"), "https://lh.tailnet.ts.net");
		for (const bad of ["", "ftp://host", "http://user:pw@host:3000", "http://host:3000/chat", "http://host:3000/?x=1", "http://host#a", "file:///etc", 42, null, "x".repeat(3000)]) {
			assert.equal(normalizeServerURL(bad), null, String(bad));
		}
	});

	it("falls back to local for anything but a valid remote record", () => {
		assert.deepEqual(normalizeConnection(null), { mode: "local", url: null });
		assert.deepEqual(normalizeConnection({ mode: "remote", url: "nope://x" }), { mode: "local", url: null });
		assert.deepEqual(normalizeConnection({ mode: "remote", url: "http://10.0.0.5:3000" }), { mode: "remote", url: "http://10.0.0.5:3000" });
		assert.deepEqual(normalizeConnection({ mode: "local", url: "http://10.0.0.5:3000" }), { mode: "local", url: "http://10.0.0.5:3000" });
	});

	it("only plain-http non-loopback origins need the secure-context grant", () => {
		assert.equal(needsInsecureOriginGrant("http://192.168.1.20:3000"), true);
		assert.equal(needsInsecureOriginGrant("http://myserver.lan:3000"), true);
		assert.equal(needsInsecureOriginGrant("https://192.168.1.20"), false);
		assert.equal(needsInsecureOriginGrant("http://127.0.0.1:3000"), false);
		assert.equal(needsInsecureOriginGrant("http://localhost:3000"), false);
		assert.equal(needsInsecureOriginGrant("http://[::1]:3000"), false);
	});
});

describe("connection record on the client", () => {
	it("round-trips, refuses an invalid remote, and survives corruption", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "lh-conn-"));
		try {
			assert.deepEqual(readConnection(dir), { mode: "local", url: null });
			writeConnection(dir, { mode: "remote", url: "http://10.0.0.5:3000/" });
			assert.deepEqual(readConnection(dir), { mode: "remote", url: "http://10.0.0.5:3000" });
			assert.throws(() => writeConnection(dir, { mode: "remote", url: "ftp://x" }));
			assert.deepEqual(readConnection(dir), { mode: "remote", url: "http://10.0.0.5:3000" });
			writeFileSync(path.join(dir, "connection.json"), "{not json");
			assert.deepEqual(readConnection(dir), { mode: "local", url: null });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("server probe", () => {
	async function serve(handler: Parameters<typeof createServer>[1]) {
		const server = createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as { port: number };
		return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
	}

	it("accepts a JSON /api/settings answer and explains other answers", async () => {
		const ok = await serve((req, res) => {
			assert.equal(req.url, "/api/settings");
			res.writeHead(200, { "Content-Type": "application/json" }).end("{\"settings\":null}");
		});
		const refused = await serve((_req, res) => { res.writeHead(403, { "Content-Type": "application/json" }).end("{}"); });
		const other = await serve((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }).end("<html>"); });
		try {
			assert.deepEqual(await probeServer(ok.origin), { ok: true });
			assert.match((await probeServer(refused.origin)).error, /LH_ALLOWED_HOSTS/);
			assert.match((await probeServer(other.origin)).error, /Not a LearnHarness server/);
		} finally {
			await Promise.all([ok.close(), refused.close(), other.close()]);
		}
		const gone = await probeServer(ok.origin, { timeoutMs: 500 });
		assert.equal(gone.ok, false);
	});
});

describe("preload in remote mode", () => {
	function bridge(argv: string[]) {
		let surface: Record<string, unknown> = {};
		const invoked: unknown[][] = [];
		runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), {
			process: { platform: "linux", argv },
			require: () => ({
				contextBridge: { exposeInMainWorld(_name: string, value: Record<string, unknown>) { surface = value; } },
				webUtils: { getPathForFile: () => "/client/path" },
				ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve(); } },
			}),
		});
		return { surface, invoked };
	}

	it("withholds client paths and marks the window remote", () => {
		const { surface } = bridge(["--lh-remote"]);
		assert.equal(surface.remote, true);
		assert.equal(surface.getPathForFile, undefined);
		assert.equal(surface.chooseAttachmentFolder, undefined);
	});

	it("keeps the path bridge locally and exposes the connection channels", async () => {
		const { surface, invoked } = bridge([]);
		assert.equal(surface.remote, undefined);
		assert.equal(typeof surface.getPathForFile, "function");
		const connection = surface.connection as { get(): Promise<unknown>; test(url: string): Promise<unknown>; apply(next: unknown): Promise<unknown> };
		await connection.get();
		await connection.test("http://10.0.0.5:3000");
		await connection.apply({ mode: "local", url: null });
		assert.deepEqual(invoked.map((call) => call[0]), ["lh:connection:get", "lh:connection:test", "lh:connection:apply"]);
	});
});

describe("Settings → Server row helpers", () => {
	it("describes the active launch and detects real changes", () => {
		assert.equal(activeServerText({ mode: "local", url: null }), SERVER_HINT_LOCAL);
		assert.equal(activeServerText({ mode: "remote", url: "http://10.0.0.5:3000" }), "Connected to http://10.0.0.5:3000.");
		const local = { mode: "local" as const, url: null };
		assert.equal(connectionChanged(local, "local", "http://x"), false);
		assert.equal(connectionChanged(local, "remote", "http://x"), true);
		const remote = { mode: "remote" as const, url: "http://10.0.0.5:3000" };
		assert.equal(connectionChanged(remote, "remote", "http://10.0.0.5:3000 "), false);
		assert.equal(connectionChanged(remote, "remote", "http://10.0.0.6:3000"), true);
	});
});
