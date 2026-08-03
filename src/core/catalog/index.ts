import { CATALOG as GENERATED } from './catalog.generated';
import type { CatalogEntry, CatalogMethod, CatalogPaging } from './types';

/**
 * The endpoint catalog: 459 `/v1` endpoints scraped from the apiDoc bundle
 * (task 08-02-full-api-coverage, design D2).
 *
 * Two views of the same API live in `core/`, on purpose:
 *
 *  - `endpoints.ts` — the **curated** view. A short, hand-maintained list whose
 *    comments record live-API findings (the singular `/ship/idea/states` trap,
 *    `short_id` being read-only, which scope a 403 really means).
 *  - this catalog — the **exhaustive machine** view, regenerated from upstream,
 *    which is what makes `pingcode api` able to reach every endpoint and what
 *    catches a path migration upstream never announces.
 *
 * It lives in `core/` because both `core/metadata.ts` and `cli/commands/api.ts`
 * need it, and `core` may not import `api` (design D2.7).
 *
 * `catalog.generated.ts` must not be imported anywhere else — this module is the
 * only door, asserted by `test/layering.test.ts`.
 */

export type {
  CatalogEntry,
  CatalogMethod,
  CatalogParam,
  CatalogPaging,
  CatalogTokenType,
} from './types';

/**
 * Corrections to the generated `paged` heuristic (design D2.3).
 *
 * Upstream documents paging **once**, as a global convention, and never repeats
 * it per endpoint — no entry declares `page_index`. So the generator has to guess
 * from shape: a GET that does not end in a path placeholder is a collection.
 * That guess is right for 131 of the 142 GETs it flags and wrong for the 11
 * below, all of which return a single object rather than a page.
 *
 * Keyed by `METHOD path`, so the three `GET /v1/auth/token` grants are covered
 * by one row. This table is hand-written and reviewable; the generated file is
 * neither, which is exactly why the correction lives here.
 */
const PAGED_OVERRIDES = new Map<string, CatalogPaging>([
  // Singletons: one object, no collection semantics at all.
  ['GET /v1/myself', false], // 获取个人信息
  ['GET /v1/directory/team', false], // 获取企业信息
  ['GET /v1/auth/token', false], // the three grants return a token, not a page
  ['GET /v1/wiki/pages/{page_id}/content', false], // a page body
  ['GET /v1/pjm/projects/{project_id}/progress', false], // one progress object
  // Permission views. `points` is an object keyed by domain (`global`, `pjm`, …)
  // rather than an array (research §3.4); the three `my/*` views answer "what may
  // I do", which is a payload, not a listing. Doc-derived, not live-verified —
  // the cost of being wrong is `--page` refused on an endpoint that would have
  // accepted it, never a silent wrong result.
  ['GET /v1/permission/points', false],
  ['GET /v1/permission/my/global', false],
  ['GET /v1/permission/my/pilot', false],
  ['GET /v1/permission/my/principal', false],
]);
// Deliberately **not** overridden: `GET /v1/pjm/processes` (获取全部项目流程) is a
// real collection of process templates, so the heuristic's `'query'` stands.

function overrideKey(entry: CatalogEntry): string {
  return `${entry.method} ${entry.path}`;
}

export const CATALOG: readonly CatalogEntry[] = GENERATED.map((entry) => {
  const paged = PAGED_OVERRIDES.get(overrideKey(entry));
  return paged === undefined ? entry : { ...entry, paged };
});

/** Every `paged` value the loader hands out came from the generator or from `PAGED_OVERRIDES`. */
export const PAGED_OVERRIDE_KEYS: readonly string[] = [...PAGED_OVERRIDES.keys()];

const BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

/** Look up by stable slug, e.g. `scm.commits.get`. */
export function findById(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/**
 * Normalize a user-supplied path: tolerate a missing leading slash, a trailing
 * slash and an accidental query string, and nothing else. Ids are **never**
 * shape-validated (they are 24-hex, 32-hex or bare slugs on this API).
 */
export function normalizePath(input: string): string {
  const withoutQuery = input.split('?')[0] ?? input;
  const withSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function segmentsOf(pathValue: string): string[] {
  return pathValue.split('/').filter((s) => s !== '');
}

function isPlaceholder(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/** How many segments of a template are wildcards — the tie-break that puts exact matches first. */
function wildcardCount(template: string): number {
  return segmentsOf(template).filter(isPlaceholder).length;
}

function templateMatches(template: string, actual: readonly string[]): boolean {
  const expected = segmentsOf(template);
  if (expected.length !== actual.length) return false;
  return expected.every((segment, i) => isPlaceholder(segment) || segment === actual[i]);
}

/**
 * Bare path → catalog entries, `{param}` segments matching any single segment.
 *
 * **Exact before wildcard.** `/v1/pjm/work_items/search` matches both the
 * literal search endpoint and `/v1/pjm/work_items/{work_item_id}`; only the
 * former is meant, so the candidates with the fewest wildcard segments win and
 * the rest are dropped. Differing segment counts never match at all, which is
 * what makes the singular/plural area trap
 * (`/v1/testhub/case/states` vs `/v1/testhub/cases/{case_id}`,
 * `/v1/ship/idea/states` vs `/v1/ship/ideas/{idea_id}`) resolve by itself:
 * segment 3 differs, so neither can be mistaken for the other.
 *
 * Returns every method of the winning path — the caller decides whether the
 * method it wanted is among them (design D3.2).
 */
export function matchPath(input: string): readonly CatalogEntry[] {
  const actual = segmentsOf(normalizePath(input));
  const candidates = CATALOG.filter((entry) => templateMatches(entry.path, actual));
  if (candidates.length === 0) return [];
  const best = Math.min(...candidates.map((entry) => wildcardCount(entry.path)));
  return candidates.filter((entry) => wildcardCount(entry.path) === best);
}

/** The methods the matched path supports — what a method-mismatch error lists. */
export function methodsFor(input: string): readonly CatalogMethod[] {
  const found = new Set(matchPath(input).map((entry) => entry.method));
  return [...found].sort();
}

/**
 * The single entry for a method + bare path, or `undefined`.
 *
 * `GET /v1/auth/token` is the one ambiguous path in the catalog (three grants
 * share it) and resolves to the first grant by id order; the CLI obtains tokens
 * through `core/auth.ts`, never through this lookup.
 */
export function findByMethodPath(method: CatalogMethod, input: string): CatalogEntry | undefined {
  return matchPath(input).find((entry) => entry.method === method);
}

/** Placeholder segments the caller left unsubstituted, e.g. a literal `{page_id}` in the path. */
export function unfilledPathParams(input: string): string[] {
  return segmentsOf(normalizePath(input))
    .filter(isPlaceholder)
    .map((segment) => segment.slice(1, -1));
}

export type MissingParam = { kind: 'query' | 'body'; name: string };

/**
 * Documented required fields the caller did not supply, so `pingcode api` can
 * name them instead of forwarding a request that is going to 400 (design D3.2).
 *
 * Presence only — values are never inspected or type-coerced, for the same
 * reason `parseSetFlags` sends values verbatim: a select property wants an
 * option's `_id`, and guessing types only invents new failure modes.
 */
export function missingRequired(
  entry: CatalogEntry,
  provided: { query?: Iterable<string> | undefined; body?: Iterable<string> | undefined },
): MissingParam[] {
  const suppliedQuery = new Set(provided.query ?? []);
  const suppliedBody = new Set(provided.body ?? []);
  const missing: MissingParam[] = [];
  for (const param of entry.query) {
    if (param.required && !suppliedQuery.has(param.name)) {
      missing.push({ kind: 'query', name: param.name });
    }
  }
  for (const param of entry.body) {
    // Nested apiDoc fields are documented as `updates[].id`; only the top-level
    // key can be checked for presence.
    if (param.required && !param.name.includes('.') && !suppliedBody.has(param.name)) {
      missing.push({ kind: 'body', name: param.name });
    }
  }
  return missing;
}
