---
name: skill-development
description: Create, review, adapt, and maintain Pi/Agent Skills. Use when the user wants to build a new skill, convert a Claude/OpenAI skill to Pi, improve SKILL.md metadata, decide whether a repeated workflow deserves a skill, or connect a workflow with Skill Scout.
---

# Skill Development

Use this skill to design, review, create, or improve Pi-compatible Agent Skills.

## Core workflow

1. Clarify the repeated workflow the skill should encode.
2. Gather concrete user examples and likely trigger phrases.
3. Decide whether a skill is the right abstraction.
4. Design progressive disclosure:
   - Keep metadata concise and trigger-focused.
   - Keep `SKILL.md` procedural and small.
   - Move detailed docs into `references/`.
   - Put deterministic reusable code in `scripts/`.
   - Put templates/assets to copy or modify in `assets/`.
5. Create or edit the skill in the correct Pi location.
6. Validate frontmatter and structure.
7. Reload Pi resources when needed.
8. Iterate after real use.

## When to create a skill

Create a skill when at least one condition is true:

- The user repeats a workflow across sessions or projects.
- The workflow needs project-specific conventions or policy.
- The workflow requires non-obvious procedural knowledge.
- The workflow benefits from reusable scripts, references, templates, or assets.
- Skill Scout has detected a repeated pattern and the user approves drafting or activation.

Do not create a skill when:

- The task is one-off and unlikely to recur.
- A short `AGENTS.md` rule or project memory entry is enough.
- The content is a secret, transient debug note, or temporary preference.
- The skill would be too broad to trigger reliably.

## Pi skill locations

Prefer these paths:

- Global user skill: `~/.pi/agent/skills/<skill-name>/SKILL.md`
- Project skill: `.pi/skills/<skill-name>/SKILL.md`

Pi also loads compatible skills from other configured skill paths. Read Pi docs before changing settings.

## Required structure

```text
skill-name/
├── SKILL.md
├── scripts/       # optional deterministic helpers
├── references/    # optional docs loaded only when needed
└── assets/        # optional output templates/assets
```

Only `SKILL.md` is required.

## Frontmatter rules

Use valid YAML frontmatter:

```yaml
---
name: skill-name
description: Specific trigger-focused description. Explain what this skill does and when to use it.
---
```

Rules:

- `name` is required.
- `description` is required; missing descriptions prevent loading.
- `name` must match parent directory.
- `name` must be lowercase letters, numbers, and hyphens only.
- `name` must be 1-64 chars.
- Avoid leading/trailing hyphens and consecutive hyphens.
- Keep `description` <= 1024 chars.
- Optional fields such as `license`, `compatibility`, and `metadata` are allowed.

## Description writing

Write descriptions to optimize activation. Include:

- Main capability.
- Specific trigger conditions.
- Common user phrasing or task shape.
- Important boundaries if needed.

Good:

```yaml
description: Create, review, adapt, and maintain Pi/Agent Skills. Use when the user wants to build a new skill, convert a Claude/OpenAI skill to Pi, improve SKILL.md metadata, decide whether a repeated workflow deserves a skill, or connect a workflow with Skill Scout.
```

Bad:

```yaml
description: Helps with skills.
```

## Instruction style

Write skill bodies as concise imperative instructions for another agent instance.

Prefer:

- `Inspect existing conventions before editing.`
- `Ask for missing trigger examples when unclear.`
- `Move long reference material into references/.`

Avoid:

- Chatty explanations.
- Duplicating large reference docs inside `SKILL.md`.
- Vague advice without concrete execution steps.

## Resource design

### scripts/

Add scripts when repeated code or deterministic behavior matters.

Examples:

- validators
- migration helpers
- format converters
- scaffolding scripts

Do not add scripts just because they are possible. Keep them auditable.

### references/

Add references for large or detailed context that should load only when needed.

Examples:

- API docs
- schema notes
- project policy
- conversion notes
- detailed examples

If a reference is large, mention search terms or relevant headings in `SKILL.md`.

### assets/

Add assets when the skill needs templates or files used in outputs.

Examples:

- starter projects
- document templates
- icons/fonts
- reusable config files

## Skill Scout integration

Use Skill Scout as the detection and approval layer; use this skill as the authoring guidance.

When a repeated workflow appears:

1. Record it with `skill_scout_record`.
2. Do not create or approve a skill unless the user explicitly asks.
3. Use `/skill-scout status` to inspect candidates.
4. Use `/skill-scout draft <name>` to create a draft.
5. Review and improve the draft with this skill.
6. Use `/skill-scout approve <name>` only after user approval.

For skill-authoring candidates, improve the generated draft beyond the generic template:

- Add Pi-specific paths and validation rules.
- Add concrete trigger examples.
- Add references for detailed external guidance instead of bloating `SKILL.md`.
- Add clear boundaries around secrets, destructive actions, and licensing.

## Converting Claude/OpenAI skills to Pi

1. Read the original skill completely.
2. Preserve useful workflow knowledge.
3. Replace harness-specific commands and paths with Pi equivalents.
4. Check license/frontmatter before copying content verbatim.
5. Prefer an adapted summary plus source path/reference over bulk copying if licensing is unclear.
6. Ensure `name` matches the destination directory.
7. Ensure `description` triggers correctly in Pi.
8. Replace unsupported tool assumptions with Pi tools/extensions.
9. Add `/reload` note after installing into Pi skill paths.

## Validation checklist

Before finishing:

- Path is correct for desired scope.
- Directory name equals frontmatter `name`.
- Description is specific and under 1024 chars.
- Skill body gives procedural instructions, not generic filler.
- Long docs live in `references/`.
- Scripts/assets are only added when genuinely useful.
- Destructive actions require explicit user approval.
- Secrets are not stored.
- User is told to run `/reload` or reload is handled by an extension command.

## References

- Pi skill rules: `references/pi-skill-rules.md`
- Source review notes: `references/skill-creator-review.md`
