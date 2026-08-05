import { describe, expect, it } from 'vitest';
import { headerFromMessageFile, isMergeHeader, TYPES, validateHeader } from '../scripts/check-commits';

/**
 * The rules under test are written in `.trellis/spec/guides/commit-conventions.md`.
 * These cases are the spec's own examples plus the failure modes the gate exists
 * to catch — the whole point is that the script and the spec cannot drift apart
 * silently.
 */
describe('validateHeader', () => {
  it('accepts the spec examples', () => {
    const valid = [
      'feat(cli): add auth, project, work-item and meta commands',
      'fix(cli): align state resolution and error mapping with live API behaviour',
      'docs(research): record the live-API smoke run',
      'refactor(core): extract url building into wire',
      'test(http): cover 429 backoff without a retry-after header',
      'chore(task): archive 07-31-pingcode-cli-mvp',
      'build: emit a single esm bundle with tsup',
      'perf(core): cache metadata lookups per project',
      'revert: feat(cli) add bulk update',
      'feat(cli)!: rename --state-id to --state-ref',
      'docs: add README and backend specs, and record final verification',
    ];
    for (const header of valid) {
      expect(validateHeader(header), header).toEqual([]);
    }
  });

  it('rejects a message with no conventional prefix', () => {
    const errors = validateHeader('Fixed stuff.');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('type(scope): subject');
  });

  it('rejects an unknown type', () => {
    expect(validateHeader('wip(cli): add a thing').join(' ')).toContain('unknown type "wip"');
    expect(validateHeader('update(cli): add a thing').join(' ')).toContain('unknown type "update"');
  });

  it('rejects an uppercase subject start', () => {
    expect(validateHeader('feat(cli): Add a thing')).toEqual(['subject must start lowercase']);
  });

  it('rejects a trailing period', () => {
    expect(validateHeader('feat(cli): add a thing.')).toEqual(['subject must not end with a period']);
  });

  it('rejects an empty subject', () => {
    expect(validateHeader('feat(cli): ')).toEqual(['empty subject']);
    expect(validateHeader('   ')).toEqual(['empty subject line']);
  });

  it('rejects a subject longer than 72 characters', () => {
    const subject = 'a'.repeat(73);
    expect(validateHeader(`feat(cli): ${subject}`)).toEqual(['subject is 73 chars, max 72']);
    expect(validateHeader(`feat(cli): ${'a'.repeat(72)}`)).toEqual([]);
  });

  it('rejects an empty or shouty scope', () => {
    expect(validateHeader('feat(): add a thing').join(' ')).toContain('empty scope');
    expect(validateHeader('feat(CLI): add a thing').join(' ')).toContain('must be lowercase');
    expect(validateHeader('feat(the cli): add a thing').join(' ')).toContain('whitespace');
  });

  it('accepts a missing scope, because the spec makes it optional', () => {
    expect(validateHeader('docs: add a thing')).toEqual([]);
  });

  it('rejects the vague subjects the spec bans', () => {
    for (const header of ['chore: wip', 'chore: wip on auth', 'chore: misc', 'chore: updates', 'chore: various fixes']) {
      expect(validateHeader(header).join(' '), header).toContain('too vague');
    }
    // Not a false positive: a real, specific subject that merely starts with a banned word stem.
    expect(validateHeader('chore: update the vitest config')).toEqual([]);
  });

  it('reports every broken rule at once', () => {
    expect(validateHeader('Nope(CLI): Did stuff.')).toEqual([
      'does not match "type(scope): subject" (types: feat, fix, docs, refactor, test, chore, build, perf, revert)',
    ]);
    expect(validateHeader('chore(CLI): Did stuff.')).toEqual([
      'scope "CLI" must be lowercase',
      'subject must start lowercase',
      'subject must not end with a period',
    ]);
  });

  it('exposes exactly the spec type table', () => {
    expect([...TYPES]).toEqual(['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'build', 'perf', 'revert']);
  });
});

describe('isMergeHeader', () => {
  it('exempts the headers git writes itself', () => {
    expect(isMergeHeader("Merge branch 'main' into topic")).toBe(true);
    expect(isMergeHeader('Merge pull request #12 from fork/topic')).toBe(true);
    expect(isMergeHeader('Merge tag v0.1.0')).toBe(true);
  });

  it('does not exempt an ordinary commit that happens to mention merging', () => {
    expect(isMergeHeader('feat(cli): merge two flags into one')).toBe(false);
    expect(isMergeHeader('Merged the branch')).toBe(false);
  });
});

/**
 * `--file` is the `commit-msg` hook's entry point, so what it reads is a
 * `COMMIT_EDITMSG` file rather than a bare header: git's own instruction block is
 * in there, and it is the reason "the first line" is not simply `text.split('\n')[0]`.
 */
describe('headerFromMessageFile', () => {
  it('takes the first line of a plain message', () => {
    expect(headerFromMessageFile('feat(cli): add a thing\n')).toBe('feat(cli): add a thing');
    expect(headerFromMessageFile('feat(cli): add a thing\n\nA body paragraph.\n')).toBe('feat(cli): add a thing');
  });

  it("strips git's comment block, wherever it sits", () => {
    const editmsg = [
      'fix(http): retry once on a 429 without retry-after',
      '',
      '# Please enter the commit message for your changes. Lines starting',
      "# with '#' will be ignored, and an empty message aborts the commit.",
      '#',
      '# On branch main',
      '',
    ].join('\n');
    expect(headerFromMessageFile(editmsg)).toBe('fix(http): retry once on a 429 without retry-after');
    // `commit --verbose` puts the diff in the comment block; a `#` line first must
    // not become the header.
    expect(headerFromMessageFile('# On branch main\n\ndocs: add a thing\n')).toBe('docs: add a thing');
  });

  it('survives CRLF, because a Windows editor writes it', () => {
    expect(headerFromMessageFile('docs: add a thing\r\n\r\n# comment\r\n')).toBe('docs: add a thing');
  });

  it('reports an aborted editor as empty rather than as an offender', () => {
    // Exit 0 in that case: git aborts the commit itself, and a second error here
    // would only be confusing. `''` is how the caller learns to say nothing.
    expect(headerFromMessageFile('')).toBe('');
    expect(headerFromMessageFile('\n\n')).toBe('');
    expect(headerFromMessageFile('# Please enter the commit message…\n#\n# On branch main\n')).toBe('');
  });

  it('feeds the same validator the range path uses', () => {
    // No second set of rules for the hook: one validator, one spec.
    expect(validateHeader(headerFromMessageFile('Fixed stuff.\n\n# comment\n'))).toHaveLength(1);
    expect(validateHeader(headerFromMessageFile('chore(hooks): install a commit-msg gate\n'))).toEqual([]);
    expect(isMergeHeader(headerFromMessageFile("Merge branch 'main' into topic\n\n# comment\n"))).toBe(true);
  });
});
