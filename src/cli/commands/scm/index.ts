import type { Command } from 'commander';
import { registerBranchCommands } from './branch';
import { registerCommitCommands } from './commit';
import { registerPlatformCommands } from './platform';
import { registerPlatformUserCommands } from './platformUser';
import { registerRefCommands } from './ref';
import { registerRepoCommands } from './repo';

/**
 * `pingcode scm …` — 源码管理, the DevOps write-back surface ([S§3.12]).
 *
 * S1a lands the foundation: 托管平台 (`platform`), its git identities
 * (`platform-user`) and its 代码仓库 (`repo`). S1b adds the CI write-back path on top
 * of that chain — 代码分支 (`branch`), 提交 (`commit`) and 提交引用 (`ref`) — and S1c's
 * pull requests and code reviews register themselves here the same way, one line each.
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
 *  - **No `replace`, ever.** Most families here document a `PUT` that replaces the
 *    whole record — and therefore blanks every field the caller did not send. Design
 *    D8.4 keeps all ten of this API's `PUT`s out of the refined layer; they remain
 *    reachable through `pingcode api PUT <path>`, where the caller is explicitly
 *    opting into a full replacement.
 *
 * Two shape irregularities worth knowing before reading the leaves, both upstream and
 * both verified live (2026-08-03, design D12):
 *
 *  - **代码分支 is the one family with a `DELETE` and no `PUT`** — the mirror image of
 *    the other five. So `scm branch delete` exists and no `scm branch replace` ever
 *    can, and neither fact generalises to its siblings.
 *  - **提交 is organisation-level**: `/v1/scm/commits` carries no platform and no
 *    repository, so `scm commit …` is the only subgroup here that takes no
 *    `--platform`. Linking a commit to a branch is a separate resource, `scm ref`.
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
      // Deliberately left as S1a wrote it, even though S1b adds three more resources:
      // this one line is what `test/help/root.test.ts.snap` pins, and that snapshot is a
      // shared coordination point across every parallel child. Rewording it to list six
      // families would make S1b and S1c both touch root's snapshot for a cosmetic gain,
      // and it would need rewording again with every family added. `scm --help` below
      // enumerates the subgroups accurately, and `modules/scm.md` documents them.
      '源码管理 scm: hosting platforms, git identities, repositories ' +
        '(企业令牌 only, scopes pcp:read:devops:code / pcp:write:devops:code)',
    );

  // Registration order is the `--help` order and is asserted by
  // `test/help/scm.test.ts`: the parent resource first, then what hangs off it.
  registerPlatformCommands(scm);
  registerPlatformUserCommands(scm);
  registerRepoCommands(scm);
  registerBranchCommands(scm);
  registerCommitCommands(scm);
  registerRefCommands(scm);
}
