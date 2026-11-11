/**
 * POST /api/stt/transcribe?language=<code> — body: one recorded dictation as
 * 16 kHz mono 16-bit WAV (components/dictation.tsx, non-Deepgram engines).
 * Returns { text }. Exempt from Proxy (its 10 MB-default body clone would
 * truncate long recordings); the identical request policy runs here first.
 */
import { isDictationLanguage } from "@/src/core";
import { apiRequestRefusal, MAX_TRANSCRIBE_BYTES, SttError, transcribe } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
	const refusal = apiRequestRefusal(request);
	if (refusal) return Response.json({ error: refusal }, { status: 403, headers: HEADERS });
	const language = new URL(request.url).searchParams.get("language") ?? "en";
	if (!isDictationLanguage(language)) return Response.json({ error: "Unsupported dictation language" }, { status: 400, headers: HEADERS });
	if (Number(request.headers.get("content-length")) > MAX_TRANSCRIBE_BYTES) return Response.json({ error: "The recording is too long." }, { status: 413, headers: HEADERS });
	const reader = request.body?.getReader();
	if (!reader) return Response.json({ error: "Expected audio." }, { status: 400, headers: HEADERS });
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_TRANSCRIBE_BYTES) {
			await reader.cancel().catch(() => {});
			return Response.json({ error: "The recording is too long." }, { status: 413, headers: HEADERS });
		}
		chunks.push(value);
	}
	if (size < 44) return Response.json({ error: "Expected audio." }, { status: 400, headers: HEADERS });
	try {
		const text = await transcribe(Buffer.concat(chunks), language);
		return Response.json({ text }, { headers: HEADERS });
	} catch (error) {
		if (error instanceof SttError) return Response.json({ error: error.message }, { status: error.status, headers: HEADERS });
		return Response.json({ error: "Transcription failed." }, { status: 500, headers: HEADERS });
	}
}
