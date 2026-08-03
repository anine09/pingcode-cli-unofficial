import { describe, expect, it } from 'vitest';
import { helpFor, leavesOf, subgroupsOf } from './tree';

/**
 * `scm` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/scm.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3). S1a creates
 * both; S1b (branches, commits, refs) extends them, and S1c (pull requests, code
 * reviews) extends them again.
 *
 * When you add a leaf: extend the list, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 */

/** `--help` with commander's hard wrapping undone, for asserting on a phrase. */
function flowingHelp(path: string[]): string {
  return helpFor(path).replace(/\s+/g, ' ');
}

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
      'scm branch list',
      'scm branch get',
      'scm branch create',
      'scm branch update',
      'scm branch delete',
      'scm commit list',
      'scm commit get',
      'scm commit create',
      'scm ref list',
      'scm ref get',
      'scm ref create',
    ]);
  });

  it('registers exactly these subgroups', () => {
    expect(subgroupsOf('scm')).toEqual([
      'scm platform',
      'scm platform-user',
      'scm repo',
      'scm branch',
      'scm commit',
      'scm ref',
    ]);
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
  it('offers no replace/put leaf for any scm PUT endpoint', () => {
    const leaves = leavesOf('scm');
    expect(leaves.filter((leaf) => /\b(replace|put|overwrite)\b/i.test(leaf))).toEqual([]);
    // …and every `update` leaf that exists is a PATCH one. Four of them: platform,
    // platform-user, repo (whose PUT twins are excluded) and branch (which has no PUT
    // upstream at all — see below).
    expect(leaves.filter((leaf) => leaf.endsWith(' update'))).toEqual([
      'scm platform update',
      'scm platform-user update',
      'scm repo update',
      'scm branch update',
    ]);
  });

  /**
   * The branch family is shaped the *other* way round: a `DELETE` and no `PUT`
   * (design D12, [S§3.12.4]). Both halves of that are asserted, because both are
   * things a later contributor would plausibly "correct":
   *
   *  - adding `scm branch replace` to match the other five families — there is no
   *    upstream `PUT` to wrap, so it would be inventing an endpoint;
   *  - adding `delete` to the other families to match this one — upstream has none,
   *    which `test/scm.test.ts` asserts against the catalog.
   */
  it('gives branch the only delete leaf in the group, and no replace', () => {
    const leaves = leavesOf('scm');
    expect(leaves.filter((leaf) => leaf.endsWith(' delete'))).toEqual(['scm branch delete']);
    expect(leaves).not.toContain('scm branch replace');
  });

  /**
   * Design D8.2: `--all` is a paging flag and belongs to `list` alone. A delete must
   * not be able to spell a bulk deletion, and the enforcement is structural —
   * `addPagingOptions` is simply not applied, so commander rejects `--all` as unknown.
   */
  it('registers no --all on the delete leaf', () => {
    expect(helpFor(['scm', 'branch', 'delete'])).not.toContain('--all');
    expect(helpFor(['scm', 'branch', 'delete'])).toContain('--yes');
  });

  it('offers --default as a bare switch, never as a true|false value', () => {
    // The server refuses `is_default: false` on PATCH (400 `100005`, "值不为true"), so a
    // value flag here could only ever spell a guaranteed rejection — unlike
    // `scm repo --private`, which is deliberately three-state.
    for (const leaf of [['scm', 'branch', 'create'], ['scm', 'branch', 'update']]) {
      const help = helpFor(leaf);
      expect(help, leaf.join(' ')).toContain('--default');
      expect(help, leaf.join(' ')).not.toMatch(/--default <'/);
      expect(help, leaf.join(' ')).not.toMatch(/--default <bool>/);
    }
  });

  it('takes no --platform on the commit leaves, because commits are org-level', () => {
    // Design D12.6: `/v1/scm/commits` has no platform in its path. Every other leaf in
    // the group requires one, so the absence is worth pinning rather than trusting.
    for (const leaf of [['scm', 'commit', 'list'], ['scm', 'commit', 'get'], ['scm', 'commit', 'create']]) {
      expect(helpFor(leaf), leaf.join(' ')).not.toContain('--platform');
    }
    // …while the branch and ref leaves, which are repository-scoped, all do.
    for (const leaf of [['scm', 'branch', 'list'], ['scm', 'ref', 'list']]) {
      expect(helpFor(leaf), leaf.join(' ')).toContain('--platform');
      expect(helpFor(leaf), leaf.join(' ')).toContain('--repo');
    }
  });

  it('warns in --help that --sender creates an identity but --committer does not', () => {
    // Design D12.1: the upsert is on the branch, not the commit. Getting this backwards
    // in the docs is worse than omitting it, so both directions are asserted.
    //
    // Matched against whitespace-collapsed help, because commander hard-wraps option
    // descriptions at the terminal width — asserting on the raw string would pin where
    // the line happens to break, which is not the contract and would fail on a resize.
    expect(flowingHelp(['scm', 'branch', 'create'])).toContain(
      'an UNKNOWN name is CREATED as a platform user',
    );
    expect(flowingHelp(['scm', 'commit', 'create'])).toContain(
      'unlike branch --sender this creates no platform user',
    );
  });

  it('says the commit reference may be a SHA, and that an abbreviated one is not', () => {
    const help = helpFor(['scm', 'commit', 'get']);
    expect(help).toContain('SHA');
    expect(help).toContain('abbreviated');
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

  it('scm branch', () => {
    expect(helpFor(['scm', 'branch'])).toMatchSnapshot();
  });

  it('scm branch create', () => {
    expect(helpFor(['scm', 'branch', 'create'])).toMatchSnapshot();
  });

  it('scm branch update', () => {
    expect(helpFor(['scm', 'branch', 'update'])).toMatchSnapshot();
  });

  it('scm branch delete', () => {
    expect(helpFor(['scm', 'branch', 'delete'])).toMatchSnapshot();
  });

  it('scm commit', () => {
    expect(helpFor(['scm', 'commit'])).toMatchSnapshot();
  });

  it('scm commit create', () => {
    expect(helpFor(['scm', 'commit', 'create'])).toMatchSnapshot();
  });

  it('scm ref', () => {
    expect(helpFor(['scm', 'ref'])).toMatchSnapshot();
  });

  it('scm ref create', () => {
    expect(helpFor(['scm', 'ref', 'create'])).toMatchSnapshot();
  });
});
