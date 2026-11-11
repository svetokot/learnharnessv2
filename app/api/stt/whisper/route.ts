/**
 * Local Whisper status and model downloads (Settings → Providers → Dictation).
 *   GET  → { binary, model, models[{id,label,bytes,downloaded}], download, running }
 *   POST { op: "download", model } | { op: "cancel" } | { op: "stop" }
 */
import { isWhisperModel } from "@/src/core";
import { whisperDownloader, whisperManager, whisperStatus } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

export async function GET() {
	return Response.json(whisperStatus(), { headers: HEADERS });
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null) as { op?: unknown; model?: unknown } | null;
	if (body?.op === "download" && isWhisperModel(body.model)) whisperDownloader().start(body.model);
	else if (body?.op === "cancel") whisperDownloader().cancel();
	else if (body?.op === "stop") whisperManager().stop();
	else return Response.json({ error: "Unsupported operation." }, { status: 400, headers: HEADERS });
	return Response.json(whisperStatus(), { headers: HEADERS });
}
