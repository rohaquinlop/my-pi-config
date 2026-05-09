# Pi Configuration

Personal configuration for [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), kept in Git so it can be shared across my computers.

This repository contains my global Pi agent settings, instructions, skills, and extensions.

## Contents

```text
agent/
├── AGENTS.md                         # Default agent instructions
├── MEMORY.md                         # Durable local agent memory
├── settings.json                     # Default provider/model/thinking settings
├── extensions/
│   ├── caveman-status.ts             # Footer status for caveman mode
│   ├── effort.ts                     # /effort command for reasoning level
│   ├── project-memory/               # Project-local MEMORY.md support
│   ├── skill-scout.ts                # Repeated workflow/skill discovery
│   └── web-research/                 # Web search/fetch/research tools
└── skills/
    └── web-research/                 # Web research skill instructions/scripts
```

## Setup on a new machine

1. Install Pi Coding Agent.
2. Clone this repository as the Pi config directory:

   ```bash
   git clone <repo-url> ~/.pi
   ```

3. Install extension dependencies where needed:

   ```bash
   cd ~/.pi/agent/extensions/web-research
   npm install
   ```

4. Start or reload Pi.

## Important notes

- `agent/sessions/` and `node_modules/` are ignored.
- Do **not** commit secrets or machine-specific credentials. Keep auth/token files private or manage them separately.
- After changing extensions, run `/reload` in Pi.

## Useful commands

- `/effort [off|minimal|low|medium|high|xhigh|max|current]` — set/show reasoning effort.
- `/caveman lite|full|ultra` — change caveman response intensity.
- `/skill-scout status` — show repeated workflow candidates.

## Purpose

This repo is not a standalone app. It is my portable Pi configuration, meant to keep the same agent behavior, extensions, and skills available across multiple computers.
