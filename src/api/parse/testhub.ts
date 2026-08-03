/**
 * testhub (测试管理) parsers — testhub research §3.
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
  TestCase,
  TestCaseHistoryItem,
  TestCaseImportantLevel,
  TestCaseState,
  TestCaseStep,
  TestCaseType,
  TestLibrary,
  TestPlan,
  TestPlanRef,
  TestPlanType,
  TestRun,
  TestRunBulkResult,
  TestRunHistoryItem,
  TestRunStatus,
  TestRunStep,
  TestSuite,
} from '../../types/api';
import {
  asBooleanFlag,
  asNumber,
  asRecord,
  asString,
  parseProperties,
  parseRef,
  parseRefList,
} from './common';

/**
 * Four normalisations are concentrated here so no testhub call site repeats them:
 *
 *  1. `0`/`1` (and the string forms `'0'`/`'1'` the schema actually declares,
 *     GOTCHA #25) → boolean, via the shared `asBooleanFlag`.
 *  2. `is_system` is left **absent** rather than defaulted to `false` when the
 *     endpoint omits it — the library-scoped `run/statuses` list does ([th#57]),
 *     and a confident `false` there would be a lie. Same rule as ship's
 *     `parseShipTicketType`.
 *  3. Array fields become `[]` so callers never branch on undefined.
 *  4. The two shapes the docs conflate get **two parsers**, never one: a case
 *     step is not a run step, and a run's embedded `plan` is not a plan resource.
 */

export function parseTestLibrary(raw: unknown): TestLibrary {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    name: asString(record.name),
    url: asString(record.url),
    description: asString(record.description),
    scope_type: asString(record.scope_type),
    scope_id: asString(record.scope_id),
    visibility: asString(record.visibility),
    color: asString(record.color),
    members: parseRefList(record.members),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

/**
 * The parent arrives as a **`parent` reference object** and the ancestor path as
 * **`paths`** (plural) — not `parent_id` / `path` ([th#9]). `core/metadata.ts`
 * reads `parent.id` when it flattens the tree, so getting this wrong would
 * silently produce a forest of roots.
 */
export function parseTestSuite(raw: unknown): TestSuite {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    url: asString(record.url),
    library: parseRef(record.library),
    parent: parseRef(record.parent),
    paths: asString(record.paths),
  };
}

/** A **case** step: prose and expectations, no result (GOTCHA #9 corollary). */
export function parseTestCaseStep(raw: unknown): TestCaseStep {
  const record = asRecord(raw);
  const step: TestCaseStep = {
    ...record,
    step_id: asString(record.step_id),
    description: asString(record.description),
    expected_value: asString(record.expected_value),
    group_id: asString(record.group_id),
  };
  // Absent must stay absent: `is_group` decides whether `group_id` is even legal
  // on this step, so inventing `false` would misdescribe a group header.
  step.is_group = record.is_group === undefined ? undefined : asBooleanFlag(record.is_group);
  return step;
}

/** A **run** step: the result only ([th#52]). Deliberately not `parseTestCaseStep`. */
export function parseTestRunStep(raw: unknown): TestRunStep {
  const record = asRecord(raw);
  return {
    ...record,
    step_id: asString(record.step_id),
    status: asString(record.status),
    actual_value: asString(record.actual_value),
  };
}

export function parseTestCase(raw: unknown): TestCase {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    short_id: asString(record.short_id),
    url: asString(record.url),
    html_url: asString(record.html_url),
    title: asString(record.title),
    level: asString(record.level),
    library: parseRef(record.library),
    suite: parseRef(record.suite),
    state: parseRef(record.state),
    type: parseRef(record.type),
    important_level: parseRef(record.important_level),
    maintenance: parseRef(record.maintenance),
    test_type: asString(record.test_type),
    description: asString(record.description),
    precondition: asString(record.precondition),
    properties: parseProperties(record.properties),
    estimated_workload: asNumber(record.estimated_workload),
    remaining_workload: asNumber(record.remaining_workload),
    steps: Array.isArray(record.steps) ? record.steps.map(parseTestCaseStep) : [],
    participants: parseRefList(record.participants),
    public_image_token: asString(record.public_image_token),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

/**
 * The **plan resource**: `state` is an object here ([th#53]).
 *
 * No `is_archived` / `is_deleted` — testhub §3.2 names that as the plan's
 * difference from library, case and run — so unlike every other testhub
 * resource this one has no normalised boolean flags at all.
 */
export function parseTestPlan(raw: unknown): TestPlan {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    short_id: asString(record.short_id),
    name: asString(record.name),
    url: asString(record.url),
    html_url: asString(record.html_url),
    library: parseRef(record.library),
    type: parseRef(record.type),
    state: parseRef(record.state),
    project: parseRef(record.project),
    sprint: parseRef(record.sprint),
    version: parseRef(record.version),
    assignee: parseRef(record.assignee),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
    summary: asString(record.summary),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
  };
}

/**
 * An **embedded** plan reference: `status` is a flat string here, where the plan
 * resource has a `state` object (GOTCHA #4).
 *
 * This is why `parseTestPlan` is not reused: it would read `state` off a payload
 * that never carries one and drop the `status` that is actually there.
 */
export function parseTestPlanRef(raw: unknown): TestPlanRef | undefined {
  const record = asRecord(raw);
  const id = asString(record.id);
  if (id === undefined) return undefined;
  return {
    ...record,
    id,
    name: asString(record.name),
    url: asString(record.url),
    status: asString(record.status),
    short_id: asString(record.short_id),
    html_url: asString(record.html_url),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
  };
}

export function parseTestRun(raw: unknown): TestRun {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    short_id: asString(record.short_id),
    url: asString(record.url),
    html_url: asString(record.html_url),
    library: parseRef(record.library),
    plan: parseTestPlanRef(record.plan),
    case: parseRef(record.case),
    suite: parseRef(record.suite),
    status: asString(record.status),
    latest_executed_status: parseRef(record.latest_executed_status),
    executor: parseRef(record.executor),
    remark: asString(record.remark),
    steps: Array.isArray(record.steps) ? record.steps.map(parseTestRunStep) : [],
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

/** `is_system` is undeclared on this resource — carried through, never invented. */
export function parseTestCaseState(raw: unknown): TestCaseState {
  const record = asRecord(raw);
  const state: TestCaseState = {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
    // Declared on the single-get record but absent from the list example ([th#25]).
    color: asString(record.color),
  };
  state.is_system = record.is_system === undefined ? undefined : asBooleanFlag(record.is_system);
  return state;
}

export function parseTestCaseType(raw: unknown): TestCaseType {
  const record = asRecord(raw);
  const type: TestCaseType = {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
  };
  type.is_system = record.is_system === undefined ? undefined : asBooleanFlag(record.is_system);
  return type;
}

export function parseTestCaseImportantLevel(raw: unknown): TestCaseImportantLevel {
  const record = asRecord(raw);
  const level: TestCaseImportantLevel = {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    color: asString(record.color),
  };
  level.is_system = record.is_system === undefined ? undefined : asBooleanFlag(record.is_system);
  return level;
}

/**
 * The lookup every run write depends on ([th#57]).
 *
 * There is **no slug field** on these items, so `name` is the only join key back
 * to the `pass`/`block`/… slug a run reports (GOTCHA #5/#10). The
 * library-scoped list omits `is_system`, which therefore stays absent.
 */
export function parseTestRunStatus(raw: unknown): TestRunStatus {
  const record = asRecord(raw);
  const status: TestRunStatus = {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
  };
  status.is_system = record.is_system === undefined ? undefined : asBooleanFlag(record.is_system);
  return status;
}

/**
 * Plan types ([th#60]). Read by `planTypes()` to resolve the `type_id` that
 * `createPlan()` requires.
 *
 * There is **no `kind` discriminator** — only `id` / `url` / `name` / `library`
 * — so nothing here can tell an iteration type from a release type, and the localized name
 * must not be used to guess: tenants rename them (testhub §10.7).
 */
export function parseTestPlanType(raw: unknown): TestPlanType {
  const record = asRecord(raw);
  const planType: TestPlanType = {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    library: parseRef(record.library),
  };
  planType.is_system = record.is_system === undefined ? undefined : asBooleanFlag(record.is_system);
  return planType;
}

/**
 * `/runs/{id}/histories` items: `executed_status` is an **object** and a
 * `remark` exists (GOTCHA #3). No wrapper in this slice.
 */
export function parseTestRunHistoryItem(raw: unknown): TestRunHistoryItem {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    run: parseRef(record.run),
    library: parseRef(record.library),
    plan: parseTestPlanRef(record.plan),
    case: parseRef(record.case),
    executed_status: parseRef(record.executed_status),
    remark: asString(record.remark),
    executed_at: asNumber(record.executed_at),
    executed_by: parseRef(record.executed_by),
    steps: Array.isArray(record.steps) ? record.steps.map(parseTestRunStep) : [],
  };
}

/**
 * `/cases/{id}/histories` items: a flat `status` **string** and no `remark` at
 * all (GOTCHA #3). Sharing `parseTestRunHistoryItem` would read
 * `executed_status` off a payload that has none. No wrapper in this slice.
 */
export function parseTestCaseHistoryItem(raw: unknown): TestCaseHistoryItem {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    run: parseRef(record.run),
    library: parseRef(record.library),
    plan: parseTestPlanRef(record.plan),
    case: parseRef(record.case),
    status: asString(record.status),
    executed_at: asNumber(record.executed_at),
    executed_by: parseRef(record.executed_by),
    steps: Array.isArray(record.steps) ? record.steps.map(parseTestRunStep) : [],
  };
}

/** Counts only — the created runs' ids are not returned ([th#49]). */
export function parseTestRunBulkResult(raw: unknown): TestRunBulkResult {
  const record = asRecord(raw);
  return {
    ...record,
    inserts: asNumber(record.inserts),
    updates: asNumber(record.updates),
    deletes: asNumber(record.deletes),
  };
}
