#!/usr/bin/env node
/**
 * Install the `pingcode` skill (design D10).
 *
 * The in-repo `skills/pingcode/` directory is the source of truth; this script
 * copies it into the global skill directories agents read. It is a **script, not
 * a CLI subcommand**: it needs the checkout it lives in, while the published
 * binary can be installed anywhere.
 *
 * Installs are global only (`~/.claude/skills/`, `~/.config/opencode/skills/`) —
 * see `targets()`.
 *
 * **What gets copied**: `SKILL.md` plus every file in `skills/pingcode/modules/`.
 * F1 split the per-module prose out of SKILL.md (design D6.4) so that parallel
 * children stop colliding in one 650-line document; the modules are therefore not
 * optional extras — SKILL.md links to them, and an install that dropped them would
 * hand the agent a document full of dead links.
 *
 * Deliberately dependency-free — only `node:fs` / `node:path` / `node:os` /
 * `node:readline`, and no relative TypeScript imports, so
 * `node --experimental-strip-types` can run it without resolving a module graph.
 *
 * Usage: node --experimental-strip-types scripts/install-skill.ts
 *          [--target claude|opencode|all] [--dry-run] [--force]
 *
 * Target selection:
 *   - `--target` given      → exactly those agents
 *   - omitted, stdin is TTY → interactive checkbox list with search
 *   - omitted, not a TTY    → all agents (historical behaviour)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const SKILL_DIR_RELATIVE_PATH = path.join('skills', 'pingcode');
const SKILL_RELATIVE_PATH = path.join('skills', 'pingcode', 'SKILL.md');
const MODULES_DIR_NAME = 'modules';

type Target = {
  /** `--target` value; also accepted as an answer to the interactive prompt. */
  name: string;
  label: string;
  file: string;
};

/** One file to copy: `relative` is the path under the skill directory, both ends. */
type Payload = {
  relative: string;
  source: string;
};

function repoRoot(): string {
  // scripts/install-skill.ts → repository root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** OpenCode reads global skills from `$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode`. */
function opencodeConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

/**
 * Both destinations are **global (user-level)** on purpose: a skill installed
 * into a repository would only exist for whoever checked that repository out,
 * and the in-repo `skills/pingcode/SKILL.md` already covers this repository.
 */
function targets(): Target[] {
  return [
    {
      name: 'claude',
      label: 'Claude Code (global)',
      file: path.join(os.homedir(), '.claude', 'skills', 'pingcode', 'SKILL.md'),
    },
    {
      name: 'opencode',
      label: 'OpenCode (global)',
      file: path.join(opencodeConfigDir(), 'skills', 'pingcode', 'SKILL.md'),
    },
  ];
}

const USAGE = 'usage: npm run skill:install -- [--target claude|opencode|all] [--dry-run] [--force]\n';

/**
 * `SKILL.md` plus every module file, in a stable order (SKILL.md first, then the
 * modules sorted by name) so the printed plan is deterministic.
 *
 * The module directory is read rather than listed: a child task that adds
 * `modules/scm.md` must not also have to remember to register it here. That is the
 * asymmetry the code-reuse guide warns about — two mechanisms that have to produce
 * the same file set, where only one of them gets updated.
 */
function collectPayload(skillDir: string): Payload[] {
  const files: Payload[] = [{ relative: 'SKILL.md', source: path.join(skillDir, 'SKILL.md') }];
  const modulesDir = path.join(skillDir, MODULES_DIR_NAME);
  if (!existsSync(modulesDir)) return files;
  for (const entry of readdirSync(modulesDir).sort()) {
    if (!entry.endsWith('.md')) continue;
    files.push({
      relative: path.join(MODULES_DIR_NAME, entry),
      source: path.join(modulesDir, entry),
    });
  }
  return files;
}

type Args = {
  dryRun: boolean;
  force: boolean;
  /** null = not specified; the caller then prompts or defaults to every agent. */
  requested: string[] | null;
  error?: string;
};

/** Split `--target a,b` / `--target=a` / repeated `--target` into lowercase names. */
function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, force: false, requested: null };
  const requested: string[] = [];
  let sawTarget = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--target' || arg.startsWith('--target=')) {
      sawTarget = true;
      let value: string | undefined;
      if (arg.startsWith('--target=')) value = arg.slice('--target='.length);
      else {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === '' || value.startsWith('-')) {
        out.error = '--target needs a value';
        break;
      }
      for (const part of value.split(',')) {
        const name = part.trim().toLowerCase();
        if (name !== '') requested.push(name);
      }
    } else if (arg.startsWith('-')) {
      out.error = `unknown option: ${arg}`;
      break;
    } else {
      out.error = `unexpected argument: ${arg}`;
      break;
    }
  }

  if (sawTarget) out.requested = requested;
  return out;
}

/** Resolve requested names to targets; `all` (or no name) means every agent. */
function selectTargets(all: Target[], requested: string[]): Target[] | string {
  if (requested.length === 0 || requested.includes('all')) return all;
  const picked: Target[] = [];
  for (const name of requested) {
    const match = all.find((t) => t.name === name);
    if (match === undefined) {
      return `unknown target: ${name} (supported: ${all.map((t) => t.name).join(', ')}, all)`;
    }
    if (!picked.includes(match)) picked.push(match);
  }
  return picked;
}

/** TTY-only. Interactive checkbox list with search/filter. */
async function promptForTargets(all: Target[]): Promise<Target[] | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const selected = new Set<number>();
  let filterText = '';
  let inFilter = false;

  const render = (): void => {
    const matches = filterText !== ''
      ? all.filter((target) => {
          const text = `${target.label} ${target.name}`.toLowerCase();
          return text.includes(filterText.toLowerCase());
        })
      : all;

    if (!inFilter) {
      process.stderr.write('install the pingcode skill into which coding agent(s)?\n');
      matches.forEach((target, displayIndex) => {
        const index = all.indexOf(target);
        const boxed = selected.has(index) ? '[x]' : '[ ]';
        process.stderr.write(`  ${boxed} ${displayIndex + 1}) ${target.label}\n       ${target.file}\n`);
      });
      process.stderr.write('  a) toggle all   |   / filter   |   Enter confirm   q = quit\n');
    }
    if (filterText !== '') {
      process.stderr.write(`filter: ${filterText}\n`);
      process.stderr.write(`${matches.length} of ${all.length} shown\n`);
    }
    process.stderr.write(inFilter ? 'filter: ' : 'choose: ');
  };

  try {
    while (true) {
      render();
      const raw = await rl.question('');
      const answer = raw.trim().toLowerCase();

      // Compute the current visible list once per input, after render() updates filterText.
      const visible = filterText !== ''
        ? all.filter((target) => {
            const text = `${target.label} ${target.name}`.toLowerCase();
            return text.includes(filterText.toLowerCase());
          })
        : all;
      const visibleIndices = visible.map((target) => all.indexOf(target));

      if (inFilter) {
        if (answer === 'q' || answer === 'quit') return null;
        if (answer === '') { inFilter = false; filterText = ''; continue; }
        filterText = answer;
        inFilter = false;
        continue;
      }

      if (answer === 'q' || answer === 'quit') return null;
      if (answer === 'a' || answer === 'all') {
        if (selected.size === all.length) selected.clear();
        else all.forEach((_, index) => selected.add(index));
        continue;
      }
      if (answer === '/') { inFilter = true; filterText = ''; continue; }
      if (answer === '') {
        if (selected.size > 0) return all.filter((_, index) => selected.has(index));
        all.forEach((_, index) => selected.add(index));
        continue;
      }

      const parts = answer.split(/[,\s]+/).filter((part) => part !== '');
      const indices = new Set<number>();
      for (const part of parts) {
        const byIndex = Number.parseInt(part, 10);
        // Resolve against visible list when filtering, against full list otherwise.
        if (String(byIndex) === part && byIndex >= 1 && byIndex <= visible.length) {
          indices.add(visibleIndices[byIndex - 1] as number);
          continue;
        }
        const match = all.find((target) => target.name === part);
        if (match === undefined) {
          const resolved = selectTargets(all, [part]);
          if (typeof resolved === 'string') {
            process.stderr.write(`${resolved}\n`);
            return null;
          }
          resolved.forEach((target) => indices.add(all.indexOf(target)));
          continue;
        }
        indices.add(all.indexOf(match));
      }
      indices.forEach((index) => {
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
      });
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  const source = path.join(repoRoot(), SKILL_RELATIVE_PATH);
  if (!existsSync(source)) {
    process.stderr.write(`source skill not found: ${source}\n`);
    return 1;
  }
  const payload = collectPayload(path.join(repoRoot(), SKILL_DIR_RELATIVE_PATH));

  const all = targets();
  let selected: Target[];
  if (args.requested !== null) {
    const resolved = selectTargets(all, args.requested);
    if (typeof resolved === 'string') {
      process.stderr.write(`${resolved}\n`);
      process.stderr.write(USAGE);
      return 2;
    }
    selected = resolved;
  } else if (process.stdin.isTTY === true) {
    const answered = await promptForTargets(all);
    if (answered === null) {
      process.stderr.write('aborted — nothing was written\n');
      return 0;
    }
    selected = answered;
  } else {
    // Non-interactive and unspecified: keep the historical every-agent behaviour.
    selected = all;
  }

  const bytes = payload.reduce((total, file) => total + statSync(file.source).size, 0);
  process.stdout.write(
    `source  ${path.join(repoRoot(), SKILL_DIR_RELATIVE_PATH)} (${payload.length} file(s), ${bytes} bytes)\n`,
  );

  let skipped = 0;
  for (const target of selected) {
    // The per-target destination is `<skill dir>/SKILL.md`, so its parent is the
    // directory the modules go into as well.
    const targetDir = path.dirname(target.file);
    for (const file of payload) {
      const destination = path.join(targetDir, file.relative);
      const exists = existsSync(destination);
      if (args.dryRun) {
        process.stdout.write(
          `would ${exists ? (args.force ? 'overwrite' : 'skip (exists, needs --force)') : 'write'}  ${destination}  — ${target.label}\n`,
        );
        continue;
      }
      if (exists && !args.force) {
        process.stdout.write(`skipped  ${destination}  — already exists, pass --force\n`);
        skipped += 1;
        continue;
      }
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(file.source, destination);
      process.stdout.write(`${exists ? 'overwrote' : 'wrote'}  ${destination}  — ${target.label}\n`);
    }
  }

  if (args.dryRun) process.stdout.write('dry run — nothing was written\n');
  else if (skipped > 0) process.stdout.write(`${skipped} destination(s) left untouched\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
