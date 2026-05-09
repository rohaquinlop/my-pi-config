/**
 * Effort Command Extension
 *
 * Adds /effort to change current model thinking/reasoning level.
 * Usage:
 *   /effort                interactive picker
 *   /effort high           set level
 *   /effort off            disable reasoning
 *   /effort max            alias for xhigh
 *   /effort current        show current level
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const LEVELS: EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ALIASES: Record<string, EffortLevel> = {
	"0": "off",
	none: "off",
	off: "off",
	min: "minimal",
	minimal: "minimal",
	1: "low",
	low: "low",
	2: "medium",
	med: "medium",
	medium: "medium",
	3: "high",
	high: "high",
	4: "xhigh",
	max: "xhigh",
	xhigh: "xhigh",
	"extra-high": "xhigh",
};

const STATUS_KEY = "effort";

function normalize(input: string): EffortLevel | undefined {
	return ALIASES[input.trim().toLowerCase()];
}

function status(level: EffortLevel, theme: { fg: (color: string, text: string) => string }): string {
	const label = `[effort:${level}]`;
	if (level === "off") return theme.fg("muted", label);
	if (level === "minimal" || level === "low") return theme.fg("success", label);
	if (level === "medium") return theme.fg("warning", label);
	return theme.fg("accent", label);
}

export default function (pi: ExtensionAPI) {
	function current(): EffortLevel {
		return pi.getThinkingLevel() as EffortLevel;
	}

	function updateStatus(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void; theme: { fg: (color: string, text: string) => string } } }) {
		ctx.ui.setStatus(STATUS_KEY, status(current(), ctx.ui.theme));
	}

	async function setEffort(level: EffortLevel, ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void; setStatus: (key: string, value: string | undefined) => void; theme: { fg: (color: string, text: string) => string } } }) {
		const before = current();
		await pi.setThinkingLevel(level);
		const after = current();
		updateStatus(ctx);

		if (after !== level) {
			ctx.ui.notify(`Effort clamped: requested ${level}, using ${after} (model capability).`, "warning");
		} else if (after !== before) {
			ctx.ui.notify(`Effort: ${after}`, "info");
		} else {
			ctx.ui.notify(`Effort already ${after}`, "info");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.registerCommand("effort", {
		description: "Change model reasoning effort: off, minimal, low, medium, high, xhigh",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const values = [...LEVELS, "min", "med", "max", "current", "help"];
			const matches = values.filter((value) => value.startsWith(p)).map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "help" || arg === "-h" || arg === "--help") {
				ctx.ui.notify("Usage: /effort [off|minimal|low|medium|high|xhigh|max|current]", "info");
				return;
			}

			if (arg === "current" || arg === "show" || arg === "status") {
				ctx.ui.notify(`Current effort: ${current()}`, "info");
				return;
			}

			let level = arg ? normalize(arg) : undefined;
			if (!level) {
				if (arg) {
					ctx.ui.notify(`Invalid effort "${args}". Use: ${LEVELS.join(", ")}.`, "error");
					return;
				}
				const choice = await ctx.ui.select("Set effort:", LEVELS);
				if (!choice) return;
				level = choice as EffortLevel;
			}

			await setEffort(level, ctx);
		},
	});
}
