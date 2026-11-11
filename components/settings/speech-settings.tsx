"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useDictationActive } from "@/components/dictation-state";
import {
	DEFAULT_SPEECH, SPEECH_ENGINE_LABELS, SPEECH_ENGINES, WHISPER_MODELS, sanitizeSpeechSettings,
	type SpeechEngine, type SpeechSettings, type UserSettings, type WhisperModel,
} from "@/src/core";
import { CommitInput, SettingsRow, ThinSelect } from "./controls.tsx";

export interface WhisperStatus {
	binary: string | null;
	model: WhisperModel;
	models: { id: WhisperModel; label: string; bytes: number; downloaded: boolean }[];
	download: { model: WhisperModel; received: number; total: number; state: "downloading" | "done" | "error" | "cancelled"; error?: string } | null;
	running: boolean;
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export const WHISPER_INSTALL_HINT = "Install whisper.cpp on the server so whisper-server is on PATH (Arch/CachyOS: the AUR package whisper.cpp-cuda for NVIDIA GPUs), or set LH_WHISPER_SERVER to its path.";

/** Engine choice + per-engine config (Settings → Providers → Dictation).
 *  The section is replace-whole, so every save sends the full record. */
export function SpeechEngineSettings({ fetchLike }: { fetchLike?: typeof fetch }) {
	const request = fetchLike ?? (typeof fetch === "undefined" ? undefined : fetch);
	const active = useDictationActive();
	const [speech, setSpeech] = useState<SpeechSettings | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [whisper, setWhisper] = useState<WhisperStatus | null>(null);

	useEffect(() => {
		if (!request) return;
		let live = true;
		void request("/api/settings", { cache: "no-store" }).then((r) => r.json()).then((body: { settings: UserSettings | null }) => {
			if (live) setSpeech(sanitizeSpeechSettings(body.settings?.speech));
		}).catch(() => { if (live) setError("Could not load dictation settings."); });
		return () => { live = false; };
	}, [request]);

	const engine: SpeechEngine = speech?.engine ?? DEFAULT_SPEECH.engine;
	const refreshWhisper = useCallback(async (init?: RequestInit) => {
		if (!request) return;
		try {
			const response = await request("/api/stt/whisper", { cache: "no-store", ...init });
			if (response.ok) setWhisper(await response.json() as WhisperStatus);
		} catch { /* keep the last status */ }
	}, [request]);
	useEffect(() => {
		if (engine !== "whisper-local") return;
		void refreshWhisper();
	}, [engine, refreshWhisper]);
	// Poll while a model downloads.
	useEffect(() => {
		if (whisper?.download?.state !== "downloading") return;
		const id = setInterval(() => void refreshWhisper(), 1000);
		return () => clearInterval(id);
	}, [whisper?.download?.state, refreshWhisper]);

	const save = async (next: SpeechSettings): Promise<boolean> => {
		if (!request) return false;
		setError(null);
		try {
			const response = await request("/api/settings/speech", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
			const body = await response.json().catch(() => ({})) as { settings?: UserSettings; error?: string };
			if (!response.ok || !body.settings) { setError(body.error ?? "Could not save dictation settings."); return false; }
			setSpeech(sanitizeSpeechSettings(body.settings.speech));
			notifySettingsSaved("speech");
			return true;
		} catch {
			setError("Could not save dictation settings.");
			return false;
		}
	};

	if (!speech) return error ? <p role="alert" className="px-1 text-xs text-error">{error}</p> : null;
	const model = speech.whisperModel ?? DEFAULT_SPEECH.whisperModel;
	const modelStatus = whisper?.models.find((entry) => entry.id === model);
	const download = whisper?.download?.model === model ? whisper.download : null;

	return <>
		<SettingsRow label="Engine" testid="row-dictation-engine" dimmed={active}>
			<ThinSelect value={engine} ariaLabel="dictation engine" testid="dictation-engine" disabled={active} onChange={(next) => void save({ ...speech, engine: next as SpeechEngine })}>
				{SPEECH_ENGINES.map((id) => <option key={id} value={id}>{SPEECH_ENGINE_LABELS[id]}</option>)}
			</ThinSelect>
		</SettingsRow>
		{engine === "whisper-local" && <>
			<SettingsRow label="Whisper model" testid="row-whisper-model" hint={whisper ? (modelStatus?.downloaded ? `Downloaded${whisper.running ? " · loaded" : ""}.` : "Not downloaded yet.") : undefined}>
				<span className="flex items-center gap-2">
					<ThinSelect value={model} ariaLabel="whisper model" testid="whisper-model" disabled={active} onChange={(next) => void save({ ...speech, whisperModel: next as WhisperModel })}>
						{WHISPER_MODELS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {formatBytes(entry.bytes)}</option>)}
					</ThinSelect>
					{whisper && !modelStatus?.downloaded && (download?.state === "downloading"
						? <Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="whisper-cancel" onClick={() => void refreshWhisper({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "cancel" }) })}>
							Cancel {Math.floor((download.received / Math.max(1, download.total)) * 100)}%
						</Button>
						: <Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="whisper-download" onClick={() => void refreshWhisper({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "download", model }) })}>Download</Button>)}
				</span>
			</SettingsRow>
			{download?.state === "error" && <p role="alert" className="px-1 text-xs text-error">Download failed: {download.error}</p>}
			{whisper && <p data-testid="whisper-binary" className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
				{whisper.binary ? <>Using <span className="font-ui">{whisper.binary}</span> on the server. It starts on first use and stops after 10 idle minutes to free GPU memory.</> : WHISPER_INSTALL_HINT}
			</p>}
		</>}
		{engine === "openai" && <>
			<SettingsRow label="Endpoint" testid="row-stt-endpoint" hint="Base URL ending in /v1, e.g. http://127.0.0.1:8000/v1. The key, if needed, goes in the Speech-to-text endpoint row.">
				<CommitInput value={speech.openaiBaseUrl ?? ""} placeholder="http://127.0.0.1:8000/v1" ariaLabel="speech-to-text endpoint" testid="stt-endpoint" onCommit={(next) => save({ ...speech, openaiBaseUrl: next || undefined })} />
			</SettingsRow>
			<SettingsRow label="Model" testid="row-stt-model">
				<CommitInput value={speech.openaiModel ?? ""} placeholder={DEFAULT_SPEECH.openaiModel} ariaLabel="speech-to-text model" testid="stt-model" onCommit={(next) => save({ ...speech, openaiModel: next || undefined })} />
			</SettingsRow>
		</>}
		{error && <p role="alert" className="px-1 text-xs text-error">{error}</p>}
	</>;
}
