import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions, SearchPayload } from '../core/paginate';
import type {
  TestCase,
  TestCaseBulkItem,
  TestCaseHistoryItem,
  TestCaseImportantLevel,
  TestCaseProperty,
  TestCaseState,
  TestCaseStep,
  TestCaseType,
  TestLibrary,
  TestPlan,
  TestPlanState,
  TestPlanType,
  TestRun,
  TestRunBulkItem,
  TestRunBulkResult,
  TestRunHistoryItem,
  TestRunStatus,
  TestSuite,
} from '../types/api';
import {
  compact,
  fetchPageOf,
  fetchSearchPageOf,
  iterateOf,
  iterateSearchOf,
  listAllOf,
  parseBareArray,
  parseTestCase,
  parseTestCaseBulkItem,
  parseTestCaseHistoryItem,
  parseTestCaseImportantLevel,
  parseTestCaseProperty,
  parseTestCaseState,
  parseTestCaseType,
  parseTestLibrary,
  parseTestPlan,
  parseTestPlanState,
  parseTestPlanType,
  parseTestRun,
  parseTestRunBulkItem,
  parseTestRunBulkResult,
  parseTestRunHistoryItem,
  parseTestRunStatus,
  parseTestSuite,
} from './parse';

/**
 * `/v1/testhub/**` — the Testhub (测试管理) surface: test libraries, case
 * modules, cases (用例), plans (测试计划) and runs (执行用例), plus the four
 * lookups every write needs (testhub §9, the 15-endpoint MVP).
 *
 * Four facts shape this file:
 *
 *  - **Search is the read path.** `GET /v1/testhub/{cases,runs}` exist, but the
 *    docs themselves redirect to `POST …/search`, and the plain case list does
 *    not even require a `library_id` — unfiltered it scans every visible library
 *    (GOTCHA #20). Neither is called from here.
 *  - **A library is the parent of everything.** `state_id`, `type_id`,
 *    `status_id` and the suite tree are all resolved per library (testhub §5).
 *    Plans are additionally addressed *under* their library in the URL; cases
 *    and runs are flat and carry the library in the body instead.
 *  - **Writes take `*_id`, reads return objects** (GOTCHA #5). That is why the
 *    `…Input` types below look nothing like the resources in `types/api.ts`.
 *  - **Nothing here formats, resolves or logs.** Names become ids in
 *    `core/metadata.ts`; rendering happens in `cli/`.
 *
 * Deliberately absent: **`PUT /runs/{id}`** — strictly worse than PATCH, since it
 * forces the whole `steps[]` array and blanks the executor when `executor_id` is
 * omitted (GOTCHA #8), which is the general rule for all ten of this API's `PUT`s
 * (design D8.4). Also absent: `GET /v1/testhub/{cases,runs}` (the simple lists the
 * docs themselves redirect away from), library / suite **update** and **delete**,
 * the library-member endpoints, and every configuration **write**.
 *
 * S3 added the rest of the read/write surface the module was missing: the four
 * bulk endpoints, case delete, both history reads, plan update, and the plan-state
 * and case-property lookups. Library and plan **create** arrived in the milestone
 * before it, because the module could not otherwise produce the fixtures its own
 * acceptance run needs.
 */

// ---------------------------------------------------------------------------
// libraries (测试库)
// ---------------------------------------------------------------------------

export type LibraryListQuery = {
  /** Matches the **name only** ([th#12]). */
  keywords?: string | undefined;
  scope_type?: 'organization' | 'user_group' | string | undefined;
  scope_id?: string | undefined;
  member_type?: string | undefined;
  member_id?: string | undefined;
  /** `"startTs,endTs"` in unix seconds. */
  created_between?: string | undefined;
  updated_between?: string | undefined;
  include_archived?: boolean | undefined;
  include_deleted?: boolean | undefined;
};

/**
 * The entry point: nothing else in testhub is reachable without a `library_id`
 * (testhub §9 #1).
 *
 * No testhub record declares `page_size` / `page_index` as *request* parameters —
 * only the platform overview does (GOTCHA #12), so paging here rides on the
 * documented platform contract rather than on the endpoint's own schema. PRD
 * open question 1 has this scheduled for live verification in S6.
 */
export async function listLibraries(
  ctx: Ctx,
  query: LibraryListQuery = {},
  page: PageRequest = {},
): Promise<Page<TestLibrary>> {
  return await fetchPageOf(ctx, ENDPOINTS.testhubLibraries, { ...query }, page, parseTestLibrary);
}

export function iterateLibraries(
  ctx: Ctx,
  query: LibraryListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<TestLibrary, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.testhubLibraries, { ...query }, options, parseTestLibrary);
}

export async function getLibrary(
  ctx: Ctx,
  libraryId: string,
  options: { include_archived?: boolean | undefined; include_deleted?: boolean | undefined } = {},
): Promise<TestLibrary> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.testhubLibrary(libraryId),
    query: { ...options },
  });
  return parseTestLibrary(raw);
}

/**
 * Required: `name`, `identifier` ([th#2]). The `identifier` is
 * **organisation-unique** and the server enforces it; the CLI does not probe
 * first, because a client-side existence check would double the request count,
 * race, and still be wrong under concurrent writes.
 *
 * `scope_type` / `scope_id` / `members[]` are deliberately not exposed: the CLI
 * creates organisation-scoped libraries, which is the API default, and member
 * management is out of scope. `visibility` defaults to `private` server-side.
 */
export type CreateLibraryInput = {
  name: string;
  identifier: string;
  description?: string | undefined;
  visibility?: 'public' | 'private' | string | undefined;
};

export async function createLibrary(ctx: Ctx, input: CreateLibraryInput): Promise<TestLibrary> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.testhubLibraries,
    body: compact(input),
  });
  return parseTestLibrary(raw);
}

// ---------------------------------------------------------------------------
// suites (模块) — a tree served flat
// ---------------------------------------------------------------------------

export type SuiteListQuery = {
  /**
   * Omitted = the whole tree, `'root'` = top level only, an id = that node's
   * direct children ([th#11]). This walk is the reason the library-scoped suite
   * endpoint is preferred over `GET /v1/testhub/case/suites?library_id=`, which
   * has no such filter (GOTCHA #28).
   */
  parent_id?: string | undefined;
};

/**
 * The suite tree, walked whole.
 *
 * There is deliberately **no single-page `listSuites` companion**. Both callers
 * — `testhub meta suites` and the `testhub-suite` resolver — need every node, and
 * for the same reason: a suite's path is computed by walking `parent` refs, so a
 * partial page yields partial paths and makes cross-branch ambiguity
 * undetectable. A paged variant would only offer a way to get that wrong.
 */
export function iterateSuites(
  ctx: Ctx,
  libraryId: string,
  query: SuiteListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<TestSuite, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.testhubLibrarySuites(libraryId),
    { ...query },
    options,
    parseTestSuite,
  );
}

// ---------------------------------------------------------------------------
// cases (用例)
// ---------------------------------------------------------------------------

/**
 * Required: `test_library_id`, `title` (1–200 chars) ([th#16]).
 *
 * Note the field name: the body says **`test_library_id`**, not `library_id`,
 * even though the response embeds the same thing as `library`.
 *
 * `state_id` is **not** settable here — only `PATCH` can move a case's state, so
 * a new case always starts in the library's default state (GOTCHA #17).
 */
export type CreateCaseInput = {
  test_library_id: string;
  title: string;
  /** Settable on the single create, impossible on the bulk variant (GOTCHA #16). */
  suite_id?: string | undefined;
  type_id?: string | undefined;
  important_level_id?: string | undefined;
  maintenance_id?: string | undefined;
  participant_ids?: string[] | undefined;
  /** A flat `{key: value}` map; passed through untyped (PRD open question 3). */
  properties?: Record<string, unknown> | undefined;
  description?: string | undefined;
  precondition?: string | undefined;
  /** Whole-array replace. A step without `step_id` is created fresh (GOTCHA #9). */
  steps?: TestCaseStep[] | undefined;
};

/**
 * Any subset. The **only** single-case mutator, and the only route to
 * `state_id` or to moving a case between suites ([th#28]).
 *
 * `steps` and `properties` **replace**, they never merge — and a step that
 * arrives without its `step_id` is treated as brand new, which silently orphans
 * every result recorded against the old one (GOTCHA #9). Callers must
 * read-modify-write; this wrapper sends exactly what it is given.
 */
export type UpdateCaseInput = {
  title?: string | undefined;
  suite_id?: string | undefined;
  state_id?: string | undefined;
  type_id?: string | undefined;
  important_level_id?: string | undefined;
  maintenance_id?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  description?: string | undefined;
  precondition?: string | undefined;
  steps?: TestCaseStep[] | undefined;
};

export async function searchCases(
  ctx: Ctx,
  payload: SearchPayload = {},
  page: PageRequest = {},
): Promise<Page<TestCase>> {
  return await fetchSearchPageOf(ctx, ENDPOINTS.testhubCasesSearch, payload, page, parseTestCase);
}

export function iterateCases(
  ctx: Ctx,
  payload: SearchPayload = {},
  options: PaginateOptions = {},
): AsyncGenerator<TestCase, void, undefined> {
  return iterateSearchOf(ctx, ENDPOINTS.testhubCasesSearch, payload, options, parseTestCase);
}

/** Accepts **`id` or `short_id`** ([th#21]) — the only testhub read that is documented for both on a case. */
export async function getCase(
  ctx: Ctx,
  caseId: string,
  options: { include_public_image_token?: string | string[] | undefined } = {},
): Promise<TestCase> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.testhubCase(caseId),
    query: { ...options },
  });
  return parseTestCase(raw);
}

export async function createCase(ctx: Ctx, input: CreateCaseInput): Promise<TestCase> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.testhubCases,
    body: compact(input),
  });
  return parseTestCase(raw);
}

/** `case_id` must be a real **id**; `short_id` is documented for GET only (GOTCHA #19). */
export async function updateCase(
  ctx: Ctx,
  caseId: string,
  patch: UpdateCaseInput,
): Promise<TestCase> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.testhubCase(caseId),
    body: compact(patch),
  });
  return parseTestCase(raw);
}

/**
 * `POST /v1/testhub/cases/bulk` ([th#18]) — the test-import path.
 *
 * **Cap 100 entries, enforced by the server** (400 `100039`, before any field
 * validation) — not the 50 the plan-scoped runs bulk documents. The command layer
 * checks it first so the error arrives without a request.
 *
 * Two entry fields are accepted and **silently dropped**: `suite_id` (documented,
 * GOTCHA #16) and `state_id` (undocumented; a bulk-created case always starts in
 * the library default, live 2026-08-04). `type_id` is the mirror image — not
 * declared, but it works. The command layer refuses the first two and offers the
 * third; nothing is silently forwarded.
 */
export type BulkCreateCasesInput = {
  cases: BulkCreateCaseEntry[];
};

export type BulkCreateCaseEntry = {
  test_library_id: string;
  title: string;
  /** Undeclared upstream, verified to work live 2026-08-04. */
  type_id?: string | undefined;
  important_level_id?: string | undefined;
  maintenance_id?: string | undefined;
  participant_ids?: string[] | undefined;
  /** A flat `{key: value}` map; an unknown key is **refused** (400 `100043`), not dropped. */
  properties?: Record<string, unknown> | undefined;
  description?: string | undefined;
  precondition?: string | undefined;
  steps?: TestCaseStep[] | undefined;
};

export async function bulkCreateCases(
  ctx: Ctx,
  input: BulkCreateCasesInput,
): Promise<TestCaseBulkItem[]> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.testhubCasesBulk,
    body: { cases: input.cases.map((entry) => compact(entry)) },
  });
  // A bare array, not a paged envelope (testhub §3.6).
  return parseBareArray(raw, parseTestCaseBulkItem);
}

/**
 * `PATCH /v1/testhub/cases/bulk` ([th#19]) — partial, per entry.
 *
 * Verified live 2026-08-04: unmentioned fields are left alone (one entry's state
 * changed while its title, type, level, description and steps survived), and
 * `state_id` / `type_id` / `title` / `important_level_id` all land. `suite_id` is
 * silently dropped here as well, so the command layer refuses it.
 */
export type BulkUpdateCasesInput = {
  cases: BulkUpdateCaseEntry[];
};

export type BulkUpdateCaseEntry = {
  case_id: string;
  title?: string | undefined;
  state_id?: string | undefined;
  type_id?: string | undefined;
  important_level_id?: string | undefined;
  maintenance_id?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  description?: string | undefined;
  precondition?: string | undefined;
  steps?: TestCaseStep[] | undefined;
};

export async function bulkUpdateCases(
  ctx: Ctx,
  input: BulkUpdateCasesInput,
): Promise<TestCaseBulkItem[]> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.testhubCasesBulk,
    body: { cases: input.cases.map((entry) => compact(entry)) },
  });
  return parseBareArray(raw, parseTestCaseBulkItem);
}

/**
 * `DELETE /v1/testhub/cases/{case_id}` ([th#17]) — returns the full case body with
 * `is_deleted: 1`, which is what lets the command echo what it destroyed.
 *
 * Live 2026-08-04, two facts the docs do not mention and one that matters a lot:
 *
 *  - it is a **soft delete**: the row is still returned by
 *    `POST /cases/search` with `include_deleted: true`, but there is no undelete
 *    endpoint, so from the API's side it is one-way;
 *  - **it cascades to the case's runs.** A case with a run in a plan took the run
 *    with it: the plan lost the row and `GET /runs/{id}` answers `100603`. This is
 *    why the command layer counts the runs before the `--yes` gate.
 *
 * `short_id` is rejected here (404 `100002`), so callers must pass a real id.
 */
export async function deleteCase(ctx: Ctx, caseId: string): Promise<TestCase> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.testhubCase(caseId),
  });
  return parseTestCase(raw);
}

/**
 * `GET /v1/testhub/cases/{case_id}/histories` ([th#26]) — the latest result of
 * every run of one case, so the row count is the run count, not the attempt count.
 *
 * Paging is honoured (live 2026-08-04) even though the record declares none, and
 * the path is **id-only**. The items are the run-side shape despite what
 * GOTCHA #3 says, which is recorded on `TestCaseHistoryItem` and is why this
 * wrapper still uses its own parser.
 */
export async function listCaseHistories(
  ctx: Ctx,
  caseId: string,
  page: PageRequest = {},
): Promise<Page<TestCaseHistoryItem>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.testhubCaseHistories(caseId),
    {},
    page,
    parseTestCaseHistoryItem,
  );
}

export function iterateCaseHistories(
  ctx: Ctx,
  caseId: string,
  options: PaginateOptions = {},
): AsyncGenerator<TestCaseHistoryItem, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.testhubCaseHistories(caseId),
    {},
    options,
    parseTestCaseHistoryItem,
  );
}

// ---------------------------------------------------------------------------
// plans (测试计划) — the only library-scoped resource in the URL
// ---------------------------------------------------------------------------

export type PlanListQuery = {
  /** Plan names are unique per library ([th#47]), so this is an exact-ish filter. */
  name?: string | undefined;
  created_between?: string | undefined;
  updated_between?: string | undefined;
};

export async function listPlans(
  ctx: Ctx,
  libraryId: string,
  query: PlanListQuery = {},
  page: PageRequest = {},
): Promise<Page<TestPlan>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.testhubLibraryPlans(libraryId),
    { ...query },
    page,
    parseTestPlan,
  );
}

export function iteratePlans(
  ctx: Ctx,
  libraryId: string,
  query: PlanListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<TestPlan, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.testhubLibraryPlans(libraryId),
    { ...query },
    options,
    parseTestPlan,
  );
}

/** `plan_id` accepts **id or short_id** ([th#53]). */
export async function getPlan(
  ctx: Ctx,
  libraryId: string,
  planId: string,
): Promise<TestPlan> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.testhubLibraryPlan(libraryId, planId),
  });
  return parseTestPlan(raw);
}

/**
 * Required: `name` (unique **per library**), `type_id`, `start_at`, `end_at`,
 * `assignee_id` ([th#47]). All five, always — there is no partial plan.
 *
 * `project_id` / `sprint_id` / `version_id` are **not** exposed. They are
 * conditionally required — `project_id` whenever either of the other two is
 * set, `sprint_id` only for an iteration type, `version_id` only for a release
 * type — and a plan type carries no `kind` discriminator, so the CLI cannot
 * tell which of the three a given `type_id` demands. A plain (普通) plan needs
 * none of them; for the other two kinds the server's refusal is what the user
 * sees, which is honest rather than guessed.
 *
 * `start_at` / `end_at` are 10-digit unix **seconds**. Turning a user's date
 * into one is the command layer's job (`parseDateBoundaryFlag`), not this
 * wrapper's.
 */
export type CreatePlanInput = {
  name: string;
  type_id: string;
  start_at: number;
  end_at: number;
  assignee_id: string;
};

export async function createPlan(
  ctx: Ctx,
  libraryId: string,
  input: CreatePlanInput,
): Promise<TestPlan> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.testhubLibraryPlans(libraryId),
    body: compact(input),
  });
  return parseTestPlan(raw);
}

/**
 * `PATCH /v1/testhub/libraries/{library_id}/plans/{plan_id}` ([th#62]) — the only
 * plan mutator, and the only way to write the test-report `summary` or move a plan
 * through its lifecycle.
 *
 * Live 2026-08-04, four things worth knowing:
 *
 *  - it is genuinely **partial**: a name-only patch left state, dates, assignee
 *    and summary untouched;
 *  - `state_id` takes an id from the **organisation-level** `plan_states` list —
 *    there is no library-scoped plan-state view anywhere;
 *  - `start_at` / `end_at` are stored **verbatim**, not snapped to whole days.
 *    That is the opposite of pjm's sprint and release windows (design D15.4), so
 *    a mid-day timestamp survives exactly as sent;
 *  - an **empty body answers 200** and changes nothing, so the refusal of an empty
 *    patch has to live in the command layer.
 *
 * `plan_id` is id-only (a `short_id` answers 404) and the `library_id` segment is
 * validated: a real plan under the wrong library answers `100602`.
 */
export type UpdatePlanInput = {
  name?: string | undefined;
  type_id?: string | undefined;
  project_id?: string | undefined;
  sprint_id?: string | undefined;
  version_id?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  assignee_id?: string | undefined;
  state_id?: string | undefined;
  summary?: string | undefined;
};

export async function updatePlan(
  ctx: Ctx,
  libraryId: string,
  planId: string,
  patch: UpdatePlanInput,
): Promise<TestPlan> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.testhubLibraryPlan(libraryId, planId),
    body: compact(patch),
  });
  return parseTestPlan(raw);
}

/**
 * Plan types of one library ([th#60]) — the only source of a `type_id`.
 *
 * **Scope `pcp:read:testhub:testplan`**, not `configuration`: this endpoint
 * lives under `/libraries/{id}/…` rather than beside the singular-segment
 * config views, and attaching a configuration-scope hint to its 403 would
 * misdirect. Loaded whole, like the other lookups — the list is small and the
 * endpoint declares no paging.
 */
export async function planTypes(ctx: Ctx, libraryId: string): Promise<TestPlanType[]> {
  return await listAllOf(ctx, ENDPOINTS.testhubLibraryPlanTypes(libraryId), {}, parseTestPlanType);
}

// ---------------------------------------------------------------------------
// runs (执行用例)
// ---------------------------------------------------------------------------

/**
 * `PATCH /v1/testhub/runs/{run_id}` ([th#61]).
 *
 * `status_id` is **required even on PATCH** (GOTCHA #7): there is no
 * "only change the remark" mode, so every run update re-asserts a result.
 *
 * `executor_id` is optional, and the command layer keeps it that way for
 * exactly one case. [th#61] claims an omitted `executor_id` defaults the
 * executor to the run's creator, but two raw PATCH controls on 2026-08-02
 * (design §7) showed it is a **no-op for that field**: a run with an executor
 * kept it, a run with `executor: null` stayed null. So the CLI sends the field
 * whenever it has a value — named or inherited from the run — and omits it only
 * when the run is unassigned and the user named nobody. `PUT /runs/{id}` was
 * never re-tested and its documented blanking still stands unverified, which is
 * why that endpoint stays unimplemented (GOTCHA #8).
 */
export type PatchRunInput = {
  status_id: string;
  executor_id?: string | undefined;
  remark?: string | undefined;
  /**
   * Whole-array replace ([th#61]). `step_id` and `status_id` are both required
   * per step, and `status_id` is a **run-status** id, not a case-state id
   * (GOTCHA #10).
   */
  steps?: RunStepInput[] | undefined;
};

export type RunStepInput = {
  step_id: string;
  status_id: string;
  actual_value?: string | undefined;
};

/**
 * `POST /v1/testhub/libraries/{id}/plans/{plan_id}/runs/bulk` ([th#49]).
 *
 * The **only** way to delete a run (GOTCHA #13), and it collapses insert,
 * update and delete into one call. Each array is capped at **50**; the count
 * guard lives in the command layer so the error arrives before the request.
 *
 * The response is counts only — no ids for the runs it created.
 */
export type BulkRunsInput = {
  inserts?: BulkRunInsert[] | undefined;
  updates?: BulkRunUpdate[] | undefined;
  /** Run ids. */
  deletes?: string[] | undefined;
};

export type BulkRunInsert = {
  case_id: string;
  executor_id?: string | undefined;
};

export type BulkRunUpdate = {
  run_id: string;
  status_id: string;
  executor_id?: string | undefined;
  steps?: RunStepInput[] | undefined;
};

/**
 * The "what is left to execute in this plan" query (testhub §9 #13).
 *
 * **Cannot filter by `library.id`** — it is on the exclusion list (GOTCHA #21),
 * so scoping runs to a library has to go through `plan.id`. Run search also
 * supports none of `include_deleted` / `include_archived` /
 * `include_public_image_token`, unlike case search.
 */
export async function searchRuns(
  ctx: Ctx,
  payload: SearchPayload = {},
  page: PageRequest = {},
): Promise<Page<TestRun>> {
  return await fetchSearchPageOf(ctx, ENDPOINTS.testhubRunsSearch, payload, page, parseTestRun);
}

export function iterateRuns(
  ctx: Ctx,
  payload: SearchPayload = {},
  options: PaginateOptions = {},
): AsyncGenerator<TestRun, void, undefined> {
  return iterateSearchOf(ctx, ENDPOINTS.testhubRunsSearch, payload, options, parseTestRun);
}

/** Accepts **id or short_id** ([th#52]). Needed before any run PATCH, to inherit `executor_id`. */
export async function getRun(ctx: Ctx, runId: string): Promise<TestRun> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.testhubRun(runId),
  });
  return parseTestRun(raw);
}

/** `run_id` must be a real **id** — `short_id` is GET-only (GOTCHA #19). */
export async function patchRun(
  ctx: Ctx,
  runId: string,
  patch: PatchRunInput,
): Promise<TestRun> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.testhubRun(runId),
    body: compact(patch),
  });
  return parseTestRun(raw);
}

/**
 * `POST /v1/testhub/runs` ([th#46]) — add one case to one plan as a run.
 *
 * Three ids and an optional executor; the response is the run itself, starting at
 * `status: not_start` / 未测 and inheriting the case's `steps[]` (live 2026-08-04).
 *
 * Two behaviours the command layer relies on:
 *
 *  - **a duplicate is refused**, not silently deduplicated: a case already in the
 *    plan answers 400 `100605` `创建执行用例失败`. That is a conflict rather than an
 *    absence, so it keeps exit 7;
 *  - **an omitted `executor_id` leaves the run unassigned** — it is not defaulted
 *    to the creator, matching the corrected reading of GOTCHA #8.
 */
export type CreateRunInput = {
  library_id: string;
  plan_id: string;
  case_id: string;
  executor_id?: string | undefined;
};

export async function createRun(ctx: Ctx, input: CreateRunInput): Promise<TestRun> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.testhubRuns,
    body: compact(input),
  });
  return parseTestRun(raw);
}

/**
 * `POST /v1/testhub/runs/bulk` ([th#48]) — the same three ids, up to **100** times.
 *
 * **Per-element best effort, under HTTP 200** (live 2026-08-04): every input row
 * comes back as `{state, run?, message?}`, so a batch containing one already-added
 * case lands the others and reports `创建失败或已创建` for that one. Callers must
 * read the `state` of each element rather than trusting the status code — which is
 * exactly what the command layer renders.
 */
export type BulkCreateRunsInput = {
  runs: CreateRunInput[];
};

export async function bulkCreateRuns(
  ctx: Ctx,
  input: BulkCreateRunsInput,
): Promise<TestRunBulkItem[]> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.testhubRunsBulk,
    body: { runs: input.runs.map((entry) => compact(entry)) },
  });
  return parseBareArray(raw, parseTestRunBulkItem);
}

/**
 * `PATCH /v1/testhub/runs/bulk` ([th#50]) — record results on up to **100** runs,
 * anywhere: no plan and no library in the URL, unlike the plan-scoped
 * `bulkRuns` below.
 *
 * **Atomic**, and that is the sharpest difference from its `POST` sibling: one
 * unknown `run_id` rejects the whole batch with 400 `100016` `存在无效run_id` and
 * nothing is applied (verified live 2026-08-04 by reading the valid run back).
 * `status_id` is required on every entry (`100008` otherwise), an omitted
 * `executor_id` preserves the run's current executor, and each applied entry
 * appends a row to that run's history — so a bulk result is auditable, unlike a
 * pjm bulk update.
 */
export type BulkUpdateRunsInput = {
  runs: BulkUpdateRunEntry[];
};

export type BulkUpdateRunEntry = {
  run_id: string;
  status_id: string;
  remark?: string | undefined;
  executor_id?: string | undefined;
  steps?: RunStepInput[] | undefined;
};

export async function bulkUpdateRuns(
  ctx: Ctx,
  input: BulkUpdateRunsInput,
): Promise<TestRunBulkItem[]> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.testhubRunsBulk,
    body: { runs: input.runs.map((entry) => compact(entry)) },
  });
  return parseBareArray(raw, parseTestRunBulkItem);
}

/**
 * `GET /v1/testhub/runs/{run_id}/histories` ([th#58]) — every result ever recorded
 * on one run, oldest first. This is the missing half of a test report.
 *
 * Paging is honoured and pages are disjoint (live 2026-08-04). The path is
 * id-only: a `short_id` answers 404, and an unknown run answers `100619`, which is
 * deliberately **not** mapped to exit 5 because the same code also rejects a whole
 * bulk batch (see `wire.ts`).
 */
export async function listRunHistories(
  ctx: Ctx,
  runId: string,
  page: PageRequest = {},
): Promise<Page<TestRunHistoryItem>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.testhubRunHistories(runId),
    {},
    page,
    parseTestRunHistoryItem,
  );
}

export function iterateRunHistories(
  ctx: Ctx,
  runId: string,
  options: PaginateOptions = {},
): AsyncGenerator<TestRunHistoryItem, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.testhubRunHistories(runId),
    {},
    options,
    parseTestRunHistoryItem,
  );
}

/**
 * One result record ([th#55]). A history id that belongs to a **different** run
 * answers 400 `100643` (a mismatch, kept on exit 7) while a genuinely unknown one
 * answers `100642`, which **is** mapped to exit 5.
 */
export async function getRunHistory(
  ctx: Ctx,
  runId: string,
  historyId: string,
): Promise<TestRunHistoryItem> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.testhubRunHistory(runId, historyId),
  });
  return parseTestRunHistoryItem(raw);
}

export async function bulkRuns(
  ctx: Ctx,
  libraryId: string,
  planId: string,
  input: BulkRunsInput,
): Promise<TestRunBulkResult> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.testhubPlanRunsBulk(libraryId, planId),
    body: compact(input),
  });
  return parseTestRunBulkResult(raw);
}

// ---------------------------------------------------------------------------
// configuration lookups (testhub §9 #3–#6)
// ---------------------------------------------------------------------------

/**
 * Three of these four take `?library_id=` and are **required** to: they are
 * "what is configured for *this* library" views over org-level config, and their
 * items' `url` fields point back at the org-level resources (testhub §5).
 *
 * The scope split across them is inconsistent and load-bearing (GOTCHA #2):
 * `case/types` needs only `pcp:read:testhub:testcase`, but its siblings
 * `case/states` and `run/statuses` need `pcp:read:testhub:configuration`. A
 * token granted `testcase` + `testplan` alone therefore cannot resolve a
 * `state_id` or a `status_id` — which means it cannot perform **any** run write
 * at all. The CLI must say so rather than surfacing a bare 403.
 */

/** **Scope `configuration`.** Resolves `state_id` ([th#25]). */
export async function caseStates(ctx: Ctx, libraryId: string): Promise<TestCaseState[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.testhubCaseStates,
    { library_id: libraryId },
    parseTestCaseState,
  );
}

/** Scope `testcase` — unlike its two siblings ([th#27]). Resolves `type_id`. */
export async function caseTypes(ctx: Ctx, libraryId: string): Promise<TestCaseType[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.testhubCaseTypes,
    { library_id: libraryId },
    parseTestCaseType,
  );
}

/**
 * Resolves `important_level_id`. **Org-level and takes no `library_id`** — this
 * is the one lookup with no library-scoped variant anywhere in the module
 * ([th#40], testhub §5).
 */
export async function importantLevels(ctx: Ctx): Promise<TestCaseImportantLevel[]> {
  return await listAllOf(ctx, ENDPOINTS.testhubCaseImportantLevels, {}, parseTestCaseImportantLevel);
}

/**
 * **Scope `configuration`.** Resolves `status_id` — the hard prerequisite for
 * every run write ([th#57], GOTCHA #5/#10).
 *
 * Items carry no slug, so the caller has to match the localized `name`
 * (通过/受阻/失败/跳过/未测) against the English slug a run reports. Tenants may
 * add their own statuses, which appear in no documented table.
 */
export async function runStatuses(ctx: Ctx, libraryId: string): Promise<TestRunStatus[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.testhubRunStatuses,
    { library_id: libraryId },
    parseTestRunStatus,
  );
}

/**
 * Plan states ([th#64]) — **organisation-level**, so no `library_id` at all, and
 * the source of the `state_id` that `updatePlan` takes.
 *
 * Scope `pcp:read:testhub:configuration`, like `case/states` and `run/statuses`,
 * so the command layer routes it through the same configuration-scope explanation.
 * Three system rows on this tenant; the whole list is loaded, like every other
 * lookup here.
 */
export async function planStates(ctx: Ctx): Promise<TestPlanState[]> {
  return await listAllOf(ctx, ENDPOINTS.testhubPlanStates, {}, parseTestPlanState);
}

/**
 * Case properties effective in one library ([th#23]) — the last piece of the
 * `meta` surface.
 *
 * Scope is `pcp:read:testhub:testcase`, **not** `configuration` (GOTCHA #2), so no
 * configuration-scope hint belongs on its 403. Read the warning on
 * `TestCaseProperty` before using the ids for anything: on this tenant they are all
 * built-in field keys, and only a genuinely custom row is a `--set` key.
 */
export async function caseProperties(ctx: Ctx, libraryId: string): Promise<TestCaseProperty[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.testhubCaseProperties,
    { library_id: libraryId },
    parseTestCaseProperty,
  );
}
