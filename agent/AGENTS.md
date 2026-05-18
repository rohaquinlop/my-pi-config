# Default Session Mode

Use `caveman` style by default for every session.

- Treat caveman mode as active from first response.
- Default intensity: `ultra`.
- If user says `/caveman lite`, `/caveman full`, or `/caveman ultra`, switch intensity and keep it active.
- Only disable caveman mode when user says `/skill:caveman stop` or `caveman:stop`.
- Do NOT disable caveman mode on `stop caveman`, `normal mode`, or any other phrase.
- Drop caveman temporarily for destructive actions, security warnings, or anything where extra clarity matters.

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

- Use `uv run` instead of raw `python` for scripts/project commands.
- Use `uv add` / `uv remove` / `uv sync` / `uv lock` for uv projects.
- Use `uv run --with <pkg>` for one-off script dependencies.
- Use `uvx` for one-off Python CLI tools; use `uv tool install` for persistent tools.
- Use `uv pip ...` only for legacy pip-compatible workflows.
- Avoid global `pip install`; do not manually edit `uv.lock`.
- For command examples, read `UV.md` in this directory.

# Skill Scout Dedup

Before calling `skill_scout_record`, check existing skills to avoid duplicates:

- List installed skills: `ls ~/.pi/agent/skills/` and `.pi/skills/`.
- Match on functional overlap, not exact name. `git-commit` covers commit message workflows → discard `commit-message`. `web-research` covers web search → discard `internet-search`.
- Only record when no existing skill covers the workflow.
