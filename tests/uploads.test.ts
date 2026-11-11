import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { config } from "../proxy.ts";
import { claimPendingUploads, deleteChatUploads, safeRelativePath, saveUploadBatch, sweepPendingUploads, uploadsRootIfPresent, UploadError } from "../src/server/uploads.ts";
import { currentChatId, itemsFromFileList, uploadItems, uploadsActive, UPLOAD_TOO_LARGE } from "../components/uploads.ts";

function roots() {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-uploads-"));
	return { dir, roots: { uploads: path.join(dir, "uploads"), pending: path.join(dir, "uploads-pending") } };
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe("upload path safety", () => {
	it("keeps relative segments and refuses traversal or absolute escapes", () => {
		assert.deepEqual(safeRelativePath("notes/week 1/a.pdf"), ["notes", "week 1", "a.pdf"]);
		assert.deepEqual(safeRelativePath("notes\\\\a.pdf"), ["notes", "a.pdf"]);
		assert.deepEqual(safeRelativePath("/abs/a.pdf"), ["abs", "a.pdf"], "a leading slash cannot escape the batch");
		assert.deepEqual(safeRelativePath("a:b?.txt"), ["a_b_.txt"]);
		assert.deepEqual(safeRelativePath("trailing."), ["trailing_"]);
		for (const bad of ["", "../x", "a/../../x", "a/./b", "nul\0", "x".repeat(300), Array(40).fill("d").join("/")]) {
			assert.equal(safeRelativePath(bad), null, bad);
		}
	});
});

describe("upload batches", () => {
	it("writes per-chat batches and returns one reference per top-level entry", () => {
		const { dir, roots: r } = roots();
		try {
			const { batchDir, paths } = saveUploadBatch("chat_1", [
				{ relativePath: "a.pdf", data: bytes("A") },
				{ relativePath: "notes/w1.md", data: bytes("W1") },
				{ relativePath: "notes/sub/w2.md", data: bytes("W2") },
			], r);
			assert.ok(batchDir.startsWith(path.join(r.uploads, "chat_1") + path.sep));
			assert.deepEqual(paths, [path.join(batchDir, "a.pdf"), path.join(batchDir, "notes") + path.sep]);
			assert.equal(readFileSync(path.join(batchDir, "notes", "sub", "w2.md"), "utf8"), "W2");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("parks batches without an existing chat in uploads-pending", () => {
		const { dir, roots: r } = roots();
		try {
			assert.ok(saveUploadBatch(null, [{ relativePath: "a.pdf", data: bytes("A") }], r).batchDir.startsWith(r.pending + path.sep));
			assert.ok(saveUploadBatch("gone", [{ relativePath: "a.pdf", data: bytes("A") }], r, () => false).batchDir.startsWith(r.pending + path.sep));
			assert.ok(saveUploadBatch("../evil", [{ relativePath: "a.pdf", data: bytes("A") }], r).batchDir.startsWith(r.pending + path.sep));
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("refuses empty, duplicate, conflicting and unsafe batches without leaving files", () => {
		const { dir, roots: r } = roots();
		try {
			assert.throws(() => saveUploadBatch("c", [], r), UploadError);
			assert.throws(() => saveUploadBatch("c", [{ relativePath: "a", data: bytes("1") }, { relativePath: "a", data: bytes("2") }], r), /Duplicate/);
			assert.throws(() => saveUploadBatch("c", [{ relativePath: "a", data: bytes("1") }, { relativePath: "a/b", data: bytes("2") }], r), /Conflicting/);
			assert.throws(() => saveUploadBatch("c", [{ relativePath: "../x", data: bytes("1") }], r), /Invalid file name/);
			assert.equal(existsSync(path.join(r.uploads, "c")), false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("pending uploads lifecycle", () => {
	it("claims referenced pending batches into the chat and rewrites their paths", () => {
		const { dir, roots: r } = roots();
		try {
			const { paths } = saveUploadBatch(null, [{ relativePath: "notes/a.md", data: bytes("A") }], r);
			const text = `Teach me from \`${paths[0]}\` please`;
			const claimed = claimPendingUploads("chat_9", text, r);
			const moved = paths[0]!.replace(r.pending, path.join(r.uploads, "chat_9"));
			assert.equal(claimed, `Teach me from \`${moved}\` please`);
			assert.equal(readFileSync(path.join(moved, "a.md"), "utf8"), "A");
			assert.equal(claimPendingUploads("chat_9", text, r), text, "an already-claimed batch is left alone");
			assert.equal(claimPendingUploads("chat_9", "no uploads here", r), "no uploads here");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("sweeps only stale pending batches, and deletes a chat's uploads", () => {
		const { dir, roots: r } = roots();
		try {
			const fresh = saveUploadBatch(null, [{ relativePath: "a", data: bytes("1") }], r).batchDir;
			const stale = saveUploadBatch(null, [{ relativePath: "b", data: bytes("2") }], r).batchDir;
			const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
			utimesSync(stale, old, old);
			mkdirSync(path.join(r.pending, "not-a-batch"));
			assert.equal(sweepPendingUploads(r), 1);
			assert.equal(existsSync(fresh), true);
			assert.equal(existsSync(stale), false);
			assert.equal(existsSync(path.join(r.pending, "not-a-batch")), true);

			saveUploadBatch("chat_d", [{ relativePath: "a", data: bytes("1") }], r);
			assert.equal(uploadsRootIfPresent(r), r.uploads);
			deleteChatUploads("chat_d", r);
			assert.equal(existsSync(path.join(r.uploads, "chat_d")), false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("upload route is exempt from Proxy body cloning", () => {
	it("matches every other API route but not the exact uploads endpoint", () => {
		const origin = "http://127.0.0.1:3000";
		assert(!unstable_doesProxyMatch({ config, nextConfig: {}, url: `${origin}/api/uploads` }));
		assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: `${origin}/api/uploads/other` }));
		assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: `${origin}/api/uploadsx` }));
		assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: `${origin}/api/settings` }));
	});
});

describe("client upload helper", () => {
	it("is active only without the path bridge, and reads the open chat from the URL", () => {
		assert.equal(uploadsActive(undefined), true);
		assert.equal(uploadsActive({}), true);
		assert.equal(uploadsActive({ getPathForFile: () => "" }), false);
		assert.equal(currentChatId("/chat/abc_1"), "abc_1");
		assert.equal(currentChatId("/chat/new"), null);
		assert.equal(currentChatId("/"), null);
		assert.equal(currentChatId("/chat/a/b"), null);
	});

	it("keeps folder-relative paths and refuses oversized batches before sending", async () => {
		const file = Object.assign(new File(["x"], "w1.md"), { webkitRelativePath: "notes/w1.md" });
		assert.deepEqual(itemsFromFileList([file, new File(["y"], "a.pdf")]).map((item) => item.path), ["notes/w1.md", "a.pdf"]);
		const huge = new File(["x"], "big.bin");
		Object.defineProperty(huge, "size", { value: 201 * 1024 * 1024 });
		let calls = 0;
		await assert.rejects(uploadItems([{ file: huge, path: "big.bin" }], { fetchLike: (async () => { calls++; return Response.json({}); }) as typeof fetch }), new RegExp(UPLOAD_TOO_LARGE));
		assert.equal(calls, 0);
	});

	it("sends the chat id and surfaces the server's error text", async () => {
		const bodies: FormData[] = [];
		const ok = (async (_url: unknown, init?: RequestInit) => { bodies.push(init!.body as FormData); return Response.json({ paths: ["/srv/a"] }); }) as typeof fetch;
		assert.deepEqual(await uploadItems([{ file: new File(["a"], "a"), path: "a" }], { fetchLike: ok, chatId: "c1" }), ["/srv/a"]);
		assert.equal(bodies[0]!.get("chatId"), "c1");
		const refused = (async () => Response.json({ error: "Nope." }, { status: 400 })) as typeof fetch;
		await assert.rejects(uploadItems([{ file: new File(["a"], "a"), path: "a" }], { fetchLike: refused, chatId: null }), /Nope\./);
	});
});
