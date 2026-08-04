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

/**
 * A pjm project.
 *
 * The seven fields below `html_url` were added by S2b, which is the first child to
 * *write* a project: `POST /v1/pjm/projects` echoes all of them, and a `create` that
 * cannot show what it set is not much of a create. Live notes, 2026-08-04:
 *
 *  - **`start_at` / `end_at` are instants, not days.** A 12:00 value is stored as
 *    12:00, unlike a sprint's or a release's, which the server snaps to the day's
 *    boundaries (design D15.4).
 *  - **`visibility` and `is_archived` are read-only**: both are echoed on create and
 *    both are silently dropped by `PATCH`, so a project can be neither archived nor
 *    deleted through this API ([S§3.8.1] — there is no project DELETE either).
 *  - `state` is the 项目状态 (未开始 / 正常 / 预警 / 延期 / 结束), patchable via
 *    `state_id`; `assignee` is the 负责人 and need **not** be a project member.
 */
export type Project = {
  id: string;
  name?: string | undefined;
  identifier?: string | undefined;
  type?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  /** `private | public`. Set at create time only — a patch is accepted and dropped. */
  visibility?: string | undefined;
  /** The 项目流程 template the type implies; echoed on create, never patched. */
  process_id?: string | undefined;
  state?: Ref | undefined;
  assignee?: Ref | undefined;
  /** Verbatim unix seconds — **not** snapped to a day boundary. */
  start_at?: number | undefined;
  /** Verbatim unix seconds. */
  end_at?: number | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  /** Normalised from `0/1`. Read-only: `PATCH {is_archived}` is dropped. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/**
 * One row of `GET /v1/pjm/projects/{project_id}/members`.
 *
 * `id` **is** the user or group id, and there is no top-level `name` — the display
 * name lives inside `user` — which is the same shape ship's product members have
 * (ship §3.6) and the reason `member get` takes a user id rather than a membership id.
 */
export type ProjectMember = {
  id: string;
  /** `user | user_group`. */
  type?: string | undefined;
  user?: Ref | undefined;
  user_group?: Ref | undefined;
  /** 管理员 / 普通成员 / 只读成员; defaults to 普通成员 when `role_id` is omitted. */
  role?: Ref | undefined;
  project?: Ref | undefined;
  url?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/pjm/projects/{project_id}/progress` — a **bare object**, not a page.
 *
 * The catalog marks this endpoint `paged: "query"` (its `paged` heuristic reads the
 * `GET`-plus-collection shape); live it returns exactly one nested count block and
 * ignores every paging parameter. Counted over work items only: there is no sprint,
 * release or workload figure here.
 */
export type ProjectProgress = {
  work_item?: ProgressCounts | undefined;
  [key: string]: unknown;
};

export type ProgressCounts = {
  total?: number | undefined;
  pending_count?: number | undefined;
  in_progress_count?: number | undefined;
  completed_count?: number | undefined;
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
  /**
   * The work-item type, and **a bare slug string on the wire** — `"task"`, `"bug"`,
   * `"epic"` — not the reference object every other field here is.
   *
   * `research/s8-smoke.md` F1 recorded that the API omits this field entirely, and the
   * CLI was built around that: `parseWorkItem` ran it through `parseRef`, which
   * discards a string, so the value never reached a caller. Live 2026-08-04 it is
   * present on all three read paths (the GET list, the GET single and the search),
   * so the string is now kept as-is. It doubles as the `work_item_type_id` a state
   * lookup needs, because system types use their slug as their id (research §6.8); a
   * custom type would report a 24-hex id here instead, which works just as well.
   *
   * Declared as a union rather than normalised into a `Ref` so `--json` keeps the
   * wire's own shape. Read it with `typeIdOf()` / `typeLabelOf()` in
   * `cli/commands/workItem.ts`.
   */
  type?: Ref | string | undefined;
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
 * One typed work-item↔work-item link — `/v1/pjm/work_items/{id}/relations`.
 *
 * **Not a `Relation`** (`types/crosscutting.ts`), which is the cross-*kind*
 * `/v1/relations` resource and carries `principal_type`/`target_type` and no type at
 * all (design D7.6). The two families share only a word.
 *
 * `relation_type` is always the vocabulary's **`category` slug** on the way out
 * (`relate`, `block`, `blocked_by`, …) even when the write sent the 24-hex id.
 *
 * Live shape, 2026-08-04: `{id, url, relation_type, origin_work_item,
 * target_work_item}` and nothing else — no timestamps, no author, so a link cannot be
 * dated or attributed. The two ends are richer than a `Ref` (they carry `identifier`,
 * `title`, `type`, `short_id`, `html_url`), which the index signature preserves.
 */
export type WorkItemLink = {
  id: string;
  url?: string | undefined;
  /** The `category` slug, e.g. `relate` / `block` / `blocked_by`. */
  relation_type?: string | undefined;
  origin_work_item?: Ref | undefined;
  target_work_item?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * One row of the org-level relation-type vocabulary — `GET /v1/pjm/work_item/relation_types`.
 *
 * Nine system rows in the live tenant, matching F5's table exactly: four inverse pairs
 * (`blocked_by`/`block`, `caused_by`/`cause`, `cloned_by`/`clone`, plus `duplicate`)
 * and `relate` / `mention`. `category` is stable across tenants; `id` is **not** —
 * hence nothing in the source hardcodes either an id or a name.
 */
export type WorkItemRelationType = {
  id: string;
  name?: string | undefined;
  /** The stable slug a write may send instead of `id`. */
  category?: string | undefined;
  url?: string | undefined;
  /** Normalised from `0/1`; all nine rows report `1`. */
  is_system: boolean;
  [key: string]: unknown;
};

/**
 * One row of the tag vocabulary — `GET /v1/pjm/work_item/tags?project_id=`.
 *
 * ⚠️ **The list is organisation-wide even though `project_id` is required.** Three
 * projects returned the identical 23 rows (live 2026-08-04), and the same rows as the
 * org-level `GET /v1/pjm/work_item_tags`. Tags are nevertheless really project-scoped:
 * attaching one to a work item in the wrong project is refused with 400 `100354`
 * `'tag'资源不存在`. Names are **not unique** either. So this type describes a
 * candidate list, not a usable one — see `project meta tags --help`.
 */
export type WorkItemTag = {
  id: string;
  name?: string | undefined;
  color?: string | undefined;
  url?: string | undefined;
  [key: string]: unknown;
};

/**
 * One `work_items/{id}/tags/{tag_id}` row: the *attachment* of a tag to a work item.
 *
 * Its `id` is the **tag's** id, not an attachment id, and the tag's name only appears
 * inside the nested `tag` — so the outer object is useless on its own, which is why
 * the renderer reaches into `tag`.
 */
export type WorkItemTagAttachment = {
  id: string;
  url?: string | undefined;
  tag?: Ref | undefined;
  work_item?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * One state change — `/v1/pjm/work_items/{id}/transition_histories`.
 *
 * `from_state` is `null` on the row every work item is created with, so a freshly
 * created item already has exactly one history row. Read-only, and note it records
 * **state** changes only: no other field's history is exposed here (the free-form
 * `/v1/activities` feed is where a title or assignee change shows up — and a *bulk*
 * PATCH shows up in neither, live 2026-08-04).
 *
 * Unrelated to ship's `transition_histories`, which has its own shape.
 */
export type WorkItemTransitionHistory = {
  id: string;
  url?: string | undefined;
  work_item?: Ref | undefined;
  /** `undefined` on the creation row. */
  from_state?: Ref | undefined;
  to_state?: Ref | undefined;
  created_by?: Ref | undefined;
  created_at?: number | undefined;
  [key: string]: unknown;
};

/**
 * The answer to `PATCH /v1/pjm/work_items` — three counts and nothing else.
 *
 * Only `updates` can be non-zero on this endpoint (it neither inserts nor deletes),
 * and it is the **only** signal available: a property name the endpoint does not
 * apply, a valid value it chooses to ignore, and an id that does not exist all answer
 * HTTP 200 with `updates` short of the number of ids sent. The command layer therefore
 * compares the two and warns.
 *
 * Same shape as testhub's `TestRunBulkResult`, deliberately a separate type: that one
 * comes from an endpoint that really does insert and delete.
 */
export type WorkItemBulkUpdateResult = {
  inserts?: number | undefined;
  updates?: number | undefined;
  deletes?: number | undefined;
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
