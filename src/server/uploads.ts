/**
 * Learner uploads (remote-client wave). A remote desktop or a plain browser
 * has no paths on the server's disk, so attached files and folders are
 * uploaded and the message carries the SERVER path instead — the agent's
 * file tools then work unchanged.
 *
 *   uploads/<chatId>/<batch>/<relative path…>   per chat, deleted with it
 *   uploads-pending/<batch>/…                    before the chat exists;
 *                                                 claimed at creation,
 *                                                 swept after 24h
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

/** One upload request's total size (owner: 200 MB per batch). */
export const MAX_UPLOAD_BATCH_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 5000;
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_ID = /^[A-Za-z0-9_-]+$/;
const BATCH_ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
const MAX_DEPTH = 32;

export interface UploadRoots { uploads: string; pending: string }
const DEFAULT_ROOTS: UploadRoots = { uploads: PATHS.uploads, pending: PATHS.uploadsPending };

export class UploadError extends Error {}

/** A client-supplied relative path → safe segments, or null. No absolute
 *  paths, no traversal, no empty/dot segments, no control or reserved
 *  characters; each segment ≤ 255 bytes. */
export function safeRelativePath(raw: string): string[] | null {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || raw.includes("\0")) return null;
	const segments = raw.split(/[\\/]+/).filter((segment) => segment !== "");
	if (segments.length === 0 || segments.length > MAX_DEPTH) return null;
	const clean: string[] = [];
	for (const segment of segments) {
		if (segment === "." || segment === "..") return null;
		const replaced = segment.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/[. ]+$/, "_");
		if (Buffer.byteLength(replaced) > 255) return null;
		clean.push(replaced);
	}
	return clean;
}

function newBatchId(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `${stamp}-${randomBytes(4).toString("hex")}`;
}

/** A directory reference ends with the platform separator — the same
 *  convention as directoryReferencePath for picked folders. */
function directoryReference(absolute: string): string {
	return absolute.endsWith(path.sep) ? absolute : absolute + path.sep;
}

export interface UploadedFile { relativePath: string; data: Uint8Array }

/**
 * Write one batch. Returns the references to insert into the draft: one per
 * TOP-LEVEL entry — a file's path, or a folder's path with a trailing
 * separator when the entry had children (an uploaded folder).
 */
export function saveUploadBatch(
	chatId: string | null,
	files: readonly UploadedFile[],
	roots: UploadRoots = DEFAULT_ROOTS,
	chatExists: (id: string) => boolean = () => true,
): { batchDir: string; paths: string[] } {
	if (files.length === 0) throw new UploadError("No files were uploaded.");
	if (files.length > MAX_UPLOAD_FILES) throw new UploadError(`At most ${MAX_UPLOAD_FILES} files can be uploaded at once.`);
	const owner = chatId && CHAT_ID.test(chatId) && chatExists(chatId) ? chatId : null;
	const batchDir = owner ? path.join(roots.uploads, owner, newBatchId()) : path.join(roots.pending, newBatchId());
	const entries = new Map<string, boolean>(); // top-level name → is a folder
	const seen = new Set<string>();
	const planned = files.map((file) => {
		const segments = safeRelativePath(file.relativePath);
		if (!segments) throw new UploadError(`Invalid file name: ${String(file.relativePath).slice(0, 200)}`);
		const key = segments.join("/");
		if (seen.has(key)) throw new UploadError(`Duplicate file: ${key}`);
		seen.add(key);
		const top = segments[0]!;
		entries.set(top, (entries.get(top) ?? false) || segments.length > 1);
		return { segments, data: file.data };
	});
	for (const [top, folder] of entries) {
		// A name cannot be both a file and a folder in one batch.
		if (folder && planned.some((p) => p.segments.length === 1 && p.segments[0] === top)) throw new UploadError(`Conflicting entry: ${top}`);
	}
	fs.mkdirSync(batchDir, { recursive: true });
	try {
		for (const { segments, data } of planned) {
			const target = path.join(batchDir, ...segments);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, data, { flag: "wx" });
		}
	} catch (error) {
		fs.rmSync(batchDir, { recursive: true, force: true });
		throw error;
	}
	const paths = [...entries].map(([top, folder]) => folder ? directoryReference(path.join(batchDir, top)) : path.join(batchDir, top));
	return { batchDir, paths };
}

/**
 * Move every pending batch the text references into uploads/<chatId>/ and
 * rewrite those references. Unknown/missing batches are left untouched.
 */
export function claimPendingUploads(chatId: string, text: string, roots: UploadRoots = DEFAULT_ROOTS): string {
	if (!CHAT_ID.test(chatId) || !text.includes(roots.pending)) return text;
	const prefix = roots.pending + path.sep;
	const ids = new Set<string>();
	let at = text.indexOf(prefix);
	while (at !== -1) {
		const id = text.slice(at + prefix.length, at + prefix.length + 24);
		if (BATCH_ID.test(id)) ids.add(id);
		at = text.indexOf(prefix, at + prefix.length);
	}
	let result = text;
	for (const id of ids) {
		const from = path.join(roots.pending, id);
		const to = path.join(roots.uploads, chatId, id);
		try {
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.renameSync(from, to);
		} catch { continue; }
		result = result.split(from).join(to);
	}
	return result;
}

/** Delete pending batches older than the TTL (cheap; runs on each upload). */
export function sweepPendingUploads(roots: UploadRoots = DEFAULT_ROOTS, now = Date.now(), ttlMs = PENDING_UPLOAD_TTL_MS): number {
	let removed = 0;
	let names: string[];
	try { names = fs.readdirSync(roots.pending); } catch { return 0; }
	for (const name of names) {
		if (!BATCH_ID.test(name)) continue;
		const dir = path.join(roots.pending, name);
		try {
			if (now - fs.statSync(dir).mtimeMs > ttlMs) {
				fs.rmSync(dir, { recursive: true, force: true });
				removed++;
			}
		} catch { /* raced with a claim or another sweep */ }
	}
	return removed;
}

/** A deleted chat takes its uploads with it. */
export function deleteChatUploads(chatId: string, roots: UploadRoots = DEFAULT_ROOTS): void {
	if (!CHAT_ID.test(chatId)) return;
	try { fs.rmSync(path.join(roots.uploads, chatId), { recursive: true, force: true }); } catch { /* best effort */ }
}

/** The uploads root, if it exists — implicitly allowed for the file tools. */
export function uploadsRootIfPresent(roots: UploadRoots = DEFAULT_ROOTS): string | null {
	try { return fs.statSync(roots.uploads).isDirectory() ? roots.uploads : null; } catch { return null; }
}
