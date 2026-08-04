/**
 * testhub (测试管理) resource types — testhub research §3.
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

/**
 * Every field below is optional, including the ones the docs mark required.
 * That is not defensiveness, it is observation: `estimated_workload`,
 * `remaining_workload`, `remark`, `expected_value`, `group_id` and
 * `actual_value` all appear as `null` in the docs' **own** response examples
 * (testhub GOTCHA #24). PRD R6 makes it a rule for the whole module.
 *
 * Two more module-wide traps are handled in `api/parse.ts` rather than here:
 *  - `is_archived` / `is_deleted` / `is_system` are declared `<Number>` with the
 *    string enum `['0','1']` (GOTCHA #25) — parsed as integers, strings tolerated;
 *  - writes take `*_id` scalars while reads return localized **objects**
 *    (GOTCHA #5), so the request shapes live in `api/testhub.ts` as
 *    `CreateCaseInput` / `UpdateCaseInput` / `PatchRunInput` and are deliberately
 *    *not* mixed into the resource types below.
 */

/** `GET /v1/testhub/libraries[/{id}]` (testhub §3.5, [th#7]/[th#12]). */
export type TestLibrary = {
  id: string;
  /** Uppercase key, ≤15 chars, unique per org — the docs describe it with project wording (GOTCHA #26). */
  identifier?: string | undefined;
  name?: string | undefined;
  url?: string | undefined;
  description?: string | undefined;
  /** `organization` (企业可见) | `user_group` (团队可见) — default `organization`. */
  scope_type?: string | undefined;
  scope_id?: string | undefined;
  /** `public` | `private` — default `private`; the enum order differs per direction (GOTCHA #27). */
  visibility?: string | undefined;
  color?: string | undefined;
  /** Membership rows, when the API embeds them. */
  members: Ref[];
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/**
 * `GET /v1/testhub/libraries/{id}/suites` — a case module (模块), served as a
 * flat list that describes a tree ([th#9]/[th#11]).
 *
 * The parent arrives as a **`parent` reference object**, not a `parent_id`
 * scalar, and the ancestor path field is **`paths`** (plural). Neither
 * `is_archived`/`is_deleted` nor a `type` discriminator is documented for a
 * testhub suite — unlike a ship suite, which does carry `type`.
 */
export type TestSuite = {
  id: string;
  name?: string | undefined;
  url?: string | undefined;
  library?: Ref | undefined;
  parent?: Ref | undefined;
  /**
   * `/`-separated **ancestor** chain, *excluding this node* — `登录` for a child
   * of root `登录`, and `''` for a root itself (verified live 2026-08-02). It is
   * not this suite's own path, so it is never registered as a resolver alias;
   * `core/metadata.ts` computes `Parent / Child` from the `parent` chain instead.
   */
  paths?: string | undefined;
  [key: string]: unknown;
};

/**
 * One step of a **case** ([th#21]).
 *
 * A step object sent **without** `step_id` is treated as brand new and gets a
 * fresh id, silently orphaning every recorded result against the old one
 * (GOTCHA #9 corollary) — which is why every steps write is a
 * read-modify-write. Group steps (`is_group: true`) are referenced by other
 * steps' `group_id` and must not carry one themselves (GOTCHA #10).
 */
export type TestCaseStep = {
  step_id?: string | undefined;
  description?: string | undefined;
  /** Nullable despite being declared required (GOTCHA #24). */
  expected_value?: string | undefined;
  is_group?: boolean | undefined;
  /** Nullable; absent on group steps by rule (GOTCHA #10). */
  group_id?: string | undefined;
  [key: string]: unknown;
};

/**
 * One step of a **run** ([th#52]) — a different shape from `TestCaseStep`.
 *
 * A run step carries the *result* (`status` slug + `actual_value`) and none of
 * the case-side prose. On the write side `steps[].status_id` is a
 * **run-status id**, while the value read back is an English slug (GOTCHA #10).
 */
export type TestRunStep = {
  step_id?: string | undefined;
  /** `not_start` | `pass` | `block` | `failure` | `skip` (testhub §8). */
  status?: string | undefined;
  /** Nullable despite being declared required (GOTCHA #24). */
  actual_value?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/testhub/cases/{case_id}` (testhub §3.1) — identical field set on the
 * create, update, delete and search responses.
 *
 * There is **no `tags` field** even though `GET /v1/testhub/cases` accepts
 * `?tag_id`: filter-only and un-round-trippable (GOTCHA #6). `test_type` is
 * returned but is not a parameter of any write (testhub §10.12).
 */
export type TestCase = {
  id: string;
  /** Human key such as `LIB-10`. */
  identifier?: string | undefined;
  /** Usable in the GET-by-id path, never in a write path (GOTCHA #19). */
  short_id?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  title?: string | undefined;
  /** The importance level's **name**, duplicating `important_level.name` (testhub §3.1). */
  level?: string | undefined;
  library?: Ref | undefined;
  suite?: Ref | undefined;
  state?: Ref | undefined;
  type?: Ref | undefined;
  important_level?: Ref | undefined;
  /** 维护人 — a user ref. */
  maintenance?: Ref | undefined;
  /** `automation` | `manual` — read-only; no write parameter exists (testhub §10.12). */
  test_type?: string | undefined;
  /** 描述 on the way out, 备注 in the PATCH request — the same field (testhub §3.1). */
  description?: string | undefined;
  precondition?: string | undefined;
  /** A flat `{key: value}` map; the typed declarations are stale (GOTCHA #11). */
  properties?: Record<string, unknown> | undefined;
  /** Read-only projections of `/v1/workloads`; nullable (GOTCHA #24). */
  estimated_workload?: number | undefined;
  remaining_workload?: number | undefined;
  steps: TestCaseStep[];
  participants: Ref[];
  /** Only present when `include_public_image_token` was supplied. */
  public_image_token?: string | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/**
 * `GET /v1/testhub/libraries/{library_id}/plans/{plan_id}` (testhub §3.2).
 *
 * Note what is **absent**: a plan carries no `is_archived` / `is_deleted`,
 * unlike a library, case or run. `project` / `sprint` / `version` are **pjm**
 * references, the only cross-module link in the module (testhub §6.1).
 */
export type TestPlan = {
  id: string;
  /** Accepted on GET, rejected on PATCH (GOTCHA #19). */
  short_id?: string | undefined;
  name?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  library?: Ref | undefined;
  /** The plan **type** ref (项目/发布/迭代). Carries no kind discriminator (testhub §10.7). */
  type?: Ref | undefined;
  /**
   * The full plan resource uses **`state`** — an object with
   * `type` ∈ `pending|in_progress|completed`. An *embedded* plan reference uses
   * a flat `status` string instead; see `TestPlanRef` (GOTCHA #4).
   */
  state?: Ref | undefined;
  project?: Ref | undefined;
  sprint?: Ref | undefined;
  version?: Ref | undefined;
  assignee?: Ref | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  /** The test-report summary. Markup contract unspecified (testhub §10.14). */
  summary?: string | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * A plan as **embedded** inside a run or a run history ([th#52]).
 *
 * Deliberately not a `Ref` and deliberately not `TestPlan`: the same concept is
 * spelled `status` (a flat string) here and `state` (an object) on the plan
 * resource (GOTCHA #4). Sharing a deserializer between the two would quietly
 * read `undefined` on one of them.
 */
export type TestPlanRef = {
  id: string;
  name?: string | undefined;
  url?: string | undefined;
  /** `pending` | `in_progress` | `completed`, as a **string** — not an object. */
  status?: string | undefined;
  short_id?: string | undefined;
  html_url?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/testhub/runs/{run_id}` — an 执行用例 (testhub §3.3): one case's
 * placement in one plan, plus its latest result.
 *
 * `status` is an English **slug** while `latest_executed_status` is a localized
 * object, and the id a write needs (`status_id`) appears in neither: it has to
 * be resolved from `GET /v1/testhub/run/statuses?library_id=` by matching the
 * localized `name` (GOTCHA #5/#10, PRD open question 2).
 */
export type TestRun = {
  id: string;
  /** Accepted on GET, rejected on PATCH (GOTCHA #19). */
  short_id?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  library?: Ref | undefined;
  /** Uses `status` (string), not `state` (object) — see `TestPlanRef`. */
  plan?: TestPlanRef | undefined;
  case?: Ref | undefined;
  suite?: Ref | undefined;
  /** `not_start` | `pass` | `block` | `failure` | `skip` (testhub §8). */
  status?: string | undefined;
  /** The localized counterpart of `status`: `{id, url, name}` such as 通过 / 未测. */
  latest_executed_status?: Ref | undefined;
  executor?: Ref | undefined;
  /** Nullable despite being declared required (GOTCHA #24). */
  remark?: string | undefined;
  steps: TestRunStep[];
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/** `GET /v1/testhub/case/states?library_id=` — `color` is absent from the list view ([th#25]/[th#34]). */
export type TestCaseState = {
  id: string;
  name?: string | undefined;
  /** `pending` | `completed` | `closed` (testhub §8). */
  type?: string | undefined;
  color?: string | undefined;
  /** Not documented on a case state; normalised from `0/1` when present. */
  is_system?: boolean | undefined;
  [key: string]: unknown;
};

/** `GET /v1/testhub/case/types?library_id=` — `{id, url, name}` ([th#35]). */
export type TestCaseType = {
  id: string;
  name?: string | undefined;
  /** Not documented on a case type; normalised from `0/1` when present. */
  is_system?: boolean | undefined;
  [key: string]: unknown;
};

/** `GET /v1/testhub/case_important_levels` — org-level only, no library view ([th#36]/[th#40]). */
export type TestCaseImportantLevel = {
  id: string;
  name?: string | undefined;
  color?: string | undefined;
  /** Not documented on an importance level; normalised from `0/1` when present. */
  is_system?: boolean | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/testhub/run/statuses?library_id=` — the lookup that makes any run
 * write possible ([th#57]).
 *
 * **There is no slug field.** Items carry `id` / `url` / `name` / `is_system`
 * only, so the join between the English slug on a run (`pass`) and the id a
 * write needs is the localized `name` (通过) — a correspondence `api_data.json`
 * never states (testhub §8, §10.1). Tenants may add their own statuses, whose
 * names are in no table at all.
 */
export type TestRunStatus = {
  id: string;
  name?: string | undefined;
  /** Normalised from `0/1`; omitted by the library-scoped list example ([th#57]). */
  is_system?: boolean | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/testhub/libraries/{library_id}/plan_types` ([th#60]) — the source of
 * the `type_id` that plan creation requires.
 *
 * The resource is `{id, url, library, name}`: there is **no kind discriminator**,
 * so telling an iteration type from a release type is only possible by matching the
 * localized `name` (testhub §10.7) — which tenants rename, so the CLI does not
 * try. The consequence is that a type demanding `sprint_id` / `version_id`
 * cannot be identified before the server refuses it.
 */
export type TestPlanType = {
  id: string;
  name?: string | undefined;
  library?: Ref | undefined;
  is_system?: boolean | undefined;
  [key: string]: unknown;
};

/**
 * One item of `GET /v1/testhub/runs/{run_id}/histories` ([th#55]/[th#58]).
 *
 * **Do not share this with `TestCaseHistoryItem`.** The docs call both "history"
 * and they are different shapes (GOTCHA #3): this one carries `executed_status`
 * as an **object** plus a `remark`.
 *
 * No wrapper is exposed in this slice — the history endpoints are out of PRD
 * scope. The type exists so the divergence is recorded where it will be read.
 */
export type TestRunHistoryItem = {
  id: string;
  url?: string | undefined;
  run?: Ref | undefined;
  library?: Ref | undefined;
  plan?: TestPlanRef | undefined;
  case?: Ref | undefined;
  /** An **object** `{id, url, name}` — the distinguishing field. */
  executed_status?: Ref | undefined;
  /**
   * The flat slug (`pass`, `block`, …), undocumented on this side ([th#55] lists
   * only `executed_status`) but always present live (2026-08-04). Carried so a
   * renderer can fall back to it when the localized object is absent.
   */
  status?: string | undefined;
  remark?: string | undefined;
  executed_at?: number | undefined;
  executed_by?: Ref | undefined;
  steps: TestRunStep[];
  [key: string]: unknown;
};

/**
 * One item of `GET /v1/testhub/cases/{case_id}/histories` ([th#26]) — the
 * **latest** result record of each run of that case.
 *
 * > **Live 2026-08-04 (S3): [TH§11]/GOTCHA #3 is falsified.** The docs describe
 * > this as a reduced shape — a flat `status` string and no `remark` — and the
 * > research told implementors never to share a deserializer with the run side
 * > because of it. On the live API the items carry **`status` *and*
 * > `executed_status` *and* `remark`**, i.e. the run-side shape, and each item's
 * > `url` points at `/runs/{run_id}/histories/{id}` with the *same* `id` the
 * > run-side read returns. It is one resource reachable through two paths.
 * >
 * > The two types and their two parsers are nevertheless kept apart, which is a
 * > deliberate choice rather than an oversight: the vendor documents different
 * > field sets for the two endpoints, only one tenant has been measured, and the
 * > cost of keeping them separate is a few lines while the cost of merging them
 * > and being wrong is a silently `undefined` field. What *is* fixed here is the
 * > content — this type no longer claims the fields do not exist.
 *
 * Also the only read endpoint in the module that declares a *write* scope
 * (GOTCHA #1); see `endpoints.ts` for why that could not be settled live.
 */
export type TestCaseHistoryItem = {
  id: string;
  url?: string | undefined;
  run?: Ref | undefined;
  library?: Ref | undefined;
  plan?: TestPlanRef | undefined;
  case?: Ref | undefined;
  /** The flat slug the docs promise: `not_start` | `pass` | `block` | `failure` | `skip`. */
  status?: string | undefined;
  /** Undocumented here but always present live — the localized `{id, url, name}`. */
  executed_status?: Ref | undefined;
  /** Undocumented here but present live, `null` when the result carried no note. */
  remark?: string | undefined;
  executed_at?: number | undefined;
  executed_by?: Ref | undefined;
  steps: TestRunStep[];
  [key: string]: unknown;
};

/**
 * `GET /v1/testhub/plan_states[/{state_id}]` ([th#63]/[th#64]) — the **plan**
 * lifecycle, organisation-level.
 *
 * Three system rows on this tenant (未开始 / 进行中 / 已完成), and their ids are
 * what `PATCH …/plans/{plan_id}` takes as `state_id` (live 2026-08-04). Not to be
 * confused with `TestCaseState` (用例状态) or `TestRunStatus` (执行结果).
 */
export type TestPlanState = {
  id: string;
  name?: string | undefined;
  /** `pending` | `in_progress` | `completed` (testhub §8). */
  type?: string | undefined;
  /** Normalised from `0/1`. Every row is `1` here, unlike run statuses. */
  is_system?: boolean | undefined;
  [key: string]: unknown;
};

/** One option of a select-typed case property ([th#32]); `_id` is the value a write sends. */
export type TestCasePropertyOption = {
  _id?: string | undefined;
  text?: string | undefined;
  parent_id?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/testhub/case/properties?library_id=` ([th#23]) — the fields effective
 * in one library.
 *
 * ⚠️ **The `id` is a field key, and most rows are built-in fields, not custom
 * properties.** Live 2026-08-04 (S3) all 8 rows on this tenant are built-ins
 * (`state_id`, `description`, `steps`, `type`, `important_level`,
 * `maintenance_uid`, `precondition`, `test_type`), and pushing one of those
 * through the `properties` map either answers HTTP 500 or rewrites the top-level
 * field of the same name. Only rows that are genuinely custom are `--set` keys —
 * see `endpoints.ts` and `modules/testhub.md`.
 */
export type TestCaseProperty = {
  id: string;
  name?: string | undefined;
  /** `text`|`textarea`|`select`|…|`link`, plus the undocumented `system` for built-ins. */
  type?: string | undefined;
  options: TestCasePropertyOption[];
  is_removable?: boolean | undefined;
  is_name_editable?: boolean | undefined;
  is_options_editable?: boolean | undefined;
  [key: string]: unknown;
};

/**
 * One element of `POST`/`PATCH /v1/testhub/cases/bulk` ([th#18]/[th#19]).
 *
 * The response is a **bare JSON array**, one element per input row, exactly as
 * testhub §3.6 predicted from the examples (confirmed live 2026-08-04). `state`
 * is `success` or `failure`; `case` is present on success. No `message` field was
 * observed on this half — a rejected *field* fails the whole request with a 400
 * instead, so a `failure` element here is rare.
 */
export type TestCaseBulkItem = {
  state?: string | undefined;
  case?: TestCase | undefined;
  message?: string | undefined;
  [key: string]: unknown;
};

/**
 * One element of `POST`/`PATCH /v1/testhub/runs/bulk` ([th#48]/[th#50]).
 *
 * Also a bare array. The `POST` half really is per-element: live 2026-08-04 a
 * three-row batch with one already-added case returned two `success` rows and one
 * `{state: 'failure', message: '创建失败或已创建'}` under HTTP 200. The `PATCH`
 * half is atomic instead, so its array is all-`success` or absent entirely.
 */
export type TestRunBulkItem = {
  state?: string | undefined;
  run?: TestRun | undefined;
  message?: string | undefined;
  [key: string]: unknown;
};

/**
 * `POST /v1/testhub/libraries/{id}/plans/{plan_id}/runs/bulk` ([th#49]).
 *
 * **Counts only.** The ids of the runs it just created are not returned, so a
 * caller that needs them has to re-query the plan (testhub §3.6).
 */
export type TestRunBulkResult = {

  inserts?: number | undefined;
  updates?: number | undefined;
  deletes?: number | undefined;
  [key: string]: unknown;
};
