/**
 * Hand-written types for the ~15 MVP endpoints (design D5, from research §4/§4.2).
 * There is no vendored spec and no conformance script — codegen from
 * `https://open.pingcode.com/api_data.json` is a recorded follow-up.
 *
 * Conventions:
 * - Field names mirror the API (snake_case) so `--json` output stays faithful to
 *   the PingCode docs and agents can use the documented names.
 * - All timestamps are 10-digit unix **seconds** (research §2/§6.7); conversion to
 *   local time happens only at the human output boundary.
 * - Every resource carries an index signature so fields we did not enumerate
 *   (custom `properties`, new API fields) survive into `--json` untouched.
 * - Two documented inconsistencies are normalised **once**, in `api/parse.ts`:
 *   `is_archived`/`is_deleted` arrive as numbers `0/1` (research §6.10), and list
 *   responses use `versions` (array) while single-GET shows `version` (object)
 *   (research §4.2).
 */

/** The "reference structure" every embedded resource uses (research §2.1). */
export type Ref = {
  id: string;
  name?: string | undefined;
  url?: string | undefined;
  [key: string]: unknown;
};

/** The uniform list envelope after normalisation (see `core/paginate.ts`). */
export type { Page } from '../core/paginate';

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

/** `GET /v1/directory/users` — user ids are **32-char hex**, not 24 (research §6.8). */
export type User = {
  id: string;
  name?: string | undefined;
  display_name?: string | undefined;
  username?: string | undefined;
  email?: string | undefined;
  is_deleted: boolean;
  [key: string]: unknown;
};

/** The token endpoint's response (research §1.3). */
export type TokenPayload = {
  access_token: string;
  token_type?: string | undefined;
  /** Documented as "过期时间"; may be a duration **or** an absolute timestamp (§4.1). */
  expires_in?: number | undefined;
  scope?: string | undefined;
};

// ---------------------------------------------------------------------------
// Ship (产品管理) — ship research §3
// ---------------------------------------------------------------------------

/**
 * Ship's id shapes are even less uniform than pjm's (ship §25): products, ideas,
 * tickets and most config rows are 24-hex, org users are 32-hex, and **property
 * ids are frequently slugs** (`backlog_type`, `solution`, `identifier`). Nothing
 * below is ever shape-validated.
 */

/** `GET /v1/ship/products[/{id}]` (ship §3.1). `state`/`owner` do not exist. */
export type ShipProduct = {
  id: string;
  /** Human key such as `SLC`, unique per org — **not** searchable via `keywords`. */
  identifier?: string | undefined;
  name?: string | undefined;
  url?: string | undefined;
  scope_type?: string | undefined;
  scope_id?: string | undefined;
  /** `public | private` */
  visibility?: string | undefined;
  color?: string | undefined;
  description?: string | undefined;
  /** Embedded members carry no `role` — the member endpoints do (ship §3.1). */
  members: ShipProductMember[];
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
 * `GET /v1/ship/products/{id}/members` (ship §3.6). The member's `id` **is** the
 * user or group id, and there is no top-level `name` — the display name lives in
 * `user` / `user_group`.
 */
export type ShipProductMember = {
  id: string;
  url?: string | undefined;
  /** `user | user_group` */
  type?: string | undefined;
  user?: Ref | undefined;
  user_group?: Ref | undefined;
  role?: Ref | undefined;
  product?: Ref | undefined;
  [key: string]: unknown;
};

/** `{from,to,granularity}` — written all-or-nothing (ship GOTCHA #9). */
export type ShipDateRange = {
  from?: number | undefined;
  to?: number | undefined;
  /** `year | quarter | month | day` */
  granularity?: string | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/ideas/{id}` (ship §3.2) — ship's primary work object. */
export type ShipIdea = {
  id: string;
  /** Human key such as `SLC-1`. No endpoint accepts it as a lookup key (ship §25). */
  identifier?: string | undefined;
  /** 8-char base62, used only inside `html_url`; **not** a lookup key either. */
  short_id?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  product?: Ref | undefined;
  assignee?: Ref | undefined;
  state?: Ref | undefined;
  priority?: Ref | undefined;
  /** Requirement schedule (需求排期). */
  plan?: Ref | undefined;
  /** Requirement module (需求模块), `type` ∈ `product` | `module`. */
  suite?: Ref | undefined;
  plan_at?: ShipDateRange | undefined;
  real_at?: ShipDateRange | undefined;
  /** Read-only/computed — no write parameter exists (ship §3.2). */
  score?: number | undefined;
  progress?: number | undefined;
  /** Keys are property ids (often slugs); select values are option `_id`s. */
  properties?: Record<string, unknown> | undefined;
  participants: Ref[];
  completed_at?: number | undefined;
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
 * `GET /v1/ship/tickets/{id}` (ship §3.3).
 *
 * `channel` is the single worst shape hazard in ship: it is an **object** for
 * externally submitted tickets and the bare **string** `"internal"` otherwise
 * (ship GOTCHA #3), so it is deliberately not a `Ref`.
 */
export type ShipTicket = {
  id: string;
  identifier?: string | undefined;
  short_id?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  product?: Ref | undefined;
  assignee?: Ref | undefined;
  state?: Ref | undefined;
  type?: Ref | undefined;
  customer?: Ref | undefined;
  solution?: Ref | undefined;
  priority?: Ref | undefined;
  /** `Object` **or** the literal string `"internal"`. Never follow `channel.url`. */
  channel?: Ref | string | undefined;
  /** Present in responses, but unwritable and unfilterable (ship §3.3). */
  estimated_at?: ShipDateRange | undefined;
  properties?: Record<string, unknown> | undefined;
  tags: Ref[];
  participants: Ref[];
  submitted_at?: number | undefined;
  submitted_by?: Ref | undefined;
  completed_at?: number | undefined;
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
 * `GET /v1/ship/{idea,ticket}/states?product_id=` (ship §3.6). Ticket state
 * `type` ∈ `pending|in_progress|completed|closed`; the **idea** state enum is
 * never declared anywhere in the docs (ship §9.2).
 */
export type ShipState = {
  id: string;
  name?: string | undefined;
  type?: string | undefined;
  color?: string | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/{idea,ticket}/priorities?product_id=` — `{id,url,name}`. */
export type ShipPriority = {
  id: string;
  name?: string | undefined;
  color?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/idea/suites?product_id=` — a **tree served as a flat list** with
 * `parent` references (ship §D). `type` ∈ `product` (sub-product) | `module`.
 */
export type ShipSuite = {
  id: string;
  name?: string | undefined;
  type?: string | undefined;
  parent?: Ref | undefined;
  product?: Ref | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/ticket/types?product_id=` — the product-scoped list omits `is_system`. */
export type ShipTicketType = {
  id: string;
  name?: string | undefined;
  is_system?: boolean | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/ticket/channels?product_id=` — `{id,url,name,product,description}`. */
export type ShipChannel = {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/{idea,ticket}/properties?product_id=` — the authoritative list of
 * valid `properties` keys **and** of the option `_id`s a select-typed property
 * accepts (ship GOTCHA #4/#5).
 */
export type ShipProperty = {
  id: string;
  name?: string | undefined;
  /** `text | textarea | select | multi_select | … | link` */
  type?: string | undefined;
  options: ShipPropertyOption[];
  [key: string]: unknown;
};

/** The declared key is `_id`; a PATCH example uses `id` instead (ship GOTCHA #8). */
export type ShipPropertyOption = {
  _id?: string | undefined;
  text?: string | undefined;
  parent_id?: string | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/ticket_state_plans` — `product` is **nullable** (= org default). */
export type ShipStatePlan = {
  id: string;
  product?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/ticket_state_plans/{plan}/ticket_state_flows` — the legal
 * transitions of a plan.
 *
 * The docs spell the source field **`form_state`** on all three state-flow
 * records while `transition_histories` spell it `from_state`, and no response
 * example exists to settle it (ship GOTCHA #2). Both keys are accepted; the
 * normalised value lands in `from_state`.
 */
export type ShipStateFlow = {
  id: string;
  from_state?: Ref | undefined;
  to_state?: Ref | undefined;
  state_plan?: Ref | undefined;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Testhub (测试管理) — testhub research §3
// ---------------------------------------------------------------------------

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
  remark?: string | undefined;
  executed_at?: number | undefined;
  executed_by?: Ref | undefined;
  steps: TestRunStep[];
  [key: string]: unknown;
};

/**
 * One item of `GET /v1/testhub/cases/{case_id}/histories` ([th#26]).
 *
 * The other half of GOTCHA #3: a flat **`status` string** instead of an
 * `executed_status` object, and **no `remark`** at all. Also the only read
 * endpoint in the module that declares a *write* scope (GOTCHA #1).
 *
 * No wrapper is exposed in this slice.
 */
export type TestCaseHistoryItem = {
  id: string;
  url?: string | undefined;
  run?: Ref | undefined;
  library?: Ref | undefined;
  plan?: TestPlanRef | undefined;
  case?: Ref | undefined;
  /** A flat **string** slug — not an object, and there is no `remark` sibling. */
  status?: string | undefined;
  executed_at?: number | undefined;
  executed_by?: Ref | undefined;
  steps: TestRunStep[];
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
