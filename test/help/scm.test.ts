import { describe, expect, it } from 'vitest';
import { commandAt, helpFor, leavesOf, program, subgroupsOf } from './tree';

/**
 * `scm` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/scm.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3). S1a creates
 * both; S1b (branches, commits, refs) extends them, and S1c (pull requests, code
 * reviews) extends them again — and, being the last scm child, is also where the
 * group's `root.test.ts.snap` description was finally reworded (see `scm/index.ts`).
 *
 * When you add a leaf: extend the list, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 */

/** `--help` with commander's hard wrapping undone, for asserting on a phrase. */
function flowingHelp(path: string[]): string {
  return helpFor(path).replace(/\s+/g, ' ');
}

/**
 * The long flags a leaf actually registers.
 *
 * Distinct from grepping `--help`: a description may legitimately *mention* a flag
 * that belongs to a different leaf (`scm pr get` points at `scm pr list --number`), and
 * a text search cannot tell the two apart.
 */
function optionsOf(path: string[]): string[] {
  return commandAt(program(), path).options.map((option) => option.long ?? option.short ?? '');
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
      'scm pr list',
      'scm pr get',
      'scm pr create',
      'scm pr update',
      'scm review list',
      'scm review get',
      'scm review create',
      'scm review update',
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
      'scm pr',
      'scm review',
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
    // …and every `update` leaf that exists is a PATCH one. Six of them: platform,
    // platform-user, repo, pr and review (whose PUT twins are all excluded) and branch
    // (which has no PUT upstream at all — see below).
    expect(leaves.filter((leaf) => leaf.endsWith(' update'))).toEqual([
      'scm platform update',
      'scm platform-user update',
      'scm repo update',
      'scm branch update',
      'scm pr update',
      'scm review update',
    ]);
  });

  /**
   * S1c's two families, named individually — the assertion above is a pattern match and
   * would still pass if `pr replace` were spelled `pr overwrite-all`. These two are the
   * last `PUT`s in the module, and the pull request's is the most tempting to wrap,
   * because a caller who wants to change several fields at once will read `PUT` as "the
   * bulk update". It is not: a replacement that omits a description silently clears it,
   * which is the whole reason D8.4 keeps every `PUT` out of the refined layer.
   *
   * An earlier revision of this comment made a sharper claim — that `PUT` promotes
   * `source_branch_id` to required where `POST` leaves it optional. The S1c live smoke
   * falsified it: `POST` requires that field too (`100224`), so the two verbs agree and
   * the general "replacement blanks what you omit" argument is the one that carries.
   */
  it('offers no replace leaf for the pull request or the code review either', () => {
    const leaves = leavesOf('scm');
    expect(leaves).not.toContain('scm pr replace');
    expect(leaves).not.toContain('scm review replace');
    // The endpoints are in the catalog, so `pingcode api PUT …` still reaches them:
    // excluding a verb from the refined layer is a UX decision, not a capability
    // removal. (`test/scm.test.ts` asserts the catalog side against the wire paths.)
    expect(leaves.filter((leaf) => leaf.startsWith('scm pr '))).toEqual([
      'scm pr list',
      'scm pr get',
      'scm pr create',
      'scm pr update',
    ]);
    expect(leaves.filter((leaf) => leaf.startsWith('scm review '))).toEqual([
      'scm review list',
      'scm review get',
      'scm review create',
      'scm review update',
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
  /**
   * Design D13: a review is addressed three parents deep and the API offers no
   * repository-wide list, so `--pr-id` is required on **every** review leaf rather than
   * being an optional filter on some of them. Asserted because "make the list work
   * without a pull request" is a plausible-looking improvement that would have to
   * fabricate a result set by looping.
   */
  it('requires --pr-id on every review leaf, because reviews have no wider list', () => {
    for (const leaf of [
      ['scm', 'review', 'list'],
      ['scm', 'review', 'get'],
      ['scm', 'review', 'create'],
      ['scm', 'review', 'update'],
    ]) {
      const help = flowingHelp(leaf);
      expect(help, leaf.join(' ')).toContain('--pr-id <id>');
      expect(help, leaf.join(' ')).toContain('--platform');
      expect(help, leaf.join(' ')).toContain('--repo');
    }
  });

  it('says a pull request is addressed by id and found by number', () => {
    // There is no `identifier` and no `short_id` in scm, so `--number` is a *list*
    // filter and the positional is an id. Accepting either would mean guessing
    // client-side whether a string "looks like a number", which is the id
    // shape-validation the quality spec forbids.
    //
    // Asserted against the registered options rather than the help text, because
    // `get`'s help mentions `scm pr list --number <n>` on purpose — telling the caller
    // where the id comes from is the whole point of taking an id.
    expect(optionsOf(['scm', 'pr', 'list'])).toContain('--number');
    expect(optionsOf(['scm', 'pr', 'get'])).not.toContain('--number');
    expect(flowingHelp(['scm', 'pr', 'get'])).toContain('pull request id');
  });

  it('tells the reader that an omitted --status is read back and re-sent', () => {
    // The pull request PATCH is the only one in scm with a mandatory field, so an
    // omitted `--status` means one extra GET rather than a request with a missing
    // field — and that has to be visible in `--help`, not just in the code.
    const help = flowingHelp(['scm', 'pr', 'update']);
    expect(help).toContain('the CURRENT status is read back');
    expect(help).toContain('open | closed | merged | abandoned');
  });

  it('quotes both status enums without enforcing either', () => {
    expect(flowingHelp(['scm', 'pr', 'create'])).toContain('open | closed | merged | abandoned');
    expect(flowingHelp(['scm', 'review', 'create'])).toContain(
      'comment | approved | request_changes',
    );
  });

  /**
   * The `/v1/reviews` confusion is the one trap of this family that no amount of
   * `--help` reading would otherwise dispel, so the group description carries it.
   */
  it('warns in the review group description that this is not /v1/reviews', () => {
    expect(flowingHelp(['scm'])).toContain('not the /v1/reviews object');
    expect(flowingHelp(['scm', 'review'])).toContain('not the /v1/reviews object');
  });

  /**
   * G3: an upstream gap has to be visible where the user is, not only in the module
   * document. scm has exactly one `DELETE` (branch), so a pull request and a review are
   * permanent once written — and that is worth saying in the two group descriptions,
   * because the natural assumption from every other CLI is that a create can be undone.
   */
  it('says in --help that pull requests and reviews cannot be deleted', () => {
    expect(flowingHelp(['scm', 'pr'])).toMatch(/no delete/i);
    expect(flowingHelp(['scm', 'review'])).toMatch(/no delete/i);
    // …and the group still has exactly one delete leaf, the branch one.
    expect(leavesOf('scm').filter((leaf) => leaf.endsWith(' delete'))).toEqual([
      'scm branch delete',
    ]);
  });

  it('marks every irreversible create as PERMANENT, not just the two group descriptions', () => {
    // G3 closeout, extending the test above. The `pr` / `review` groups already said it,
    // but the five `create` leaves for resources scm cannot delete at all said nothing —
    // so `scm repo create --owner-name` could mint an undeletable ghost identity on a typo
    // with no warning anywhere near the flag. pjm's `project create` established the
    // spelling (`PERMANENT: there is no delete …`); these reuse it verbatim so the word is
    // greppable across groups.
    //
    // NOTE the premise this corrects, because a brief for this batch asserted otherwise:
    // scm is NOT delete-free. It has exactly one DELETE, `scm branch delete`, asserted
    // above. What these five share is that *their own* resource has none.
    for (const leaf of [
      ['scm', 'platform', 'create'],
      ['scm', 'repo', 'create'],
      ['scm', 'platform-user', 'create'],
      ['scm', 'commit', 'create'],
      ['scm', 'ref', 'create'],
    ]) {
      expect(flowingHelp(leaf), leaf.join(' ')).toContain('PERMANENT');
    }
    // The one create that is reversible must NOT claim to be permanent.
    expect(flowingHelp(['scm', 'branch', 'create'])).not.toContain('PERMANENT');
  });

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

  it('carries the same upsert warning on the three pull-request and review name fields', () => {
    // S1c smoke (design D13.1 item 3): `creator_name`, `merged_by_name` and
    // `reviewer_name` all upsert a platform user, verified in one call by passing two
    // distinguishable unknown names and watching both appear. Every entry point that can
    // mint a permanent identity has to say so, or the warning on `branch create` reads as
    // if it were the only one.
    expect(flowingHelp(['scm', 'pr', 'create'])).toContain(
      'an UNKNOWN name is CREATED as a platform user',
    );
    expect(flowingHelp(['scm', 'review', 'create'])).toContain(
      'an UNKNOWN name is CREATED as a platform user',
    );
    // …including on the update paths, which can set the same fields.
    expect(flowingHelp(['scm', 'pr', 'update'])).toContain(
      'an UNKNOWN name is CREATED as a platform user',
    );
    expect(flowingHelp(['scm', 'review', 'update'])).toContain(
      'an UNKNOWN name is CREATED as a platform user',
    );
  });

  it('requires both branch ids on pr create, because the live API requires both', () => {
    // The catalog says `source_branch_id` is optional on POST; the server says
    // `100224 源分支是必填字段` (S1c smoke). Live wins, so the flag is required rather
    // than being an optional flag that can never be omitted successfully.
    const help = helpFor(['scm', 'pr', 'create']);
    expect(help).toContain('--source-branch-id');
    expect(help).toContain('--target-branch-id');
    const usage = help.split('\n')[0] ?? '';
    expect(usage).not.toContain('[options]?');
    // Both appear above the optional block, i.e. commander lists them as required.
    expect(optionsOf(['scm', 'pr', 'create'])).toContain('--source-branch-id');
  });

  it('says an unknown --pr-id reads as an empty review list rather than an error', () => {
    // The one scm child list that hides a missing parent: GET
    // …/pull_requests/{unknown}/reviews returns 200 with no rows, where a missing
    // platform or repository yields 100200/100202 (S1c smoke). Silence is the failure
    // mode here, so the help has to name it.
    expect(flowingHelp(['scm', 'review', 'list'])).toContain('empty list');
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

  it('scm pr', () => {
    expect(helpFor(['scm', 'pr'])).toMatchSnapshot();
  });

  it('scm pr create', () => {
    expect(helpFor(['scm', 'pr', 'create'])).toMatchSnapshot();
  });

  it('scm pr update', () => {
    expect(helpFor(['scm', 'pr', 'update'])).toMatchSnapshot();
  });

  it('scm review', () => {
    expect(helpFor(['scm', 'review'])).toMatchSnapshot();
  });

  it('scm review create', () => {
    expect(helpFor(['scm', 'review', 'create'])).toMatchSnapshot();
  });

  it('scm review update', () => {
    expect(helpFor(['scm', 'review', 'update'])).toMatchSnapshot();
  });
});
