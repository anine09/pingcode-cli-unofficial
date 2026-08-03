import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type { Deployment, ReleaseEnvironment } from '../types/api';
import {
  compact,
  fetchPageOf,
  iterateOf,
  parseDeployment,
  parseReleaseEnvironment,
} from './parse';

/**
 * `/v1/release/**` — 环境 and 部署 ([S§3.12.9-10]), the deployment write-back surface.
 *
 * Two families under one area and **one** scope pair, `pcp:read:devops:deploy` /
 * `pcp:write:devops:deploy` — environments are not separately scoped, so a token that
 * can write a deploy can also create the environment it names. 企业令牌 only, like the
 * rest of DevOps.
 *
 * Both families are organisation-level: no platform, no repository, no project. The
 * one parent relationship in this file is deploy → environment, and it travels as
 * `env_id` in the body rather than in the path — so a deploy is *not* addressed under
 * its environment, and `getDeploy` takes no environment id.
 *
 * Three live findings (2026-08-04) the signatures encode:
 *
 *  - **`EnvironmentListQuery.name` is optional**, though the vendor docs (and hence
 *    the catalog) mark it required. Unfiltered, the list returns every environment.
 *    When sent it is an **exact, case-insensitive** match, so it cannot stand in for a
 *    search — the same shape as a platform's or a branch's `?name=`.
 *  - **`?env_id=` is the deploy list's only working filter.** `status`,
 *    `release_name` and `work_item_id` were probed and silently ignored, so they are
 *    absent here rather than offered and dead (D11.2). An unknown-but-well-formed
 *    `env_id` yields 200 with zero rows, which is worth knowing: the empty list does
 *    **not** distinguish "no deploys yet" from "no such environment".
 *  - **`work_item_identifiers` silently drops unknown identifiers** and, on PATCH,
 *    replaces the whole set. The response's `work_items` is the only evidence a link
 *    landed, so the command layer compares the two.
 *
 * Neither family's `DELETE` is wrapped here (PRD out of scope, pending the parent
 * task's ruling on the two `DELETE`s) and neither `PUT` ever will be (design D8.4);
 * both remain reachable through `pingcode api`. That gap is deliberate and is stated
 * in `--help`, not left for a caller to discover.
 */

/** Required: `name`, unique per organisation (a duplicate is 400 `100105`). */
export type CreateEnvironmentInput = {
  name: string;
  /** Must be a valid URL. An empty string is refused, so this can never be cleared. */
  html_url?: string | undefined;
};

/** Any subset; both fields are patchable. `html_url: ''` is refused by the server. */
export type UpdateEnvironmentInput = {
  name?: string | undefined;
  html_url?: string | undefined;
};

export type EnvironmentListQuery = {
  /**
   * **Exact, case-insensitive** match on the environment name — and **optional**,
   * despite the docs marking it required (live 2026-08-04). Because it is exact it
   * cannot answer "which environments are there", so name *resolution* loads the
   * whole (tiny) list instead; see the `release-env` row in `core/metadata/registry.ts`.
   */
  name?: string | undefined;
};

export async function listEnvironments(
  ctx: Ctx,
  query: EnvironmentListQuery = {},
  page: PageRequest = {},
): Promise<Page<ReleaseEnvironment>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.releaseEnvironments,
    { ...query },
    page,
    parseReleaseEnvironment,
  );
}

export function iterateEnvironments(
  ctx: Ctx,
  query: EnvironmentListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<ReleaseEnvironment, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.releaseEnvironments,
    { ...query },
    options,
    parseReleaseEnvironment,
  );
}

export async function getEnvironment(
  ctx: Ctx,
  environmentId: string,
): Promise<ReleaseEnvironment> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.releaseEnvironment(environmentId),
  });
  return parseReleaseEnvironment(raw);
}

export async function createEnvironment(
  ctx: Ctx,
  input: CreateEnvironmentInput,
): Promise<ReleaseEnvironment> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.releaseEnvironments,
    body: compact(input),
  });
  return parseReleaseEnvironment(raw);
}

export async function updateEnvironment(
  ctx: Ctx,
  environmentId: string,
  patch: UpdateEnvironmentInput,
): Promise<ReleaseEnvironment> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.releaseEnvironment(environmentId),
    body: compact(patch),
  });
  return parseReleaseEnvironment(raw);
}

// ---------------------------------------------------------------------------
// 部署 deploys
// ---------------------------------------------------------------------------

export type DeployListQuery = {
  /**
   * The **only** filter this endpoint honours, and an exact one. Note that an
   * environment id that does not exist returns 200 with no rows rather than a
   * not-found: silence here means "no match", not "no such environment".
   */
  env_id?: string | undefined;
};

/**
 * Required: `status`, `env_id`, `release_name`, `start_at`, `end_at`, `duration`.
 *
 * `status` is `not_deployed|deployed` — there is no failed or rolled-back state; a
 * rollback is recorded as another deploy. Typed `string` for the module's usual
 * reason.
 *
 * `env_id` is one of the very few identifiers this API shape-validates (400 `100003`
 * for a non-ObjectId) and it must exist (400 `100205`, which maps to exit 5 because
 * the row the request named really is absent).
 */
export type CreateDeployInput = {
  status: string;
  env_id: string;
  release_name: string;
  /** Unix **seconds**; range-checked server-side (400 `100004` for `0` or for ms). */
  start_at: number;
  end_at: number;
  /** Seconds. Required, and never derived from the two timestamps. */
  duration: number;
  release_url?: string | undefined;
  /** Work item **identifiers** (`PLM-001`), not ids. Unknown ones are silently dropped. */
  work_item_identifiers?: string[] | undefined;
};

/**
 * Any subset — including `env_id`, so a deploy can be moved to another environment.
 * Verified live as a genuine partial update: patching only `status` left
 * `release_name`, `release_url`, the timestamps and `work_items` intact.
 */
export type UpdateDeployInput = {
  status?: string | undefined;
  env_id?: string | undefined;
  release_name?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  duration?: number | undefined;
  release_url?: string | undefined;
  /** Replaces the whole link set; `[]` clears it. */
  work_item_identifiers?: string[] | undefined;
};

export async function listDeploys(
  ctx: Ctx,
  query: DeployListQuery = {},
  page: PageRequest = {},
): Promise<Page<Deployment>> {
  return await fetchPageOf(ctx, ENDPOINTS.releaseDeploys, { ...query }, page, parseDeployment);
}

export function iterateDeploys(
  ctx: Ctx,
  query: DeployListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<Deployment, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.releaseDeploys, { ...query }, options, parseDeployment);
}

export async function getDeploy(ctx: Ctx, deployId: string): Promise<Deployment> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.releaseDeploy(deployId),
  });
  return parseDeployment(raw);
}

export async function createDeploy(ctx: Ctx, input: CreateDeployInput): Promise<Deployment> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.releaseDeploys,
    body: compact(input),
  });
  return parseDeployment(raw);
}

export async function updateDeploy(
  ctx: Ctx,
  deployId: string,
  patch: UpdateDeployInput,
): Promise<Deployment> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.releaseDeploy(deployId),
    body: compact(patch),
  });
  return parseDeployment(raw);
}
