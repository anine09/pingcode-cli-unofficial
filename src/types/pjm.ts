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

/**
 * 迭代 — `/v1/pjm/projects/{project_id}/sprints[/{sprint_id}]`.
 *
 * Live-verified 2026-08-04 (design D15). Two things worth knowing before reading a
 * field off this:
 *
 *  - **`status` is a plain field, not a lifecycle.** Patching it to `in_progress`
 *    or `completed` leaves `started_at` / `completed_at` `null`; only the GUI's
 *    start/complete actions set those. So a sprint the API "completed" is
 *    distinguishable from one a human completed, and neither timestamp can be
 *    written.
 *  - **the three story-point totals are always present, always numbers, and are
 *    derived** — a fresh sprint reports `0` for all three rather than omitting
 *    them. They are not inputs and there is no flag for them.
 *
 * There is **no `is_archived` / `is_deleted`** on a sprint, and no DELETE either.
 */
export type Sprint = {
  id: string;
  name?: string | undefined;
  /** `pending | in_progress | completed`. Writable, but see the note above. */
  status?: string | undefined;
  /** Snapped server-side to 00:00:00 of the date. */
  start_at?: number | undefined;
  /** Snapped server-side to 23:59:59 of the date. */
  end_at?: number | undefined;
  description?: string | undefined;
  url?: string | undefined;
  project?: Ref | undefined;
  assignee?: Ref | undefined;
  /** Set by the GUI's "start sprint" action only — never by a `status` patch. */
  started_at?: number | undefined;
  /** Set by the GUI's "complete sprint" action only. */
  completed_at?: number | undefined;
  total_story_points?: number | undefined;
  completed_story_points?: number | undefined;
  started_story_points?: number | undefined;
  /** 迭代类别, written as `category_ids` and read back as objects. Always an array. */
  categories: Ref[];
  created_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_at?: number | undefined;
  updated_by?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * 发布 — `/v1/pjm/projects/{project_id}/versions[/{version_id}]`.
 *
 * **The name is a four-way collision and this type is only one of the four**
 * ([S§6], design D7.2): a pjm *version* is a release plan of a project; a wiki page
 * version is a document revision (`/v1/wiki/pages/{id}/versions`); a
 * `*_state_plan` / `*_property_plan` "plan" is a configuration scheme; and a
 * testhub 测试计划 / ship 需求排期 are yet other things. Hence `ProjectVersion`
 * rather than `Version`.
 *
 * Live shape, 2026-08-04 (design D15) — narrower than the docs imply:
 *
 *  - **no `is_archived`, no `is_deleted`, no `html_url`, no `description`.** The
 *    only prose field is `changelog`, and it is **not writable** through any
 *    documented body field: sending one is accepted and dropped.
 *  - `progress` is derived (0 on a fresh version) and not writable either.
 *  - `stage` is the current 发布阶段; `stages[]` is every configured stage with the
 *    timestamp at which this version reached it, which is where `operate_at` lands.
 */
export type ProjectVersion = {
  id: string;
  name?: string | undefined;
  url?: string | undefined;
  project?: Ref | undefined;
  assignee?: Ref | undefined;
  /** Snapped server-side to 00:00:00 of the date. */
  start_at?: number | undefined;
  /** Snapped server-side to 23:59:59 of the date. */
  end_at?: number | undefined;
  /** Derived, read-only: a `progress` in a patch body is accepted and ignored. */
  progress?: number | undefined;
  /** Read-only in practice — no documented body field writes it. */
  changelog?: string | undefined;
  /** When this version reached its current `stage`. Only writable *with* `stage_id`. */
  operate_at?: number | undefined;
  stage?: Ref | undefined;
  /** Every configured stage plus this version's arrival time at it. Always an array. */
  stages: VersionStage[];
  /** 发布类别, written as `category_ids`. Always an array. */
  categories: Ref[];
  created_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_at?: number | undefined;
  updated_by?: Ref | undefined;
  [key: string]: unknown;
};

/** One row of `ProjectVersion.stages`: a stage, and when this version reached it. */
export type VersionStage = {
  id: string;
  name?: string | undefined;
  url?: string | undefined;
  /** `undefined` for a stage this version has not reached. */
  operate_at?: number | undefined;
  [key: string]: unknown;
};

/**
 * One entry of a `POST …/bulk` response, for both 迭代 and 发布.
 *
 * The two bulk endpoints answer with a **bare top-level array** rather than the
 * usual `{page_index, page_size, total, values}` envelope — the only shape like it
 * in the CLI — and each element pairs a `state` with the created resource. Live
 * 2026-08-04: every element of a successful batch reported `state: "success"`, and
 * a batch containing one rejected entry produced **no array at all**, just a 400
 * naming the offending index (design D15.5), so `resource` being absent is a shape
 * the CLI tolerates rather than one it has seen.
 */
export type BulkCreateResult<T> = {
  /** `success` on every element observed so far; carried verbatim, never assumed. */
  state?: string | undefined;
  /** The created 迭代 / 发布, read from the `sprint` / `version` key. */
  resource?: T | undefined;
  [key: string]: unknown;
};
