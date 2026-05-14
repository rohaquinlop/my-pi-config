/**
 * Compact Progress Extension
 *
 * Shows a live progress bar while /compact or auto-compaction runs.
 * Pi exposes only before/after compaction hooks, so progress is phase/time based:
 * preparation is done when session_before_compact fires, summary generation advances
 * gradually, and completion jumps to 100% when session_compact fires.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PhaseId = "prepare" | "summarize" | "save" | "reload";

type Phase = {
	id: PhaseId;
	label: string;
	percent: number;
};

const WIDGET_KEY = "compact-progress";
const TICK_MS = 350;
const DONE_VISIBLE_MS = 1200;
const STALL_TIMEOUT_MS = 5 * 60 * 1000;
const BAR_WIDTH = 28;

const PHASES: Phase[] = [
	{ id: "prepare", label: "Prepare messages", percent: 8 },
	{ id: "summarize", label: "Summarize old context", percent: 86 },
	{ id: "save", label: "Save compacted entry", percent: 96 },
	{ id: "reload", label: "Reload trimmed context", percent: 100 },
];

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function formatCount(value: number): string {
	return Number.isFinite(value) ? value.toLocaleString() : "0";
}

function getColor(ctx: ExtensionContext, percent: number): "accent" | "success" | "warning" {
	if (percent >= 100) return "success";
	if (percent >= 90) return "warning";
	return "accent";
}

function progressBar(ctx: ExtensionContext, percent: number): string {
	const filled = clamp(Math.round((percent / 100) * BAR_WIDTH), 0, BAR_WIDTH);
	const full = "█".repeat(filled);
	const empty = "░".repeat(BAR_WIDTH - filled);
	const color = getColor(ctx, percent);
	return ctx.ui.theme.fg(color, full) + ctx.ui.theme.fg("dim", empty);
}

function phaseLines(ctx: ExtensionContext, percent: number): string[] {
	return PHASES.map((phase) => {
		const done = percent >= phase.percent;
		const current = !done && percent >= (PHASES[PHASES.findIndex((p) => p.id === phase.id) - 1]?.percent ?? 0);
		const marker = done ? ctx.ui.theme.fg("success", "✓") : current ? ctx.ui.theme.fg("accent", "●") : ctx.ui.theme.fg("dim", "○");
		const text = done ? ctx.ui.theme.fg("muted", phase.label) : current ? ctx.ui.theme.fg("text", phase.label) : ctx.ui.theme.fg("dim", phase.label);
		return `│  ${marker} ${text}`;
	});
}

function renderWidget(ctx: ExtensionContext, percent: number, messageCount: number, tokensBefore: number): string[] {
	const pending = clamp(100 - percent, 0, 100);
	const pct = `${Math.floor(percent).toString().padStart(3, " ")}%`;
	const left = ctx.ui.theme.fg("accent", "compact");
	const stats = ctx.ui.theme.fg("dim", `${formatCount(messageCount)} msgs • ${formatCount(tokensBefore)} tokens`);
	return [
		ctx.ui.theme.fg("dim", "┌─ ") + left + ctx.ui.theme.fg("dim", ` ${stats}`),
		`│  ${progressBar(ctx, percent)}  ${ctx.ui.theme.fg(getColor(ctx, percent), pct)} done • ${ctx.ui.theme.fg("dim", `${Math.ceil(pending)}% pending`)}`,
		...phaseLines(ctx, percent),
		ctx.ui.theme.fg("dim", "└─ Esc cancels compaction"),
	];
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let clearTimer: ReturnType<typeof setTimeout> | undefined;
	let lastCtx: ExtensionContext | undefined;
	let startedAt = 0;
	let percent = 0;
	let messageCount = 0;
	let tokensBefore = 0;

	function stopTimers() {
		if (timer) clearInterval(timer);
		if (clearTimer) clearTimeout(clearTimer);
		timer = undefined;
		clearTimer = undefined;
	}

	function clear(ctx: ExtensionContext | undefined = lastCtx) {
		stopTimers();
		ctx?.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
	}

	function paint(ctx: ExtensionContext) {
		lastCtx = ctx;
		ctx.ui.setWidget(WIDGET_KEY, renderWidget(ctx, percent, messageCount, tokensBefore), { placement: "aboveEditor" });
	}

	function setPercent(ctx: ExtensionContext, nextPercent: number) {
		percent = clamp(Math.max(percent, nextPercent), 0, 100);
		paint(ctx);
	}

	function start(ctx: ExtensionContext) {
		stopTimers();
		lastCtx = ctx;
		startedAt = Date.now();
		percent = 8;
		paint(ctx);

		timer = setInterval(() => {
			if (!lastCtx) return;
			const elapsed = Date.now() - startedAt;
			// Smooth, bounded estimate during LLM summary. Never claim save/reload until real completion.
			const estimated = 8 + 78 * (1 - Math.exp(-elapsed / 18_000));
			setPercent(lastCtx, clamp(estimated, 8, 86));
			if (elapsed > STALL_TIMEOUT_MS) clear(lastCtx);
		}, TICK_MS);
	}

	pi.on("session_before_compact", async (event, ctx) => {
		const prep = event.preparation;
		messageCount = prep.messagesToSummarize.length + prep.turnPrefixMessages.length;
		tokensBefore = prep.tokensBefore;
		start(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		setPercent(ctx, 100);
		stopTimers();
		clearTimer = setTimeout(() => clear(ctx), DONE_VISIBLE_MS);
	});

	pi.on("session_shutdown", async () => clear());

	pi.registerCommand("compact-progress", {
		description: "Show compact progress bar status",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Compact progress bar is enabled for /compact and auto-compaction.", "info");
		},
	});
}
