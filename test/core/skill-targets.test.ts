import { describe, expect, it } from 'vitest';
import { resolveTargetList } from '../../src/core/skill-targets';
import { AGENT_SPECS, skillTargets } from '../../src/core/paths';

const ALL = skillTargets({});
const NAMES = ALL.map((target) => target.name);
const find = (name: string) => ALL.find((target) => target.name === name)!;

describe('resolveTargetList', () => {
  it('treats `all` (any case) as every agent', () => {
    expect(resolveTargetList('all')).toEqual({ ok: true, targets: ALL });
    expect(resolveTargetList('ALL').ok).toBe(true);
    expect(resolveTargetList('All')).toEqual({ ok: true, targets: ALL });
  });

  it('treats a missing / whitespace `--target` as every agent', () => {
    // An empty `--target` is indistinguishable from "not given", which is what
    // keeps the interactive and non-interactive paths in agreement.
    for (const raw of ['', '   ', '\t', ' , , ']) {
      expect(resolveTargetList(raw)).toEqual({ ok: true, targets: ALL });
    }
  });

  it('resolves a single agent id', () => {
    const result = resolveTargetList('cursor');
    expect(result.ok).toBe(true);
    expect(result.ok && result.targets.map((t) => t.name)).toEqual(['cursor']);
  });

  it('accepts a comma-separated list, preserving order', () => {
    const result = resolveTargetList('cursor,claude-code,opencode');
    expect(result.ok && result.targets.map((t) => t.name)).toEqual([
      'cursor',
      'claude-code',
      'opencode',
    ]);
  });

  it('is case-insensitive and ignores padding around tokens', () => {
    const result = resolveTargetList(' Cursor , CLAUDE-CODE ,opencode ');
    expect(result.ok && result.targets.map((t) => t.name)).toEqual([
      'cursor',
      'claude-code',
      'opencode',
    ]);
  });

  it('dedupes repeated ids', () => {
    const result = resolveTargetList('cursor,cursor,CURSOR');
    expect(result.ok && result.targets).toHaveLength(1);
  });

  it('resolves the legacy `claude` alias to claude-code', () => {
    const viaAlias = resolveTargetList('claude');
    const viaId = resolveTargetList('claude-code');
    expect(viaAlias).toEqual(viaId);
    expect(viaId.ok && viaId.targets[0]!.name).toBe('claude-code');
  });

  it('collapses an alias and its id to one target', () => {
    const result = resolveTargetList('claude,claude-code');
    expect(result.ok && result.targets).toHaveLength(1);
  });

  it('returns the full target object, not just the name', () => {
    const result = resolveTargetList('cursor');
    expect(result.ok && result.targets[0]).toEqual(find('cursor'));
  });

  it('keeps all 48 agents resolvable by id', () => {
    const result = resolveTargetList(NAMES.join(','));
    expect(result.ok).toBe(true);
    expect(result.ok && result.targets).toHaveLength(48);
  });

  describe('unknown values', () => {
    it('reports unknown tokens instead of silently dropping them', () => {
      const result = resolveTargetList('cursor,definitely-not-real');
      expect(result).toMatchObject({ ok: false, unknown: ['definitely-not-real'] });
    });

  it('lists every valid token in the error, in catalog order', () => {
    // `validTokens()` interleaves each spec's aliases right after its id, so
    // `claude` sits next to `claude-code` rather than in a block at the end.
    const result = resolveTargetList('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.valid).toEqual([
        ...AGENT_SPECS.flatMap((spec) => [spec.id, ...(spec.aliases ?? [])]),
        'all',
      ]);
    }
  });

    it('lowercases the unknown token as the user typed it', () => {
      const result = resolveTargetList(' Cursor , Nope ,OPencode');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unknown).toEqual(['nope']);
    });

    it('dedupes repeated unknown tokens', () => {
      const result = resolveTargetList('nope,nope,NOPE');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unknown).toEqual(['nope']);
    });

    it('rejects `all` mixed with other tokens', () => {
      // `all` is only meaningful as the whole value, so a mix is an error rather
      // than a surprise "everything" install.
      const result = resolveTargetList('all,cursor');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unknown).toEqual(['all']);
    });

    it('does not report a known id as unknown', () => {
      const result = resolveTargetList('antigravity2.0');
      expect(result.ok && result.targets.map((t) => t.name)).toEqual(['antigravity2.0']);
    });
  });
});
