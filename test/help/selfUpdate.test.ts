import { describe, expect, it } from 'vitest';
import { helpFor, leavesOf } from './tree';

/**
 * `self-update` — its own leaves and its own `--help` snapshot.
 *
 * This file and `test/help/__snapshots__/selfUpdate.test.ts.snap` are the
 * write scope of whoever owns this group (design D6.3).
 */
describe('self-update command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('self-update')).toEqual(['self-update']);
  });
});

describe('self-update --help', () => {
  it('self-update', () => {
    expect(helpFor(['self-update'])).toMatchSnapshot();
  });
});
