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
  ProjectVersion,
  Sprint,
  User,
  VersionStage,
  WorkItem,
  WorkItemPriority,
  WorkItemState,
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
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
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
    type: parseRef(record.type),
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
