# Pi Skill Rules

Pi implements the Agent Skills standard leniently: warnings do not always block loading, but missing descriptions do.

## Discovery locations

Pi loads skills from:

- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- `.pi/skills/`
- `.agents/skills/` in cwd and ancestors
- package skill directories or `pi.skills` entries
- paths configured in settings `skills`
- CLI `--skill <path>`

## Discovery details

- Direct root `.md` files are discovered in `~/.pi/agent/skills/` and `.pi/skills/`.
- Directories containing `SKILL.md` are discovered recursively.
- Root `.md` files in `.agents/skills/` are ignored.
- `--no-skills` disables discovery except explicit `--skill` paths.

## Activation model

1. Pi scans skill paths at startup or reload.
2. Pi exposes skill names and descriptions in the system prompt.
3. The model should read the full `SKILL.md` when the task matches.
4. Relative paths in a skill resolve from the skill directory.

## Slash commands

Skills register as commands:

```bash
/skill:<name>
/skill:<name> arguments here
```

Arguments are appended to skill content as user context.

## Frontmatter

Required:

- `name`
- `description`

Optional:

- `license`
- `compatibility`
- `metadata`
- `allowed-tools`
- `disable-model-invocation`

## Name validation

Valid names:

- lowercase letters
- numbers
- hyphens
- 1-64 chars
- no leading/trailing hyphen
- no consecutive hyphens
- matches parent directory

Examples:

- valid: `skill-development`
- valid: `pdf-processing`
- invalid: `SkillDevelopment`
- invalid: `skill_development`
- invalid: `-skill-development`

## Reload

After creating or editing skills in auto-discovered locations, run `/reload` in interactive Pi so the skill list refreshes.
