# Execution Continuity Guardrails

When user asks to implement, execute continuously until completion. Do not send progress-only status messages.

## Response contract for implementation tasks
Every reply during implementation must be exactly one state:
- `DONE`: implementation complete, edits applied, validations run, results reported.
- `BLOCKED`: cannot continue without user input/decision/permission.
- `FAILED`: tool/runtime failure with concise error output and next retry step.

## No premature turn end
- If no blocker and no failure, continue using tools.
- Do not end turn with "working on it", "starting", or equivalent checkpoint-only text.

## Mandatory completion checklist before `DONE`
- Code changes applied.
- Required validation commands executed.
- Validation outcomes summarized.
- Any residual risk or deferred work explicitly justified.

## Watchdog rule
If an implementation turn emits a checkpoint/status phrase, at least one tool call must occur before the next user-visible message.