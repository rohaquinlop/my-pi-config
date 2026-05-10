# Project Memory

Persistent project-local context for Pi. Store only facts useful across many future sessions.

Project root: /Users/rhafid/.pi/agent

## Project Facts


- 2026-05-09: Added global Pi extension `extensions/skill-scout.ts`: detects repeated workflows, records skill opportunities via `skill_scout_record`, and provides `/skill-scout status|draft|approve|ignore|reset|help`. It writes draft skills under project `.pi/skill-scout-drafts/` (or `~/.pi/agent/skill-scout-drafts/`) and approved skills under project `.pi/skills/` (or `~/.pi/agent/skills/`).
- 2026-05-10: Agent-local uv Python project exists at `/Users/rhafid/.pi/agent` with `.venv`, `pyproject.toml`, and `uv.lock`. Current deps include `certifi`; Python helpers should run via `uv run --project /Users/rhafid/.pi/agent python ...`. Do not replace working JS/TS extension dependencies with uv/Python.


  - Why: Useful future context for managing the new Skill Scout extension.

## Decisions

- 2026-05-09: Project memory extension stores concise per-project durable context in MEMORY.md near AGENTS.md. It should not load full memory into model context by default; agent consults it with memory_read only when relevant.
  - Why: Preserve context window and avoid vague/noisy memory.

## Rationale / Why

## User Preferences


- 2026-05-10: Prefer `uv` only for Python workflows whenever available. Use `uv run`, `uv add/remove/sync/lock`, `uvx`, and `uv tool` before raw `python`, `pip`, `venv`, or global installs. Do not replace working JS/TypeScript/npm workflows with uv. See `/Users/rhafid/.pi/agent/UV.md` for command cheat sheet.

## Commands / Workflows


- 2026-05-09: Run /reload after changing Pi extensions.
  - Why: Needed after extension edits.

## Open Questions

## Change Log

- 2026-05-09: Created MEMORY.md.
