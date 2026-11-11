import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FACTORY_SETTINGS, isUiStyle, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { BUILTIN_THEMES, DEFAULT_THEME } from "../src/core/themes.ts";

describe("interface style (identity wave)", () => {
	it("defaults to editorial and accepts only the two styles", () => {
		assert.equal(FACTORY_SETTINGS.appearance.uiStyle, "editorial");
		assert.equal(resolveSettings(null).appearance.uiStyle, "editorial");
		assert.equal(isUiStyle("classic"), true);
		assert.equal(isUiStyle("brutalist"), false);
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { uiStyle: "classic" } })?.appearance?.uiStyle, "classic");
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { uiStyle: "nope" } })?.appearance?.uiStyle, undefined);
		assert.deepEqual(parseAppearanceSettingsBody({ uiStyle: "classic" }), { ok: true, settings: { uiStyle: "classic" } });
		assert.equal(parseAppearanceSettingsBody({ uiStyle: 3 }).ok, false);
	});

	it("the stylesheet scopes the editorial overrides to the attribute", () => {
		const css = fs.readFileSync("app/globals.css", "utf8");
		assert.match(css, /html\[data-ui-style="editorial"\] \.uppercase \{\s*text-transform: none;/);
		assert.match(css, /html\[data-ui-style="editorial"\] :is\(\.tracking-widest, \.tracking-wider, \.tracking-wide\)/);
		const layout = fs.readFileSync("app/layout.tsx", "utf8");
		assert.match(layout, /data-ui-style=\{appearance\?\.uiStyle \?\? "editorial"\}/);
	});

	it("the original look stays one click away: Classic is the old Default palette", () => {
		const classic = BUILTIN_THEMES.find((t) => t.id === "classic")!;
		assert.equal(classic.colors.background, "#141414");
		assert.equal(classic.mode, "dark");
		assert.equal(DEFAULT_THEME.colors.bold, DEFAULT_THEME.colors.text, "Default's emphasis inks stay the text color");
		assert.equal(BUILTIN_THEMES.find((t) => t.id === "paper")?.mode, "light");
	});
});
