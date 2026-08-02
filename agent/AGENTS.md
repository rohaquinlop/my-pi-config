# Pi Agent System

> **What lives where:** the delegation guidance, the agent roster, intent routing,
> and tool-selection advice are generated at startup by `register-agents.ts` from
> the agent `.md` files and injected at the top of the system prompt. They are
> deliberately **not** duplicated here — a second copy in different words is just
> a second thing to keep in sync, and conflicting phrasings are worse than none.
> To change an agent's model, tools, or connector, edit its `.md` file in
> `extensions/agents/`. This file covers only what the generated block doesn't.

## Agent Precedence

Agent definitions are merged at startup by `@rohaquinlop/pi-subagents`:

1. **Built-in agents** from the package's own `agents/` directory — `scout`, `researcher`, `worker`
2. **User-defined agents** from `extensions/agents/` — `planner`, `reviewer`, and overrides of all three built-ins

User agents with the same `name` replace the built-in. This applies to nested
subagent processes too, restricted by `PI_SUBAGENT_ALLOWED`.

The package owns all agent parsing. `register-agents.ts` only reads these files
to describe them in the prompt — it does not register them.

### Model selection

An agent's `model:` may be a concrete spec, `inherit` (the session's current
model, following `/model` switches), or `$tier` resolved from `modelTiers` in
[`pi-subagents.config.json`](./pi-subagents.config.json).

All five agents use tiers, so no agent file names a provider:

| Tier | Resolves to | Used by |
|---|---|---|
| `$deep` | `inherit` — the session model | `planner`, `reviewer`, `worker` |
| `$fast` | a cheaper model for recon | `scout`, `researcher` |

Switching providers means editing `$fast` in that one file; `$deep` needs no edit
at all because it follows whatever `/model` selects. Requires pi-subagents ≥ 0.6.1,
which reads config from `~/.pi/agent/` rather than from inside `node_modules`.

## Chaining Agents

Beyond one-shot `subagent` dispatch, two tools compose agents:

| Situation | Tool |
|---|---|
| Multi-step sequential work (scout → plan → implement → review) | `pipeline` |
| Iterative refinement with quality gating (draft → review → polish) | `loop` |

`pipeline` chains agents with automatic context passing via `{previous}`, framed
by each agent's `connector` template. `loop` re-runs one agent with accumulated
prior outputs and can stop early once a `judge` agent is satisfied.

Both are worth reaching for only when the work is large enough to justify several
spawns — see the delegation guidance in the system prompt for where that line sits.

## Extension Tools

Beyond pi's built-ins, the extensions in `extensions/` add:

- `ffgrep`, `fffind`, `fff-multi-grep` — frecency-ranked, typo-tolerant search
- `gh_cli` — allowlisted `gh` subcommands with JSON parsing
- `web_search`, `web_fetch`, `web_research`
- `read_pdf` — PDF text extraction with page selection
- `clarification_ui` — interactive multiple-choice plan clarification

`register-agents.ts` defines no tools and blocks nothing; it only injects guidance.
The rest (`deepseek-cache`, `compact-progress`, `compact-tool-renderer`,
`working-words`, `herdr-agent-state`) affect the TUI or telemetry only.
`herdr-agent-state.ts` is vendor-managed — don't edit it.

The repository layout is documented in [`../README.md`](../README.md).

## Available Skills

Skills load on-demand when a task matches their description. Use `read` to load a
skill's `SKILL.md` for full instructions. Resolve relative paths in skill files
against the skill directory.

| Skill | Purpose |
|---|---|
| `create-pr` | GitHub PR creation with generated title/body from `git diff` |
| `git-commit` | Conventional Commits workflow — load before any `git commit` |
| `hallmark` | Anti-AI-slop design for pages, audits, redesigns |
| `handoff` | Compact conversation into a handoff document for another agent |
| `init` | Scan a project and generate or update its `AGENTS.md` |
| `plan-clarifier` | Interactive plan clarification with multiple-choice UI |
| `release-notes` | Generate release notes and publish via `gh release create` |

Skills are unavailable inside subagents — pi-subagents spawns children with
`--no-skills`. Anything skill-driven has to happen in the main agent.

## Agent Conventions

### Implementation Completeness

When implementing a requested change, do the full high-quality implementation the codebase needs, not only the narrow visible patch.

- If you discover that another improvement is necessary to make the requested implementation correct, robust, maintainable, or production-ready, implement that improvement too.
- Do NOT leave known-necessary work as a "note", "next polish", TODO, or follow-up suggestion when it is within the current task's natural scope.
- Do NOT ship a weaker first pass while explicitly knowing the better implementation is needed.
- Expand scope proactively for supporting refactors, resolver precision, tests, types, error handling, state modeling, imports, local-scope handling, and similar enabling work.
- Only defer work when it is genuinely unrelated, risky/destructive, requires a product decision, or would be disproportionately large. In that case, say clearly why it was not done.
- Prefer fewer, complete, well-designed changes over quick partial patches.

### Committing changes

Only commit changes when asked for, never do it by your own if there's no explicit instruction by the user or skill mention.

### Execution Continuity

See [`APPEND_SYSTEM.md`](./APPEND_SYSTEM.md) for the DONE/BLOCKED/FAILED response contract and continuation rules.

### Python Workflow

Prefer `uv` whenever working with Python, if available. See [`UV.md`](./UV.md) for the full command reference.

### GitHub CLI

`gh` is available and authenticated. Prefer the `gh_cli` tool over raw `gh` in bash —
it validates against an allowlist and parses JSON. The `worker` subagent is the only
agent with `safe_bash`, so route shell-driven GitHub work there.

Common subcommands: `gh pr create|list|view|edit`, `gh issue`, `gh repo`, `gh api`.

### Skill Dedup

Before recording a new skill, check existing skills to avoid duplicates:

- List installed skills: `ls ~/.pi/agent/skills/`
- Match on functional overlap, not exact name. `git-commit` covers commit workflows → discard `commit-message`.
- Only record when no existing skill covers the workflow.
