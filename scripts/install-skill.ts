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
 * Target selection (prd 08-01-skill-install-targets):
 *   - `--target` given      → exactly those agents
 *   - omitted, stdin is TTY → interactive prompt
 *   - omitted, not a TTY    → both agents (the historical behaviour, so CI and
 *                             pipes keep working unchanged)
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

/** TTY-only. Returns the chosen targets, or null when the operator aborts. */
async function promptForTargets(all: Target[]): Promise<Target[] | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write('install the pingcode skill into which coding agent?\n');
    all.forEach((target, index) => {
      process.stderr.write(`  ${index + 1}) ${target.label}\n       ${target.file}\n`);
    });
    process.stderr.write(`  a) all of them\n`);
    const answer = (await rl.question('choose [number/name/a, empty = all, q = quit]: ')).trim().toLowerCase();
    if (answer === 'q' || answer === 'quit') return null;
    if (answer === '' || answer === 'a' || answer === 'all') return all;

    const byIndex = Number.parseInt(answer, 10);
    if (String(byIndex) === answer && byIndex >= 1 && byIndex <= all.length) {
      return [all[byIndex - 1] as Target];
    }
    const selected = selectTargets(all, [answer]);
    if (typeof selected === 'string') {
      process.stderr.write(`${selected}\n`);
      return null;
    }
    return selected;
  } catch {
    // EOF / closed stdin — treat like an abort rather than installing blindly.
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
