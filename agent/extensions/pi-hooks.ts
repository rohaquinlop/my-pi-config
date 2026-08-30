/**
 * Pi Hooks Extension
 *
 * Declarative shell-command hooks for pi's lifecycle events. Configure hooks
 * as JSON and implement them as plain shell scripts:
 *
 *   ~/.pi/agent/hooks.json   global hooks (all projects)
 *   .pi/hooks.json           project hooks (trusted projects only)
 *
 * Events map onto pi's extension lifecycle:
 *   preToolUse        tool_call          can block, can patch tool input
 *   postToolUse       turn_end (once per turn; edits collected from
 *                     tool_result)      report-only; non-empty stdout is
 *                                       delivered as a visible message
 *   userPromptSubmit  input + before_agent_start  can block, can inject context
 *   sessionStart      session_start      report-only
 *   sessionEnd        session_shutdown   report-only
 *
 * Matchers target tool names and optionally file paths: `bash`, `write|edit`,
 * `write(*.rs)`, `write|edit(*.py)`. The path glob matches the tool's `path`
 * input field; `*` crosses directory separators, so `*.rs` matches
 * `crates/foo/src/lib.rs`.
 *
 * Each matched hook command receives a JSON payload on stdin. Decisions come
 * back via stdout (JSON) with an exit-code fallback:
 *   - stdout parses as { action: "block" | "mutate" | "continue" } -> honored
 *   - otherwise exit code 0 = allow, non-zero = block (stdout is the reason)
 *
 * Hook failures are fail-open (onError: "allow", the default) or fail-closed
 * (onError: "block" for preToolUse / userPromptSubmit). Failures always show
 * a user notification.
 *
 * Config files are re-read when their mtime or size changes, so edits apply
 * to the next event without a restart. Project hooks run only when the
 * project is trusted (ctx.isProjectTrusted()).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HookEventName = "preToolUse" | "postToolUse" | "userPromptSubmit" | "sessionStart" | "sessionEnd";

const HOOK_EVENTS: readonly HookEventName[] = [
	"preToolUse",
	"postToolUse",
	"userPromptSubmit",
	"sessionStart",
	"sessionEnd",
];

interface HookEntry {
	id?: string;
	event: HookEventName;
	/** Exact tool name or `*` glob, optionally with a path glob: `write(*.rs)`. */
	matcher?: string;
	/** Shell command line (run via /bin/sh -c) or [cmd, ...args] (spawned directly). */
	command: string | string[];
	/** Milliseconds before the hook is killed. Default 10000. */
	timeoutMs?: number;
	/** Behavior when the hook crashes or times out. Default "allow". */
	onError?: "allow" | "block";
}

interface HooksFile {
	version?: number;
	hooks?: HookEntry[];
}

type HookDecision =
	| { action: "block"; reason?: string }
	| { action: "mutate"; input: Record<string, unknown> }
	| { action: "continue" };

interface HookRunResult {
	entry: HookEntry;
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	failed: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1_000_000; // 1 MB safety cap per stream
const MAX_INJECT_CHARS = 20_000; // cap for combined per-turn injected output

// Global config lives in the agent config dir (honors PI_CODING_AGENT_DIR).
const GLOBAL_CONFIG_PATH = join(getAgentDir(), "hooks.json");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface FileStamp {
	mtimeMs: number;
	size: number;
}

interface ParsedMatcher {
	/** null = all tools */
	toolRegex: RegExp | null;
	/** null = no path constraint */
	pathRegex: RegExp | null;
}

interface CachedConfig {
	entries: HookEntry[];
	matchers: Map<HookEntry, ParsedMatcher>;
	projectPath: string;
	trusted: boolean;
	globalStamp: FileStamp;
	projectStamp: FileStamp;
}

interface TurnEdit {
	toolName: string;
	input: Record<string, unknown>;
	path: string | undefined;
	/** Dedupe key: path when present, otherwise tool + serialized input. */
	key: string;
}

interface PiHooksState {
	config: CachedConfig | undefined;
	pendingContext: string[] | undefined;
	turnEdits: TurnEdit[];
	lastWarn: string | undefined;
}

const state: PiHooksState = {
	config: undefined,
	pendingContext: undefined,
	turnEdits: [],
	lastWarn: undefined,
};

function warnOnce(ctx: ExtensionContext | undefined, message: string) {
	if (state.lastWarn === message) return;
	state.lastWarn = message;
	ctx?.ui.notify(message, "warning");
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

	function matcherRegex(matcher: string | undefined): ParsedMatcher {
	if (!matcher) return { toolRegex: null, pathRegex: null };
	const match = matcher.match(/^([^()]*?)(?:\((.*)\))?$/);
	// A malformed matcher must never match anything.
	if (!match) return { toolRegex: /(?!)/, pathRegex: null };
	const toolPart = match[1].trim();
	const pathPart = match[2]?.trim();
	const toolRegex = toolPart
		? new RegExp(`^(${toolPart.split("|").map((alt) => alt.split("*").map(escapeRegex).join(".*")).join("|")})$`)
		: null;
	const pathRegex = pathPart ? new RegExp(`^${pathPart.split("*").map(escapeRegex).join(".*")}$`) : null;
	return { toolRegex, pathRegex };
}

/** Extract a string path from tool input, if the tool has one. */
function inputPath(input: unknown): string | undefined {
	if (input && typeof input === "object" && "path" in input) {
		const path = (input as Record<string, unknown>).path;
		if (typeof path === "string") return path;
	}
	return undefined;
}

function matcherMatches(matcher: ParsedMatcher, toolName: string, path: string | undefined): boolean {
	if (matcher.toolRegex && !matcher.toolRegex.test(toolName)) return false;
	if (matcher.pathRegex) {
		if (path === undefined) return false;
		if (!matcher.pathRegex.test(path)) return false;
	}
	return true;
}

function validEntry(entry: unknown): entry is HookEntry {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as HookEntry;
	if (!(HOOK_EVENTS as readonly string[]).includes(candidate.event)) return false;
	if (Array.isArray(candidate.command)) {
		if (candidate.command.length === 0 || !candidate.command.every((part) => typeof part === "string")) return false;
	} else if (typeof candidate.command !== "string" || candidate.command.trim() === "") {
		return false;
	}
	return true;
}

function statSafe(path: string): FileStamp {
	try {
		const info = statSync(path);
		return { mtimeMs: info.mtimeMs, size: info.size };
	} catch {
		return { mtimeMs: 0, size: 0 };
	}
}

function readFile(path: string): HooksFile | { error: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as HooksFile;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.hooks)) {
			return { error: "missing a \"hooks\" array" };
		}
		if (typeof parsed.version === "number" && parsed.version > 1) {
			return { error: `unsupported version ${parsed.version}` };
		}
		return parsed;
	} catch (error) {
		// No config file is the normal case — silent, no hooks.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Read global + project hooks files, merging by id (project wins). Results
 * are cached and rebuilt only when a file's mtime or size changes, the
 * project path changes, or the trust status changes.
 */
function loadConfig(ctx: ExtensionContext): CachedConfig {
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "hooks.json");
	const trusted = ctx.isProjectTrusted();
	const cached = state.config;
	const globalStamp = statSafe(GLOBAL_CONFIG_PATH);
	const projectStamp = statSafe(projectPath);

	const unchanged =
		cached !== undefined &&
		cached.projectPath === projectPath &&
		cached.trusted === trusted &&
		cached.globalStamp.mtimeMs === globalStamp.mtimeMs &&
		cached.globalStamp.size === globalStamp.size &&
		cached.projectStamp.mtimeMs === projectStamp.mtimeMs &&
		cached.projectStamp.size === projectStamp.size;
	if (unchanged) return cached;

	const globalFile = readFile(GLOBAL_CONFIG_PATH);
	if (globalFile && "error" in globalFile) {
		warnOnce(ctx, `pi-hooks: failed to load ${GLOBAL_CONFIG_PATH}: ${globalFile.error}`);
	}

	// Project hooks run only for trusted projects. An untrusted project's
	// hooks.json is never read, so no project-defined command can execute.
	const projectFile = trusted ? readFile(projectPath) : undefined;
	if (projectFile && "error" in projectFile) {
		warnOnce(ctx, `pi-hooks: failed to load ${projectPath}: ${projectFile.error}`);
	}

	const globalEntries = globalFile && !("error" in globalFile) ? (globalFile.hooks ?? []) : [];
	const projectEntries = projectFile && !("error" in projectFile) ? (projectFile.hooks ?? []) : [];

	// Merge by id: a project entry with the same id replaces the global one.
	const entries: HookEntry[] = [];
	const indexById = new Map<string, number>();
	for (const raw of [...globalEntries, ...projectEntries]) {
		if (!validEntry(raw)) {
			warnOnce(ctx, `pi-hooks: skipping invalid hook entry (event and command are required)`);
			continue;
		}
		if (raw.id && indexById.has(raw.id)) {
			entries[indexById.get(raw.id)!] = raw;
			continue;
		}
		if (raw.id) indexById.set(raw.id, entries.length);
		entries.push(raw);
	}

	const matchers = new Map<HookEntry, ParsedMatcher>();
	for (const entry of entries) matchers.set(entry, matcherRegex(entry.matcher));

	state.config = { entries, matchers, projectPath, trusted, globalStamp, projectStamp };
	return state.config;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function hookLabel(entry: HookEntry): string {
	if (entry.id) return `"${entry.id}"`;
	return typeof entry.command === "string" ? entry.command.split(/\s+/)[0] : entry.command[0] ?? "(hook)";
}

function hookEnv(ctx: ExtensionContext, event: HookEventName, toolName?: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PI_HOOK_EVENT: event,
		...(toolName ? { PI_HOOK_TOOL: toolName } : {}),
		PI_SESSION_ID: ctx.sessionManager.getSessionId(),
		PI_SESSION_FILE: ctx.sessionManager.getSessionFile() ?? "",
		PI_PROVIDER: ctx.model?.provider ?? "",
		PI_MODEL: ctx.model?.id ?? "",
		PI_REASONING_LEVEL: ctx.thinkingLevel ?? "off",
	};
}

function runHook(entry: HookEntry, payload: unknown, ctx: ExtensionContext, toolName?: string): Promise<HookRunResult> {
	return new Promise((resolve) => {
		const cmd = Array.isArray(entry.command) ? entry.command[0] : "/bin/sh";
		const args = Array.isArray(entry.command) ? entry.command.slice(1) : ["-c", entry.command];
		const child = spawn(cmd, args, {
			cwd: ctx.cwd,
			env: hookEnv(ctx, entry.event, toolName),
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let failed = false;
		let settled = false;
		let finalCode: number | null = null;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ entry, stdout, stderr, code: finalCode, timedOut, failed });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
		});
		child.on("error", (error) => {
			// Spawn failure (missing binary, bad cwd): no "close" follows.
			failed = true;
			stderr = error.message;
			finish();
		});
		child.on("close", (code) => {
			finalCode = code;
			finish();
		});

		child.stdin?.on("error", () => {
			// Broken stdin pipe — the child closed early. "close" settles it.
		});
		child.stdin?.end(JSON.stringify(payload));
	});
}

async function runMatching(
	ctx: ExtensionContext,
	event: HookEventName,
	toolName: string | undefined,
	input: unknown,
	payload: unknown,
): Promise<HookRunResult[]> {
	const config = loadConfig(ctx);
	const path = inputPath(input);
	const entries = config.entries.filter((entry) => {
		if (entry.event !== event) return false;
		if (toolName === undefined) return true;
		return matcherMatches(config.matchers.get(entry) ?? { toolRegex: null, pathRegex: null }, toolName, path);
	});
	if (entries.length === 0) return [];
	return Promise.all(entries.map((entry) => runHook(entry, payload, ctx, toolName)));
}

/** True when stdout is a structured decision object (block/mutate/continue). */
function isDecisionJson(stdout: string): boolean {
	const text = stdout.trim();
	if (!text.startsWith("{")) return false;
	try {
		const obj = JSON.parse(text) as Record<string, unknown>;
		return !!obj && typeof obj === "object" && typeof obj.action === "string";
	} catch {
		return false;
	}
}

/**
 * Turn hook output into a decision. JSON stdout wins; otherwise the exit
 * code decides (0 = continue, non-zero = block with stdout as the reason).
 */
function parseDecision(result: HookRunResult): HookDecision {
	const text = result.stdout.trim();
	if (text.startsWith("{")) {
		try {
			const obj = JSON.parse(text) as Record<string, unknown>;
			if (obj && typeof obj === "object" && typeof obj.action === "string") {
				if (obj.action === "block") {
					return { action: "block", reason: typeof obj.reason === "string" ? obj.reason : undefined };
				}
				if (obj.action === "mutate" && obj.input && typeof obj.input === "object" && !Array.isArray(obj.input)) {
					return { action: "mutate", input: obj.input as Record<string, unknown> };
				}
				if (obj.action === "continue") return { action: "continue" };
			}
		} catch {
			// Not JSON — fall through to exit-code semantics.
		}
	}
	if (result.code === 0) return { action: "continue" };
	return { action: "block", reason: text || `hook exited with code ${result.code ?? "unknown"}` };
}

function failureReason(result: HookRunResult): string {
	const label = hookLabel(result.entry);
	if (result.failed) return `pi-hooks: hook ${label} failed to start: ${result.stderr || "unknown error"}`;
	if (result.code === 127) return `pi-hooks: hook ${label} command not found`;
	if (result.code === 126) return `pi-hooks: hook ${label} command not executable`;
	return `pi-hooks: hook ${label} timed out`;
}

/** A crash = spawn failure, timeout, or shell "not found" exits. */
function isCrash(result: HookRunResult): boolean {
	return result.failed || result.timedOut || result.code === 126 || result.code === 127;
}

function notifyFailure(ctx: ExtensionContext, result: HookRunResult) {
	const label = hookLabel(result.entry);
	const detail = result.failed ? result.stderr || "failed to start" : result.timedOut ? "timed out" : `exited ${result.code}`;
	ctx.ui.notify(`pi-hooks: ${result.entry.event} hook ${label} ${detail}`, "warning");
}

function basePayload(ctx: ExtensionContext, event: HookEventName): Record<string, unknown> {
	return {
		hookVersion: 1,
		event,
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
		model: ctx.model?.id ?? null,
		provider: ctx.model?.provider ?? null,
	};
}

function toolPayload(
	ctx: ExtensionContext,
	event: HookEventName,
	toolName: string,
	toolCallId: string,
	input: unknown,
): Record<string, unknown> {
	return { ...basePayload(ctx, event), toolName, toolCallId, input };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// preToolUse: can block, can patch tool input.
	pi.on("tool_call", async (event, ctx) => {
		const payload = toolPayload(ctx, "preToolUse", event.toolName, event.toolCallId, event.input);
		const results = await runMatching(ctx, "preToolUse", event.toolName, event.input, payload);
		for (const result of results) {
			if (isCrash(result)) {
				notifyFailure(ctx, result);
				if (result.entry.onError === "block") {
					return { block: true, reason: failureReason(result) };
				}
				continue;
			}
			const decision = parseDecision(result);
			if (decision.action === "block") {
				return {
					block: true,
					reason: decision.reason || `pi-hooks: blocked by hook ${hookLabel(result.entry)}`,
				};
			}
			if (decision.action === "mutate") {
				Object.assign(event.input as Record<string, unknown>, decision.input);
			}
		}
	});

	// postToolUse: collect tool calls during the turn; hooks run once at
	// turn_end against the coalesced batch. The tool result is never modified.
	pi.on("tool_result", async (event) => {
		const path = inputPath(event.input);
		const key = path ?? `${event.toolName}:${JSON.stringify(event.input)}`;
		if (!state.turnEdits.some((edit) => edit.key === key)) {
			state.turnEdits.push({
				toolName: event.toolName,
				input: event.input as Record<string, unknown>,
				path,
				key,
			});
		}
	});

	// Run each matching postToolUse hook once per turn with a payload that
	// lists the whole edit batch, then deliver non-empty output as a visible
	// message. Visible messages are stored in the session and sent to the
	// model, so the agent sees failures on its next LLM call and the user
	// sees them in the transcript even after the agent settles.
	pi.on("turn_end", async (_event, ctx) => {
		const records = state.turnEdits;
		state.turnEdits = [];
		if (records.length === 0) return;

		const config = loadConfig(ctx);
		const matches = (entry: HookEntry, record: TurnEdit) =>
			matcherMatches(config.matchers.get(entry) ?? { toolRegex: null, pathRegex: null }, record.toolName, record.path);
		const selected = config.entries.filter(
			(entry) => entry.event === "postToolUse" && records.some((record) => matches(entry, record)),
		);
		if (selected.length === 0) return;

		const results = await Promise.all(
			selected.map((entry) => {
				const matched = records.filter((record) => matches(entry, record));
				const toolNames = [...new Set(matched.map((record) => record.toolName))];
				const paths = [...new Set(matched.map((record) => record.path).filter((p): p is string => p !== undefined))];
				const payload = {
					...basePayload(ctx, "postToolUse"),
					toolNames,
					editedPaths: paths,
					inputs: matched.map((record) => record.input),
				};
				return runHook(entry, payload, ctx);
			}),
		);

		const blocks: string[] = [];
		for (const result of results) {
			if (isCrash(result)) {
				notifyFailure(ctx, result);
				continue;
			}
			if (isDecisionJson(result.stdout)) continue; // structured decisions are meaningless here
			const text = result.stdout.trim();
			if (text) {
				blocks.push(`[postToolUse ${hookLabel(result.entry)}]\n${text}`);
			}
		}
		if (blocks.length === 0) return;

		// Cap total output: keep the newest blocks, drop the oldest.
		let combined = "";
		for (const block of [...blocks].reverse()) {
			if (combined.length + block.length + 1 > MAX_INJECT_CHARS) {
				// The newest block alone exceeds the cap: truncate it.
				if (combined === "") combined = block.slice(0, MAX_INJECT_CHARS);
				break;
			}
			combined = combined ? `${block}\n\n${combined}` : block;
		}
		pi.sendMessage({ customType: "pi-hooks", content: combined, display: true });
	});

	// Clear the edit collection at each turn boundary so a stray record
	// never leaks into the next run.
	pi.on("turn_start", async () => {
		state.turnEdits = [];
	});

	// userPromptSubmit: can block the prompt and inject context for the turn.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return; // never hook extension-generated input
		const payload = {
			...basePayload(ctx, "userPromptSubmit"),
			prompt: event.text,
			images: event.images?.length ?? 0,
			source: event.source,
		};
		const results = await runMatching(ctx, "userPromptSubmit", undefined, undefined, payload);
		const injected: string[] = [];
		for (const result of results) {
			if (isCrash(result)) {
				notifyFailure(ctx, result);
				if (result.entry.onError === "block") return { action: "handled" };
				continue;
			}
			const decision = parseDecision(result);
			if (decision.action === "block") {
				ctx.ui.notify(
					`pi-hooks blocked prompt: ${decision.reason || `hook ${hookLabel(result.entry)}`}`,
					"warning",
				);
				return { action: "handled" };
			}
			const text = result.stdout.trim();
			if (text) injected.push(text);
		}
		state.pendingContext = injected.length > 0 ? injected : undefined;
	});

	// Inject pending prompt-hook context into the next model request.
	pi.on("before_agent_start", async () => {
		if (!state.pendingContext || state.pendingContext.length === 0) return;
		const content = state.pendingContext.join("\n\n");
		state.pendingContext = undefined;
		return { message: { customType: "pi-hooks", content, display: true } };
	});

	// Clear stale context when the turn ends, e.g. when the prompt never
	// reached before_agent_start (handled by another extension).
	pi.on("agent_end", async () => {
		state.pendingContext = undefined;
		state.turnEdits = [];
	});

	// sessionStart / sessionEnd: report-only.
	pi.on("session_start", async (event, ctx) => {
		const payload = { ...basePayload(ctx, "sessionStart"), reason: event.reason };
		const results = await runMatching(ctx, "sessionStart", undefined, undefined, payload);
		for (const result of results) {
			if (isCrash(result)) notifyFailure(ctx, result);
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const payload = { ...basePayload(ctx, "sessionEnd"), reason: event.reason };
		const results = await runMatching(ctx, "sessionEnd", undefined, undefined, payload);
		for (const result of results) {
			if (isCrash(result)) notifyFailure(ctx, result);
		}
	});
}
