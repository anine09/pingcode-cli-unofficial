import { describe, expect, it } from 'vitest';
import { fullHelpFor, helpFor, leavesOf, subgroupsOf } from './tree';

/**
 * `testhub` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/testhub.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3).
 *
 * When you add a leaf: extend the list below, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 *
 * The list is **exact** on purpose. S3 added twelve leaves for thirteen endpoints, and
 * an exact array is what makes a thirteenth leaf — the usual way scope creeps — fail
 * the suite instead of arriving unnoticed.
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
      'testhub cases bulk-create',
      'testhub cases bulk-update',
      'testhub cases delete',
      'testhub cases history list',
      'testhub cases relation list',
      'testhub cases relation get',
      'testhub cases relation add',
      'testhub cases relation delete',
      'testhub cases comment list',
      'testhub cases comment get',
      'testhub cases comment add',
      'testhub cases comment delete',
      'testhub cases attachment list',
      'testhub cases attachment get',
      'testhub cases attachment add-snippet',
      'testhub cases attachment delete',
      'testhub cases activity list',
      'testhub cases activity get',
      'testhub plans list',
      'testhub plans get',
      'testhub plans create',
      'testhub plans update',
      'testhub runs list',
      'testhub runs create',
      'testhub runs patch',
      'testhub runs bulk-create',
      'testhub runs bulk-update',
      'testhub runs bulk',
      'testhub runs history list',
      'testhub runs history get',
      'testhub runs relation list',
      'testhub runs relation get',
      'testhub runs relation add',
      'testhub runs relation delete',
      'testhub runs comment list',
      'testhub runs comment get',
      'testhub runs comment add',
      'testhub runs comment delete',
      'testhub runs attachment list',
      'testhub runs attachment get',
      'testhub runs attachment add-snippet',
      'testhub runs attachment delete',
      'testhub runs activity list',
      'testhub runs activity get',
      'testhub meta case-states',
      'testhub meta case-types',
      'testhub meta important-levels',
      'testhub meta run-statuses',
      'testhub meta plan-types',
      'testhub meta plan-states',
      'testhub meta case-properties',
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

  it('offers no `replace` leaf for the one PUT in the module', () => {
    // `PUT /v1/testhub/runs/{run_id}` is the module's only PUT and it stays out of the
    // refined layer (design D8.4): a full replacement forces the whole `steps[]` array
    // and blanks the executor when `executor_id` is omitted ([TH§7]). Asserted per
    // group rather than globally — S1d's rule is that each group owns its own list, so
    // this names the only two update spellings testhub is allowed to have.
    const updateLeaves = leavesOf('testhub').filter((path) =>
      /\b(update|patch|replace|put)$/.test(path),
    );
    expect(updateLeaves).toEqual([
      'testhub cases update',
      'testhub cases bulk-update',
      'testhub plans update',
      'testhub runs patch',
      'testhub runs bulk-update',
    ]);
  });

  it('exposes no leaf for the simple run and case lists', () => {
    // `GET /v1/testhub/{cases,runs}` are reachable only through `pingcode api`
    // (`endpoints.ts`): the case list does not even require a `library_id`, so
    // unfiltered it scans every visible library, and the docs redirect to `…/search`.
    // `cases list` / `runs list` are the search endpoints, which is what their help says.
    expect(fullHelpFor(['testhub', 'cases', 'list'])).toContain('/v1/testhub/cases/search');
    expect(fullHelpFor(['testhub', 'runs', 'list'])).toContain('/v1/testhub/runs/search');
    expect(leavesOf('testhub')).not.toContain('testhub runs get');
  });

  it('documents the upstream-missing symmetry where a reader would look for it', () => {
    // Three asymmetries that are facts about the API, not gaps in the CLI. Each is
    // stated at the leaf a user would reach for, so nobody has to discover it by
    // getting a 404 or, worse, a silent 200.
    //
    //  1. no per-case history detail path — a row is a run history record;
    //  2. no library delete, so a created library is permanent;
    //  3. the two `cases/bulk` halves accept `suite_id` and land nothing.
    expect(fullHelpFor(['testhub', 'cases', 'history'])).toMatch(/no `history get`/);
    expect(fullHelpFor(['testhub', 'cases', 'bulk-create'])).toMatch(/LANDS NOTHING/);
    expect(fullHelpFor(['testhub', 'libraries', 'create'])).toMatch(/no library delete|permanent/i);
  });

  it('warns that a case delete takes its runs with it', () => {
    // The one destructive leaf in the module, and its blast radius is wider than its
    // name: verified live, deleting a case removes its runs from every plan.
    const help = fullHelpFor(['testhub', 'cases', 'delete']);
    expect(help).toMatch(/CASCADES to its runs/);
    expect(help).toContain('--yes');
  });

  it('separates the two bulk-run halves by their opposite failure semantics', () => {
    // The finding most likely to bite a script author: the create half reports
    // per-element failures inside a 200, the update half rejects the whole batch.
    expect(fullHelpFor(['testhub', 'runs', 'bulk-create'])).toMatch(/PER-ELEMENT BEST EFFORT/);
    expect(fullHelpFor(['testhub', 'runs', 'bulk-update'])).toMatch(/ATOMIC/);
  });

  it('disambiguates the three vocabularies called "state" in this module', () => {
    // plan state ≠ case state ≠ run result, and all three are reachable from `meta`.
    const help = fullHelpFor(['testhub', 'meta', 'plan-states']);
    expect(help).toContain('meta case-states');
    expect(help).toContain('meta run-statuses');
  });

  it('warns that most case-property keys are not --set keys', () => {
    const help = fullHelpFor(['testhub', 'meta', 'case-properties']);
    expect(help).toMatch(/HTTP 500/);
    // And says where the missing signal *can* be read, rather than inventing a column
    // from fields the library-scoped view does not return.
    expect(help).toContain('/v1/testhub/case_properties');
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

  it('testhub cases bulk-create', () => {
    expect(helpFor(['testhub', 'cases', 'bulk-create'])).toMatchSnapshot();
  });

  it('testhub cases bulk-update', () => {
    expect(helpFor(['testhub', 'cases', 'bulk-update'])).toMatchSnapshot();
  });

  it('testhub plans', () => {
    expect(helpFor(['testhub', 'plans'])).toMatchSnapshot();
  });

  it('testhub plans update', () => {
    expect(helpFor(['testhub', 'plans', 'update'])).toMatchSnapshot();
  });

  it('testhub runs', () => {
    expect(helpFor(['testhub', 'runs'])).toMatchSnapshot();
  });

  it('testhub runs bulk-update', () => {
    expect(helpFor(['testhub', 'runs', 'bulk-update'])).toMatchSnapshot();
  });

  it('testhub meta', () => {
    expect(helpFor(['testhub', 'meta'])).toMatchSnapshot();
  });
});
