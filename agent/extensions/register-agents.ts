/**
 * Subagent Delegation Guidance
 *
 * Injects delegation guidance into the main agent's system prompt, derived from
 * whichever agents pi-subagents has loaded.
 *
 * This extension does NOT register agents. pi-subagents already discovers
 * `~/.pi/agent/extensions/agents/` natively (its USER_AGENTS_DIR) and merges it
 * over its built-ins, parsing every frontmatter field including `connector`.
 * An earlier version of this file re-registered those same agents through the
 * `globalThis.__pi_subagents` bridge, which meant unregistering the
 * upstream-parsed config and replacing it with a lossier local re-parse —
 * silently dropping `connector` and substituting a model default for files
 * upstream would have rejected outright. All agent parsing now belongs to the
 * package, where it is tested.
 *
 * What remains here reads the same directories read-only, purely to describe
 * the available agents in the prompt. It mirrors upstream's acceptance rule
 * (name, description, tools, model and thinking all required) so the prompt
 * never advertises an agent the runtime did not load.
 *
 * Guidance (nothing here is enforced — no tool is ever blocked):
 *
 * 1. System prompt injection (before_agent_start)
 *    - When delegation pays for itself, framed around its actual cost
 *    - Which disposable-output patterns are worth a spawn
 *    - Intent → agent routing, scaled by task size rather than phrasing
 *    - Tool selection: the cheap option for each situation, and why
 *    This block is turn-invariant so the cached prompt prefix stays stable.
 *
 * 2. Input pre-processor (input event)
 *    - Conservative keyword matching, suppressed when the prompt bounds its
 *      own scope (SCOPE_LIMITERS)
 *    - Emits an advisory hint via the message channel, never the system prompt
 *
 * 3. Turn boundary tracking (turn_start event)
 *    - Clears stale routing decisions
 *
 * Agent definitions themselves live in `extensions/agents/*.md` and are owned
 * by pi-subagents. To change an agent's model, tools or connector, edit the
 * `.md` file — nothing in this extension needs to know.
 *
 * Direct tools are the default. A subagent costs a process spawn plus its own
 * system prompt and turns, so it only pays off when it absorbs high-volume
 * intermediate output the main agent would otherwise carry. The point is to
 * protect the context window, not to route everything through a subprocess.
 *
 * Child subagent processes (PI_IS_SUBAGENT=1) have full tool access and never
 * see any of this.
 *
 * Agent file format (frontmatter + markdown body) — parsed by pi-subagents:
 *   ---
 *   name: agent-name
 *   description: What the agent does
 *   tools: comma, separated, tool, names
 *   model: provider/model-id          (required)
 *   thinking: off|low|medium|high     (required)
 *   subagent_agents: comma, separated, agent, names   (optional)
 *   connector: "## Header\n\n{output}"                 (optional)
 *   ---
 *   System prompt body...
 *
 * Adding a new .md file to agents/ makes it available to the `subagent` tool
 * (via pi-subagents) and adds it to the generated guidance here — no code
 * changes in either place.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ── Precompiled constants ────────────────────────────────────────────

/**
 * Phrases that signal the user has already bounded the scope.
 *
 * A keyword match alone cannot tell task size apart: "review this" is a direct
 * read on a ten-line diff and a `reviewer` dispatch on a fifteen-file change.
 * When the prompt names its own limits, suppress the routing hint and let the
 * model choose — a spawn for a one-line question costs more than it saves.
 */
const SCOPE_LIMITERS: RegExp[] = [
	/\b(this|that|the)\s+(line|function|method|variable|import|typo|comment|string)\b/,
	/\b(one|single|1)\s+(line|file|function|change)\b/,
	/\b(quick|quickly|just|simply|small|tiny|trivial|minor)\b/,
	/\b(rename|typo|indent|formatting|whitespace)\b/,
];

/** Routing rules for the input pre-processor */
const ROUTING_RULES: Array<{ keywords: string[]; agent: string; description: string }> = [
	{
		keywords: [
			"review the code", "review this", "code review", "review the changes",
			"review changes", "code audit", "validate the", "check for bugs",
			"security review", "performance impact", "code quality",
		],
		agent: "reviewer",
		description: "Code and plan review specialist for quality, security, and correctness",
	},
	{
		keywords: [
			"create a plan", "plan the implementation", "plan this",
			"plan how to", "plan an", "implementation plan",
		],
		agent: "planner",
		description: "Creates implementation plans by scouting code and researching requirements",
	},
	{
		keywords: [
			"search the web", "look up how", "find documentation for",
			"find docs for", "research how", "best practices for",
			"what is the latest", "how does it compare",
		],
		agent: "researcher",
		description: "Web researcher \u2014 searches the web and synthesizes findings",
	},
];

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** User agent definitions — pi-subagents' USER_AGENTS_DIR. */
const USER_AGENTS_DIR = path.join(EXT_DIR, "agents");

/**
 * pi-subagents' own `agents/` directory, holding the built-ins that user files
 * override by name. Probed rather than resolved: this extension is loaded by
 * jiti, so `require.resolve` is not reliably available, and the package may sit
 * under either the npm or git install root.
 */
const BUILTIN_AGENT_DIR_CANDIDATES = [
	path.join(EXT_DIR, "..", "npm", "node_modules", "@rohaquinlop", "pi-subagents", "agents"),
	path.join(EXT_DIR, "..", "node_modules", "@rohaquinlop", "pi-subagents", "agents"),
	path.join(EXT_DIR, "..", "git", "github.com", "rohaquinlop", "pi-subagents", "agents"),
];

// ── Agent Loading (read-only — pi-subagents owns registration) ───────

interface AgentMeta {
	name: string;
	description: string;
	tools: string[];
	subagentAgents?: string[];
}

let cachedAgents: AgentMeta[] | null = null;
let cachedDelegationRules: string | null = null;
let pendingRoutingAgent: string | null = null;

function splitList(raw: string | undefined): string[] {
	return (raw || "").split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Read agent .md files from one directory.
 *
 * Mirrors pi-subagents' `parseAgentMd` acceptance rule: name, description,
 * tools, model and thinking are all required, and a file missing any of them
 * is skipped there too. Keeping the rules aligned is what stops the generated
 * prompt from advertising an agent the runtime never loaded.
 */
function readAgentDir(dir: string): AgentMeta[] {
	const agents: AgentMeta[] = [];
	if (!fs.existsSync(dir)) return agents;

	for (const entry of fs.readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		// Validation and output reports sometimes land here; they are not agents.
		if (entry.endsWith("-validation.md") || entry.endsWith("-output.md")) continue;

		const filePath = path.join(dir, entry);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		if (!content.startsWith("---\n")) continue;

		const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
		const { name, description, tools, model, thinking } = frontmatter;
		if (!name || !description || !tools || !model || !thinking) continue;

		const subagentAgents = splitList(frontmatter.subagent_agents);
		agents.push({
			name,
			description,
			tools: splitList(tools),
			...(subagentAgents.length ? { subagentAgents } : {}),
		});
	}

	return agents;
}

/**
 * Load the agent list the way pi-subagents does: built-ins first, then user
 * definitions overriding them by name.
 */
function loadAllAgents(): AgentMeta[] {
	if (cachedAgents) return cachedAgents;

	const byName = new Map<string, AgentMeta>();
	const builtinDir = BUILTIN_AGENT_DIR_CANDIDATES.find((dir) => fs.existsSync(dir));
	if (builtinDir) {
		for (const agent of readAgentDir(builtinDir)) byName.set(agent.name, agent);
	}
	for (const agent of readAgentDir(USER_AGENTS_DIR)) byName.set(agent.name, agent);

	cachedAgents = Array.from(byName.values());
	return cachedAgents;
}

// ── Delegation Rule Generation ──────────────────────────────────────

/**
 * Generate the full delegation rules block.
 *
 * This is fully dynamic — all rules are derived from agent .md frontmatter.
 * No hardcoded switch/case statements. Adding a new .md file to agents/
 * automatically updates the enforcement table, detail section, and general
 * guidance.
 *
 * Returns the block as a string, ready to inject at the TOP of the system prompt.
 */
function generateDelegationRules(allAgents: AgentMeta[]): string {
	if (allAgents.length === 0) return "";

	const lines: string[] = [];

	// ════════════════════════════════════════════════
	// WHEN TO DELEGATE (auto-generated from agent list)
	// ════════════════════════════════════════════════
	lines.push("## Subagent Delegation");
	lines.push("");
	lines.push(
		"**Direct tools are the default.** Delegating to a subagent costs a process spawn " +
		"plus that agent's own system prompt, tool schemas, and turns — a fixed overhead " +
		"you pay before it does any useful work. Below that threshold, doing the work " +
		"yourself is both cheaper and faster.",
	);
	lines.push("");
	lines.push(
		"Delegate when you expect to **generate output you will read once and discard**. " +
		"That is what a subagent buys you: it burns the intermediate volume in its own " +
		"isolated context and returns only the conclusion.",
	);
	lines.push("");
	lines.push("| Delegate when | Do it directly when |");
	lines.push("|---|---|");
	lines.push("| You don't yet know which files matter | You know the path |");
	lines.push("| The search space is open-ended (unfamiliar repo, untraced dependency chain) | The target is named or already located |");
	lines.push("| You'd skim many candidates to surface a few relevant ones | You'll reuse what you read across later turns |");
	lines.push("| The work needs a distinct skill set (web research, adversarial review) | The answer fits in a handful of bounded calls |");
	lines.push("");
	lines.push(
		"The predictor is **known vs. unknown target**, not file count. Reading five known " +
		"files is cheap and the content stays available for follow-ups; grepping one unknown " +
		"symbol across a large repo is expensive and disposable.",
	);
	lines.push("");
	lines.push(
		"When uncertain, start directly — you can always delegate once the work turns out " +
		"to be larger than expected. A wasted spawn is not recoverable.",
	);
	lines.push("");
	lines.push("### Available agents");
	lines.push("");
	lines.push("| Agent | Purpose | Tools & Capabilities |");
	lines.push("|---|---|---|");

	for (const agent of allAgents) {
		const capParts: string[] = [`Tools: ${agent.tools.join(", ")}`];
		if (agent.subagentAgents?.length) {
			capParts.push(`Can spawn: ${agent.subagentAgents.join(", ")}`);
		}
		lines.push(`| \`agent: ${agent.name}\` | ${agent.description} | ${capParts.join(". ")} |`);
	}

	lines.push("");

	// ════════════════════════════════════════════════════════════════════
	// ANTI-PATTERNS TABLE
	// ════════════════════════════════════════════════════════════════════
	lines.push("## Patterns worth delegating");
	lines.push("");
	lines.push(
		"These generate high-volume output you read once and throw away \u2014 the case where " +
		"a subagent's overhead pays for itself:",
	);
	lines.push("");
	lines.push("| Pattern | Better as |");
	lines.push("|---|---|");
	lines.push("| Searching for a symbol whose location you don't know | `agent: scout` |");
	lines.push("| Tracing an unfamiliar dependency or call chain | `agent: scout` |");
	lines.push("| `bash node -e` / `npx tsx -e` / `python3 -c` to explore code properties | `agent: scout` (runs in isolation) |");
	lines.push("| `bash cat` piped into an analysis one-liner across many files | `agent: scout` |");
	lines.push("| Open-ended web research spanning several searches and pages | `agent: researcher` |");
	lines.push("| Reviewing a substantial change across multiple files | `agent: reviewer` |");
	lines.push("");
	lines.push(
		"The inverse also holds. Reading a file you can name, editing a location you have " +
		"already found, running a build, or answering from what is already in context are " +
		"cheaper done directly \u2014 spawning an agent for those spends tokens to save none.",
	);
	lines.push("");

	// ════════════════════════════════════════════════════════════════════
	// ROUTING PATTERNS TABLE
	// ════════════════════════════════════════════════════════════════════
	lines.push("## Routing by intent");
	lines.push("");
	lines.push(
		"When a task does clear the delegation threshold above, this is which agent fits. " +
		"Scale matters more than phrasing: \"review this\" on a ten-line diff is a direct " +
		"read, the same words on a fifteen-file change are a `reviewer` dispatch.",
	);
	lines.push("");
	lines.push("| Intent | Agent |");
	lines.push("|---|---|");
	lines.push("| Locate code in unfamiliar territory, map architecture, trace call paths | `agent: scout` |");
	lines.push("| Answer a question needing external sources | `agent: researcher` |");
	lines.push("| Produce an implementation plan for a substantial change | `agent: planner` |");
	lines.push("| Review a substantial change for correctness, security, quality | `agent: reviewer` |");
	lines.push("| Carry out a multi-step change that needs builds, tests, or git | `agent: worker` |");
	lines.push("");

	// ════════════════════════════════════════════════
	// DETAILED AGENT REFERENCE (auto-generated)
	// ════════════════════════════════════════════════
	lines.push("## Subagent Reference");
	lines.push("");
	lines.push(
		"Subagents run in isolated pi processes, so their tool calls never enter your " +
		"context \u2014 only their final summary does. That isolation is the whole benefit, " +
		"and it is what you are paying the spawn overhead for.",
	);
	lines.push("");

	for (const agent of allAgents) {
		// When to use
		lines.push(`### ${agent.name}`);
		lines.push(`**${agent.description}**`);
		lines.push("");

		if (agent.subagentAgents?.length) {
			lines.push(`- Can delegate to: ${agent.subagentAgents.join(", ")}`);
		}
		lines.push(`- Tools: ${agent.tools.join(", ")}`);

		// Agent-specific guidance
		switch (agent.name) {
			case "scout":
				lines.push("- Use for: exploring unfamiliar code, tracing imports, searching for something whose location you don't know, understanding architecture.");
				lines.push("- Do NOT use for: reading files at known paths (use `read` directly — several known files are still cheaper than a spawn).");
				break;
			case "researcher":
				lines.push("- Use for: open-ended questions needing multiple searches and page fetches, synthesized findings.");
				lines.push("- Do NOT use for: fetching a known URL (use `web_fetch` directly).");
				break;
			case "worker":
				lines.push("- Use for: code changes that need bash commands (builds, tests, installs, git).");
				lines.push("- Do NOT use for: simple text changes (use `edit`/`write` directly).");
				break;
			case "planner":
				lines.push("- Use for: changes whose shape isn't obvious yet — unclear blast radius, several plausible approaches, or unfamiliar subsystems. It scouts and researches, then returns a structured plan.");
				lines.push("- Do NOT use for: changes you can already describe step by step (just make them).");
				break;
			case "reviewer":
				lines.push("- Use for: reviewing a substantial change, or when a second independent pass on correctness and security is worth a spawn.");
				lines.push("- Do NOT use for: a diff small enough to read in full yourself.");
				break;
			default:
				lines.push(`- Dispatch \`agent: ${agent.name}\` when the task matches its purpose.`);
				break;
		}
		lines.push("");
	}

	// General principles
	lines.push("### General Principles");
	lines.push("");
	lines.push("- **Parallelize** — dispatch multiple independent subagents in the same turn; they run concurrently.");
	lines.push("- **Chain** — planner → worker → reviewer is the shape for genuinely large work; skip straight to the step you need for anything smaller.");
	lines.push("- **Subagents have NO context from the current conversation** — include ALL necessary context in the task description.");

	return lines.join("\n");
}

/**
 * Build the tool guidance block.
 *
 * Guidance only — nothing here is enforced, and no tool is blocked. It exists to
 * make the cost of each option legible so the model can pick the cheap one, not
 * to funnel every operation through a subagent.
 *
 * Child subagent processes have full tool access and never see this block.
 */
const TOOL_RESTRICTIONS = [
	"## Tool Selection",
	"",
	"Every tool below is available to you directly. The question is never permission, only cost:",
	"a direct call costs what it returns, a subagent costs a spawn plus its own prompt and turns.",
	"Pick whichever is smaller for the task in front of you.",
	"",
	"### Usually cheapest done directly",
	"",
	"| Tool | Notes |",
	"|---|---|",
	"| `read` | Any file whose path you know. Several known files still beat a spawn, and what you read stays available for follow-ups. |",
	"| `ls` | Orientation in a known directory. |",
	"| `edit` | Targeted edits to located code. |",
	"| `write` | Creating or finalizing files. |",
	"| `bash` | Builds, tests, git, and other bounded commands. |",
	"| `web_fetch` | When you already have the URL. |",
	"| `grep` / `ffgrep` / `find` / `fffind` | A bounded search with a known scope — a specific directory, a pattern you expect few hits for. |",
	"",
	"### Usually cheaper as a subagent",
	"",
	"| Situation | Delegate to |",
	"|---|---|",
	"| Search whose scope you can't bound yet — unknown location, broad pattern, unfamiliar repo | `agent: scout` |",
	"| Iterative search: grep, read hits, refine, repeat | `agent: scout` |",
	"| `web_search` across several queries and pages | `agent: researcher` |",
	"",
	"The dividing line is whether you can predict the volume. One grep with an expected handful of",
	"hits is fine directly; a hunt that will take several rounds of grep-and-read belongs in a subagent.",
	"",
	"### Bash patterns usually worth delegating",
	"",
	"These tend to produce output far larger than the answer you want out of them:",
	"- `grep`, `rg`, `ag`, `ack`, `find` used to sweep an unbounded scope",
	"- `git grep` across a whole history or tree",
	"- `node -e`/`--eval`, `bun -e`/`--eval`, `npx tsx -e`, `deno eval` (inline JS/TS exploration)",
	"- `python -c`, `python3 -c`, `ruby -e`, `perl -e`, `php -r` (inline scripting to inspect code)",
	"",
	"A scoped use of any of these — `rg` in one directory, a one-line `python3 -c` computing a value —",
	"is fine directly. It is the unbounded sweep that is worth a subagent.",
	"",
	"None of this applies to subagent child processes: they have full tool access and no such guidance.",
	"",
].join("\n");

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	pi.on("session_start", async () => {
		// Invalidate caches so reloads pick up new agent files
		cachedAgents = null;
		cachedDelegationRules = null;
		pendingRoutingAgent = null;
	});

	// Input pre-processor: detect routing intent (don't transform — inject via before_agent_start)
	pi.on("input", (event) => {
		// Only route for interactive user input, not for extension-sent messages
		if (process.env.PI_IS_SUBAGENT === "1") return;
		if (event.source !== "interactive") return;

		const text = event.text.toLowerCase();

		// The user has bounded the scope themselves — no hint, direct tools are cheaper.
		if (SCOPE_LIMITERS.some((re) => re.test(text))) {
			pendingRoutingAgent = null;
			return { action: "continue" as const };
		}

		// Conservative multi-word matching — only trigger on clear intent signals
		for (const rule of ROUTING_RULES) {
			if (rule.keywords.some((kw) => text.includes(kw))) {
				pendingRoutingAgent = rule.agent;
				return { action: "continue" as const };
			}
		}

		pendingRoutingAgent = null;
		return { action: "continue" as const };
	});

	// Track turn boundaries for routing state cleanup
	pi.on("turn_start", (event) => {
		if (process.env.PI_IS_SUBAGENT === "1") return;
		pendingRoutingAgent = null; // Clear stale routing decision
	});

	pi.on("before_agent_start", async (event) => {
		// Skip delegation rules in child processes — they have full tool access
		// and the rules waste 1-2k tokens of their limited context.
		if (process.env.PI_IS_SUBAGENT === "1") return;

		// Build delegation guidance (auto-generated, at TOP of system prompt)
		if (!cachedDelegationRules) {
			cachedDelegationRules = generateDelegationRules(loadAllAgents());
		}

		// Prepend rules + guidance BEFORE the existing system prompt.
		// This block is turn-invariant, which keeps the cached prefix stable.
		const systemPrompt = cachedDelegationRules + "\n\n" + TOOL_RESTRICTIONS + "\n\n" + event.systemPrompt;

		// Suggest a route if the input matched a routing rule.
		//
		// This goes in the message channel, NOT the system prompt: the hint varies
		// per turn, and prepending it to the system prompt would change the cached
		// prefix on exactly the turns it fires, forfeiting the prompt cache.
		let routingMessage = undefined;
		if (pendingRoutingAgent) {
			const agent = pendingRoutingAgent;
			pendingRoutingAgent = null;

			const routingPatterns: Record<string, string> = {
				reviewer: "code review",
				planner: "implementation planning",
				researcher: "web research",
			};
			const pattern = routingPatterns[agent] || "specialized";

			routingMessage = {
				customType: "register-agents-routing",
				content:
					`Routing hint: this reads like a ${pattern} task, which \`agent: ${agent}\` handles. ` +
					`Use it if the scope warrants a spawn; if the work is small enough to do directly, do that instead.`,
				display: false,
				details: { agent },
			};
		}

		return {
			message: routingMessage,
			systemPrompt,
		};
	});

}
