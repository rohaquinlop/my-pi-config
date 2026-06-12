/**
 * Register Custom Subagents & Generate Delegation Rules
 *
 * Discovers agent markdown files from the `agents/` directory (relative to
 * this extension) and registers them with the pi-subagents extension via
 * the globalThis.__pi_subagents bridge.
 *
 * Also injects auto-generated delegation rules into the system prompt via
 * `before_agent_start`.  These rules tell the main agent WHEN to use each
 * subagent vs. direct tools, based on the agent's tool list and description.
 * No manual maintenance — adding a new .md file updates everything.
 *
 * Agent file format (frontmatter + markdown body):
 *   ---
 *   name: agent-name
 *   description: What the agent does
 *   tools: comma, separated, tool, names
 *   subagent_agents: comma, separated, agent, names  (optional)
 *   model: provider/model-id  (default: deepseek/deepseek-v4-flash)
 *   thinking: off|low|medium|high  (default: medium)
 *   ---
 *   System prompt body...
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

function loadAgentFiles(): AgentMeta[] {
	if (cachedAgents) return cachedAgents;

	const agents: AgentMeta[] = [];
	if (!fs.existsSync(AGENTS_DIR)) {
		cachedAgents = [];
		return cachedAgents;
	}

	for (const entry of fs.readdirSync(AGENTS_DIR)) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(AGENTS_DIR, entry);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const { frontmatter, body } =
				parseFrontmatter<Record<string, string>>(content);
			if (!frontmatter.name) {
				console.warn(
					`[register-agents] Skipping ${entry}: no "name" in frontmatter`,
				);
				continue;
			}

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
				model: frontmatter.model || "deepseek/deepseek-v4-flash",
				thinking: frontmatter.thinking || "medium",
				systemPrompt: body,
				filePath,
				subagentAgents,
			});
		} catch (err) {
			console.warn(`[register-agents] Error loading ${entry}:`, err);
		}
	}

	cachedAgents = agents;
	return agents;
}

// ── Delegation Rule Generation ──────────────────────────────────────

/**
 * Map of built-in tool names that the main agent has by default.
 * Any agent whose tool list overlaps these is a candidate for delegation.
 */
const DIRECT_TOOLS = new Set([
	"read",
	"bash",
	"ls",
	"edit",
	"write",
	"grep",
	"find",
	"web_search",
	"web_fetch",
]);

/**
 * Generate human-readable delegation rules for each agent based on its
 * tool list and description.  These are injected into the system prompt.
 */
function generateDelegationRules(agents: AgentMeta[]): string {
	if (agents.length === 0) return "";

	const lines: string[] = [
		"## Subagent Delegation Guidelines",
		"",
		"Subagents run in isolated pi processes — their tool calls don't bloat your context.",
		"Use them for complex, multi-step, or high-context work.  Use direct tools for",
		"simple, targeted operations.",
		"",
	];

	for (const agent of agents) {
		// Determine what direct-tool overlap this agent has
		const overlappingTools = agent.tools.filter((t) =>
			DIRECT_TOOLS.has(t),
		);

		// Build one or more "when" rules based on the agent's unique tools
		const rules = agentSpecificRules(agent);
		if (rules.length > 0) {
			lines.push(`### ${agent.name}`);
			lines.push(...rules.map((r) => `- ${r}`));
			lines.push("");
		}
	}

	// General guidance
	lines.push("### General Principles");
	lines.push(
		"- **Simple & fast** (one file read, quick grep, single fetch) → use direct tools; subagent overhead (~8s) isn't worth it.",
	);
	lines.push(
		"- **Complex & multi-step** (unknown code areas, broad searches, multi-page research, implementation needing recon) → dispatch a subagent; the context savings are worth the overhead.",
	);
	lines.push(
		"- **Parallelize** — dispatch multiple independent subagents in the same turn; they run concurrently.",
	);
	lines.push(
		"- **Chain** — use planner first, then worker, then reviewer for structured work.",
	);

	return lines.join("\n");
}

function agentSpecificRules(agent: AgentMeta): string[] {
	const rules: string[] = [];
	const tools = new Set(agent.tools);

	switch (agent.name) {
		case "scout":
			rules.push(
				"**Code exploration**: dispatch `agent: scout` when you need to explore unfamiliar code, trace imports, grep across many files, or understand architecture. " +
					"Scouts return compressed summaries — they're cheap for big searches.",
			);
			rules.push(
				"**Direct alternative** (when to NOT use scout): use `grep`/`read` directly for targeted lookups at known paths, single-file reads, or narrow patterns.",
			);
			break;

		case "researcher":
			rules.push(
				"**Web research**: dispatch `agent: researcher` for open-ended questions that need multiple searches and page fetches, or when you need synthesized findings.",
			);
			rules.push(
				"**Direct alternative**: use `web_search`/`web_fetch` directly when you already know the exact URL or need one quick search result.",
			);
			break;

		case "worker":
			rules.push(
				"**Code changes + bash**: dispatch `agent: worker` for changes that need bash commands (builds, tests, installs, git operations). Worker has `safe_bash` with dangerous-command blocking.",
			);
			rules.push(
				"**Direct alternative**: use `edit`/`write` directly for simple text changes. Use `bash` directly for quick commands.",
			);
			break;

		case "planner":
			rules.push(
				"**Implementation planning**: dispatch `agent: planner` before making non-trivial changes. The planner scouts the codebase, researches as needed, and produces a structured plan with steps, files, and risks.",
			);
			break;

		case "reviewer":
			rules.push(
				"**Code/plan review**: dispatch `agent: reviewer` to validate code quality, security, and plan adherence. Use after implementing changes or before finalizing.",
			);
			break;

		default:
			// Generic rule for any agent not covered above
			if (agent.description) {
				rules.push(
					`**${agent.description}**: dispatch \`agent: ${agent.name}\` when the task matches its purpose.`,
				);
			}
			if (tools.size > 0) {
				rules.push(
					`Has tools: ${agent.tools.join(", ")}. ` +
						(tools.has("subagent")
							? `Can spawn: ${agent.subagentAgents?.join(", ") || "any agent"}.`
							: "Read-only — doesn't modify files."),
				);
			}
			break;
	}

	return rules;
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Register agents with the pi-subagents runtime
	pi.on("session_start", async () => {
		// Invalidate agent cache so reloads pick up new agent files
		cachedAgents = null;
		agentsRegistered = false;
		// Registration happens in before_agent_start instead
		// to ensure the pi-subagents bridge is available.
	});

	// Inject auto-generated delegation rules into the system prompt.
	// These are derived from agent .md files — no manual updates needed.
	// Also registers agents if not yet done (bridge may not be ready at session_start).
	pi.on("before_agent_start", async (event) => {
		const agents = loadAgentFiles();
		if (agents.length === 0) return;

		// Register agents if not yet done (bridge may not be ready at session_start)
		if (!agentsRegistered) {
			const bridge = (globalThis as any).__pi_subagents as
				| { registerAgent: (config: any) => void; unregisterAgent: (name: string) => void }
				| undefined;

			if (bridge) {
				for (const agent of agents) {
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

		const rules = generateDelegationRules(agents);

		// Tool restriction message — tells the model what's blocked and why
		const restrictions = [
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

		return {
			systemPrompt:
				event.systemPrompt + "\n\n" + rules + "\n\n" + restrictions,
		};
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

	console.log('[register-agents] tool_call handler registered');
}
