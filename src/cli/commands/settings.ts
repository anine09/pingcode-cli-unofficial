import type { Command } from 'commander';
import { iterateUsers, listUsers, type UserListQuery } from '../../api/meta';
import { collect } from '../../core/paginate';
import type { User } from '../../types/api';
import { addGlobalOptions } from '../globals';
import type { Column } from '../output';
import {
  addPagingOptions,
  contextFor,
  modeOf,
  printCollection,
  readPaging,
  type PagingFlags,
} from './common';

/**
 * `pingcode settings …` — the 后台设置 module: organisation-wide directory data
 * that belongs to no single business module.
 *
 * `settings users` reads `GET /v1/directory/users` under
 * `pcp:read:global:team`, which is why it does not live under `product` or
 * `project`: it is org directory data, not pjm or ship data — even though its
 * ids are what `--assignee` resolves against in both.
 */

type UsersFlags = PagingFlags & { keywords?: string | undefined };

const USER_COLUMNS: Column<User>[] = [
  { header: 'ID', value: (u) => u.id },
  { header: 'NAME', value: (u) => u.display_name ?? u.name ?? '', flex: true },
  { header: 'USERNAME', value: (u) => u.username ?? '' },
  { header: 'EMAIL', value: (u) => u.email ?? '', flex: true },
];

export function registerSettingsCommands(program: Command): void {
  const settings = program
    .command('settings')
    .description('后台设置: organisation-wide directory data');

  addGlobalOptions(
    addPagingOptions(
      settings
        .command('users')
        .description('organisation members (scope pcp:read:global:team)')
        .option('--keywords <text>', 'fuzzy search over name and username'),
    ),
    { hidden: true },
  ).action(async (flags: UsersFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const paging = readPaging(flags);
    const query: UserListQuery = {
      ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
    };

    if (paging.all) {
      const values = await collect(
        iterateUsers(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
      );
      printCollection(values, USER_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listUsers(ctx, query, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    // Lookup commands all emit `{values,count}` in --json, even this paginated one,
    // so an agent never has to branch on which lookup it asked for
    // (research/s8-smoke.md, cosmetic nits). `--page`/`--page-size` still control
    // the request itself.
    printCollection(page.values, USER_COLUMNS, modeOf(ctx));
  });
}
