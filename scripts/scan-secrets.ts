#!/usr/bin/env node
/**
 * Scan for leaked credentials and tenant-identifiable values (prd 08-01-ci-cd-pipeline D5/R3).
 *
 * This repository already needed one history-wide sanitisation pass, so the
 * cheap recurring check lives here and runs in CI once per run (not per matrix
 * leg). It looks at two surfaces, because last time the leak reached both:
 *
 *   1. tracked files (`git ls-files`)
 *   2. commit messages in a range (`git log <range>`)
 *
 * **Targeted patterns only.** A generic "24/40 hex id" rule was rejected on
 * purpose: every git sha, cache key and work-item id in this repository would
 * match it. Every pattern below therefore needs a *keyword* (`client_secret`,
 * `PINGCODE_CLIENT_*`, `Bearer`) or the `.pingcode.com` suffix next to the
 * value, which is something no sha carries.
 *
 * Deliberately dependency-free — only `node:` builtins and no relative
 * TypeScript imports, so `node --experimental-strip-types` can run it without
 * resolving a module graph (same rule as `scripts/install-skill.ts`).
 *
 * Usage: node --experimental-strip-types scripts/scan-secrets.ts [<git-range>]
 *   npm run scan:secrets                       # tracked files only
 *   npm run scan:secrets -- HEAD~20..HEAD      # tracked files + those messages
 *
 * Exit codes: 0 = clean, 1 = at least one finding, 2 = bad usage.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A line containing this marker is never reported — for docs and fixtures. */
export const ALLOW_MARKER = 'scan-secrets:allow';

/** Value charset shared by the credential patterns; `<value>`, `${x}` and `***` fall outside it. */
const VALUE = String.raw`[A-Za-z0-9._\-]`;

export type Pattern = {
  /** Stable id, used in the report and in tests. */
  name: string;
  /** Must have the `g` flag; group 1 is the suspicious value. */
  re: RegExp;
  /** Why this cannot fire on a git sha. */
  why: string;
};

/**
 * Minimum value lengths are what keeps the fixtures in `test/` quiet
 * (`Bearer tok-1`, `client_secret=secret-1`) while still catching a real
 * secret, which is 32+ characters on this API.
 */
export const PATTERNS: readonly Pattern[] = [
  {
    name: 'client-secret-assignment',
    // The lookbehind hands `PINGCODE_CLIENT_SECRET=…` to the next pattern instead
    // of reporting the same value twice.
    re: new RegExp(String.raw`(?<!PINGCODE_)client_secret["']?\s*[=:]\s*["']?(${VALUE}{12,})`, 'gi'),
    why: 'requires the literal key next to the value',
  },
  {
    name: 'pingcode-credential-env',
    re: new RegExp(String.raw`PINGCODE_CLIENT_(?:ID|SECRET)["']?\s*[=:]\s*["']?(${VALUE}{12,})`, 'g'),
    why: 'requires the env var name next to the value',
  },
  {
    name: 'bearer-token-literal',
    re: /Bearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g,
    why: 'requires the `Bearer` scheme prefix; docs use `Bearer <token>`, which is outside the charset',
  },
  {
    name: 'tenant-host',
    re: /\b([a-z0-9](?:[a-z0-9-]*)?[0-9])\.pingcode\.com\b/gi,
    why: 'anchored on `.pingcode.com` and requires a digit in the subdomain, so `open.` / `example.` stay clean',
  },
];

/**
 * Redaction placeholders and obvious fixtures. Substring match on the
 * lowercased value, plus a "single repeated character" rule that covers the
 * masked ids the spec recommends (`aaaaaaaaaaaaaaaaaaaaaaaa`).
 */
const PLACEHOLDER_SUBSTRINGS = [
  'redacted',
  'example',
  'placeholder',
  'changeme',
  'dummy',
  'sample',
  'your-',
  'yourclient',
  'fake',
  'test',
  'mock',
  'stub',
  'secret-',
  'tenant',
  'localhost',
];

export function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === '') return true;
  if (PLACEHOLDER_SUBSTRINGS.some((needle) => lower.includes(needle))) return true;
  // aaaa… / xxxx… / 0000… — a masked id, never a real credential.
  const first = lower[0] ?? '';
  if (lower.length >= 4 && [...lower].every((char) => char === first)) return true;
  return false;
}

/**
 * `client_secret: clientSecret` and `ENV_CLIENT_SECRET = 'PINGCODE_CLIENT_SECRET'`
 * are our own source code, not leaks. Both cases are identifiers, and no
 * credential this API issues looks like one: the rules below allow **no digits**,
 * while a real secret is hex or random alphanumeric.
 */
export function isCodeIdentifier(value: string): boolean {
  if (/^[a-z]+(?:[A-Z][a-z]*)+$/.test(value)) return true; // camelCase
  if (/^[A-Z][a-z]+(?:[A-Z][a-z]*)*$/.test(value)) return true; // PascalCase
  if (/^[A-Z][A-Z_]*$/.test(value)) return true; // CONSTANT_CASE
  if (/^[a-z]+(?:[_.-][a-z]+)+$/.test(value)) return true; // snake_case / kebab-case / dotted
  return false;
}

export type Finding = {
  /** `path:line` for files, `commit <sha>` for messages. */
  location: string;
  pattern: string;
  /** The matched value, truncated — never the whole line, so the report stays safe to paste. */
  evidence: string;
};

function truncate(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-2)}`;
}

/**
 * The pure core: scan text line by line. `label` is prefixed to every finding
 * so callers can report `file:line` or `commit <sha>`.
 */
export function scanText(text: string, label: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.includes(ALLOW_MARKER)) continue;
    for (const pattern of PATTERNS) {
      // Fresh state per line: the patterns are global.
      pattern.re.lastIndex = 0;
      for (let match = pattern.re.exec(line); match !== null; match = pattern.re.exec(line)) {
        const value = match[1] ?? '';
        if (isPlaceholder(value) || isCodeIdentifier(value)) continue;
        findings.push({
          location: `${label}:${index + 1}`,
          pattern: pattern.name,
          evidence: truncate(value),
        });
      }
    }
  }
  return findings;
}

/** Paths whose contents are generated, vendored, binary, or this scanner itself. */
const SKIPPED_PREFIXES = ['dist/', 'node_modules/', '.git/'];
const SKIPPED_FILES = ['scripts/scan-secrets.ts'];
const SKIPPED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tgz', '.woff', '.woff2'];

export function shouldSkipPath(relativePath: string): boolean {
  const normalised = relativePath.split(path.sep).join('/');
  if (SKIPPED_PREFIXES.some((prefix) => normalised.startsWith(prefix))) return true;
  if (SKIPPED_FILES.includes(normalised)) return true;
  return SKIPPED_EXTENSIONS.some((extension) => normalised.toLowerCase().endsWith(extension));
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function trackedFiles(): string[] {
  return git(['ls-files', '-z'])
    .split('\0')
    .filter((entry) => entry !== '');
}

function scanFiles(): Finding[] {
  const findings: Finding[] = [];
  for (const relativePath of trackedFiles()) {
    if (shouldSkipPath(relativePath)) continue;
    let text: string;
    try {
      text = readFileSync(path.join(repoRoot(), relativePath), 'utf8');
    } catch {
      // Deleted-but-tracked or unreadable: nothing to scan, and not this gate's job to complain.
      continue;
    }
    if (text.includes('\0')) continue; // binary without a known extension
    findings.push(...scanText(text, relativePath));
  }
  return findings;
}

/**
 * Commit messages in `range`. A range that resolves to nothing (first push,
 * shallow clone, unknown `before` sha) is treated as "nothing to scan" rather
 * than a failure — the file scan is the load-bearing half.
 */
function scanCommitMessages(range: string): Finding[] {
  let log: string;
  try {
    log = git(['log', '--no-merges', '--format=%H%x1f%B%x1e', range]);
  } catch {
    process.stderr.write(`scan-secrets: cannot resolve range ${range}, skipping commit messages\n`);
    return [];
  }
  const findings: Finding[] = [];
  for (const record of log.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '');
    if (trimmed === '') continue;
    const separator = trimmed.indexOf('\x1f');
    if (separator === -1) continue;
    const sha = trimmed.slice(0, separator);
    const message = trimmed.slice(separator + 1);
    findings.push(...scanText(message, `commit ${sha.slice(0, 12)}`));
  }
  return findings;
}

function main(argv: string[]): number {
  const ranges: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: npm run scan:secrets [-- <git-range>]\n');
      return 0;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`unknown option: ${arg}\nusage: npm run scan:secrets [-- <git-range>]\n`);
      return 2;
    }
    ranges.push(arg);
  }

  const findings = scanFiles();
  for (const range of ranges) findings.push(...scanCommitMessages(range));

  if (findings.length > 0) {
    process.stderr.write(`scan-secrets: ${findings.length} finding(s)\n`);
    for (const finding of findings) {
      process.stderr.write(`  ${finding.location}  [${finding.pattern}]  ${finding.evidence}\n`);
    }
    process.stderr.write(
      `\nIf a hit is a documented placeholder, put \`${ALLOW_MARKER}\` on that line. Otherwise: rotate the credential first, then scrub it.\n`,
    );
    return 1;
  }

  const scope = ranges.length > 0 ? `tracked files + ${ranges.join(' ')}` : 'tracked files';
  process.stdout.write(`scan-secrets: clean (${scope})\n`);
  return 0;
}

/** Only run when executed directly, so the tests can import the pure helpers. */
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
