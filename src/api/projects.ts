import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type { Project, ProjectType } from '../types/api';
import { fetchPageOf, iterateOf, parseProject } from './parse';

/**
 * `/v1/pjm/projects` (research §4 rows 2–3). Thin wrappers: no formatting, no
 * config reads, no name resolution — that is `core/metadata.ts`'s job.
 */

export type ProjectListQuery = {
  keywords?: string | undefined;
  type?: ProjectType | string | undefined;
  scope_type?: 'organization' | 'user_group' | undefined;
  scope_id?: string | undefined;
  member_type?: string | undefined;
  member_id?: string | undefined;
  /** `"startTs,endTs"` in unix seconds. */
  created_between?: string | undefined;
  updated_between?: string | undefined;
  include_archived?: boolean | undefined;
  include_deleted?: boolean | undefined;
};

export async function listProjects(
  ctx: Ctx,
  query: ProjectListQuery = {},
  page: PageRequest = {},
): Promise<Page<Project>> {
  return await fetchPageOf(ctx, ENDPOINTS.projects, { ...query }, page, parseProject);
}

export function iterateProjects(
  ctx: Ctx,
  query: ProjectListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<Project, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.projects, { ...query }, options, parseProject);
}

export async function getProject(
  ctx: Ctx,
  projectId: string,
  options: { include_archived?: boolean | undefined; include_deleted?: boolean | undefined } = {},
): Promise<Project> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.project(projectId),
    query: { ...options },
  });
  return parseProject(raw);
}

/**
 * The login/`auth status --check` verification call (design §4.3): a capability we
 * actually need, rather than `GET /v1/myself` — the org token is not user-bound
 * and `pcp:read:account:personal` may simply not be granted, so a `/v1/myself`
 * failure would reject a token that works perfectly.
 *
 * Returns the reported project total.
 */
export async function verifyAccess(ctx: Ctx): Promise<number> {
  const page = await listProjects(ctx, {}, { pageSize: 1, pageIndex: 0 });
  return page.total;
}
