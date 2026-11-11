/**
 * Speech-to-text engines (STT wave 2). Browser-safe: types, the model list,
 * sanitizing, and the language mapping. Server side: src/server/stt.ts.
 *
 *   deepgram       — the original cloud streaming engine (renderer → Deepgram).
 *   whisper-local  — whisper.cpp's `whisper-server` (found on PATH, or the
 *                    LH_WHISPER_SERVER environment variable — deliberately
 *                    not a setting: the API has no login, and a settable
 *                    executable path would let any LAN client run programs
 *                    on the server), managed by the
 *                    LearnHarness server: model downloaded into
 *                    data/whisper/models/, process started on first use,
 *                    stopped after 10 idle minutes.
 *   openai         — any OpenAI-compatible /v1/audio/transcriptions endpoint
 *                    (speaches/faster-whisper-server, LocalAI, Groq, OpenAI).
 *
 * The non-Deepgram engines record the whole dictation and transcribe it once
 * at stop — the same deferred-transcript behavior the owner chose for
 * Deepgram. Audio goes client → LearnHarness server → engine.
 */
import type { DictationLanguage } from "./dictation.ts";

export const SPEECH_ENGINES = ["deepgram", "whisper-local", "openai"] as const;
export type SpeechEngine = (typeof SPEECH_ENGINES)[number];

export const SPEECH_ENGINE_LABELS: Record<SpeechEngine, string> = {
	deepgram: "Deepgram (cloud)",
	"whisper-local": "Local Whisper (whisper.cpp)",
	openai: "OpenAI-compatible endpoint",
};

/** whisper.cpp ggml models from huggingface.co/ggerganov/whisper.cpp
 *  (sizes HEAD-verified 2026-11-11). */
export const WHISPER_MODELS = [
	{ id: "tiny", label: "tiny", bytes: 77691713 },
	{ id: "base", label: "base", bytes: 147951465 },
	{ id: "small", label: "small", bytes: 487601967 },
	{ id: "medium", label: "medium", bytes: 1533763059 },
	{ id: "large-v3-turbo-q5_0", label: "large-v3-turbo (q5_0)", bytes: 574041195 },
	{ id: "large-v3-turbo", label: "large-v3-turbo", bytes: 1624555275 },
	{ id: "large-v3", label: "large-v3", bytes: 3095033483 },
] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number]["id"];
export const DEFAULT_WHISPER_MODEL: WhisperModel = "large-v3-turbo-q5_0";

export function whisperModelUrl(model: WhisperModel): string {
	return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

export function isWhisperModel(value: unknown): value is WhisperModel {
	return WHISPER_MODELS.some((model) => model.id === value);
}

export function isSpeechEngine(value: unknown): value is SpeechEngine {
	return (SPEECH_ENGINES as readonly unknown[]).includes(value);
}

/** The Keys-store id for the OpenAI-compatible engine's optional key. */
export const STT_OPENAI_KEY_ID = "STT_OPENAI_API_KEY";

export interface SpeechSettings {
	engine?: SpeechEngine;
	whisperModel?: WhisperModel;
	/** OpenAI-compatible base URL, e.g. http://127.0.0.1:8000/v1 */
	openaiBaseUrl?: string;
	openaiModel?: string;
}

export const DEFAULT_SPEECH: Required<Pick<SpeechSettings, "engine" | "whisperModel" | "openaiModel">> = {
	engine: "deepgram",
	whisperModel: DEFAULT_WHISPER_MODEL,
	openaiModel: "whisper-1",
};

/** An http(s) base URL without credentials, query or fragment; trailing
 *  slashes dropped. */
export function normalizeSpeechBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 2048) return null;
	try {
		const url = new URL(trimmed);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
		return url.toString().replace(/\/+$/, "");
	} catch { return null; }
}

/** Lenient read side: invalid fields drop to their defaults. */
export function sanitizeSpeechSettings(raw: unknown): SpeechSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const r = raw as Record<string, unknown>;
	const out: SpeechSettings = {};
	if (isSpeechEngine(r.engine)) out.engine = r.engine;
	if (isWhisperModel(r.whisperModel)) out.whisperModel = r.whisperModel;
	const base = normalizeSpeechBaseUrl(r.openaiBaseUrl);
	if (base) out.openaiBaseUrl = base;
	if (typeof r.openaiModel === "string" && r.openaiModel.trim() && r.openaiModel.length <= 200) out.openaiModel = r.openaiModel.trim();
	return out;
}

export function resolveSpeech(settings: SpeechSettings | undefined) {
	return {
		engine: settings?.engine ?? DEFAULT_SPEECH.engine,
		whisperModel: settings?.whisperModel ?? DEFAULT_SPEECH.whisperModel,
		openaiBaseUrl: settings?.openaiBaseUrl ?? null,
		openaiModel: settings?.openaiModel ?? DEFAULT_SPEECH.openaiModel,
	};
}

/** Deepgram codes → Whisper's: "multi" is auto-detect, locales drop to their
 *  base language ("en-GB" → "en"), Cantonese is Whisper's "yue". */
export function whisperLanguage(language: DictationLanguage | string): string {
	if (language === "multi") return "auto";
	if (language === "zh-HK") return "yue";
	return language.split("-")[0]!.toLowerCase();
}
