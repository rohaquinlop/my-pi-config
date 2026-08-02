# Pi Configuration

Personal configuration for [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), kept in Git so it can be shared across multiple machines.

This repository contains global Pi agent settings, instructions, extensions, skills, and prompt workflows.

## Contents

```text
~/.pi/
├── README.md                                 # This file
├── .gitignore                                # Ignored: sessions, node_modules, auth, MEMORY
│
├── bootstrap.sh                              # Fresh-machine setup
│
└── agent/
    ├── settings.template.json                # Tracked, portable settings (no provider/model pinned)
    ├── settings.json                         # Per-machine, gitignored; seeded by bootstrap.sh
    ├── pi-subagents.config.json              # Subagent model tiers ($fast / $deep)
    ├── AGENTS.md                             # Agent behavior instructions
    ├── APPEND_SYSTEM.md                      # Execution continuity guardrails
    ├── UV.md                                 # Python uv workflow guide
    │
    ├── extensions/                           # Loaded at Pi startup
    │   ├── compact-progress.ts               # Compaction progress bar widget
    │   ├── compact-tool-renderer.ts          # Ultra-compact tool call/result TUI rendering
    │   ├── working-words.ts                  # Real-time tool activity status display
    │   ├── plan-clarifier-ui.ts              # Interactive plan clarification TUI (↑↓/Space/Enter)
    │   ├── herdr-agent-state.ts              # Vendor-managed herdr integration (do not edit)
    │   ├── register-agents.ts                # Injects subagent delegation guidance
    │   ├── agents/                           # Agent definitions (override pi-subagents built-ins)
    │   │   ├── planner.md                    # Implementation planning
    │   │   ├── reviewer.md                   # Code and plan review
    │   │   ├── researcher.md                 # Web research
    │   │   ├── scout.md                      # Codebase recon
    │   │   └── worker.md                     # General-purpose implementation
    │   ├── fff/                              # ffgrep, fffind, fff-multi-grep (npm package)
    │   ├── gh-cli/                           # gh_cli tool (npm package)
    │   ├── web-research/                     # web_search, web_fetch, web_research (npm package)
    │   ├── pdf-reader/                       # read_pdf with page selection (npm package)
    │   └── deepseek-cache/                   # Cache telemetry written by pi-deepseek-cache (gitignored)
    │
    ├── skills/                               # Loaded on demand by intent
    │   ├── create-pr/           SKILL.md     # PR creation with generated title/body
    │   ├── git-commit/          SKILL.md     # Conventional Commits workflow
    │   ├── hallmark/            SKILL.md     # Anti-AI-slop design guidance
    │   ├── handoff/             SKILL.md     # Compact conversation into handoff document
    │   ├── init/                SKILL.md     # Scan project and generate AGENTS.md
    │   ├── plan-clarifier/      SKILL.md     # Plan clarification with multiple-choice UI
    │   └── release-notes/       SKILL.md     # Generate release notes via gh release
    │
    ├── npm/                                  # npm-installed pi packages (gitignored)
    └── git/                                  # Git-backed pi packages
```

## Extensions

| Extension | Description |
|---|---|
| `compact-progress.ts` | Shows a live progress bar with time estimates during `/compact` or auto-compaction; supports Escape cancel. |
| `compact-tool-renderer.ts` | Overrides default `read`/`bash`/`edit`/`write`/`grep`/`ls`/`find` tool output with a single-line compact format, removing default box/padding for a cleaner TUI. |
| `working-words.ts` | Displays a real-time animated status line showing the current tool activity (e.g. "Reading file.ts", "Running npm test"). Controlled by `/working-words on\|off\|default`. |
| `plan-clarifier-ui.ts` | Registers the `clarification_ui` tool with ↑↓ keyboard navigation, Space/Enter selection, custom typed answers, dig-deeper follow-up, and leave-to-agent delegation. |
| `herdr-agent-state.ts` | Vendor-managed integration that reports agent state (working/blocked/idle) to herdr over a unix socket. Overwritten on herdr reinstall — don't edit. |
| `register-agents.ts` | Generates subagent delegation guidance and injects it at the top of the system prompt: when delegation pays for itself, which patterns are worth a spawn, intent → agent routing, and tool-selection advice. All derived from the agent `.md` frontmatter. It registers nothing and blocks nothing — pi-subagents owns agent parsing and registration. Also emits an advisory routing hint via the message channel when a prompt clearly matches an agent and hasn't bounded its own scope. |
| `agents/` | Agent definitions in Markdown with YAML frontmatter, read by pi-subagents from its `USER_AGENTS_DIR`. Files here override the package's built-ins by name. Each declares tools, model, thinking level, connector, and spawn permissions. |
| `fff/` | npm package registering `ffgrep`, `fffind`, and `fff-multi-grep` — frecency-ranked, typo-tolerant search. |
| `gh-cli/` | npm package registering `gh_cli` — allowlisted `gh` subcommands with JSON parsing and field extraction. |
| `web-research/` | npm package registering 3 tools: `web_search` (Brave Search / DuckDuckGo fallback), `web_fetch` (URL → Markdown via Readability), `web_research` (search + fetch top sources → research bundle). |
| `pdf-reader/` | npm package registering `read_pdf` tool — extracts text from PDFs with page selection, max-page limit, and truncation with temp-file fallback. |

### Subagent Architecture

Agents come from two directories, merged by `@rohaquinlop/pi-subagents` at startup:

| Source | Agents | Location |
|---|---|---|
| **Package built-ins** | `scout`, `researcher`, `worker` | `npm/node_modules/@rohaquinlop/pi-subagents/agents/` |
| **This repo** | `planner`, `reviewer`, plus overrides of all three built-ins | `extensions/agents/` |

A user file replaces the built-in of the same name. Dropping a new `.md` into
`extensions/agents/` makes it available to the `subagent` tool and adds it to the
generated guidance — no code changes in either place.

Models are chosen by tier rather than pinned per agent. `pi-subagents.config.json`
maps `$fast` and `$deep` to concrete models; `$deep` resolves to `inherit`, which
follows whatever `/model` selects. Switching providers is a one-line edit there.

Delegation is advisory, not enforced. Direct tools are the default; a subagent is
worth its spawn cost only when it absorbs high-volume output the main agent would
otherwise carry — an unbounded search, an unfamiliar dependency chain. Nothing is
blocked, and the routing hint explicitly defers to doing small work directly.

## Skills

| Skill | Auto-loaded | Purpose |
|---|---|---|
| `create-pr` | When user says "create a PR" or "summarize branch changes" | Creates a GitHub PR with title/body generated from `git diff <base>...HEAD`, writes `PR_DESCRIPTION.md` with title/what/why/changes sections. |
| `git-commit` | When user asks to inspect, stage, split, or commit changes | Conventional Commits format with structured types/scopes, grouping guidelines, and execution rules. |
| `hallmark` | When user asks to build or redesign a page, or invokes it by name | Anti-AI-slop design guidance — genres, macrostructures, component cookbook, and an audit/redesign workflow. |
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

3. Run the setup script. It seeds `agent/settings.json` from the tracked
   template, installs dependencies for every tracked package (root `agent/`
   and each extension subpackage — `fff/`, `web-research/`, `pdf-reader/`,
   `gh-cli/`), and runs `pi install` for each pi package in the template:

   ```bash
   cd ~/.pi && ./bootstrap.sh
   ```

4. Set up provider authentication and pick a model:

   ```bash
   # In pi: /login → "Use an API key" → select your provider → paste your key
   # Then: /model → pick a default model
   ```

   No provider or model is pinned in the tracked config — the harness is
   provider-neutral by design.

5. Start or reload Pi:

   ```bash
   pi
   # or in Pi: /reload
   ```

## Important notes

- `agent/sessions/`, `agent/node_modules/`, `agent/auth.json`, `agent/MEMORY.md`, `agent/trust.json`, `agent/models-store.json`, and `agent/skill-scout.json` are gitignored (per-machine state/secrets).
- `agent/settings.json` is **not** tracked — it accumulates per-machine provider/model state. The tracked file is `agent/settings.template.json`, which holds only the portable subset (theme, thinking level, `packages`, retry policy) and deliberately pins **no** provider or model. `bootstrap.sh` copies it to `settings.json` on a fresh clone; pick a provider with `/login` and a model with `/model`.
- pi does **not** auto-install the packages named in `settings.json` — it only resolves them from disk. `bootstrap.sh` runs `pi install` for each one; without that step the subagent runtime is missing and every `subagent` dispatch fails.
- `agent/pi-subagents.config.json` **is** tracked — it holds the model tiers and no secrets. It lives here rather than in the package's own `config.json` because that path is inside `node_modules` and gets replaced on every update (requires pi-subagents ≥ 0.6.1).
- Each extension subpackage (`fff/`, `gh-cli/`, `web-research/`, `pdf-reader/`) owns its dependencies and its `package-lock.json`. There is deliberately no root `agent/package.json` — it previously duplicated every subpackage dependency while `agent/node_modules` didn't even exist.
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