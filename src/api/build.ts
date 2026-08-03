import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type { BuildRecord } from '../types/api';
import { compact, fetchPageOf, iterateOf, parseBuildRecord } from './parse';

/**
 * `/v1/build/builds` — 构建记录 ([S§3.12.8]), the CI write-back surface for builds.
 *
 * One family, five wrappers, and three facts that shape all of them:
 *
 *  - **企业令牌 only**, like the whole DevOps area, under
 *    `pcp:read:devops:build` / `pcp:write:devops:build` — its own scope pair, not
 *    shared with scm's `devops:code` or release's `devops:deploy`.
 *  - **Organisation-level.** No platform, repository or project appears in either
 *    path, so no wrapper here takes a parent id. A build reaches the rest of PingCode
 *    only through `work_item_identifiers`.
 *  - **The list takes no query at all.** Not one filter is documented, and five
 *    plausible ones (`identifier`, `name`, `status`, `provider`, `work_item_id`) were
 *    each probed live on 2026-08-04 and **silently ignored**. So `listBuilds` has no
 *    query parameter to offer — deliberately, because a wrapper that accepted one
 *    would promise filtering the server does not do (D11.2).
 *
 * This family is also the only one in the area with a `DELETE`, and — unlike scm,
 * where `deleteBranch` orphans commit refs — deleting a build affects nothing else.
 *
 * No `PUT`: `PUT /v1/build/builds/{id}` replaces the whole record and blanks what it
 * is not sent (design D8.4), so it stays reachable only as
 * `pingcode api PUT /v1/build/builds/<id>`.
 *
 * Nothing here formats or resolves: a build has no name→id lookup at all (its
 * `identifier` is not unique), and rendering happens in `cli/`.
 */

/**
 * Required: all of `name`, `identifier`, `provider`, `status`, `start_at`, `end_at`
 * and `duration` — seven of the eleven fields, which is the most demanding create in
 * the CLI. Nothing is derived: `duration` is required *alongside* the two timestamps
 * and the server never computes it from them.
 *
 * `provider` is `bamboo|bitbucket|jenkins|other` and `status` is `success|failure`;
 * both are typed `string` because a value the server later accepts must not be
 * refused by a CLI that shipped before it (a wrong one is 400 `100003`).
 */
export type CreateBuildInput = {
  name: string;
  /** The caller's build number. **Not unique** — duplicates are accepted (live 2026-08-04). */
  identifier: string;
  provider: string;
  status: string;
  /** Unix **seconds**; the server range-checks this (400 `100004` for `0` or for ms). */
  start_at: number;
  end_at: number;
  /** Seconds. */
  duration: number;
  job_url?: string | undefined;
  result_overview?: string | undefined;
  result_url?: string | undefined;
  /** Work item **identifiers** (`PLM-001`), not ids. Unknown ones are silently dropped. */
  work_item_identifiers?: string[] | undefined;
};

/**
 * Any subset — every field of the create is patchable, including `identifier`
 * (verified live: a PATCH of `name` + `identifier` left everything else intact).
 *
 * `work_item_identifiers` **replaces** the whole link set and `[]` clears it, the same
 * array semantics as the rest of the API.
 */
export type UpdateBuildInput = {
  name?: string | undefined;
  identifier?: string | undefined;
  provider?: string | undefined;
  status?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  duration?: number | undefined;
  job_url?: string | undefined;
  result_overview?: string | undefined;
  result_url?: string | undefined;
  work_item_identifiers?: string[] | undefined;
};

/** No query parameter: this endpoint honours none (see the module note). */
export async function listBuilds(ctx: Ctx, page: PageRequest = {}): Promise<Page<BuildRecord>> {
  return await fetchPageOf(ctx, ENDPOINTS.buildRecords, {}, page, parseBuildRecord);
}

export function iterateBuilds(
  ctx: Ctx,
  options: PaginateOptions = {},
): AsyncGenerator<BuildRecord, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.buildRecords, {}, options, parseBuildRecord);
}

export async function getBuild(ctx: Ctx, buildId: string): Promise<BuildRecord> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.buildRecord(buildId),
  });
  return parseBuildRecord(raw);
}

export async function createBuild(ctx: Ctx, input: CreateBuildInput): Promise<BuildRecord> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.buildRecords,
    body: compact(input),
  });
  return parseBuildRecord(raw);
}

export async function updateBuild(
  ctx: Ctx,
  buildId: string,
  patch: UpdateBuildInput,
): Promise<BuildRecord> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.buildRecord(buildId),
    body: compact(patch),
  });
  return parseBuildRecord(raw);
}

/**
 * Delete one build record. **The only `DELETE` in the DevOps area outside scm's
 * branch**, and a hard one: the row is gone and a following `GET` answers 400
 * `100203` (live 2026-08-04).
 *
 * The response is the deleted record, which is why this returns a `BuildRecord`
 * rather than `void` — the command layer echoes what went.
 */
export async function deleteBuild(ctx: Ctx, buildId: string): Promise<BuildRecord> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.buildRecord(buildId),
  });
  return parseBuildRecord(raw);
}
