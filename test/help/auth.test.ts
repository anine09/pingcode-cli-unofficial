import { describe, expect, it } from 'vitest';
import { helpFor, leavesOf } from './tree';

/**
 * `auth` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/auth.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3).
 *
 * When you add a leaf: extend the list below, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 */

describe('auth command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('auth')).toEqual([
      'auth login',
      'auth status',
      'auth logout',
    ]);
  });
});

describe('auth --help', () => {
  it('auth', () => {
    expect(helpFor(['auth'])).toMatchSnapshot();
  });
});
