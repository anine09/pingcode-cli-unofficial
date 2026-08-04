/**
 * pjm (项目管理 / 敏捷开发) parsers — research §4/§4.2.
 *
 * Split out of the former single 897-line `src/api/parse.ts` by F1 (design D6.5).
 * `src/api/parse.ts` re-exports every name below, so **no existing import path
 * changed**; the move is mechanical and behaviour-free.
 *
 * The module-wide rule still holds: this layer is the **only** place wire quirks are
 * normalised (`0/1` booleans, `versions[]` vs `version`), unknown fields are always
 * preserved so `--json` stays faithful, and nothing here formats output.
 */

import type {
  BulkCreateResult,
  Project,
  ProjectMember,
  ProjectProgress,
  ProjectVersion,
  Ref,
  Sprint,
  User,
  VersionStage,
  WorkItem,
  WorkItemBulkUpdateResult,
  WorkItemLink,
  WorkItemPriority,
  WorkItemRelationType,
  WorkItemState,
  WorkItemTag,
  WorkItemTagAttachment,
  WorkItemTransitionHistory,
  WorkItemType,
} from '../../types/api';
import { asBooleanFlag, asNumber, asRecord, asString, parseRef, parseRefList } from './common';

export function parseProject(raw: unknown): Project {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    identifier: asString(record.identifier),
    type: asString(record.type),
    description: asString(record.description),
    url: asString(record.url),
    html_url: asString(record.html_url),
    visibility: asString(record.visibility),
    process_id: asString(record.process_id),
    state: parseRef(record.state),
    assignee: parseRef(record.assignee),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseProjectMember(raw: unknown): ProjectMember {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    type: asString(record.type),
    user: parseRef(record.user),
    user_group: parseRef(record.user_group),
    role: parseRef(record.role),
    project: parseRef(record.project),
    url: asString(record.url),
  };
}

/** A bare `{work_item: {…}}`, not a page envelope — see `types/pjm.ts`. */
export function parseProjectProgress(raw: unknown): ProjectProgress {
  const record = asRecord(raw);
  const counts = asRecord(record.work_item);
  return {
    ...record,
    work_item: {
      ...counts,
      total: asNumber(counts.total),
      pending_count: asNumber(counts.pending_count),
      in_progress_count: asNumber(counts.in_progress_count),
      completed_count: asNumber(counts.completed_count),
    },
  };
}

export function parseWorkItem(raw: unknown): WorkItem {
  const record = asRecord(raw);

  // `versions` (array) on list responses vs `version` (object) on single GET.
  let versions = parseRefList(record.versions);
  if (versions.length === 0) {
    const single = parseRef(record.version);
    if (single !== undefined) versions = [single];
  }

  const properties =
    typeof record.properties === 'object' && record.properties !== null && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;

  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    short_id: asString(record.short_id),
    url: asString(record.url),
    html_url: asString(record.html_url),
    title: asString(record.title),
    description: asString(record.description),
    type: parseWorkItemTypeField(record.type),
    state: parseRef(record.state),
    priority: parseRef(record.priority),
    assignee: parseRef(record.assignee),
    project: parseRef(record.project),
    parent: parseRef(record.parent),
    sprint: parseRef(record.sprint),
    board: parseRef(record.board),
    entry: parseRef(record.entry),
    swimlane: parseRef(record.swimlane),
    phase: parseRef(record.phase),
    versions,
    tags: parseRefList(record.tags),
    participants: parseRefList(record.participants),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
    completed_at: asNumber(record.completed_at),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    story_points: asNumber(record.story_points),
    estimated_workload: asNumber(record.estimated_workload),
    remaining_workload: asNumber(record.remaining_workload),
    properties,
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseWorkItemType(raw: unknown): WorkItemType {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    description: asString(record.description),
  };
}

/**
 * A work item's own `type` field, which is a **bare slug string** on the wire
 * (`"task"`, `"epic"`) rather than the reference object the neighbouring fields are.
 *
 * Live 2026-08-04, on all three read paths. `parseRef` would turn that string into
 * `undefined` — which is what the CLI did until now, blanking the TYPE column and
 * dropping the key from `--json` (`research/s8-smoke.md` F1 had recorded the field as
 * absent altogether). The string is kept verbatim; an object, should the API ever send
 * one, still goes through `parseRef`.
 */
export function parseWorkItemTypeField(raw: unknown): Ref | string | undefined {
  if (typeof raw === 'string' && raw !== '') return raw;
  return parseRef(raw);
}

export function parseWorkItemState(raw: unknown): WorkItemState {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
  };
}

export function parseWorkItemPriority(raw: unknown): WorkItemPriority {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    color: asString(record.color),
  };
}

export function parseSprint(raw: unknown): Sprint {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    status: asString(record.status),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
    description: asString(record.description),
    url: asString(record.url),
    project: parseRef(record.project),
    assignee: parseRef(record.assignee),
    started_at: asNumber(record.started_at),
    completed_at: asNumber(record.completed_at),
    total_story_points: asNumber(record.total_story_points),
    completed_story_points: asNumber(record.completed_story_points),
    started_story_points: asNumber(record.started_story_points),
    categories: parseRefList(record.categories),
    created_at: asNumber(record.created_at),
    created_by: parseRef(record.created_by),
    updated_at: asNumber(record.updated_at),
    updated_by: parseRef(record.updated_by),
  };
}

/**
 * 发布. Note `stages[]` gets its **own** parser rather than `parseRefList`: a stage
 * row carries an `operate_at` a plain `Ref` would drop from the typed view (it would
 * survive in the index signature, but no call site could reach it).
 */
export function parseProjectVersion(raw: unknown): ProjectVersion {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    url: asString(record.url),
    project: parseRef(record.project),
    assignee: parseRef(record.assignee),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
    progress: asNumber(record.progress),
    changelog: asString(record.changelog),
    operate_at: asNumber(record.operate_at),
    stage: parseRef(record.stage),
    stages: Array.isArray(record.stages) ? record.stages.map(parseVersionStage) : [],
    categories: parseRefList(record.categories),
    created_at: asNumber(record.created_at),
    created_by: parseRef(record.created_by),
    updated_at: asNumber(record.updated_at),
    updated_by: parseRef(record.updated_by),
  };
}

export function parseVersionStage(raw: unknown): VersionStage {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    url: asString(record.url),
    operate_at: asNumber(record.operate_at),
  };
}

/**
 * One element of a `POST …/bulk` array, for either family.
 *
 * The created resource arrives under a family-specific key (`sprint` / `version`),
 * so the key is a parameter and the result is normalised to `resource` — the
 * alternative was two near-identical parsers differing in one string.
 */
export function parseBulkCreateResult<T>(
  raw: unknown,
  key: string,
  parseResource: (value: unknown) => T,
): BulkCreateResult<T> {
  const record = asRecord(raw);
  const resource = record[key];
  return {
    ...record,
    state: asString(record.state),
    ...(resource === undefined || resource === null ? {} : { resource: parseResource(resource) }),
  };
}

export function parseUser(raw: unknown): User {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    display_name: asString(record.display_name),
    username: asString(record.username),
    email: asString(record.email),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

// ---------------------------------------------------------------------------
// 工作项 links, tags, history and the bulk-update answer (S2b, live 2026-08-04)
// ---------------------------------------------------------------------------

/**
 * A typed work-item↔work-item link. The two ends are parsed as `Ref`s for the
 * renderer's benefit, and the index signature keeps everything else the wire sends on
 * them (`identifier`, `title`, `type`, `short_id`, `html_url`) reachable in `--json`.
 */
export function parseWorkItemLink(raw: unknown): WorkItemLink {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    relation_type: asString(record.relation_type),
    origin_work_item: parseRef(record.origin_work_item),
    target_work_item: parseRef(record.target_work_item),
  };
}

export function parseWorkItemRelationType(raw: unknown): WorkItemRelationType {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    category: asString(record.category),
    url: asString(record.url),
    is_system: asBooleanFlag(record.is_system),
  };
}

export function parseWorkItemTag(raw: unknown): WorkItemTag {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    color: asString(record.color),
    url: asString(record.url),
  };
}

/**
 * The tag *attachment* row. Its `id` is the tag's id and its only name lives in the
 * nested `tag`, so both are read here rather than at the call site.
 */
export function parseWorkItemTagAttachment(raw: unknown): WorkItemTagAttachment {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    tag: parseRef(record.tag),
    work_item: parseRef(record.work_item),
  };
}

export function parseWorkItemTransitionHistory(raw: unknown): WorkItemTransitionHistory {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    work_item: parseRef(record.work_item),
    // `null` on the row a work item is created with, which `parseRef` already reads
    // as `undefined` — the renderer prints "(new)" for it rather than an empty cell.
    from_state: parseRef(record.from_state),
    to_state: parseRef(record.to_state),
    created_by: parseRef(record.created_by),
    created_at: asNumber(record.created_at),
  };
}

/**
 * `{inserts, updates, deletes}`. The counts are **not** defaulted to `0`: an absent
 * count and a zero one mean different things here, because zero is the API's way of
 * saying "accepted and ignored" and the command layer's warning keys on it.
 */
export function parseWorkItemBulkUpdateResult(raw: unknown): WorkItemBulkUpdateResult {
  const record = asRecord(raw);
  return {
    ...record,
    inserts: asNumber(record.inserts),
    updates: asNumber(record.updates),
    deletes: asNumber(record.deletes),
  };
}
