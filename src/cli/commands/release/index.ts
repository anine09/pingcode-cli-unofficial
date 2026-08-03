import type { Command } from 'commander';
import { registerDeployCommands } from './deploy';
import { registerEnvironmentCommands } from './environment';

/**
 * `pingcode release …` — 环境 and 部署 ([S§3.12.9-10]), the deployment write-back
 * surface a CD pipeline calls after it ships.
 *
 * Two subgroups, one scope pair, and a shape worth stating up front: **an environment
 * is standing configuration and a deploy is an event.** `release env` is a short list
 * of named targets an organisation edits rarely; `release deploy` grows by one row
 * every time something ships. That difference is why only the environment is
 * name-resolvable (`--env production`) while a deploy is addressed by id.
 *
 * Three group-wide facts, so no leaf repeats them:
 *
 *  - **企业令牌 only**, under `pcp:read:devops:deploy` / `pcp:write:devops:deploy` —
 *    **one** pair for both subgroups. There is no separate environment scope, so a
 *    token that can record a deploy can also create the environment it names.
 *  - **Both families are organisation-level.** No project, product or repository
 *    anywhere; a deploy names its environment through `--env`, and reaches work items
 *    only through `--work-item`.
 *  - **Neither subgroup has a `delete` or a `replace` leaf, and the reasons differ.**
 *    The two `PUT`s are excluded permanently (design D8.4: a replacement blanks every
 *    field it is not sent). The two `DELETE`s, by contrast, **do exist upstream and do
 *    work** — they are simply out of this task's scope, pending a decision on whether
 *    the CLI should offer them at all. Both are reachable meanwhile:
 *
 *      pingcode api DELETE /v1/release/environments/<id> --yes
 *      pingcode api DELETE /v1/release/deploys/<id> --yes
 *
 *    That asymmetry is stated here rather than left to be discovered, because "there is
 *    no delete" and "the delete is not wrapped yet" are different facts and only one of
 *    them is true here.
 *
 * One genuinely reassuring live finding (2026-08-04), worth knowing before using the
 * escape hatch above: **the server refuses to delete an environment a deploy still
 * references** (400 `100106`, `'environment'正在使用，不能被删除`), and accepts it once
 * those deploys are gone. This is the opposite of the scm branch hazard, where deleting
 * a parent orphaned its commit refs and left a permanent HTTP 500 behind (design D12.5).
 * Nothing in `release` can be orphaned.
 */
export function registerReleaseCommands(program: Command): void {
  const release = program
    .command('release')
    .description(
      '构建与部署 release: deploy targets 环境 and deployment records 部署 ' +
        '(企业令牌 only, scopes pcp:read:devops:deploy / pcp:write:devops:deploy)',
    )
    // The verb asymmetry, where the reader is. `addHelpText` rather than a longer
    // `.description()`, which is what root `--help` prints for the group.
    //
    // Saying it here matters more than it did for scm, because the two facts point in
    // *opposite* directions: scm genuinely has no delete, while release has two that
    // work. "Not offered by this CLI yet" and "not offered by the API" are different
    // answers, and a user who assumes the wrong one either gives up or files a bug.
    .addHelpText(
      'after',
      '\nBoth families are organisation-level: no --project and no --product anywhere. A deploy\n' +
        'names its environment with --env, and reaches work items only through --work-item.\n' +
        'Neither subgroup has `replace` or `delete`, for different reasons:\n' +
        '  · PUT is excluded on purpose — it blanks every field it is not sent. Use\n' +
        '    `pingcode api PUT /v1/release/{environments,deploys}/<id>` if you mean it.\n' +
        '  · DELETE, by contrast, EXISTS upstream and works; it is simply not wrapped yet.\n' +
        '    `pingcode api DELETE /v1/release/deploys/<id> --yes` removes a deploy, and\n' +
        '    `… /v1/release/environments/<id> --yes` an environment — which the server\n' +
        '    refuses while any deploy still references it, so nothing here can be orphaned.\n',
    );

  // Registration order is the `--help` order and is asserted by
  // `test/help/release.test.ts`: the environment first, because a deploy needs one.
  registerEnvironmentCommands(release);
  registerDeployCommands(release);
}
