/**
 * Register Custom Subagents & Enforce Delegation
 *
 * Discovers agent markdown files from the `agents/` directory (relative to
 * this extension) and registers them with the pi-subagents extension via
 * the globalThis.__pi_subagents bridge.
 *
 * Enforcement (multi-layered to encourage subagent delegation):
 *
 * 1. System prompt injection (before_agent_start)
 *    - Auto-generated delegation table: "You MUST dispatch subagents for..."
 *    - Anti-patterns table: concrete bypass examples with correct alternatives
 *    - Routing patterns table: user intent → dispatch agent mapping
 *    - Tool restrictions: what's recommended vs discouraged and why
 *
 * 2. Input pre-processor (input event)
 *    - Classifies user messages using conservative keyword matching
 *    - Injects routing directive prefix when a clear agent match is found
 *
 * 3. Turn boundary tracking (turn_start event)
 *    - Clears stale routing decisions
 *
 * Child subagent processes (PI_IS_SUBAGENT=1) have full tool access.
 * Soft guidance applies only to the main agent process.
 *
 * Agent file format (frontmatter + markdown body):
 *   ---
 *   name: agent-name
 *   description: What the agent does
 *   tools: comma, separated, tool, names
 *   subagent_agents: comma, separated, agent, names  (optional)
 *   model: provider/model-id  (default: nan/deepseek-v4-flash)
 *   thinking: off|low|medium|high  (default: medium)
 *   ---
 *   System prompt body...
 *
 * Adding a new .md file to agents/ automatically:
 * - Registers the agent with the subagent bridge
 * - Generates enforcement rules in the system prompt
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ── Precompiled constants ────────────────────────────────────────────

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

const AGENTS_DIR = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"agents",
);

// ── Agent Loading ────────────────────────────────────────────────────

interface AgentMeta {
	name: string;
	description: string;
	tools: string[];
	model: string;
	thinking: string;
	systemPrompt: string;
	filePath: string;
	subagentAgents?: string[];
}

let cachedAgents: AgentMeta[] | null = null;
let cachedDelegationRules: string | null = null;
let agentsRegistered = false;
let pendingRoutingAgent: string | null = null;

/**
 * Load custom agent .md files from the extensions/agents/ directory.
 */
function loadCustomAgents(): AgentMeta[] {
	if (cachedAgents) return cachedAgents;

	const agents: AgentMeta[] = [];
	if (!fs.existsSync(AGENTS_DIR)) {
		cachedAgents = [];
		return cachedAgents;
	}

	for (const entry of fs.readdirSync(AGENTS_DIR)) {
		// Skip non-agent files: validation reports, output reports, or any file
		// that doesn't start with YAML frontmatter ("---").
		if (!entry.endsWith(".md")) continue;
		if (entry.endsWith("-validation.md") || entry.endsWith("-output.md")) continue;

		const filePath = path.join(AGENTS_DIR, entry);
		const content = fs.readFileSync(filePath, "utf-8");
		// Skip files that don't have YAML frontmatter (no "---\n" prefix)
		if (!content.startsWith("---\n")) continue;

		const { frontmatter, body } =
			parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name) continue;

		const tools = (frontmatter.tools || "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const rawSubagentAgents = frontmatter.subagent_agents;
		const subagentAgents = rawSubagentAgents
			? rawSubagentAgents.split(",").map((t) => t.trim()).filter(Boolean)
			: undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools,
			model: frontmatter.model || "nan/deepseek-v4-flash",
			thinking: frontmatter.thinking || "medium",
			systemPrompt: body,
			filePath,
			subagentAgents,
		});
	}

	cachedAgents = agents;
	return agents;
}

/**
 * Load ALL agents from extensions/agents/.
 */
function loadAllAgents(): AgentMeta[] {
	return loadCustomAgents();
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
	// ENFORCEMENT TABLE (auto-generated from agent list)
	// ════════════════════════════════════════════════
	lines.push("## MANDATORY SUBAGENT DELEGATION");
	lines.push("");
	lines.push(
		"You MUST dispatch subagents for the following task types. Direct tool use " +
		"without dispatching the appropriate subagent first is not allowed for these categories:",
	);
	lines.push("");
	lines.push("| Task Type | Dispatch Agent | Tools & Capabilities |");
	lines.push("|---|---|---|");

	for (const agent of allAgents) {
		const capParts: string[] = [`Tools: ${agent.tools.join(", ")}`];
		if (agent.subagentAgents?.length) {
			capParts.push(`Can spawn: ${agent.subagentAgents.join(", ")}`);
		}
		lines.push(`| ${agent.description} | \`agent: ${agent.name}\` | ${capParts.join(". ")} |`);
	}

	lines.push("");
	lines.push("### Exemptions");
	lines.push(
		"Quick lookups (1\u20132 file reads at known paths), simple single-file edits, " +
		"or trivial questions (e.g. \"what's 2+2?\") do not require a subagent. " +
		"When in doubt, dispatch a subagent.",
	);
	lines.push("");

	// ════════════════════════════════════════════════════════════════════
	// ANTI-PATTERNS TABLE
	// ════════════════════════════════════════════════════════════════════
	lines.push("## Anti-patterns \u2014 DO NOT bypass subagents");
	lines.push("");
	lines.push("These are common bypass patterns that waste context and are NOT ALLOWED:");
	lines.push("");
	lines.push("| \u274c Anti-pattern (what you might be tempted to do) | \u2705 Correct approach |");
	lines.push("|---|---|");
	lines.push("| `read` on 3+ files to understand code | Dispatch `agent: scout` for compressed summaries |");
	lines.push("| `bash node -e \"...\"` to explore or compute something inline | Dispatch `agent: scout` or `agent: worker` |");
	lines.push("| `bash npx tsx -e \"...\"` to run inline TypeScript | Dispatch `agent: scout` or `agent: worker` |");
	lines.push("| `bash python3 -c \"...\"` to explore code properties | Dispatch `agent: scout` (it runs in isolation) |");
	lines.push("| `bash cat` + pipe to analyze source files | Dispatch `agent: scout` for structured output |");
	lines.push("| Reading 5+ files in a single turn to 'just understand' | Dispatch `agent: scout` first for orientation |");
	lines.push("| Trying to review code without dispatching `agent: reviewer` | Always dispatch reviewer for review tasks |");
	lines.push("| Jumping straight to implementation without `agent: planner` | Dispatch planner first for non-trivial changes |");
	lines.push("");
	lines.push("**Consequence of bypassing:** every subagent you skip dumps raw data into your finite context window.");
	lines.push("Subagents run in isolated processes and return only compressed summaries. Direct tool abuse leads");
	lines.push("to context overflow, truncated responses, and missed work.");
	lines.push("");

	// ════════════════════════════════════════════════════════════════════
	// ROUTING PATTERNS TABLE
	// ════════════════════════════════════════════════════════════════════
	lines.push("## Routing Patterns \u2014 explicit dispatch rules");
	lines.push("");
	lines.push("| When the user says... | Dispatch this agent FIRST |");
	lines.push("|---|---|");
	lines.push("| \"review this code\" / \"check for issues\" / \"performance impact\" / \"code audit\" / \"validate\" | `agent: reviewer` |");
	lines.push("| \"plan implementation\" / \"how to implement\" / \"what needs to change\" | `agent: planner` |");
	lines.push("| \"find where X is defined\" / \"explore codebase\" / \"map architecture\" / \"trace\" | `agent: scout` |");
	lines.push("| \"research Y\" / \"search the web for Z\" / \"find docs\" / \"look up\" | `agent: researcher` |");
	lines.push("| \"implement X\" / \"change Y\" / \"add feature\" / \"refactor\" / \"fix bug\" | `agent: worker` (after planner if complex) |");
	lines.push("");

	// ════════════════════════════════════════════════
	// DETAILED AGENT REFERENCE (auto-generated)
	// ════════════════════════════════════════════════
	lines.push("## Subagent Reference");
	lines.push("");
	lines.push(
		"Subagents run in isolated pi processes \u2014 their tool calls don't bloat your context. " +
		"Use them for complex, multi-step, or high-context work. Use direct tools for " +
		"simple, targeted operations.",
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
				lines.push("- Use for: exploring unfamiliar code, tracing imports, grepping across many files, understanding architecture.");
				lines.push("- Do NOT use for: reading a single file at a known path (use `read` directly).");
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
				lines.push("- Use BEFORE any non-trivial implementation. The planner scouts code, researches, and produces a structured plan.");
				lines.push("- Do NOT write/edit/implement without dispatching planner first for anything beyond a quick fix.");
				break;
			case "reviewer":
				lines.push("- Use AFTER implementation to validate code quality, security, and plan adherence.");
				lines.push("- Do NOT finalize changes without review for anything beyond trivial edits.");
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
	lines.push("- **Chain** — use planner first, then worker, then reviewer for structured work.");
	lines.push("- **Subagents have NO context from the current conversation** — include ALL necessary context in the task description.");

	return lines.join("\n");
}

/**
 * Build the tool restrictions block.
 *
 * Recommended tools are for targeted, bounded operations. High-context tools
 * should be delegated to subagents. This is soft guidance only — no hard blocks.
 *
 * Child subagent processes have full tool access.
 */
const TOOL_RESTRICTIONS = [
	"## Tool Restrictions",
	"",
	"Your direct tools are for **targeted, bounded operations only** — not for exploration, research, or review.",
	"Use the `subagent` tool to delegate work that would produce high-volume output or consume significant context.",
	"",
	"### Recommended tools (direct use)",
	"",
	"| Tool | When to use directly |",
	"|---|---|",
	"| `subagent` | **Always first** for exploration, research, review, or multi-file work |",
	"| `read` | Only after scout has identified the file; or 1-2 quick lookups at known paths |",
	"| `ls` | Quick orientation of a known directory |",
	"| `write` | Finalizing changes |",
	"| `edit` | Targeted edits to known locations |",
	"| `bash` | Simple commands at known paths; prefer subagent for exploration scripts or inline eval |",
	"| `web_fetch` | Only when you have the exact URL |",
	"",
	"### Tools best delegated to subagents",
	"",
	"| Tool | Delegate to |",
	"|---|---|",
	"| `grep` | `agent: scout` |",
	"| `find` | `agent: scout` |",
	"| `ffgrep` | `agent: scout` |",
	"| `fffind` | `agent: scout` |",
	"| `fff-multi-grep` | `agent: scout` |",
	"| `web_search` | `agent: researcher` |",
	"",
	"### Bash patterns best delegated to subagents",
	"",
	"The following bash commands produce high-volume output and are better delegated:",
	"- `grep`, `rg`, `ag`, `ack`, `find`, `sed`, `awk` as base commands (code search)",
	"- `git grep` (code search via git)",
	"- `node -e`/`--eval`, `bun -e`/`--eval` (inline JS execution — replaces scout)",
	"- `npx tsx -e` (inline TypeScript execution — replaces scout)",
	"- `deno eval` (inline code execution)",
	"- `python -c`, `python3 -c`, `ruby -e`, `perl -e`, `php -r` (inline scripting)",
	"",
	"Subagent child processes have full tool access — guidance applies only to this main agent.",
	"",
].join("\n");

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// Register agents with the pi-subagents runtime
	pi.on("session_start", async () => {
		// Invalidate caches so reloads pick up new agent files
		cachedAgents = null;
		cachedDelegationRules = null;
		agentsRegistered = false;
		pendingRoutingAgent = null;
	});

	// Input pre-processor: detect routing intent (don't transform — inject via before_agent_start)
	pi.on("input", (event) => {
		// Only route for interactive user input, not for extension-sent messages
		if (process.env.PI_IS_SUBAGENT === "1") return;
		if (event.source !== "interactive") return;

		const text = event.text.toLowerCase();

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

		const customAgents = loadCustomAgents();

		// Register custom agents with the pi-subagents bridge
		if (!agentsRegistered) {
			const bridge = (globalThis as any).__pi_subagents as
				| { registerAgent: (config: any) => void; unregisterAgent: (name: string) => void }
				| undefined;

			if (bridge) {
				for (const agent of customAgents) {
					try {
						// Unregister first to avoid "already registered" errors.
						// pi-subagents natively loads agents from both built-in and user
						// directories at startup. The bridge is a fallback for agents
						// added after startup.
						try { bridge.unregisterAgent(agent.name); } catch {}
						bridge.registerAgent({
							name: agent.name,
							description: agent.description,
							tools: agent.tools,
							model: agent.model,
							thinking: agent.thinking,
							systemPrompt: agent.systemPrompt,
							filePath: agent.filePath,
							...(agent.subagentAgents ? { subagentAgents: agent.subagentAgents } : {}),
						});
					} catch (err) {
						// "already registered" is expected when pi-subagents has already
						// loaded the user agent natively — suppress the noise.
						const msg = err instanceof Error ? err.message : String(err);
						if (!msg.includes("already registered")) {
							console.warn(`[register-agents] Failed to register agent ${agent.name}:`, err);
						}
					}
				}
				agentsRegistered = true;
			} else {
				console.warn("[register-agents] pi-subagents bridge not found in before_agent_start");
			}
		}

		// Build delegation rules (auto-generated, at TOP of system prompt)
		if (!cachedDelegationRules) {
			const allAgents = loadAllAgents();
			cachedDelegationRules = generateDelegationRules(allAgents);
		}

		// Prepend rules + restrictions BEFORE the existing system prompt
		let systemPrompt = cachedDelegationRules + "\n\n" + TOOL_RESTRICTIONS + "\n\n" + event.systemPrompt;

		// Inject routing directive if input matched a routing rule
		let routingMessage = undefined;
		if (pendingRoutingAgent) {
			const agent = pendingRoutingAgent;
			pendingRoutingAgent = null;

			const routingPatterns: Record<string, string> = {
				reviewer: "CODE REVIEW",
				planner: "IMPLEMENTATION PLANNING",
				researcher: "WEB RESEARCH",
			};
			const pattern = routingPatterns[agent] || "TASK";

			systemPrompt =
				`\u26a0\ufe0f ROUTING REQUIREMENT: This task matches ${pattern} patterns (agent:${agent}).\n` +
				`Dispatch agent:${agent} FIRST \u2014 direct tool use for this task type risks context overflow.\n\n` +
				systemPrompt;

			routingMessage = {
				customType: "register-agents-routing",
				content: `Routing directive: dispatch agent:${agent} for this ${pattern.toLowerCase()} task.`,
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
