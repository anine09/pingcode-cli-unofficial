import { describe, expect, it } from 'vitest';
import { helpFor, leavesOf, subgroupsOf } from './tree';

/**
 * `scm` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/scm.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3). S1a creates
 * both; S1b (branches, commits, refs) and S1c (pull requests, code reviews) extend
 * the list below and add their own snapshots.
 *
 * When you add a leaf: extend the list, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 */

describe('scm command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('scm')).toEqual([
      'scm platform list',
      'scm platform get',
      'scm platform create',
      'scm platform update',
      'scm platform-user list',
      'scm platform-user get',
      'scm platform-user create',
      'scm platform-user update',
      'scm repo list',
      'scm repo get',
      'scm repo create',
      'scm repo update',
    ]);
  });

  it('registers exactly these subgroups', () => {
    expect(subgroupsOf('scm')).toEqual(['scm platform', 'scm platform-user', 'scm repo']);
  });

  /**
   * Design D8.4, made mechanical: **no `PUT` may get a refined leaf.**
   *
   * All three families S1a covers document a fifth verb —
   * `PUT /v1/scm/products/{id}`, `…/users/{id}`, `…/repositories/{id}` — that
   * replaces the whole record and therefore blanks every field the caller omitted.
   * The API never documents what clearing a field does, and testhub proved live that
   * a `PUT` twin destroys data its `PATCH` sibling preserves ([TH§7]), so the verb is
   * reachable only through `pingcode api PUT <path>`, where the caller has explicitly
   * asked for a full replacement.
   *
   * This is asserted rather than merely written down because "the update command
   * looks incomplete" is exactly the kind of gap a later contributor closes helpfully.
   */
  it('offers no replace/put leaf for the three PUT endpoints', () => {
    const leaves = leavesOf('scm');
    expect(leaves.filter((leaf) => /\b(replace|put|overwrite)\b/i.test(leaf))).toEqual([]);
    // …and the three `update` leaves that exist are the PATCH ones.
    expect(leaves.filter((leaf) => leaf.endsWith(' update'))).toHaveLength(3);
  });

  it('says in --help that the group is enterprise-token-only and names its scopes', () => {
    // The one thing an agent cannot discover by trying: these endpoints reject a user
    // token outright, and the CLI's client_credentials token is the right one.
    const help = helpFor(['scm']);
    expect(help).toContain('企业令牌');
    expect(help).toContain('pcp:read:devops:code');
    expect(help).toContain('pcp:write:devops:code');
  });

  it('offers --full-name and not --name on repo list', () => {
    // Upstream ignores `?name=` on the repository list (live 2026-08-03), so exposing
    // it would be a filter that silently returns everything.
    const help = helpFor(['scm', 'repo', 'list']);
    expect(help).toContain('--full-name');
    expect(help).not.toMatch(/--name </);
  });
});

describe('scm --help', () => {
  it('scm', () => {
    expect(helpFor(['scm'])).toMatchSnapshot();
  });

  it('scm platform', () => {
    expect(helpFor(['scm', 'platform'])).toMatchSnapshot();
  });

  it('scm platform create', () => {
    expect(helpFor(['scm', 'platform', 'create'])).toMatchSnapshot();
  });

  it('scm platform-user', () => {
    expect(helpFor(['scm', 'platform-user'])).toMatchSnapshot();
  });

  it('scm platform-user create', () => {
    expect(helpFor(['scm', 'platform-user', 'create'])).toMatchSnapshot();
  });

  it('scm repo', () => {
    expect(helpFor(['scm', 'repo'])).toMatchSnapshot();
  });

  it('scm repo create', () => {
    expect(helpFor(['scm', 'repo', 'create'])).toMatchSnapshot();
  });
});
