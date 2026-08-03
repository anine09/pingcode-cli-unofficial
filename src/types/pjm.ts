/**
 * pjm (项目管理 / 敏捷开发) resource types — research §4/§4.2.
 *
 * Split out of the former single 773-line `src/types/api.ts` by F1 (design D6.5):
 * four parallel S children add types, and one shared file is the shape that cannot
 * be merged. `src/types/api.ts` re-exports every name below, so **no existing
 * import path changed**.
 *
 * Conventions are module-wide and stated once in `src/types/api.ts`: API
 * `snake_case` field names, 10-digit unix **seconds** for every timestamp, an index
 * signature on every resource so unknown fields survive into `--json`, and wire
 * quirks normalised exactly once under `api/parse/`.
 */

import type { Ref } from './common';

export type ProjectType = 'scrum' | 'kanban' | 'waterfall' | 'hybrid';

export type Project = {
  id: string;
  name?: string | undefined;
  identifier?: string | undefined;
  type?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

export type WorkItem = {
  id: string;
  /** Human-facing key such as `SCR-5`. */
  identifier?: string | undefined;
  /** Short key used in `html_url`, e.g. `1bAqLmTG`. */
  short_id?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  /** `epic | feature | story | task | bug | issue | …` — id may be a slug (research §6.8). */
  type?: Ref | undefined;
  state?: Ref | undefined;
  priority?: Ref | undefined;
  assignee?: Ref | undefined;
  project?: Ref | undefined;
  parent?: Ref | undefined;
  sprint?: Ref | undefined;
  board?: Ref | undefined;
  entry?: Ref | undefined;
  swimlane?: Ref | undefined;
  phase?: Ref | undefined;
  /** Always an array here, even when the API sent a single `version` object. */
  versions: Ref[];
  tags: Ref[];
  participants: Ref[];
  start_at?: number | undefined;
  end_at?: number | undefined;
  completed_at?: number | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  story_points?: number | undefined;
  estimated_workload?: number | undefined;
  remaining_workload?: number | undefined;
  properties?: Record<string, unknown> | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/** `GET /v1/pjm/work_item/types` — system types use string slugs as their id. */
export type WorkItemType = {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  [key: string]: unknown;
};

/** `GET /v1/pjm/work_item/states` — requires **both** `project_id` and `work_item_type_id`. */
export type WorkItemState = {
  id: string;
  name?: string | undefined;
  /** `pending | in_progress | completed`-style grouping, when the API sends one. */
  type?: string | undefined;
  [key: string]: unknown;
};

export type WorkItemPriority = {
  id: string;
  name?: string | undefined;
  color?: string | undefined;
  [key: string]: unknown;
};

export type Sprint = {
  id: string;
  name?: string | undefined;
  /** `pending | in_progress | completed` */
  status?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  [key: string]: unknown;
};
