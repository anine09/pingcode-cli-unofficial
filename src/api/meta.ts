import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type { Sprint, User, WorkItemPriority, WorkItemState, WorkItemType } from '../types/api';
import {
  fetchPageOf,
  iterateOf,
  listAllOf,
  parseSprint,
  parseUser,
  parseWorkItemPriority,
  parseWorkItemState,
  parseWorkItemType,
} from './parse';

/**
 * Project-scoped configuration lookups plus the directory (research §4 rows
 * 10–14). These exist because an agent **cannot construct a valid `create`**
 * without discovering project-scoped `type_id` / `state_id` (research §6.13).
 */

/** `GET /v1/pjm/work_item/types?project_id=…` — `project_id` is required. */
export async function listWorkItemTypes(ctx: Ctx, projectId: string): Promise<WorkItemType[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.workItemTypes,
    { project_id: projectId },
    parseWorkItemType,
  );
}

/**
 * `GET /v1/pjm/work_item/states?project_id=…&work_item_type_id=…` — **both** are
 * required, which is why resolving a state *by name* also requires a type
 * (design §6).
 */
export async function listWorkItemStates(
  ctx: Ctx,
  projectId: string,
  workItemTypeId: string,
): Promise<WorkItemState[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.workItemStates,
    { project_id: projectId, work_item_type_id: workItemTypeId },
    parseWorkItemState,
  );
}

/** `GET /v1/pjm/work_item/priorities?project_id=…` */
export async function listWorkItemPriorities(
  ctx: Ctx,
  projectId: string,
): Promise<WorkItemPriority[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.workItemPriorities,
    { project_id: projectId },
    parseWorkItemPriority,
  );
}

export type SprintListQuery = {
  name?: string | undefined;
  status?: 'pending' | 'in_progress' | 'completed' | undefined;
  created_between?: string | undefined;
  updated_between?: string | undefined;
};

/** `GET /v1/pjm/projects/{project_id}/sprints` — only meaningful for scrum/hybrid. */
export async function listSprints(
  ctx: Ctx,
  projectId: string,
  query: SprintListQuery = {},
): Promise<Sprint[]> {
  return await listAllOf(ctx, ENDPOINTS.projectSprints(projectId), { ...query }, parseSprint);
}

export type UserListQuery = {
  /** Fuzzy over name/username. */
  keywords?: string | undefined;
  name?: string | undefined;
  /** CSV, max 20. */
  emails?: string | string[] | undefined;
  mobiles?: string | string[] | undefined;
  department_ids?: string | string[] | undefined;
};

/** `GET /v1/directory/users` — user ids are 32-char hex (research §6.8). */
export async function listUsers(
  ctx: Ctx,
  query: UserListQuery = {},
  page: PageRequest = {},
): Promise<Page<User>> {
  return await fetchPageOf(ctx, ENDPOINTS.users, { ...query }, page, parseUser);
}

export function iterateUsers(
  ctx: Ctx,
  query: UserListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<User, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.users, { ...query }, options, parseUser);
}
