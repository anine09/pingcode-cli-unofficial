/**
 * The catalog entry shape (task 08-02-full-api-coverage, design D2.1).
 *
 * This is the contract between `scripts/catalog-sync.ts` (which writes
 * `catalog.generated.ts`) and `core/catalog/index.ts` (which loads it). Field
 * names *are* the contract: the generated file is data, so a rename here is a
 * regeneration, not a refactor.
 *
 * Deliberately **not** here: response models, parsers, help text, name→id
 * resolvers. The generic layer passes JSON through untouched (design D2.2), and
 * name resolution stays hand-registered in `core/metadata.ts`.
 */

export type CatalogMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Which OAuth2 token the endpoint accepts, from the apiDoc `permission` field:
 *
 *  - `APP`  — 企业令牌/用户令牌, either works (388 endpoints)
 *  - `ENT`  — 企业令牌 only (61)
 *  - `USER` — 用户令牌 only (7)
 *
 * This CLI's `client_credentials` flow holds an **enterprise** token, so `APP`
 * and `ENT` are reachable and `USER` must be refused before any network IO
 * (design D8.5).
 */
export type CatalogTokenType = 'APP' | 'ENT' | 'USER';

/**
 * Pagination flavour, derived (design D2.3) rather than declared: the upstream
 * docs describe paging once as a global convention and never repeat it in the
 * per-endpoint parameter tables (research §4.1), so no entry carries a
 * `page_index` parameter to key off.
 *
 *  - `'query'`  — 0-based `page_index` / `page_size` in the query string
 *  - `'search'` — the five `POST …/search` endpoints, page fields in the body
 *  - `false`    — not a collection; passing `--page*` is a usage error
 */
export type CatalogPaging = 'query' | 'search' | false;

/** One documented query or body field. Types are the apiDoc strings (`String`, `Number`, `Object[]`, …). */
export type CatalogParam = {
  name: string;
  type: string;
  required: boolean;
};

export type CatalogEntry = {
  /**
   * Stable slug `<module>.<resource…>.<verb>` — e.g. `scm.commits.get`,
   * `pjm.work_items.search`. Derived from (method, path) only and therefore
   * idempotent: an upstream title change never moves an id, only a path
   * migration does.
   */
  id: string;
  /**
   * Top-level namespace: the URL segment after `/v1` (research §2's `area`
   * axis) — `pjm`, `ship`, `testhub`, `scm`, `build`, `release`, `directory`,
   * `wiki`, `relations`, `comments`, `attachments`, `activities`,
   * `participants`, `reviews`, `permission`, `security`, `workloads`,
   * `workload_types`, `nexus`, `auth`, `myself`.
   */
  module: string;
  /** The apiDoc group label (Chinese), e.g. 「工作项」「托管平台」. The facet `api list` groups by. */
  group: string;
  method: CatalogMethod;
  /** Path template with `{…}` placeholders kept verbatim, e.g. `/v1/scm/commits/{commit_id_or_sha}`. */
  path: string;
  /** Placeholder names in path order, e.g. `['product_id', 'repository_id']`. */
  pathParams: readonly string[];
  query: readonly CatalogParam[];
  body: readonly CatalogParam[];
  paged: CatalogPaging;
  /**
   * Absent means the endpoint needs **no** token at all — true of exactly the
   * three `GET /v1/auth/token` grants, which are how a token is obtained in the
   * first place. That is why the three histogram buckets sum to 456 rather than
   * 459 (design D2.3): the union stays three-valued and the token-less entries
   * simply omit the field.
   */
  tokenType?: CatalogTokenType;
  /** Declared scopes without the `pcp:` prefix, e.g. `['read:devops:code']`. `[]` = the docs declare none — never guessed. */
  scopes: readonly string[];
  /** The apiDoc title (Chinese), e.g. 获取工作项列表. */
  title: string;
  /**
   * Always `false` today (no entry carries an apiDoc deprecation marker). Kept
   * because upstream publishes no changelog: the only sunset signals are an
   * entry disappearing or this flag appearing, and `catalog:check` needs
   * somewhere to report the latter.
   */
  deprecated: boolean;
};
