import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, request as httpRequest } from "node:http";
import { chatGPTCallbackPortOf } from "../src/server/web-subscriptions.ts";

const require = createRequire(import.meta.url);
const { chatGPTRelayPort, startChatGPTRelay } = require("../electron/chatgpt-relay.cjs");

const authorize = (redirect: string) => `https://auth.openai.com/oauth/authorize?${new URLSearchParams({ client_id: "x", redirect_uri: redirect, state: "s" })}`;

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** Raw GET so the Host header is exactly what a browser would send. */
function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
			let body = "";
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("ChatGPT callback port", () => {
	it("accepts only a loopback /auth/callback redirect, on client and server alike", () => {
		for (const parse of [chatGPTRelayPort, chatGPTCallbackPortOf]) {
			assert.equal(parse(authorize("http://127.0.0.1:43123/auth/callback")), 43123);
			for (const bad of [
				authorize("http://localhost:43123/auth/callback"),
				authorize("http://127.0.0.1:43123/other"),
				authorize("https://127.0.0.1:43123/auth/callback"),
				authorize("http://10.0.0.5:43123/auth/callback"),
				authorize("http://127.0.0.1/auth/callback"),
				"not a url",
			]) assert.equal(parse(bad), null, bad);
		}
		assert.equal(chatGPTRelayPort("http://auth.openai.com/?redirect_uri=http://127.0.0.1:1/auth/callback"), null);
	});
});

describe("ChatGPT callback relay", () => {
	it("forwards the browser's callback query to the remote server once, then closes", async () => {
		const posted: Array<{ search: string; origin: string | undefined; marker: string | undefined }> = [];
		const remote = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				assert.equal(req.method, "POST");
				assert.equal(req.url, "/api/subscriptions/chatgpt-callback");
				posted.push({ search: JSON.parse(body).search, origin: req.headers.origin, marker: req.headers["x-learnharness-subscriptions"] as string | undefined });
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: 200, body: "Return to LearnHarness." }));
			});
		});
		await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
		const origin = `http://127.0.0.1:${(remote.address() as { port: number }).port}`;
		const port = await freePort();
		const relay = await startChatGPTRelay({ port, origin });
		try {
			assert.equal((await get(port, "/elsewhere")).status, 404);
			const answered = await get(port, "/auth/callback?code=c&state=s");
			assert.deepEqual(answered, { status: 200, body: "Return to LearnHarness." });
			assert.deepEqual(posted, [{ search: "?code=c&state=s", origin, marker: "1" }]);
			await assert.rejects(get(port, "/auth/callback?code=again&state=s"), "the relay closes after one delivered sign-in");
		} finally {
			relay.close();
			await new Promise((resolve) => remote.close(resolve));
		}
	});

	it("reports an unreachable server to the browser instead of hanging", async () => {
		const port = await freePort();
		const deadOrigin = `http://127.0.0.1:${await freePort()}`;
		const relay = await startChatGPTRelay({ port, origin: deadOrigin });
		try {
			const answered = await get(port, "/auth/callback?code=c&state=s");
			assert.equal(answered.status, 502);
		} finally {
			relay.close();
		}
	});

	it("refuses to start when the port is taken on this client", async () => {
		const busy = createServer();
		await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
		const port = (busy.address() as { port: number }).port;
		try {
			await assert.rejects(startChatGPTRelay({ port, origin: "http://127.0.0.1:1" }));
		} finally {
			await new Promise((resolve) => busy.close(resolve));
		}
	});
});

describe("server side of the relay", () => {
	it("routes a relayed callback to the pending listener, which still verifies state", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const path = await import("node:path");
		const { createWebSubscriptionOwner } = await import("../src/server/web-subscriptions.ts");
		const dir = mkdtempSync(path.join(tmpdir(), "lh-relay-"));
		const owner = createWebSubscriptionOwner({ directory: dir });
		try {
			assert.equal(await owner.relayChatGPTCallback("?code=c&state=s"), undefined, "nothing pending yet");
			const started = await owner.control("chatgpt", { op: "login" }, "http://10.0.0.5:3000");
			assert.match(String(started.browserAction), /^\/api\/subscriptions\/browser\?id=/);
			const relayed = await owner.relayChatGPTCallback("?code=c&state=forged");
			assert.deepEqual(relayed, { status: 400, body: "Sign-in could not be verified." });
		} finally {
			owner.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
