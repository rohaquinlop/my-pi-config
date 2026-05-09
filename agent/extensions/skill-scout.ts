import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = path.join(process.env.HOME || ".", ".pi/agent/skill-scout.json");
const THRESHOLD = 3;
const MAX_EXAMPLES = 5;

type Pattern = {
	key: string;
	name: string;
	description: string;
	count: number;
	lastSeen: string;
	examples: string[];
	ignored?: boolean;
	draftedPath?: string;
	approvedPath?: string;
};

type State = { projects: Record<string, { patterns: Record<string, Pattern> }> };

type Candidate = { key: string; name: string; description: string; score?: number };

const emptyParams = {
	type: "object",
	additionalProperties: false,
	properties: {},
} as const;

const recordParams = {
	type: "object",
	additionalProperties: false,
	required: ["name", "description", "evidence"],
	properties: {
		name: { type: "string", description: "Proposed skill name, e.g. database-migration-review" },
		description: { type: "string", description: "What repeated workflow this skill would handle" },
		evidence: { type: "string", description: "Short reason or example from current task" },
	},
} as const;

async function exists(file: string): Promise<boolean> {
	try { await fs.access(file); return true; } catch { return false; }
}

async function findProjectRoot(cwd: string): Promise<string> {
	let dir = path.resolve(cwd);
	const homeAgentDir = path.resolve(process.env.HOME || "", ".pi/agent");
	while (true) {
		if (await exists(path.join(dir, ".git"))) return dir;
		if (await exists(path.join(dir, "AGENTS.md"))) return dir;
		if (dir === homeAgentDir) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

async function readState(): Promise<State> {
	try {
		return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
	} catch {
		return { projects: {} };
	}
}

async function writeState(state: State): Promise<void> {
	await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
	await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function slug(input: string): string {
	return input.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/--+/g, "-")
		.slice(0, 64) || "project-workflow";
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => part?.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

function candidatesFromPrompt(text: string): Candidate[] {
	const t = text.toLowerCase();
	const out: Candidate[] = [];
	const add = (key: string, name: string, description: string) => out.push({ key, name, description });

	if (/commit message|write a commit|generate commit|\bcommit\b/.test(t)) add("commit-message", "commit-message", "Generate project-specific commit messages with the local style and trailer rules.");
	if (/code review|review (this|the)? ?(pr|diff|pull request)|\/review/.test(t)) add("code-review", "code-review", "Review diffs and pull requests using the project's preferred comment style.");
	if (/skill|skills|skill\.md|agent skills/.test(t)) add("skill-authoring", "skill-authoring", "Create and maintain Pi/Agent Skills with valid structure, descriptions, and safe boundaries.");
	if (/extension|extensions|registertool|registercommand|pi\./.test(t)) add("pi-extension-dev", "pi-extension-dev", "Build Pi extensions using lifecycle hooks, commands, tools, and safe persistence.");
	if (/memory\.md|remember|project memory|memory_update/.test(t)) add("project-memory", "project-memory", "Maintain concise durable project memory without storing transient noise or secrets.");
	if (/test|tests|failing|pytest|vitest|jest|cargo test|npm test/.test(t)) add("test-debugging", "test-debugging", "Debug failing tests and follow project test workflows.");
	if (/refactor|cleanup|simplify|restructure/.test(t)) add("refactor-workflow", "refactor-workflow", "Plan and apply safe refactors while preserving behavior.");
	if (/release notes|changelog|change log|version|publish|release/.test(t)) add("release-notes", "release-notes", "Prepare release notes and changelog entries from project changes.");
	if (/documentation|docs|readme|markdown/.test(t)) add("docs-update", "docs-update", "Update documentation in the project's voice and structure.");

	return out;
}

async function record(projectRoot: string, candidate: Candidate, evidence: string): Promise<Pattern> {
	const state = await readState();
	const project = state.projects[projectRoot] ||= { patterns: {} };
	const key = slug(candidate.key || candidate.name);
	const current = project.patterns[key] || {
		key,
		name: slug(candidate.name || key),
		description: candidate.description,
		count: 0,
		lastSeen: new Date().toISOString(),
		examples: [],
	};
	current.count += 1;
	current.lastSeen = new Date().toISOString();
	current.description = candidate.description || current.description;
	const cleanEvidence = evidence.trim().replace(/\s+/g, " ").slice(0, 240);
	if (cleanEvidence && !current.examples.includes(cleanEvidence)) current.examples.unshift(cleanEvidence);
	current.examples = current.examples.slice(0, MAX_EXAMPLES);
	project.patterns[key] = current;
	await writeState(state);
	return current;
}

function projectSkillDir(projectRoot: string): string {
	const homeAgentDir = path.resolve(process.env.HOME || "", ".pi/agent");
	if (path.resolve(projectRoot) === homeAgentDir) return path.join(projectRoot, "skills");
	return path.join(projectRoot, ".pi/skills");
}

function draftDir(projectRoot: string): string {
	const homeAgentDir = path.resolve(process.env.HOME || "", ".pi/agent");
	if (path.resolve(projectRoot) === homeAgentDir) return path.join(projectRoot, "skill-scout-drafts");
	return path.join(projectRoot, ".pi/skill-scout-drafts");
}

function skillMarkdown(p: Pattern): string {
	const examples = p.examples.length ? p.examples.map((e) => `- ${e}`).join("\n") : "- Add concrete examples after first use.";
	return `---\nname: ${slug(p.name)}\ndescription: ${p.description} Use when this project repeats this workflow.\n---\n\n# ${slug(p.name)}\n\nPurpose: ${p.description}\n\n## When to use\n\nUse this skill when the user asks for this repeated project workflow or when current task clearly matches prior examples.\n\n## Project signals\n\n${examples}\n\n## Workflow\n\n1. Inspect the relevant project files before changing anything.\n2. Follow existing project conventions over generic defaults.\n3. Ask before destructive actions or broad rewrites.\n4. Keep output concise and actionable.\n5. If the workflow no longer fits, tell the user and do not force this skill.\n\n## Boundaries\n\n- Do not run destructive commands without explicit user approval.\n- Do not store secrets or transient debug details.\n- Prefer small targeted edits.\n`;
}

async function getPattern(projectRoot: string, keyOrName: string): Promise<Pattern | undefined> {
	const state = await readState();
	const patterns = state.projects[projectRoot]?.patterns || {};
	const key = slug(keyOrName);
	return patterns[key] || Object.values(patterns).find((p) => slug(p.name) === key);
}

async function listPatterns(projectRoot: string): Promise<Pattern[]> {
	const state = await readState();
	return Object.values(state.projects[projectRoot]?.patterns || {}).sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}

async function patchPattern(projectRoot: string, key: string, patch: Partial<Pattern>): Promise<void> {
	const state = await readState();
	const stored = state.projects[projectRoot]?.patterns[key];
	if (stored) Object.assign(stored, patch);
	await writeState(state);
}

export default function skillScout(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, _ctx) => {
		return { systemPrompt: event.systemPrompt + "\n\n# Skill Scout\nWhen you notice a repeated project workflow that would benefit from a reusable skill, call skill_scout_record. Do not create or approve skills unless the user explicitly asks; Skill Scout is confirm-first." };
	});

	pi.on("agent_end", async (event, ctx) => {
		const projectRoot = await findProjectRoot(ctx.cwd);
		const userTexts = (event.messages || [])
			.filter((m: any) => m?.role === "user" || m?.message?.role === "user")
			.map((m: any) => textFromContent(m.content || m.message?.content))
			.filter(Boolean);
		for (const text of userTexts) {
			for (const c of candidatesFromPrompt(text)) {
				const p = await record(projectRoot, c, text);
				if (!p.ignored && p.count === THRESHOLD) {
					ctx.ui.notify(`Skill Scout: repeated ${p.name} (${p.count}x). Run /skill-scout draft ${p.key}`, "info");
				}
			}
		}
	});

	pi.registerTool({
		name: "skill_scout_record",
		label: "Record Skill Opportunity",
		description: "Record a repeated workflow that may deserve a project skill. Does not create files.",
		promptSnippet: "Record repeated workflows that may deserve project skills",
		promptGuidelines: [
			"Use skill_scout_record when a repeated project workflow appears likely to save future prompts or encode project-specific rules.",
			"skill_scout_record only records evidence; never treat it as approval to create or modify a skill.",
		],
		parameters: recordParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const projectRoot = await findProjectRoot(ctx.cwd);
			const p = await record(projectRoot, { key: params.name, name: params.name, description: params.description }, params.evidence);
			return { content: [{ type: "text", text: `Recorded skill opportunity ${p.name}: ${p.count}x. Threshold: ${THRESHOLD}.` }], details: { projectRoot, pattern: p } };
		},
	});

	pi.registerCommand("skill-scout", {
		description: "Detect repeated workflows and draft/approve project skills",
		getArgumentCompletions: (prefix: string) => {
			const vals = ["status", "draft", "approve", "ignore", "reset", "help"];
			const p = prefix.trim().toLowerCase();
			return vals.filter((v) => v.startsWith(p)).map((v) => ({ value: v, label: v }));
		},
		handler: async (args, ctx) => {
			const [cmdRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const cmd = (cmdRaw || "status").toLowerCase();
			const name = rest.join(" ");
			const projectRoot = await findProjectRoot(ctx.cwd);

			if (cmd === "help") {
				ctx.ui.notify("/skill-scout status|draft <name>|approve <name>|ignore <name>|reset <name|all>", "info");
				return;
			}

			if (cmd === "status") {
				const patterns = await listPatterns(projectRoot);
				const top = patterns.slice(0, 5).map((p) => `${p.name}:${p.count}${p.ignored ? "(ignored)" : ""}`).join(", ") || "none yet";
				ctx.ui.notify(`Skill Scout (${projectRoot}): ${top}`, "info");
				return;
			}

			if (!name && cmd !== "reset") {
				ctx.ui.notify(`Need pattern name. Try /skill-scout status`, "error");
				return;
			}

			if (cmd === "draft") {
				const p = await getPattern(projectRoot, name);
				if (!p) { ctx.ui.notify(`Unknown pattern: ${name}`, "error"); return; }
				const dir = path.join(draftDir(projectRoot), slug(p.name));
				const file = path.join(dir, "SKILL.md");
				await fs.mkdir(dir, { recursive: true });
				await fs.writeFile(file, skillMarkdown(p), "utf8");
				await patchPattern(projectRoot, p.key, { draftedPath: file });
				ctx.ui.notify(`Drafted: ${file}. Approve with /skill-scout approve ${p.key}`, "info");
				return;
			}

			if (cmd === "approve") {
				const p = await getPattern(projectRoot, name);
				if (!p) { ctx.ui.notify(`Unknown pattern: ${name}`, "error"); return; }
				const ok = await ctx.ui.confirm("Approve Skill Scout draft?", `Create active skill ${slug(p.name)}?`);
				if (!ok) return;
				const dir = path.join(projectSkillDir(projectRoot), slug(p.name));
				const file = path.join(dir, "SKILL.md");
				await fs.mkdir(dir, { recursive: true });
				await fs.writeFile(file, skillMarkdown(p), "utf8");
				await patchPattern(projectRoot, p.key, { approvedPath: file });
				ctx.ui.notify(`Approved skill: ${file}. Reloading...`, "info");
				await ctx.reload();
				return;
			}

			if (cmd === "ignore") {
				const state = await readState();
				const p = await getPattern(projectRoot, name);
				if (!p) { ctx.ui.notify(`Unknown pattern: ${name}`, "error"); return; }
				const stored = state.projects[projectRoot]?.patterns[p.key];
				if (stored) stored.ignored = true;
				await writeState(state);
				ctx.ui.notify(`Ignored: ${p.name}`, "info");
				return;
			}

			if (cmd === "reset") {
				const state = await readState();
				if (name === "all" || !name) delete state.projects[projectRoot];
				else {
					const p = await getPattern(projectRoot, name);
					if (p) delete state.projects[projectRoot]?.patterns[p.key];
				}
				await writeState(state);
				ctx.ui.notify(`Skill Scout reset: ${name || "all"}`, "info");
				return;
			}

			ctx.ui.notify(`Unknown command: ${cmd}. Try /skill-scout help`, "error");
		},
	});
}
