# Skill Creator Original — Review Notes

Reviewed source:

`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/plugin-dev/skills/skill-development/references/skill-creator-original.md`

## Useful ideas preserved

- Skills are modular onboarding guides for repeated domains/tasks.
- Good skills encode specialized workflows, tool integrations, domain knowledge, and bundled resources.
- Progressive disclosure matters:
  1. metadata always loaded
  2. `SKILL.md` loaded when triggered
  3. bundled resources loaded only as needed
- Start with concrete usage examples before writing the skill.
- Decide reusable contents from examples:
  - scripts for deterministic repeated code
  - references for large docs/domain knowledge
  - assets for templates/output resources
- Keep `SKILL.md` lean and procedural.
- Avoid duplicating detailed content between `SKILL.md` and references.
- Iterate after real use.

## Pi adaptations

- Use Pi locations such as `~/.pi/agent/skills/<name>/SKILL.md` and `.pi/skills/<name>/SKILL.md`.
- Do not assume Claude-specific initialization or packaging scripts exist.
- Use Pi validation rules for frontmatter/name/description.
- Reload Pi resources after installing or changing a skill.
- Treat Skill Scout as detection and approval workflow, not as automatic skill creation.

## Cautions

- Original file references a license file; avoid wholesale copying unless license terms are checked.
- Original text is Claude-oriented; convert wording and paths before use in Pi.
- Packaging as zip is optional for Pi local usage.
