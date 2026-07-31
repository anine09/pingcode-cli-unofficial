import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type { WorkItem } from '../types/api';
import { compact, fetchPageOf, iterateOf, parseWorkItem } from './parse';

/**
 * `/v1/pjm/work_items` (research §4 rows 4, 6, 7, 8).
 *
 * `GET /v1/pjm/work_items/{id}` accepts **`id` or `short_id`**; `PATCH` documents
 * only `id` (research §6.9), so mutating callers resolve to a real id first —
 * see `core/metadata.ts`.
 */

export type WorkItemListQuery = {
  project_id?: string | undefined;
  identifier?: string | undefined;
  type_id?: string | undefined;
  parent_id?: string | undefined;
  assignee_id?: string | undefined;
  state_id?: string | undefined;
  priority_id?: string | undefined;
  sprint_id?: string | undefined;
  board_id?: string | undefined;
  entry_id?: string | undefined;
  swimlane_id?: string | undefined;
  phase_id?: string | undefined;
  version_id?: string | undefined;
  tag_id?: string | undefined;
  bug_type_id?: string | undefined;
  created_by?: string | undefined;
  participant_id?: string | undefined;
  keywords?: string | undefined;
  /** CSV of field names, max 32 (research §6.19). */
  include_public_image_token?: string | string[] | undefined;
  include_archived?: boolean | undefined;
  include_deleted?: boolean | undefined;
};

export type WorkItemGetOptions = {
  include_public_image_token?: string | string[] | undefined;
  include_archived?: boolean | undefined;
  include_deleted?: boolean | undefined;
};

/** Required: `project_id`, `type_id`, `title` (research §4 row 7). */
export type CreateWorkItemInput = {
  project_id: string;
  type_id: string;
  title: string;
  description?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  priority_id?: string | undefined;
  state_id?: string | undefined;
  assignee_id?: string | undefined;
  parent_id?: string | undefined;
  sprint_id?: string | undefined;
  /** **Replaces** the whole array (design §7.2). */
  version_ids?: string[] | undefined;
  board_id?: string | undefined;
  entry_id?: string | undefined;
  swimlane_id?: string | undefined;
  story_points?: number | undefined;
  estimated_workload?: number | undefined;
  remaining_workload?: number | undefined;
  /** **Replaces** the whole object; keys must exist in the type's property scheme. */
  properties?: Record<string, unknown> | undefined;
  /** **Replaces** the whole array. */
  participant_ids?: string[] | undefined;
};

/** Any subset of the updatable fields (research §4 row 8). `state_id` drives transitions. */
export type UpdateWorkItemInput = {
  title?: string | undefined;
  description?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  priority_id?: string | undefined;
  state_id?: string | undefined;
  assignee_id?: string | undefined;
  parent_id?: string | undefined;
  version_ids?: string[] | undefined;
  board_id?: string | undefined;
  entry_id?: string | undefined;
  swimlane_id?: string | undefined;
  phase_id?: string | undefined;
  story_points?: number | undefined;
  estimated_workload?: number | undefined;
  remaining_workload?: number | undefined;
  properties?: Record<string, unknown> | undefined;
};

export async function listWorkItems(
  ctx: Ctx,
  query: WorkItemListQuery = {},
  page: PageRequest = {},
): Promise<Page<WorkItem>> {
  return await fetchPageOf(ctx, ENDPOINTS.workItems, { ...query }, page, parseWorkItem);
}

export function iterateWorkItems(
  ctx: Ctx,
  query: WorkItemListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<WorkItem, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.workItems, { ...query }, options, parseWorkItem);
}

/** `id` **or** `short_id` (research §6.9). */
export async function getWorkItem(
  ctx: Ctx,
  workItemId: string,
  options: WorkItemGetOptions = {},
): Promise<WorkItem> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.workItem(workItemId),
    query: { ...options },
  });
  return parseWorkItem(raw);
}

/** Look a work item up by its human identifier, e.g. `SCR-5`. */
export async function findWorkItemByIdentifier(
  ctx: Ctx,
  identifier: string,
  options: WorkItemGetOptions = {},
): Promise<WorkItem[]> {
  const page = await listWorkItems(ctx, { identifier, ...options }, { pageSize: 10, pageIndex: 0 });
  return page.values;
}

export async function createWorkItem(ctx: Ctx, input: CreateWorkItemInput): Promise<WorkItem> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.workItems,
    body: compact(input),
  });
  return parseWorkItem(raw);
}

/**
 * Only the fields present in `patch` are sent — the API replaces arrays and
 * `properties` wholesale rather than merging (design §7.2, research §6.16).
 * An empty patch is a caller error (`UsageError`, exit 2) and is not sent here.
 */
export async function updateWorkItem(
  ctx: Ctx,
  workItemId: string,
  patch: UpdateWorkItemInput,
): Promise<WorkItem> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.workItem(workItemId),
    body: compact(patch),
  });
  return parseWorkItem(raw);
}
