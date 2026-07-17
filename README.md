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
    ├── settings.json                         # Default provider (NaN Builders), model, thinking level
    ├── AGENTS.md                             # Agent behavior instructions
    ├── APPEND_SYSTEM.md                      # Execution continuity guardrails
    ├── UV.md                                 # Python uv workflow guide
    │
    ├── extensions/                           # Loaded at Pi startup
    │   ├── compact-progress.ts               # Compaction progress bar widget
    │   ├── compact-tool-renderer.ts          # Ultra-compact tool call/result TUI rendering
    │   ├── working-words.ts                  # Real-time tool activity status display
    │   ├── plan-clarifier-ui.ts              # Interactive plan clarification TUI (↑↓/Space/Enter)
    │   ├── nan-builders.ts                   # NaN Builders custom provider (OpenAI-compatible API)
    │   ├── register-agents.ts                # Subagent discovery, pre-processor, auto-delegation
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
    │   ├── create-pr/            SKILL.md     # PR creation with generated title/body
    │   ├── git-commit/          SKILL.md     # Conventional Commits workflow
    │   ├── handoff/             SKILL.md     # Compact conversation into handoff document
    │   ├── init/                SKILL.md     # Scan project and generate AGENTS.md
    │   ├── plan-clarifier/      SKILL.md     # Plan clarification with multiple-choice UI
    │   └── release-notes/       SKILL.md     # Generate release notes via gh release
    │
    └── git/                                  # Git-backed pi packages
        └── github.com/
            └── rohaquinlop/pi-subagents/     # Subagent runtime (scout, researcher, worker)
```

## Extensions

| Extension | Description |
|---|---|
| `compact-progress.ts` | Shows a live progress bar with time estimates during `/compact` or auto-compaction; supports Escape cancel. |
| `compact-tool-renderer.ts` | Overrides default `read`/`bash`/`edit`/`write`/`grep`/`ls`/`find` tool output with a single-line compact format, removing default box/padding for a cleaner TUI. |
| `working-words.ts` | Displays a real-time animated status line showing the current tool activity (e.g. "Reading file.ts", "Running npm test"). Controlled by `/working-words on\|off\|default`. |
| `plan-clarifier-ui.ts` | Registers the `clarification_ui` tool with ↑↓ keyboard navigation, Space/Enter selection, custom typed answers, dig-deeper follow-up, and leave-to-agent delegation. |
| `nan-builders.ts` | Registers the **nan** provider (NaN.builders) via `pi.registerProvider()`. Uses OpenAI-compatible Chat Completions API with dynamic model fetching and fallback to known model capabilities (deepseek-v4-flash, mimo-v2.5, qwen3.6, gemma4). Configured API key via `/login` or `$NAN_BUILDERS_API_KEY` env var. |
| `register-agents.ts` | Three-in-one subagent management: **(1)** Discovers agent `.md` files from `agents/` and registers them via the pi-subagents bridge. **(2)** Pre-processor hook that classifies user prompts against agent descriptions using keyword scoring and injects routing directives to guide the LLM toward the right subagent before it responds. Supports parallel routing — a query like "implement and review" returns `[planner, reviewer]` with suggested chain order. **(3)** Generates a dynamic enforcement table at the TOP of the system prompt (MANDATORY SUBAGENT DELEGATION) — all rules auto-derived from agent frontmatter, no hardcoded cases. Also blocks `grep`/`find`/bash-grep and redirects to `scout`. |
| `agents/` | Subagent definitions in Markdown with YAML frontmatter: `planner.md` (implementation planning), `reviewer.md` (code/plan review). Each declares tools, model, and subagent capabilities. New agent files are automatically registered and appear in the enforcement table / classification — zero code changes. |
| `web-research/` | npm package registering 3 tools: `web_search` (Brave Search / DuckDuckGo fallback), `web_fetch` (URL → Markdown via Readability), `web_research` (search + fetch top sources → research bundle). |
| `pdf-reader/` | npm package registering `read_pdf` tool — extracts text from PDFs with page selection, max-page limit, and truncation with temp-file fallback. |

### Subagent Architecture

The subagent system combines agents from two sources:

| Source | Agents | Location |
|---|---|---|
| **pi-subagents package** (runtime) | `scout`, `researcher`, `worker` | `git/github.com/rohaquinlop/pi-subagents/agents/` |
| **Custom** (this repo) | `planner`, `reviewer` | `extensions/agents/` |

All 5 agents appear in the auto-generated enforcement table and intent classification. Adding a new `.md` file to `extensions/agents/` automatically:
1. Registers it with the pi-subagents bridge
2. Adds it to the MANDATORY SUBAGENT DELEGATION table in the system prompt
3. Adds it to the pre-processor's intent classification (keyword matching from description)
4. Makes it available via the `subagent` tool — no code changes

The pre-processor classifies every user prompt before the main LLM responds. Classification uses keyword scoring against each agent's name and description, plus task-specific heuristics. When multiple agents match (e.g. "implement and review" → `[reviewer, planner]`), the routing directive lists them in priority order (scout → researcher → planner → worker → reviewer) and tells the LLM to dispatch dependent agents in sequence and independent ones in parallel.

## Skills

| Skill | Auto-loaded | Purpose |
|---|---|---|
| `create-pr` | When user says "create a PR" or "summarize branch changes" | Creates a GitHub PR with title/body generated from `git diff <base>...HEAD`, writes `PR_DESCRIPTION.md` with title/what/why/changes sections. |
| `git-commit` | When user asks to inspect, stage, split, or commit changes | Conventional Commits format with structured types/scopes, grouping guidelines, and execution rules. |
| `handoff` | When user says "handoff" or needs to pass context to another agent | Compacts conversation into a structured handoff document with summary, decisions, and remaining tasks. |
| `init` | When user says "init", "generate AGENTS.md", or "set up agents" | Scans the project to generate or update an `AGENTS.md` with tech stack, commands, conventions, and structure. |
| `plan-clarifier` | When user says "clarify this plan" or pastes an unclear spec | Reviews implementation plans, detects missing context, asks targeted multiple-choice questions via `clarification_ui`. |
| `release-notes` | When user says "release notes" or "create a release" | Generates release notes from merged PRs and publishes via `gh release create`. |

## Setup on a new machine

1. Install Pi Coding Agent:

   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```

2. Clone this repository as the Pi config directory:

   ```bash
   git clone <repo-url> ~/.pi
   ```

3. Run the setup script (installs dependencies for every tracked package —
   root `agent/`, and each extension subpackage like `fff/`, `web-research/`,
   `pdf-reader/`, `gh-cli/`):

   ```bash
   cd ~/.pi && ./bootstrap.sh
   ```

4. Set up provider authentication via `/login`:

   ```bash
   # In pi: /login → "Use an API key" → "NaN Builders" → paste your key
   # Or set the environment variable:
   export NAN_BUILDERS_API_KEY="sk-your-key-here"
   ```

5. Start or reload Pi:

   ```bash
   pi
   # or in Pi: /reload
   ```

## Important notes

- `agent/sessions/`, `agent/node_modules/`, `agent/auth.json`, `agent/MEMORY.md`, `agent/trust.json`, and `agent/skill-scout.json` are gitignored (per-machine state/secrets).
- `agent/settings.json` **is** tracked — it holds no secrets, just provider/model/theme config.
- Do **not** commit secrets or machine-specific credentials. Authentication tokens belong in `auth.json` (gitignored).
- After changing extensions, run `/reload` in Pi.
- After changing `AGENTS.md` or `APPEND_SYSTEM.md`, start a new session for changes to take effect.

## Commands

- `/effort [off|minimal|low|medium|high|xhigh|max|current]` — set/show reasoning effort (from compact-progress.ts).
- `/working-words [on|off|default]` — toggle real-time tool activity display.
- `/compact` — compact the conversation (with progress bar).
- `/reload` — reload extensions and configuration.

## Purpose

This repo is not a standalone application. It is a portable Pi Coding Agent configuration, meant to maintain consistent agent behavior, custom tooling, and workflow skills across every machine I work on.