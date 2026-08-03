import type { Command } from 'commander';
import {
  CATALOG,
  findById,
  matchPath,
  methodsFor,
  missingRequired,
  normalizePath,
  unfilledPathParams,
  type CatalogEntry,
  type CatalogMethod,
  type CatalogParam,
} from '../../core/catalog';
import type { Ctx } from '../../core/context';
import { PermissionError, UsageError } from '../../core/errors';
import { request } from '../../core/http';
import { parseJsonDocument, readJsonFile, readJsonStdin } from '../../core/jsonInput';
import {
  collect,
  DEFAULT_LIMIT,
  fetchSearchPage,
  MAX_PAGE_SIZE,
  paginate,
  searchPaginate,
  type SearchPayload,
} from '../../core/paginate';
import { addGlobalOptions } from '../globals';
import { errLine, outLine, paint, printJson, type Column } from '../output';
import {
  collectValue,
  contextFor,
  modeOf,
  parseSetFlags,
  printCollection,
  printFields,
  readPaging,
  type PagingFlags,
} from './common';

/**
 * `pingcode api …` — the generic executor (design D3), and the command that makes
 * *"every documented endpoint is reachable"* true.
 *
 * **It is plumbing, not semantics.** There is no response model, no parser, no
 * name→id resolution and no per-endpoint flag anywhere in this file. stdout is the
 * API's own JSON, verbatim. That is what keeps 459 endpoints affordable: the
 * refined command groups spend their budget on ergonomics for the endpoints that
 * deserve it, and everything else is still callable today.
 *
 * **Zero new failure modes (design D3.5).** Every request goes through
 * `core/http.ts:request()`, so the `--dry-run` gate, URL/header redaction, the
 * single 401 replay, the `x-pc-retry-after` 429 wait, "any 2xx is success", the
 * `{code}` overrides and the whole 0–8 exit-code table are **inherited**, not
 * reimplemented. The one thing this layer adds is *"the catalog says that endpoint
 * does not exist"* — and it fires before any network IO. The danger surface
 * therefore does not grow with the endpoint count; it grows only with the quality
 * of the `--yes` gate (design D8).
 *
 * **`--json` is a no-op on the five verbs.** stdout is raw JSON either way, so
 * there is nothing for it to switch. It *does* apply to `api list` / `api describe`,
 * which render local catalog data and have a human table as well as a JSON form.
 * Both facts are stated in `--help` and in `skills/pingcode/modules/api.md`.
 */

const METHODS: readonly CatalogMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

/**
 * Verbs that carry a request body, and therefore get `--body-file` / `--body` / `--set`.
 *
 * `DELETE` is in the set because of exactly one endpoint: `DELETE /v1/pjm/stages/{stage_id}`
 * (删除一个发布阶段) documents an optional `replace_id` body field. No documented `GET`
 * carries a body, so `GET` stays out — reachability is decided by the catalog, not by
 * what REST usually looks like.
 */
const BODY_VERBS = new Set<CatalogMethod>(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Verbs that can page. `GET` pages in the query string; `POST` only for the five
 * `…/search` endpoints, which page inside `payload` (design D3.4).
 */
const PAGING_VERBS = new Set<CatalogMethod>(['GET', 'POST']);

const SET_HINT =
  'values are sent verbatim: a select-typed field wants the option `_id`, not its display text. ' +
  'Run `pingcode api describe <METHOD> <path>` for the documented fields, or use --body-file for nested JSON';

type VerbFlags = PagingFlags & {
  query?: string[] | undefined;
  bodyFile?: string | undefined;
  body?: string | undefined;
  set?: string[] | undefined;
  yes?: boolean | undefined;
};

type ListFlags = {
  module?: string | undefined;
  search?: string | undefined;
  token?: string | undefined;
  method?: string | undefined;
};

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerApiCommands(program: Command): void {
  const api = program
    .command('api')
    .description('通用逃生舱: call any documented v1 endpoint directly (catalog-checked passthrough)');

  api.addHelpText(
    'after',
    '\nstdout is the API response, verbatim JSON — so --json is a no-op on the five verbs\n' +
      '(it does apply to `api list` / `api describe`, which render the local catalog).\n' +
      'The path is checked against the endpoint catalog before anything is sent, so an\n' +
      'unknown path, a wrong method, a missing required field or a user-token-only\n' +
      'endpoint fails with exit 2 and no request.\n' +
      'Start with `pingcode api list --search <text>` and `pingcode api describe <id>`.\n',
  );

  for (const method of METHODS) registerVerb(api, method);
  registerList(api);
  registerDescribe(api);
}

function registerVerb(api: Command, method: CatalogMethod): void {
  const command = api
    .command(method)
    // Aliased to lowercase so `pingcode api get /v1/…` works too; commander matches
    // subcommand names case-sensitively.
    .alias(method.toLowerCase())
    .description(verbDescription(method))
    .argument(
      '<path>',
      'endpoint path with ids substituted, e.g. /v1/scm/commits/9f3c1ab (no query string)',
    )
    .option('--query <key=value>', 'query parameter, repeatable, value sent verbatim', collectValue);

  if (BODY_VERBS.has(method)) {
    command
      .option('--body-file <path>', 'request body, read as JSON from a file')
      .option('--body <json|->', 'request body as inline JSON, or - to read stdin')
      .option('--set <key=value>', 'one top-level body field, repeatable, value verbatim', collectValue);
  }

  if (PAGING_VERBS.has(method)) {
    // Deliberately **without** commander defaults: "the user did not ask for paging"
    // has to stay distinguishable from "the user asked for page 0", so that nothing
    // is injected into a request that did not request it, and so that `--page` on a
    // non-collection endpoint can be refused instead of silently ignored (D3.4).
    command
      .option('--page <n>', 'page index, 0-based (paged endpoints only)')
      .option('--page-size <n>', `rows per page, 1-${MAX_PAGE_SIZE} (paged endpoints only)`)
      .option('--all', 'walk every page (best effort: the API guarantees no ordering)')
      .option('--limit <n>', `stop after this many rows with --all (default ${DEFAULT_LIMIT})`);
  }

  if (method === 'DELETE') {
    command.option('--yes', 'confirm the deletion — required, this API has no undo for most rows');
  }

  command.addHelpText('after', `\n${verbNotes(method)}`);

  addGlobalOptions(command, { hidden: true }).action(
    async (pathArgument: string, flags: VerbFlags, self: Command) => {
      await runVerb(method, pathArgument, flags, self);
    },
  );
}

function verbDescription(method: CatalogMethod): string {
  switch (method) {
    case 'GET':
      return 'read any documented endpoint (paged endpoints accept --page/--all)';
    case 'POST':
      return 'create, or run one of the five POST …/search reads';
    case 'PATCH':
      return 'partial update — the verb to prefer for every update';
    case 'PUT':
      return 'full replacement — omitted fields may be cleared (see the note below)';
    case 'DELETE':
      return 'delete — requires --yes';
  }
}

function verbNotes(method: CatalogMethod): string {
  const shared =
    'stdout is the API response, verbatim JSON; --json is a no-op here.\n' +
    'The catalog is consulted first: unknown path, wrong method, missing required field\n' +
    'or a user-token-only endpoint ⇒ exit 2 with nothing sent.\n';
  switch (method) {
    case 'GET':
      return (
        `${shared}` +
        '--page/--page-size are forwarded as page_index/page_size only when you pass them;\n' +
        '--all walks the pages and prints {"values":[…],"count":N,"all":true}.\n'
      );
    case 'POST':
      return (
        `${shared}` +
        'The five POST …/search endpoints are reads that use a mutating verb: they run even\n' +
        'under --dry-run, take a {"mode":"query","payload":{…}} body, and page inside payload.\n'
      );
    case 'PUT':
      return (
        `${shared}` +
        'PUT replaces the whole object and this API never documents what an omitted field\n' +
        'does — one module was measured clearing a field its PATCH sibling preserves. Use\n' +
        'PATCH unless you really mean to replace everything. No refined command uses PUT.\n'
      );
    case 'DELETE':
      return (
        `${shared}` +
        '--yes is mandatory. `pingcode api list --method DELETE` enumerates the 49 deletable\n' +
        'endpoints; a wiki page and a code branch are the two with no recovery path at all.\n'
      );
    case 'PATCH':
      return shared;
  }
}

// ---------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------

/**
 * Order matters, and it is the order of design D3.2's table: everything that can
 * be decided from the catalog is decided *before* a context is built, before a
 * file or stdin is read, and before any request is sent.
 */
async function runVerb(
  method: CatalogMethod,
  pathArgument: string,
  flags: VerbFlags,
  self: Command,
): Promise<void> {
  const { candidates, path } = resolveEntry(method, pathArgument);
  refuseUserTokenEndpoint(candidates);

  const query = parseQueryFlags(flags.query);
  refuseUnconfirmedDelete(method, path, query, flags);

  const body = await readBodyFlags(flags);
  const entry = chooseEntry(candidates, query, body);
  const paging = readPagingFor(entry, flags);

  const { ctx } = contextFor(self);

  try {
    await send(ctx, entry, path, query, body, paging);
  } catch (error) {
    // Design D3.3: the 403 message the server sends is generic, and `wire.ts` cannot
    // be taught the per-endpoint scope (it is a PRD R1 no-touch file and knows nothing
    // about the catalog). So the declared scope is appended here, in the command layer.
    if (error instanceof PermissionError) errLine(paint.dim(declaredScopeLine(entry)));
    throw error;
  }
}

type ResolvedPaging = {
  all: boolean;
  pageIndex: number;
  pageSize: number;
  limit: number;
  /** Did the user actually type a paging flag? Nothing is injected unless they did. */
  requested: boolean;
};

async function send(
  ctx: Ctx,
  entry: CatalogEntry,
  path: string,
  query: Record<string, unknown>,
  body: unknown,
  paging: ResolvedPaging,
): Promise<void> {
  if (entry.paged === 'search') {
    await sendSearch(ctx, path, body, paging);
    return;
  }

  if (entry.paged === 'query' && paging.all) {
    const values = await collect(
      paginate<unknown>(ctx, path, query, {
        pageSize: paging.pageSize,
        startPage: paging.pageIndex,
        limit: paging.limit,
      }),
    );
    printJson({ values, count: values.length, all: true });
    return;
  }

  const raw = await request<unknown>(ctx, {
    method: entry.method,
    path,
    query: paging.requested
      ? { ...query, page_index: paging.pageIndex, page_size: paging.pageSize }
      : query,
    ...(body === undefined ? {} : { body }),
  });
  printResponse(raw);
}

/**
 * The five `POST …/search` endpoints always go through `core/paginate.ts` (design
 * D3.4), for two reasons that both come from there rather than from here: the
 * cursor lives in `payload`, and a search is a **read** that happens to use a
 * mutating verb, so `paginate.ts` runs it even under `--dry-run` — the same
 * contract the refined layer documents.
 */
async function sendSearch(
  ctx: Ctx,
  path: string,
  body: unknown,
  paging: ResolvedPaging,
): Promise<void> {
  const payload = searchPayloadOf(body);

  if (paging.all) {
    const values = await collect(
      searchPaginate<unknown>(ctx, path, payload, {
        pageSize: paging.pageSize,
        startPage: paging.pageIndex,
        limit: paging.limit,
      }),
    );
    printJson({ values, count: values.length, all: true });
    return;
  }

  const page = await fetchSearchPage<unknown>(ctx, path, payload, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  // The envelope's four documented field names, put back exactly as they arrive on
  // the wire (research §2.2). This is the one response this file reshapes, and only
  // because reusing `fetchSearchPage` is worth more than byte-identity here.
  printJson({
    page_index: page.pageIndex,
    page_size: page.pageSize,
    total: page.total,
    values: page.values,
  });
}

function printResponse(raw: unknown): void {
  if (raw === undefined) {
    // A 2xx with an empty body (this API answers some writes that way). There is no
    // JSON to print, and inventing one would be a lie; stdout stays empty.
    errLine(paint.dim('the request succeeded with an empty response body'));
    return;
  }
  printJson(raw);
}

function declaredScopeLine(entry: CatalogEntry): string {
  if (entry.scopes.length === 0) {
    return `${entry.method} ${entry.path} declares no scope in the docs — 27 generic endpoints are like this, and whether they are genuinely scope-exempt is unverified`;
  }
  return `${entry.method} ${entry.path} declares: ${entry.scopes.map(scopeName).join(', ')}`;
}

function scopeName(scope: string): string {
  return scope.startsWith('pcp:') ? scope : `pcp:${scope}`;
}

// ---------------------------------------------------------------------------
// pre-flight checks (design D3.2) — all of these happen before any network IO
// ---------------------------------------------------------------------------

/**
 * Match the path, then keep every catalog entry that also has the requested method.
 *
 * It is a **list**, not one entry, because two paths in the catalog are shared by
 * more than one documented endpoint: `GET /v1/auth/token` (three grants) and
 * `POST /v1/attachments` (a file upload and a code snippet, distinguished only by
 * content type). Picking the first and validating against it would reject a
 * perfectly legal refresh-token call because the *authorization-code* grant wants a
 * `code` — so the choice is deferred until the fields are known (`chooseEntry`).
 */
function resolveEntry(
  method: CatalogMethod,
  pathArgument: string,
): { candidates: readonly CatalogEntry[]; path: string } {
  const raw = pathArgument.trim();
  if (raw.includes('?')) {
    throw new UsageError('the path must not carry a query string', {
      hint: `drop everything from "?" and pass the parameters as --query key=value (repeatable), so they are serialised the same way every other command does it`,
    });
  }

  const path = normalizePath(raw);

  const unfilled = unfilledPathParams(path);
  if (unfilled.length > 0) {
    throw new UsageError(
      `the path still contains the placeholder${unfilled.length > 1 ? 's' : ''} ${unfilled
        .map((name) => `{${name}}`)
        .join(', ')}`,
      {
        hint: 'substitute the real ids — the catalog prints paths as templates, the request needs values',
      },
    );
  }

  const onPath = matchPath(path);
  if (onPath.length === 0) throw unknownPath(path);

  const candidates = onPath.filter((candidate) => candidate.method === method);
  if (candidates.length === 0) {
    const supported = methodsFor(path);
    throw new UsageError(`${method} ${path} is not a documented endpoint`, {
      hint: `that path supports ${supported.join(', ')} — this API is missing several symmetric operations on purpose (there is no project delete, no sprint delete, and nothing in 产品管理 can be deleted at all)`,
    });
  }

  return { candidates, path };
}

const AUTHORIZE_HINT =
  'this CLI authenticates with the client_credentials grant, which yields an 企业令牌; the ' +
  'authorization-code flow (and therefore anything needing a 用户令牌) is a separate task. ' +
  'Run `pingcode auth login`.';

function unknownPath(path: string): UsageError {
  if (segmentsOf(path).includes('authorize')) {
    // Design D2.8: `{oauth2_root}/authorize` is the one documented "endpoint" that is
    // not in the catalog, because it is not an endpoint. Saying "unknown path" here
    // would send the reader looking for a typo that does not exist.
    return new UsageError(
      `${path} is the browser authorization page of the OAuth2 authorization-code flow, not a REST endpoint: it renders HTML for a human to click and redirects, it returns no JSON, and it is not under /v1`,
      { hint: AUTHORIZE_HINT },
    );
  }

  const suggestions = nearestPaths(path);
  const hint =
    suggestions.length === 0
      ? `no documented path has ${segmentsOf(path).length} segments like this one — search the catalog with \`pingcode api list --search <text>\``
      : `did you mean ${suggestions.join(' , ')} ? — or search with \`pingcode api list --search <text>\``;
  return new UsageError(`${path} is not in the endpoint catalog (459 documented v1 endpoints)`, {
    hint,
  });
}

/**
 * Nearest documented paths: **same segment count**, ranked by segment-level edit
 * distance, top 3 (design D3.2).
 *
 * A `{placeholder}` segment costs nothing, because it matches any value — so
 * `/v1/pjm/projects/abc/sprint` scores 1 against
 * `/v1/pjm/projects/{project_id}/sprints` and wins, which is the whole point.
 * Requiring the same segment count is what keeps the singular-area trap
 * (`/v1/testhub/case/states` vs `/v1/testhub/cases/{case_id}`) out of the
 * suggestion list.
 */
function nearestPaths(path: string): string[] {
  const actual = segmentsOf(path);
  const scored = new Map<string, number>();
  for (const entry of CATALOG) {
    const template = segmentsOf(entry.path);
    if (template.length !== actual.length) continue;
    const score = template.reduce(
      (sum, segment, index) =>
        sum + (isPlaceholder(segment) ? 0 : editDistance(segment, actual[index] ?? '')),
      0,
    );
    const previous = scored.get(entry.path);
    if (previous === undefined || score < previous) scored.set(entry.path, score);
  }
  return [...scored.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([candidate]) => candidate);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function isPlaceholder(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/**
 * Design D8.5. Two things this deliberately does not do:
 *
 *  - it does not treat an **absent** `tokenType` as "unknown, better refuse" — absent
 *    means the endpoint needs no token, which is true of exactly the three
 *    `GET /v1/auth/token` grants, i.e. of how a token is obtained in the first place;
 *  - it only refuses when **every** candidate on the path is user-token-only, since a
 *    shared path could in principle mix token types and refusing then would block a
 *    reachable endpoint.
 */
function refuseUserTokenEndpoint(candidates: readonly CatalogEntry[]): void {
  if (!candidates.every((entry) => entry.tokenType === 'USER')) return;
  const entry = candidates[0];
  if (entry === undefined) return;
  throw new UsageError(
    `${entry.method} ${entry.path} requires a 用户令牌 (user token), and this CLI only holds an 企业令牌 (enterprise token)`,
    {
      hint:
        'seven endpoints are user-token-only — /v1/myself, /v1/permission/my/* and /v1/permission/check/*. ' +
        'GET /v1/permission/points does work with the enterprise token. ' +
        AUTHORIZE_HINT,
    },
  );
}

function refuseUnconfirmedDelete(
  method: CatalogMethod,
  path: string,
  query: Record<string, unknown>,
  flags: VerbFlags,
): void {
  if (method !== 'DELETE' || flags.yes === true) return;
  throw new UsageError(`refusing to send DELETE ${path}${displayQuery(query)} without --yes`, {
    hint: 're-run with --yes to send it, or with --yes --dry-run to print the full request plan without sending anything',
  });
}

/** Display only — the request URL itself is built once, in `core/wire.ts`. */
function displayQuery(query: Record<string, unknown>): string {
  const pairs = Object.entries(query).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).map((item) => `${key}=${String(item)}`),
  );
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

/**
 * Pick the documented endpoint the invocation actually matches, and refuse it here if
 * none of them is satisfied.
 *
 * For the 457 unambiguous paths this is just "check the required fields are present".
 * For the two shared ones it is the whole point: `GET /v1/auth/token` with
 * `grant_type` + `refresh_token` is the refresh grant, not the authorization-code
 * grant that also wants a `code`; `POST /v1/attachments` with `format` + `content` is
 * the code-snippet variant, not the file upload. Fewest missing fields wins, ties go
 * to catalog id order, and the error names the closest candidate — which is the most
 * informative one to name.
 *
 * Presence only. Values are never inspected or coerced (`missingRequired`'s rule, and
 * `parseSetFlags`' rule before it).
 */
function chooseEntry(
  candidates: readonly CatalogEntry[],
  query: Record<string, unknown>,
  body: unknown,
): CatalogEntry {
  const provided = {
    query: Object.keys(query),
    body: isRecord(body) ? Object.keys(body) : [],
  };

  const ranked = candidates
    .map((entry) => ({ entry, missing: missingRequired(entry, provided) }))
    .sort((a, b) => a.missing.length - b.missing.length);

  const best = ranked[0];
  if (best === undefined) throw new UsageError('no candidate endpoint'); // unreachable
  if (best.missing.length === 0) return best.entry;

  const named = best.missing.map((param) => `${param.name} (${param.kind})`).join(', ');
  const alternatives =
    candidates.length === 1
      ? ''
      : ` — ${candidates.length} documented endpoints share ${best.entry.method} ${best.entry.path} (${candidates
          .map((entry) => entry.id)
          .join(', ')}), and this is the closest`;
  throw new UsageError(
    `${best.entry.method} ${best.entry.path} is missing required field(s): ${named}${alternatives}`,
    {
      hint: `run \`pingcode api describe ${best.entry.id}\` for every documented field; pass query fields with --query k=v and body fields with --set k=v or --body-file`,
    },
  );
}

function readPagingFor(entry: CatalogEntry, flags: VerbFlags): ResolvedPaging {
  const requested =
    flags.page !== undefined ||
    flags.pageSize !== undefined ||
    flags.all === true ||
    flags.limit !== undefined;

  if (requested && entry.paged === false) {
    // Not silently ignored: an endpoint that returns one object would answer a
    // `--page 3` request with the same object, and the caller would believe it paged.
    throw new UsageError(
      `${entry.method} ${entry.path} is not a paged collection, so --page/--page-size/--all/--limit do not apply`,
      {
        hint: '`pingcode api describe` prints the paging flavour of an endpoint; only list endpoints page, and the five POST …/search endpoints page inside the body',
      },
    );
  }

  // `readPaging` fills the API's own defaults (0 / 30 / 500) and enforces its caps.
  const paging = readPaging(flags);
  return {
    all: paging.all,
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
    limit: paging.limit,
    requested,
  };
}

// ---------------------------------------------------------------------------
// flags → query / body
// ---------------------------------------------------------------------------

/**
 * `--query k=v`, repeatable. A repeated key becomes an array, which
 * `core/wire.ts` serialises as CSV — the API's own convention for
 * `emails`, `department_ids` and friends.
 *
 * Values are **never** coerced, for the same reason `parseSetFlags` does not coerce:
 * guessing types only invents failure modes.
 */
function parseQueryFlags(values: string[] | undefined): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const raw of values ?? []) {
    const separator = raw.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(`--query expects key=value, got "${raw}"`, {
        hint: 'e.g. --query principal_type=work_item --query principal_id=5f2a…',
      });
    }
    const key = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1);
    const previous = query[key];
    if (previous === undefined) query[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else query[key] = [previous, value];
  }
  return query;
}

async function readBodyFlags(flags: VerbFlags): Promise<unknown> {
  const given = [
    flags.bodyFile === undefined ? undefined : '--body-file',
    flags.body === undefined ? undefined : '--body',
    (flags.set?.length ?? 0) === 0 ? undefined : '--set',
  ].filter((name): name is string => name !== undefined);

  if (given.length > 1) {
    throw new UsageError(`${given.join(', ')} are mutually exclusive`, {
      hint: 'pick one source for the body: a file, inline/stdin JSON, or repeated --set key=value',
    });
  }

  if (flags.set !== undefined && flags.set.length > 0) {
    return Object.fromEntries(
      parseSetFlags(flags.set, SET_HINT).map((assignment) => [assignment.key, assignment.value]),
    );
  }

  if (flags.bodyFile !== undefined) return await readJsonFile(flags.bodyFile);

  if (flags.body !== undefined) {
    // `-` means stdin, so a body can be piped in without a temp file; anything else is
    // inline JSON. Both are parsed by `core/jsonInput.ts`, which also owns the file
    // read — `cli/` does no filesystem IO (design §2, test/layering.test.ts).
    return flags.body === '-'
      ? await readJsonStdin()
      : parseJsonDocument(flags.body, '--body');
  }

  return undefined;
}

/**
 * A `POST …/search` body is `{"mode":"query","payload":{…}}` (research §4.1);
 * `mode`'s only legal value is `"query"`. `payload` is handed to
 * `core/paginate.ts`, which re-wraps it and owns the cursor fields.
 */
function searchPayloadOf(body: unknown): SearchPayload {
  if (!isRecord(body)) {
    throw new UsageError('a POST …/search body must be a JSON object', {
      hint: 'e.g. --body \'{"mode":"query","payload":{"keywords":"login"}}\'',
    });
  }
  const mode = body.mode;
  if (mode !== undefined && mode !== 'query') {
    throw new UsageError(`search mode "${String(mode)}" is not documented`, {
      hint: '"query" is the only legal value of mode',
    });
  }
  const payload = body.payload;
  if (!isRecord(payload)) {
    throw new UsageError('a POST …/search body must carry a "payload" object', {
      hint: 'filter/keywords go inside payload; --page/--page-size are written into payload.page_index/page_size for you',
    });
  }
  return payload as SearchPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// discovery: api list / api describe (design D3.6)
// ---------------------------------------------------------------------------

const LIST_COLUMNS: Column<CatalogEntry>[] = [
  { header: 'METHOD', value: (entry) => entry.method },
  { header: 'PATH', value: (entry) => entry.path, flex: true },
  { header: 'TITLE', value: (entry) => entry.title, flex: true },
  { header: 'SCOPES', value: (entry) => entry.scopes.map(scopeName).join(' '), flex: true },
  { header: 'TOKEN', value: (entry) => entry.tokenType ?? 'NONE' },
];

const TOKEN_FILTERS = ['APP', 'ENT', 'USER', 'NONE'] as const;

function registerList(api: Command): void {
  const command = api
    .command('list')
    .description('search the catalog of 459 documented endpoints (local, no request)')
    .option('--module <name>', 'module: pjm, ship, testhub, scm, build, release, directory, wiki, …')
    .option('--search <text>', 'substring match over path, title and group')
    .option('--token <type>', `token type: ${TOKEN_FILTERS.join(' | ')} (NONE = needs no token)`)
    .option('--method <verb>', `${METHODS.join(' | ')}`);

  command.addHelpText(
    'after',
    '\nThis reads the bundled catalog, never the network. `--token ENT` is the 61 endpoints\n' +
      'only a machine identity can call (the CLI holds exactly that token); `--method DELETE`\n' +
      'is the auditable danger surface.\n' +
      '--json prints {"values":[…],"count":N} with each catalog entry verbatim.\n',
  );

  addGlobalOptions(command, { hidden: true }).action((flags: ListFlags, self: Command) => {
    const { ctx } = contextFor(self);
    printCollection(filterCatalog(flags), LIST_COLUMNS, modeOf(ctx));
  });
}

function filterCatalog(flags: ListFlags): CatalogEntry[] {
  const module = flags.module?.trim().toLowerCase();
  if (module !== undefined && module !== '' && !knownModules().includes(module)) {
    throw new UsageError(`no module named "${flags.module ?? ''}"`, {
      hint: `the modules are ${knownModules().join(', ')}`,
    });
  }

  const method = flags.method?.trim().toUpperCase();
  if (method !== undefined && method !== '' && !METHODS.includes(method as CatalogMethod)) {
    throw new UsageError(`"${flags.method ?? ''}" is not an HTTP method this API uses`, {
      hint: `the methods are ${METHODS.join(', ')}`,
    });
  }

  const token = flags.token?.trim().toUpperCase();
  if (token !== undefined && token !== '' && !TOKEN_FILTERS.includes(token as 'APP')) {
    throw new UsageError(`"${flags.token ?? ''}" is not a token type`, {
      hint: `the token types are ${TOKEN_FILTERS.join(', ')} — NONE selects the three token-grant endpoints, which need no token`,
    });
  }

  const needle = flags.search?.trim().toLowerCase();

  return CATALOG.filter((entry) => {
    if (module !== undefined && module !== '' && entry.module !== module) return false;
    if (method !== undefined && method !== '' && entry.method !== method) return false;
    if (token !== undefined && token !== '' && (entry.tokenType ?? 'NONE') !== token) return false;
    if (needle !== undefined && needle !== '') {
      const haystack = `${entry.path} ${entry.title} ${entry.group}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function knownModules(): string[] {
  return [...new Set(CATALOG.map((entry) => entry.module))].sort();
}

function registerDescribe(api: Command): void {
  const command = api
    .command('describe')
    .description('one endpoint in full: fields, scope, token type, paging flavour (local)')
    .argument('<id-or-method>', 'catalog id such as scm.commits.get, or an HTTP method')
    .argument('[path]', 'endpoint path, when the first argument is a method');

  command.addHelpText(
    'after',
    '\nAn id is exact; a method + path is matched through the same wildcard rules the\n' +
      'executor uses. GET /v1/auth/token is the one path three entries share (the three\n' +
      'grants), so address those by id.\n' +
      '--json prints the catalog entry verbatim.\n',
  );

  addGlobalOptions(command, { hidden: true }).action(
    (idOrMethod: string, path: string | undefined, _flags: unknown, self: Command) => {
      const { ctx } = contextFor(self);
      const entry = lookupForDescribe(idOrMethod, path);
      printEntry(entry, modeOf(ctx));
    },
  );
}

function lookupForDescribe(idOrMethod: string, path: string | undefined): CatalogEntry {
  if (path !== undefined) {
    const method = idOrMethod.trim().toUpperCase();
    if (!METHODS.includes(method as CatalogMethod)) {
      throw new UsageError(`"${idOrMethod}" is not an HTTP method`, {
        hint: `the methods are ${METHODS.join(', ')} — or pass a single catalog id instead`,
      });
    }
    const normalized = normalizePath(path.trim());
    const matches = matchPath(normalized).filter((entry) => entry.method === method);
    const entry = matches[0];
    if (entry === undefined) {
      const supported = methodsFor(normalized);
      if (supported.length === 0) throw unknownPath(normalized);
      throw new UsageError(`${method} ${normalized} is not a documented endpoint`, {
        hint: `that path supports ${supported.join(', ')}`,
      });
    }
    if (matches.length > 1) {
      errLine(
        paint.dim(
          `${matches.length} entries share ${method} ${entry.path}; showing ${entry.id} — the others are ${matches
            .slice(1)
            .map((other) => other.id)
            .join(', ')}`,
        ),
      );
    }
    return entry;
  }

  const byId = findById(idOrMethod.trim());
  if (byId !== undefined) return byId;

  if (METHODS.includes(idOrMethod.trim().toUpperCase() as CatalogMethod)) {
    throw new UsageError(`describe by method needs the path too: \`api describe ${idOrMethod.trim().toUpperCase()} <path>\``);
  }

  throw new UsageError(`no catalog entry has the id "${idOrMethod}"`, {
    hint: nearestIdsHint(idOrMethod),
  });
}

function nearestIdsHint(input: string): string {
  const needle = input.trim().toLowerCase();
  const near = CATALOG.map((entry) => ({ id: entry.id, score: editDistance(entry.id, needle) }))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((candidate) => candidate.id);
  return `did you mean ${near.join(' , ')} ? — or search with \`pingcode api list --search <text>\``;
}

function printEntry(entry: CatalogEntry, mode: { json: boolean }): void {
  if (mode.json) {
    printJson(entry);
    return;
  }

  printFields([
    ['id', entry.id],
    ['endpoint', `${entry.method} ${entry.path}`],
    ['title', entry.title],
    ['module', `${entry.module} · ${entry.group}`],
    ['token', tokenLine(entry)],
    ['scopes', entry.scopes.length === 0 ? 'none declared in the docs' : entry.scopes.map(scopeName).join(', ')],
    ['paging', pagingLine(entry)],
    ['path params', entry.pathParams.join(', ')],
  ]);

  printParams('query', entry.query);
  printParams('body', entry.body);

  for (const warning of warningsFor(entry)) errLine(paint.yellow(warning));
}

function tokenLine(entry: CatalogEntry): string {
  // An **absent** tokenType means "needs no token", never "unknown" (design D2.3).
  if (entry.tokenType === undefined) {
    return 'none — this endpoint needs no token (it is how a token is obtained)';
  }
  if (entry.tokenType === 'ENT') {
    return 'ENT — 企业令牌 only (reachable: this CLI holds an enterprise token)';
  }
  if (entry.tokenType === 'USER') return 'USER — 用户令牌 only (NOT reachable with this CLI)';
  return 'APP — 企业令牌 or 用户令牌';
}

function pagingLine(entry: CatalogEntry): string {
  if (entry.paged === 'query') return 'query string — --page / --page-size / --all / --limit';
  if (entry.paged === 'search') {
    return 'body — payload.page_index / payload.page_size, driven by the same flags';
  }
  return 'not a collection — paging flags are refused';
}

/**
 * `printFields` drops empty values (that is what makes the scalar block above
 * tidy), so the section label is written separately rather than as an empty row.
 */
function printParams(label: string, params: readonly CatalogParam[]): void {
  if (params.length === 0) return;
  outLine(paint.dim(label));
  printFields(
    params.map((param): [string, string] => [
      `  ${param.name}`,
      `${param.type}${param.required ? ' (required)' : ''}`,
    ]),
  );
}

function warningsFor(entry: CatalogEntry): string[] {
  const warnings: string[] = [];
  if (entry.method === 'PUT') {
    warnings.push(
      'PUT is a full replacement: fields you omit may be cleared, and this API never documents that. Use PATCH unless you really mean to replace the whole object.',
    );
  }
  if (entry.method === 'DELETE') {
    warnings.push('DELETE requires --yes, and most rows on this API cannot be restored.');
  }
  if (entry.tokenType === 'USER') {
    warnings.push(
      'user-token-only: this CLI refuses it with exit 2 before sending anything (the authorization-code flow is not implemented).',
    );
  }
  if (entry.scopes.length === 0 && entry.tokenType !== undefined) {
    warnings.push(
      'the docs declare no scope for this endpoint; whether it is genuinely scope-exempt is unverified.',
    );
  }
  return warnings;
}
