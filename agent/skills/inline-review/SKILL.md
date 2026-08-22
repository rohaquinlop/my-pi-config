---
name: inline-review
description: >
    Review a GitHub PR and post inline review comments using the gh extension
    `gh-inline-review-comments`. Generates a `pr-<N>-review-comments.md` file with
    ordered findings, then posts them as one review (comment / approve /
    request-changes). Invoke when the user asks to add inline review comments,
    review a PR with line comments, re-request changes, or regenerate/post a
    PR review-comments file.
---

# Inline PR Review

Two phases:

1. **Generate** `pr-<N>-review-comments.md` in the repository root with the findings.
2. **Post** the inline-anchorable comments as one review via the `gh inline-review-comments` extension.

Project-agnostic: never hardcode repo names or paths. Derive everything from the current checkout or user input.

## Prerequisites

- `gh` installed and authenticated.
- Extension installed: `gh extension install rohaquinlop/gh-inline-review-comments`.
  Verify with `gh extension list`. If missing, report and stop.

## Inputs

| Input | Source | Default |
|---|---|---|
| PR number | User request or `gh pr view --json number` | active branch's PR |
| Repo | `git remote get-url origin` | current checkout |
| Verdict | User phrasing | `comment` |

Verdict detection:

| Phrase | `--event` |
|---|---|
| "re-request changes", "request changes" | `request-changes` |
| "approve" | `approve` |
| anything else | `comment` |

## Phase 1 — Gather context

```bash
gh pr view <N> --json number,title,headRefOid,body   # title + head SHA for the header note
gh pr diff <N>                                        # the diff under review
```

Read files around candidate finding lines to confirm exact line numbers against the **PR head** (`headRefOid`). A comment line MUST be part of the PR diff, otherwise GitHub rejects it with 422. For deleted-line comments use `side: LEFT` (line numbers from the old file).

## Phase 2 — Write `pr-<N>-review-comments.md`

Create the file in the repository root. Exact pattern:

```markdown
# Review Comments — PR #<N> (<PR title>)

Line numbers refer to the PR head (`<head sha>`). Ordered by severity.
Comments 1–3 and 5 can be anchored inline on the diff; comment 4 must be
posted as a PR-level (general) comment because `<file>` is not in the diff.

---

## 1. <Short summary> (<severity>)

- filename: `<path>`
- line number: `<line>`
- comment: <Actionable explanation. Include concrete fix code in fenced
  blocks when useful. Reference existing patterns in the repo.>

---

## 2. ...
```

Rules:

- Order findings by severity: correctness/safety first, then missing tests/convention gaps, then minor nits.
- Each finding gets: filename, line number, full comment text.
- Comment text must be self-contained and actionable: what is wrong, why it matters, how to fix it.
- Findings on files NOT in the diff are marked "PR-level comment" and folded into the review body later.
- Do not delete the file after posting. Leave it for reference.

## Phase 3 — Post the review

Build a temp JSON array from every inline-anchorable finding. Schema:

```jsonc
[
  {
    "path": "src/foo.py",     // required
    "body": "<finding comment>", // required
    "line": 42,               // required; last line of range
    "side": "RIGHT",          // optional; LEFT for deleted lines
    "start_line": 40,         // optional; first line of multi-line range
    "start_side": "RIGHT"     // optional
  }
]
```

Then post ONE review with all comments batched (never one review per comment):

```bash
gh inline-review-comments create <N> \
  --input comments.json \
  --event <verdict> \
  --review-body "<PR-level findings only, see rules below>" \
  -R <owner/repo if outside checkout> \
  --json
```

### Review body rules (strict)

The review body is NOT a chat message. It carries ONLY findings that cannot be
anchored inline (file not in the diff). One bullet per finding, same content
style as the MD file: filename, line number, what is wrong, how to fix it.

FORBIDDEN in the review body:
- Praise, encouragement ("nice work", "great job").
- Status summaries of previous rounds or re-review narration ("Round-N status...").
- Commit SHAs, test-run reports, CI status, lint results.
- Verdict restatements ("all issues fixed", "still blocking").
- Greetings, sign-offs, meta commentary.

If every finding can be anchored inline, pass the minimum viable body required
by the extension: the PR title or "See inline comments." — nothing more.

Other flags:

- `--review-body` is REQUIRED for `comment` and `request-changes`; optional for `approve`.
- Prefer `--input -` piping from a here-doc over temp files.
- Use `--json`; report `id`, `state`, `html_url` from the output.

## Errors

| Symptom | Action |
|---|---|
| 422 "line must be part of the diff" | Fix path/line/side against `gh pr diff`; retry |
| Missing extension | Tell user to run `gh extension install rohaquinlop/gh-inline-review-comments` |
| Empty findings | Report no issues found; do not post an empty review |

## Completion report

End with: file path written, number of inline comments posted, verdict, review URL.
