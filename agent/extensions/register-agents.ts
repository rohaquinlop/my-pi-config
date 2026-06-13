/**
 * Register Custom Subagents & Enforce Delegation
 *
 * Discovers agent markdown files from the `agents/` directory (relative to
 * this extension) and registers them with the pi-subagents extension via
 * the globalThis.__pi_subagents bridge.
 *
 * Enforcement:
 * - Blocks high-context tools (grep, find, web_search) and bash commands
 *   containing grep-like searches in the main agent process.
 * - Action tools (write, edit, bash) and orientation tools (read, ls) are
 *   allowed directly — they have low context cost.
 * - Child subagent processes (PI_IS_SUBAGENT=1) have full tool access.
 * - Injects auto-generated delegation rules at the TOP of the system prompt
 *   telling the LLM which agent to use for which task.
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
 * Build the tool restrictions block.
 *
 * Only high-context tools are blocked. Action tools (write, edit, bash) and
 * orientation tools (read, ls) are allowed — they have low context cost.
 */
const TOOL_RESTRICTIONS = [
	"## Tool Restrictions",
	"",
	"To protect your context window, tools that produce high-volume output are blocked.",
	"Use the `subagent` tool to delegate exploration and research tasks.",
	"",
	"| Tool | Status | Reason |",
	"|---|---|---|",
	"| `subagent` | ✅ Allowed | Primary mechanism for delegating work |",
	"| `read` | ✅ Allowed | Targeted file reads |",
	"| `ls` | ✅ Allowed | Directory orientation |",
	"| `write` | ✅ Allowed | Writing files |",
	"| `edit` | ✅ Allowed | Editing files |",
	"| `bash` | ✅ Allowed | Running commands (except grep-like searches) |",
	"| `grep` | ❌ Blocked | High context cost — delegate to `scout` agent |",
	"| `find` | ❌ Blocked | High context cost — delegate to `scout` agent |",
	"| `web_search` | ❌ Blocked | High context cost — delegate to `researcher` agent |",
	"| `web_fetch` | ✅ Allowed | Direct URL fetches |",
	"",
	"When blocked, the tool returns a reason with available agents and an example.",
	"Subagent child processes have full tool access — restrictions apply only to this main agent.",
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
		const allAgents = loadAllAgents();
		const rules = generateDelegationRules(allAgents);

		// Prepend rules + restrictions BEFORE the existing system prompt
		return {
			systemPrompt: rules + "\n\n" + TOOL_RESTRICTIONS + "\n\n" + event.systemPrompt,
		};
	});

	// Tool-level enforcement: block high-context tools in the main agent process.
	// Child subagents (PI_IS_SUBAGENT=1) have full access.
	//
	// Blocked: grep, find, web_search (high context cost — flood the main
	// agent's context with search results and file listings).
	//
	// Allowed: read, ls, write, edit, bash, web_fetch, subagent.
	// These have low context cost or are needed for direct action.
	//
	// bash with grep-like commands is also blocked (the LLM could use
	// `bash grep` to bypass the grep block).
	pi.on("tool_call", (event) => {
		const isChildProcess = process.env.PI_IS_SUBAGENT === "1";

		// Child processes: no blocking — scout, worker, researcher etc. need full tool access
		if (isChildProcess) return;

		if (agentsRegistered) {
			const blocked = new Set(["grep", "find", "web_search"]);

			// Block native grep, find, web_search
			if (blocked.has(event.toolName)) {
				const currentAgents = loadAllAgents();
				const agentList = currentAgents.length > 0
					? currentAgents.map((a) => `${a.name} (${a.description})`).join("\n  - ")
					: "(none — add agent .md files to extensions/agents/)";
				return {
					block: true,
					reason:
						`Direct use of \`${event.toolName}\` is blocked to protect your context window. ` +
						`Use the \`subagent\` tool to delegate this task.\n\n` +
						`Available agents:\n  - ${agentList}\n\n` +
						`Example: { "agent": "scout", "task": "Find all auth-related files in src/" }`,
				};
			}

			// Block bash commands that run grep/rg/find/ag/ack (bypass attempt)
			if (event.toolName === "bash") {
				const cmd = (event.input as any).command || "";
				// Extract the first command (skip env vars, pipes).
				// This avoids false positives from words like "grep" in commit messages.
				const firstCmd = cmd
					.trim()
					.replace(/^([A-Z_]+=\S+\s+)*/, "")
					.split("|")[0]
					.trim()
					.split(/\s+/);
				const base = firstCmd[0] || "";
				const sub = firstCmd[1] || "";
				// Block: grep, rg, find, ag, ack as base commands
				// Block: git grep specifically (not other git subcommands)
				if (/^(grep|rg|ag|ack|find|sed|awk)$/.test(base)) {
					return {
						block: true,
						reason:
							"Broad code searches bloat your context. Use `subagent` with `agent: scout` " +
							"for code exploration — it runs in an isolated process and returns compressed summaries.",
					};
				}
				if (base === "git" && sub === "grep") {
					return {
						block: true,
						reason:
							"Broad code searches bloat your context. Use `subagent` with `agent: scout` " +
							"for code exploration — it runs in an isolated process and returns compressed summaries.",
					};
				}
			}
		}
	});

}
