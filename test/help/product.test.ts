import { describe, expect, it } from 'vitest';
import { fullHelpFor, helpFor, leavesOf, subgroupsOf } from './tree';

/**
 * `product` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/product.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3).
 *
 * When you add a leaf: extend the list below, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 */

/**
 * `--help` **including the trailing prose**, with commander's hard wrapping undone, for
 * asserting on a phrase rather than on where the terminal width happens to break a line
 * (same reason as `test/help/scm.test.ts`'s helper of the same name).
 *
 * `fullHelpFor`, not `helpFor`, because the group-level warnings this file asserts live in
 * `addHelpText('after')` epilogs. That is not incidental: a group *description* is also
 * rendered in `pingcode --help`, so putting a multi-line warning there would reflow the
 * root listing that `test/help/__snapshots__/root.test.ts.snap` pins.
 */
function flowingHelp(path: string[]): string {
  return fullHelpFor(path).replace(/\s+/g, ' ');
}

describe('product command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('product')).toEqual([
      'product list',
      'product get',
      'product idea list',
      'product idea get',
      'product idea create',
      'product idea update',
      'product idea history list',
      'product idea history get',
      'product idea relation list',
      'product idea relation get',
      'product idea relation add',
      'product idea relation delete',
      'product idea comment list',
      'product idea comment get',
      'product idea comment add',
      'product idea comment delete',
      'product idea attachment list',
      'product idea attachment get',
      'product idea attachment add-snippet',
      'product idea attachment delete',
      'product idea activity list',
      'product idea activity get',
      'product ticket list',
      'product ticket get',
      'product ticket create',
      'product ticket update',
      'product ticket transition',
      'product ticket relation list',
      'product ticket relation get',
      'product ticket relation add',
      'product ticket relation delete',
      'product ticket comment list',
      'product ticket comment get',
      'product ticket comment add',
      'product ticket comment delete',
      'product ticket attachment list',
      'product ticket attachment get',
      'product ticket attachment add-snippet',
      'product ticket attachment delete',
      'product ticket activity list',
      'product ticket activity get',
      'product plan list',
      'product plan get',
      'product meta idea-states',
      'product meta idea-priorities',
      'product meta idea-suites',
      'product meta idea-properties',
      'product meta idea-plans',
      'product meta members',
      'product meta ticket-states',
      'product meta ticket-priorities',
      'product meta ticket-types',
      'product meta ticket-channels',
      'product meta ticket-properties',
      'product meta ticket-customers',
      'product meta ticket-solutions',
      'product meta ticket-tags',
    ]);
  });

  it('registers exactly these subgroups', () => {
    expect(subgroupsOf('product')).toEqual([
      'product idea',
      'product ticket',
      'product plan',
      'product meta',
    ]);
  });
});

describe('product --help', () => {
  it('product', () => {
    expect(helpFor(['product'])).toMatchSnapshot();
  });

  it('product idea', () => {
    expect(helpFor(['product', 'idea'])).toMatchSnapshot();
  });

  it('product ticket', () => {
    expect(helpFor(['product', 'ticket'])).toMatchSnapshot();
  });

  it('product meta', () => {
    expect(helpFor(['product', 'meta'])).toMatchSnapshot();
  });

  it('product idea list (the search filter surface)', () => {
    expect(helpFor(['product', 'idea', 'list'])).toMatchSnapshot();
  });

  it('product idea update (no --type: ship states are product-scoped)', () => {
    expect(helpFor(['product', 'idea', 'update'])).toMatchSnapshot();
  });

  it('product ticket create (--type is required by the API)', () => {
    expect(helpFor(['product', 'ticket', 'create'])).toMatchSnapshot();
  });

  it('product ticket list (the POST /search filter surface)', () => {
    expect(helpFor(['product', 'ticket', 'list'])).toMatchSnapshot();
  });

  it('product ticket transition (advisory: the server decides)', () => {
    expect(helpFor(['product', 'ticket', 'transition'])).toMatchSnapshot();
  });

  // These three use `fullHelpFor`: for all of them the trailing prose *is* the
  // contract — the three-way "plan" disambiguation, why a missing schedule exits 7,
  // and the fact that this endpoint accepts filters and then ignores them.
  it('product plan (需求排期: one of three unrelated things called a plan)', () => {
    expect(fullHelpFor(['product', 'plan'])).toMatchSnapshot();
  });

  it('product plan get (why a missing schedule exits 7, not 5)', () => {
    expect(fullHelpFor(['product', 'plan', 'get'])).toMatchSnapshot();
  });

  it('product idea history (state changes only, no filter flags)', () => {
    expect(fullHelpFor(['product', 'idea', 'history'])).toMatchSnapshot();
  });
});

/**
 * S4: the symmetric operations that do **not** exist upstream, asserted as absences.
 *
 * All five of the leaves S4 added are GETs, and that is not a scoping choice — every
 * write verb on both paths answers HTTP **405 Method Not Allowed** (live 2026-08-05,
 * design §D18). Ship has no delete for a product, a requirement or a ticket — its 8
 * `DELETE`s all remove configuration or membership rows, so nothing this group creates can
 * be undone. Without these rows a future child could quietly add a `plan create` that
 * cannot work.
 */
describe('product: the write leaves ship does not have', () => {
  it('offers no plan or history writes, because the routes answer 405', () => {
    const leaves = leavesOf('product');
    for (const forbidden of [
      'product plan create',
      'product plan update',
      'product plan delete',
      'product idea history create',
      'product idea history add',
      'product idea history delete',
    ]) {
      expect(leaves, forbidden).not.toContain(forbidden);
    }
  });

  it('offers no delete leaf anywhere in ship, and says so in the group description', () => {
    // The crosscutting subgroups are the exception and prove the rule — they are
    // `/v1/{relations,comments,attachments}`, not `/v1/ship/**`.
    const shipOwn = leavesOf('product').filter(
      (leaf) => !/ (relation|comment|attachment|activity) /.test(leaf),
    );
    expect(shipOwn.filter((leaf) => leaf.endsWith(' delete'))).toEqual([]);
    // G3 closeout: the absence has to be visible where the user is. Every pjm leaf that
    // creates something undeletable already said `PERMANENT`; this whole group did not,
    // even though an idea and a ticket are exactly that.
    expect(flowingHelp(['product'])).toContain('PERMANENT');
  });

  it('is precise about what the 8 ship DELETEs actually delete', () => {
    // Correcting the wording this file used to carry ("the module has no DELETE at all").
    // `api list --module ship --method DELETE` returns **8** rows — but every one of them
    // removes a configuration or membership row (a scheme member, a product member, a
    // suite, a tag, an external user, a state flow), never a product, a requirement or a
    // ticket. The leaf-level claim above is correct; the prose was not, and an agent that
    // believed the prose would not think to look for `DELETE …/products/{id}/members/{id}`.
    const group = flowingHelp(['product']);
    expect(group).toMatch(/configuration or membership row/);
    expect(group).not.toMatch(/no DELETE at all/);
  });

  it('keeps the update surface to exactly the two resources that have a PATCH', () => {
    expect(leavesOf('product').filter((leaf) => leaf.endsWith(' update'))).toEqual([
      'product idea update',
      'product ticket update',
    ]);
  });
});
