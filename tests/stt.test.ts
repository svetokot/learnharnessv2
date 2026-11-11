import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { config } from "../proxy.ts";
import { DEFAULT_SPEECH, normalizeSpeechBaseUrl, resolveSpeech, sanitizeSpeechSettings, whisperLanguage, whisperModelUrl } from "../src/core/speech.ts";
import { parseSpeechSettingsBody } from "../src/server/settings-body.ts";
import { createModelDownloader, createWhisperManager, findWhisperBinary, transcribe, whisperModelPath } from "../src/server/stt.ts";
import { encodeWav, readSpeechEngine } from "../components/speech-engine.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-whisper-server.mjs", import.meta.url));
const fakeSpawn = (env: Record<string, string> = {}) => {
	const spawned: string[][] = [];
	return {
		spawned,
		spawnProcess: (_binary: string, args: string[]) => {
			spawned.push(args);
			return spawn(process.execPath, [FAKE, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
		},
	};
};

describe("speech settings", () => {
	it("defaults to Deepgram and keeps only valid fields", () => {
		assert.equal(resolveSpeech(undefined).engine, "deepgram");
		assert.deepEqual(sanitizeSpeechSettings({ engine: "whisper-local", whisperModel: "nope", openaiBaseUrl: "ftp://x", openaiModel: "", extra: 1 }), { engine: "whisper-local" });
		assert.equal(resolveSpeech({ engine: "whisper-local" }).whisperModel, DEFAULT_SPEECH.whisperModel);
		assert.equal(normalizeSpeechBaseUrl("http://127.0.0.1:8000/v1/"), "http://127.0.0.1:8000/v1");
		assert.equal(normalizeSpeechBaseUrl("http://user:pw@host/v1"), null);
	});

	it("the write side is strict", () => {
		assert.deepEqual(parseSpeechSettingsBody({ engine: "openai", openaiBaseUrl: "https://api.groq.com/openai/v1", openaiModel: " whisper-large-v3 " }), { ok: true, settings: { engine: "openai", openaiBaseUrl: "https://api.groq.com/openai/v1", openaiModel: "whisper-large-v3" } });
		assert.equal(parseSpeechSettingsBody({ engine: "nope" }).ok, false);
		assert.equal(parseSpeechSettingsBody({ whisperModel: "huge" }).ok, false);
		assert.equal(parseSpeechSettingsBody({ openaiBaseUrl: "javascript:alert(1)" }).ok, false);
		assert.equal(parseSpeechSettingsBody({ whisperBinary: "/bin/sh" }).ok, true, "unknown keys are dropped");
		assert.deepEqual(parseSpeechSettingsBody({ whisperBinary: "/bin/sh" }), { ok: true, settings: {} }, "no settable executable path");
	});

	it("maps dictation languages to Whisper codes", () => {
		assert.equal(whisperLanguage("multi"), "auto");
		assert.equal(whisperLanguage("en-GB"), "en");
		assert.equal(whisperLanguage("pt-BR"), "pt");
		assert.equal(whisperLanguage("zh-HK"), "yue");
		assert.equal(whisperLanguage("ru"), "ru");
	});

	it("model URLs point at the whisper.cpp repository", () => {
		assert.equal(whisperModelUrl("large-v3-turbo-q5_0"), "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin");
	});
});

describe("WAV encoding", () => {
	it("writes a 16 kHz mono 16-bit header and little-endian samples", () => {
		const wav = encodeWav([Int16Array.of(1, -2), Int16Array.of(32767)]);
		const view = new DataView(wav.buffer);
		assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
		assert.equal(new TextDecoder().decode(wav.slice(8, 12)), "WAVE");
		assert.equal(view.getUint16(22, true), 1);
		assert.equal(view.getUint32(24, true), 16000);
		assert.equal(view.getUint16(34, true), 16);
		assert.equal(view.getUint32(40, true), 6);
		assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)], [1, -2, 32767]);
		assert.equal(wav.length, 50);
	});
});

describe("engine read on the client", () => {
	it("reads the engine and falls back to the last known one", async () => {
		assert.equal(await readSpeechEngine((async () => Response.json({ engine: "whisper-local" })) as typeof fetch), "whisper-local");
		assert.equal(await readSpeechEngine((async () => { throw new Error("offline"); }) as typeof fetch), "whisper-local");
		assert.equal(await readSpeechEngine((async () => Response.json({ engine: "bogus" })) as typeof fetch), "whisper-local");
	});
});

describe("whisper-server binary discovery", () => {
	it("prefers LH_WHISPER_SERVER, else searches PATH", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "lh-whisper-bin-"));
		try {
			const bin = path.join(dir, "whisper-server");
			writeFileSync(bin, "#!/bin/sh\n");
			assert.equal(findWhisperBinary({ PATH: dir }), null, "not executable yet");
			chmodSync(bin, 0o755);
			assert.equal(findWhisperBinary({ PATH: `/nonexistent${path.delimiter}${dir}` }), bin);
			assert.equal(findWhisperBinary({ PATH: "", LH_WHISPER_SERVER: bin }), bin);
			assert.equal(findWhisperBinary({ PATH: dir, LH_WHISPER_SERVER: path.join(dir, "missing") }), null);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("whisper-server process manager", () => {
	it("starts on first use, waits for the model to load, reuses, restarts on model change, and stops when idle", async () => {
		const fake = fakeSpawn({ FAKE_WHISPER_DELAY_MS: "400" });
		const whisper = createWhisperManager({ spawnProcess: fake.spawnProcess, idleMs: 600, log: () => {} });
		try {
			const port = await whisper.ensure("/usr/bin/whisper-server", "/models/ggml-a.bin");
			assert.deepEqual(fake.spawned[0], ["--host", "127.0.0.1", "--port", String(port), "-m", "/models/ggml-a.bin"]);
			assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, "ready means /health is ok");
			assert.equal(await whisper.ensure("/usr/bin/whisper-server", "/models/ggml-a.bin"), port);
			assert.equal(fake.spawned.length, 1, "a resident server is reused");
			const other = await whisper.ensure("/usr/bin/whisper-server", "/models/ggml-b.bin");
			assert.equal(fake.spawned.length, 2, "a different model restarts it");
			assert.equal(whisper.running(), true);
			await new Promise((resolve) => setTimeout(resolve, 900));
			assert.equal(whisper.running(), false, "idle timeout stops it (frees VRAM)");
			await assert.rejects(fetch(`http://127.0.0.1:${other}/health`));
		} finally { whisper.stop(); }
	});

	it("reports a server that dies during startup", async () => {
		const whisper = createWhisperManager({
			spawnProcess: () => spawn(process.execPath, ["-e", "console.error('error: failed to load model'); process.exit(3)"], { stdio: ["ignore", "pipe", "pipe"] }),
			log: () => {},
		});
		await assert.rejects(whisper.ensure("/x", "/m.bin"), /exited \(code 3\).*failed to load model/);
		assert.equal(whisper.running(), false);
	});
});

describe("transcription engines", () => {
	const wav = encodeWav([Int16Array.of(0, 1, 2, 3)]);

	it("local Whisper: spawns whisper-server, posts the WAV with the mapped language, returns trimmed text", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "lh-whisper-models-"));
		const fake = fakeSpawn();
		const whisper = createWhisperManager({ spawnProcess: fake.spawnProcess, log: () => {} });
		try {
			writeFileSync(whisperModelPath("tiny", dir), "model");
			const text = await transcribe(wav, "en-GB", { whisper, speech: { engine: "whisper-local", whisperModel: "tiny" }, binary: "/usr/bin/whisper-server", modelsDir: dir });
			assert.equal(text, "heard wav in en with ggml-tiny.bin");
			assert.equal(await transcribe(wav, "multi", { whisper, speech: { engine: "whisper-local", whisperModel: "tiny" }, binary: "/usr/bin/whisper-server", modelsDir: dir }), "heard wav in auto with ggml-tiny.bin");
		} finally {
			whisper.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("local Whisper explains a missing binary or model", async () => {
		await assert.rejects(transcribe(wav, "en", { speech: { engine: "whisper-local" }, binary: null }), /whisper-server was not found/);
		await assert.rejects(transcribe(wav, "en", { speech: { engine: "whisper-local" }, binary: "/usr/bin/whisper-server", modelsDir: "/nonexistent" }), /Download the Whisper model/);
	});

	it("OpenAI-compatible: multipart to /audio/transcriptions; auto language is omitted; errors carry the endpoint's message", async () => {
		const seen: { url: string; form: FormData; auth: string | null }[] = [];
		const fetchLike = (async (url: string, init: RequestInit) => {
			seen.push({ url, form: init.body as FormData, auth: new Headers(init.headers).get("authorization") });
			return Response.json({ text: " hello " });
		}) as unknown as typeof fetch;
		const speech = { engine: "openai" as const, openaiBaseUrl: "http://127.0.0.1:8000/v1", openaiModel: "Systran/faster-whisper-small" };
		assert.equal(await transcribe(wav, "de", { fetchLike, speech }), "hello");
		assert.equal(seen[0]!.url, "http://127.0.0.1:8000/v1/audio/transcriptions");
		assert.equal(seen[0]!.form.get("model"), "Systran/faster-whisper-small");
		assert.equal(seen[0]!.form.get("language"), "de");
		assert.equal((seen[0]!.form.get("file") as File).type, "audio/wav");
		await transcribe(wav, "multi", { fetchLike, speech });
		assert.equal(seen[1]!.form.get("language"), null);
		const refusing = (async () => Response.json({ error: { message: "Invalid model" } }, { status: 400 })) as unknown as typeof fetch;
		await assert.rejects(transcribe(wav, "de", { fetchLike: refusing, speech }), /HTTP 400.*Invalid model/);
		await assert.rejects(transcribe(wav, "de", { fetchLike, speech: { engine: "openai" } }), /Set the endpoint URL/);
	});

	it("Deepgram is never transcribed server-side", async () => {
		await assert.rejects(transcribe(wav, "en", { speech: { engine: "deepgram" } }), /streams from the browser/);
	});
});

describe("model downloads", () => {
	it("streams to .part, renames when complete, and removes a failed partial", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "lh-whisper-dl-"));
		try {
			const ok = createModelDownloader({ dir: () => dir, fetchLike: (async () => new Response("abcdef", { headers: { "content-length": "6" } })) as unknown as typeof fetch });
			const state = ok.start("tiny");
			assert.equal(state.state, "downloading");
			assert.equal(ok.start("base"), state, "one download at a time");
			while (ok.status()?.state === "downloading") await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(ok.status()?.state, "done");
			assert.equal(readFileSync(whisperModelPath("tiny", dir), "utf8"), "abcdef");

			const short = createModelDownloader({ dir: () => dir, fetchLike: (async () => new Response("abc", { headers: { "content-length": "6" } })) as unknown as typeof fetch });
			short.start("base");
			while (short.status()?.state === "downloading") await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(short.status()?.state, "error");
			assert.equal(existsSync(whisperModelPath("base", dir)), false);
			assert.equal(existsSync(`${whisperModelPath("base", dir)}.part`), false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("transcription route is exempt from Proxy body cloning", () => {
	it("matches the rest of /api/stt", () => {
		const origin = "http://127.0.0.1:3000";
		assert(!unstable_doesProxyMatch({ config, nextConfig: {}, url: `${origin}/api/stt/transcribe` }));
		assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: `${origin}/api/stt/whisper` }));
		assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: `${origin}/api/stt/token` }));
		mkdirSync(tmpdir(), { recursive: true });
	});
});

describe("Whisper prompt", () => {
	const wav = encodeWav([Int16Array.of(0, 1)]);
	it("is optional, bounded, and sent to both Whisper engines", async () => {
		assert.deepEqual(parseSpeechSettingsBody({ prompt: "  Привет! Hello.  " }), { ok: true, settings: { prompt: "Привет! Hello." } });
		assert.deepEqual(parseSpeechSettingsBody({ prompt: "" }), { ok: true, settings: {} });
		assert.equal(parseSpeechSettingsBody({ prompt: "x".repeat(501) }).ok, false);
		assert.equal(sanitizeSpeechSettings({ prompt: 5 }).prompt, undefined);
		const forms: FormData[] = [];
		const fetchLike = (async (_url: string, init: RequestInit) => { forms.push(init.body as FormData); return Response.json({ text: "ok" }); }) as unknown as typeof fetch;
		await transcribe(wav, "multi", { fetchLike, speech: { engine: "openai", openaiBaseUrl: "http://127.0.0.1:8000/v1", prompt: "Привет! Hello." } });
		assert.equal(forms[0]!.get("prompt"), "Привет! Hello.");
		await transcribe(wav, "multi", { fetchLike, speech: { engine: "openai", openaiBaseUrl: "http://127.0.0.1:8000/v1" } });
		assert.equal(forms[1]!.get("prompt"), null);
	});
	it("defaults to the benchmarked q8_0 turbo model", () => {
		assert.equal(DEFAULT_SPEECH.whisperModel, "large-v3-turbo-q8_0");
	});
});

describe("segment joining", () => {
	it("joins whisper-server's newline-separated segments into one line", async () => {
		const fetchLike = (async () => Response.json({ text: " Первая фраза.\n Second sentence,\n и ещё. " })) as unknown as typeof fetch;
		assert.equal(await transcribe(encodeWav([Int16Array.of(1)]), "multi", { fetchLike, speech: { engine: "openai", openaiBaseUrl: "http://127.0.0.1:8000/v1" } }), "Первая фраза. Second sentence, и ещё.");
	});
});
