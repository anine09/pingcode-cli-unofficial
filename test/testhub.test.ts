import { describe, expect, it } from 'vitest';
import {
  parseTestCase,
  parseTestCaseHistoryItem,
  parseTestCaseState,
  parseTestCaseStep,
  parseTestCaseType,
  parseTestLibrary,
  parseTestPlan,
  parseTestPlanRef,
  parseTestRun,
  parseTestRunBulkResult,
  parseTestRunStatus,
  parseTestRunHistoryItem,
  parseTestRunStep,
  parseTestSuite,
} from '../src/api/parse';
import {
  bulkRuns,
  caseStates,
  caseTypes,
  createCase,
  getCase,
  getLibrary,
  getPlan,
  getRun,
  importantLevels,
  iterateCases,
  iterateLibraries,
  iteratePlans,
  iterateRuns,
  iterateSuites,
  listLibraries,
  listPlans,
  listSuites,
  patchRun,
  runStatuses,
  searchCases,
  searchRuns,
  updateCase,
} from '../src/api/testhub';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { DryRunHalt } from '../src/core/errors';
import { collect } from '../src/core/paginate';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S2: the testhub API wrappers. Injected `fetch`, zero network. Every assertion
 * is either a wire fact (method, path, query, body) or a normalisation the
 * research report demands — the singular-vs-plural segment split (GOTCHA #2),
 * `0`/`1` → boolean (GOTCHA #25), `is_system` staying absent ([th#57]), the two
 * history shapes (GOTCHA #3), and the plan `status`-vs-`state` divergence
 * (GOTCHA #4).
 */

const NOW = 1_700_000_000_000;

function ctxFor(responses: Array<() => Response>, options: { dryRun?: boolean } = {}) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { ctx, fake };
}

function envelope(values: unknown[]): Response {
  return jsonResponse({ page_index: 0, page_size: 100, total: values.length, values });
}

describe('testhub normalisation', () => {
  it('turns 0/1 archive flags into booleans (GOTCHA #25)', () => {
    expect(parseTestLibrary({ id: 'l', is_archived: 1, is_deleted: 0 }).is_archived).toBe(true);
    expect(parseTestCase({ id: 'c', is_archived: 0, is_deleted: 1 }).is_deleted).toBe(true);
    expect(parseTestRun({ id: 'r', is_archived: 1 }).is_archived).toBe(true);
  });

  it('tolerates the string forms the schema actually declares (GOTCHA #25)', () => {
    // allowedValues is ['0','1'] — string literals — while the examples show integers.
    expect(parseTestCase({ id: 'c', is_archived: '1', is_deleted: '0' })).toMatchObject({
      is_archived: true,
      is_deleted: false,
    });
    expect(parseTestRunStatus({ id: 's', is_system: '1' }).is_system).toBe(true);
    expect(parseTestRunStatus({ id: 's', is_system: '0' }).is_system).toBe(false);
  });

  it('leaves is_system absent rather than defaulting it to false ([th#57])', () => {
    // The library-scoped run/statuses list omits the field entirely.
    expect(parseTestRunStatus({ id: 's1', name: '通过' }).is_system).toBeUndefined();
    expect(parseTestRunStatus({ id: 's1', is_system: 1 }).is_system).toBe(true);
    expect(parseTestCaseState({ id: 'st1', name: '待评审' }).is_system).toBeUndefined();
    expect(parseTestCaseType({ id: 'ty1', name: '功能测试' }).is_system).toBeUndefined();
  });

  it('keeps a run status name as the only join key — there is no slug field (GOTCHA #5)', () => {
    const status = parseTestRunStatus({ id: 'rs1', url: '/v1/testhub/run_statuses/rs1', name: '通过' });
    expect(status.name).toBe('通过');
    expect(status.slug).toBeUndefined();
    expect(status.type).toBeUndefined();
  });

  it('reads a suite parent as a ref and the ancestor chain as `paths` ([th#9])', () => {
    const suite = parseTestSuite({
      id: 'su2',
      name: '短信验证码',
      parent: { id: 'su1', name: '登录' },
      // live shape: the ancestor chain, excluding this node
      paths: '登录',
      library: { id: 'lib-1' },
    });
    // core/metadata.ts flattens the tree through `parent.id`; a `parent_id`
    // scalar would leave every node looking like a root.
    expect(suite.parent?.id).toBe('su1');
    expect(suite.paths).toBe('登录');
    expect(suite.library?.id).toBe('lib-1');
  });

  it('does not invent is_group on a case step (GOTCHA #10)', () => {
    expect(parseTestCaseStep({ step_id: 's1', description: 'click' }).is_group).toBeUndefined();
    expect(parseTestCaseStep({ step_id: 's1', is_group: 1 }).is_group).toBe(true);
  });

  it('keeps nullable-but-declared-required step fields absent (GOTCHA #24)', () => {
    const step = parseTestCaseStep({ step_id: 's1', expected_value: null, group_id: null });
    expect(step.expected_value).toBeUndefined();
    expect(step.group_id).toBeUndefined();
    const runStep = parseTestRunStep({ step_id: 's1', status: 'pass', actual_value: null });
    expect(runStep.actual_value).toBeUndefined();
    expect(runStep.status).toBe('pass');
  });

  it('parses case steps and run steps with different shapes (GOTCHA #9/#10)', () => {
    const testCase = parseTestCase({
      id: 'c1',
      steps: [{ step_id: 's1', description: 'open', expected_value: 'form', is_group: 0 }],
    });
    expect(testCase.steps[0]).toMatchObject({ step_id: 's1', description: 'open' });

    const run = parseTestRun({
      id: 'r1',
      steps: [{ step_id: 's1', status: 'pass', actual_value: 'ok' }],
    });
    // A run step carries the result and none of the case-side prose.
    expect(run.steps[0]).toMatchObject({ step_id: 's1', status: 'pass', actual_value: 'ok' });
    expect(run.steps[0]?.description).toBeUndefined();
  });

  it('normalises missing arrays to [] on both case and run', () => {
    expect(parseTestCase({ id: 'c1' }).steps).toEqual([]);
    expect(parseTestCase({ id: 'c1' }).participants).toEqual([]);
    expect(parseTestRun({ id: 'r1' }).steps).toEqual([]);
    expect(parseTestLibrary({ id: 'l1' }).members).toEqual([]);
  });

  it('reads an embedded plan through `status`, not `state` (GOTCHA #4)', () => {
    const ref = parseTestPlanRef({
      id: 'p1',
      name: 'Sprint 3 回归',
      status: 'in_progress',
      short_id: 'ab12cd34',
    });
    expect(ref).toMatchObject({ id: 'p1', status: 'in_progress' });
    expect(ref?.state).toBeUndefined();
    expect(parseTestPlanRef({ name: 'no id' })).toBeUndefined();
  });

  it('reads the plan resource through `state`, an object (GOTCHA #4)', () => {
    const plan = parseTestPlan({
      id: 'p1',
      name: 'Sprint 3 回归',
      state: { id: 'ps1', name: '进行中', type: 'in_progress' },
      project: { id: 'proj-1', identifier: 'SCR' },
    });
    expect(plan.state?.id).toBe('ps1');
    expect(plan.state?.type).toBe('in_progress');
    expect(plan.project?.id).toBe('proj-1');
    // A plan carries no archive flags at all — unlike library, case and run.
    expect(plan.is_archived).toBeUndefined();
    expect(plan.is_deleted).toBeUndefined();
  });

  it('nests an embedded plan ref inside a run without collapsing it to a plan', () => {
    const run = parseTestRun({ id: 'r1', plan: { id: 'p1', status: 'in_progress' } });
    expect(run.plan?.status).toBe('in_progress');
    expect(run.plan?.state).toBeUndefined();
  });

  it('keeps the two history shapes on separate deserializers (GOTCHA #3)', () => {
    const runHistory = parseTestRunHistoryItem({
      id: 'h1',
      executed_status: { id: 'rs1', name: '通过' },
      remark: 'retested',
      steps: [{ step_id: 's1', status: 'pass' }],
    });
    expect(runHistory.executed_status?.name).toBe('通过');
    expect(runHistory.remark).toBe('retested');

    const caseHistory = parseTestCaseHistoryItem({ id: 'h2', status: 'pass' });
    // Flat string, no `executed_status`, and no `remark` sibling exists at all.
    expect(caseHistory.status).toBe('pass');
    expect(caseHistory.executed_status).toBeUndefined();
    expect(caseHistory.remark).toBeUndefined();
  });

  it('keeps timestamps raw and preserves unknown fields and custom properties', () => {
    const testCase = parseTestCase({
      id: 'c1',
      created_at: 1578897962,
      properties: { severity: 'blocker' },
      future_field: 'kept',
    });
    expect(testCase.created_at).toBe(1578897962);
    expect(testCase.properties).toEqual({ severity: 'blocker' });
    expect(testCase.future_field).toBe('kept');
  });

  it('keeps nullable workloads absent rather than zero (GOTCHA #24)', () => {
    const testCase = parseTestCase({
      id: 'c1',
      estimated_workload: null,
      remaining_workload: null,
    });
    expect(testCase.estimated_workload).toBeUndefined();
    expect(testCase.remaining_workload).toBeUndefined();
    expect(parseTestCase({ id: 'c1', estimated_workload: 0 }).estimated_workload).toBe(0);
  });

  it('parses the bulk result as counts only ([th#49])', () => {
    expect(parseTestRunBulkResult({ inserts: 3, updates: 2, deletes: 0 })).toMatchObject({
      inserts: 3,
      updates: 2,
      deletes: 0,
    });
    // No ids of created runs are returned, so there is nothing else to read.
    expect(parseTestRunBulkResult({}).inserts).toBeUndefined();
  });

  it('never validates an id shape', () => {
    expect(parseTestCaseState({ id: 'pending' }).id).toBe('pending');
    expect(parseTestLibrary({ id: 'LIB' }).id).toBe('LIB');
  });
});

describe('libraries api', () => {
  it('lists libraries with keywords and paging', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'lib-1', identifier: 'LIB', name: '核心回归库', is_archived: 0 }],
        }),
    ]);
    const page = await listLibraries(ctx, { keywords: '回归', include_archived: true }, { pageSize: 30 });
    expect(page.values[0]?.identifier).toBe('LIB');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/libraries');
    expect(url.searchParams.get('keywords')).toBe('回归');
    expect(url.searchParams.get('include_archived')).toBe('true');
    expect(url.searchParams.get('page_size')).toBe('30');
    expect(fake.calls[0]?.method).toBe('GET');
  });

  it('iterates libraries across pages, de-duplicating by id', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 2, total: 3, values: [{ id: 'a' }, { id: 'b' }] }),
      () => jsonResponse({ page_index: 1, page_size: 2, total: 3, values: [{ id: 'c' }] }),
    ]);
    const libraries = await collect(iterateLibraries(ctx, {}, { pageSize: 2 }));
    expect(libraries.map((library) => library.id)).toEqual(['a', 'b', 'c']);
    expect(new URL(fake.urls()[1] ?? '').searchParams.get('page_index')).toBe('1');
  });

  it('gets one library', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'lib-1', name: '核心回归库', is_archived: 0, is_deleted: 0 }),
    ]);
    expect((await getLibrary(ctx, 'lib-1', { include_deleted: true })).name).toBe('核心回归库');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/libraries/lib-1');
    expect(url.searchParams.get('include_deleted')).toBe('true');
  });

  it('percent-encodes a library id into the path', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'a b' })]);
    await getLibrary(ctx, 'a b');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/libraries/a%20b');
  });
});

describe('suites api', () => {
  it('lists suites under the library and passes ?parent_id=root ([th#11])', async () => {
    const { ctx, fake } = ctxFor([
      () => envelope([{ id: 'su1', name: '登录', paths: '登录' }]),
    ]);
    const page = await listSuites(ctx, 'lib-1', { parent_id: 'root' });
    expect(page.values[0]?.paths).toBe('登录');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/libraries/lib-1/suites');
    expect(url.searchParams.get('parent_id')).toBe('root');
    expect(fake.calls[0]?.method).toBe('GET');
  });

  it('omits parent_id entirely when not given (= the whole tree)', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: 'su1' }])]);
    await collect(iterateSuites(ctx, 'lib-1'));
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/libraries/lib-1/suites');
    expect(url.searchParams.get('parent_id')).toBeNull();
  });
});

describe('cases api', () => {
  it('reads through POST …/cases/search, never GET /v1/testhub/cases (GOTCHA #20)', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 2, total: 1, values: [{ id: 'c1', title: '登录' }] }),
    ]);
    const page = await searchCases(
      ctx,
      { filter: { 'library.id': { in: ['lib-1'] }, 'state.id': { in: ['st1'] } }, keywords: 'sso' },
      { pageSize: 2 },
    );
    expect(page.values[0]?.title).toBe('登录');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/cases/search');
    // The page cursor lives inside `payload`, not the query string.
    expect(fake.calls[0]?.body).toEqual({
      mode: 'query',
      payload: {
        filter: { 'library.id': { in: ['lib-1'] }, 'state.id': { in: ['st1'] } },
        keywords: 'sso',
        page_index: 0,
        page_size: 2,
      },
    });
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('page_size')).toBeNull();
    expect(fake.calls.some((call) => new URL(call.url).pathname === '/v1/testhub/cases')).toBe(false);
  });

  it('iterates cases through the search cursor', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [{ id: 'c1' }] }),
      () => jsonResponse({ page_index: 1, page_size: 1, total: 2, values: [{ id: 'c2' }] }),
      () => jsonResponse({ page_index: 2, page_size: 1, total: 2, values: [] }),
    ]);
    const cases = await collect(iterateCases(ctx, { keywords: 'x' }, { pageSize: 1 }));
    expect(cases.map((testCase) => testCase.id)).toEqual(['c1', 'c2']);
    const second = fake.calls[1]?.body as { payload: { page_index: number } };
    expect(second.payload.page_index).toBe(1);
  });

  it('gets one case by short_id and asks for image tokens ([th#21])', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'c1', short_id: 'ab12cd34', title: '登录', steps: [] }),
    ]);
    const testCase = await getCase(ctx, 'ab12cd34', {
      include_public_image_token: 'description',
    });
    expect(testCase.short_id).toBe('ab12cd34');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/cases/ab12cd34');
    expect(url.searchParams.get('include_public_image_token')).toBe('description');
  });

  it('creates with test_library_id (not library_id) and a compacted body ([th#16])', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'c-new' }, { status: 201 })]);
    const created = await createCase(ctx, {
      test_library_id: 'lib-1',
      title: '短信验证码登录',
      suite_id: 'su1',
      type_id: 'ty1',
      description: undefined,
      steps: [{ step_id: 's1', description: 'open', expected_value: 'form' }],
    });
    expect(created.id).toBe('c-new');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/cases');
    expect(fake.calls[0]?.body).toEqual({
      test_library_id: 'lib-1',
      title: '短信验证码登录',
      suite_id: 'su1',
      type_id: 'ty1',
      steps: [{ step_id: 's1', description: 'open', expected_value: 'form' }],
    });
  });

  it('patches only the provided fields, including state_id ([th#28])', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'c1', state: { id: 'st2' } })]);
    await updateCase(ctx, 'c1', { state_id: 'st2', suite_id: 'su9', title: undefined });
    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ state_id: 'st2', suite_id: 'su9' });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/cases/c1');
  });

  it('sends steps verbatim — the wrapper never rebuilds the array (GOTCHA #9)', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'c1' })]);
    const steps = [
      { step_id: 's1', description: 'open', expected_value: 'form' },
      { step_id: 's2', description: 'submit', expected_value: 'ok' },
    ];
    await updateCase(ctx, 'c1', { steps });
    // Read-modify-write is the caller's job; dropping a step_id here would
    // silently orphan its results, so the wrapper must not touch the array.
    expect((fake.calls[0]?.body as { steps: unknown }).steps).toEqual(steps);
  });
});

describe('plans api', () => {
  it('lists plans under the library with ?name ([th#59])', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: 'p1', name: 'Sprint 3 回归' }])]);
    const page = await listPlans(ctx, 'lib-1', { name: 'Sprint 3 回归' });
    expect(page.values[0]?.name).toBe('Sprint 3 回归');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/libraries/lib-1/plans');
    expect(url.searchParams.get('name')).toBe('Sprint 3 回归');
  });

  it('iterates plans under the library', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'p1' }] }),
    ]);
    expect((await collect(iteratePlans(ctx, 'lib-1'))).map((plan) => plan.id)).toEqual(['p1']);
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/libraries/lib-1/plans');
  });

  it('gets one plan by short_id, nested under its library ([th#53])', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'p1', short_id: 'zz99', state: { id: 'ps1', type: 'in_progress' } }),
    ]);
    const plan = await getPlan(ctx, 'lib-1', 'zz99');
    expect(plan.state?.type).toBe('in_progress');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/libraries/lib-1/plans/zz99');
    expect(fake.calls[0]?.method).toBe('GET');
  });
});

describe('runs api', () => {
  it('reads through POST …/runs/search, scoping by plan.id not library.id (GOTCHA #21)', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [{ id: 'r1' }] }),
    ]);
    await searchRuns(ctx, {
      filter: { 'plan.id': { in: ['p1'] }, 'latest_executed_status.id': { in: ['rs-not-start'] } },
    });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/runs/search');
    const body = fake.calls[0]?.body as { mode: string; payload: { filter: Record<string, unknown> } };
    expect(body.mode).toBe('query');
    expect(body.payload.filter).toEqual({
      'plan.id': { in: ['p1'] },
      'latest_executed_status.id': { in: ['rs-not-start'] },
    });
    // library.id is on the runs-search exclusion list; nothing here adds it back.
    expect(body.payload.filter['library.id']).toBeUndefined();
  });

  it('iterates runs through the search cursor', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [{ id: 'r1' }] }),
      () => jsonResponse({ page_index: 1, page_size: 1, total: 2, values: [{ id: 'r2' }] }),
      () => jsonResponse({ page_index: 2, page_size: 1, total: 2, values: [] }),
    ]);
    expect((await collect(iterateRuns(ctx, {}, { pageSize: 1 }))).map((run) => run.id)).toEqual([
      'r1',
      'r2',
    ]);
    expect(fake.calls).toHaveLength(3);
  });

  it('gets one run, exposing the slug/localized status pair (GOTCHA #5)', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          id: 'r1',
          status: 'pass',
          latest_executed_status: { id: 'rs1', name: '通过' },
          executor: { id: 'u1', display_name: '张三' },
          plan: { id: 'p1', status: 'in_progress' },
          is_archived: 0,
        }),
    ]);
    const run = await getRun(ctx, 'r1');
    expect(run.status).toBe('pass');
    expect(run.latest_executed_status?.name).toBe('通过');
    expect(run.executor?.id).toBe('u1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/runs/r1');
  });

  it('patches a run with the mandatory status_id and an always-explicit executor_id', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'r1', status: 'pass' })]);
    await patchRun(ctx, 'r1', {
      status_id: 'rs1',
      executor_id: 'u1',
      remark: 'retested',
      steps: [{ step_id: 's1', status_id: 'rs1', actual_value: 'ok' }],
    });
    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/runs/r1');
    expect(fake.calls[0]?.body).toEqual({
      status_id: 'rs1',
      executor_id: 'u1',
      remark: 'retested',
      steps: [{ step_id: 's1', status_id: 'rs1', actual_value: 'ok' }],
    });
  });

  it('keeps a given executor_id in the body even with nothing else to say', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'r1' })]);
    await patchRun(ctx, 'r1', { status_id: 'rs1', executor_id: 'u1', remark: undefined });
    // `compact` drops undefined keys; it must never drop a field the caller
    // deliberately set, since the command layer's omission of executor_id is a
    // decision it makes explicitly (design §7), not a side effect of encoding.
    expect(fake.calls[0]?.body).toEqual({ status_id: 'rs1', executor_id: 'u1' });
  });

  it('posts a plan-scoped bulk with inserts, updates and deletes ([th#49])', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ inserts: 2, updates: 1, deletes: 1 })]);
    const result = await bulkRuns(ctx, 'lib-1', 'p1', {
      inserts: [{ case_id: 'c1', executor_id: 'u1' }, { case_id: 'c2' }],
      updates: [{ run_id: 'r1', status_id: 'rs1', executor_id: 'u1' }],
      deletes: ['r9'],
    });
    expect(result).toMatchObject({ inserts: 2, updates: 1, deletes: 1 });
    expect(fake.calls[0]?.method).toBe('POST');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe(
      '/v1/testhub/libraries/lib-1/plans/p1/runs/bulk',
    );
    expect(fake.calls[0]?.body).toEqual({
      inserts: [{ case_id: 'c1', executor_id: 'u1' }, { case_id: 'c2' }],
      updates: [{ run_id: 'r1', status_id: 'rs1', executor_id: 'u1' }],
      deletes: ['r9'],
    });
  });

  it('omits absent bulk arrays rather than sending empty ones', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ deletes: 1 })]);
    await bulkRuns(ctx, 'lib-1', 'p1', { deletes: ['r9'], inserts: undefined });
    expect(fake.calls[0]?.body).toEqual({ deletes: ['r9'] });
  });
});

describe('library-scoped configuration lookups', () => {
  const cases: Array<[string, (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>, string]> =
    [
      ['case states', (ctx) => caseStates(ctx, 'lib-1'), '/v1/testhub/case/states'],
      ['case types', (ctx) => caseTypes(ctx, 'lib-1'), '/v1/testhub/case/types'],
      ['run statuses', (ctx) => runStatuses(ctx, 'lib-1'), '/v1/testhub/run/statuses'],
    ];

  for (const [label, call, path] of cases) {
    it(`${label} hit the SINGULAR segment ${path} with ?library_id= (GOTCHA #2)`, async () => {
      const { ctx, fake } = ctxFor([() => envelope([{ id: 'x', name: 'X' }])]);
      await call(ctx);
      const url = new URL(fake.urls()[0] ?? '');
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get('library_id')).toBe('lib-1');
      expect(fake.calls[0]?.method).toBe('GET');
    });
  }

  it('never confuses the singular config views with the plural resources', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: 'x' }])]);
    await caseStates(ctx, 'lib-1');
    const path = new URL(fake.urls()[0] ?? '').pathname;
    expect(path).toBe('/v1/testhub/case/states');
    expect(path).not.toContain('/cases/');
  });

  it('important levels are org-level and send no library_id ([th#40])', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: 'il1', name: 'P0', color: '#f00' }])]);
    const levels = await importantLevels(ctx);
    expect(levels[0]?.name).toBe('P0');
    const url = new URL(fake.urls()[0] ?? '');
    // Underscored, plural, and the only lookup with no library-scoped variant.
    expect(url.pathname).toBe('/v1/testhub/case_important_levels');
    expect(url.searchParams.get('library_id')).toBeNull();
  });

  it('collects every page of a config list', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 100, total: 2, values: [{ id: 'a' }, { id: 'b' }] }),
    ]);
    expect((await caseTypes(ctx, 'lib-1')).map((type) => type.id)).toEqual(['a', 'b']);
  });
});

describe('the api layer neither logs nor sends under --dry-run', () => {
  it('logs nothing beyond transport debug lines', async () => {
    const { ctx } = ctxFor([() => jsonResponse({ id: 'c1' })]);
    await getCase(ctx, 'c1');
    for (const line of ctx.logLines) {
      expect(line).toMatch(/^(→|←)/);
    }
  });

  it('halts every testhub write under --dry-run with zero requests sent', async () => {
    const writes: Array<[string, (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>]> = [
      ['createCase', (ctx) => createCase(ctx, { test_library_id: 'lib-1', title: 't' })],
      ['updateCase', (ctx) => updateCase(ctx, 'c1', { title: 't' })],
      ['patchRun', (ctx) => patchRun(ctx, 'r1', { status_id: 'rs1', executor_id: 'u1' })],
      ['bulkRuns', (ctx) => bulkRuns(ctx, 'lib-1', 'p1', { deletes: ['r9'] })],
    ];

    for (const [label, call] of writes) {
      const { ctx, fake } = ctxFor([() => jsonResponse({})], { dryRun: true });
      const error = await call(ctx).catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(DryRunHalt);
      expect(fake.calls, label).toHaveLength(0);
    }
  });

  it('still runs both searches under --dry-run — they are reads on a POST verb', async () => {
    for (const [label, call] of [
      ['searchCases', (ctx: ReturnType<typeof ctxFor>['ctx']) => searchCases(ctx, {})],
      ['searchRuns', (ctx: ReturnType<typeof ctxFor>['ctx']) => searchRuns(ctx, {})],
    ] as const) {
      const { ctx, fake } = ctxFor(
        [() => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
        { dryRun: true },
      );
      await call(ctx);
      expect(fake.calls, label).toHaveLength(1);
    }
  });
});
