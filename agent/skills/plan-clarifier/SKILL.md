---
name: plan-clarifier
description: Reviews an existing implementation plan from an MD file, pasted text, issue, comment, or rough idea; detects missing context; asks targeted multiple-choice clarification questions with recommended answers first; supports custom authored answers, dig-deeper follow-ups, and delegation when the user says to decide. Use before implementing unclear features, refactors, migrations, or tasks needing better context.
---

# Plan Clarifier

Use this skill to turn an incomplete plan into enough context for safe implementation.

## Goals

- Review a plan from:
  - Markdown file path
  - pasted plan text
  - issue/comment/task description
  - rough user idea
- Identify ambiguity, missing constraints, risk, dependencies, and acceptance criteria.
- Ask only useful clarification questions.
- Provide answer options with the recommended option first.
- Let the user select one or many options, author a custom answer, ask to dig deeper, or delegate the choice to the agent.
- Iterate until the plan has enough context, then produce an implementation-ready brief.

## Triggers

Use when the user says things like:

- `/skill:plan-clarifier <plan.md>`
- `review this plan and ask me questions`
- `clarify this plan before implementation`
- `help build context for this task`
- `ask me what you need before coding`
- `here is a plan, what is missing?`

## Interactive UI

When the `clarification_ui` tool is available, use it instead of printing all choices in plain text.

Use batch mode: generate the clarification questions first, then open the picker once with the full question set. Do not use streaming/background question generation because it causes an extra model call and increases token usage.

`clarification_ui` behavior:

- Shows one question/screen at a time.
- User moves with ↑/↓.
- User toggles/selects with Space.
- User advances with Enter.
- User can go back with ←.
- Recommended option must be first when possible and marked `recommended: true` so it starts selected.
- Include options for custom authored answer, dig deeper, and leave-to-agent unless inappropriate.

If `clarification_ui` is unavailable, fall back to the plain Markdown question format below.

## Workflow

### 1. Load and summarize

If user gives a file path, read it first.
If user pastes text, use that text.
If context is partial, infer cautiously.

Then output:

```markdown
## Understood
- Goal: ...
- Current plan: ...
- Known constraints: ...
- Main unknowns: ...
```

Keep it short. Do not over-explain.

### 2. Decide if questions are needed

Ask questions when missing context can affect implementation choices.
Do not ask questions for obvious defaults or low-impact details.

Prioritize:

1. Product behavior / expected outcome
2. Scope boundaries
3. Data model or API contracts
4. UX / interaction details
5. Compatibility / migration / rollout
6. Error handling
7. Testing / acceptance criteria
8. Performance / security / operational risk

### 3. Ask grouped multiple-choice questions

Ask 3-7 questions per round. Fewer is better.

Preferred batch mode: call `clarification_ui` with the full round. Example shape:

```json
{
  "title": "Clarify plan",
  "questions": [
    {
      "id": "scope",
      "label": "Scope",
      "prompt": "What should be included in the first implementation pass?",
      "why": "This controls risk and avoids accidental overbuild.",
      "allowMultiple": true,
      "options": [
        {
          "value": "minimal-core",
          "label": "Minimal core behavior only",
          "description": "Best first pass; easiest to test and review.",
          "recommended": true
        },
        {
          "value": "core-plus-polish",
          "label": "Core behavior plus UI polish",
          "description": "More complete but bigger diff."
        }
      ]
    }
  ]
}
```

Fallback plain-text format:

```markdown
## Questions — round N

### Q1. <question>
Why it matters: <short reason>
Options:
- A) <recommended option> ✅ Recommended — <why this fits>
- B) <other option> — <tradeoff>
- C) <other option> — <tradeoff>
- D) Author custom answer
- E) Dig deeper on this question
- F) Leave it to agent
Your answer: choose A/B/C, multiple like A+C, or write custom text.
```

Rules:

- The recommended answer should usually be option A.
- If no clear recommendation exists, still provide the safest default first and label it `Tentative recommendation`.
- Allow multiple selections when choices can combine.
- Use concrete choices, not vague options.
- Include tradeoffs briefly.
- If the user asks `dig deeper`, ask a narrower follow-up question for that item.
- If the user says `leave it to you`, choose the recommended/default option and record the assumption.

### 4. Process answers

After each user response:

- Map selections to decisions.
- Preserve authored/custom answers exactly when important.
- Resolve contradictions by asking only about the conflict.
- If enough context exists, stop asking.
- If not enough context exists, ask another short round.

Maintain a decision log:

```markdown
## Decisions so far
- Q1: <decision>
- Q2: <decision>
- Assumptions delegated to agent:
  - <assumption>
```

### 5. Produce implementation-ready brief

When clarification is sufficient, output:

```markdown
## Implementation brief

### Goal
...

### Scope
In:
- ...
Out:
- ...

### Decisions
- ...

### Assumptions
- ...

### Acceptance criteria
- ...

### Risks / watchouts
- ...

### Suggested implementation steps
1. ...
2. ...
3. ...

### Suggested tests
- ...
```

Then ask:

```markdown
Proceed with implementation, save this brief to a file, or refine more?
```

## Interaction commands

Recognize these user intents naturally:

- `A`, `B`, `A+C`, `1:A 2:C`, etc. => select options.
- `author:` or free text => custom answer.
- `dig deeper`, `deeper on Q2` => ask focused follow-up.
- `leave it to you`, `you decide`, `default all` => choose recommendations.
- `skip` => leave unresolved if safe, otherwise explain why needed.
- `done`, `enough`, `make brief` => produce brief with known assumptions.

## Quality bar

- Questions must be high-signal, not exhaustive bureaucracy.
- Prefer defaults that reduce scope and risk.
- Do not implement code until enough context exists or user delegates decisions.
- Surface risky assumptions explicitly.
- Keep responses compact.
