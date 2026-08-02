import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions, SearchPayload } from '../core/paginate';
import type {
  TestCase,
  TestCaseImportantLevel,
  TestCaseState,
  TestCaseStep,
  TestCaseType,
  TestLibrary,
  TestPlan,
  TestRun,
  TestRunBulkResult,
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
  parseTestCase,
  parseTestCaseImportantLevel,
  parseTestCaseState,
  parseTestCaseType,
  parseTestLibrary,
  parseTestPlan,
  parseTestRun,
  parseTestRunBulkResult,
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
 * Deliberately absent, per PRD scope: `PUT /runs/{id}` (strictly worse than
 * PATCH — it forces the whole `steps[]` array and blanks the executor when
 * `executor_id` is omitted, GOTCHA #8), `DELETE /cases/{id}` (irreversible, no
 * undelete endpoint), the `cases/bulk` and `runs/bulk` importer endpoints, plan
 * create/update, every configuration **write**, and the three history reads.
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

export async function listSuites(
  ctx: Ctx,
  libraryId: string,
  query: SuiteListQuery = {},
  page: PageRequest = {},
): Promise<Page<TestSuite>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.testhubLibrarySuites(libraryId),
    { ...query },
    page,
    parseTestSuite,
  );
}

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
