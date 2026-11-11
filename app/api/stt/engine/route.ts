/** GET /api/stt/engine → { engine } — read by the dictation hook at each start. */
import { resolveSpeech } from "@/src/core";
import { settingsStore } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ engine: resolveSpeech(settingsStore.readSettings()?.speech).engine }, { headers: { "Cache-Control": "no-store" } });
}
