#!/usr/bin/env node
/**
 * One-click installer for the `pingcode` CLI (cross-platform: Linux, macOS, Windows).
 *
 * The package is not published and `bin` points at the built `dist/bin/pingcode.js`,
 * so "install" = deps + build + global link. Run this from the repo checkout:
 *
 *   node scripts/install.mjs        # or: npm run install:cli
 *   ./install.sh                    # Linux / macOS
 *   .\install.ps1                   # Windows PowerShell
 *
 * Re-run it after `git pull` to rebuild + relink the latest code — one memorable
 * command instead of npm install / build / link.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BIN = 'pingcode';
const NODE_MAJOR_REQUIRED = 20;

function die(message) {
  process.stderr.write(`\n✗ install failed: ${message}\n`);
  process.exit(1);
}

function major() {
  return Number(process.versions.node.split('.')[0] ?? 0);
}

/**
 * Run a command, streaming its output, and abort on failure. `shell: true` so `npm`
 * resolves on Windows (npm.cmd) as well as Unix. Returns the resolved binary path on
 * success for the version checks.
 */
function run(label, command, args, { capture = false } = {}) {
  process.stdout.write(`\n→ ${label}: ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    stdio: capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
    encoding: capture ? 'utf8' : undefined,
  });
  if (result.status !== 0) {
    die(`"${command} ${args.join(' ')}" exited with ${String(result.status)}`);
  }
  return result;
}

function main() {
  process.stdout.write(`Installing ${BIN} (Node ${process.versions.node})…\n`);

  const m = major();
  if (!Number.isInteger(m) || m < NODE_MAJOR_REQUIRED) {
    die(`Node.js >= ${NODE_MAJOR_REQUIRED} required, found ${process.versions.node}`);
  }

  // 1. dependencies (runs the esbuild/fsevents install scripts the deps commit allows).
  run('dependencies', 'npm', ['install']);

  // 2. build dist/bin/pingcode.js (what package.json `bin` points at).
  run('build', 'npm', ['run', 'build']);

  // 3. global link so `pingcode` lands on PATH.
  run('link', 'npm', ['link']);

  // 4. verify the linked command resolves and reports a version.
  const version = run('verify', BIN, ['--version'], { capture: true });
  const out = (version.stdout ?? '').trim();
  if (out === '') die('the linked `pingcode` command did not print a version');

  process.stdout.write(`\n✓ ${BIN} installed — ${out}\n`);
  process.stdout.write(`  run: ${BIN} auth login\n`);
}

// Resolve the repo root so the script can be run from anywhere; keeps relative reads sane.
export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

main();
