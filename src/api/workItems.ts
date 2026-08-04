import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type {
  Page,
  PageRequest,
  PaginateOptions,
  SearchPayload,
} from '../core/paginate';
import type {
  WorkItem,
  WorkItemBulkUpdateResult,
  WorkItemLink,
  WorkItemRelationType,
  WorkItemTag,
  WorkItemTagAttachment,
  WorkItemTransitionHistory,
} from '../types/api';
import {
  compact,
  fetchPageOf,
  fetchSearchPageOf,
  iterateOf,
  iterateSearchOf,
  listAllOf,
  parseWorkItem,
  parseWorkItemBulkUpdateResult,
  parseWorkItemLink,
  parseWorkItemRelationType,
  parseWorkItemTag,
  parseWorkItemTagAttachment,
  parseWorkItemTransitionHistory,
} from './parse';

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

// ---------------------------------------------------------------------------
// POST /v1/pjm/work_items/search — filtered reads, live-verified 2026-08-04
// ---------------------------------------------------------------------------
//
// ⚠️ **This endpoint ignores paging.** `payload.page_index` / `payload.page_size`,
// the same two at the top level of the body, and the query string were all tried:
// every one answers `page_index: 0, page_size: 30`. `total` is accurate, so it
// reports how many rows matched and then hands back the first 30 of them. That is
// *not* ship's search, which pages for real (design §14.1), so nothing here may be
// reasoned about by analogy with `searchIdeas` / `searchTickets`.
//
// The filter vocabulary is also **not** the query-string vocabulary of the simple
// list — see `core/endpoints.ts` for the enumerated field and operator sets. The
// short version: `?type_id=` is `type` (a bare slug), `?tag_id=` is `tags.id`, and
// `identifier` / `short_id` / `bug_type_id` cannot be filtered on at all.

/**
 * One page — in practice **the only page** — of `POST /v1/pjm/work_items/search`.
 *
 * `page` is passed through for signature symmetry with `listWorkItems` and because
 * `fetchSearchPageOf` needs something to normalise the envelope against; upstream
 * disregards it. Callers should say so to the user rather than pretend otherwise.
 */
export async function searchWorkItems(
  ctx: Ctx,
  payload: SearchPayload = {},
  page: PageRequest = {},
): Promise<Page<WorkItem>> {
  return await fetchSearchPageOf(ctx, ENDPOINTS.workItemsSearch, payload, page, parseWorkItem);
}

/**
 * Walk the search endpoint. Kept for symmetry with the other read paths and used by
 * nothing in the command layer: because the echoed `page_index` never advances,
 * `walkPages` warns and stops after the first page (`core/paginate.ts`), so this
 * yields at most 30 items. `project work-item list` refuses `--all` in search mode
 * instead of shipping that as a feature.
 */
export function iterateSearchWorkItems(
  ctx: Ctx,
  payload: SearchPayload = {},
  options: PaginateOptions = {},
): AsyncGenerator<WorkItem, void, undefined> {
  return iterateSearchOf(ctx, ENDPOINTS.workItemsSearch, payload, options, parseWorkItem);
}

// ---------------------------------------------------------------------------
// PATCH /v1/pjm/work_items — one property across many work items
// ---------------------------------------------------------------------------

/**
 * The bulk body: **one** property name and **one** value, applied to every id.
 *
 * Not a patch object — `{title, state_id}` is not expressible, and two properties
 * need two calls.
 *
 * Live behaviour that the type cannot express and callers must handle:
 *
 *  - **omitting `property_value` clears the field** (`updates: 1`), so it is required
 *    here even though the docs mark it optional;
 *  - a property the endpoint does not apply — `sprint_id` is the important one, and it
 *    is the use case this endpoint was documented for — answers HTTP 200 with
 *    `updates: 0` and changes nothing;
 *  - an id that does not exist is skipped silently, and the rest of the batch still
 *    lands (best-effort, unlike the **atomic** sprint/version bulks of design D15.5);
 *  - ids may span projects;
 *  - the change is recorded in **no** activity feed, so it is invisible to an audit.
 */
export type BulkUpdateWorkItemsInput = {
  ids: readonly string[];
  /** Verified to apply: `assignee_id`, `state_id`, `priority_id`, `title`, `description`. */
  property_name: string;
  property_value: unknown;
};

/**
 * `PATCH /v1/pjm/work_items`. Returns the three counts and nothing else — compare
 * `updates` against `ids.length` to find out whether anything happened.
 */
export async function bulkUpdateWorkItems(
  ctx: Ctx,
  input: BulkUpdateWorkItemsInput,
): Promise<WorkItemBulkUpdateResult> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.workItems,
    body: {
      ids: [...input.ids],
      property_name: input.property_name,
      property_value: input.property_value,
    },
  });
  return parseWorkItemBulkUpdateResult(raw);
}

/**
 * Delete one work item. **The recycle bin keeps it** — the response's own `url`
 * carries `?include_deleted=true`, and the row stays reachable through
 * `include_deleted` — which is why a work item qualifies as a refined DELETE under
 * PRD R3 while a project (no DELETE at all) and a sprint (likewise) do not.
 *
 * Returns the deleted work item, which is what the command layer echoes.
 */
export async function deleteWorkItem(ctx: Ctx, workItemId: string): Promise<WorkItem> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.workItem(workItemId),
  });
  return parseWorkItem(raw);
}

// ---------------------------------------------------------------------------
// /v1/pjm/work_items/{id}/relations — the TYPED, same-kind link family
// ---------------------------------------------------------------------------
//
// Not `/v1/relations` (`api/common.ts`), which links objects of *different* kinds and
// has no type at all; `work_item → work_item` is in fact refused there (design D7.6).
// Everything below needs a `relation_type` and accepts nothing but work items.

/** Required: both. `relation_type` takes the `category` slug or the type's 24-hex id. */
export type CreateWorkItemLinkInput = {
  target_work_item_id: string;
  relation_type: string;
};

/**
 * Link two work items. The server also creates the **inverse** row on the target,
 * with the paired category (`block` here becomes `blocked_by` there) and a
 * **different** id.
 *
 * Live quirks worth knowing before scripting this: the target may live in another
 * project, a work item may be linked to **itself** (accepted, and it produces two
 * rows), and a duplicate pair is 400 `100350` `工作项关联已经存在`.
 */
export async function createWorkItemLink(
  ctx: Ctx,
  workItemId: string,
  input: CreateWorkItemLinkInput,
): Promise<WorkItemLink> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.workItemRelations(workItemId),
    body: compact(input),
  });
  return parseWorkItemLink(raw);
}

export type WorkItemLinkListQuery = {
  /** The `category` slug. Enum-validated: an unknown value is 400 `100001`. */
  relation_type?: string | undefined;
};

/**
 * List one work item's links. ⚠️ An unknown work item answers **200 with zero rows**
 * rather than a not-found — so an empty result here is not proof the item exists.
 */
export async function listWorkItemLinks(
  ctx: Ctx,
  workItemId: string,
  query: WorkItemLinkListQuery = {},
  page: PageRequest = {},
): Promise<Page<WorkItemLink>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.workItemRelations(workItemId),
    { ...query },
    page,
    parseWorkItemLink,
  );
}

export function iterateWorkItemLinks(
  ctx: Ctx,
  workItemId: string,
  query: WorkItemLinkListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<WorkItemLink, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.workItemRelations(workItemId),
    { ...query },
    options,
    parseWorkItemLink,
  );
}

/** The work-item segment is enforced: a link id from another item is 400 `100351`. */
export async function getWorkItemLink(
  ctx: Ctx,
  workItemId: string,
  relationId: string,
): Promise<WorkItemLink> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.workItemRelation(workItemId, relationId),
  });
  return parseWorkItemLink(raw);
}

/**
 * Unlink. **Both directions go at once** — the inverse row on the other work item
 * disappears too (verified live) — and a second delete of the same id is 400 `100351`.
 * Returns the deleted link.
 */
export async function deleteWorkItemLink(
  ctx: Ctx,
  workItemId: string,
  relationId: string,
): Promise<WorkItemLink> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.workItemRelation(workItemId, relationId),
  });
  return parseWorkItemLink(raw);
}

// ---------------------------------------------------------------------------
// /v1/pjm/work_items/{id}/tags — add, get-one, delete. There is NO list.
// ---------------------------------------------------------------------------

/**
 * Attach a tag. `tag_id` must be a tag of **this work item's project**: the
 * vocabulary endpoint returns every tag in the organisation regardless of the
 * `project_id` it demands, so most ids it offers are refused here with 400 `100354`
 * `'tag'资源不存在` — a code that therefore cannot be mapped to `not_found`, because
 * the tag it calls missing is one the user can see. A duplicate is 400 `100352`.
 */
export async function addWorkItemTag(
  ctx: Ctx,
  workItemId: string,
  tagId: string,
): Promise<WorkItemTagAttachment> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.workItemTags(workItemId),
    body: { tag_id: tagId },
  });
  return parseWorkItemTagAttachment(raw);
}

/**
 * One tag on one work item. ⚠️ **There is no list counterpart** (research §3.8.3):
 * read `work-item get`'s `tags[]` to see them all. A tag that is not attached — and a
 * tag id that does not exist — both answer 400 `100357` `工作项不包含此标签`.
 */
export async function getWorkItemTag(
  ctx: Ctx,
  workItemId: string,
  tagId: string,
): Promise<WorkItemTagAttachment> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.workItemTag(workItemId, tagId),
  });
  return parseWorkItemTagAttachment(raw);
}

/**
 * Detach a tag. **Not idempotent**: removing the same tag twice answers HTTP **500**
 * `100000` `内部服务错误` rather than a 400, so a retry after a timeout can look like
 * a server fault when it is really a second delete.
 */
export async function deleteWorkItemTag(
  ctx: Ctx,
  workItemId: string,
  tagId: string,
): Promise<WorkItemTagAttachment> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.workItemTag(workItemId, tagId),
  });
  return parseWorkItemTagAttachment(raw);
}

// ---------------------------------------------------------------------------
// /v1/pjm/work_items/{id}/transition_histories — state changes only
// ---------------------------------------------------------------------------

/**
 * List a work item's state changes, newest last as the API orders them. Unlike the
 * link list, this one **does** validate the work item (400 `100317`).
 */
export async function listWorkItemTransitionHistories(
  ctx: Ctx,
  workItemId: string,
  page: PageRequest = {},
): Promise<Page<WorkItemTransitionHistory>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.workItemTransitionHistories(workItemId),
    {},
    page,
    parseWorkItemTransitionHistory,
  );
}

export function iterateWorkItemTransitionHistories(
  ctx: Ctx,
  workItemId: string,
  options: PaginateOptions = {},
): AsyncGenerator<WorkItemTransitionHistory, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.workItemTransitionHistories(workItemId),
    {},
    options,
    parseWorkItemTransitionHistory,
  );
}

/** An unknown history id is 400 `1003108` — note the seven digits. */
export async function getWorkItemTransitionHistory(
  ctx: Ctx,
  workItemId: string,
  historyId: string,
): Promise<WorkItemTransitionHistory> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.workItemTransitionHistory(workItemId, historyId),
  });
  return parseWorkItemTransitionHistory(raw);
}

// ---------------------------------------------------------------------------
// the two org-level vocabularies
// ---------------------------------------------------------------------------

/**
 * `GET /v1/pjm/work_item/relation_types` — nine system rows, no parameters at all,
 * and the only source for the `relation_type` a link write requires. `category` is
 * stable across tenants, `id` is not.
 */
export async function listWorkItemRelationTypes(ctx: Ctx): Promise<WorkItemRelationType[]> {
  return await listAllOf(ctx, ENDPOINTS.workItemRelationTypes, {}, parseWorkItemRelationType);
}

export type WorkItemTagListQuery = {
  /** Case-insensitive **substring**, not an exact match. */
  name?: string | undefined;
};

/**
 * `GET /v1/pjm/work_item/tags?project_id=` — the only way to enumerate tags.
 *
 * ⚠️ `project_id` is **required and ignored**: it is validated (an unknown project is
 * 400 `100300`) and then plays no part in the result, which is the whole
 * organisation's tag list. Verified live 2026-08-04 across three projects, byte for
 * byte identical, and identical to the org-level `GET /v1/pjm/work_item_tags`. Tags
 * are still really project-scoped on the write side, and names repeat — so treat this
 * as a catalogue to look ids up in, not as the set of tags a given project can use.
 */
export async function listWorkItemTagVocabulary(
  ctx: Ctx,
  projectId: string,
  query: WorkItemTagListQuery = {},
): Promise<WorkItemTag[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.workItemTagVocabulary,
    { project_id: projectId, ...query },
    parseWorkItemTag,
  );
}
