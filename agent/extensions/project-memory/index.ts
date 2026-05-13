import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE_NAME = "MEMORY.md";
const MAX_READ_CHARS = 50000;

const emptyParams = {
	type: "object",
	additionalProperties: false,
	properties: {},
} as const;

const updateParams = {
	type: "object",
	additionalProperties: false,
	required: ["section", "content"],
	properties: {
		section: { type: "string", description: "Top-level section to update, e.g. Decisions, Project Facts, User Preferences, Commands, Rationale, Open Questions" },
		content: { type: "string", description: "Concise Markdown memory content to add or replace" },
		mode: { type: "string", enum: ["append", "replace-section"], description: "append by default; replace-section rewrites the whole named section" },
		reason: { type: "string", description: "Why this belongs in long-term project memory" },
	},
} as const;

const readParams = {
	type: "object",
	additionalProperties: false,
	properties: {
		maxChars: { type: "number", description: "Max characters to return, default 50000" },
	},
} as const;

type MemoryLoc = { root: string; path: string; foundAgentsPath?: string };

async function exists(file: string): Promise<boolean> {
	try { await fs.access(file); return true; } catch { return false; }
}

async function findProjectRoot(cwd: string): Promise<MemoryLoc> {
	let dir = path.resolve(cwd);
	const home = path.resolve(process.env.HOME || "");
	const homePiDir = path.join(home, ".pi");
	const homeAgentDir = path.join(homePiDir, "agent");

	if ((dir === homePiDir || dir.startsWith(`${homePiDir}${path.sep}`)) && await exists(path.join(homeAgentDir, "AGENTS.md"))) {
		return { root: homeAgentDir, path: path.join(homeAgentDir, FILE_NAME), foundAgentsPath: path.join(homeAgentDir, "AGENTS.md") };
	}

	while (true) {
		for (const name of ["AGENTS.md", "agents.md"]) {
			const p = path.join(dir, name);
			if (await exists(p)) return { root: dir, path: path.join(dir, FILE_NAME), foundAgentsPath: p };
		}
		const parent = path.dirname(dir);
		if (dir === parent) break;
		// Avoid accidentally treating ~/.pi/agent/AGENTS.md as project root for normal projects above it.
		if (dir === homeAgentDir) break;
		dir = parent;
	}
	return { root: path.resolve(cwd), path: path.join(path.resolve(cwd), FILE_NAME) };
}

function template(root: string): string {
	return `# Project Memory

Persistent project-local context for Pi. Store only concise facts useful across many future sessions.

Project root: ${root}

## Project Facts

## Decisions

## Rationale / Why

## User Preferences

## Commands / Workflows

## Open Questions

## Change Log

- ${new Date().toISOString().slice(0, 10)}: Created MEMORY.md.
`;
}

async function ensureMemory(loc: MemoryLoc): Promise<void> {
	if (await exists(loc.path)) return;
	await fs.writeFile(loc.path, template(loc.root), "utf8");
}

function sectionRegex(section: string): RegExp {
	const esc = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^## ${esc}\\s*\n)([\\s\\S]*?)(?=^## |$)`, "m");
}

function normalizeSection(section: string): string {
	return section.replace(/^#+\s*/, "").trim() || "Notes";
}

function entry(content: string, reason?: string): string {
	const date = new Date().toISOString().slice(0, 10);
	const body = content.trim().replace(/\n{3,}/g, "\n\n");
	const why = reason?.trim() ? `\n  - Why: ${reason.trim()}` : "";
	return `- ${date}: ${body}${why}\n`;
}

async function updateMemory(loc: MemoryLoc, sectionRaw: string, content: string, mode = "append", reason?: string): Promise<string> {
	await ensureMemory(loc);
	const section = normalizeSection(sectionRaw);
	let text = await fs.readFile(loc.path, "utf8");
	const re = sectionRegex(section);
	if (mode === "replace-section") {
		const replacement = `## ${section}\n\n${content.trim()}\n\n`;
		text = re.test(text) ? text.replace(re, replacement) : `${text.trim()}\n\n${replacement}`;
	} else {
		const add = entry(content, reason);
		if (re.test(text)) {
			text = text.replace(re, (_m, heading, body) => `${heading}${body.trim() ? body.trimEnd() + "\n" : "\n"}${add}\n`);
		} else {
			text = `${text.trim()}\n\n## ${section}\n\n${add}`;
		}
	}
	await fs.writeFile(loc.path, text.replace(/\n{4,}/g, "\n\n\n"), "utf8");
	return loc.path;
}

async function memoryDigest(file: string): Promise<{ exists: boolean; chars: number; headings: string[] }> {
	if (!(await exists(file))) return { exists: false, chars: 0, headings: [] };
	const text = await fs.readFile(file, "utf8");
	const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 30);
	return { exists: true, chars: text.length, headings };
}

export default function projectMemoryExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const loc = await findProjectRoot(ctx.cwd);
		const digest = await memoryDigest(loc.path);
		const lines = [
			"\n\n# Project Memory Runtime",
			`Project-local memory file: ${loc.path}`,
			loc.foundAgentsPath ? `Project root selected from context file: ${loc.foundAgentsPath}` : `Project root fallback: ${loc.root}`,
			"MEMORY.md is NOT loaded into context by default; consult it with memory_read only when project history/preferences/decisions/rationale may affect the task.",
			"Use memory_update only for concise, durable, project-local context likely useful across many future sessions.",
			"Keep MEMORY.md small and specific. Prefer replacing/compressing noisy sections over appending. Do not store secrets, transient debug noise, or one-off details.",
		];
		if (digest.exists) lines.push(`MEMORY.md exists (${digest.chars} chars). Headings: ${digest.headings.join(", ") || "none"}.`);
		else lines.push("MEMORY.md does not exist yet. Create it with memory_update only when durable project context becomes useful.");
		return { systemPrompt: event.systemPrompt + lines.join("\n") };
	});

	pi.registerTool({
		name: "memory_read",
		label: "Read Project Memory",
		description: "Read the project-local MEMORY.md file from the nearest project root containing AGENTS.md.",
		promptSnippet: "Read project-local MEMORY.md for persistent project context",
		promptGuidelines: [
			"Use memory_read only when project history, prior decisions, user preferences, or rationale may affect the task; do not read MEMORY.md for every request.",
		],
		parameters: readParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const loc = await findProjectRoot(ctx.cwd);
			if (!(await exists(loc.path))) {
				return { content: [{ type: "text", text: `No MEMORY.md exists yet at ${loc.path}. Use memory_update to create it when needed.` }], details: { ...loc, exists: false } };
			}
			const max = Math.max(1000, Math.min(MAX_READ_CHARS, typeof params.maxChars === "number" ? params.maxChars : MAX_READ_CHARS));
			const text = await fs.readFile(loc.path, "utf8");
			return { content: [{ type: "text", text: text.slice(0, max) + (text.length > max ? "\n...[truncated]" : "") }], details: { ...loc, exists: true, chars: text.length } };
		},
	});

	pi.registerTool({
		name: "memory_update",
		label: "Update Project Memory",
		description: "Create or update project-local MEMORY.md with durable context useful across future sessions.",
		promptSnippet: "Create/update project-local MEMORY.md with durable cross-session context",
		promptGuidelines: [
			"Use memory_update when the user asks to remember/update memory or when a stable project fact/decision/rationale/preference should persist across sessions.",
			"Keep memory_update entries concise and durable; prefer replace-section for cleanup/compression; never store secrets, temporary noise, or one-off details.",
		],
		parameters: updateParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const loc = await findProjectRoot(ctx.cwd);
			const file = await updateMemory(loc, params.section, params.content, params.mode || "append", params.reason);
			return { content: [{ type: "text", text: `Updated project memory: ${file}` }], details: { ...loc, section: params.section, mode: params.mode || "append" } };
		},
	});

	pi.registerTool({
		name: "memory_status",
		label: "Project Memory Status",
		description: "Show project memory root/path/status.",
		parameters: emptyParams,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const loc = await findProjectRoot(ctx.cwd);
			const digest = await memoryDigest(loc.path);
			return { content: [{ type: "text", text: JSON.stringify({ ...loc, ...digest }, null, 2) }], details: { ...loc, ...digest } };
		},
	});

	pi.registerCommand("memory", {
		description: "Show project MEMORY.md path/status",
		handler: async (_args, ctx) => {
			const loc = await findProjectRoot(ctx.cwd);
			const digest = await memoryDigest(loc.path);
			ctx.ui.notify(`MEMORY.md: ${loc.path} (${digest.exists ? `${digest.chars} chars` : "missing"})`, digest.exists ? "info" : "warning");
		},
	});
}
