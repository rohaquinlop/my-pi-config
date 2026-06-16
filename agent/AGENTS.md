# Implementation Completeness

When implementing a requested change, do the full high-quality implementation the codebase needs, not only the narrow visible patch.

- If you discover that another improvement is necessary to make the requested implementation correct, robust, maintainable, or production-ready, implement that improvement too.
- Do NOT leave known-necessary work as a "note", "next polish", TODO, or follow-up suggestion when it is within the current task's natural scope.
- Do NOT ship a weaker first pass while explicitly knowing the better implementation is needed.
- Expand scope proactively for supporting refactors, resolver precision, tests, types, error handling, state modeling, imports, local-scope handling, and similar enabling work.
- Only defer work when it is genuinely unrelated, risky/destructive, requires a product decision, or would be disproportionately large. In that case, say clearly why it was not done.
- Prefer fewer, complete, well-designed changes over quick partial patches.

# Python Workflow

Prefer `uv` whenever working with Python, if available. This applies only to Python workflows; do not replace existing JavaScript/TypeScript/npm workflows with uv.

For detailed uv usage, read [`UV.md`](./UV.md) in this directory.

# GitHub CLI

`gh` (GitHub CLI) is available and authenticated for GitHub operations. The
worker subagent (the only agent with `safe_bash`) executes `gh` commands.

Common subcommands used in this project:
- `gh pr create` — create pull requests (see `create-pr` skill)
- `gh pr list` — list pull requests with `--json` for machine-readable output
- `gh pr view` — view/update pull requests
- `gh pr edit` — update PR title, body, or metadata
- `gh issue` — issue management
- `gh repo` — repository operations
- `gh api` — direct GitHub API access (useful for operations not covered by other subcommands)

When dispatching tasks involving GitHub operations, route to the worker
subagent and include `gh` CLI context in the task description.

For details, see the `create-pr` and `pr-description` skills.


# Project State

## Directory Structure

```
~/.pi/
├── README.md                                 # Full project documentation
├── .gitignore
└── agent/
    ├── AGENTS.md                             # This file — agent behavior instructions
    ├── APPEND_SYSTEM.md                      # Execution continuity guardrails (DONE/BLOCKED/FAILED)
    ├── UV.md                                 # Python uv workflow guide
    ├── settings.json                         # Default provider: nan, model: deepseek-v4-flash
    │
    ├── extensions/                           # Loaded at Pi startup
    │   ├── compact-progress.ts               # Compaction progress bar widget
    │   ├── compact-tool-renderer.ts          # Ultra-compact tool call/result TUI rendering
    │   ├── working-words.ts                  # Real-time tool activity status display
    │   ├── plan-clarifier-ui.ts              # Interactive plan clarification TUI
    │   ├── nan-builders.ts                   # NaN Builders custom provider
    │   ├── register-agents.ts                # Subagent discovery, pre-processor, auto-delegation
    │   ├── agents/
    │   │   ├── planner.md                    # Planning subagent
    │   │   ├── researcher.md                 # Web research subagent
    │   │   ├── reviewer.md                   # Code review subagent
    │   │   ├── scout.md                      # Codebase recon subagent
    │   │   └── worker.md                     # General-purpose worker subagent
    │   ├── web-research/                     # Web research tools (npm package)
    │   │   └── index.ts                      # web_search, web_fetch, web_research
    │   └── pdf-reader/                       # PDF extraction tool (npm package)
    │       └── index.ts                      # read_pdf
    │
    ├── skills/                               # Loaded on demand by intent
    │   ├── create-pr/           SKILL.md     # GitHub PR creation via gh CLI
    │   ├── git-commit/          SKILL.md     # Conventional Commits workflow
    │   ├── handoff/             SKILL.md     # Conversation compact & handoff
    │   ├── plan-clarifier/      SKILL.md     # Plan clarification with multiple-choice UI
    │   ├── pr-description/      SKILL.md     # PR description generation from git diff
    │
    └── git/                                  # Git-backed pi packages
        └── github.com/rohaquinlop/pi-subagents/  # Subagent runtime
```

## Subagent System

Five agents are available via the `subagent` tool. The MANDATORY SUBAGENT DELEGATION table at the top of the system prompt auto-generates from agent definitions:

| Agent | Purpose | Tool Access |
|---|---|---|
| `planner` | Creates implementation plans by scouting code and researching requirements | subagent, read, grep, find, ls; can delegate to scout, researcher |
| `reviewer` | Code and plan review for quality, security, correctness | subagent, read, grep, find, ls; can delegate to scout |
| `researcher` | Web research — searches the web and synthesizes findings | web_search, web_fetch |
| `scout` | Fast codebase recon — explores files, finds patterns, maps architecture | read, grep, find, ls |
| `worker` | General-purpose code reading, writing, and editing | read, write, edit, safe_bash, web_search, web_fetch, subagent |

Pre-processor auto-classifies user prompts against agent descriptions and injects routing directives. Agents are defined in both `extensions/agents/` (user-defined, takes precedence) and `git/.../pi-subagents/agents/` (built-in defaults).

### Agent Precedence

pi-subagents natively loads agents from two directories at startup:

1. **Built-in agents** from `pi-subagents/agents/` (scout, researcher, worker)
2. **User-defined agents** from `extensions/agents/` (scout, researcher, worker, planner, reviewer)

User agents with the same `name` override the corresponding built-in agent. User-only agents (planner, reviewer) are added to the registry. This applies to child subagent processes too — nested subagents use the same merged definitions, restricted by `PI_SUBAGENT_ALLOWED`.

## Extensions

- **compact-progress.ts** — Live progress bar with time estimates during `/compact`
- **compact-tool-renderer.ts** — Single-line compact tool output (read/bash/edit/write/grep/ls/find)
- **working-words.ts** — Real-time animated tool activity status
- **plan-clarifier-ui.ts** — `clarification_ui` tool with ↑↓/Space/Enter, custom answers, dig-deeper
- **nan-builders.ts** — NaN Builders custom provider with dynamic model fetching
- **register-agents.ts** — Generates auto-enforcement table, tool restrictions, and tool_call blocks (grep/find/web_search/bash-grep → redirect to scout). Bridge registration is a fallback for runtime-added agents; the primary override is native in pi-subagents.
- **web-research/** — 3 tools: web_search, web_fetch, web_research
- **pdf-reader/** — read_pdf tool with page selection

## Skills

- **create-pr** (loaded when user asks to create a PR) — GitHub PR creation via `gh pr create`, uses the pr-description skill
- **git-commit** (loaded when user asks to stage/commit) — Conventional Commits with structured types/scopes and grouping
- **handoff** (loaded when user asks to compact/handoff) — Conversation compaction and handoff document
- **plan-clarifier** (loaded on plan clarification intent) — Multiple-choice TUI, iteration, brief generation
- **pr-description** (loaded when asked for PR) — Generates PR description from `git diff main...HEAD`

## Execution Guardrails

`APPEND_SYSTEM.md` enforces DONE/BLOCKED/FAILED response contract during implementation tasks. Do not send progress-only status messages.

# Skill Scout Dedup

Before calling `skill_scout_record`, check existing skills to avoid duplicates:

- List installed skills: `ls ~/.pi/agent/skills/`
- Match on functional overlap, not exact name. `git-commit` covers commit message workflows → discard `commit-message`.
- Only record when no existing skill covers the workflow.
