import { describe, expect, it } from 'vitest';
import { isMergeHeader, TYPES, validateHeader } from '../scripts/check-commits';

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
