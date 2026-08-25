#!/usr/bin/env node
/**
 * Build and package the `pingcode` CLI into per-platform release zips.
 *
 * This is a **build-time script, not a CLI subcommand**: it needs the checkout
 * it lives in (tsup build + the in-repo `skills/` directory), while the
 * published binary ships as one of the zips this script produces.
 *
 * The zips are platform-independent (pure JS), so every platform×arch entry in
 * the release matrix gets the **same contents**; only the filename differs, and
 * only so the self-update flow can match an asset to the machine it runs on.
 *
 * Each zip contains:
 *   dist/bin/pingcode.js
 *   skills/pingcode/SKILL.md
 *   skills/pingcode/modules/*.md
 *
 * Deliberately dependency-free — only `node:*` modules, plus the system `zip`
 * binary, so `node --experimental-strip-types` can run it without resolving a
 * module graph and without bundling a ZIP writer.
 *
 * Usage: node --experimental-strip-types scripts/package-release.ts
 *          [--no-build] [--output <dir>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `platform`×`arch` pairs the release matrix advertises to the self-update flow. */
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;
const ARCHES = ['x64', 'arm64'] as const;

type Platform = (typeof PLATFORMS)[number];
type Arch = (typeof ARCHES)[number];

/** Build output: a single bundled entrypoint. */
const BIN_ENTRY = path.join('dist', 'bin', 'pingcode.js');
/** Skills payload — packaged alongside the binary so a fresh install is usable. */
const SKILL_DIR = path.join('skills', 'pingcode');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');
const SKILL_MODULES_DIR = path.join(SKILL_DIR, 'modules');

type Args = {
  build: boolean;
  output: string;
  error?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { build: true, output: 'release' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--no-build') out.build = false;
    else if (arg === '--output' || arg.startsWith('--output=')) {
      let value: string | undefined;
      if (arg.startsWith('--output=')) value = arg.slice('--output='.length);
      else {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === '' || value.startsWith('-')) {
        out.error = '--output needs a directory';
        break;
      }
      out.output = value;
    } else if (arg.startsWith('-')) {
      out.error = `unknown option: ${arg}`;
      break;
    } else {
      out.error = `unexpected argument: ${arg}`;
      break;
    }
  }
  return out;
}

function repoRoot(): string {
  // scripts/package-release.ts → repository root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function readVersion(root: string): string {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`version not found in ${pkgPath}`);
  }
  return pkg.version;
}

/** The `zip` binary is a system dependency; fail early with a clear message. */
function ensureZip(): void {
  try {
    execFileSync('zip', ['--version'], { stdio: 'ignore' });
  } catch {
    process.stderr.write('error: the `zip` command is required but was not found on PATH\n');
    process.stderr.write('       install it (e.g. apt install zip / brew install zip) and retry\n');
    process.exit(1);
  }
}

function runBuild(root: string): void {
  process.stdout.write('building (npm run build) …\n');
  execFileSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

/**
 * Confirm everything the zip will reference actually exists, so we fail before
 * producing a partial archive rather than letting `zip` silently skip files.
 */
function verifyPayload(root: string): void {
  const bin = path.join(root, BIN_ENTRY);
  if (!existsSync(bin)) throw new Error(`build output missing: ${bin}`);
  const skill = path.join(root, SKILL_FILE);
  if (!existsSync(skill)) throw new Error(`skill not found: ${skill}`);
  const modulesDir = path.join(root, SKILL_MODULES_DIR);
  if (existsSync(modulesDir)) {
    const modules = readdirSync(modulesDir).filter((entry) => entry.endsWith('.md'));
    if (modules.length === 0) throw new Error(`no modules in ${modulesDir}`);
  } else {
    throw new Error(`modules directory not found: ${modulesDir}`);
  }
}

/**
 * Create one zip. `zip -j`-free: we keep relative paths inside the archive so the
 * self-update extractor lands files under `dist/bin/` and `skills/pingcode/`
 * exactly as the runtime expects.
 *
 * Run from the repo root so the archived paths are `dist/...` and `skills/...`.
 */
function createZip(root: string, outputDir: string, version: string, platform: Platform, arch: Arch): string {
  const name = `pingcode-cli-v${version}-${platform}-${arch}.zip`;
  const output = path.join(outputDir, name);
  if (existsSync(output)) rmSync(output);
  execFileSync(
    'zip',
    ['-rq', output, BIN_ENTRY, 'skills/pingcode/'],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  return output;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    process.stderr.write('usage: node --experimental-strip-types scripts/package-release.ts [--no-build] [--output <dir>]\n');
    return 2;
  }

  const root = repoRoot();
  const version = readVersion(root);
  process.stdout.write(`version  ${version}\n`);

  ensureZip();

  if (args.build) runBuild(root);
  verifyPayload(root);

  const outputDir = path.resolve(root, args.output);
  mkdirSync(outputDir, { recursive: true });

  const matrix: Array<[Platform, Arch]> = [];
  for (const platform of PLATFORMS) for (const arch of ARCHES) matrix.push([platform, arch]);

  process.stdout.write(`packaging ${matrix.length} archive(s) → ${outputDir}\n`);
  const created: string[] = [];
  for (const [platform, arch] of matrix) {
    const output = createZip(root, outputDir, version, platform, arch);
    created.push(output);
    process.stdout.write(`  ${path.basename(output)}\n`);
  }

  process.stdout.write(`\ndone — ${created.length} release archive(s) in ${outputDir}\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
