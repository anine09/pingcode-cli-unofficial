#!/usr/bin/env node
/**
 * Install the `pingcode` skill (design D10).
 *
 * The in-repo `skills/pingcode/SKILL.md` is the source of truth; this script
 * copies it to the places agents read skills from. It is a **script, not a CLI
 * subcommand**: a globally installed binary would resolve `.opencode/skills/`
 * relative to whatever directory the user happened to be in.
 *
 * Deliberately dependency-free — only `node:fs` / `node:path` / `node:os`, and no
 * relative TypeScript imports, so `node --experimental-strip-types` can run it
 * without resolving a module graph.
 *
 * Usage: node --experimental-strip-types scripts/install-skill.ts [--dry-run] [--force]
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_RELATIVE_PATH = path.join('skills', 'pingcode', 'SKILL.md');

type Target = {
  label: string;
  file: string;
};

function repoRoot(): string {
  // scripts/install-skill.ts → repository root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function targets(): Target[] {
  return [
    {
      label: 'Claude Code (user scope)',
      file: path.join(os.homedir(), '.claude', 'skills', 'pingcode', 'SKILL.md'),
    },
    {
      label: 'OpenCode (project scope)',
      file: path.join(process.cwd(), '.opencode', 'skills', 'pingcode', 'SKILL.md'),
    },
  ];
}

function main(argv: string[]): number {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const unknown = argv.filter((arg) => arg.startsWith('-') && !['--dry-run', '--force'].includes(arg));
  if (unknown.length > 0) {
    process.stderr.write(`unknown option(s): ${unknown.join(', ')}\n`);
    process.stderr.write('usage: npm run skill:install -- [--dry-run] [--force]\n');
    return 2;
  }

  const source = path.join(repoRoot(), SKILL_RELATIVE_PATH);
  if (!existsSync(source)) {
    process.stderr.write(`source skill not found: ${source}\n`);
    return 1;
  }
  const bytes = statSync(source).size;
  process.stdout.write(`source  ${source} (${bytes} bytes)\n`);

  let skipped = 0;
  for (const target of targets()) {
    const exists = existsSync(target.file);
    if (dryRun) {
      process.stdout.write(
        `would ${exists ? (force ? 'overwrite' : 'skip (exists, needs --force)') : 'write'}  ${target.file}  — ${target.label}\n`,
      );
      continue;
    }
    if (exists && !force) {
      process.stdout.write(`skipped  ${target.file}  — already exists, pass --force\n`);
      skipped += 1;
      continue;
    }
    mkdirSync(path.dirname(target.file), { recursive: true });
    copyFileSync(source, target.file);
    process.stdout.write(`${exists ? 'overwrote' : 'wrote'}  ${target.file}  — ${target.label}\n`);
  }

  if (dryRun) process.stdout.write('dry run — nothing was written\n');
  else if (skipped > 0) process.stdout.write(`${skipped} destination(s) left untouched\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
