---
name: create-pr
description: >
    Create a GitHub Pull Request with generated title/body from git diff.
    Supports optional target branch (defaults to main). Invoke when the user asks to create
    a PR, open a pull request, or submit changes via GitHub CLI.
---

# Create PR

Creates a GitHub Pull Request using `gh pr create`. Generates the PR title and body
from `git diff`, writes it to `PR_DESCRIPTION.md`, then submits.

## Usage

The user may specify a target branch. If omitted, default is `main`.

Examples:
- "Create a PR" → targets `main`
- "Create a PR for staging" → targets `staging`
- "Create a PR against release-v2" → targets `release-v2`

## PR Description Format

When generating the PR description:

1. Run `git diff <base>...HEAD` (where `<base>` is the target branch) to see all changes on this branch.
2. Create or overwrite `PR_DESCRIPTION.md` in the repository root.
3. Write the PR description into `PR_DESCRIPTION.md` following the format below.
4. Final response must mention the file path and briefly summarize what was written.

Output requirements:

- MUST use the write tool to create or update `PR_DESCRIPTION.md`.
- MUST NOT only print the PR description in chat unless the user explicitly asks for chat-only output.
- If `PR_DESCRIPTION.md` was not written, the task is incomplete.

### Title suggestion

Short and descriptive title suggestion for the PR

### What

One sentence explaining what this PR does.

### Why

Brief context on why this change is needed.

### Changes

- Bullet points of specific changes made
- Group related changes together
- Mention any files deleted or renamed

## Workflow

1. **Generate the PR description** following the format above — run `git diff <target-branch>...HEAD`, then create `PR_DESCRIPTION.md` with the title and body.
2. **Determine target branch**: if user specified a branch, use that; otherwise `main`.
3. **Read `PR_DESCRIPTION.md`** to extract the title (first line, stripped of `## Title suggestion` prefix) and body (everything after the title block).
4. **Create PR via `gh pr create`**:

   ```bash
   gh pr create \
     --base <target-branch> \
     --title "$TITLE" \
     --body "$BODY"
   ```

   - If on a fork, add `--repo <owner>/<repo>` inferred from `git remote get-url origin`.
   - If the branch has no remote, prompt to push first with `git push -u origin HEAD`.
   - If `gh` is not authenticated, report error and stop.

5. **Report result**: output the PR URL and a summary. Do NOT delete `PR_DESCRIPTION.md` — leave it for reference.

## Edge Cases

| Scenario | Action |
|----------|--------|
| No commits on branch vs base | Warn user: no diff to create PR from |
| Branch already has open PR | Detect with `gh pr list --head "$BRANCH"`; reuse or abort |
| Unpushed branch | Offer to push before creating PR |
| `gh` not installed | Report error, suggest `brew install gh` |
| `gh` not authenticated | Report error, suggest `gh auth login` |

## Parameter Detection

Parse the user's request for a target branch:

| Phrase | Branch |
|--------|--------|
| "for X" | X |
| "against X" | X |
| "into X" | X |
| "to X" | X |
| "base X" | X |
| No branch mention | `main` |
