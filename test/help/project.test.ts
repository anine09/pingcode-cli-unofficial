import { describe, expect, it } from 'vitest';
import { helpFor, leavesOf, subgroupsOf } from './tree';

/**
 * `project` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/project.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3).
 *
 * When you add a leaf: extend the list below, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 */

describe('project command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('project')).toEqual([
      'project list',
      'project get',
      'project work-item list',
      'project work-item get',
      'project work-item create',
      'project work-item update',
      'project work-item transition',
      'project work-item relation list',
      'project work-item relation get',
      'project work-item relation add',
      'project work-item relation delete',
      'project work-item comment list',
      'project work-item comment get',
      'project work-item comment add',
      'project work-item comment delete',
      'project work-item attachment list',
      'project work-item attachment get',
      'project work-item attachment add-snippet',
      'project work-item attachment delete',
      'project work-item activity list',
      'project work-item activity get',
      'project meta types',
      'project meta states',
      'project meta priorities',
      'project meta sprints',
    ]);
  });

  it('registers exactly these subgroups', () => {
    expect(subgroupsOf('project')).toEqual([
      'project work-item',
      'project meta',
    ]);
  });
});

describe('project --help', () => {
  it('project', () => {
    expect(helpFor(['project'])).toMatchSnapshot();
  });

  it('project work-item', () => {
    expect(helpFor(['project', 'work-item'])).toMatchSnapshot();
  });

  it('project meta', () => {
    expect(helpFor(['project', 'meta'])).toMatchSnapshot();
  });

  it('project work-item update (the widest flag set)', () => {
    expect(helpFor(['project', 'work-item', 'update'])).toMatchSnapshot();
  });

  it('project work-item transition (--type is a lookup aid, not a patched field)', () => {
    expect(helpFor(['project', 'work-item', 'transition'])).toMatchSnapshot();
  });
});
