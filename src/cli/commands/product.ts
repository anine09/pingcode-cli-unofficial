import type { Command } from 'commander';
import { getProduct, iterateProducts, listProducts, type ProductListQuery } from '../../api/ship';
import { resolveProduct } from '../../core/metadata';
import { collect } from '../../core/paginate';
import type { ShipProduct } from '../../types/api';
import { addGlobalOptions } from '../globals';
import type { Column } from '../output';
import {
  addPagingOptions,
  contextFor,
  modeOf,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refName,
  requireFlag,
  timestampCell,
  type PagingFlags,
} from './common';

/**
 * `pingcode product list|get` — `GET /v1/ship/products[/{id}]` (ship §A).
 *
 * A product is the parent of everything else in ship: `state_id`, `priority_id`,
 * `suite_id`, `type_id`, `channel_id`, the `properties` keys and the assignee
 * candidate set are all resolved inside one product, so this group is the first
 * call of any ship workflow.
 *
 * There is deliberately no `create`, `update` or `delete`: ship exposes no
 * product DELETE at all, and `PATCH` edits only three cosmetic fields
 * (ship GOTCHA #15/#17). Product governance stays in the console.
 */

type ListFlags = PagingFlags & {
  keywords?: string | undefined;
  includeArchived?: boolean | undefined;
  includeDeleted?: boolean | undefined;
};

type GetFlags = {
  includeArchived?: boolean | undefined;
  includeDeleted?: boolean | undefined;
};

export const PRODUCT_COLUMNS: Column<ShipProduct>[] = [
  { header: 'IDENTIFIER', value: (p) => p.identifier ?? '' },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
  { header: 'VISIBILITY', value: (p) => p.visibility ?? '' },
  { header: 'ID', value: (p) => p.id },
];

export function registerProductCommands(program: Command): void {
  const product = program
    .command('product')
    .description('ship products 产品 (scope pcp:read:ship:product)');

  addGlobalOptions(
    addPagingOptions(
      product
        .command('list')
        .description('list products')
        .option('--keywords <text>', 'search product names (the identifier is NOT searchable)')
        .option('--include-archived', 'include archived products')
        .option('--include-deleted', 'include deleted products'),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    product
      .command('get')
      .description('show one product, including its members')
      .argument('<product>', 'product name, identifier such as SLC, or id')
      .option('--include-archived', 'allow an archived product to be returned')
      .option('--include-deleted', 'allow a deleted product to be returned'),
    { hidden: true },
  ).action(async (target: string, flags: GetFlags, command: Command) => {
    await runGet(target, flags, command);
  });
}

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const query: ProductListQuery = {
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
    ...(flags.includeArchived === true ? { include_archived: true } : {}),
    ...(flags.includeDeleted === true ? { include_deleted: true } : {}),
  };

  if (paging.all) {
    const values = await collect(
      iterateProducts(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, PRODUCT_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listProducts(ctx, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, PRODUCT_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: GetFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const resolved = await resolveProduct(ctx, requireFlag(target, '<product>'));
  const product = await getProduct(ctx, resolved.id, {
    ...(flags.includeArchived === true ? { include_archived: true } : {}),
    ...(flags.includeDeleted === true ? { include_deleted: true } : {}),
  });

  printResource(
    product,
    [
      ['name', product.name ?? ''],
      ['identifier', product.identifier ?? ''],
      ['id', product.id],
      ['visibility', product.visibility ?? ''],
      ['scope', product.scope_type ?? ''],
      ['members', String(product.members.length)],
      ['owner', refName(product.created_by)],
      ['archived', product.is_archived ? 'yes' : 'no'],
      ['created', timestampCell(product.created_at)],
      ['updated', timestampCell(product.updated_at)],
      ['url', product.url ?? ''],
      ['description', product.description ?? ''],
    ],
    modeOf(ctx),
  );
}
