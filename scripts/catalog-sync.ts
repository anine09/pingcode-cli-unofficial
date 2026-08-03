#!/usr/bin/env node
/**
 * Regenerate `src/core/catalog/catalog.generated.ts` from the upstream apiDoc
 * bundle (task 08-02-full-api-coverage, design D2.1/D2.4/D2.5).
 *
 * ## Why a scraper at all
 *
 * `https://open.pingcode.com` is an **apiDoc** SPA: there is no OpenAPI spec, no
 * Swagger, no sitemap, and every unknown path answers 200 with the same ~21 KB
 * shell — so path existence cannot be probed. The only machine-readable surface
 * is the doc bundle itself:
 *
 *   - `api_data.js` (~2.37 MB, 简体中文, current) — a `define({ "api": [...] })`
 *     AMD wrapper holding **579 entries = 460 endpoints + 119 nav/section stubs**
 *     (stubs carry an empty `type`).
 *   - `api_data_en.js` is a **stale 347-endpoint build** — never use it
 *     (research §8).
 *
 * Of the 460 endpoints, `GET {oauth2_root}/authorize` is excluded: it is not
 * `/v1`, does not return JSON, and is a browser redirect page rather than a
 * callable endpoint (design D2.8). That leaves the **459** entries this script
 * writes, every one of them under `/v1/`.
 *
 * ## Discipline
 *
 * - **Never fetched at runtime.** Only this script talks to the network, and
 *   only when a developer or the weekly CI job runs it. The CLI reads the
 *   vendored file.
 * - **Data only.** No response models, parsers, commands or help text are
 *   generated (design D2.2).
 * - Dependency-free: `node:` builtins plus the global `fetch`. The single
 *   relative import is `import type`, which `--experimental-strip-types` erases,
 *   so no TypeScript module graph has to resolve at runtime (same rule as
 *   `scripts/scan-secrets.ts`).
 *
 * Usage:
 *   node --experimental-strip-types scripts/catalog-sync.ts            # rewrite the generated file
 *   node --experimental-strip-types scripts/catalog-sync.ts --check    # compare against upstream, never write
 *   …                                                     --from <f>   # read a saved bundle instead of fetching
 *
 * Exit codes: 0 = in sync / written, 1 = drift or integrity failure, 2 = bad usage.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CatalogEntry,
  CatalogMethod,
  CatalogPaging,
  CatalogParam,
  CatalogTokenType,
} from '../src/core/catalog/types';

export const SOURCE_URL = 'https://open.pingcode.com/api_data.js';

/** The generated file's location, relative to the repository root. */
export const GENERATED_PATH = 'src/core/catalog/catalog.generated.ts';

/**
 * A tripwire, not a configuration knob. 459 is derived in design D2.8 and echoed
 * by two independent histograms (method and area) in research §2; if upstream
 * really changes, the number moves in the PRD and the design in the same commit.
 */
export const EXPECTED_ENTRIES = 459;

const DECLARATION = 'export const CATALOG: readonly CatalogEntry[] = ';

// ---------------------------------------------------------------------------
// Upstream bundle
// ---------------------------------------------------------------------------

/** apiDoc parameter-table group names. `路径参数` is ignored: the URL is the source of truth for path params. */
const QUERY_GROUP = '查询参数';
const BODY_GROUPS = ['Parameter', '请求参数', 'Body', '请求参数 form-data'];
const MULTIPART_GROUP = '请求参数 form-data';

const METHODS: readonly CatalogMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Strip the AMD wrapper. Done by slicing between the first `(` and the last `)`
 * rather than with a regex or a JS parser: the payload is JSON, so `JSON.parse`
 * is the validation step and no expression parser (and no new dependency) is
 * needed.
 */
export function unwrapBundle(raw: string): unknown {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close <= open) throw new Error('not an AMD `define(...)` bundle');
  return JSON.parse(raw.slice(open + 1, close).trim());
}

/** The `api` array of the bundle, unnarrowed — every field is validated at use site. */
export function bundleEntries(raw: string): Record<string, unknown>[] {
  const data = unwrapBundle(raw);
  if (!isRecord(data)) throw new Error('bundle payload is not an object');
  const api = asArray(data['api']);
  if (api.length === 0) throw new Error('bundle carries no `api` array');
  return api.filter(isRecord);
}

/** Upstream spells methods inconsistently (`get`, `Patch`, `DEL`, …). */
export function normalizeMethod(type: string): CatalogMethod | undefined {
  const upper = type.trim().toUpperCase();
  const canonical = upper === 'DEL' ? 'DELETE' : upper;
  return METHODS.find((m) => m === canonical);
}

// ---------------------------------------------------------------------------
// Derivation (design D2.3)
// ---------------------------------------------------------------------------

function params(fields: Record<string, unknown>, groups: readonly string[]): CatalogParam[] {
  const out: CatalogParam[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const raw of asArray(fields[group])) {
      if (!isRecord(raw)) continue;
      const name = asString(raw['field']);
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, type: asString(raw['type']), required: raw['optional'] !== true });
    }
  }
  return out;
}

/** Placeholder names of a path template, in path order. */
export function pathParamsOf(pathTemplate: string): string[] {
  return [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '');
}

function isPlaceholder(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/** Does the path address one resource (`…/{id}`) rather than a collection? */
function endsWithItem(pathTemplate: string): boolean {
  const segments = pathTemplate.split('/').filter((s) => s !== '');
  return isPlaceholder(segments[segments.length - 1] ?? '');
}

/**
 * `GET /v1/myself` is a singleton (个人信息), not a collection, so the id rules
 * below would otherwise call it `myself.list`. The only such path today. Its
 * *paging* is corrected in `core/catalog/index.ts` instead — every heuristic
 * correction belongs in that hand-written table, not in this generator.
 */
const SINGLETON_PATHS = new Set(['/v1/myself']);

/**
 * Trailing segments that name an *action* rather than a resource. They become
 * the verb, which is what makes `pjm.work_items.search` read the way a human
 * would write it.
 */
const ACTION_SEGMENTS = new Set(['search', 'bulk']);

const METHOD_VERBS: Record<CatalogMethod, string> = {
  GET: 'get',
  POST: 'create',
  PATCH: 'update',
  PUT: 'replace',
  DELETE: 'delete',
};

/**
 * `<module>.<resource…>.<verb>` from (method, path) alone.
 *
 * The verb carries the collection/item distinction (`…projects.list` vs
 * `…projects.get`), which is also what keeps the two shapes of the same
 * resource from colliding. Action segments are folded into the verb: `bulk` for
 * the POST (which upstream loads with inserts/updates/deletes at once) and
 * `bulk_update` for the PATCH twin, so the id never depends on which sibling
 * methods happen to exist.
 */
export function deriveId(method: CatalogMethod, pathTemplate: string): string {
  const segments = pathTemplate.split('/').filter((s) => s !== '');
  const tail = segments.slice(1); // drop the `v1` version segment
  const moduleName = tail[0] ?? '';
  const rest = tail.slice(1);
  const last = rest[rest.length - 1];

  let action: string | undefined;
  if (last !== undefined && ACTION_SEGMENTS.has(last)) {
    action = last;
    rest.pop();
  }

  const nameParts = rest.filter((s) => !isPlaceholder(s));
  const itemShape = last !== undefined && isPlaceholder(last);
  const base =
    method === 'GET' && !itemShape && !SINGLETON_PATHS.has(pathTemplate)
      ? 'list'
      : METHOD_VERBS[method];
  const verb =
    action === undefined ? base : method === 'POST' ? action : `${action}_${METHOD_VERBS[method]}`;

  return [moduleName, ...nameParts, verb].filter((s) => s !== '').join('.');
}

/**
 * Design D2.3's rules, in order:
 *
 *  1. a documented `page_index` **query** parameter → `'query'`;
 *  2. `POST …/search` → `'search'` (page fields ride in the body, research §4.1);
 *  3. a GET whose last segment is not a placeholder → `'query'`, because paging
 *     is a global convention upstream never repeats per endpoint — rule 1 alone
 *     would call all 250 GETs unpaged (it matches **zero** entries today);
 *  4. otherwise `false`.
 *
 * Rule 3 is a heuristic: the dozen GET collections that are really singletons
 * (`/v1/myself`, a page's body, a project's progress, …) are corrected by the
 * hand-written override table in `core/catalog/index.ts`, which is reviewable
 * code — the generated file is not.
 */
export function derivePaged(
  method: CatalogMethod,
  pathTemplate: string,
  query: readonly CatalogParam[],
): CatalogPaging {
  if (query.some((p) => p.name === 'page_index')) return 'query';
  if (method === 'POST' && pathTemplate.endsWith('/search')) return 'search';
  const segments = pathTemplate.split('/').filter((s) => s !== '');
  const last = segments[segments.length - 1] ?? '';
  if (method === 'GET' && !isPlaceholder(last)) return 'query';
  return false;
}

const TOKEN_TYPES = new Map<string, CatalogTokenType>([
  ['企业令牌/用户令牌', 'APP'],
  ['企业令牌', 'ENT'],
  ['用户令牌', 'USER'],
]);

function deriveTokenType(entry: Record<string, unknown>): CatalogTokenType | undefined {
  for (const raw of asArray(entry['permission'])) {
    if (!isRecord(raw)) continue;
    const mapped = TOKEN_TYPES.get(asString(raw['name']).trim());
    if (mapped !== undefined) return mapped;
  }
  return undefined;
}

/**
 * Literal (non-placeholder) values in the documented query string. Only
 * `/v1/auth/token?grant_type=…` has any, and they are exactly what separates its
 * three grants.
 */
function literalQueryValues(url: string): string[] {
  const queryString = url.split('?')[1];
  if (queryString === undefined) return [];
  const out: string[] = [];
  for (const pair of queryString.split('&')) {
    const [, value] = pair.split('=');
    if (value !== undefined && value !== '' && !isPlaceholder(value)) out.push(value);
  }
  return out;
}

type Derived = { entry: CatalogEntry; url: string; multipart: boolean };

function derive(raw: Record<string, unknown>): Derived | undefined {
  const method = normalizeMethod(asString(raw['type']));
  if (method === undefined) return undefined; // nav/section stub: empty `type`
  const url = asString(raw['url']);
  if (!url.startsWith('/v1/')) return undefined; // the oauth2 authorize page, design D2.8

  const pathTemplate = url.split('?')[0] ?? url;
  const fields = isRecord(raw['parameter']) && isRecord(raw['parameter']['fields'])
    ? raw['parameter']['fields']
    : {};
  const query = params(fields, [QUERY_GROUP]);
  const body = params(fields, BODY_GROUPS);
  const scopes = asArray(raw['scopes'])
    .filter(isRecord)
    .map((s) => asString(s['name']).replace(/^pcp:/, ''))
    .filter((s) => s !== '');
  const tokenType = deriveTokenType(raw);

  const entry: CatalogEntry = {
    id: deriveId(method, pathTemplate),
    module: pathTemplate.split('/')[2] ?? '',
    group: asString(raw['groupTitle']) || asString(raw['group']),
    method,
    path: pathTemplate,
    pathParams: pathParamsOf(pathTemplate),
    query,
    body,
    paged: derivePaged(method, pathTemplate, query),
    ...(tokenType === undefined ? {} : { tokenType }),
    scopes,
    title: asString(raw['title']) || asString(raw['name']),
    deprecated: raw['deprecated'] === true,
  };
  return { entry, url, multipart: Object.keys(fields).includes(MULTIPART_GROUP) };
}

/**
 * Three families in the bundle share a (method, path) or a derived verb, and each
 * needs a different discriminator — in this order:
 *
 *  - `GET /v1/auth/token` × 3 — the grants differ only by the literal
 *    `grant_type` in the URL, so that value *replaces* the verb:
 *    `auth.token.client_credentials` and friends.
 *  - `PATCH /v1/pjm/work_items` (批量部分更新工作项属性) beside
 *    `PATCH /v1/pjm/work_items/{work_item_id}` — same verb, different path
 *    shape, so the collection-level write takes `_all`: `pjm.work_items.update`
 *    stays the single-item write and `pjm.work_items.update_all` is the batch.
 *    (The shape suffix is not applied unconditionally because
 *    `PUT /v1/wiki/pages/{page_id}/content` is a singleton sub-resource, not a
 *    collection, and `wiki.pages.content.replace` is what it should be called.)
 *  - `POST /v1/attachments` × 2 — a `multipart/form-data` file upload and an
 *    `application/json` code snippet, separated by the body's content type.
 *
 * The numeric fallback exists so a fourth family can never produce a duplicate
 * id silently; `test/catalog.test.ts` asserts uniqueness either way.
 */
function disambiguate(group: Derived[]): void {
  const byLiteral = group.map((d) => literalQueryValues(d.url).join('_'));
  if (new Set(byLiteral.filter((v) => v !== '')).size === group.length) {
    group.forEach((d, i) => {
      const verbless = d.entry.id.split('.').slice(0, -1).join('.');
      d.entry.id = `${verbless}.${byLiteral[i]}`;
    });
    return;
  }
  const byShape = group.map((d) => (endsWithItem(d.entry.path) ? d.entry.id : `${d.entry.id}_all`));
  if (new Set(byShape).size === group.length) {
    group.forEach((d, i) => {
      d.entry.id = byShape[i] ?? d.entry.id;
    });
    return;
  }
  const byBody = group.map((d) => (d.multipart ? 'multipart' : 'json'));
  if (new Set(byBody).size === group.length) {
    group.forEach((d, i) => {
      d.entry.id = `${d.entry.id}.${byBody[i]}`;
    });
    return;
  }
  group.forEach((d, i) => {
    d.entry.id = `${d.entry.id}.${i + 1}`;
  });
}

/** Normalize the whole bundle: drop stubs and the non-`/v1` page, resolve id collisions, sort by id. */
export function deriveCatalog(raw: string): CatalogEntry[] {
  const derived: Derived[] = [];
  for (const item of bundleEntries(raw)) {
    const one = derive(item);
    if (one !== undefined) derived.push(one);
  }

  const byId = new Map<string, Derived[]>();
  for (const d of derived) {
    const bucket = byId.get(d.entry.id);
    if (bucket === undefined) byId.set(d.entry.id, [d]);
    else bucket.push(d);
  }
  for (const bucket of byId.values()) {
    if (bucket.length > 1) disambiguate(bucket);
  }

  return derived
    .map((d) => d.entry)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.method.localeCompare(b.method)));
}

// ---------------------------------------------------------------------------
// Rendering (design D2.4)
// ---------------------------------------------------------------------------

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Split a generated file into its provenance header and the body the content hash covers. */
export function splitGenerated(text: string): { header: string; body: string } {
  const marker = '\n */\n';
  const end = text.indexOf(marker);
  if (end < 0) throw new Error('generated file has no provenance header');
  const cut = end + marker.length;
  return { header: text.slice(0, cut), body: text.slice(cut) };
}

/** Read the entries back out of a generated file — how `--check` compares without importing TypeScript. */
export function parseGenerated(text: string): CatalogEntry[] {
  const { body } = splitGenerated(text);
  const start = body.indexOf(DECLARATION);
  const end = body.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error('generated file has no CATALOG declaration');
  const parsed: unknown = JSON.parse(body.slice(start + DECLARATION.length, end + 1));
  if (!Array.isArray(parsed)) throw new Error('CATALOG is not an array');
  return parsed as CatalogEntry[];
}

/** The declared content hash from the header, or `undefined` if the header is malformed. */
export function declaredHash(text: string): string | undefined {
  return /content sha256:\s*([0-9a-f]{64})/.exec(text)?.[1];
}

export function renderGenerated(
  entries: readonly CatalogEntry[],
  provenance: { upstreamHash: string; snapshot: string },
): string {
  // One entry per line: the file is hidden from diffs by `.gitattributes`, but a
  // single changed endpoint should still be a single changed line.
  // No trailing comma: the array text stays parseable as JSON, which is how
  // `--check` and `test/catalog.test.ts` read the entries back without importing
  // TypeScript.
  const rows = entries.map((e) => `  ${JSON.stringify(e)}`).join(',\n');
  const body = [
    "import type { CatalogEntry } from './types';",
    '',
    `${DECLARATION}[`,
    rows,
    '];',
    '',
  ].join('\n');
  const header = [
    '/**',
    ' * GENERATED FILE — DO NOT EDIT.',
    ` * source:   ${SOURCE_URL}`,
    ` * snapshot: ${provenance.snapshot}`,
    ` * upstream sha256: ${provenance.upstreamHash}`,
    ` * entries:  ${entries.length}   (all /v1; the oauth2 authorize page is excluded, see design D2.8)`,
    ' * generator: scripts/catalog-sync.ts',
    ' *',
    ' * Run `npm run catalog:sync` to regenerate; `npm run catalog:check` compares',
    ' * this snapshot against the live docs. Hand edits are caught by the content',
    ' * hash below (test/catalog.test.ts).',
    ` * content sha256: ${sha256(body)}`,
    ' */',
    '',
  ].join('\n');
  return header + body;
}

// ---------------------------------------------------------------------------
// Drift report (design D2.5)
// ---------------------------------------------------------------------------

export type Drift = {
  added: string[];
  removed: string[];
  methodChanged: string[];
  pathChanged: string[];
  scopeChanged: string[];
  otherChanged: string[];
};

export function isClean(drift: Drift): boolean {
  return Object.values(drift).every((list) => list.length === 0);
}

const COMPARED_FIELDS = ['module', 'group', 'paged', 'tokenType', 'title', 'deprecated'] as const;

/**
 * Diff two catalogs by id. A moved path or a changed method shows up as an
 * id disappearing and another appearing, so those pairs are re-joined by title
 * to report them as the migrations they are — that is the only signal upstream
 * gives, since it publishes no changelog (research §8).
 */
export function diffCatalogs(current: readonly CatalogEntry[], next: readonly CatalogEntry[]): Drift {
  const drift: Drift = {
    added: [],
    removed: [],
    methodChanged: [],
    pathChanged: [],
    scopeChanged: [],
    otherChanged: [],
  };
  const before = new Map(current.map((e) => [e.id, e]));
  const after = new Map(next.map((e) => [e.id, e]));

  const goneTitles = new Map<string, CatalogEntry>();
  for (const [id, entry] of before) if (!after.has(id)) goneTitles.set(entry.title, entry);

  for (const [id, entry] of after) {
    const previous = before.get(id);
    if (previous === undefined) {
      const moved = goneTitles.get(entry.title);
      if (moved === undefined) {
        drift.added.push(`${entry.method} ${entry.path}  (${id})`);
      } else {
        goneTitles.delete(entry.title);
        const where = moved.path === entry.path ? drift.methodChanged : drift.pathChanged;
        where.push(`${moved.method} ${moved.path} → ${entry.method} ${entry.path}  (${entry.title})`);
      }
      continue;
    }
    if (previous.scopes.join(',') !== entry.scopes.join(',')) {
      drift.scopeChanged.push(`${id}: [${previous.scopes.join(', ')}] → [${entry.scopes.join(', ')}]`);
    }
    const changed = COMPARED_FIELDS.filter((f) => previous[f] !== entry[f]);
    if (changed.length > 0) drift.otherChanged.push(`${id}: ${changed.join(', ')} changed`);
  }
  for (const entry of goneTitles.values()) {
    drift.removed.push(`${entry.method} ${entry.path}  (${entry.id})`);
  }
  return drift;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

async function loadBundle(from: string | undefined): Promise<string> {
  if (from !== undefined) return readFileSync(from, 'utf8');
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`${SOURCE_URL} → HTTP ${response.status}`);
  return await response.text();
}

function histogram(entries: readonly CatalogEntry[], of: (e: CatalogEntry) => string): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(of(entry), (counts.get(of(entry)) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
}

function summarize(entries: readonly CatalogEntry[]): string {
  return [
    `entries: ${entries.length}`,
    `methods: ${histogram(entries, (e) => e.method)}`,
    `tokens:  ${histogram(entries, (e) => e.tokenType ?? '(none)')}`,
    `paged:   ${histogram(entries, (e) => String(e.paged))}`,
  ]
    .map((line) => `  ${line}\n`)
    .join('');
}

async function main(argv: string[]): Promise<number> {
  let check = false;
  let from: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') check = true;
    else if (arg === '--from') {
      from = argv[i + 1];
      i += 1;
      if (from === undefined) {
        process.stderr.write('catalog-sync: --from needs a path\n');
        return 2;
      }
    } else {
      process.stderr.write(`catalog-sync: unknown argument ${String(arg)}\n`);
      return 2;
    }
  }

  const target = path.join(repoRoot(), GENERATED_PATH);
  const raw = await loadBundle(from);
  const entries = deriveCatalog(raw);

  if (entries.length !== EXPECTED_ENTRIES) {
    process.stderr.write(
      `catalog-sync: upstream now yields ${entries.length} endpoints, not ${EXPECTED_ENTRIES}.\n` +
        'This is a real surface change: update the count in prd.md and design.md (D2.8) in the\n' +
        'same commit as the regenerated file — the number has one source of truth.\n',
    );
    if (check) return 1;
  }

  if (!check) {
    const rendered = renderGenerated(entries, {
      upstreamHash: sha256(raw),
      snapshot: new Date().toISOString().slice(0, 10),
    });
    writeFileSync(target, rendered);
    process.stdout.write(`catalog-sync: wrote ${GENERATED_PATH}\n${summarize(entries)}`);
    return 0;
  }

  const onDisk = readFileSync(target, 'utf8');
  const { body } = splitGenerated(onDisk);
  const actualHash = sha256(body);
  if (declaredHash(onDisk) !== actualHash) {
    process.stderr.write(
      'catalog-sync: the vendored file was hand-edited (content hash mismatch).\n' +
        'Run `npm run catalog:sync` instead of editing it.\n',
    );
    return 1;
  }

  const drift = diffCatalogs(parseGenerated(onDisk), entries);
  if (isClean(drift)) {
    process.stdout.write(`catalog-sync: in sync with ${SOURCE_URL}\n${summarize(entries)}`);
    return 0;
  }
  process.stderr.write('catalog-sync: upstream drifted\n');
  for (const [label, lines] of Object.entries(drift)) {
    for (const line of lines) process.stderr.write(`  ${label}: ${line}\n`);
  }
  process.stderr.write('\nRun `npm run catalog:sync` and commit the regenerated file on its own.\n');
  return 1;
}

/** Only run when executed directly, so the tests can import the pure helpers. */
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
