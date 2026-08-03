import type { Command } from 'commander';
import { registerPlatformCommands } from './platform';
import { registerPlatformUserCommands } from './platformUser';
import { registerRepoCommands } from './repo';

/**
 * `pingcode scm …` — 源码管理, the DevOps write-back surface ([S§3.12]).
 *
 * S1a lands the foundation: 托管平台 (`platform`), its git identities
 * (`platform-user`) and its 代码仓库 (`repo`). Branches, commits and commit refs
 * (S1b) and pull requests and code reviews (S1c) hang off the same platform →
 * repository chain and register themselves here, one line each.
 *
 * Three group-wide facts, so no leaf has to repeat them:
 *
 *  - **企业令牌 only.** Every endpoint in this area rejects a user token; the CLI's
 *    `client_credentials` flow holds an enterprise token, so the whole group is
 *    reachable out of the box. Scopes: `pcp:read:devops:code` /
 *    `pcp:write:devops:code`.
 *  - **An scm platform is not a ship product**, even though both live under a
 *    `products` path segment. `pingcode product …` is 产品管理; this is a code
 *    hosting server record.
 *  - **No `replace`, ever.** Each of the three families documents a `PUT` that
 *    replaces the whole record — and therefore blanks every field the caller did
 *    not send. Design D8.4 keeps all ten of this API's `PUT`s out of the refined
 *    layer; they remain reachable through `pingcode api PUT <path>`, where the
 *    caller is explicitly opting into a full replacement.
 *
 * The four cross-object families (`relation` / `comment` / `attachment` /
 * `activity`) are deliberately **not** mounted here: a platform, a git identity and
 * a repository are not `principal_type` values the generic layer accepts (design
 * D5.2's table is a list of measured facts, and none of these appear in it).
 */
export function registerScmCommands(program: Command): void {
  const scm = program
    .command('scm')
    .description(
      '源码管理 scm: hosting platforms, git identities, repositories ' +
        '(企业令牌 only, scopes pcp:read:devops:code / pcp:write:devops:code)',
    );

  // Registration order is the `--help` order and is asserted by
  // `test/help/scm.test.ts`: the parent resource first, then what hangs off it.
  registerPlatformCommands(scm);
  registerPlatformUserCommands(scm);
  registerRepoCommands(scm);
}
