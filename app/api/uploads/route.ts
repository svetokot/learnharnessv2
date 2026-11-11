/**
 * POST /api/uploads — learner uploads (remote-client wave). Multipart:
 * optional `chatId`, then pairs of `path` (the relative path, e.g.
 * "notes/week1.pdf") and `file`. Returns { paths }: server paths to insert
 * into the draft (see src/server/uploads.ts).
 *
 * Exempt from Proxy (proxy.ts matcher): Proxy buffers at most 10 MB of a
 * body and silently truncates the rest. The identical request policy runs
 * here first instead.
 */
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data";
import { apiRequestRefusal, MAX_UPLOAD_BATCH_BYTES, MAX_UPLOAD_FILES, saveUploadBatch, stores, sweepPendingUploads, UploadError } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };
/** Multipart framing on top of the file bytes. */
const FORM_OVERHEAD_BYTES = 4 * 1024 * 1024;

export async function POST(request: Request) {
	const refusal = apiRequestRefusal(request);
	if (refusal) return Response.json({ error: refusal }, { status: 403, headers: HEADERS });
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_UPLOAD_BATCH_BYTES + FORM_OVERHEAD_BYTES, request.signal);
	} catch (error) {
		if (error instanceof FormBodyLimitError) return Response.json({ error: "Uploads are limited to 200 MB at a time." }, { status: 413, headers: HEADERS });
		return Response.json({ error: "The upload could not be read." }, { status: 400, headers: HEADERS });
	}
	const chatId = form.get("chatId");
	const names = form.getAll("path");
	const blobs = form.getAll("file");
	if (blobs.length === 0 || names.length !== blobs.length) return Response.json({ error: "Expected one path per file." }, { status: 400, headers: HEADERS });
	if (blobs.length > MAX_UPLOAD_FILES) return Response.json({ error: `At most ${MAX_UPLOAD_FILES} files can be uploaded at once.` }, { status: 413, headers: HEADERS });
	let total = 0;
	const files = [];
	for (const [index, blob] of blobs.entries()) {
		const name = names[index];
		if (typeof blob === "string" || typeof name !== "string") return Response.json({ error: "Expected one path per file." }, { status: 400, headers: HEADERS });
		total += blob.size;
		if (total > MAX_UPLOAD_BATCH_BYTES) return Response.json({ error: "Uploads are limited to 200 MB at a time." }, { status: 413, headers: HEADERS });
		files.push({ relativePath: name, data: new Uint8Array(await blob.arrayBuffer()) });
	}
	try {
		sweepPendingUploads();
		const { paths } = saveUploadBatch(typeof chatId === "string" && chatId ? chatId : null, files, undefined, (id) => !!stores.chatStore.getChat(id));
		return Response.json({ paths }, { headers: HEADERS });
	} catch (error) {
		if (error instanceof UploadError) return Response.json({ error: error.message }, { status: 400, headers: HEADERS });
		return Response.json({ error: "The upload could not be saved on the server." }, { status: 500, headers: HEADERS });
	}
}
