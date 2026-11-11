"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow, ThinSelect } from "./controls.tsx";

/** One endpoint choice, as electron/connection.cjs stores it on this client. */
export type ServerConnection = { mode: "local" | "remote"; url: string | null };
export type ConnectionSnapshot = { saved: ServerConnection; active: ServerConnection; dev: boolean };
export type ConnectionTestResult = { ok: boolean; error?: string; url?: string };
export interface ConnectionBridge {
	get(): Promise<ConnectionSnapshot>;
	test(url: string): Promise<ConnectionTestResult>;
	apply(next: ServerConnection): Promise<ServerConnection>;
}

export const SERVER_HINT_LOCAL = "This computer runs LearnHarness.";
export const SERVER_ADDRESS_HINT = "A LearnHarness server on your network, started with npm run start:remote.";

/** The hint under the Server row: what THIS launch uses (a saved change
 *  applies on restart). */
export function activeServerText(active: ServerConnection): string {
	return active.mode === "remote" && active.url ? `Connected to ${active.url}.` : SERVER_HINT_LOCAL;
}

/** Apply is meaningful only when the draft differs from this launch. */
export function connectionChanged(active: ServerConnection, mode: ServerConnection["mode"], url: string): boolean {
	if (mode !== active.mode) return true;
	return mode === "remote" && url.trim() !== (active.url ?? "");
}

/** Settings → General → Server. Desktop only: a browser tab already chose
 *  its server by its address bar, so the row renders nothing there. */
export function ServerConnectionSettings({ bridge }: { bridge?: ConnectionBridge }) {
	const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null);
	const [mode, setMode] = useState<ServerConnection["mode"]>("local");
	const [url, setUrl] = useState("");
	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const connection = bridge ?? (typeof window !== "undefined" ? window.lh?.connection : undefined);

	useEffect(() => {
		if (!connection) return;
		let live = true;
		void connection.get().then((next) => {
			if (!live) return;
			setSnapshot(next);
			setMode(next.saved.mode);
			setUrl(next.saved.url ?? "");
		}).catch(() => {});
		return () => { live = false; };
	}, [connection]);

	if (!connection || !snapshot) return null;

	const test = async (): Promise<ConnectionTestResult> => {
		setBusy(true);
		setStatus(null);
		try {
			const result = await connection.test(url);
			setStatus(result.ok ? { ok: true, text: `LearnHarness is answering at ${result.url}.` } : { ok: false, text: result.error ?? "The server could not be reached." });
			if (result.ok && result.url) setUrl(result.url);
			return result;
		} catch {
			const failed = { ok: false, error: "The server could not be reached." };
			setStatus({ ok: false, text: failed.error });
			return failed;
		} finally {
			setBusy(false);
		}
	};

	const apply = async () => {
		let target: ServerConnection = { mode: "local", url: url.trim() || null };
		if (mode === "remote") {
			const result = await test();
			if (!result.ok || !result.url) return;
			target = { mode: "remote", url: result.url };
		}
		setBusy(true);
		try {
			await connection.apply(target); // relaunches the app on success
		} catch {
			setStatus({ ok: false, text: "The connection could not be saved." });
			setBusy(false);
		}
	};

	const locked = snapshot.dev;
	return (
		<>
			<SettingsRow
				label="Server"
				testid="row-server"
				hint={locked ? "The development shell always uses LH_DEV_URL." : activeServerText(snapshot.active)}
			>
				<ThinSelect value={mode} ariaLabel="server" testid="server-mode" disabled={locked || busy} onChange={(next) => { setMode(next === "remote" ? "remote" : "local"); setStatus(null); }}>
					<option value="local">This computer</option>
					<option value="remote">Remote server</option>
				</ThinSelect>
			</SettingsRow>
			{mode === "remote" && !locked && (
				<SettingsRow label="Server address" testid="row-server-address" hint={status ? <span role="status" className={status.ok ? undefined : "text-error"} data-testid="server-status">{status.text}</span> : SERVER_ADDRESS_HINT}>
					<span className="flex items-center gap-2">
						<input
							type="text"
							value={url}
							placeholder="http://192.168.1.20:3000"
							aria-label="server address"
							data-testid="server-url"
							disabled={busy}
							spellCheck={false}
							onChange={(e) => { setUrl(e.target.value); setStatus(null); }}
							onKeyDown={(e) => { if (e.key === "Enter") void test(); }}
							className="h-7 w-56 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
						/>
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="server-test" disabled={busy || !url.trim()} onClick={() => void test()}>Test</Button>
					</span>
				</SettingsRow>
			)}
			{!locked && connectionChanged(snapshot.active, mode, url) && (
				<SettingsRow label="Apply connection" testid="row-server-apply" hint="LearnHarness restarts to switch servers.">
					<Button type="button" size="xs" className="cursor-pointer" data-testid="server-apply" disabled={busy || (mode === "remote" && !url.trim())} onClick={() => void apply()}>Apply &amp; restart</Button>
				</SettingsRow>
			)}
		</>
	);
}
