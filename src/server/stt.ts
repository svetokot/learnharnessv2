/**
 * Server-side transcription for the non-Deepgram dictation engines (STT
 * wave 2, src/core/speech.ts). The client records the whole dictation, wraps
 * it as 16 kHz mono 16-bit WAV, and POSTs it to /api/stt/transcribe; this
 * module hands it to the configured engine and returns the text.
 *
 * Local Whisper: whisper.cpp's whisper-server (verified against
 * examples/server/server.cpp, 2026-11-11):
 *   whisper-server --host 127.0.0.1 --port P -m MODEL
 *   GET  /health      → {"status":"ok"} once the model is loaded (503 while loading)
 *   POST /inference   multipart: file, language, response_format=json → {"text": …}
 * Started on first use, stopped after 10 idle minutes (owner: free the VRAM),
 * restarted when the model changes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { resolveSpeech, STT_OPENAI_KEY_ID, WHISPER_MODELS, whisperLanguage, whisperModelUrl, type SpeechSettings, type WhisperModel } from "../core/speech.ts";
import { keyValue } from "./keys.ts";
import { settingsStore } from "../store/settings.ts";

/** ≈ 26 minutes of 16 kHz mono 16-bit audio. */
export const MAX_TRANSCRIBE_BYTES = 50 * 1024 * 1024;
export const WHISPER_IDLE_MS = 10 * 60_000;
const WHISPER_START_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;
const BINARY_NAMES = ["whisper-server", "whisper-cpp-server", "whisper.cpp-server"];

export class SttError extends Error {
	constructor(message: string, readonly status = 502) { super(message); }
}

export function whisperModelsDir(): string {
	return path.join(PATHS.data, "whisper", "models");
}
export function whisperModelPath(model: WhisperModel, dir = whisperModelsDir()): string {
	return path.join(dir, `ggml-${model}.bin`);
}

/** LH_WHISPER_SERVER, else the first whisper-server name found on PATH. */
export function findWhisperBinary(env: Record<string, string | undefined> = process.env): string | null {
	const explicit = env.LH_WHISPER_SERVER?.trim();
	if (explicit) return isExecutable(explicit) ? explicit : null;
	for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const name of BINARY_NAMES) {
			const candidate = path.join(/* turbopackIgnore: true */ dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return null;
}
function isExecutable(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch { return false; }
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

export interface WhisperManagerOptions {
	spawnProcess?: (binary: string, args: string[]) => ChildProcess;
	fetchLike?: typeof fetch;
	idleMs?: number;
	startTimeoutMs?: number;
	log?: (line: string) => void;
}

/** One resident whisper-server at a time, keyed by binary + model. */
export function createWhisperManager(options: WhisperManagerOptions = {}) {
	const spawnProcess = options.spawnProcess ?? ((binary, args) => spawn(/* turbopackIgnore: true */ binary, args, { stdio: ["ignore", "pipe", "pipe"] }));
	const fetchLike = options.fetchLike ?? fetch;
	const idleMs = options.idleMs ?? WHISPER_IDLE_MS;
	const startTimeoutMs = options.startTimeoutMs ?? WHISPER_START_TIMEOUT_MS;
	const log = options.log ?? ((line: string) => console.log(`[whisper] ${line}`));
	let current: { key: string; child: ChildProcess; port: number; ready: Promise<void> } | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;

	const stop = () => {
		if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
		const running = current;
		current = null;
		if (!running) return;
		running.child.kill("SIGTERM");
		const force = setTimeout(() => { try { running.child.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
		force.unref?.();
	};
	const touch = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => { log("idle — stopping whisper-server"); stop(); }, idleMs);
		idleTimer.unref?.();
	};

	async function ensure(binary: string, modelPath: string): Promise<number> {
		const key = `${binary}\0${modelPath}`;
		if (current && current.key !== key) stop();
		if (!current) {
			const port = await freePort();
			const child = spawnProcess(binary, ["--host", "127.0.0.1", "--port", String(port), "-m", modelPath]);
			let stderr = "";
			child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
			child.stdout?.resume();
			const exited = new Promise<never>((_, reject) => {
				child.once("error", (error) => reject(new SttError(`whisper-server could not start: ${error.message}`)));
				child.once("exit", (code) => reject(new SttError(`whisper-server exited (code ${code}). ${stderr.trim().split("\n").at(-1) ?? ""}`.trim())));
			});
			exited.catch(() => {});
			const entry = { key, child, port, ready: Promise.resolve() };
			child.once("exit", () => { if (current === entry) { current = null; if (idleTimer) clearTimeout(idleTimer); } });
			entry.ready = (async () => {
				const deadline = Date.now() + startTimeoutMs;
				for (;;) {
					try {
						const response = await Promise.race([fetchLike(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }), exited]);
						if (response.ok) return;
					} catch (error) {
						if (error instanceof SttError) throw error;
					}
					if (Date.now() > deadline) throw new SttError("whisper-server did not become ready in time.");
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			})();
			current = entry;
			log(`started ${path.basename(binary)} on 127.0.0.1:${port} with ${path.basename(modelPath)}`);
		}
		const entry = current;
		try { await entry.ready; }
		catch (error) { if (current === entry) stop(); throw error; }
		touch();
		return entry.port;
	}

	return {
		ensure,
		stop,
		/** A finished request also counts as use. */
		touch,
		running: () => !!current,
	};
}

/** Process-wide singletons on globalThis (the web-subscriptions pattern):
 *  route bundles and dev HMR can instantiate this module more than once,
 *  and each copy must not spawn its own whisper-server. */
const KEY = Symbol.for("lh.stt");
function registry(): { manager?: ReturnType<typeof createWhisperManager>; downloader?: ReturnType<typeof createModelDownloader> } {
	const global = globalThis as typeof globalThis & { [KEY]?: ReturnType<typeof registry> };
	return (global[KEY] ??= {});
}
export function whisperManager() {
	const state = registry();
	if (!state.manager) {
		const manager = createWhisperManager();
		state.manager = manager;
		process.once("exit", () => manager.stop());
	}
	return state.manager;
}

/** Model downloads: one at a time, streamed to .part and renamed. */
export interface DownloadState { model: WhisperModel; received: number; total: number; state: "downloading" | "done" | "error" | "cancelled"; error?: string }
export function createModelDownloader({ fetchLike = fetch, dir = whisperModelsDir } : { fetchLike?: typeof fetch; dir?: () => string } = {}) {
	let state: DownloadState | null = null;
	let abort: AbortController | null = null;
	return {
		status: () => state,
		cancel() { abort?.abort(); },
		start(model: WhisperModel): DownloadState {
			if (state?.state === "downloading") return state;
			const info = WHISPER_MODELS.find((entry) => entry.id === model)!;
			const controller = new AbortController();
			abort = controller;
			const download: DownloadState = { model, received: 0, total: info.bytes, state: "downloading" };
			state = download;
			void (async () => {
				const target = whisperModelPath(model, dir());
				const part = `${target}.part`;
				try {
					fs.mkdirSync(path.dirname(target), { recursive: true });
					const response = await fetchLike(whisperModelUrl(model), { signal: controller.signal, redirect: "follow" });
					if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
					download.total = Number(response.headers.get("content-length")) || info.bytes;
					const out = fs.createWriteStream(part);
					const reader = response.body.getReader();
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							download.received += value.byteLength;
							if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
						}
					} finally {
						await new Promise<void>((resolve) => out.end(() => resolve()));
					}
					if (download.received !== download.total) throw new Error("The download was incomplete.");
					fs.renameSync(part, target);
					download.state = "done";
				} catch (error) {
					fs.rmSync(part, { force: true });
					download.state = controller.signal.aborted ? "cancelled" : "error";
					if (!controller.signal.aborted) download.error = error instanceof Error ? error.message : "The download failed.";
				}
			})();
			return download;
		},
	};
}
export function whisperDownloader() { return (registry().downloader ??= createModelDownloader()); }

export function whisperStatus() {
	const speech = resolveSpeech(settingsStore.readSettings()?.speech);
	return {
		binary: findWhisperBinary(),
		model: speech.whisperModel,
		models: WHISPER_MODELS.map((model) => ({ ...model, downloaded: fs.existsSync(whisperModelPath(model.id)) })),
		download: whisperDownloader().status(),
		running: whisperManager().running(),
	};
}

async function readText(response: Response): Promise<string> {
	const body = await response.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
	if (!response.ok) {
		const detail = typeof body?.error === "string" ? body.error : (body?.error as { message?: unknown } | undefined)?.message;
		throw new SttError(`Transcription failed (HTTP ${response.status})${typeof detail === "string" ? `: ${detail.slice(0, 200)}` : ""}`);
	}
	if (typeof body?.text !== "string") throw new SttError("The engine returned no text.");
	// whisper-server separates segments with newlines; a dictation is one
	// run of text in the draft.
	return body.text.replace(/\s*\n\s*/g, " ").trim();
}

function audioForm(wav: Uint8Array, fields: Record<string, string>): FormData {
	const form = new FormData();
	form.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "dictation.wav");
	for (const [name, value] of Object.entries(fields)) form.append(name, value);
	return form;
}

/** Transcribe one recorded dictation with the configured engine. */
export async function transcribe(wav: Uint8Array, language: string, deps: { fetchLike?: typeof fetch; whisper?: ReturnType<typeof createWhisperManager>; speech?: SpeechSettings; binary?: string | null; modelsDir?: string } = {}): Promise<string> {
	const fetchLike = deps.fetchLike ?? fetch;
	const speech = resolveSpeech(deps.speech ?? settingsStore.readSettings()?.speech);
	const lang = whisperLanguage(language);
	if (speech.engine === "openai") {
		if (!speech.openaiBaseUrl) throw new SttError("Set the endpoint URL in Settings → Providers → Dictation.", 503);
		const key = keyValue(STT_OPENAI_KEY_ID);
		const response = await fetchLike(`${speech.openaiBaseUrl}/audio/transcriptions`, {
			method: "POST",
			headers: key ? { Authorization: `Bearer ${key}` } : {},
			body: audioForm(wav, { model: speech.openaiModel, response_format: "json", ...(lang === "auto" ? {} : { language: lang }), ...(speech.prompt ? { prompt: speech.prompt } : {}) }),
			signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
		}).catch(() => { throw new SttError("The speech-to-text endpoint could not be reached."); });
		return readText(response);
	}
	if (speech.engine === "whisper-local") {
		const binary = deps.binary !== undefined ? deps.binary : findWhisperBinary();
		if (!binary) throw new SttError("whisper-server was not found. Install whisper.cpp on the server (or set LH_WHISPER_SERVER).", 503);
		const model = whisperModelPath(speech.whisperModel, deps.modelsDir);
		if (!fs.existsSync(model)) throw new SttError("Download the Whisper model in Settings → Providers → Dictation.", 503);
		const whisper = deps.whisper ?? whisperManager();
		const port = await whisper.ensure(binary, model);
		try {
			const response = await fetchLike(`http://127.0.0.1:${port}/inference`, {
				method: "POST",
				body: audioForm(wav, { language: lang, response_format: "json", temperature: "0", ...(speech.prompt ? { prompt: speech.prompt } : {}) }),
				signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
			}).catch(() => { throw new SttError("whisper-server stopped answering."); });
			return await readText(response);
		} finally {
			whisper.touch();
		}
	}
	throw new SttError("Deepgram dictation streams from the browser; nothing to transcribe here.", 400);
}
