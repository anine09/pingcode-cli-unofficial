import type { Command } from 'commander';
import { registerApiCommands } from './commands/api';
import { registerAuthCommands } from './commands/auth';
import { registerBuildCommands } from './commands/build';
import { registerProductCommands } from './commands/product';
import { registerProjectCommands } from './commands/project';
import { registerReleaseCommands } from './commands/release';
import { registerResolveCommands } from './commands/resolve';
import { registerScmCommands } from './commands/scm';
import { registerSelfUpdateCommands } from './commands/selfUpdate';
import { registerSettingsCommands } from './commands/settings';
import { registerTesthubCommands } from './commands/testhub';

/**
 * The command-group registry — the single line a new group has to touch.
 *
 * Before F1, adding a group meant editing `program.ts` (an import plus a call) *and*
 * the hardcoded group array in `test/help.test.ts`. The second half is what actually
 * serialised the work: every parallel child would have had to edit the same
 * assertion. Now `program.ts` iterates this array and `test/help/root.test.ts`
 * asserts the tree equals `GROUPS.map(([name]) => name)` — **self-satisfying**, so it
 * never needs editing again (design D6.2, PRD A3).
 *
 * That assertion still earns its place: it proves the registry and the commander tree
 * agree, so a `register*` that is listed here but never actually attaches its group
 * (or attaches it under a different name) fails the suite instead of silently
 * disappearing from `--help`.
 *
 * **Order is the user-visible `--help` order** and it is deliberate: `auth` first
 * because nothing works without credentials, then the business groups in the GUI's
 * own module order (产品管理 → 项目管理 → 测试管理 → 源码管理 → 构建与部署), then
 * `settings` last. S1d added the last two DevOps groups (`build`, `release`) after
 * `scm`, which was exactly the two rows this comment predicted — and the only source
 * change either group needed outside its own files.
 *
 * The `name` column is not decoration: it is what root's assertion compares against,
 * so it must match the name the `register*` function gives its top-level command.
 */
export const GROUPS: readonly (readonly [string, (program: Command) => void])[] = [
  ['auth', registerAuthCommands],
  ['api', registerApiCommands],
  ['resolve', registerResolveCommands],
  ['product', registerProductCommands],
  ['project', registerProjectCommands],
  ['testhub', registerTesthubCommands],
  ['scm', registerScmCommands],
  ['build', registerBuildCommands],
  ['release', registerReleaseCommands],
  ['settings', registerSettingsCommands],
  ['self-update', registerSelfUpdateCommands],
];
