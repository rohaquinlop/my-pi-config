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
    │   │   └── reviewer.md                   # Code review subagent
    │   ├── web-research/                     # Web research tools (npm package)
    │   │   └── index.ts                      # web_search, web_fetch, web_research
    │   └── pdf-reader/                       # PDF extraction tool (npm package)
    │       └── index.ts                      # read_pdf
    │
    ├── skills/                               # Loaded on demand by intent
    │   ├── git-commit/          SKILL.md     # Conventional Commits workflow
    │   ├── plan-clarifier/      SKILL.md     # Plan clarification with multiple-choice UI
    │   └── pr-description/      SKILL.md     # PR description generation
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

Pre-processor auto-classifies user prompts against agent descriptions and injects routing directives. Agents from `extensions/agents/` and the `pi-subagents` package are all included.

## Extensions

- **compact-progress.ts** — Live progress bar with time estimates during `/compact`
- **compact-tool-renderer.ts** — Single-line compact tool output (read/bash/edit/write/grep/ls/find)
- **working-words.ts** — Real-time animated tool activity status
- **plan-clarifier-ui.ts** — `clarification_ui` tool with ↑↓/Space/Enter, custom answers, dig-deeper
- **nan-builders.ts** — NaN Builders custom provider with dynamic model fetching
- **register-agents.ts** — Agent discovery, pre-processor, auto-generated enforcement table, blocks grep/find/bash-grep → redirects to scout
- **web-research/** — 3 tools: web_search, web_fetch, web_research
- **pdf-reader/** — read_pdf tool with page selection

## Skills

- **git-commit** (loaded when user asks to stage/commit) — Conventional Commits with structured types/scopes and grouping
- **plan-clarifier** (loaded on plan clarification intent) — Multiple-choice TUI, iteration, brief generation
- **pr-description** (loaded when asked for PR) — Generates PR description from `git diff main...HEAD`

## Execution Guardrails

`APPEND_SYSTEM.md` enforces DONE/BLOCKED/FAILED response contract during implementation tasks. Do not send progress-only status messages.

# Skill Scout Dedup

Before calling `skill_scout_record`, check existing skills to avoid duplicates:

- List installed skills: `ls ~/.pi/agent/skills/`
- Match on functional overlap, not exact name. `git-commit` covers commit message workflows → discard `commit-message`.
- Only record when no existing skill covers the workflow.
