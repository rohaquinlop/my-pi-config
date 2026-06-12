# Pi Configuration

Personal configuration for [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), kept in Git so it can be shared across multiple machines.

This repository contains global Pi agent settings, instructions, extensions, skills, and prompt workflows.

## Contents

```text
~/.pi/
├── README.md                                 # This file
├── .gitignore                                # Ignored: sessions, node_modules, auth, MEMORY
│
└── agent/
    ├── settings.json                         # Default provider (DeepSeek), model, thinking level
    ├── AGENTS.md                             # Agent behavior instructions
    ├── APPEND_SYSTEM.md                      # Execution continuity guardrails
    ├── UV.md                                 # Python uv workflow guide
    │
    ├── extensions/                           # Loaded at Pi startup
    │   ├── compact-progress.ts               # Compaction progress bar widget
    │   ├── compact-tool-renderer.ts          # Ultra-compact tool call/result TUI rendering
    │   ├── working-words.ts                  # Real-time tool activity status display
    │   ├── plan-clarifier-ui.ts              # Interactive plan clarification TUI (↑↓/Space/Enter)
    │   ├── register-agents.ts                # Subagent discovery + tool restriction rules
    │   ├── agents/
    │   │   ├── planner.md                    # Planning subagent (scout → plan)
    │   │   └── reviewer.md                   # Code review subagent
    │   ├── web-research/                     # Web research tools (npm package)
    │   │   ├── index.ts                      # web_search, web_fetch, web_research
    │   │   └── package.json
    │   └── pdf-reader/                       # PDF extraction tool (npm package)
    │       ├── index.ts                      # read_pdf with page selection
    │       └── package.json
    │
    ├── skills/                               # Loaded on demand by intent
    │   ├── git-commit/          SKILL.md     # Conventional Commits workflow
    │   ├── plan-clarifier/      SKILL.md     # Plan clarification with multiple-choice UI
    │   └── pr-description/      SKILL.md     # PR description generation
    │
    ├── prompts/                              # Workflow templates (/prompt commands)
    │   ├── scout-and-plan.md                 # Scout → Planner chain (plan only)
    │   ├── implement.md                      # Scout → Planner → Worker chain
    │   └── implement-and-review.md           # Worker → Reviewer → Worker loop
    │
    └── git/                                  # Git-backed pi packages
        └── github.com/
            └── amosblomqvist/pi-subagents/   # Subagent runtime (scout, researcher, worker)
```

## Extensions

| Extension | Description |
|---|---|
| `compact-progress.ts` | Shows a live progress bar with time estimates during `/compact` or auto-compaction; supports Escape cancel. |
| `compact-tool-renderer.ts` | Overrides default `read`/`bash`/`edit`/`write`/`grep`/`ls`/`find` tool output with a single-line compact format, removing default box/padding for a cleaner TUI. |
| `working-words.ts` | Displays a real-time animated status line showing the current tool activity (e.g. "Reading file.ts", "Running npm test"). Controlled by `/working-words on\|off\|default`. |
| `plan-clarifier-ui.ts` | Registers the `clarification_ui` tool with ↑↓ keyboard navigation, Space/Enter selection, custom typed answers, dig-deeper follow-up, and leave-to-agent delegation. |
| `register-agents.ts` | Discovers subagent `.md` files from `agents/`, registers them via the pi-subagents bridge, and injects delegation guidelines + tool restrictions (blocks `grep`/`find`/bash-grep → redirects to `scout`) into the system prompt. |
| `agents/` | Subagent definitions in Markdown with frontmatter: `planner.md` (implementation planning), `reviewer.md` (code/plan review). Each declares tools, model, and subagent capabilities. |
| `web-research/` | npm package registering 3 tools: `web_search` (Brave Search / DuckDuckGo fallback), `web_fetch` (URL → Markdown via Readability), `web_research` (search + fetch top sources → research bundle). |
| `pdf-reader/` | npm package registering `read_pdf` tool — extracts text from PDFs with page selection, max-page limit, and truncation with temp-file fallback. |

## Skills

| Skill | Auto-loaded | Purpose |
|---|---|---|
| `git-commit` | When user asks to inspect, stage, split, or commit changes | Conventional Commits format with structured types/scopes, grouping guidelines, and execution rules. |
| `plan-clarifier` | When user says "clarify this plan" or pastes an unclear spec | Reviews implementation plans, detects missing context, asks targeted multiple-choice questions via `clarification_ui`. |
| `pr-description` | When user says "create a PR" or "summarize branch changes" | Generates PR description from `git diff main...HEAD`, writes `PR_DESCRIPTION.md` with title/what/why/changes sections. |

## Prompt Workflows

| Command | Pipeline | Output |
|---|---|---|
| `/prompt scout-and-plan <task>` | Scout → Planner | Implementation plan only (no code changes) |
| `/prompt implement <task>` | Scout → Planner → Worker | Full implementation from plan |
| `/prompt implement-and-review <task>` | Worker → Reviewer → Worker | Implemented + reviewed code with feedback applied |

Workflows use subagent chaining, passing output between steps via the `{previous}` placeholder.

## Settings

- **Provider**: DeepSeek (default)
- **Model**: `deepseek-v4-flash`
- **Thinking Level**: `xhigh`
- **Hidden Thinking**: enabled
- **Package**: `git:github.com/amosblomqvist/pi-subagents`

See `agent/settings.json` for the full configuration.

## Setup on a new machine

1. Install Pi Coding Agent:

   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```

2. Clone this repository as the Pi config directory:

   ```bash
   git clone <repo-url> ~/.pi
   ```

3. Install extension dependencies:

   ```bash
   cd ~/.pi/agent/extensions/web-research && npm install
   cd ~/.pi/agent/extensions/pdf-reader  && npm install
   ```

4. (Optional) Set up provider authentication in `agent/auth.json` (see `.gitignore` — this file is not committed).

5. Start or reload Pi:

   ```bash
   pi
   # or in Pi: /reload
   ```

## Important notes

- `agent/sessions/`, `agent/node_modules/`, `agent/auth.json`, `agent/MEMORY.md`, and `agent/skill-scout.json` are gitignored.
- Do **not** commit secrets or machine-specific credentials. Authentication tokens belong in `auth.json` (gitignored).
- After changing extensions, run `/reload` in Pi.
- After changing `AGENTS.md` or `APPEND_SYSTEM.md`, start a new session for changes to take effect.

## Commands

- `/effort [off|minimal|low|medium|high|xhigh|max|current]` — set/show reasoning effort (from compact-progress.ts).
- `/working-words [on|off|default]` — toggle real-time tool activity display.
- `/compact` — compact the conversation (with progress bar).
- `/reload` — reload extensions and configuration.
- `/prompt <workflow> <task>` — run a multi-step subagent workflow.

## Purpose

This repo is not a standalone application. It is a portable Pi Coding Agent configuration, meant to maintain consistent agent behavior, custom tooling, and workflow skills across every machine I work on.
