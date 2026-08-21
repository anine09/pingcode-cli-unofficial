import { describe, expect, it } from 'vitest';
import { commandAt, fullHelpFor, helpFor, leavesOf, program, subgroupsOf } from './tree';

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
      'project create',
      'project update',
      'project progress',
      'project work-item list',
      'project work-item get',
      'project work-item create',
      'project work-item update',
      'project work-item transition',
      'project work-item bulk-update',
      'project work-item delete',
      'project work-item link list',
      'project work-item link get',
      'project work-item link add',
      'project work-item link delete',
      'project work-item tag add',
      'project work-item tag get',
      'project work-item tag delete',
      'project work-item history list',
      'project work-item history get',
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
      'project sprint bulk-create',
      'project version list',
      'project version get',
      'project version create',
      'project version update',
      'project version delete',
      'project version bulk-create',
      'project board list',
      'project board entries',
      'project board swimlanes',
      'project member list',
      'project member get',
      'project member add',
      'project meta types',
      'project meta states',
      'project meta priorities',
      'project meta sprints',
      'project meta relation-types',
      'project meta tags',
    ]);
  });

  it('registers exactly these subgroups', () => {
    expect(subgroupsOf('project')).toEqual([
      'project work-item',
      'project sprint',
      'project version',
      'project board',
      'project member',
      'project meta',
    ]);
  });

  /**
   * S2b's endpoint budget, pinned as a number so a twenty-first leaf cannot arrive
   * quietly.
   *
   * The three-set balance in `prd.md` (53 covered + 107 in scope + 299 out = 459) and
   * the eight-child endpoint sum of 92 are the checkable reason to believe the task
   * built what it said it would. S2b is 20 endpoints / 19 leaves, which is the whole of
   * the remaining headroom under the "re-split above ~20 leaves" rule — so the count is
   * an assertion, not a comment.
   */
  it('adds exactly the nineteen leaves S2b owns, and no twentieth', () => {
    const s2b = [
      'project create',
      'project update',
      'project progress',
      'project work-item bulk-update',
      'project work-item delete',
      'project work-item link list',
      'project work-item link get',
      'project work-item link add',
      'project work-item link delete',
      'project work-item tag add',
      'project work-item tag get',
      'project work-item tag delete',
      'project work-item history list',
      'project work-item history get',
      'project member list',
      'project member get',
      'project member add',
      'project meta relation-types',
      'project meta tags',
    ];
    expect(s2b).toHaveLength(19);
    const leaves = leavesOf('project');
    for (const leaf of s2b) expect(leaves, leaf).toContain(leaf);
  });

  /**
   * The five absences this group must keep visible. All five are upstream's, all five
   * look like oversights, and every one of them would be "completed" by a later
   * contributor who did not check — which is exactly what happened to the API's own
   * symmetry.
   *
   *  - **no sprint delete.** `/v1/pjm/projects/{p}/sprints/{s}` documents GET and PATCH
   *    only ([S§3.8.5]), so a sprint is permanent once created.
   *  - **no project delete.** `/v1/pjm/projects/{p}` has no DELETE either ([S§3.8.1]),
   *    and `is_archived` is not patchable — a project cannot even be hidden.
   *  - **no `work-item tag list`.** Upstream has the add, the get-one and the delete but
   *    no collection GET (research §3.8.3). A work item's own `tags[]` is the answer.
   *  - **no `project meta` leaf for project states**, deliberately: that endpoint is
   *    outside this child's twenty, so `project update` takes `--state-id`.
   *  - **no `member remove`**, and this one is a *choice* rather than an upstream gap:
   *    `DELETE …/members/{member_id}` exists. It is left to the generic layer because
   *    recovering it would take S2b to 20 leaves and break the endpoint-budget identity
   *    the whole task is checked against; a membership is also the cheapest thing here
   *    to recreate. Documented in `member --help` and `modules/pjm.md`.
   */
  it('keeps the four upstream gaps and the one deliberate omission absent', () => {
    const leaves = leavesOf('project');
    expect(leaves).not.toContain('project sprint delete');
    expect(leaves).not.toContain('project delete');
    expect(leaves).not.toContain('project sprint list');
    expect(leaves).not.toContain('project work-item tag list');
    expect(leaves).not.toContain('project member remove');
    expect(leaves).not.toContain('project member delete');
    // The releases *do* delete, and so do work items — the assertions that keep the
    // absences above from reading as a blanket "pjm cannot delete anything".
    expect(leaves).toContain('project version delete');
    expect(leaves).toContain('project work-item delete');
    expect(leaves).toContain('project meta sprints');
  });

  it('gates every delete behind --yes and never offers one --all', () => {
    // Design D8.1/D8.2: every refined delete needs --yes, and --all is a paging flag
    // that must not become a bulk-delete switch.
    const deletes: string[][] = [
      ['project', 'version', 'delete'],
      ['project', 'work-item', 'delete'],
      ['project', 'work-item', 'link', 'delete'],
      ['project', 'work-item', 'tag', 'delete'],
    ];
    for (const path of deletes) {
      const flags = commandAt(program(), path).options.map((option) => option.long);
      expect(flags, path.join(' ')).toContain('--yes');
      expect(flags, path.join(' ')).not.toContain('--all');
      expect(flags, path.join(' ')).not.toContain('--page');
    }
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

  it('offers no bulk-update flag for the properties the endpoint silently ignores', () => {
    // The same rule, and the sharpest instance of it in this child: D7.2 justified the
    // bulk PATCH with "move twenty work items into a sprint in one call", and live
    // 2026-08-04 `property_name: sprint_id` answers HTTP 200 with `updates: 0` and
    // changes nothing — as do type_id, tag_ids, version_ids and participant_ids. A
    // `--sprint` flag here would be a dead knob that reports success.
    const flags = commandAt(program(), ['project', 'work-item', 'bulk-update']).options.map(
      (option) => option.long,
    );
    for (const dead of ['--sprint', '--tag', '--tag-id', '--version', '--participant', '--parent']) {
      expect(flags, dead).not.toContain(dead);
    }
    // The five verified to apply, plus the generic escape hatch for everything else.
    for (const live of [
      '--assignee',
      '--state',
      '--priority',
      '--title',
      '--description',
      '--property',
      '--value',
    ]) {
      expect(flags, live).toContain(live);
    }
  });

  /**
   * The X3 gap that this repair closes, pinned from the flag side.
   *
   * `PATCH /v1/pjm/work_items/{id}` accepts `sprint_id` and `version_ids`; before this,
   * only `create` carried `--sprint` and nothing carried the release, so an item that
   * already existed could join either **only** through `pingcode api PATCH`.
   *
   * The name matters more than the presence. `--version` is **not available**: the root
   * program owns it, commander's root parses options across the whole argv, and
   * `work-item update <id> --version 1.4.0` therefore prints `0.1.0` and exits 0 having
   * sent nothing (observed on the built binary, 2026-08-05). A flag that reports success
   * while doing nothing is the failure mode this whole task keeps finding upstream, so it
   * must not be introduced here — hence the negative assertion.
   */
  it('lets an existing work item join a sprint and a release, and refuses to name the release flag --version', () => {
    const update = commandAt(program(), ['project', 'work-item', 'update']);
    const flags = update.options.map((option) => option.long);
    expect(flags).toContain('--sprint');
    expect(flags).toContain('--release');
    // Would be swallowed by the root's own --version.
    expect(flags).not.toContain('--version');
    // `sprint_id` is a scalar and `version_ids` an array that replaces, so exactly one
    // of the two is variadic — the shape difference has to survive in the surface.
    expect(update.options.find((option) => option.long === '--sprint')?.variadic).toBeFalsy();
    const help = fullHelpFor(['project', 'work-item', 'update']);
    expect(help).toContain('repeatable');
    expect(help).toContain('REPLACES');
    // And `bulk-update` still may not grow either one: it answers 200 / `updated: 0`.
    const bulk = commandAt(program(), ['project', 'work-item', 'bulk-update']).options.map(
      (option) => option.long,
    );
    expect(bulk).not.toContain('--sprint');
    expect(bulk).not.toContain('--release');
    expect(fullHelpFor(['project', 'work-item', 'bulk-update'])).toContain(
      'work-item update --sprint',
    );
  });

  it('marks the search-only list filters and keeps them off the simple-list path', () => {
    // The two transports accept **different filters**, which is why the switch has to be
    // visible in `--help` at all. It is *not* because search pages differently: it pages
    // exactly like the simple list (live 2026-08-04). An earlier revision asserted the
    // help said paging was "IGNORED" here, which pinned a false claim in place — see
    // design D16.1.
    const list = commandAt(program(), ['project', 'work-item', 'list']);
    const flags = list.options.map((option) => option.long);
    for (const searchOnly of [
      '--unassigned',
      '--title-contains',
      '--created-after',
      '--created-before',
      '--updated-after',
      '--updated-before',
    ]) {
      expect(flags, searchOnly).toContain(searchOnly);
      const option = list.options.find((candidate) => candidate.long === searchOnly);
      expect(option?.description, searchOnly).toContain('(search)');
    }
    const help = fullHelpFor(['project', 'work-item', 'list']);
    expect(help).toContain('different things');
    // The retraction, asserted so it cannot silently come back: the help must not claim
    // the search transport ignores paging or refuses --all.
    expect(help).not.toContain('IGNORES');
    expect(help).not.toContain('--all is refused');
  });

  it('sends nobody to a work-item tag list, and says where the tags are instead', () => {
    // The one absence a user is most likely to go looking for, so the pointer has to be
    // in the help rather than only in the docs.
    const help = fullHelpFor(['project', 'work-item', 'tag']);
    expect(help).toContain('no `tag list`');
    expect(help).toContain('tags[]');
    expect(help).toContain('project meta tags');
  });

  it('distinguishes the two relation families in both help texts', () => {
    // `link` is /v1/pjm/work_items/{id}/relations (typed, work item ↔ work item);
    // `relation` is /v1/relations (untyped, work item ↔ anything else, and it refuses
    // two work items). Neither may impersonate the other (design D7.6).
    const link = fullHelpFor(['project', 'work-item', 'link']);
    expect(link).toContain('/v1/relations');
    expect(link).toContain('relation-types');
    const relation = fullHelpFor(['project', 'work-item', 'relation']);
    expect(relation).toContain('/v1/pjm/work_items/{id}/relations');
  });

  it('warns in the meta help that the tag vocabulary is organisation-wide', () => {
    // `--project` is required by the endpoint and then ignored by it, while the write
    // enforces project scoping — the trap that also cost `100354` its override row.
    const help = fullHelpFor(['project', 'meta', 'tags']);
    expect(help).toContain('IGNORED');
    expect(help).toContain('resolve');
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

  it('project sprint bulk-create (the entry schema and the ENT-only note)', () => {
    expect(helpFor(['project', 'sprint', 'bulk-create'])).toMatchSnapshot();
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

  it('project work-item list (the two transports and their different filters)', () => {
    expect(fullHelpFor(['project', 'work-item', 'list'])).toMatchSnapshot();
  });

  it('project work-item bulk-update (the widest new flag set, and the ignored properties)', () => {
    expect(fullHelpFor(['project', 'work-item', 'bulk-update'])).toMatchSnapshot();
  });

  it('project work-item delete (the first refined DELETE in pjm)', () => {
    expect(helpFor(['project', 'work-item', 'delete'])).toMatchSnapshot();
  });

  it('project work-item link (link vs relation is in the group help)', () => {
    expect(fullHelpFor(['project', 'work-item', 'link'])).toMatchSnapshot();
  });

  it('project work-item tag (the missing list is in the group help)', () => {
    expect(fullHelpFor(['project', 'work-item', 'tag'])).toMatchSnapshot();
  });

  it('project work-item history (state changes only)', () => {
    expect(fullHelpFor(['project', 'work-item', 'history'])).toMatchSnapshot();
  });

  it('project create (permanent, and the one flag that can never be changed)', () => {
    expect(fullHelpFor(['project', 'create'])).toMatchSnapshot();
  });

  it('project member (the deliberate absence of `remove` is in the group help)', () => {
    expect(fullHelpFor(['project', 'member'])).toMatchSnapshot();
  });

  it('project meta tags (the org-wide vocabulary warning)', () => {
    expect(fullHelpFor(['project', 'meta', 'tags'])).toMatchSnapshot();
  });
});
