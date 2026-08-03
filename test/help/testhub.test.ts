import { describe, expect, it } from 'vitest';
import { helpFor, leavesOf, subgroupsOf } from './tree';

/**
 * `testhub` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/testhub.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3).
 *
 * When you add a leaf: extend the list below, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 */

describe('testhub command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('testhub')).toEqual([
      'testhub libraries list',
      'testhub libraries get',
      'testhub libraries create',
      'testhub cases list',
      'testhub cases get',
      'testhub cases create',
      'testhub cases update',
      'testhub plans list',
      'testhub plans get',
      'testhub plans create',
      'testhub runs list',
      'testhub runs patch',
      'testhub runs bulk',
      'testhub meta case-states',
      'testhub meta case-types',
      'testhub meta important-levels',
      'testhub meta run-statuses',
      'testhub meta plan-types',
      'testhub meta suites',
    ]);
  });

  it('registers exactly these subgroups', () => {
    expect(subgroupsOf('testhub')).toEqual([
      'testhub libraries',
      'testhub cases',
      'testhub plans',
      'testhub runs',
      'testhub meta',
    ]);
  });
});

describe('testhub --help', () => {
  it('testhub', () => {
    expect(helpFor(['testhub'])).toMatchSnapshot();
  });

  it('testhub libraries', () => {
    expect(helpFor(['testhub', 'libraries'])).toMatchSnapshot();
  });

  it('testhub cases', () => {
    expect(helpFor(['testhub', 'cases'])).toMatchSnapshot();
  });

  it('testhub plans', () => {
    expect(helpFor(['testhub', 'plans'])).toMatchSnapshot();
  });

  it('testhub runs', () => {
    expect(helpFor(['testhub', 'runs'])).toMatchSnapshot();
  });

  it('testhub meta', () => {
    expect(helpFor(['testhub', 'meta'])).toMatchSnapshot();
  });
});
