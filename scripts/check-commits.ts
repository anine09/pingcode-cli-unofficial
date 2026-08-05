#!/usr/bin/env node
/**
 * Enforce the commit-message rules from `.trellis/spec/guides/commit-conventions.md`
 * (prd 08-01-ci-cd-pipeline D6/R4).
 *
 * The spec is the contract; this script only encodes the parts a machine can
 * decide without guessing:
 *
 *   - `type(scope): subject`, with an optional `!` breaking-change marker
 *   - `type` from the spec's fixed table (no invented types)
 *   - `scope` optional, but non-empty and lowercase when the parens are there
 *   - `subject` non-empty, lowercase first character, no trailing period, <= 72
 *   - none of the vague subjects the spec bans outright (`WIP`, `misc`, …)
 *
 * Imperative mood is *not* checked: there is no reliable test for it, and a
 * wrong guess would block honest commits. It stays a review item.
 *
 * Merge commits are exempt (git writes those headers, not us). On a pull
 * request the PR *title* is validated too, because a squash merge becomes the
 * commit subject.
 *
 * Deliberately dependency-free — only `node:` builtins and no relative
 * TypeScript imports, so `node --experimental-strip-types` can run it.
 *
 * Usage: node --experimental-strip-types scripts/check-commits.ts [<git-range> | --file <path>]
 *   npm run check:commits                       # whole history reachable from HEAD
 *   npm run check:commits -- origin/main..HEAD  # a range
 *   PR_TITLE='fix(cli): …' npm run check:commits -- origin/main..HEAD
 *   npm run check:commits -- --file .git/COMMIT_EDITMSG   # one message file
 *
 * `--file` is what the `commit-msg` hook calls: in CI this gate can only look at
 * commits that already exist, so a bad message is found after the fact and the
 * fix is a rebase. Validating the file git is about to commit catches it before
 * the commit is born, with the same validator and the same rules — the hook adds
 * no rule of its own. `--file` and a range are mutually exclusive.
 *
 * Exit codes: 0 = all valid, 1 = at least one offender, 2 = bad usage.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The spec's table, verbatim. Do not extend without changing the spec first. */
export const TYPES = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'test',
  'chore',
  'build',
  'perf',
  'revert',
] as const;

/** Subjects the spec bans by name, plus the `WIP` prefix. */
const VAGUE_SUBJECT = /^(wip\b|misc$|updates?$|various fixes$)/;

const MAX_SUBJECT_LENGTH = 72;

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?: (?<subject>.*)$/;

/** `Merge branch 'x'`, `Merge pull request #1 …`, `Merge tag …` — written by git. */
export function isMergeHeader(header: string): boolean {
  return /^Merge (branch|remote-tracking branch|pull request|tag|commit) /.test(header);
}

/**
 * The pure validator. Returns every rule the header breaks, so one run reports
 * the whole picture instead of the first problem.
 */
export function validateHeader(header: string): string[] {
  const errors: string[] = [];
  if (header.trim() === '') return ['empty subject line'];

  const match = HEADER.exec(header);
  if (match === null || match.groups === undefined) {
    return [`does not match "type(scope): subject" (types: ${TYPES.join(', ')})`];
  }

  const groups = match.groups;
  const type = groups['type'] ?? '';
  const scope = groups['scope'];
  const subject = groups['subject'] ?? '';

  if (!(TYPES as readonly string[]).includes(type)) {
    errors.push(`unknown type "${type}" (allowed: ${TYPES.join(', ')})`);
  }

  if (scope !== undefined) {
    if (scope.trim() === '') errors.push('empty scope — drop the parentheses instead');
    else if (scope !== scope.toLowerCase()) errors.push(`scope "${scope}" must be lowercase`);
    else if (/\s/.test(scope)) errors.push(`scope "${scope}" must not contain whitespace`);
  }

  if (subject === '') {
    errors.push('empty subject');
    return errors;
  }
  if (subject !== subject.trimStart()) errors.push('subject has leading whitespace');
  const firstChar = subject[0] ?? '';
  if (firstChar !== firstChar.toLowerCase()) errors.push('subject must start lowercase');
  if (subject.endsWith('.')) errors.push('subject must not end with a period');
  if (subject.length > MAX_SUBJECT_LENGTH) {
    errors.push(`subject is ${subject.length} chars, max ${MAX_SUBJECT_LENGTH}`);
  }
  if (VAGUE_SUBJECT.test(subject.toLowerCase())) {
    errors.push('subject is too vague (the spec bans WIP / misc / updates / various fixes)');
  }

  return errors;
}

/**
 * The header of a commit-message *file* (`COMMIT_EDITMSG`), which is not the
 * same thing as its first line: git appends its own instruction block, so the
 * file usually starts or ends with `#` comments and blank lines. Those are
 * stripped first, then the first remaining line is the header.
 *
 * Returns `''` when nothing is left — the editor was closed without writing a
 * message. That is not an offence to report: git aborts the commit by itself,
 * and a second error here would only be confusing noise.
 */
export function headerFromMessageFile(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)) // CRLF editors
    .filter((line) => !line.startsWith('#'));
  for (const line of lines) {
    if (line.trim() !== '') return line;
  }
  return '';
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

type Commit = { sha: string; header: string };

/** `git log <range>` headers; merge commits are dropped by `--no-merges`. */
function commitsIn(range: string): Commit[] | null {
  let log: string;
  try {
    log = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%s', range], {
      cwd: repoRoot(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const commits: Commit[] = [];
  for (const line of log.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('\x1f');
    if (separator === -1) continue;
    commits.push({ sha: line.slice(0, separator), header: line.slice(separator + 1) });
  }
  return commits;
}

/**
 * `--file` mode: validate the single header in a commit-message file. Same
 * validator, same report shape and same exit codes as the range path, minus the
 * sha (the commit does not exist yet — that is the point).
 */
function checkMessageFile(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    process.stderr.write(`check-commits: cannot read message file ${file}\n`);
    return 2;
  }

  const header = headerFromMessageFile(text);
  if (header === '') return 0; // aborted editor; git stops the commit on its own
  if (isMergeHeader(header)) return 0;

  const errors = validateHeader(header);
  if (errors.length > 0) {
    process.stderr.write(`${header}\n`);
    for (const error of errors) process.stderr.write(`    - ${error}\n`);
    process.stderr.write('\ncheck-commits: 1 offender(s). See .trellis/spec/guides/commit-conventions.md.\n');
    return 1;
  }

  process.stdout.write('check-commits: commit message is conventional\n');
  return 0;
}

const USAGE = 'usage: npm run check:commits [-- <git-range> | -- --file <path>]   (PR_TITLE is checked when set)\n';

function main(argv: string[]): number {
  const ranges: string[] = [];
  let file: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg === '--file' || arg.startsWith('--file=')) {
      const value = arg === '--file' ? argv[index + 1] : arg.slice('--file='.length);
      if (value === undefined || value === '' || value.startsWith('-')) {
        process.stderr.write(`check-commits: --file needs a path\n${USAGE}`);
        return 2;
      }
      if (file !== undefined) {
        process.stderr.write('check-commits: pass at most one --file\n');
        return 2;
      }
      file = value;
      if (arg === '--file') index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`unknown option: ${arg}\n${USAGE}`);
      return 2;
    }
    ranges.push(arg);
  }

  if (file !== undefined) {
    if (ranges.length > 0) {
      process.stderr.write('check-commits: --file and a git range are mutually exclusive\n');
      return 2;
    }
    return checkMessageFile(file);
  }

  const range = ranges[0] ?? 'HEAD';
  if (ranges.length > 1) {
    process.stderr.write('check-commits: pass at most one range\n');
    return 2;
  }

  const commits = commitsIn(range);
  if (commits === null) {
    process.stderr.write(`check-commits: cannot resolve range ${range}\n`);
    return 2;
  }

  let offenders = 0;
  for (const commit of commits) {
    if (isMergeHeader(commit.header)) continue;
    const errors = validateHeader(commit.header);
    if (errors.length === 0) continue;
    offenders += 1;
    process.stderr.write(`${commit.sha.slice(0, 12)}  ${commit.header}\n`);
    for (const error of errors) process.stderr.write(`    - ${error}\n`);
  }

  // A squash merge takes the PR title as the commit subject, so it has to hold up too.
  const prTitle = process.env['PR_TITLE'];
  if (prTitle !== undefined && prTitle.trim() !== '') {
    const errors = validateHeader(prTitle);
    if (errors.length > 0) {
      offenders += 1;
      process.stderr.write(`PR title  ${prTitle}\n`);
      for (const error of errors) process.stderr.write(`    - ${error}\n`);
    }
  }

  if (offenders > 0) {
    process.stderr.write(
      `\ncheck-commits: ${offenders} offender(s). See .trellis/spec/guides/commit-conventions.md.\n`,
    );
    return 1;
  }

  process.stdout.write(`check-commits: ${commits.length} commit(s) in ${range} are conventional\n`);
  return 0;
}

/** Only run when executed directly, so the tests can import the pure validator. */
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
