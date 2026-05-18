---
name: pr-description
description: >
    Pull request description format and writing rules for this project.
    MUST be loaded before creating or writing a PR description. Invoke whenever
    the user asks to create a PR, open a pull request, or summarize branch changes.
---

When writing a PR description:

1. Run `git diff main...HEAD` to see all changes on this branch
2. Write a description in a md file named `PR_DESCRIPTION.md` following this format:

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
