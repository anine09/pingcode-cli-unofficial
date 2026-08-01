# Skill install target selection (Claude Code / OpenCode)

Lightweight task — PRD only. No `design.md` / `implement.md`: one script, one README section, one test file.

## Goal

`npm run skill:install` currently writes `skills/pingcode/SKILL.md` to **both** agent
destinations unconditionally. Let the operator choose which coding agent to install into.
Supported agents for now: **Claude Code** and **OpenCode**.

## Context

- Source of truth stays `skills/pingcode/SKILL.md` (design D10). This task does not change
  the skill content or add a CLI subcommand — it remains a repo script, because it needs the
  checkout it lives in, while the published binary may be installed anywhere.
- Destinations, both **global (user-level)**:
  - Claude Code: `~/.claude/skills/pingcode/SKILL.md`
  - OpenCode: `$XDG_CONFIG_HOME/opencode/skills/pingcode/SKILL.md` (default `~/.config/opencode/…`)
  - Project-local installs are deliberately not offered (user decision): the in-repo
    `skills/pingcode/SKILL.md` already covers this repository.
- The script must stay dependency-free: `node:` builtins only, no relative TS imports, so
  `node --experimental-strip-types` can run it without a module graph.

## Decisions

| # | Decision |
|---|---|
| D1 | Selection is exposed as `--target <agent>`, repeatable and comma-separated. Values: `claude`, `opencode`, `all`. |
| D2 | When `--target` is absent **and** stdin is a TTY, prompt interactively (`node:readline/promises`, prompt on stderr). |
| D3 | When `--target` is absent and stdin is **not** a TTY, install to **both** — the current behaviour. Keeps CI, pipes and `-- --dry-run` working unchanged. |
| D4 | Both targets are global/user-level. OpenCode's global skill dir is `$XDG_CONFIG_HOME/opencode/skills/` (default `~/.config/opencode/skills/`); the previous project-scoped `<cwd>/.opencode/skills/` destination is dropped. |
| D5 | `--dry-run` and `--force` keep their current meaning and compose with `--target`. `--dry-run` must never write and must never block on a prompt it cannot answer. |

## Requirements

- R1 `--target claude` writes only the Claude Code destination; `--target opencode` only the
  OpenCode one; `--target all` (or both values) writes both.
- R2 `--target` accepts repetition (`--target claude --target opencode`), a comma list
  (`--target claude,opencode`) and `--target=claude`. Values are case-insensitive.
- R3 An unknown agent name exits **2** with a message listing the supported names. Unknown
  flags keep exiting 2 with the usage line, which must now document `--target`.
- R4 Interactive prompt (TTY only) lists the agents with their resolved absolute paths and
  accepts: the number, the name, `a`/`all`, and empty input meaning **both**. `q` or EOF
  aborts with exit 0 and writes nothing.
- R5 Non-TTY without `--target` installs to both, unchanged from today.
- R6 Output still reports, per destination, whether it was written, overwritten or skipped,
  plus the `dry run — nothing was written` / `N destination(s) left untouched` trailers.
- R7 The prompt and all diagnostics go to **stderr**; the per-destination result lines stay
  on **stdout**, so `npm run skill:install -- --dry-run | ...` remains parseable.
- R8 README documents `--target`, including the non-interactive default.

## Non-Goals

- Other agents (Cursor, Codex, Gemini, …), and any *project*-scoped destination for either agent.
- Turning the installer into a `pingcode skill install` subcommand.
- Uninstall, symlinking, or version/diff checks against an existing installed copy.

## Acceptance Criteria

- AC1 `npm run typecheck && npm test` green; `test/help.test.ts` installer assertions still hold.
- AC2 `npm run skill:install -- --dry-run` (non-TTY, no `--target`) still lists **both**
  destinations and writes nothing — byte-identical behaviour to before this change.
- AC3 `--target claude --dry-run` lists only the Claude Code path; `--target opencode --dry-run`
  only the OpenCode path.
- AC4 `--target bogus` exits 2 and names the supported agents.
- AC5 A real `--target opencode` run creates `~/.config/opencode/skills/pingcode/SKILL.md` and
  leaves `~/.claude/skills/pingcode/SKILL.md` untouched.
- AC6 Script still runs with only `node:` builtins — no new dependency in `package.json`.
- AC7 README's install section documents `--target` and the non-interactive default.
