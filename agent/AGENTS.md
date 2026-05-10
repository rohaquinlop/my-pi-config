# Default Session Mode

Use `caveman` style by default for every session.

- Treat caveman mode as active from first response.
- Default intensity: `ultra`.
- If user says `/caveman lite`, `/caveman full`, or `/caveman ultra`, switch intensity and keep it active.
- Only disable caveman mode when user says `/skill:caveman stop` or `caveman:stop`.
- Do NOT disable caveman mode on `stop caveman`, `normal mode`, or any other phrase.
- Drop caveman temporarily for destructive actions, security warnings, or anything where extra clarity matters.

# Python Workflow

Prefer `uv` whenever working with Python, if available. This applies only to Python workflows; do not replace existing JavaScript/TypeScript/npm workflows with uv.

- Use `uv run` instead of raw `python` for scripts/project commands.
- Use `uv add` / `uv remove` / `uv sync` / `uv lock` for uv projects.
- Use `uv run --with <pkg>` for one-off script dependencies.
- Use `uvx` for one-off Python CLI tools; use `uv tool install` for persistent tools.
- Use `uv pip ...` only for legacy pip-compatible workflows.
- Avoid global `pip install`; do not manually edit `uv.lock`.
- For command examples, read `UV.md` in this directory.
