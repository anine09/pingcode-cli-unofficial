import { describe, expect, it } from 'vitest';
import { commandAt, helpFor, leavesOf, program, subgroupsOf } from './tree';

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
      'project sprint get',
      'project sprint create',
      'project sprint update',
      'project sprint bulk',
      'project version list',
      'project version get',
      'project version create',
      'project version update',
      'project version delete',
      'project version bulk',
      'project meta types',
      'project meta states',
      'project meta priorities',
      'project meta sprints',
    ]);
  });

  it('registers exactly these subgroups', () => {
    expect(subgroupsOf('project')).toEqual([
      'project work-item',
      'project sprint',
      'project version',
      'project meta',
    ]);
  });

  /**
   * The two absences S2a must keep visible. Both are upstream's, both look like
   * oversights, and both would be "completed" by a later contributor who did not know:
   *
   *  - **no sprint delete.** `/v1/pjm/projects/{p}/sprints/{s}` documents GET and PATCH
   *    only ([S§3.8.5]), so a sprint is permanent once created.
   *  - **no project delete.** `/v1/pjm/projects/{p}` has no DELETE either ([S§3.8.1]).
   *
   * There is also **no `sprint list`** leaf, but for the opposite reason: that endpoint
   * is already covered as `project meta sprints`, which the list above still contains.
   */
  it('has no sprint delete, no project delete, and no duplicate sprint list', () => {
    const leaves = leavesOf('project');
    expect(leaves).not.toContain('project sprint delete');
    expect(leaves).not.toContain('project delete');
    expect(leaves).not.toContain('project sprint list');
    // The release *does* delete — the one destructive verb in the planning surface, and
    // the assertion that keeps the two absences above from reading as a blanket rule.
    expect(leaves).toContain('project version delete');
    expect(leaves).toContain('project meta sprints');
  });

  it('gates the one delete behind --yes and never offers it --all', () => {
    // Design D8.1/D8.2: every refined delete needs --yes, and --all is a paging flag
    // that must not become a bulk-delete switch.
    const remove = commandAt(program(), ['project', 'version', 'delete']);
    const flags = remove.options.map((option) => option.long);
    expect(flags).toContain('--yes');
    expect(flags).not.toContain('--all');
    expect(flags).not.toContain('--page');
  });

  it('offers no --stage filter on the release list, because upstream ignores it', () => {
    // Live 2026-08-04: `?stage_id=` returned every row regardless. D11.2's rule — a
    // silently dead filter is worse than no filter.
    const flags = commandAt(program(), ['project', 'version', 'list']).options.map(
      (option) => option.long,
    );
    expect(flags).toContain('--status');
    expect(flags).not.toContain('--stage');
    expect(flags).not.toContain('--stage-id');
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

  it('project sprint (the two absences are in the group help)', () => {
    expect(helpFor(['project', 'sprint'])).toMatchSnapshot();
  });

  it('project sprint create (permanent, and the widest sprint flag set)', () => {
    expect(helpFor(['project', 'sprint', 'create'])).toMatchSnapshot();
  });

  it('project sprint bulk (the entry schema and the ENT-only note)', () => {
    expect(helpFor(['project', 'sprint', 'bulk'])).toMatchSnapshot();
  });

  it('project version (the four-way name collision is in the group help)', () => {
    expect(helpFor(['project', 'version'])).toMatchSnapshot();
  });

  it('project version update (--operate-at needs --stage-id)', () => {
    expect(helpFor(['project', 'version', 'update'])).toMatchSnapshot();
  });

  it('project version delete (the only delete in the planning surface)', () => {
    expect(helpFor(['project', 'version', 'delete'])).toMatchSnapshot();
  });
});
