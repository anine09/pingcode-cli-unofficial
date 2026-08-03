import type { Command } from 'commander';
import { registerBranchCommands } from './branch';
import { registerCommitCommands } from './commit';
import { registerPlatformCommands } from './platform';
import { registerPlatformUserCommands } from './platformUser';
import { registerPullRequestCommands } from './pullRequest';
import { registerRefCommands } from './ref';
import { registerRepoCommands } from './repo';
import { registerReviewCommands } from './review';

/**
 * `pingcode scm …` — 源码管理, the DevOps write-back surface ([S§3.12]).
 *
 * S1a lands the foundation: 托管平台 (`platform`), its git identities
 * (`platform-user`) and its 代码仓库 (`repo`). S1b adds the CI write-back path on top
 * of that chain — 代码分支 (`branch`), 提交 (`commit`) and 提交引用 (`ref`) — and S1c
 * completes the module with 拉取请求 (`pr`) and 代码评审 (`review`). All six documented
 * families are now refined; nothing in `/v1/scm/**` is generic-layer-only except the
 * five `PUT`s.
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
 *  - **No `replace`, ever.** Five of the six families here document a `PUT` that
 *    replaces the whole record — and therefore blanks every field the caller did not
 *    send. Design D8.4 keeps all ten of this API's `PUT`s out of the refined layer;
 *    they remain reachable through `pingcode api PUT <path>`, where the caller is
 *    explicitly opting into a full replacement.
 *
 * Three shape irregularities worth knowing before reading the leaves, all upstream and
 * all verified live (2026-08-03, design D11–D13):
 *
 *  - **代码分支 is the one family with a `DELETE` and no `PUT`** — the mirror image of
 *    the other five. So `scm branch delete` exists and no `scm branch replace` ever
 *    can, and neither fact generalises to its siblings. Everything else written
 *    through this group is **permanent**.
 *  - **提交 is organisation-level**: `/v1/scm/commits` carries no platform and no
 *    repository, so `scm commit …` is the only subgroup here that takes no
 *    `--platform`. Linking a commit to a branch is a separate resource, `scm ref`.
 *  - **代码评审 is not the cross-object `/v1/reviews` resource.** `scm review` is a
 *    review event on one pull request; `/v1/reviews` is a polymorphic 评审 object
 *    addressed by `principal_type` + `pilot_id` and reachable only through
 *    `pingcode api`. They share a word and nothing else — see `review.ts`.
 *
 * The four cross-object families (`relation` / `comment` / `attachment` /
 * `activity`) are deliberately **not** mounted here: a platform, a git identity, a
 * repository, a pull request and a code review are not `principal_type` values the
 * generic layer accepts (design D5.2's table is a list of measured facts, and none of
 * these appear in it).
 */
export function registerScmCommands(program: Command): void {
  const scm = program
    .command('scm')
    // Reworded by S1c, the last of the three scm children, as one deliberate change to
    // `test/help/root.test.ts.snap`. S1a wrote the line while only three families
    // existed and S1b left it alone (and reverted its own edit) to keep that shared
    // snapshot byte-identical while two children were in flight — at the cost of a
    // description that named half the group. Now that the module is complete the fix is
    // to stop enumerating families altogether: the wording describes the *purpose*, so
    // it stays correct as the surface grows, and `scm --help` plus `modules/scm.md`
    // remain the accurate inventory.
    .description(
      '源码管理 scm: the DevOps write-back surface for code hosting data ' +
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
  registerPullRequestCommands(scm);
  registerReviewCommands(scm);
}
