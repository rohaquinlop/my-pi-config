/**
 * GitHub CLI Tool Extension
 *
 * Wraps the `gh` CLI as a registered Pi tool with allowlisted commands,
 * JSON output parsing, and field extraction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Allowlist of safe gh commands (top-level subcommand → allowed sub-subcommands)
// ---------------------------------------------------------------------------

const ALLOWED_COMMANDS: Record<string, string[]> = {
	// PR (read)
	pr: [
		"view", "list", "status", "diff", "checks",
		// PR (write)
		"create", "edit", "merge", "close", "reopen",
		"review", "comment", "ready", "update-branch",
		"revert", "lock", "unlock",
	],
	// Issue (read)
	issue: [
		"view", "list", "status",
		// Issue (write)
		"create", "edit", "close", "reopen",
		"comment", "delete", "develop", "transfer",
		"pin", "unpin", "lock", "unlock",
	],
	// Repo
	repo: [
		"view", "list", "clone", "fork", "sync",
		"read-file", "read-dir", "create",
	],
	// Release
	release: [
		"view", "list", "create", "edit",
		"download", "upload", "delete",
	],
	// Actions — runs
	run: [
		"list", "view", "watch", "rerun", "cancel",
		"download", "delete",
	],
	// Actions — workflows
	workflow: [
		"list", "view", "run",
		"enable", "disable",
	],
	// Search
	search: [
		"repos", "issues", "prs",
		"commits", "code",
	],
	// API
	api: ["*"],
	// Utility
	auth: ["status"],
	browse: [],
	label: ["list", "clone", "create", "edit", "delete"],
	gist: ["list", "clone", "create", "view", "edit", "delete"],
	project: ["list", "view", "item-list"],
	config: ["list", "get"],
	completion: [],
	codespace: ["list", "view", "logs"],
};

// ---------------------------------------------------------------------------
// TypeBox parameter schema
// ---------------------------------------------------------------------------

const GhCliParams = Type.Object({
	command: Type.String({
		description:
			'gh subcommand + args, e.g. "pr view 123 --json number,title"',
	}),
	repo: Type.Optional(
		Type.String({
			description: "Repository in owner/repo format, prepends --repo to args",
		})
	),
	json_output: Type.Optional(
		Type.Boolean({
			description: "Parse stdout as JSON (default: true)",
			default: true,
		})
	),
	field: Type.Optional(
		Type.String({
			description:
				'JSON field extraction path, e.g. ".title", ".[].number", ".items[0].name"',
		})
	),
});

type GhCliParams = typeof GhCliParams extends infer S
	? S extends { static: infer T }
		? T
		: never
	: never;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a shell-like command string into an argv array, respecting:
 *  - single-quoted strings
 *  - double-quoted strings
 *  - backslash escapes
 */
function parseCommandString(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			escaped = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}

		if (ch === " " && !inSingle && !inDouble) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}

		current += ch;
	}

	if (current) args.push(current);
	return args;
}

/**
 * Validate that a parsed gh command is in the allowlist.
 * Returns an error string if blocked, or null if allowed.
 */
function validateCommand(args: string[]): string | null {
	if (args.length === 0) return "Empty command";

	const subcommand = args[0]!;
	const allowed = ALLOWED_COMMANDS[subcommand];

	if (!allowed) {
		const known = Object.keys(ALLOWED_COMMANDS).join(", ");
		return `Unknown top-level command "${subcommand}". Allowed: ${known}`;
	}

	// "api" accepts anything
	if (allowed.length === 1 && allowed[0] === "*") return null;

	// For "browse" and "completion" there is no sub-subcommand
	if (allowed.length === 0) return null;

	const subSub = args[1];
	if (!subSub) {
		// Bare subcommand with no sub-subcommand — allowed (e.g. "auth")
		if (allowed.length === 0) return null;
		return `Command "${subcommand}" requires a sub-subcommand. Allowed: ${allowed.join(", ")}`;
	}

	if (!allowed.includes(subSub)) {
		return `"${subcommand} ${subSub}" is not allowed. Allowed subcommands for "${subcommand}": ${allowed.join(", ")}`;
	}

	return null;
}

/**
 * Extract a value from a JSON object using a simple dot-notation path.
 *
 * Supported patterns:
 *  - ".title"              → data.title
 *  - ".author.login"       → data.author.login
 *  - ".items[0].name"      → data.items[0].name
 *  - ".[].title"           → array of .title from each item in the root array
 *  - ".items[].name"       → array of .name from each item in data.items
 */
function extractField(data: unknown, field: string): unknown {
	// Strip leading dot
	let path = field.startsWith(".") ? field.slice(1) : field;

	// Handle root array iteration: ".[].foo"
	if (path.startsWith("[]")) {
		if (!Array.isArray(data)) return `[]. prefix requires an array, got ${typeof data}`;
		const rest = path.slice(2); // e.g. ".title" or ".foo.bar"
		const subPath = rest.startsWith(".") ? rest.slice(1) : rest;
		if (!subPath) return data;
		return data.map((item) => extractField(item, subPath));
	}

	// Walk the path
	const segments = path.split(".");
	let current: unknown = data;

	for (const seg of segments) {
		// Handle array indexing: "items[0]"
		const match = seg.match(/^([^\[]+)\[(\d+|\*)\]$/);
		if (match) {
			const [, key, idx] = match;
			if (current && typeof current === "object" && current !== null) {
				current = (current as Record<string, unknown>)[key!];
			} else {
				return undefined;
			}
			if (idx === "*") {
				if (!Array.isArray(current)) return `Expected array at "${key}", got ${typeof current}`;
				// Remainder of path applied to each element
				const restSegs = segments.slice(segments.indexOf(seg) + 1);
				if (restSegs.length === 0) return current;
				const subPath = restSegs.join(".");
				return (current as unknown[]).map((item) => extractField(item, subPath));
			}
			if (Array.isArray(current)) {
				current = current[Number(idx)];
			} else {
				return undefined;
			}
			continue;
		}

		// Handle bare array iteration within a segment: "[]"
		if (seg === "[]") {
			if (!Array.isArray(current)) return `Expected array, got ${typeof current}`;
			const restSegs = segments.slice(segments.indexOf(seg) + 1);
			if (restSegs.length === 0) return current;
			const subPath = restSegs.join(".");
			return (current as unknown[]).map((item) => extractField(item, subPath));
		}

		if (current && typeof current === "object" && current !== null) {
			current = (current as Record<string, unknown>)[seg];
		} else {
			return undefined;
		}
	}

	return current;
}

/**
 * Try to parse JSON safely.
 */
function tryParseJson(text: string): { ok: true; data: unknown } | { ok: false } {
	try {
		return { ok: true, data: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/**
 * Truncate a string to a maximum number of lines and characters.
 */
function truncateOutput(text: string, maxLines = 100, maxChars = 8_000): string {
	const lines = text.split("\n");
	let result: string;
	if (lines.length > maxLines) {
		result = lines.slice(0, maxLines).join("\n") + `\n... [${lines.length - maxLines} more lines]`;
	} else {
		result = text;
	}
	if (result.length > maxChars) {
		result = result.slice(0, maxChars) + "\n... [truncated]";
	}
	return result;
}

/**
 * Format the command string for display in the TUI.
 */
function displayCommand(args: string[], repo?: string): string {
	let cmd = args.join(" ");
	if (repo) cmd += ` --repo ${repo}`;
	return cmd;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function ghCliExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "gh_cli",
		label: "GitHub CLI",
		description:
			"Execute GitHub CLI (gh) commands with allowlist validation, JSON parsing, and field extraction. Prefer this over raw safe_bash for all GitHub operations.",
		promptSnippet: "Run github cli commands for PRs, issues, releases, workflows, search, API",
		promptGuidelines: [
			"Use gh_cli for ALL GitHub operations: PRs (create/view/edit/merge/close/review/diff/checks), issues, releases, workflows/actions, repo read-file/read-dir, search, and API calls.",
			"Pass the gh subcommand and args as a single 'command' string, e.g. 'pr view 123 --json number,title'.",
			"Use 'repo' parameter to target a specific owner/repo when not in a git checkout.",
			"The output is JSON-parsed by default — use 'field' for jq-style extraction ('.title', '.[].number', '.items[0].name').",
			"Set json_output:false for raw text output from commands that don't produce JSON.",
			"For complex operations, use 'api' subcommand with REST or GraphQL endpoints.",
		],
		parameters: GhCliParams,
		renderShell: "self",

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", "[gh] ");
			text += theme.fg("accent", displayCommand(parseCommandString(args.command), args.repo));
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "running gh..."), 0, 0);

			const details = result.details as
				| { exitCode?: number; command?: string; parsed?: boolean; field?: string }
				| undefined;

			const exitCode = details?.exitCode ?? -1;
			const ok = exitCode === 0;
			let text = ok
				? theme.fg("success", "ok")
				: theme.fg("error", `exit ${exitCode}`);

			if (details?.field) text += theme.fg("dim", ` → ${details.field}`);

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const preview = truncateOutput(content.text, 30, 2_000);
					text += "\n" + theme.fg("toolOutput", preview);
				}
			}

			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate) {
			const args = parseCommandString(params.command);

			// 1. Validate against allowlist
			const validationError = validateCommand(args);
			if (validationError) {
				const allowedList = Object.entries(ALLOWED_COMMANDS)
					.map(([cmd, subs]) =>
						subs.length === 0 ? cmd : `${cmd} {${subs.join(", ")}}`
					)
					.join("\n  ");
				return {
					content: [
						{
							type: "text",
							text: `Command not allowed: ${validationError}\n\nAllowed commands:\n  ${allowedList}`,
						},
					],
					details: { command: params.command, exitCode: -1, allowed: false },
				};
			}

			// 2. Prepend --repo as global flag if specified
			const finalArgs = [...args];
			if (params.repo) {
				finalArgs.unshift("--repo", params.repo);
			}

			// 3. Execute via pi.exec
			try {
				const result = await pi.exec("gh", finalArgs, {
					signal,
					timeout: 60_000,
				});

				// 4. Parse JSON output if requested
				const jsonOutput = params.json_output !== false;
				let outputText = result.stdout;
				let parsed = false;
				let fieldResult: unknown = undefined;
				let field = params.field;

				if (result.code === 0 && jsonOutput && result.stdout.trim()) {
					const parsedJson = tryParseJson(result.stdout.trim());
					if (parsedJson.ok) {
						parsed = true;

						// 5. Apply field extraction if specified
						if (field) {
							fieldResult = extractField(parsedJson.data, field);
							outputText =
								typeof fieldResult === "string"
									? fieldResult
									: JSON.stringify(fieldResult, null, 2);
						} else {
							outputText = JSON.stringify(parsedJson.data, null, 2);
						}
					}
				}

				// Include stderr in output if there was an error and no useful stdout
				if (result.code !== 0 && result.stderr.trim() && !outputText.trim()) {
					outputText = result.stderr.trim();
				} else if (result.code !== 0 && result.stderr.trim()) {
					outputText = outputText.trim()
						? `${outputText.trim()}\n\nstderr:\n${result.stderr.trim()}`
						: result.stderr.trim();
				}

				return {
					content: [{ type: "text", text: outputText || "(empty output)" }],
					details: {
						command: displayCommand(args, params.repo),
						exitCode: result.code,
						parsed,
						field: field ?? undefined,
						fieldResult,
						stderr: result.stderr.trim() || undefined,
						killed: result.killed,
					},
				};
			} catch (err: any) {
				const message = err?.message ?? String(err);
				return {
					content: [{ type: "text", text: `gh command failed: ${message}` }],
					details: {
						command: displayCommand(args, params.repo),
						exitCode: -1,
						error: message,
					},
				};
			}
		},
	});
}
