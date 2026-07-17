---
name: init
description: >
  Scan a project and generate or update an AGENTS.md file with project conventions,
  tech stack, build/test/lint commands, structure, and coding style. Use when setting
  up a new project for AI agent assistance, or when the user asks to create, update,
  or regenerate an AGENTS.md or CLAUDE.md context file.
---

# Init

Scan the current project and generate (or update) an `AGENTS.md` file that gives
AI agents full context about the codebase.

## When to Use

- User says "init", "generate AGENTS.md", "set up agents", or "create context file"
- User asks to update an existing `AGENTS.md` or `CLAUDE.md`
- Starting work on an unfamiliar project and need structured context

## Workflow

### Phase 1 — Project Detection

Dispatch a `scout` subagent to scan for:

1. **Language & framework indicators**: `package.json`, `tsconfig.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `go.mod`, `pom.xml`, `build.gradle`, `Gemfile`, `composer.json`, `mix.exs`
2. **Framework configs**: `next.config.*`, `nuxt.config.*`, `vite.config.*`, `astro.config.*`, `svelte.config.*`, `tailwind.config.*`, `Django`, `Flask`, `FastAPI`, `Rails`, `Spring`, `Actix`, `Axum`
3. **Lockfiles** (determines package manager): `package-lock.json` (npm), `pnpm-lock.yaml` (pnpm), `yarn.lock` (yarn), `bun.lockb` (bun), `uv.lock` (uv), `Cargo.lock` (cargo), `go.sum` (go)
4. **Monorepo indicators**: `pnpm-workspace.yaml`, `lerna.json`, `turbo.json`, `nx.json`, workspaces in `package.json`

### Phase 2 — Command Detection

Extract build/test/lint commands from:

- `package.json` scripts — `build`, `test`, `lint`, `dev`, `start`, `format`, `check`, `typecheck`
- `Makefile` targets — list the main ones
- `pyproject.toml` `[tool]` sections — pytest, ruff, mypy, black, isort
- `Cargo.toml` — workspace members, build targets
- `go.mod` — module name
- CI configs — `.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile`
- Docker — `Dockerfile`, `docker-compose.yml`

### Phase 3 — Convention Detection

Check for:

- Linter configs: `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `prettier.config.*`, `ruff.toml`, `.flake8`, `.pylintrc`, `clippy.toml`, `.rubocop.yml`
- Editor config: `.editorconfig`, `.vscode/settings.json`
- Git hooks: `.husky/`, `.pre-commit-config.yaml`
- Commit conventions: `commitlint.config.*`, recent `git log --oneline -n 20`
- Contribution guides: `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`
- Existing context files: `CLAUDE.md`, `AGENTS.md`, `CODE_STYLE.md`

### Phase 4 — Structure Mapping

- List top-level directories and their purposes
- Identify key entry points (main files, index files, app files)
- Identify test directories and patterns
- Identify config vs source vs docs separation
- Limit to top 2-3 levels for large projects

### Phase 5 — Generate AGENTS.md

Read the existing `AGENTS.md` or `CLAUDE.md` if present. Then write `AGENTS.md` using this structure:

```markdown
# {Project Name}

> {One-line description from README or package.json}

## Tech Stack

- **Language:** {language + version}
- **Framework:** {framework}
- **Package Manager:** {pm}
- **Runtime:** {runtime if applicable}

## Project Structure

\`\`\`
{directory tree — top 2 levels, annotated}
\`\`\`

## Commands

### Setup
\`\`\`bash
{install command}
\`\`\`

### Development
\`\`\`bash
{dev/start command}
\`\`\`

### Build
\`\`\`bash
{build command}
\`\`\`

### Test
\`\`\`bash
{test command}
\`\`\`

### Lint & Format
\`\`\`bash
{lint command}
{format command}
\`\`\`

## Code Style

- {conventions detected from linter configs, editorconfig, etc.}
- {commit message format if detectable}
- {naming conventions if evident}

## Key Files

- `{path}` — {purpose}
- `{path}` — {purpose}

## Conventions

- {any CONTRIBUTING.md rules}
- {PR/branch naming if detectable}
- {testing patterns — where tests live, how they're structured}

## Anti-Patterns

- {things to avoid, from CONTRIBUTING.md or detected patterns}
```

### Phase 6 — Merge Strategy

When updating an existing `AGENTS.md`:

1. Read the existing file first
2. Preserve sections with custom content that the scan wouldn't detect
3. Update sections where fresh scan data is more accurate
4. Never overwrite project-specific custom rules
5. If user said "generate" without "update", ask whether to overwrite or merge

## Edge Cases

| Scenario | Action |
|----------|--------|
| No `AGENTS.md` exists | Generate from scratch |
| `CLAUDE.md` exists | Read it, generate `AGENTS.md`, note the existing file |
| Very large monorepo | Ask user to specify a subdirectory scope |
| Minimal project (no package.json, etc.) | Generate what's possible, mark missing sections as "Not detected" |
| User says "update" | Merge with existing, preserve custom sections |

## Output

The generated `AGENTS.md` should be 80-200 lines for a typical project. It must be:
- Immediately useful to any AI agent working on the project
- Self-contained — no external references needed to understand the project
- Actionable — commands should be copy-pasteable
