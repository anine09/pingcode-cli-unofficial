import type { Command } from 'commander';
import { registerCaseCommands } from './cases';
import { registerLibraryCommands } from './libraries';
import { registerTesthubMetaCommands } from './meta';
import { registerPlanCommands } from './plans';
import { registerRunCommands } from './runs';

/**
 * `pingcode testhub …` — the 测试管理 module, mirroring the GUI's grouping and
 * the shape `product` already established: the parent resource first, then the
 * resources that hang off it, then the id lookups every write needs.
 *
 * **Split by resource in S3** (design D6.5). The single file had reached 1865
 * lines, and the split was done as its own behaviour-neutral commit before any new
 * leaf was added: `--help` is byte-for-byte unchanged across it, proven by
 * `test/help/testhub.test.ts` and its snapshot passing unmodified. The shape
 * mirrors `scm/`, including where the shared helpers live — the bootstrap resource
 * (`libraries.ts`, like `scm/platform.ts`) owns the flag-pair machinery and the
 * parent hop, so there is no sixth "shared" file.
 *
 * Five facts from `design.md` shape the whole module:
 *
 *  - **A library is the bootstrap hop.** `state_id`, `type_id`, `status_id`, the
 *    suite tree and the plan list are all library-scoped (design §5), so
 *    `--library <name|id>` is resolved *once* at the top of an action and the
 *    resolved id is handed down to every other resolver. The one exception is
 *    importance levels, which are genuinely org-level and take no library.
 *  - **Search is the read path.** `cases list` and `runs list` are
 *    `POST …/search`; the plain `GET /v1/testhub/{cases,runs}` lists are never
 *    called (design §2).
 *  - **Writes take `*_id`, reads return objects.** Every name-resolvable field
 *    is a `--x` / `--x-id` pair: `--x` resolves, `--x-id` is sent verbatim, and
 *    the two are mutually exclusive (design §6).
 *  - **`PATCH /runs/{id}` is a read-modify-write.** `status_id` is required even
 *    on PATCH, and the executor has to be carried over by hand (GOTCHA #7/#8).
 *    `runs patch` therefore always reads the run first, always sends
 *    `status_id`, and re-sends the run's executor unless the run has none
 *    (design §7).
 *  - **Arrays replace, they never merge.** `steps[]` and `properties` overwrite
 *    wholesale, and a step that arrives without its `step_id` is re-created with
 *    a new one, orphaning its history (GOTCHA #9). Nothing here synthesises a
 *    step: a partial step edit is refused with the full list of steps rather
 *    than guessed at.
 *
 * Deliberately not exposed: `PUT /runs/{id}` — a full replacement that blanks the
 * executor when `executor_id` is omitted ([TH§7]), the general rule for all ten of
 * this API's `PUT`s (design D8.4). Reach it, if you really mean it, with
 * `pingcode api PUT /v1/testhub/runs/<id>`.
 */
export function registerTesthubCommands(program: Command): void {
  const testhub = program
    .command('testhub')
    .description(
      '测试管理 testhub: libraries 测试库, cases 用例, plans 测试计划, runs 执行用例 ' +
        '(scopes pcp:read:testhub:testcase / :testplan / :configuration)',
    );

  // Registration order is the `--help` order and is asserted by
  // `test/help/testhub.test.ts`: the parent resource first, then what hangs off
  // it, then the lookups.
  registerLibraryCommands(testhub);
  registerCaseCommands(testhub);
  registerPlanCommands(testhub);
  registerRunCommands(testhub);
  registerTesthubMetaCommands(testhub);
}
