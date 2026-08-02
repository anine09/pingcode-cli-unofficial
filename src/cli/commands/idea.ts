import type { Command } from 'commander';
import {
  createIdea,
  getIdea,
  iterateIdeas,
  listIdeaStates,
  searchIdeas,
  updateIdea,
  type CreateIdeaInput,
  type UpdateIdeaInput,
} from '../../api/ship';
import type { Ctx } from '../../core/context';
import { NotFoundError, PingcodeError, UsageError } from '../../core/errors';
import {
  resolveIdeaPriority,
  resolveIdeaProperty,
  resolveIdeaState,
  resolveIdeaSuite,
  resolveProduct,
  resolveProductMember,
  resolveShipRef,
  type ResolveResult,
  type ShipLocator,
} from '../../core/metadata';
import { collect, type SearchPayload } from '../../core/paginate';
import type { ShipIdea } from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import {
  addPagingOptions,
  addShipStateOptions,
  collectValue,
  contextFor,
  mergeFilters,
  modeOf,
  parseNumberFlag,
  parseSetFlags,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refFilter,
  refName,
  requireFlag,
  resolveShipStateFlags,
  runWrite,
  timestampCell,
  type PagingFlags,
  type PropertyAssignment,
  type ResolvedWrite,
  type StateFlags,
} from './common';

/**
 * `pingcode product idea list|get|create|update` — ship's 需求 (ship §J).
 *
 * Four rules from the design shape this file:
 *
 *  - **Search is the read path.** `idea list` is `POST /v1/ship/ideas/search`;
 *    `GET /v1/ship/ideas` is never called, because it cannot filter by assignee,
 *    suite, date or custom property (PRD D2).
 *  - **Everything resolves inside one product.** `--product` is required on
 *    `list` and `create`; on `update` the product comes from the idea itself.
 *  - **Replace, not merge.** Only the fields given are sent, and `properties`
 *    replaces wholesale. An empty patch is exit 2, raised here.
 *  - **No transition pre-validation.** Ship has no idea state-flow endpoint at
 *    all (ship GOTCHA #20), so an illegal state change can only be discovered by
 *    the server. On rejection the product's configured states are printed. This
 *    is the deliberate asymmetry with `ticket transition`, which *can* be
 *    validated locally.
 */

type ListFlags = PagingFlags &
  StateFlags & {
    product: string;
    priority?: string | undefined;
    assignee?: string | undefined;
    suite?: string | undefined;
    keywords?: string | undefined;
  };

type CreateFlags = {
  product: string;
  title: string;
  description?: string | undefined;
  assignee?: string | undefined;
  priority?: string | undefined;
  suite?: string | undefined;
  set?: string[] | undefined;
};

type UpdateFlags = StateFlags & {
  title?: string | undefined;
  description?: string | undefined;
  priority?: string | undefined;
  assignee?: string | undefined;
  suite?: string | undefined;
  progress?: string | undefined;
  set?: string[] | undefined;
};

const SET_HELP =
  'custom property, repeatable: --set key=value. Values for select-type properties are option ids, not labels. Replaces, never merges';

const SUITE_FILTER_CAVEAT =
  'filtering ideas by suite is undocumented: the API lists suite.id in neither the filterable ' +
  'nor the unfilterable set (ship §9.5), so verify the result rather than trusting an empty one';

export const IDEA_COLUMNS: Column<ShipIdea>[] = [
  { header: 'IDENTIFIER', value: (idea) => idea.identifier ?? idea.id },
  { header: 'TITLE', value: (idea) => idea.title ?? '', flex: true },
  { header: 'STATE', value: (idea) => refName(idea.state) },
  { header: 'PRIORITY', value: (idea) => refName(idea.priority) },
  { header: 'ASSIGNEE', value: (idea) => refName(idea.assignee) },
  { header: 'SUITE', value: (idea) => refName(idea.suite) },
];

export function registerIdeaCommands(parent: Command): void {
  const group = parent
    .command('idea')
    .description('ship requirements 需求 (scopes pcp:read:ship:idea / pcp:write:ship:idea)');

  addGlobalOptions(
    addShipStateOptions(
      addPagingOptions(
        group
          .command('list')
          .description('search ideas in a product (POST /v1/ship/ideas/search)')
          .requiredOption('--product <name|id>', 'product name, identifier or id')
          .option('--priority <name|id>', 'priority')
          .option('--assignee <name|id>', 'assignee — must be a member of this product')
          .option('--suite <name|id>', `requirement module 需求模块 — ${SUITE_FILTER_CAVEAT}`)
          .option('--keywords <text>', 'fuzzy search over identifier and title'),
      ),
      'filter by state',
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one idea')
      .argument('<idea>', 'id, identifier such as SLC-1, or a pasted idea URL'),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    await runGet(target, command);
  });

  addGlobalOptions(
    group
      .command('create')
      .description('create an idea (only --product and --title are required)')
      .requiredOption('--product <name|id>', 'product name, identifier or id')
      .requiredOption('--title <text>', 'title, max 255 characters')
      .option('--description <text>', 'description')
      .option('--assignee <name|id>', 'assignee — must be a member of this product')
      .option('--priority <name|id>', 'priority')
      .option('--suite <name|id>', 'requirement module 需求模块')
      .option('--set <key=value>', SET_HELP, collectValue),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    addShipStateOptions(
      group
        .command('update')
        .description('patch an idea — only the fields you pass are sent, and they replace')
        .argument('<idea>', 'id, identifier such as SLC-1, or a pasted idea URL')
        .option('--title <text>', 'new title')
        .option('--description <text>', 'new description (replaces the old one)')
        .option('--priority <name|id>', 'new priority')
        .option('--assignee <name|id>', 'new assignee')
        .option('--suite <name|id>', 'new requirement module')
        .option('--progress <n>', 'progress between 0 and 1, two decimal places')
        .option('--set <key=value>', SET_HELP, collectValue),
      'new state (validated by the server: ship has no idea state-flow endpoint)',
    ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });
}

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);

  const product = await resolveProduct(ctx, flags.product);
  const state = await resolveShipStateFlags(ctx, flags, 'ship-idea-state', (c, input) =>
    resolveIdeaState(c, product.id, input),
  );
  const priority =
    flags.priority === undefined
      ? undefined
      : await resolveIdeaPriority(ctx, product.id, flags.priority);
  const assignee =
    flags.assignee === undefined
      ? undefined
      : await resolveProductMember(ctx, product.id, flags.assignee);
  const suite =
    flags.suite === undefined ? undefined : await resolveIdeaSuite(ctx, product.id, flags.suite);

  if (suite !== undefined) ctx.logger.warn(SUITE_FILTER_CAVEAT);

  const payload: SearchPayload = {
    filter: mergeFilters([
      refFilter('product', product.id),
      refFilter('state', state?.id),
      refFilter('priority', priority?.id),
      refFilter('assignee', assignee?.id),
      refFilter('suite', suite?.id),
    ]),
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
  };

  if (paging.all) {
    const values = await collect(
      iterateIdeas(ctx, payload, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, IDEA_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await searchIdeas(ctx, payload, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, IDEA_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const locator = await resolveShipRef(ctx, 'idea', requireFlag(target, '<idea>'));
  if (locator.id === '') {
    throw new NotFoundError(`could not resolve "${target}" to an idea id`);
  }
  printIdea(await getIdea(ctx, locator.id), ctx);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const title = requireFlag(flags.title, '--title');
  const assignments = parseSetFlags(flags.set);

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<CreateIdeaInput>> => {
    const product = await resolveProduct(attemptCtx, flags.product);
    const assignee =
      flags.assignee === undefined
        ? undefined
        : await resolveProductMember(attemptCtx, product.id, flags.assignee);
    const priority =
      flags.priority === undefined
        ? undefined
        : await resolveIdeaPriority(attemptCtx, product.id, flags.priority);
    const suite =
      flags.suite === undefined
        ? undefined
        : await resolveIdeaSuite(attemptCtx, product.id, flags.suite);
    const properties = await resolveProperties(attemptCtx, product.id, assignments);

    const input: CreateIdeaInput = {
      product_id: product.id,
      title,
      ...(flags.description === undefined ? {} : { description: flags.description }),
      ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
      ...(priority === undefined ? {} : { priority_id: priority.id }),
      ...(suite === undefined ? {} : { suite_id: suite.id }),
      ...(properties.value === undefined ? {} : { properties: properties.value }),
    };

    return {
      resolutions: present([product, assignee, priority, suite, ...properties.resolutions]),
      value: input,
    };
  };

  const idea = await runWrite(ctx, resolve, (attemptCtx, input) => createIdea(attemptCtx, input));
  printIdea(idea, ctx, 'created');
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const progress = parseNumberFlag(flags.progress, '--progress');
  const assignments = parseSetFlags(flags.set);

  const scalarPatch: UpdateIdeaInput = {
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(progress === undefined ? {} : { progress }),
  };

  const wantsState =
    (flags.state !== undefined && flags.state.trim() !== '') ||
    (flags.stateId !== undefined && flags.stateId.trim() !== '');
  const wantsReference =
    wantsState ||
    flags.priority !== undefined ||
    flags.assignee !== undefined ||
    flags.suite !== undefined ||
    assignments.length > 0;

  // An empty PATCH is a usage error (exit 2), never a no-op round-trip.
  if (Object.keys(scalarPatch).length === 0 && !wantsReference) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint: 'pass at least one of --title / --description / --state / --state-id / --priority / --assignee / --suite / --progress / --set',
    });
  }

  // `PATCH` accepts the id only, so the reference is resolved first — which also
  // hands back the product every name lookup below needs.
  const locator = await resolveShipRef(ctx, 'idea', requireFlag(target, '<idea>'));
  if (locator.id === '') {
    throw new NotFoundError(`could not resolve "${target}" to an idea id`);
  }

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<UpdateIdeaInput>> => {
    const productId = locator.productId;
    if (wantsReference && (productId === undefined || productId === '')) {
      throw new UsageError(
        `the idea ${locator.identifier ?? locator.id} did not report a product, so names cannot be resolved`,
        { hint: 'pass ids directly (--state-id <id>) instead of names' },
      );
    }

    const state =
      productId === undefined
        ? undefined
        : await resolveShipStateFlags(attemptCtx, flags, 'ship-idea-state', (c, input) =>
            resolveIdeaState(c, productId, input),
          );
    const priority =
      flags.priority === undefined || productId === undefined
        ? undefined
        : await resolveIdeaPriority(attemptCtx, productId, flags.priority);
    const assignee =
      flags.assignee === undefined || productId === undefined
        ? undefined
        : await resolveProductMember(attemptCtx, productId, flags.assignee);
    const suite =
      flags.suite === undefined || productId === undefined
        ? undefined
        : await resolveIdeaSuite(attemptCtx, productId, flags.suite);
    const properties = await resolveProperties(attemptCtx, productId, assignments);

    const patch: UpdateIdeaInput = {
      ...scalarPatch,
      ...(state === undefined ? {} : { state_id: state.id }),
      ...(priority === undefined ? {} : { priority_id: priority.id }),
      ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
      ...(suite === undefined ? {} : { suite_id: suite.id }),
      ...(properties.value === undefined ? {} : { properties: properties.value }),
    };

    return {
      resolutions: present([state, priority, assignee, suite, ...properties.resolutions]),
      value: patch,
    };
  };

  try {
    const idea = await runWrite(ctx, resolve, (attemptCtx, patch) =>
      updateIdea(attemptCtx, locator.id, patch),
    );
    printIdea(idea, ctx, 'updated');
  } catch (error) {
    if (wantsState) await explainIdeaStates(ctx, locator, error);
    throw error;
  }
}

/**
 * Ship has **no idea state-flow endpoint** (ship GOTCHA #20), so there is nothing
 * to pre-validate against: an illegal transition can only be discovered by
 * sending it. The least we can do on rejection is name the states the product
 * actually has — the server message rarely does.
 */
async function explainIdeaStates(
  ctx: Ctx,
  locator: ShipLocator,
  error: unknown,
): Promise<void> {
  if (!(error instanceof PingcodeError)) return;
  if (!['api', 'usage', 'not_found', 'permission'].includes(error.kind)) return;
  const productId = locator.productId;
  if (productId === undefined) return;

  try {
    const states = await listIdeaStates(ctx, productId);
    if (states.length === 0) return;
    const listed = states.map((state) => `${state.name ?? '(unnamed)'} (${state.id})`).join(', ');
    ctx.logger.warn(
      `states configured for this product: ${listed}. ` +
        `Current state: ${locator.stateName ?? '(unknown)'}. ` +
        'Ship publishes no idea state-flow endpoint, so which transitions are legal is only ' +
        'knowable by trying them.',
    );
  } catch {
    // Best effort: never mask the original failure with a lookup failure.
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export type ResolvedProperties = {
  value: Record<string, unknown> | undefined;
  resolutions: ResolveResult[];
};

/**
 * Turn `--set key=value` into a `properties` object, resolving each key against
 * the product's property view — the authoritative list of writable keys, and the
 * only place the option ids of a select-typed property are visible
 * (ship GOTCHA #4/#5/#6).
 */
export async function resolvePropertiesWith(
  ctx: Ctx,
  productId: string | undefined,
  assignments: PropertyAssignment[],
  resolveKey: (ctx: Ctx, productId: string, input: string) => Promise<ResolveResult>,
): Promise<ResolvedProperties> {
  if (assignments.length === 0 || productId === undefined || productId === '') {
    return { value: undefined, resolutions: [] };
  }
  const value: Record<string, unknown> = {};
  const resolutions: ResolveResult[] = [];
  for (const assignment of assignments) {
    const property = await resolveKey(ctx, productId, assignment.key);
    value[property.id] = assignment.value;
    resolutions.push(property);
  }
  return { value, resolutions };
}

async function resolveProperties(
  ctx: Ctx,
  productId: string | undefined,
  assignments: PropertyAssignment[],
): Promise<ResolvedProperties> {
  return await resolvePropertiesWith(ctx, productId, assignments, resolveIdeaProperty);
}

function printIdea(idea: ShipIdea, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    idea,
    [
      ['identifier', idea.identifier ?? ''],
      ['id', idea.id],
      ['title', idea.title ?? ''],
      ['product', refName(idea.product)],
      ['state', refName(idea.state)],
      ['priority', refName(idea.priority)],
      ['assignee', refName(idea.assignee)],
      ['suite', refName(idea.suite)],
      ['plan', refName(idea.plan)],
      ['progress', idea.progress === undefined ? '' : String(idea.progress)],
      ['completed', timestampCell(idea.completed_at)],
      ['created', timestampCell(idea.created_at)],
      ['updated', timestampCell(idea.updated_at)],
      ['url', idea.html_url ?? idea.url ?? ''],
      ['description', idea.description ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${idea.identifier ?? idea.id}`));
  }
}

export function present(resolutions: (ResolveResult | undefined)[]): ResolveResult[] {
  return resolutions.filter((resolution): resolution is ResolveResult => resolution !== undefined);
}
