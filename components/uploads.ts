/**
 * Client side of learner uploads (remote-client wave). Used whenever this
 * window has no server-valid paths — a plain browser tab, or the desktop app
 * connected to a remote server (preload withholds the path bridge there).
 * Files and folders upload to POST /api/uploads; the returned SERVER paths
 * are inserted like picked paths. Server side: src/server/uploads.ts.
 */

/** Owner: 200 MB per upload batch (mirrors MAX_UPLOAD_BATCH_BYTES). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const UPLOAD_TOO_LARGE = "Uploads are limited to 200 MB at a time.";
export const UPLOAD_FAILED = "The upload failed. Try again.";

/** One file to upload with its path relative to the batch ("a.pdf",
 *  "notes/week1/a.pdf" for a folder's contents). */
export interface UploadItem { file: File; path: string }

/** No path bridge → attachments upload instead. SSR is the browser case. */
export function uploadsActive(lh: { getPathForFile?: unknown } | undefined = typeof window === "undefined" ? undefined : window.lh): boolean {
	return !lh?.getPathForFile;
}

/** The open chat, from the URL (/chat/<id>); the new-session screen has none
 *  — its uploads wait server-side until the session is created. */
export function currentChatId(pathname: string = typeof location === "undefined" ? "" : location.pathname): string | null {
	const match = /^\/chat\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
	return match && match[1] !== "new" ? match[1]! : null;
}

/** From an <input type=file> (multiple, or webkitdirectory for a folder). */
export function itemsFromFileList(files: Iterable<File>): UploadItem[] {
	return Array.from(files, (file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
}

interface EntryLike {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?(success: (file: File) => void, failure?: (error: unknown) => void): void;
	createReader?(): { readEntries(success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void): void };
}

async function walk(entry: EntryLike, prefix: string, out: UploadItem[]): Promise<void> {
	const path = prefix ? `${prefix}/${entry.name}` : entry.name;
	if (entry.isFile && entry.file) {
		out.push({ file: await new Promise<File>((resolve, reject) => entry.file!(resolve, reject)), path });
		return;
	}
	if (!entry.isDirectory || !entry.createReader) return;
	const reader = entry.createReader();
	// readEntries returns batches (≈100) until an empty one.
	for (;;) {
		const batch = await new Promise<EntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
		if (batch.length === 0) break;
		for (const child of batch) await walk(child, path, out);
	}
}

/** A drop's files, folders walked recursively (relative paths kept). Falls
 *  back to the flat file list when entries are unavailable. */
export async function itemsFromDataTransfer(transfer: DataTransfer): Promise<UploadItem[]> {
	const entries = Array.from(transfer.items ?? [])
		.filter((item) => item.kind === "file")
		.map((item) => { try { return item.webkitGetAsEntry?.() as EntryLike | null; } catch { return null; } });
	if (entries.length === 0 || entries.some((entry) => !entry)) return itemsFromFileList(Array.from(transfer.files));
	const out: UploadItem[] = [];
	for (const entry of entries) await walk(entry!, "", out);
	return out;
}

/** Upload one batch; resolves to the server paths to insert. */
export async function uploadItems(items: readonly UploadItem[], { fetchLike = fetch, chatId = currentChatId() }: { fetchLike?: typeof fetch; chatId?: string | null } = {}): Promise<string[]> {
	if (items.length === 0) return [];
	if (items.reduce((sum, item) => sum + item.file.size, 0) > MAX_UPLOAD_BYTES) throw new Error(UPLOAD_TOO_LARGE);
	const form = new FormData();
	if (chatId) form.append("chatId", chatId);
	for (const item of items) {
		form.append("path", item.path);
		form.append("file", item.file);
	}
	let response: Response;
	try { response = await fetchLike("/api/uploads", { method: "POST", body: form }); }
	catch { throw new Error(UPLOAD_FAILED); }
	const result = await response.json().catch(() => ({})) as { paths?: unknown; error?: unknown };
	if (!response.ok || !Array.isArray(result.paths) || !result.paths.every((p) => typeof p === "string")) {
		throw new Error(typeof result.error === "string" ? result.error : UPLOAD_FAILED);
	}
	return result.paths as string[];
}
