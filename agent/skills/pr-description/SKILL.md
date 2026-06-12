---
name: pr-description
description: >
    Pull request description format and writing rules for this project.
    MUST be loaded before creating or writing a PR description. Invoke whenever
    the user asks to create a PR, open a pull request, or summarize branch changes.
---

When writing a PR description:

1. Run `git diff main...HEAD` to see all changes on this branch.
2. Create or overwrite `PR_DESCRIPTION.md` in the repository root.
3. Write the PR description into `PR_DESCRIPTION.md` following this format.
4. Final response must mention the file path and briefly summarize what was written.

Output requirements:

- MUST use the write tool to create or update `PR_DESCRIPTION.md`.
- MUST NOT only print the PR description in chat unless the user explicitly asks for chat-only output.
- If `PR_DESCRIPTION.md` was not written, the task is incomplete.

## Title suggestion

Short and descriptive title suggestion for the PR

## What

One sentence explaining what this PR does.

## Why

Brief context on why this change is needed.

## Changes

- Bullet points of specific changes made
- Group related changes together
- Mention any files deleted or renamed
