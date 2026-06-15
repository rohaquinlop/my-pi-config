/**
 * Register Custom Subagents & Enforce Delegation
 *
 * Discovers agent markdown files from the `agents/` directory (relative to
 * this extension) and registers them with the pi-subagents extension via
 * the globalThis.__pi_subagents bridge.
 *
 * Enforcement (multi-layered to prevent subagent bypass):
 *
 * 1. System prompt injection (before_agent_start)
 *    - Auto-generated delegation table: "You MUST dispatch subagents for..."
 *    - Anti-patterns table: concrete bypass examples with correct alternatives
 *    - Routing patterns table: user intent → dispatch agent mapping
 *    - Tool restrictions: what's allowed vs blocked and why
 *
 * 2. Input pre-processor (input event)
 *    - Classifies user messages using conservative keyword matching
 *    - Injects routing directive prefix when a clear agent match is found
 *
 * 3. Tool-level enforcement (tool_call event)
 *    - BLOCKED: grep, find, web_search, ffgrep, fffind, fff-multi-grep
 *    - BLOCKED bash: grep, rg, ag, ack, find, sed, awk, git grep
 *    - BLOCKED bash: node -e/--eval, bun -e, npx tsx -e, deno eval,
 *                    python -c, python3 -c, ruby -e, php -r (inline exec)
 *    - BLOCKED: 4th+ read in a single turn (forces scout dispatch, threshold=3)
 *
 * 4. Turn boundary tracking (turn_start event)
 *    - Resets read counter per turn
 *
 * Child subagent processes (PI_IS_SUBAGENT=1) have full tool access.
 * Restrictions apply only to the main agent process.
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

// ── Precompiled constants (avoid per-event allocations) ──────────────

/** Bash commands blocked as base command when running code searches */
const BLOCKED_BASH_SEARCH = /^(grep|rg|ag|ack|find|sed|awk)$/;

/** Shared eval-flag pattern used by node, bun, and npx tsx */
const EVAL_FLAG_RE = /^(?:-[eE]|--eval)$/;

/** Native tools blocked in the main agent */
const BLOCKED_TOOLS = new Set(["grep", "find", "web_search", "ffgrep", "fffind", "fff-multi-grep"]);

/** Inline eval engine flags — map of base command → flag regex */
const INLINE_EVAL_FLAGS: Record<string, RegExp> = {
	node: EVAL_FLAG_RE,
	bun: EVAL_FLAG_RE,
	deno: /^eval$/,
	python: /^-c$/,
	python3: /^-c$/,
	ruby: /^-e$/,
	perl: /^-e$/,
	php: /^-r$/,
};

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

function buildRoutingMessage(agentName: string, originalMessage: string): string {
	const agentMessages: Record<string, { pattern: string; workflow: string }> = {
		reviewer: {
			pattern: "CODE REVIEW",
			workflow:
				"Dispatch agent:reviewer FIRST. The reviewer subagent runs in an isolated " +
				"process, reads all relevant files, and returns a compressed, structured review " +
				"covering quality, security, and correctness. Only use direct read after the " +
				"subagent has identified specific files to examine.",
		},
		planner: {
			pattern: "IMPLEMENTATION PLANNING",
			workflow:
				"Dispatch agent:planner FIRST. The planner subagent scouts the codebase, " +
				"researches requirements, and produces a structured step-by-step plan. " +
				"Direct exploration burns context that the planner would use more efficiently.",
		},
		researcher: {
			pattern: "WEB RESEARCH",
			workflow:
				"Dispatch agent:researcher FIRST. The researcher subagent runs multiple " +
				"searches in parallel, fetches pages, and synthesizes a concise summary. " +
				"Direct web_search or web_fetch calls produce raw results that bloat your context.",
		},
	};

	const info = agentMessages[agentName] || { pattern: "TASK", workflow: `Dispatch agent:${agentName} first.` };

	return (
		`⚠️ ROUTING REQUIREMENT: This task matches ${info.pattern} patterns (agent:${agentName}).\n\n` +
		`Direct read/bash exploration is NOT ALLOWED for this task type because:\n` +
		`  • Context bloat — raw file contents consume 10-20x more tokens than subagent summaries\n` +
		`  • Task failure risk — context overflow causes truncated responses\n` +
		`  • Quality loss — agent:${agentName} is a specialist with targeted system prompts\n\n` +
		`CORRECT WORKFLOW: ${info.workflow}\n\n` +
		`--- original user message below ---\n\n` +
		originalMessage
	);
}

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
 * Allowed tools are only for targeted, bounded operations. High-context tools
 * are blocked. bash with grep-like commands or inline code execution is blocked
 * (the LLM could use these to bypass subagent dispatch).
 *
 * Child subagent processes have full tool access.
 */
const TOOL_RESTRICTIONS = [
	"## Tool Restrictions",
	"",
	"Your direct tools are for **targeted, bounded operations only** — not for exploration, research, or review.",
	"Use the `subagent` tool to delegate work that would produce high-volume output or consume significant context.",
	"",
	"### Allowed tools (direct use)",
	"",
	"| Tool | When to use directly |",
	"|---|---|",
	"| `subagent` | **Always first** for exploration, research, review, or multi-file work |",
	"| `read` | Only after scout has identified the file; or 1-2 quick lookups at known paths |",
	"| `ls` | Quick orientation of a known directory |",
	"| `write` | Finalizing changes |",
	"| `edit` | Targeted edits to known locations |",
	"| `bash` | Simple commands at known paths; NOT for exploration scripts or inline eval |",
	"| `web_fetch` | Only when you have the exact URL |",
	"",
	"### Blocked tools (delegate to subagent)",
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
	"### Blocked bash patterns",
	"",
	"The following bash commands are blocked to prevent subagent bypass:",
	"- `grep`, `rg`, `ag`, `ack`, `find`, `sed`, `awk` as base commands (code search)",
	"- `git grep` (code search via git)",
	"- `node -e`/`--eval`, `bun -e`/`--eval` (inline JS execution — replaces scout)",
	"- `npx tsx -e` (inline TypeScript execution — replaces scout)",
	"- `deno eval` (inline code execution)",
	"- `python -c`, `python3 -c`, `ruby -e`, `perl -e`, `php -r` (inline scripting)",
	"",
	"When blocked, the tool returns a reason with available agents and an example.",
	"Subagent child processes have full tool access — restrictions apply only to this main agent.",
	"",
].join("\n");

// ── Per-turn read counter ────────────────────────────────────────────
// Scoped inside export default to avoid shared mutable state if the module
// were ever loaded multiple times (e.g., in tests).

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Per-turn read counter — closure-scoped, not module-level.
	let readCountThisTurn = 0;
	let currentTurnIndex = -1;
	const MAX_READS_PER_TURN = 3;

	// Register agents with the pi-subagents runtime
	pi.on("session_start", async () => {
		// Invalidate caches so reloads pick up new agent files
		cachedAgents = null;
		cachedDelegationRules = null;
		agentsRegistered = false;
		readCountThisTurn = 0;
		currentTurnIndex = -1;
	});

	// Input pre-processor: inject routing directives when user task matches an agent
	pi.on("input", (event) => {
		// Only route for interactive user input, not for extension-sent messages
		if (process.env.PI_IS_SUBAGENT === "1") return;
		if (event.source !== "interactive") return;

		const text = event.text.toLowerCase();

		// Conservative multi-word matching — only trigger on clear intent signals
		for (const rule of ROUTING_RULES) {
			if (rule.keywords.some((kw) => text.includes(kw))) {
				return {
					action: "transform" as const,
					text: buildRoutingMessage(rule.agent, event.text),
				};
			}
		}

		return { action: "continue" as const };
	});

	// Track turn boundaries for read counter reset
	pi.on("turn_start", (event) => {
		if (process.env.PI_IS_SUBAGENT === "1") return;
		if (event.turnIndex !== currentTurnIndex) {
			readCountThisTurn = 0;
			currentTurnIndex = event.turnIndex;
		}
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
		return {
			systemPrompt: cachedDelegationRules + "\n\n" + TOOL_RESTRICTIONS + "\n\n" + event.systemPrompt,
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

			// Block native grep, find, web_search
			if (BLOCKED_TOOLS.has(event.toolName)) {
				const currentAgents = loadAllAgents();
				const agentList = currentAgents.length > 0
					? currentAgents.map((a) => `${a.name} (${a.description})`).join("\n  - ")
					: "(none — add agent .md files to extensions/agents/)";
				return {
					block: true,
					reason:
						`__PI_BLOCKED__` +
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
				// Handles quoted values with escaped quotes (FOO="hello\"world").
				const firstCmd = cmd
					.trim()
					.replace(/^\s*env\s+/, "")
					.replace(/^([A-Za-z0-9_]+=(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|\S+)\s+)*/, "")
					.split("|")[0]
					.trim()
					.split(/\s+/);
				const base = firstCmd[0] || "";
				const sub = firstCmd[1] || "";
				// Block: grep, rg, find, ag, ack as base commands
				// Block: git grep specifically (not other git subcommands)
				if (BLOCKED_BASH_SEARCH.test(base)) {
					return {
						block: true,
						reason:
							"__PI_BLOCKED__" +
							"Broad code searches bloat your context. Use `subagent` with `agent: scout` " +
							"for code exploration — it runs in an isolated process and returns compressed summaries.",
					};
				}
				if (base === "git" && sub === "grep") {
					return {
						block: true,
						reason:
							"__PI_BLOCKED__" +
							"Broad code searches bloat your context. Use `subagent` with `agent: scout` " +
							"for code exploration — it runs in an isolated process and returns compressed summaries.",
					};
				}

				// Block inline code execution engines (subagent bypass pattern)
				// Scan all args (not just sub) because flags can appear at any position:
				//   node --experimental-vm-modules -e "code", bun --inspect -e "code"
				//   deno --allow-all eval "code"
				// For npx: npx tsx -e or npx --yes tsx --eval (handled separately)

				const evalFlagPattern = INLINE_EVAL_FLAGS[base];
				if (evalFlagPattern) {
					const hasEval = firstCmd.slice(1).some(
						(t) => evalFlagPattern.test(t));
					if (hasEval) {
						return {
							block: true,
							reason:
								"__PI_BLOCKED__" +
								`Inline code execution via \`${base}\` is blocked to protect your context window. ` +
								"Direct inline scripts produce unbounded output that bloats your context.\n\n" +
								"Use `subagent` to delegate this task:\n" +
								"  - Code exploration \u2192 `agent: scout`\n" +
								"  - Code changes \u2192 `agent: worker`\n" +
								"  - Web research \u2192 `agent: researcher`",
						};
					}
				}

				// Special case: npx tsx -e (flags can be reordered, scan all args)
				if (base === "npx") {
					const tsxIdx = firstCmd.findIndex((t) => t === "tsx");
					if (tsxIdx >= 0) {
						const hasEvalFlag = firstCmd.slice(tsxIdx + 1).some((t) =>
							EVAL_FLAG_RE.test(t));
						if (hasEvalFlag) {
							return {
								block: true,
								reason:
									"__PI_BLOCKED__" +
									"Inline TypeScript execution via `npx tsx -e` is blocked to protect your context window. " +
									"Direct inline scripts produce unbounded output that bloats your context.\n\n" +
									"Use `subagent` to delegate this task:\n" +
									"  - Code exploration \u2192 `agent: scout`\n" +
									"  - Code changes \u2192 `agent: worker`\n" +
									"  - Web research \u2192 `agent: researcher`",
							};
						}
					}
				}
			}

			// Track read count per turn to prevent multi-file exploration without scout
			if (event.toolName === "read") {
				if (readCountThisTurn >= MAX_READS_PER_TURN) {
					const currentAgents = loadAllAgents();
					return {
						block: true,
						reason:
							"__PI_BLOCKED__" +
							`⚠️ READ LIMIT: ${readCountThisTurn}/${MAX_READS_PER_TURN} reads used this turn.\n\n` +
							"Continuing to read files directly risks context overflow:\n" +
							"  • Each raw file read consumes tokens that compound across turns\n" +
							"  • Context overflow causes truncated responses and missed work\n\n" +
							"Dispatch `agent: scout` for codebase exploration — it runs in an isolated " +
							"process, reads all relevant files, and returns compressed summaries.\n\n" +
							`Available agents: ${currentAgents.map((a) => a.name).join(", ")}`,
					};
				}
				readCountThisTurn++;
			}
		}
	});

}
