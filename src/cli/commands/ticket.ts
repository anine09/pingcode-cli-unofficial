import type { Command } from 'commander';
import {
  createTicket,
  getTicket,
  iterateTickets,
  listTicketStates,
  searchTickets,
  updateTicket,
  type CreateTicketInput,
  type UpdateTicketInput,
} from '../../api/ship';
import type { Ctx } from '../../core/context';
import { NotFoundError, PingcodeError, UsageError } from '../../core/errors';
import {
  findTicketStatePlanId,
  invalidateCacheKey,
  loadTicketStateFlows,
  resolveProduct,
  resolveProductMember,
  resolveShipRef,
  resolveTicketChannel,
  resolveTicketPriority,
  resolveTicketProperty,
  resolveTicketState,
  resolveTicketType,
  withoutCache,
  type ShipLocator,
  type StateFlowEdge,
} from '../../core/metadata';
import { collect, type SearchPayload } from '../../core/paginate';
import type { Ref, ShipTicket } from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import { present, resolvePropertiesWith, type ResolvedProperties } from './idea';
import {
  addPagingOptions,
  addShipStateOptions,
  collectValue,
  contextFor,
  mergeFilters,
  modeOf,
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
 * `pingcode ticket list|get|create|update|transition` — ship's 工单 (ship §K).
 *
 * Structurally identical to `idea`, with three differences that come straight
 * from the API:
 *
 *  - **`--type` is required to create**, because `type_id` is a required body
 *    field on `POST /v1/ship/tickets` (PRD D12). This is the one place ship
 *    demands a lookup before a write can even be attempted.
 *  - **`--channel` is set-once**: it exists on create and not on update, because
 *    `PATCH` has no `channel_id` (ship GOTCHA #16).
 *  - **Transitions can be pre-validated.** Unlike ideas, tickets have a state
 *    plan with declared flows, so an illegal target state can be refused locally
 *    rather than round-tripped to the server (design §13.2).
 */

type ListFlags = PagingFlags &
  StateFlags & {
    product: string;
    type?: string | undefined;
    priority?: string | undefined;
    assignee?: string | undefined;
    channel?: string | undefined;
    keywords?: string | undefined;
  };

type CreateFlags = {
  product: string;
  type: string;
  title: string;
  description?: string | undefined;
  assignee?: string | undefined;
  priority?: string | undefined;
  channel?: string | undefined;
  set?: string[] | undefined;
};

type UpdateFlags = StateFlags & {
  title?: string | undefined;
  description?: string | undefined;
  type?: string | undefined;
  priority?: string | undefined;
  assignee?: string | undefined;
  set?: string[] | undefined;
};

const SET_HELP =
  'custom property, repeatable: --set key=value. Values for select-type properties are option ids, not labels. Replaces, never merges';

/** `channel` is an object for external tickets and the string `"internal"` otherwise. */
export function channelName(channel: Ref | string | undefined): string {
  if (channel === undefined) return '';
  if (typeof channel === 'string') return channel;
  return channel.name ?? channel.id;
}

export const TICKET_COLUMNS: Column<ShipTicket>[] = [
  { header: 'IDENTIFIER', value: (ticket) => ticket.identifier ?? ticket.id },
  { header: 'TITLE', value: (ticket) => ticket.title ?? '', flex: true },
  { header: 'STATE', value: (ticket) => refName(ticket.state) },
  { header: 'PRIORITY', value: (ticket) => refName(ticket.priority) },
  { header: 'ASSIGNEE', value: (ticket) => refName(ticket.assignee) },
  { header: 'CHANNEL', value: (ticket) => channelName(ticket.channel) },
];

export function registerTicketCommands(program: Command): void {
  const group = program
    .command('ticket')
    .description('ship tickets 工单 (scopes pcp:read:ship:ticket / pcp:write:ship:ticket)');

  addGlobalOptions(
    addShipStateOptions(
      addPagingOptions(
        group
          .command('list')
          .description('search tickets in a product (POST /v1/ship/tickets/search)')
          .requiredOption('--product <name|id>', 'product name, identifier or id')
          .option('--type <name|id>', 'ticket type')
          .option('--priority <name|id>', 'priority')
          .option('--assignee <name|id>', 'assignee — must be a member of this product')
          .option('--channel <name|id>', 'submission channel 工单渠道')
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
      .description('show one ticket')
      .argument('<ticket>', 'id, identifier such as SLC-1, or a pasted ticket URL'),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    await runGet(target, command);
  });

  addGlobalOptions(
    group
      .command('create')
      .description('create a ticket (--type is required by the API, unlike idea)')
      .requiredOption('--product <name|id>', 'product name, identifier or id')
      .requiredOption('--type <name|id>', 'ticket type — list them with `meta ticket-types`')
      .requiredOption('--title <text>', 'title, max 255 characters')
      .option('--description <text>', 'description')
      .option('--assignee <name|id>', 'assignee — must be a member of this product')
      .option('--priority <name|id>', 'priority')
      .option('--channel <name|id>', 'submission channel — can only be set here, never patched')
      .option('--set <key=value>', SET_HELP, collectValue),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    addShipStateOptions(
      group
        .command('update')
        .description('patch a ticket — only the fields you pass are sent, and they replace')
        .argument('<ticket>', 'id, identifier such as SLC-1, or a pasted ticket URL')
        .option('--title <text>', 'new title')
        .option('--description <text>', 'new description (replaces the old one)')
        .option('--type <name|id>', 'new ticket type')
        .option('--priority <name|id>', 'new priority')
        .option('--assignee <name|id>', 'new assignee')
        .option('--set <key=value>', SET_HELP, collectValue),
      'new state (checked against the state plan before it is sent)',
    ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });

  addGlobalOptions(
    addShipStateOptions(
      group
        .command('transition')
        .description('move a ticket to another state, checking the state plan first')
        .argument('<ticket>', 'id, identifier such as SLC-1, or a pasted ticket URL'),
      'target state',
    ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    if (
      (flags.state === undefined || flags.state.trim() === '') &&
      (flags.stateId === undefined || flags.stateId.trim() === '')
    ) {
      throw new UsageError('transition requires --state <name> or --state-id <id>', {
        hint: 'list the states with `pingcode meta ticket-states --product <p>`',
      });
    }
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
  const type =
    flags.type === undefined ? undefined : await resolveTicketType(ctx, product.id, flags.type);
  const state = await resolveShipStateFlags(ctx, flags, 'ship-ticket-state', (c, input) =>
    resolveTicketState(c, product.id, input),
  );
  const priority =
    flags.priority === undefined
      ? undefined
      : await resolveTicketPriority(ctx, product.id, flags.priority);
  const assignee =
    flags.assignee === undefined
      ? undefined
      : await resolveProductMember(ctx, product.id, flags.assignee);
  const channel =
    flags.channel === undefined
      ? undefined
      : await resolveTicketChannel(ctx, product.id, flags.channel);

  const payload: SearchPayload = {
    filter: mergeFilters([
      refFilter('product', product.id),
      refFilter('type', type?.id),
      refFilter('state', state?.id),
      refFilter('priority', priority?.id),
      refFilter('assignee', assignee?.id),
      refFilter('channel', channel?.id),
    ]),
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
  };

  if (paging.all) {
    const values = await collect(
      iterateTickets(ctx, payload, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, TICKET_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await searchTickets(ctx, payload, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, TICKET_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const locator = await resolveShipRef(ctx, 'ticket', requireFlag(target, '<ticket>'));
  if (locator.id === '') {
    throw new NotFoundError(`could not resolve "${target}" to a ticket id`);
  }
  printTicket(await getTicket(ctx, locator.id), ctx);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const title = requireFlag(flags.title, '--title');
  const assignments = parseSetFlags(flags.set);

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<CreateTicketInput>> => {
    const product = await resolveProduct(attemptCtx, flags.product);
    // `type_id` is required by the API, so this lookup is not optional.
    const type = await resolveTicketType(attemptCtx, product.id, flags.type);
    const assignee =
      flags.assignee === undefined
        ? undefined
        : await resolveProductMember(attemptCtx, product.id, flags.assignee);
    const priority =
      flags.priority === undefined
        ? undefined
        : await resolveTicketPriority(attemptCtx, product.id, flags.priority);
    const channel =
      flags.channel === undefined
        ? undefined
        : await resolveTicketChannel(attemptCtx, product.id, flags.channel);
    const properties = await resolveProperties(attemptCtx, product.id, assignments);

    const input: CreateTicketInput = {
      product_id: product.id,
      title,
      type_id: type.id,
      ...(flags.description === undefined ? {} : { description: flags.description }),
      ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
      ...(priority === undefined ? {} : { priority_id: priority.id }),
      ...(channel === undefined ? {} : { channel_id: channel.id }),
      ...(properties.value === undefined ? {} : { properties: properties.value }),
    };

    return {
      resolutions: present([product, type, assignee, priority, channel, ...properties.resolutions]),
      value: input,
    };
  };

  const ticket = await runWrite(ctx, resolve, (attemptCtx, input) =>
    createTicket(attemptCtx, input),
  );
  printTicket(ticket, ctx, 'created');
}

// ---------------------------------------------------------------------------
// update / transition (one code path)
// ---------------------------------------------------------------------------

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const assignments = parseSetFlags(flags.set);

  const scalarPatch: UpdateTicketInput = {
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
  };

  const wantsState =
    (flags.state !== undefined && flags.state.trim() !== '') ||
    (flags.stateId !== undefined && flags.stateId.trim() !== '');
  const wantsReference =
    wantsState ||
    flags.type !== undefined ||
    flags.priority !== undefined ||
    flags.assignee !== undefined ||
    assignments.length > 0;

  if (Object.keys(scalarPatch).length === 0 && !wantsReference) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint: 'pass at least one of --title / --description / --type / --state / --state-id / --priority / --assignee / --set',
    });
  }

  const locator = await resolveShipRef(ctx, 'ticket', requireFlag(target, '<ticket>'));
  if (locator.id === '') {
    throw new NotFoundError(`could not resolve "${target}" to a ticket id`);
  }

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<UpdateTicketInput>> => {
    const productId = locator.productId;
    if (wantsReference && (productId === undefined || productId === '')) {
      throw new UsageError(
        `the ticket ${locator.identifier ?? locator.id} did not report a product, so names cannot be resolved`,
        { hint: 'pass ids directly (--state-id <id>) instead of names' },
      );
    }

    const state =
      productId === undefined
        ? undefined
        : await resolveShipStateFlags(attemptCtx, flags, 'ship-ticket-state', (c, input) =>
            resolveTicketState(c, productId, input),
          );
    const type =
      flags.type === undefined || productId === undefined
        ? undefined
        : await resolveTicketType(attemptCtx, productId, flags.type);
    const priority =
      flags.priority === undefined || productId === undefined
        ? undefined
        : await resolveTicketPriority(attemptCtx, productId, flags.priority);
    const assignee =
      flags.assignee === undefined || productId === undefined
        ? undefined
        : await resolveProductMember(attemptCtx, productId, flags.assignee);
    const properties = await resolveProperties(attemptCtx, productId, assignments);

    const patch: UpdateTicketInput = {
      ...scalarPatch,
      ...(state === undefined ? {} : { state_id: state.id }),
      ...(type === undefined ? {} : { type_id: type.id }),
      ...(priority === undefined ? {} : { priority_id: priority.id }),
      ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
      ...(properties.value === undefined ? {} : { properties: properties.value }),
    };

    return {
      resolutions: present([state, type, priority, assignee, ...properties.resolutions]),
      value: patch,
    };
  };

  try {
    const ticket = await runWrite(ctx, resolve, async (attemptCtx, patch) => {
      // Pre-validation runs inside the write attempt so the retry pass — which
      // has the cache bypassed — re-checks against freshly read flows.
      if (patch.state_id !== undefined) {
        await verifyTicketTransition(attemptCtx, locator, patch.state_id);
      }
      return await updateTicket(attemptCtx, locator.id, patch);
    });
    printTicket(ticket, ctx, 'updated');
  } catch (error) {
    if (wantsState) await explainTicketStates(ctx, locator, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// transition pre-validation (design §13.2) — the ticket/idea asymmetry
// ---------------------------------------------------------------------------

/**
 * Refuse a transition the state plan does not allow, **before** sending it.
 *
 * This is the one thing tickets can do that ideas cannot: ship publishes
 * `GET /v1/ship/ticket_state_plans/{plan}/ticket_state_flows`, and a `state_id`
 * on `PATCH /v1/ship/tickets` is only accepted if a matching edge exists
 * (ship GOTCHA #20). Ideas have no flow endpoint at all, so `idea update
 * --state` can only ever be judged by the server.
 *
 * The failure mode is asymmetric on purpose: an *illegal transition* is refused
 * locally with exit 2 and the reachable states named, but a *failed lookup* —
 * no plan found, 403 on the configuration scope, an undocumented shape — only
 * warns and lets the write proceed. Losing the ability to move a ticket because
 * a lookup failed is worse than a server-side rejection.
 */
export async function verifyTicketTransition(
  ctx: Ctx,
  locator: ShipLocator,
  targetStateId: string,
): Promise<void> {
  const currentStateId = locator.stateId;
  if (currentStateId !== undefined && currentStateId === targetStateId) {
    throw new UsageError(
      `${locator.identifier ?? locator.id} is already in state ${locator.stateName ?? targetStateId}`,
      { hint: 'nothing to do — drop --state, or pick a different target state' },
    );
  }

  const productId = locator.productId;
  if (productId === undefined || productId === '') {
    ctx.logger.warn(
      'the ticket did not report a product, so the state plan cannot be located; ' +
        'sending the transition and letting the server decide',
    );
    return;
  }

  let planId: string | undefined;
  let flows: Awaited<ReturnType<typeof loadTicketStateFlows>>;
  try {
    // The ticket schema documents no state-plan reference, so this is almost
    // always the O(all plans) scan. `statePlanId` is read opportunistically in
    // case the wire is richer than the docs.
    planId = locator.statePlanId ?? (await findTicketStatePlanId(ctx, productId));
    if (planId === undefined) {
      ctx.logger.warn(
        'no ticket state plan could be matched to this product, so the transition cannot be ' +
          'checked locally; sending it and letting the server decide',
      );
      return;
    }
    flows = await loadTicketStateFlows(ctx, planId);
  } catch (error) {
    ctx.logger.warn(
      `could not read the ticket state flows (${describe(error)}); sending the transition and ` +
        'letting the server decide. Reading them needs pcp:read:ship:configuration',
    );
    return;
  }

  if (flows.edges.length === 0) {
    ctx.logger.warn(
      `state plan ${planId} reported no transitions, so the move cannot be checked locally; ` +
        'sending it and letting the server decide',
    );
    return;
  }

  if (isReachable(flows.edges, currentStateId, targetStateId)) return;

  // A stale flow cache must never produce a false local rejection: drop it and
  // check once more against the live plan before refusing.
  if (flows.fromCache) {
    invalidateCacheKey(ctx, flows.cacheKey);
    try {
      const fresh = await loadTicketStateFlows(withoutCache(ctx), planId);
      if (fresh.edges.length === 0 || isReachable(fresh.edges, currentStateId, targetStateId)) {
        return;
      }
      flows = fresh;
    } catch {
      // Keep the cached view and refuse below rather than masking the reason.
    }
  }

  const reachable = flows.edges
    .filter((edge) => edge.fromId === undefined || edge.fromId === currentStateId)
    .map((edge) => `${edge.toName ?? '(unnamed)'} (${edge.toId})`);

  // The reachable set goes in the **message**, not the hint: `--json` errors are
  // `{kind,message,code,exit}` and drop the hint entirely, so anything an agent
  // has to act on must survive that shape.
  const options =
    reachable.length === 0
      ? 'no transition out of the current state is configured — this ticket cannot be moved'
      : `reachable from here: ${reachable.join(', ')}`;

  throw new UsageError(
    `the state plan does not allow ${locator.identifier ?? locator.id} to move from ` +
      `${locator.stateName ?? currentStateId ?? '(unknown)'} to ${targetStateId}. ${options}`,
    {
      hint: 'run `pingcode meta ticket-states --product <p>` to see every state, or --no-cache if the plan was just reconfigured',
    },
  );
}

/** An edge with no source is an entry transition and is not treated as a barrier. */
function isReachable(
  edges: StateFlowEdge[],
  currentStateId: string | undefined,
  targetStateId: string,
): boolean {
  return edges.some(
    (edge) =>
      edge.toId === targetStateId &&
      (edge.fromId === undefined || currentStateId === undefined || edge.fromId === currentStateId),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * When the **server** rejects a state change, name the states the product has:
 * the server message rarely does. A local refusal already explains itself, so
 * `usage` is not in the list.
 */
async function explainTicketStates(
  ctx: Ctx,
  locator: ShipLocator,
  error: unknown,
): Promise<void> {
  if (!(error instanceof PingcodeError)) return;
  if (!['api', 'not_found', 'permission'].includes(error.kind)) return;
  const productId = locator.productId;
  if (productId === undefined) return;

  try {
    const states = await listTicketStates(ctx, productId);
    if (states.length === 0) return;
    const listed = states.map((state) => `${state.name ?? '(unnamed)'} (${state.id})`).join(', ');
    ctx.logger.warn(
      `states configured for this product: ${listed}. ` +
        `Current state: ${locator.stateName ?? '(unknown)'}.`,
    );
  } catch {
    // Best effort: never mask the original failure with a lookup failure.
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

async function resolveProperties(
  ctx: Ctx,
  productId: string | undefined,
  assignments: PropertyAssignment[],
): Promise<ResolvedProperties> {
  return await resolvePropertiesWith(ctx, productId, assignments, resolveTicketProperty);
}

function printTicket(ticket: ShipTicket, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    ticket,
    [
      ['identifier', ticket.identifier ?? ''],
      ['id', ticket.id],
      ['title', ticket.title ?? ''],
      ['product', refName(ticket.product)],
      ['type', refName(ticket.type)],
      ['state', refName(ticket.state)],
      ['priority', refName(ticket.priority)],
      ['assignee', refName(ticket.assignee)],
      ['channel', channelName(ticket.channel)],
      ['customer', refName(ticket.customer)],
      ['solution', refName(ticket.solution)],
      ['submitted', timestampCell(ticket.submitted_at)],
      ['completed', timestampCell(ticket.completed_at)],
      ['created', timestampCell(ticket.created_at)],
      ['updated', timestampCell(ticket.updated_at)],
      ['url', ticket.html_url ?? ticket.url ?? ''],
      ['description', ticket.description ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${ticket.identifier ?? ticket.id}`));
  }
}
