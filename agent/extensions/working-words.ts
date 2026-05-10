/**
 * Working Words Extension
 *
 * Shows real, tool-driven status words while pi is working.
 *
 * Commands:
 *   /working-words          show current mode
 *   /working-words on       enable real working words
 *   /working-words off      hide custom animation
 *   /working-words default  restore pi default loader
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "on" | "off" | "default";

type Activity = {
	label: string;
	startedAt: number;
};

const WIDGET_KEY = "working-words-widget";
const FRAME_INTERVAL_MS = 260;
const GLYPHS = ["✻", "✢", "✳", "✶"];
const DOTS = ["", ".", "..", "..."];
const MAX_TARGET_WIDTH = 46;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function compactPath(value: string, cwd?: string): string {
	let result = value;
	if (cwd && path.isAbsolute(value)) {
		const relative = path.relative(cwd, value);
		if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) result = relative;
	}
	result = result.replaceAll(path.sep, "/");
	if (result.startsWith("/Users/")) {
		const parts = result.split("/").filter(Boolean);
		result = parts.length > 2 ? `~/${parts.slice(2).join("/")}` : "~";
	}
	if (result.length <= MAX_TARGET_WIDTH) return result;
	const base = path.basename(result) || result.slice(-MAX_TARGET_WIDTH + 1);
	return `…/${base}`;
}

function hostFromUrl(value: string): string {
	try {
		const url = new URL(value);
		return url.hostname || value;
	} catch {
		return value.length > MAX_TARGET_WIDTH ? `${value.slice(0, MAX_TARGET_WIDTH - 1)}…` : value;
	}
}

function firstCommandToken(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	const withoutPrefix = trimmed.replace(/^(?:source\s+[^\n;]+[\n;]\s*)+/, "").trim();
	const match = withoutPrefix.match(/(?:^|&&|\|\||;|\|)\s*([A-Za-z0-9_./-]+)/);
	if (!match?.[1]) return undefined;
	return path.basename(match[1]);
}

function activityForTool(toolName: string, args: unknown, cwd?: string): string {
	const input = asRecord(args);
	const name = toolName.replace(/^functions\./, "");

	switch (name) {
		case "read":
		case "read_pdf": {
			const target = stringField(input, "path");
			return target ? `Reading ${compactPath(target, cwd)}` : "Reading file";
		}
		case "write": {
			const target = stringField(input, "path");
			return target ? `Writing ${compactPath(target, cwd)}` : "Writing file";
		}
		case "edit": {
			const target = stringField(input, "path");
			return target ? `Editing ${compactPath(target, cwd)}` : "Editing file";
		}
		case "bash": {
			const token = firstCommandToken(stringField(input, "command") ?? "");
			return token ? `Running ${token}` : "Running command";
		}
		case "web_search": {
			const query = stringField(input, "query");
			return query ? `Searching web for “${query.slice(0, 36)}${query.length > 36 ? "…" : ""}”` : "Searching web";
		}
		case "web_fetch": {
			const url = stringField(input, "url");
			return url ? `Fetching ${hostFromUrl(url)}` : "Fetching web page";
		}
		case "web_research":
			return "Researching web";
		case "memory_read":
			return "Reading project memory";
		case "memory_update":
			return "Updating project memory";
		case "memory_status":
			return "Checking project memory";
		case "clarification_ui":
			return "Asking clarification";
		case "skill_scout_record":
			return "Recording skill idea";
		default: {
			const label = name.replaceAll("_", " ");
			return label ? `Using ${label}` : "Using tool";
		}
	}
}

function currentLabel(active: Map<string, Activity>, fallback = "Thinking"): string {
	let newest: Activity | undefined;
	for (const activity of active.values()) {
		if (!newest || activity.startedAt > newest.startedAt) newest = activity;
	}
	return newest?.label ?? fallback;
}

function frameText(label: string, index: number): string {
	const glyph = GLYPHS[index % GLYPHS.length];
	const dots = DOTS[index % DOTS.length];
	return `${glyph} ${label}${dots}`;
}

function widgetLines(ctx: ExtensionContext, label: string, frameIndex: number): string[] {
	const line = ctx.ui.theme.fg(frameIndex % 2 === 0 ? "accent" : "text", frameText(label, frameIndex));
	return [ctx.ui.theme.fg("dim", "┌─ agent working"), `│  ${line}`, ctx.ui.theme.fg("dim", "└─ live from tool activity")];
}

function apply(ctx: ExtensionContext, mode: Mode, label = "Thinking", frameIndex = 0, active = false) {
	if (mode === "on") {
		// Keep the custom Agent working box as the single visible activity UI.
		// The built-in working row would duplicate the same text.
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setWorkingMessage(" ");
		ctx.ui.setWorkingIndicator({ frames: [] });
		ctx.ui.setHiddenThinkingLabel(" ");
		ctx.ui.setWidget(WIDGET_KEY, active ? widgetLines(ctx, label, frameIndex) : undefined, { placement: "aboveEditor" });
		return;
	}

	ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });

	if (mode === "off") {
		ctx.ui.setWorkingIndicator({ frames: [] });
		ctx.ui.setWorkingMessage(" ");
		ctx.ui.setHiddenThinkingLabel(" ");
		return;
	}

	ctx.ui.setWorkingMessage();
	ctx.ui.setWorkingIndicator();
	ctx.ui.setHiddenThinkingLabel();
	ctx.ui.setWorkingVisible(true);
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = "on";
	let timer: ReturnType<typeof setInterval> | undefined;
	let frameIndex = 0;
	let lastCtx: ExtensionContext | undefined;
	const activeTools = new Map<string, Activity>();

	function stopTimer() {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function render(ctx: ExtensionContext, active = true) {
		lastCtx = ctx;
		apply(ctx, mode, currentLabel(activeTools, "Thinking"), frameIndex, active);
	}

	function startTimer(ctx: ExtensionContext) {
		stopTimer();
		if (mode !== "on") return;
		render(ctx, true);
		timer = setInterval(() => {
			frameIndex += 1;
			if (lastCtx) render(lastCtx, true);
		}, FRAME_INTERVAL_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		activeTools.clear();
		apply(ctx, mode, "Thinking", frameIndex, false);
	});

	pi.on("agent_start", async (_event, ctx) => {
		activeTools.clear();
		startTimer(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (mode !== "on") return;
		activeTools.set(event.toolCallId, {
			label: activityForTool(event.toolName, event.args, ctx.cwd),
			startedAt: Date.now(),
		});
		render(ctx, true);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (mode !== "on") return;
		activeTools.delete(event.toolCallId);
		render(ctx, true);
	});

	pi.on("message_update", async (event, ctx) => {
		if (mode !== "on" || event.message.role !== "assistant") return;
		render(ctx, true);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer();
		activeTools.clear();
		apply(ctx, mode, "Thinking", frameIndex, false);
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
		activeTools.clear();
	});

	pi.registerCommand("working-words", {
		description: "Real working words: on, off, default",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			return ["on", "off", "default"].filter((value) => value.startsWith(p)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const next = args.trim().toLowerCase();

			if (!next) {
				ctx.ui.notify(`Working words: ${mode}`, "info");
				return;
			}

			if (next !== "on" && next !== "off" && next !== "default") {
				ctx.ui.notify("Usage: /working-words [on|off|default]", "error");
				return;
			}

			mode = next;
			stopTimer();
			activeTools.clear();
			apply(ctx, mode, "Thinking", frameIndex, false);
			ctx.ui.notify(`Working words: ${mode}`, "info");
		},
	});
}
