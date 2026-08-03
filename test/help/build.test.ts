import { describe, expect, it } from 'vitest';
import { commandAt, helpFor, leavesOf, program, subgroupsOf } from './tree';

/**
 * `build` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/build.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3). S1d creates both,
 * and this group has exactly one owner — there is no second child coming for it.
 *
 * The assertions worth having here are the **absences**, because every one of them is a
 * plausible-looking improvement that would be wrong:
 *
 *  - no `replace` leaf (design D8.4);
 *  - no filter flags on `list`, because upstream honours none;
 *  - no `--all` on `delete`, so a bulk deletion cannot be spelled (design D8.2);
 *  - no ghost-identity warning, because unlike scm nothing here upserts an identity.
 */

/**
 * `--help` **including** any `addHelpText('after')` block.
 *
 * `helpInformation()` (what `helpFor` uses) silently omits it, so the group's trailing
 * paragraph — where the two verb asymmetries are stated — would be invisible to both the
 * assertions and the snapshot. Same helper `test/help/resolve.test.ts` needs, for the
 * same reason.
 */
function fullHelp(path: readonly string[]): string {
  const command = commandAt(program(), path);
  let text = '';
  command.configureOutput({
    writeOut: (chunk) => {
      text += chunk;
    },
  });
  command.outputHelp();
  return text;
}

/** `--help` with commander's hard wrapping undone, for asserting on a phrase. */
function flowingHelp(path: string[]): string {
  return fullHelp(path).replace(/\s+/g, ' ');
}

/**
 * The long flags a leaf actually registers.
 *
 * Distinct from grepping `--help`: a description may legitimately *mention* a flag that
 * belongs to a different leaf, and a text search cannot tell the two apart.
 */
function optionsOf(path: string[]): string[] {
  return commandAt(program(), path).options.map((option) => option.long ?? option.short ?? '');
}

describe('build command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('build')).toEqual([
      'build list',
      'build get',
      'build create',
      'build update',
      'build delete',
    ]);
  });

  it('has no subgroups: one family, five leaves directly under the group', () => {
    // 构建记录 is a single resource, so there is nothing to nest. Pinned because the
    // sibling group (`release`) *does* nest, and matching its shape "for consistency"
    // would invent a level the API does not have.
    expect(subgroupsOf('build')).toEqual([]);
  });

  /**
   * Design D8.4, made mechanical: **no `PUT` may get a refined leaf.**
   *
   * `PUT /v1/build/builds/{id}` replaces the whole record, so it blanks every field the
   * caller omitted — and this API never documents what clearing a field does. It stays
   * reachable through `pingcode api PUT <path>`, where the caller has explicitly asked
   * for a full replacement.
   */
  it('offers no replace/put leaf for the build PUT', () => {
    const leaves = leavesOf('build');
    expect(leaves.filter((leaf) => /\b(replace|put|overwrite)\b/i.test(leaf))).toEqual([]);
    expect(leaves).not.toContain('build replace');
    // …and the one `update` leaf that exists is the PATCH one.
    expect(leaves.filter((leaf) => leaf.endsWith(' update'))).toEqual(['build update']);
  });

  it('names the generic-layer fallback for the excluded PUT in --help', () => {
    // An excluded verb has to say where it went, or the exclusion reads as an absence.
    expect(flowingHelp(['build'])).toContain('pingcode api PUT /v1/build/builds/<id>');
  });

  /**
   * Design D8.2: `--all` is a paging flag and belongs to `list` alone. A delete must not
   * be able to spell a bulk deletion, and the enforcement is structural —
   * `addPagingOptions` is simply not applied, so commander rejects `--all` as unknown.
   */
  it('gates delete behind --yes and never lets it take --all', () => {
    const help = fullHelp(['build', 'delete']);
    expect(help).toContain('--yes');
    expect(help).not.toContain('--all');
    expect(optionsOf(['build', 'delete'])).not.toContain('--all');
    // One delete leaf, and only one.
    expect(leavesOf('build').filter((leaf) => leaf.endsWith(' delete'))).toEqual(['build delete']);
  });

  it('offers no filter flag on list, because upstream honours none', () => {
    // Live 2026-08-04: `?identifier=`, `?name=`, `?status=`, `?provider=` and
    // `?work_item_id=` were each probed and silently ignored — every row came back every
    // time. A flag for any of them would be a filter that appears to work (design D11.2).
    const flags = optionsOf(['build', 'list']);
    for (const absent of ['--identifier', '--name', '--status', '--provider', '--work-item-id']) {
      expect(flags, absent).not.toContain(absent);
    }
    // …only the paging flags, which do work.
    expect(flags).toEqual(expect.arrayContaining(['--page', '--page-size', '--all', '--limit']));
    // …and the help says so, because an empty flag list looks like an oversight.
    expect(flowingHelp(['build', 'list'])).toContain('NO filters');
  });

  it('takes no parent flag anywhere, because build records are organisation-level', () => {
    // Design D14: no platform, repository or project appears in either path. Same shape
    // as `scm commit`, and worth pinning rather than trusting — every scm leaf but that
    // one requires a `--platform`.
    for (const leaf of [
      ['build', 'list'],
      ['build', 'get'],
      ['build', 'create'],
      ['build', 'update'],
      ['build', 'delete'],
    ]) {
      const flags = optionsOf(leaf);
      expect(flags, leaf.join(' ')).not.toContain('--platform');
      expect(flags, leaf.join(' ')).not.toContain('--project');
    }
  });

  it('requires the seven fields the API requires on create, and no more', () => {
    // All seven are genuinely mandatory upstream (400 `100008` otherwise), including
    // `--duration`, which the server never derives from the timestamps. A flag that is
    // optional but can never be omitted successfully is the same lie as a dead filter —
    // the judgement S1c applied to `--source-branch-id`.
    const create = commandAt(program(), ['build', 'create']);
    // `option.mandatory` is commander's flag for `requiredOption`; `option.required`
    // only means the option takes a value (`<x>`), which every one of these does.
    const required = create.options
      .filter((option) => option.mandatory)
      .map((option) => option.long);
    expect(required.sort()).toEqual([
      '--duration',
      '--end-at',
      '--identifier',
      '--name',
      '--provider',
      '--start-at',
      '--status',
    ]);
  });

  it('quotes both enums without enforcing either', () => {
    const create = flowingHelp(['build', 'create']);
    expect(create).toContain('bamboo | bitbucket | jenkins | other');
    expect(create).toContain('success | failure');
    // The mid-run status update is the reason `update` exists at all, so it says so.
    expect(flowingHelp(['build', 'update'])).toContain('success | failure');
  });

  it('says the build number is not a lookup key', () => {
    // Live 2026-08-04: two builds were created with `identifier: "9001"` and both were
    // accepted. With no list filter either, an id is the only address a build has — so
    // `<build>` must not read as "the build number".
    expect(flowingHelp(['build', 'get'])).toContain('not the build number');
    expect(flowingHelp(['build', 'create'])).toContain('NOT unique');
  });

  it('carries no ghost-identity warning, because nothing here upserts one', () => {
    // scm's `--sender` / `--owner-name` / `--creator` / `--reviewer` mint a permanent
    // 托管平台用户 from a typo (design D12.1, D13.1). No field in this family is a
    // `*_name` reference, so repeating that warning here would assert a hazard that does
    // not exist — which D12.1 says is exactly as wrong as omitting a real one.
    for (const leaf of [['build', 'create'], ['build', 'update']]) {
      expect(flowingHelp(leaf), leaf.join(' ')).not.toContain('CREATED as a platform user');
    }
  });

  it('warns that an unknown --work-item is ignored rather than rejected', () => {
    // The one silent-failure mode this family does have (live 2026-08-04, same as scm).
    for (const leaf of [['build', 'create'], ['build', 'update']]) {
      expect(flowingHelp(leaf), leaf.join(' ')).toContain('silently ignored');
    }
    // …and update additionally replaces rather than merges.
    expect(flowingHelp(['build', 'update'])).toContain('REPLACES the existing links');
  });

  it('says in --help that the group is enterprise-token-only and names its own scopes', () => {
    // `devops:build`, not scm's `devops:code`: a token that can write commits cannot
    // write builds, and the only symptom is a bare 403.
    const help = fullHelp(['build']);
    expect(help).toContain('企业令牌');
    expect(help).toContain('pcp:read:devops:build');
    expect(help).toContain('pcp:write:devops:build');
    expect(help).not.toContain('devops:code');
  });
});

describe('build --help', () => {
  it('build', () => {
    expect(fullHelp(['build'])).toMatchSnapshot();
  });

  it('build list', () => {
    expect(helpFor(['build', 'list'])).toMatchSnapshot();
  });

  it('build create', () => {
    expect(helpFor(['build', 'create'])).toMatchSnapshot();
  });

  it('build update', () => {
    expect(helpFor(['build', 'update'])).toMatchSnapshot();
  });

  it('build delete', () => {
    expect(helpFor(['build', 'delete'])).toMatchSnapshot();
  });
});
