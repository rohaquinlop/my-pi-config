/**
 * Caveman Status Extension
 *
 * Shows current caveman mode intensity in the footer status bar.
 * Detects /caveman and caveman:stop commands via input interception.
 *
 * Display: [caveman:ultra] [caveman:full] [caveman:lite] [caveman:off]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CavemanLevel = "off" | "lite" | "full" | "ultra" | "wenyan-lite" | "wenyan-full" | "wenyan-ultra";

const STATUS_KEY = "caveman";

function formatStatus(level: CavemanLevel, theme: { fg: (color: string, text: string) => string }): string {
	const label = `[caveman:${level}]`;
	switch (level) {
		case "ultra":
		case "wenyan-ultra":
			return theme.fg("accent", label);
		case "full":
		case "wenyan-full":
			return theme.fg("success", label);
		case "lite":
		case "wenyan-lite":
			return theme.fg("warning", label);
		case "off":
			return theme.fg("muted", label);
		default:
			return label;
	}
}

export default function (pi: ExtensionAPI) {
	let level: CavemanLevel = "ultra"; // Default per AGENTS.md

	function updateStatus(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void; theme: { fg: (color: string, text: string) => string } } }) {
		if (!ctx.ui) return;
		ctx.ui.setStatus(STATUS_KEY, formatStatus(level, ctx.ui.theme));
	}

	pi.on("session_start", async (_event, ctx) => {
		// Restore from session custom entry if present
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "caveman-status") {
				const data = entry.data as { level?: CavemanLevel };
				if (data?.level) level = data.level;
				break;
			}
		}
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text.trim().toLowerCase();
		let changed = false;

		if (text === "/skill:caveman stop" || text === "caveman:stop" || text === "/caveman stop") {
			level = "off";
			changed = true;
		} else if (text.startsWith("/caveman ")) {
			const arg = text.slice("/caveman ".length).trim();
			const validLevels: CavemanLevel[] = ["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"];
			if (validLevels.includes(arg as CavemanLevel)) {
				level = arg as CavemanLevel;
				changed = true;
			}
		}

		if (changed) {
			pi.appendEntry("caveman-status", { level });
			updateStatus(ctx);
		}

		return { action: "continue" };
	});
}
