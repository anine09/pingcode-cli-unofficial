/**
 * Endpoint paths for the MVP surface (research §4).
 *
 * They live in `core` because both `api/*` (typed wrappers) and
 * `core/metadata.ts` (name→id resolution) need them, and `core` must not import
 * `api`. One place to change if a path ever moves.
 */
export const ENDPOINTS = {
  token: '/v1/auth/token',

  projects: '/v1/pjm/projects',
  project: (projectId: string): string => `/v1/pjm/projects/${encodeURIComponent(projectId)}`,
  projectSprints: (projectId: string): string =>
    `/v1/pjm/projects/${encodeURIComponent(projectId)}/sprints`,

  workItems: '/v1/pjm/work_items',
  /** Accepts **`id` or `short_id`** on GET (research §6.9); PATCH documents only `id`. */
  workItem: (workItemId: string): string =>
    `/v1/pjm/work_items/${encodeURIComponent(workItemId)}`,

  workItemTypes: '/v1/pjm/work_item/types',
  workItemStates: '/v1/pjm/work_item/states',
  workItemPriorities: '/v1/pjm/work_item/priorities',

  users: '/v1/directory/users',
} as const;
