/**
 * Client helpers for the non-Deepgram dictation engines (src/core/speech.ts):
 * read the configured engine, wrap the worklet's linear16 frames as WAV, and
 * transcribe one recording through the LearnHarness server.
 */
import { isSpeechEngine, type SpeechEngine } from "@/src/core";

/** The last engine this window read; null until the first read. The
 *  Deepgram warm-token pre-mint only runs for "deepgram" (or unknown). */
let lastKnownEngine: SpeechEngine | null = null;
export function knownSpeechEngine(): SpeechEngine | null { return lastKnownEngine; }

/** Read fresh at each dictation start, so a Settings change applies at once.
 *  A failed read keeps the last known engine (else Deepgram, the original
 *  behavior); the server still refuses a mismatched transcription. */
export async function readSpeechEngine(fetchLike: typeof fetch = fetch): Promise<SpeechEngine> {
	try {
		const response = await fetchLike("/api/stt/engine", { cache: "no-store" });
		if (!response.ok) throw new Error();
		const body = await response.json() as { engine?: unknown };
		if (!isSpeechEngine(body.engine)) throw new Error();
		lastKnownEngine = body.engine;
		return body.engine;
	} catch {
		return lastKnownEngine ?? "deepgram";
	}
}

/** 16-bit PCM mono frames → a WAV file. */
export function encodeWav(frames: readonly Int16Array[], sampleRate = 16000): Uint8Array {
	const samples = frames.reduce((sum, frame) => sum + frame.length, 0);
	const dataBytes = samples * 2;
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	let offset = 44;
	for (const frame of frames) {
		for (let i = 0; i < frame.length; i++, offset += 2) view.setInt16(offset, frame[i]!, true);
	}
	return out;
}

/** ≈ 26 minutes at 16 kHz mono 16-bit (mirrors MAX_TRANSCRIBE_BYTES). */
export const MAX_RECORDING_SAMPLES = Math.floor((50 * 1024 * 1024 - 44) / 2);

export async function transcribeRecording(wav: Uint8Array, language: string, fetchLike: typeof fetch = fetch): Promise<string> {
	let response: Response;
	try {
		response = await fetchLike(`/api/stt/transcribe?language=${encodeURIComponent(language)}`, {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: wav as Uint8Array<ArrayBuffer>,
		});
	} catch {
		throw new Error("The LearnHarness server could not be reached.");
	}
	const body = await response.json().catch(() => ({})) as { text?: unknown; error?: unknown };
	if (!response.ok || typeof body.text !== "string") throw new Error(typeof body.error === "string" ? body.error : "Transcription failed.");
	return body.text;
}
