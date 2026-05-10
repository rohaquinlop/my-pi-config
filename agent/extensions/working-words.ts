/**
 * Working Words Extension
 *
 * Shows Claude Code-like animated status words while pi is streaming.
 * Useful when thinking blocks are hidden.
 *
 * Commands:
 *   /working-words          show current mode
 *   /working-words on       enable animated words
 *   /working-words off      hide custom animation
 *   /working-words default  restore pi default loader
 */

import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

type Mode = "on" | "off" | "default";

const WIDGET_KEY = "working-words-widget";
const FRAME_INTERVAL_MS = 260;

const WORDS = [
	"Thinking",
	"Reading",
	"Scanning",
	"Planning",
	"Checking",
	"Editing",
	"Testing",
	"Polishing",
];

const GLYPHS = ["✻", "✢", "✳", "✶"];
const DOTS = ["", ".", "..", "..."];

function frameText(index: number): string {
	const word = WORDS[Math.floor(index / 12) % WORDS.length];
	const glyph = GLYPHS[index % GLYPHS.length];
	const dots = DOTS[index % DOTS.length];
	return `${glyph} ${word}${dots}`;
}

function buildIndicator(ctx: ExtensionContext): WorkingIndicatorOptions {
	const frames = Array.from({ length: WORDS.length * 12 }, (_unused, index) =>
		ctx.ui.theme.fg(index % 2 === 0 ? "accent" : "text", frameText(index)),
	);

	return {
		frames,
		intervalMs: FRAME_INTERVAL_MS,
	};
}

function widgetLines(ctx: ExtensionContext, frameIndex: number): string[] {
	const line = ctx.ui.theme.fg(frameIndex % 2 === 0 ? "accent" : "text", frameText(frameIndex));
	return [ctx.ui.theme.fg("dim", "┌─ agent working"), `│  ${line}`, ctx.ui.theme.fg("dim", "└─ tools stay in chat")];
}

function apply(ctx: ExtensionContext, mode: Mode, frameIndex = 0, active = false) {
	if (mode === "on") {
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setWorkingMessage(" ");
		ctx.ui.setWorkingIndicator({ frames: [] });
		ctx.ui.setHiddenThinkingLabel(" ");
		ctx.ui.setWidget(WIDGET_KEY, active ? widgetLines(ctx, frameIndex) : undefined, { placement: "aboveEditor" });
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

	function stopTimer() {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function startTimer(ctx: ExtensionContext) {
		stopTimer();
		if (mode !== "on") return;
		apply(ctx, mode, frameIndex, true);
		timer = setInterval(() => {
			frameIndex += 1;
			apply(ctx, mode, frameIndex, true);
		}, FRAME_INTERVAL_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		apply(ctx, mode, frameIndex);
	});

	pi.on("agent_start", async (_event, ctx) => {
		startTimer(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (mode !== "on" || event.message.role !== "assistant") return;
		apply(ctx, mode, frameIndex, true);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer();
		apply(ctx, mode, frameIndex, false);
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
	});

	pi.registerCommand("working-words", {
		description: "Animated working words: on, off, default",
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
			apply(ctx, mode, frameIndex, false);
			ctx.ui.notify(`Working words: ${mode}`, "info");
		},
	});
}
