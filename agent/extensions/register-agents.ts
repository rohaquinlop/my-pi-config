/**
 * Register Custom Subagents & Generate Delegation Rules
 *
 * Discovers agent markdown files from the `agents/` directory (relative to
 * this extension) and registers them with the pi-subagents extension via
 * the globalThis.__pi_subagents bridge.
 *
 * Also:
 * - Injects auto-generated delegation rules at the TOP of the system prompt
 *   with MANDATORY language (no hardcoded cases — all rules derived from
 *   agent .md frontmatter).
 * - Provides a pre-processor hook (via `before_agent_start`) that classifies
 *   the user's prompt against agent descriptions and injects a routing
 *   directive message before the main LLM sees the request.
 * - Intercepts grep/find/bash-with-grep and redirects to scout.
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
 * - Adds intent classification for the pre-processor
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
let agentsRegistered = false;

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
 * Load agent .md files from the pi-subagents package's own agents/ directory
 * (scout, researcher, worker). These are merged into the delegation rules
 * so the enforcement table covers all available subagents, not just custom ones.
 */
function loadSubagentsPackageAgents(): AgentMeta[] {
	const pkgDir = path.join(
		os.homedir(),
		".pi",
		"agent",
		"git",
		"github.com",
		"rohaquinlop",
		"pi-subagents",
		"agents",
	);

	const agents: AgentMeta[] = [];
	if (!fs.existsSync(pkgDir)) return agents;

	for (const entry of fs.readdirSync(pkgDir)) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(pkgDir, entry);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
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
		} catch {
			// skip unparseable files
		}
	}

	return agents;
}

/**
 * Load ALL agents: custom ones from extensions/agents/ + built-in ones from
 * the pi-subagents package.
 */
function loadAllAgents(): AgentMeta[] {
	const custom = loadCustomAgents();
	const pkg = loadSubagentsPackageAgents();
	// Merge, deduplicating by name (custom overrides package)
	const names = new Set<string>();
	const all: AgentMeta[] = [];
	for (const a of [...custom, ...pkg]) {
		if (!names.has(a.name)) {
			names.add(a.name);
			all.push(a);
		}
	}
	return all;
}

// ── Intent Classification ────────────────────────────────────────────

/**
 * Classify a user prompt against available agents.
 * Returns ALL agents scoring above threshold, sorted by relevance.
 *
 * Uses keyword scoring from agent name + description.
 * Threshold: at least 2 keyword hits or explicit name mention.
 * Supports parallel dispatch — multiple agents can match one prompt
 * (e.g. "implement and review" → [planner, reviewer]).
 */
function classifyIntent(prompt: string, agents: AgentMeta[]): AgentMeta[] {
	const lowerPrompt = prompt.toLowerCase();

	const scored: { agent: AgentMeta; score: number }[] = [];

	for (const agent of agents) {
		let score = 0;

		// Explicit name mention = strong signal
		if (lowerPrompt.includes(agent.name.toLowerCase())) {
			score += 3;
		}

		// Score from description keywords
		const desc = agent.description.toLowerCase();
		const keywords = desc
			.split(/[\s—–,]+/)
			.map((w) => w.replace(/^[^a-z]+|[^a-z]+$/g, ""))
			.filter((w) => w.length > 3 && !["with", "that", "this", "from", "their"].includes(w));

		for (const kw of keywords) {
			if (lowerPrompt.includes(kw)) {
				score++;
			}
		}

		// Tool-based heuristic
		if (agent.name === "planner" && /plan|implement|design|architecture|build/.test(lowerPrompt)) {
			score += 2;
		}
		if (agent.name === "reviewer" && /review|check|audit|validate|quality/.test(lowerPrompt)) {
			score += 2;
		}
		if (agent.name === "scout" && /find|search|explore|trace|locate|where|current changes|what changed|explain changes|summarize changes|uncommitted|overview|codebase|architecture|how does|how is|project state|git (diff|status|log|changes|show)/.test(lowerPrompt)) {
			score += 2;
		}
		if (agent.name === "researcher" && /research|search web|look up|find docs|api docs|documentation/.test(lowerPrompt)) {
			score += 2;
		}

		if (score >= 2) {
			scored.push({ agent, score });
		}
	}

	// Sort descending by score
	scored.sort((a, b) => b.score - a.score);
	return scored.map((s) => s.agent);
}

/**
 * Build a routing directive message for one or more matched agents.
 * This is injected before the user's prompt to guide the LLM.
 * Supports parallel dispatch: when multiple agents match, the directive
 * lists them in priority order and suggests chaining/parallelization.
 */
function buildRoutingDirective(agents: AgentMeta[]): string {
	if (agents.length === 0) return "";

	const lines: string[] = [];

	if (agents.length === 1) {
		const agent = agents[0];
		lines.push(`[Pre-processor routing] The user's request matches **${agent.name}**: ${agent.description}`);
		lines.push("");
		lines.push(`You MUST dispatch \`agent: ${agent.name}\` with the full user context before using direct tools.`);
		if (agent.name === "planner") lines.push("Do not write, edit, or implement anything until the planner returns a plan.");
		if (agent.name === "reviewer") lines.push("Dispatch the reviewer agent to validate before finalizing.");
		if (agent.name === "scout") lines.push("Dispatch scout for codebase recon. Use the findings to orient yourself.");
		if (agent.name === "researcher") lines.push("Dispatch researcher for external knowledge before answering.");
		if (agent.name === "worker") lines.push("The worker handles implementation. Dispatch it with full context.");
	} else {
		lines.push("[Pre-processor routing] The user's request matches multiple subagents:");
		lines.push("");

		// Build ordered list with descriptions
		const ordered = [...agents];
		// Reorder: scout first (recon), then researcher (knowledge), then planner (plan),
		// then worker (implement), then reviewer (review). Unknown agents at the end.
		const priority = ["scout", "researcher", "planner", "worker", "reviewer"];
		ordered.sort((a, b) => {
			const ia = priority.indexOf(a.name);
			const ib = priority.indexOf(b.name);
			return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
		});

		for (let i = 0; i < ordered.length; i++) {
			const agent = ordered[i];
			lines.push(`${i + 1}. **${agent.name}**: ${agent.description}`);
		}

		lines.push("");

		// Suggest ordering
		const names = ordered.map((a) => a.name);
		const hasChainable = names.some((n) => ["scout", "planner", "reviewer"].includes(n));
		if (hasChainable) {
			const chainOrder = names.filter((n) => priority.includes(n)).sort(
				(a, b) => priority.indexOf(a) - priority.indexOf(b),
			);
			lines.push(`Suggested order: ${chainOrder.join(" → ")}`);
			lines.push("Dispatch independent agents in parallel. Chain dependent ones (scout → planner → worker → reviewer).");
		} else {
			lines.push("You MAY dispatch these agents in parallel using multiple `subagent` tool calls in the same turn.");
		}
	}

	return lines.join("\n");
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
		"Quick lookups (1–2 file reads at known paths), simple single-file edits, " +
		"or trivial questions (e.g. \"what's 2+2?\") do not require a subagent. " +
		"When in doubt, dispatch a subagent.",
	);
	lines.push("");

	// ════════════════════════════════════════════════
	// DETAILED AGENT REFERENCE (auto-generated)
	// ════════════════════════════════════════════════
	lines.push("## Subagent Reference");
	lines.push("");
	lines.push(
		"Subagents run in isolated pi processes — their tool calls don't bloat your context. " +
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
 * Build the tool restrictions block (same as before, but tweaked).
 */
const TOOL_RESTRICTIONS = [
	"## Tool Restrictions",
	"",
	"To prevent context bloat, the following operations are blocked and will be redirected:",
	"",
	"| Blocked operation | Alternative |",
	"|---|---|",
	"| `grep` tool | Use `subagent` with `agent: scout` for code searches |",
	"| `find` tool | Use `subagent` with `agent: scout` for file discovery |",
	"| `bash` with `grep`/`rg`/`find`/`ag`/`ack` | Use `subagent` with `agent: scout` for code exploration |",
	"",
	"All other tools (`read`, `ls`, `bash`, `edit`, `write`, `web_search`, `web_fetch`, `subagent`) are",
	"available directly with no restrictions.",
	"",
].join("\n");

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Register agents with the pi-subagents runtime
	pi.on("session_start", async () => {
		// Invalidate agent cache so reloads pick up new agent files
		cachedAgents = null;
		agentsRegistered = false;
	});

	// ── Pre-processor: classify + route + enforce ──
	//
	// 1. Register custom agents with the pi-subagents bridge
	// 2. Classify the user's prompt against all agent descriptions
	// 3. If matched, inject a routing directive message BEFORE the user's prompt
	// 4. Inject delegation rules at the TOP of the system prompt (not appended)
	pi.on("before_agent_start", async (event) => {
		const customAgents = loadCustomAgents();

		// Register custom agents with bridge if not yet done
		if (!agentsRegistered) {
			const bridge = (globalThis as any).__pi_subagents as
				| { registerAgent: (config: any) => void; unregisterAgent: (name: string) => void }
				| undefined;

			if (bridge) {
				for (const agent of customAgents) {
					try {
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
						console.warn(`[register-agents] Failed to register agent ${agent.name}:`, err);
					}
				}
				agentsRegistered = true;
			} else {
				console.warn("[register-agents] pi-subagents bridge not found in before_agent_start");
			}
		}

		// Classify intent — returns ALL matched agents (supports parallel dispatch)
		const allAgents = loadAllAgents();
		const matchedAgents = classifyIntent(event.prompt, allAgents);

		const result: {
			systemPrompt?: string;
			message?: { customType: string; content: string; display: boolean };
		} = {};

		// Inject routing directive if any agents matched
		if (matchedAgents.length > 0) {
			result.message = {
				customType: "routing",
				content: buildRoutingDirective(matchedAgents),
				display: true,
			};
		}

		// Build delegation rules (auto-generated, at TOP of system prompt)
		const rules = generateDelegationRules(allAgents);

		// Prepend rules + restrictions BEFORE the existing system prompt
		result.systemPrompt = rules + "\n\n" + TOOL_RESTRICTIONS + "\n\n" + event.systemPrompt;

		return result;
	});

	// Intercept grep-like commands (bash, native grep/find tools) and redirect to scout
	pi.on("tool_call", (event, ctx) => {
		// Block native grep and find — use scout instead (context bloat)
		if (event.toolName === "grep" || event.toolName === "find") {
			return {
				block: true,
				reason:
					"Broad code searches bloat your context window. Use `subagent` with `agent: scout` for code exploration — it runs in an isolated process and returns compressed summaries. The scout can grep, find, and read files without filling your context.",
			};
		}

		// Block bash commands that run grep/rg/find — use scout instead
		if (event.toolName === "bash") {
			const cmd = (event.input as any).command || "";
			const searchPatterns = /\b(grep|rg|find|ag|ack|git\s+grep)\b/;
			if (searchPatterns.test(cmd)) {
				return {
					block: true,
					reason:
						"Broad code searches bloat your context. Use subagent agent:scout for code exploration instead — it runs in an isolated process and returns compressed summaries.",
				};
			}
		}
	});

}
