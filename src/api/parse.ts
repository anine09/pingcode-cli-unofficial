import type { Ctx } from '../core/context';
import {
  collect,
  fetchPage,
  fetchSearchPage,
  paginate,
  searchPaginate,
  type Page,
  type PageRequest,
  type PaginateOptions,
  type SearchPayload,
} from '../core/paginate';
import type {
  Project,
  Ref,
  ShipChannel,
  ShipDateRange,
  ShipIdea,
  ShipPriority,
  ShipProduct,
  ShipProductMember,
  ShipProperty,
  ShipPropertyOption,
  ShipState,
  ShipStateFlow,
  ShipStatePlan,
  ShipSuite,
  ShipTicket,
  ShipTicketType,
  Sprint,
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
  User,
  WorkItem,
  WorkItemPriority,
  WorkItemState,
  WorkItemType,
} from '../types/api';

/**
 * Parsing / normalisation for the API layer.
 *
 * This is the **only** place where the two documented inconsistencies are handled
 * (design §8): `is_archived`/`is_deleted` arriving as numbers `0/1`
 * (research §6.10), and `versions` (array, list responses) vs `version` (object,
 * single GET) (research §4.2). Call sites never repeat this.
 *
 * Unknown fields are preserved so `--json` stays faithful to the API and custom
 * `properties` are never silently dropped. Nothing here formats output.
 */

export function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** `is_archived` / `is_deleted` are numbers `0/1`, not booleans (research §6.10). */
export function asBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== '0' && value !== 'false';
  return false;
}

export function parseRef(raw: unknown): Ref | undefined {
  const record = asRecord(raw);
  const id = asString(record.id);
  if (id === undefined) return undefined;
  const ref: Ref = { ...record, id };
  const name = asString(record.name);
  ref.name = name;
  const url = asString(record.url);
  ref.url = url;
  return ref;
}

export function parseRefList(raw: unknown): Ref[] {
  if (!Array.isArray(raw)) return [];
  const refs: Ref[] = [];
  for (const item of raw) {
    const ref = parseRef(item);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

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
// ship (产品管理) — ship research §3
// ---------------------------------------------------------------------------

/** `plan_at` / `real_at` / `estimated_at` — written all-or-nothing (ship GOTCHA #9). */
export function parseDateRange(raw: unknown): ShipDateRange | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    ...record,
    from: asNumber(record.from),
    to: asNumber(record.to),
    granularity: asString(record.granularity),
  };
}

function parseProperties(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

export function parseShipProductMember(raw: unknown): ShipProductMember {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    type: asString(record.type),
    user: parseRef(record.user),
    user_group: parseRef(record.user_group),
    role: parseRef(record.role),
    product: parseRef(record.product),
  };
}

export function parseShipProduct(raw: unknown): ShipProduct {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    name: asString(record.name),
    url: asString(record.url),
    scope_type: asString(record.scope_type),
    scope_id: asString(record.scope_id),
    visibility: asString(record.visibility),
    color: asString(record.color),
    description: asString(record.description),
    members: Array.isArray(record.members) ? record.members.map(parseShipProductMember) : [],
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseShipIdea(raw: unknown): ShipIdea {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    short_id: asString(record.short_id),
    url: asString(record.url),
    html_url: asString(record.html_url),
    title: asString(record.title),
    description: asString(record.description),
    product: parseRef(record.product),
    assignee: parseRef(record.assignee),
    state: parseRef(record.state),
    priority: parseRef(record.priority),
    plan: parseRef(record.plan),
    suite: parseRef(record.suite),
    plan_at: parseDateRange(record.plan_at),
    real_at: parseDateRange(record.real_at),
    score: asNumber(record.score),
    progress: asNumber(record.progress),
    properties: parseProperties(record.properties),
    participants: parseRefList(record.participants),
    completed_at: asNumber(record.completed_at),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

/**
 * `ticket.channel` is documented as `Object/String`: a reference for externally
 * submitted tickets, the bare string `"internal"` otherwise (ship GOTCHA #3).
 * Naive `channel.name` access throws on internal tickets, so the union is kept.
 */
export function parseTicketChannel(raw: unknown): Ref | string | undefined {
  if (typeof raw === 'string') return raw === '' ? undefined : raw;
  return parseRef(raw);
}

export function parseShipTicket(raw: unknown): ShipTicket {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    short_id: asString(record.short_id),
    url: asString(record.url),
    html_url: asString(record.html_url),
    title: asString(record.title),
    description: asString(record.description),
    product: parseRef(record.product),
    assignee: parseRef(record.assignee),
    state: parseRef(record.state),
    type: parseRef(record.type),
    customer: parseRef(record.customer),
    solution: parseRef(record.solution),
    priority: parseRef(record.priority),
    channel: parseTicketChannel(record.channel),
    estimated_at: parseDateRange(record.estimated_at),
    properties: parseProperties(record.properties),
    tags: parseRefList(record.tags),
    participants: parseRefList(record.participants),
    submitted_at: asNumber(record.submitted_at),
    submitted_by: parseRef(record.submitted_by),
    completed_at: asNumber(record.completed_at),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseShipState(raw: unknown): ShipState {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
    color: asString(record.color),
  };
}

export function parseShipPriority(raw: unknown): ShipPriority {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    color: asString(record.color),
  };
}

export function parseShipSuite(raw: unknown): ShipSuite {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
    parent: parseRef(record.parent),
    product: parseRef(record.product),
  };
}

export function parseShipTicketType(raw: unknown): ShipTicketType {
  const record = asRecord(raw);
  const parsed: ShipTicketType = {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
  };
  // The product-scoped list omits `is_system` entirely (ship GOTCHA #12); an
  // absent flag must stay absent rather than become a confident `false`.
  parsed.is_system = record.is_system === undefined ? undefined : asBooleanFlag(record.is_system);
  return parsed;
}

export function parseShipChannel(raw: unknown): ShipChannel {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    description: asString(record.description),
  };
}

export function parseShipPropertyOption(raw: unknown): ShipPropertyOption {
  const record = asRecord(raw);
  return {
    ...record,
    // The declared key is `_id`, but one documented PATCH example uses `id`
    // (ship GOTCHA #8), so both are read and normalised onto `_id`.
    _id: asString(record._id) ?? asString(record.id),
    text: asString(record.text),
    parent_id: asString(record.parent_id),
  };
}

export function parseShipProperty(raw: unknown): ShipProperty {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
    options: Array.isArray(record.options) ? record.options.map(parseShipPropertyOption) : [],
  };
}

export function parseShipStatePlan(raw: unknown): ShipStatePlan {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    // Nullable: `null` means the org-level default plan (ship GOTCHA #23).
    product: parseRef(record.product),
  };
}

/**
 * State flows spell the source state **`form_state`** in the docs while
 * transition histories spell it `from_state`, and no response example exists to
 * settle which reaches the wire (ship GOTCHA #2). Both are accepted; the
 * normalised value is `from_state`.
 */
export function parseShipStateFlow(raw: unknown): ShipStateFlow {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    from_state: parseRef(record.from_state) ?? parseRef(record.form_state),
    to_state: parseRef(record.to_state),
    state_plan: parseRef(record.state_plan),
  };
}

// ---------------------------------------------------------------------------
// Testhub (测试管理) — testhub research §3
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// list plumbing
// ---------------------------------------------------------------------------

export type Parser<T> = (raw: unknown) => T;

/** One page of a list endpoint, parsed. */
export async function fetchPageOf<T>(
  ctx: Ctx,
  path: string,
  query: Record<string, unknown>,
  page: PageRequest,
  parse: Parser<T>,
): Promise<Page<T>> {
  const raw = await fetchPage<unknown>(ctx, path, query, page);
  return { ...raw, values: raw.values.map(parse) };
}

/** Walk a list endpoint, parsing as we go. */
export async function* iterateOf<T>(
  ctx: Ctx,
  path: string,
  query: Record<string, unknown>,
  options: PaginateOptions,
  parse: Parser<T>,
): AsyncGenerator<T, void, undefined> {
  for await (const raw of paginate<unknown>(ctx, path, query, options)) {
    yield parse(raw);
  }
}

/** Collect every row of a (small, config-shaped) list endpoint. */
export async function listAllOf<T>(
  ctx: Ctx,
  path: string,
  query: Record<string, unknown>,
  parse: Parser<T>,
  options: PaginateOptions = {},
): Promise<T[]> {
  return await collect(
    iterateOf(ctx, path, query, { pageSize: 100, limit: 1000, ...options }, parse),
  );
}

/** One page of a `POST …/search` endpoint, parsed (ship §4). */
export async function fetchSearchPageOf<T>(
  ctx: Ctx,
  path: string,
  payload: SearchPayload,
  page: PageRequest,
  parse: Parser<T>,
): Promise<Page<T>> {
  const raw = await fetchSearchPage<unknown>(ctx, path, payload, page);
  return { ...raw, values: raw.values.map(parse) };
}

/** Walk a `POST …/search` endpoint, parsing as we go. */
export async function* iterateSearchOf<T>(
  ctx: Ctx,
  path: string,
  payload: SearchPayload,
  options: PaginateOptions,
  parse: Parser<T>,
): AsyncGenerator<T, void, undefined> {
  for await (const raw of searchPaginate<unknown>(ctx, path, payload, options)) {
    yield parse(raw);
  }
}

/** Drop `undefined` values so they never reach a JSON request body. */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
