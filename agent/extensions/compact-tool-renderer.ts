/**
 * Compact Tool Renderer
 *
 * Replaces built-in tool rendering with ultra-compact format:
 *   [tool-name] $args
 *   <summarized/truncated output>
 *
 * No spacing between tool calls. renderShell: "self" removes default box/padding.
 * Edit shows: [edit] path/to/file [+X/-Y] with colored +X/-Y.
 *

 */

import type { BashToolDetails, EditToolDetails, ExtensionAPI, FindToolDetails, GrepToolDetails, LsToolDetails, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// ── Helpers ──

	/** Check if a tool result is a blocked-call message (should not render). */
	function isBlockedResult(content: unknown): boolean {
		if (!content || typeof content !== "object") return false;
		const text = (content as any).text;
		return typeof text === "string" && text.startsWith("__PI_BLOCKED__");
	}

	// ── Read tool ──

	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", `[read] `);
			text += theme.fg("accent", args.path);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "reading..."), 0, 0);

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];

			if (isBlockedResult(content)) return new Text("", 0, 0);
			if (content?.type === "image") return new Text(theme.fg("success", "[image loaded]"), 0, 0);
			if (content?.type !== "text") return new Text(theme.fg("error", "[no content]"), 0, 0);

			const lines = content.text.split("\n");
			const count = lines.length;
			let text = theme.fg("success", `${count} line${count === 1 ? "" : "s"}`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", ` (truncated ${details.truncation.totalLines})`);
			}

			// Show first N lines as preview (only in expanded view)
			if (expanded) {
				const previewLines = lines.slice(0, 5);
				if (previewLines.length > 0 && previewLines.some((l) => l.trim())) {
					for (const line of previewLines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (count > 5) text += `\n${theme.fg("muted", `... ${count - 5} more`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// ── Bash tool ──
	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: originalBash.description,
		parameters: originalBash.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", `[bash] `);
			const cmd = args.command.length > 90 ? `${args.command.slice(0, 87)}...` : args.command;
			text += theme.fg("accent", `$ ${cmd}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "running..."), 0, 0);

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];

			if (isBlockedResult(content)) return new Text("", 0, 0);

			const output = content?.type === "text" ? content.text : "";

			// Match both "exit code: N" and "Command exited with code N"
			const exitMatch = output.match(/(?:exit code|Command exited with code):? (\d+)/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
			const lines = output.split("\n").filter((l) => l.trim());
			const lineCount = lines.length;

			let text = "";
			if (exitCode === null) {
				text += theme.fg("success", "ok");
			} else if (exitCode === 0) {
				text += theme.fg("success", "ok");
			} else {
				text += theme.fg("error", `exit ${exitCode}`);
			}
			text += theme.fg("dim", ` (${lineCount} line${lineCount === 1 ? "" : "s"})`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " truncated");
			}

			// Show last few lines (only in expanded view)
			if (expanded) {
				const outputLines = output.split("\n");
				const nonExitLines = outputLines.filter((l) => {
					const t = l.trim();
					return t && !t.startsWith("exit code:") && !t.startsWith("Command exited with code");
				});
				if (nonExitLines.length > 0) {
					const maxPreview = Math.min(nonExitLines.length, 3);
					const preview = nonExitLines.slice(-maxPreview);
					for (const line of preview) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (nonExitLines.length > 3) {
						text += `\n${theme.fg("muted", `... ${nonExitLines.length - 3} more`)}`;
					}
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// ── Edit tool ──
	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalEdit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", `[edit] `);
			text += theme.fg("accent", args.path);

			// Count edit blocks
			const count = Array.isArray(args.edits) ? args.edits.length : 1;
			text += theme.fg("dim", ` (${count} edit${count === 1 ? "" : "s"})`);

			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "editing..."), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			if (!details?.diff) {
				return new Text(theme.fg("success", "applied"), 0, 0);
			}

			// Diff stats: count +/- lines
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = "";
			text += theme.fg("success", `+${additions}`);
			text += theme.fg("dim", "/");
			text += theme.fg("error", `-${removals}`);

			return new Text(text, 0, 0);
		},
	});

	// ── Write tool ──
	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: originalWrite.description,
		parameters: originalWrite.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", `[write] `);
			text += theme.fg("accent", args.path);
			const lineCount = args.content.split("\n").length;
			text += theme.fg("dim", ` (${lineCount} line${lineCount === 1 ? "" : "s"})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "writing..."), 0, 0);

			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			return new Text(theme.fg("success", "written"), 0, 0);
		},
	});

	// ── Grep tool ──
	const originalGrep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: originalGrep.description,
		parameters: originalGrep.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalGrep.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", `[grep] `);
			text += theme.fg("accent", args.pattern);
			if (args.path) text += theme.fg("dim", ` ${args.path}`);
			if (args.glob) text += theme.fg("dim", ` ${args.glob}`);
			if (args.limit) text += theme.fg("dim", ` (limit ${args.limit})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "searching..."), 0, 0);

			const details = result.details as GrepToolDetails | undefined;
			const content = result.content[0];

			if (isBlockedResult(content)) return new Text("", 0, 0);
			if (content?.type !== "text") return new Text(theme.fg("error", "[no results]"), 0, 0);

			const lines = content.text.split("\n").filter((l) => l.trim());
			const count = lines.length;

			let text = theme.fg("success", `${count} match${count === 1 ? "" : "es"}`);
			if (details?.truncation?.truncated || details?.matchLimitReached) {
				text += theme.fg("warning", " (truncated)");
			}

			// Show first few lines (only in expanded view)
			if (expanded) {
				const preview = lines.slice(0, 3);
				for (const line of preview) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (count > 3) text += `\n${theme.fg("muted", `... ${count - 3} more`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	// ── Ls tool ──
	const originalLs = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: originalLs.description,
		parameters: originalLs.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalLs.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", `[ls] `);
			text += theme.fg("accent", args.path || ".");
			if (args.limit) text += theme.fg("dim", ` (limit ${args.limit})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "listing..."), 0, 0);

			const details = result.details as LsToolDetails | undefined;
			const content = result.content[0];

			if (isBlockedResult(content)) return new Text("", 0, 0);
			if (content?.type !== "text") return new Text(theme.fg("error", "[no entries]"), 0, 0);

			const lines = content.text.split("\n").filter((l) => l.trim());
			const count = lines.length;

			let text = theme.fg("success", `${count} entr${count === 1 ? "y" : "ies"}`);
			if (details?.truncation?.truncated || details?.entryLimitReached) {
				text += theme.fg("warning", " (truncated)");
			}

			// Show first few entries (only in expanded view)
			if (expanded) {
				const preview = lines.slice(0, 5);
				for (const line of preview) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (count > 5) text += `\n${theme.fg("muted", `... ${count - 5} more`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	// ── Find tool ──
	const originalFind = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: originalFind.description,
		parameters: originalFind.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalFind.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", `[find] `);
			text += theme.fg("accent", args.pattern);
			if (args.path) text += theme.fg("dim", ` ${args.path}`);
			if (args.limit) text += theme.fg("dim", ` (limit ${args.limit})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "searching..."), 0, 0);

			const details = result.details as FindToolDetails | undefined;
			const content = result.content[0];

			if (isBlockedResult(content)) return new Text("", 0, 0);
			if (content?.type !== "text") return new Text(theme.fg("error", "[no results]"), 0, 0);

			const lines = content.text.split("\n").filter((l) => l.trim());
			const count = lines.length;

			let text = theme.fg("success", `${count} result${count === 1 ? "" : "s"}`);
			if (details?.truncation?.truncated || details?.resultLimitReached) {
				text += theme.fg("warning", " (truncated)");
			}

			// Show first few results (only in expanded view)
			if (expanded) {
				const preview = lines.slice(0, 5);
				for (const line of preview) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (count > 5) text += `\n${theme.fg("muted", `... ${count - 5} more`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
