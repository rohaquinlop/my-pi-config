# uv Python Workflow

Use `uv` for Python work whenever possible. Source: https://docs.astral.sh/uv/guides/

## Agent rule

- Prefer `uv` over raw `python`, `pip`, `venv`, `pipx`, or ad-hoc global installs for Python work only.
- Use raw `python` / `pip` only when `uv` is unavailable or a project explicitly requires another Python workflow.
- Do not replace working JavaScript/TypeScript/npm extension dependencies with uv/Python.
- Do not install packages globally with `pip`; use `uv add`, `uv run --with`, `uvx`, or `uv tool`.
- Keep `uv.lock` committed for uv projects.
- Do not manually edit `uv.lock`.

## Install / update

```bash
# macOS Homebrew
brew install uv

# standalone installer, macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# update standalone install
uv self update

# check
uv --version
```

Docs: https://docs.astral.sh/uv/getting-started/installation/

## Projects

```bash
# create project
uv init my-project
cd my-project

# init current dir
uv init

# run project script/command
uv run main.py
uv run pytest
uv run -- ruff check .

# sync environment from lockfile/project
uv sync

# add/remove deps
uv add requests
uv add 'requests==2.31.0'
uv add -r requirements.txt -c constraints.txt
uv remove requests

# upgrade one package in lockfile
uv lock --upgrade-package requests

# inspect deps
uv tree

# build package
uv build
```

Project files:

- `pyproject.toml`: project metadata, deps, optional `[tool.uv]` config.
- `.python-version`: default Python version for env creation.
- `.venv/`: local project env, created by uv.
- `uv.lock`: exact cross-platform lockfile, commit it.

Docs: https://docs.astral.sh/uv/guides/projects/

## Scripts

```bash
# run script, no manual venv needed
uv run script.py

# pass args
uv run script.py arg1 arg2

# run stdin
printf 'print("hi")' | uv run -

# avoid installing current project when in a pyproject dir
uv run --no-project script.py

# run with temp deps for one invocation
uv run --with rich script.py
uv run --with 'rich>12,<13' script.py

# choose Python version
uv run --python 3.12 script.py

# create script with inline metadata
uv init --script script.py --python 3.12

# add inline script deps
uv add --script script.py requests rich

# lock script deps, creates script.py.lock
uv lock --script script.py
```

Executable script shebang:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
import httpx
print(httpx.get("https://example.com"))
```

Docs: https://docs.astral.sh/uv/guides/scripts/

## Tools

Use `uvx` for one-off Python CLI tools; use `uv tool install` for persistent tools.

```bash
# one-off tool run
uvx ruff check .
uvx pycowsay hello

# command name differs from package name
uvx --from httpie http --help

# specific version / latest
uvx ruff@latest check .
uvx --from 'ruff==0.3.0' ruff check .

# tool with plugin/dependency
uvx --with mkdocs-material mkdocs --help

# install persistent tool
uv tool install ruff
uv tool install httpie

# upgrade tools
uv tool upgrade ruff
uv tool upgrade --all

# ensure tool bin dir is on PATH
uv tool update-shell
```

Use `uv run` instead of `uvx` for tools that must see project deps or import the project, e.g. `pytest`, `mypy`, project-local CLIs.

Docs: https://docs.astral.sh/uv/guides/tools/

## Python versions

```bash
# install Python via uv
uv python install 3.12

# list installed/available Pythons
uv python list

# pin project Python
uv python pin 3.12

# run with requested Python
uv run --python 3.12 main.py
```

Docs: https://docs.astral.sh/uv/guides/install-python/

## pip-compatible fallback

Use only for existing pip-style workflows or migration:

```bash
uv venv
uv pip install -r requirements.txt
uv pip install requests
uv pip freeze
uv pip compile requirements.in -o requirements.txt
```

Prefer native uv project commands (`uv add`, `uv sync`, `uv lock`, `uv run`) for new work.

Docs: https://docs.astral.sh/uv/pip/

## Quick decision table

| Need                        | Use                             |
| --------------------------- | ------------------------------- |
| Run project command         | `uv run <cmd>`                  |
| Run Python script           | `uv run script.py`              |
| One-off script dependency   | `uv run --with <pkg> script.py` |
| Add project dependency      | `uv add <pkg>`                  |
| Remove project dependency   | `uv remove <pkg>`               |
| Sync env                    | `uv sync`                       |
| Run one-off CLI tool        | `uvx <tool>`                    |
| Install persistent CLI tool | `uv tool install <tool>`        |
| Create project              | `uv init [dir]`                 |
| Create venv for legacy flow | `uv venv`                       |
| pip-compatible install      | `uv pip install ...`            |
