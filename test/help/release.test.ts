import { describe, expect, it } from 'vitest';
import { commandAt, helpFor, leavesOf, program, subgroupsOf } from './tree';

/**
 * `release` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/release.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a leaf
 * here cannot conflict with another group's child (design D6.3). S1d creates both.
 *
 * The most important assertion in this file is the one about **DELETE**. The two
 * `DELETE` endpoints of this area exist and work; they are unwrapped because they are
 * out of the task's scope, not because the API lacks them. That is the opposite of scm's
 * situation, and getting the two confused in either direction misleads the reader — so
 * both halves are pinned: no `delete` leaf, and the group help naming the generic-layer
 * route.
 */

/**
 * `--help` **including** any `addHelpText('after')` block, which `helpInformation()`
 * omits — and this group's trailing paragraph is where the verb asymmetry lives.
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
function flowingHelp(path: readonly string[]): string {
  return fullHelp(path).replace(/\s+/g, ' ');
}

function optionsOf(path: readonly string[]): string[] {
  return commandAt(program(), path).options.map((option) => option.long ?? option.short ?? '');
}

describe('release command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('release')).toEqual([
      'release env list',
      'release env get',
      'release env create',
      'release env update',
      'release deploy list',
      'release deploy get',
      'release deploy create',
      'release deploy update',
    ]);
  });

  it('registers exactly these subgroups, configuration before events', () => {
    // `env` first because a deploy cannot exist without one — the same
    // parent-resource-first ordering `scm` uses.
    expect(subgroupsOf('release')).toEqual(['release env', 'release deploy']);
  });

  /**
   * Design D8.4: **no `PUT` may get a refined leaf.** Both families document one, and
   * both replace the whole record — so both are reachable only through the generic layer.
   */
  it('offers no replace/put leaf for either PUT, and names the fallback', () => {
    const leaves = leavesOf('release');
    expect(leaves.filter((leaf) => /\b(replace|put|overwrite)\b/i.test(leaf))).toEqual([]);
    expect(leaves).not.toContain('release env replace');
    expect(leaves).not.toContain('release deploy replace');
    // …and the two `update` leaves that exist are the PATCH ones.
    expect(leaves.filter((leaf) => leaf.endsWith(' update'))).toEqual([
      'release env update',
      'release deploy update',
    ]);
    expect(flowingHelp(['release'])).toContain(
      'pingcode api PUT /v1/release/{environments,deploys}/<id>',
    );
  });

  /**
   * The asymmetry this group has to be explicit about, and the reason it differs from
   * every other "missing verb" in the CLI so far.
   *
   * scm has no `DELETE` at all: nothing written through it can ever be removed. Here both
   * `DELETE`s exist and were verified working live (2026-08-04) — they are simply out of
   * this task's scope. "The API cannot do it" and "this CLI does not wrap it yet" lead a
   * caller to opposite conclusions, so the help must say which one it is.
   */
  it('has no delete leaf, but says in --help that the endpoints exist and how to reach them', () => {
    expect(leavesOf('release').filter((leaf) => leaf.endsWith(' delete'))).toEqual([]);

    const help = flowingHelp(['release']);
    expect(help).toContain('EXISTS upstream and works');
    expect(help).toContain('pingcode api DELETE /v1/release/deploys/<id> --yes');
    expect(help).toContain('/v1/release/environments/<id> --yes');
    // …including the reason the environment delete can be refused, which is the one
    // thing that would otherwise look like a bug in the escape hatch.
    expect(help).toContain('refuses while any deploy still references it');
  });

  it('takes no --project and no --product anywhere: both families are org-level', () => {
    for (const leaf of leavesOf('release')) {
      const path = leaf.split(' ');
      const flags = optionsOf(path);
      expect(flags, leaf).not.toContain('--project');
      expect(flags, leaf).not.toContain('--product');
      expect(flags, leaf).not.toContain('--platform');
    }
  });

  it('offers the --env / --env-id pair exactly where an environment is addressable', () => {
    // A deploy names its environment where it can be *filtered* or *set*, and nowhere
    // else: `deploy get` takes an id, and the environment subgroup addresses its own rows
    // positionally.
    for (const leaf of [
      ['release', 'deploy', 'list'],
      ['release', 'deploy', 'create'],
    ]) {
      const flags = optionsOf(leaf);
      expect(flags, leaf.join(' ')).toContain('--env');
      expect(flags, leaf.join(' ')).toContain('--env-id');
    }
    expect(optionsOf(['release', 'deploy', 'get'])).not.toContain('--env');
    expect(optionsOf(['release', 'env', 'get'])).not.toContain('--env');
  });

  it('offers no --env on deploy update, because env_id is echoed and then ignored', () => {
    // The nastiest live finding of this child (2026-08-04): `PATCH …/deploys/{id}` with an
    // `env_id` answers 200 **and echoes the new environment in the response**, while a
    // following `GET` still shows the old one. Verified twice, through the CLI and through
    // raw HTTP, with and without a `status` alongside it.
    //
    // So the flag is not offered at all — a write that reports success and changes nothing
    // is the same lie as a filter that silently matches everything (design D11.2), and here
    // the echo actively defeats the "read it back" habit. Both halves are pinned: the flags
    // are gone, and `--help` says why, since "why can I not move a deploy" is the obvious
    // next question.
    const flags = optionsOf(['release', 'deploy', 'update']);
    expect(flags).not.toContain('--env');
    expect(flags).not.toContain('--env-id');
    expect(flowingHelp(['release', 'deploy', 'update'])).toContain('CANNOT be changed');
  });

  it('warns that a deploy window has to be moved end-first', () => {
    // `100102 开始时间必须小于等于已存在的结束时间`: a new `start_at` is validated against the
    // **stored** `end_at`, not against the `end_at` in the same request — so moving a
    // window forward takes two calls in a fixed order. Nothing the CLI can fix; everything
    // it can document.
    expect(flowingHelp(['release', 'deploy', 'update'])).toContain('--end-at FIRST');
  });

  it('exposes no dead filter on the deploy list', () => {
    // Live 2026-08-04: `?status=`, `?release_name=` and `?work_item_id=` were probed and
    // silently ignored; only `?env_id=` filters. A flag for the others would look like it
    // worked (design D11.2).
    const flags = optionsOf(['release', 'deploy', 'list']);
    for (const absent of ['--status', '--release-name', '--work-item-id', '--work-item']) {
      expect(flags, absent).not.toContain(absent);
    }
    expect(flags).toEqual(expect.arrayContaining(['--env', '--env-id', '--page', '--all']));
  });

  it('warns that an unknown --env-id reads as an empty list, not an error', () => {
    // The same silence-is-the-failure-mode trap as `scm review list` under an unknown
    // `--pr-id` (design D13): 200 with zero rows, so no override can make it exit 5.
    expect(flowingHelp(['release', 'deploy', 'list'])).toContain('EMPTY LIST, not an error');
  });

  it('says an environment name is a real filter and unique per organisation', () => {
    expect(flowingHelp(['release', 'env', 'list'])).toContain('exact (case-insensitive)');
    expect(flowingHelp(['release', 'env'])).toContain('unique per organisation');
  });

  it('says html_url cannot be cleared, because the API refuses an empty value', () => {
    // Live 2026-08-04: `html_url: ""` is 400 `100003` (`不是URL格式`), so a link can be
    // replaced but never removed — a one-way door worth naming before someone scripts it.
    expect(flowingHelp(['release', 'env', 'update'])).toContain('cannot be cleared');
  });

  it('requires the fields the API requires on both creates, and no more', () => {
    // `option.mandatory` is commander's `requiredOption` flag; `option.required` only
    // means the option takes a value.
    const mandatory = (path: readonly string[]): string[] =>
      commandAt(program(), path)
        .options.filter((option) => option.mandatory)
        .map((option) => option.long ?? '')
        .sort();

    expect(mandatory(['release', 'env', 'create'])).toEqual(['--name']);
    // Six for a deploy — and `--env` is deliberately **not** among them: it is enforced
    // in the action (`requireEnvironmentFlag`) because either half of the `--env` /
    // `--env-id` pair satisfies it, which `requiredOption` cannot express.
    expect(mandatory(['release', 'deploy', 'create'])).toEqual([
      '--duration',
      '--end-at',
      '--release-name',
      '--start-at',
      '--status',
    ]);
  });

  it('quotes the two-value deploy enum without enforcing it', () => {
    // There is no failed or rolled-back state upstream; a rollback is another deploy.
    expect(flowingHelp(['release', 'deploy', 'create'])).toContain('not_deployed | deployed');
    expect(flowingHelp(['release', 'deploy', 'update'])).toContain('not_deployed | deployed');
  });

  it('says a deploy is addressed by id, because release_name is not a key', () => {
    expect(flowingHelp(['release', 'deploy', 'get'])).toContain('free text and not a key');
  });

  it('carries no ghost-identity warning, because nothing here upserts one', () => {
    // No `*_name` reference field exists in either family, so scm's warning would be
    // asserting a hazard that does not exist (design D12.1).
    for (const leaf of [
      ['release', 'env', 'create'],
      ['release', 'deploy', 'create'],
      ['release', 'deploy', 'update'],
    ]) {
      expect(flowingHelp(leaf), leaf.join(' ')).not.toContain('CREATED as a platform user');
    }
  });

  it('warns that an unknown --work-item is ignored rather than rejected', () => {
    for (const leaf of [
      ['release', 'deploy', 'create'],
      ['release', 'deploy', 'update'],
    ]) {
      expect(flowingHelp(leaf), leaf.join(' ')).toContain('silently ignored');
    }
    expect(flowingHelp(['release', 'deploy', 'update'])).toContain('REPLACES the existing links');
  });

  it('says in --help that the group is enterprise-token-only and shares one scope pair', () => {
    const help = fullHelp(['release']);
    expect(help).toContain('企业令牌');
    expect(help).toContain('pcp:read:devops:deploy');
    expect(help).toContain('pcp:write:devops:deploy');
    // There is no `devops:release` scope, and no environment-specific one either.
    expect(help).not.toContain('devops:release');
    expect(help).not.toContain('devops:build');
  });
});

describe('release --help', () => {
  it('release', () => {
    expect(fullHelp(['release'])).toMatchSnapshot();
  });

  it('release env', () => {
    expect(helpFor(['release', 'env'])).toMatchSnapshot();
  });

  it('release env list', () => {
    expect(helpFor(['release', 'env', 'list'])).toMatchSnapshot();
  });

  it('release env create', () => {
    expect(helpFor(['release', 'env', 'create'])).toMatchSnapshot();
  });

  it('release env update', () => {
    expect(helpFor(['release', 'env', 'update'])).toMatchSnapshot();
  });

  it('release deploy', () => {
    expect(helpFor(['release', 'deploy'])).toMatchSnapshot();
  });

  it('release deploy list', () => {
    expect(helpFor(['release', 'deploy', 'list'])).toMatchSnapshot();
  });

  it('release deploy create', () => {
    expect(helpFor(['release', 'deploy', 'create'])).toMatchSnapshot();
  });

  it('release deploy update', () => {
    expect(helpFor(['release', 'deploy', 'update'])).toMatchSnapshot();
  });
});
