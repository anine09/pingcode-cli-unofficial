#!/usr/bin/env node
/**
 * Point git at `.githooks` (`core.hooksPath`) so the hooks in this repository are
 * live after a plain `npm install`.
 *
 * **Plain ESM JavaScript on purpose, not TypeScript.** Every other script in
 * `scripts/` is `.ts` run through `node --experimental-strip-types`, but this one
 * is wired to `prepare`, which runs during `npm ci` — including on the Node 20 leg
 * of the CI matrix, where that flag does not exist. A `.ts` installer would break
 * `npm ci` there. So: `.mjs`, `node:` builtins only, no relative imports, nothing
 * to transpile.
 *
 * Two no-op cases, both exit 0 so they can never fail an install:
 *   - `CI` is set — a CI checkout commits nothing and pushes nothing, and rewriting
 *     git config in a runner is pointless noise.
 *   - not inside a git work tree — installing the published tarball as a dependency.
 *
 * Usage: node scripts/install-hooks.mjs   (or `npm run hooks:install`)
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = '.githooks';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function insideWorkTree() {
  try {
    return git(['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

function main() {
  if (process.env.CI !== undefined && process.env.CI !== '') {
    process.stdout.write('install-hooks: CI detected, leaving core.hooksPath alone\n');
    return 0;
  }

  if (!insideWorkTree()) {
    process.stdout.write('install-hooks: not a git work tree, nothing to do\n');
    return 0;
  }

  const hooksPath = path.join(repoRoot, HOOKS_DIR);
  let hooks;
  try {
    hooks = readdirSync(hooksPath).filter((name) => statSync(path.join(hooksPath, name)).isFile());
  } catch {
    process.stderr.write(`install-hooks: ${HOOKS_DIR}/ is missing — nothing installed\n`);
    return 1;
  }

  git(['config', 'core.hooksPath', HOOKS_DIR]);

  // Git preserves the executable bit, so this is belt and braces: a checkout made
  // with a umask-mangling tool, or a hook created without `chmod +x`, would
  // otherwise fail silently at commit time.
  for (const hook of hooks) chmodSync(path.join(hooksPath, hook), 0o755);

  process.stdout.write(
    `install-hooks: core.hooksPath = ${HOOKS_DIR} (${hooks.sort().join(', ')})\n` +
      'install-hooks: hooks only run commands CI runs too, so --no-verify defers a check, never skips it\n',
  );
  return 0;
}

process.exitCode = main();
