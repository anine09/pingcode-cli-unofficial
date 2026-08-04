import { describe, expect, it } from 'vitest';
import {
  bulkCreateSprints,
  bulkCreateVersions,
  createSprint,
  createVersion,
  deleteVersion,
  getSprint,
  getVersion,
  iterateVersions,
  listVersions,
  updateSprint,
  updateVersion,
} from '../src/api/projects';
import { parseProjectVersion, parseSprint } from '../src/api/parse';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { CATALOG } from '../src/core/catalog';
import { ENDPOINTS } from '../src/core/endpoints';
import { DryRunHalt } from '../src/core/errors';
import { META_KINDS, specOf } from '../src/core/metadata';
import { collect } from '../src/core/paginate';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S2a: the 迭代 (sprint) write path and the 发布 (version) family — paths, bodies,
 * normalisation and error mapping.
 *
 * Injected `fetch`, zero network. Every assertion is either a wire fact (method, path,
 * query, body) or a behaviour observed live on 2026-08-04 and recorded in
 * `core/endpoints.ts` / design D15. As in `test/build.test.ts`, the *absences* carry
 * the most weight, because they are what a later contributor would "complete":
 *
 *  - **no `deleteSprint`.** The path has GET and PATCH only, upstream. A helpful-looking
 *    wrapper would 404 forever.
 *  - **no `?stage_id=` on the version list**, because upstream ignores it (D11.2: a dead
 *    filter is worse than none).
 *  - **no client-side bulk cap.** 60 entries were accepted live, so imposing testhub's
 *    50 here would be inventing a limit.
 *  - **no `PUT` wrapper anywhere** — vacuously satisfied, since pjm documents no `PUT`
 *    at all. That is asserted against the catalog rather than by inspecting our exports,
 *    because "we did not add one" and "there is none to add" are different facts.
 *
 * The command layer lives in `test/pjmPlanningCommands.test.ts`.
 */

const NOW = 1_700_000_000_000;

/** Realistic 24-hex shapes, in the shape the S2a smoke produced. */
const PROJECT = '6a1c41781c7734aaad9ec23c';
const SPRINT = '6a712ff4a2f1bc8bb00eba3f';
const VERSION = '6a712f293e127a186f111f51';
const USER = 'f5712155d0e54d0b94ffacb1384217f0';
const STAGE = '68389e8133ee52bc5c2586de';

function ctxFor(responses: Array<() => Response>, options: { dryRun?: boolean } = {}) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
    useCache: false,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { ctx, fake };
}

function envelope(values: unknown[], page = { page_index: 0, page_size: 100 }): Response {
  return jsonResponse({ ...page, total: values.length, values });
}

/** The four fields both creates require. */
const WINDOW = { start_at: 1788192000, end_at: 1790783999 } as const;
const CREATE_SPRINT = { name: '[CLI smoke] s-1', ...WINDOW, assignee_id: USER } as const;
const CREATE_VERSION = { name: '[CLI smoke] v-1', ...WINDOW, assignee_id: USER } as const;

describe('sprint and version endpoint paths', () => {
  it('scopes both families to a project through the path', () => {
    expect(ENDPOINTS.projectSprints(PROJECT)).toBe(`/v1/pjm/projects/${PROJECT}/sprints`);
    expect(ENDPOINTS.projectSprint(PROJECT, SPRINT)).toBe(
      `/v1/pjm/projects/${PROJECT}/sprints/${SPRINT}`,
    );
    expect(ENDPOINTS.projectVersions(PROJECT)).toBe(`/v1/pjm/projects/${PROJECT}/versions`);
    expect(ENDPOINTS.projectVersion(PROJECT, VERSION)).toBe(
      `/v1/pjm/projects/${PROJECT}/versions/${VERSION}`,
    );
  });

  it('puts the two bulk endpoints at the organisation root, not under a project', () => {
    // They take a `project_id` per entry instead, which is what lets one call span
    // projects — and is why they are 企业令牌 only.
    expect(ENDPOINTS.sprintsBulk).toBe('/v1/pjm/sprints/bulk');
    expect(ENDPOINTS.versionsBulk).toBe('/v1/pjm/versions/bulk');
  });

  it('percent-encodes both segments rather than trusting their shape', () => {
    expect(ENDPOINTS.projectSprint('a/b', 'c d')).toBe('/v1/pjm/projects/a%2Fb/sprints/c%20d');
    expect(ENDPOINTS.projectVersion('a/b', 'c d')).toBe('/v1/pjm/projects/a%2Fb/versions/c%20d');
  });

  it('matches the catalog on exactly the ten endpoints S2a owns', () => {
    const owned = new Set([
      'POST /v1/pjm/projects/{project_id}/sprints',
      'GET /v1/pjm/projects/{project_id}/sprints/{sprint_id}',
      'PATCH /v1/pjm/projects/{project_id}/sprints/{sprint_id}',
      'POST /v1/pjm/sprints/bulk',
      'POST /v1/pjm/projects/{project_id}/versions',
      'GET /v1/pjm/projects/{project_id}/versions',
      'GET /v1/pjm/projects/{project_id}/versions/{version_id}',
      'PATCH /v1/pjm/projects/{project_id}/versions/{version_id}',
      'DELETE /v1/pjm/projects/{project_id}/versions/{version_id}',
      'POST /v1/pjm/versions/bulk',
    ]);
    const documented = new Set(
      CATALOG.filter((entry) => owned.has(`${entry.method} ${entry.path}`)).map(
        (entry) => `${entry.method} ${entry.path}`,
      ),
    );
    expect(documented).toEqual(owned);
  });

  it('has no sprint DELETE to wrap, and one version DELETE that exists', () => {
    // [S§3.8.5]: the asymmetry is upstream's, and it is the single most
    // "completion-inviting" gap in the module.
    const verbs = (path: string) =>
      CATALOG.filter((entry) => entry.path === path)
        .map((entry) => entry.method)
        .sort();
    expect(verbs('/v1/pjm/projects/{project_id}/sprints/{sprint_id}')).toEqual(['GET', 'PATCH']);
    expect(verbs('/v1/pjm/projects/{project_id}/versions/{version_id}')).toEqual([
      'DELETE',
      'GET',
      'PATCH',
    ]);
  });

  it('declares the sprint and release scope pairs, and no scope on the two bulks', () => {
    const scopesOf = (id: string) => CATALOG.find((entry) => entry.id === id)?.scopes ?? null;
    expect(scopesOf('pjm.projects.sprints.create')).toEqual(['write:pjm:sprint']);
    expect(scopesOf('pjm.projects.sprints.get')).toEqual(['read:pjm:sprint']);
    expect(scopesOf('pjm.projects.versions.list')).toEqual(['read:pjm:release']);
    expect(scopesOf('pjm.projects.versions.delete')).toEqual(['write:pjm:release']);

    // The two ENT-only, scope-less endpoints — the only ones like that outside
    // DevOps/CES ([S§7]A). `api describe` and both `bulk --help` texts say so.
    for (const id of ['pjm.sprints.bulk', 'pjm.versions.bulk']) {
      const entry = CATALOG.find((candidate) => candidate.id === id);
      expect(entry?.tokenType, id).toBe('ENT');
      expect(entry?.scopes, id).toEqual([]);
    }
  });

  it('is reachable with an enterprise token everywhere else too', () => {
    for (const id of [
      'pjm.projects.sprints.create',
      'pjm.projects.sprints.update',
      'pjm.projects.versions.create',
      'pjm.projects.versions.delete',
    ]) {
      expect(CATALOG.find((entry) => entry.id === id)?.tokenType, id).toBe('APP');
    }
  });
});

describe('sprint normalisation', () => {
  it('keeps the derived totals, defaults categories and preserves unknown fields', () => {
    const sprint = parseSprint({
      id: SPRINT,
      name: '[CLI smoke] s-1',
      status: 'pending',
      start_at: 1788192000,
      end_at: 1790783999,
      description: null,
      started_at: null,
      completed_at: null,
      total_story_points: 0,
      completed_story_points: 0,
      started_story_points: 0,
      assignee: { id: USER, name: 'someone' },
      future_field: 'kept',
    });

    expect(sprint).toMatchObject({ id: SPRINT, status: 'pending', total_story_points: 0 });
    expect(sprint.assignee?.id).toBe(USER);
    expect(sprint.description).toBeUndefined();
    expect(sprint.future_field).toBe('kept');
    // Never `undefined`: the table renderer joins these without a null check.
    expect(sprint.categories).toEqual([]);
  });

  it('does not invent a started_at for a sprint the API only marked in_progress', () => {
    // Live 2026-08-04: patching `status` to `in_progress` (and then to `completed`) left
    // both lifecycle timestamps `null`. Reporting one would claim a sprint was started.
    const sprint = parseSprint({ id: SPRINT, status: 'in_progress' });
    expect(sprint.started_at).toBeUndefined();
    expect(sprint.completed_at).toBeUndefined();
  });
});

describe('version normalisation', () => {
  it('parses the stage timeline as its own shape, keeping each arrival time', () => {
    // `parseRefList` would drop `operate_at` from the typed view, and that field is the
    // only record of when the release reached a stage.
    const version = parseProjectVersion({
      id: VERSION,
      name: '[CLI smoke] v-1',
      progress: 0,
      changelog: null,
      operate_at: 1788192000,
      stage: { id: STAGE, name: '未开始', type: 'pending' },
      stages: [
        { id: STAGE, name: '未开始', operate_at: 1788192000 },
        { id: 'stage-2', name: '进行中', operate_at: null },
      ],
      categories: [{ id: 'cat-1', name: '普通发布' }],
    });

    expect(version.stage?.name).toBe('未开始');
    expect(version.stages).toHaveLength(2);
    expect(version.stages[0]?.operate_at).toBe(1788192000);
    expect(version.stages[1]?.operate_at).toBeUndefined();
    expect(version.categories[0]?.name).toBe('普通发布');
    expect(version.changelog).toBeUndefined();
  });

  it('defaults both arrays, so a bare version still renders', () => {
    const version = parseProjectVersion({ id: VERSION });
    expect(version.stages).toEqual([]);
    expect(version.categories).toEqual([]);
  });

  it('survives a stages field that is not an array', () => {
    // Defensive rather than observed: the parse layer must never throw on wire drift.
    const version = parseProjectVersion({ id: VERSION, stages: 'unexpected' });
    expect(version.stages).toEqual([]);
  });
});

describe('sprint api', () => {
  it('gets one sprint under its project', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: SPRINT })]);
    await getSprint(ctx, PROJECT, SPRINT);
    expect(fake.calls[0]?.method).toBe('GET');
    expect(fake.urls()[0]).toContain(`/v1/pjm/projects/${PROJECT}/sprints/${SPRINT}`);
  });

  it('creates a sprint with the four required fields and drops the rest', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: SPRINT })]);
    await createSprint(ctx, PROJECT, { ...CREATE_SPRINT, description: undefined });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.urls()[0]).toContain(`/v1/pjm/projects/${PROJECT}/sprints`);
    expect(fake.calls[0]?.body).toEqual({
      name: '[CLI smoke] s-1',
      start_at: 1788192000,
      end_at: 1790783999,
      assignee_id: USER,
    });
  });

  it('sends both window ends in one patch, which this API accepts', async () => {
    // The contrast worth pinning: `release deploy` validates a new `start_at` against
    // the **stored** `end_at`, so its window can only move end-first (design D14.6).
    // Here both travel together and are checked against each other (400 `100042`).
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: SPRINT })]);
    await updateSprint(ctx, PROJECT, SPRINT, { start_at: 1793376000, end_at: 1796054399 });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ start_at: 1793376000, end_at: 1796054399 });
  });

  it('sends an empty category list verbatim, because [] clears the set', async () => {
    // `compact` must not treat `[]` as "nothing to say": it is how a caller detaches
    // every 迭代类别.
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: SPRINT })]);
    await updateSprint(ctx, PROJECT, SPRINT, { category_ids: [] });
    expect(fake.calls[0]?.body).toEqual({ category_ids: [] });
  });

  it('exposes no delete wrapper, because the endpoint does not exist', async () => {
    const api = (await import('../src/api/projects')) as Record<string, unknown>;
    expect(Object.keys(api).filter((name) => /deleteSprint|removeSprint/i.test(name))).toEqual([]);
    expect(api.deleteVersion).toBeTypeOf('function');
  });
});

describe('sprint bulk api', () => {
  it('wraps the entries in a `sprints` array and keeps each project_id', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse([
          { state: 'success', sprint: { id: 's1', name: 'a' } },
          { state: 'success', sprint: { id: 's2', name: 'b' } },
        ]),
    ]);

    const results = await bulkCreateSprints(ctx, [
      { ...CREATE_SPRINT, name: 'a', project_id: PROJECT },
      { ...CREATE_SPRINT, name: 'b', project_id: 'another-project' },
    ]);

    expect(fake.urls()[0]).toContain('/v1/pjm/sprints/bulk');
    expect(fake.calls[0]?.body).toEqual({
      sprints: [
        { name: 'a', start_at: 1788192000, end_at: 1790783999, assignee_id: USER, project_id: PROJECT },
        {
          name: 'b',
          start_at: 1788192000,
          end_at: 1790783999,
          assignee_id: USER,
          project_id: 'another-project',
        },
      ],
    });
    expect(results.map((result) => result.resource?.id)).toEqual(['s1', 's2']);
    expect(results.every((result) => result.state === 'success')).toBe(true);
  });

  it('reads a bare array, not an envelope — the only response shaped that way', async () => {
    const { ctx } = ctxFor([() => jsonResponse([{ state: 'success', sprint: { id: 's1' } }])]);
    const results = await bulkCreateSprints(ctx, [{ ...CREATE_SPRINT, project_id: PROJECT }]);
    expect(results).toHaveLength(1);
  });

  it('reads zero entries rather than throwing if the shape ever changes', async () => {
    // The resources would have been created either way; a parse failure would report a
    // successful write as a client error.
    const { ctx } = ctxFor([() => jsonResponse({ total: 1, values: [] })]);
    expect(await bulkCreateSprints(ctx, [{ ...CREATE_SPRINT, project_id: PROJECT }])).toEqual([]);
  });

  it('tolerates an entry with no resource attached', async () => {
    const { ctx } = ctxFor([() => jsonResponse([{ state: 'success' }])]);
    const results = await bulkCreateSprints(ctx, [{ ...CREATE_SPRINT, project_id: PROJECT }]);
    expect(results[0]?.resource).toBeUndefined();
    expect(results[0]?.state).toBe('success');
  });

  it('imposes no client-side cap, because upstream accepted sixty in one call', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse([])]);
    const entries = Array.from({ length: 60 }, (_, index) => ({
      ...CREATE_SPRINT,
      name: `s-${index}`,
      project_id: PROJECT,
    }));
    await bulkCreateSprints(ctx, entries);

    const body = fake.calls[0]?.body as { sprints: unknown[] };
    expect(body.sprints).toHaveLength(60);
  });
});

describe('version api', () => {
  it('lists versions with paging and the two filters upstream honours', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: VERSION, name: 'v-1' }])]);
    await listVersions(
      ctx,
      PROJECT,
      { name: 'probe', status: 'in_progress' },
      { pageIndex: 1, pageSize: 2 },
    );

    const url = fake.urls()[0] ?? '';
    expect(url).toContain(`/v1/pjm/projects/${PROJECT}/versions?`);
    expect(url).toContain('name=probe');
    expect(url).toContain('status=in_progress');
    expect(url).toContain('page_index=1');
    expect(url).toContain('page_size=2');
  });

  it('forwards exactly the four documented filters and nothing else', async () => {
    // `?stage_id=`, `?assignee_id=` and `?keywords=` were each probed live on
    // 2026-08-04 and silently ignored, so `VersionListQuery` has no slot for them —
    // the type is the enforcement, and this asserts the other half: nothing is added
    // to the query beyond what the caller passed and the paging the walker needs.
    const { ctx, fake } = ctxFor([() => envelope([])]);
    await listVersions(ctx, PROJECT, { created_between: '1,2', updated_between: '3,4' });

    const url = new URL(fake.urls()[0] ?? '', 'https://example.test');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'created_between',
      'page_index',
      'page_size',
      'updated_between',
    ]);
  });

  it('walks every page of versions', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'v1' }], { page_index: 0, page_size: 1 }),
      () => envelope([{ id: 'v2' }], { page_index: 1, page_size: 1 }),
      () => envelope([], { page_index: 2, page_size: 1 }),
    ]);
    const values = await collect(iterateVersions(ctx, PROJECT, {}, { pageSize: 1 }));
    expect(values.map((version) => version.id)).toEqual(['v1', 'v2']);
  });

  it('gets one version', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: VERSION })]);
    await getVersion(ctx, PROJECT, VERSION);
    expect(fake.urls()[0]).toContain(`/v1/pjm/projects/${PROJECT}/versions/${VERSION}`);
  });

  it('creates a version without a stage, which upstream defaults', async () => {
    // The docs mark `stage_id` required on the bulk twin; live, both creates default it
    // to the first configured stage (未开始).
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: VERSION })]);
    await createVersion(ctx, PROJECT, CREATE_VERSION);
    expect(fake.calls[0]?.body).toEqual({
      name: '[CLI smoke] v-1',
      start_at: 1788192000,
      end_at: 1790783999,
      assignee_id: USER,
    });
  });

  it('sends stage_id and operate_at together when both are given', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: VERSION })]);
    await updateVersion(ctx, PROJECT, VERSION, { stage_id: STAGE, operate_at: 1789000000 });
    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ stage_id: STAGE, operate_at: 1789000000 });
  });

  it('deletes a version and returns the deleted record', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: VERSION, name: 'gone' })]);
    const deleted = await deleteVersion(ctx, PROJECT, VERSION);
    expect(fake.calls[0]?.method).toBe('DELETE');
    expect(deleted.name).toBe('gone');
  });

  it('wraps bulk versions in a `versions` array', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse([{ state: 'success', version: { id: 'v1' } }]),
    ]);
    const results = await bulkCreateVersions(ctx, [
      { ...CREATE_VERSION, project_id: PROJECT, stage_id: STAGE },
    ]);

    expect(fake.urls()[0]).toContain('/v1/pjm/versions/bulk');
    expect(fake.calls[0]?.body).toEqual({
      versions: [
        {
          name: '[CLI smoke] v-1',
          start_at: 1788192000,
          end_at: 1790783999,
          assignee_id: USER,
          project_id: PROJECT,
          stage_id: STAGE,
        },
      ],
    });
    expect(results[0]?.resource?.id).toBe('v1');
  });
});

describe('dry-run gate', () => {
  it('blocks every write and lets the reads through', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: VERSION })], { dryRun: true });

    await expect(createSprint(ctx, PROJECT, CREATE_SPRINT)).rejects.toBeInstanceOf(DryRunHalt);
    await expect(updateSprint(ctx, PROJECT, SPRINT, { name: 'x' })).rejects.toBeInstanceOf(
      DryRunHalt,
    );
    await expect(bulkCreateSprints(ctx, [])).rejects.toBeInstanceOf(DryRunHalt);
    await expect(createVersion(ctx, PROJECT, CREATE_VERSION)).rejects.toBeInstanceOf(DryRunHalt);
    await expect(updateVersion(ctx, PROJECT, VERSION, { name: 'x' })).rejects.toBeInstanceOf(
      DryRunHalt,
    );
    await expect(deleteVersion(ctx, PROJECT, VERSION)).rejects.toBeInstanceOf(DryRunHalt);
    await expect(bulkCreateVersions(ctx, [])).rejects.toBeInstanceOf(DryRunHalt);
    expect(fake.calls).toHaveLength(0);

    await getVersion(ctx, PROJECT, VERSION);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('planning not-found mapping (exit 5, from HTTP 400)', () => {
  // S2a smoke, 2026-08-04. `100308 'Iteration'资源不存在` on GET and PATCH — all the
  // verbs the sprint path has — and `100304 'version'资源不存在` on GET, PATCH and
  // DELETE, each with a syntactically valid but nonexistent 24-hex id.
  async function failing(
    code: string,
    message: string,
    call: (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>,
  ) {
    const { ctx } = ctxFor([() => jsonResponse({ code, message }, { status: 400 })]);
    return await call(ctx).catch((error: unknown) => error);
  }

  it('maps a missing sprint on both verbs that can name one', async () => {
    for (const call of [
      (ctx: ReturnType<typeof ctxFor>['ctx']) => getSprint(ctx, PROJECT, SPRINT),
      (ctx: ReturnType<typeof ctxFor>['ctx']) =>
        updateSprint(ctx, PROJECT, SPRINT, { name: 'renamed' }),
    ]) {
      expect(await failing('100308', "'Iteration'资源不存在", call)).toMatchObject({
        kind: 'not_found',
        exitCode: 5,
        code: '100308',
      });
    }
  });

  it('maps a missing version on all three of its verbs', async () => {
    for (const call of [
      (ctx: ReturnType<typeof ctxFor>['ctx']) => getVersion(ctx, PROJECT, VERSION),
      (ctx: ReturnType<typeof ctxFor>['ctx']) =>
        updateVersion(ctx, PROJECT, VERSION, { name: 'renamed' }),
      (ctx: ReturnType<typeof ctxFor>['ctx']) => deleteVersion(ctx, PROJECT, VERSION),
    ]) {
      expect(await failing('100304', "'version'资源不存在", call)).toMatchObject({
        kind: 'not_found',
        exitCode: 5,
        code: '100304',
      });
    }
  });

  it('leaves a missing PROJECT on exit 7, because kanban answers the same code', async () => {
    // The one row S2a deliberately did not add. `POST …/{a kanban project}/sprints`
    // answers `100300 'project'资源不存在` for a project that plainly exists and is
    // listed by `project list` — so exit 5 would send an agent hunting for a row it can
    // see. Same judgement as ship's `100719` and scm's `100223`.
    expect(
      await failing('100300', "'project'资源不存在", (ctx) =>
        createSprint(ctx, PROJECT, CREATE_SPRINT),
      ),
    ).toMatchObject({ kind: 'api', exitCode: 7, code: '100300' });
  });

  it('leaves the pairing, uniqueness, bulk and validation rejections on exit 7', async () => {
    for (const [code, message] of [
      // Both records exist; only the (project, child) pair is wrong.
      ['100309', "'project'不匹配"],
      ['1003107', '发布与项目不匹配'],
      // Uniqueness conflicts on the name.
      ['100343', "'Iteration'已经存在"],
      ['100337', "'version'已经存在"],
      // Whole-batch rejections: exit 5 would name one entry and imply the rest landed.
      ['100390', "'sprint.1''sprint'资源名称已存在"],
      ['100001', 'versions[1]:version named x had existed'],
      // Cross-field and input validation.
      ['100042', '开始时间必须小于结束时间'],
      ['100395', "输入的'operate_at'必须在开始和发布时间之间"],
      ['100003', "'status'不是有效的字符串(不是有效的枚举值)"],
      ['100039', 'versions[1].name 是必填字段'],
    ] as const) {
      expect(
        await failing(code, message, (ctx) => updateVersion(ctx, PROJECT, VERSION, { name: 'x' })),
        code,
      ).toMatchObject({ kind: 'api', exitCode: 7, code });
    }
  });

  it('keeps the bulk 500 a server fault', async () => {
    // Two entries sharing a name inside one batch is HTTP 500 `100000`, and nothing is
    // created. A 500 must stay a 500.
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100000', message: '内部服务错误' }, { status: 500 }),
    ]);
    const error = await bulkCreateVersions(ctx, [
      { ...CREATE_VERSION, project_id: PROJECT },
    ]).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'api', exitCode: 7, code: '100000' });
  });
});

describe('the one resolver row S2a adds', () => {
  it('registers pjm-version, project-scoped through the path', () => {
    expect(META_KINDS).toContain('pjm-version');
    const spec = specOf('pjm-version');
    expect(spec.parent).toBe('project');
    // The project id rides in the path, exactly like `sprint` — so there is no
    // `parentQuery` and no engine change.
    expect(spec.parentQuery).toBeUndefined();
    expect(typeof spec.path).toBe('function');
  });

  it('loads the whole list instead of using ?name=, which is a substring match', () => {
    // `inputQuery` would hand the server a fragment and get several candidates back for
    // one typo — the opposite of what a resolver needs. It also could not answer "which
    // releases are there", so a failed lookup would print no candidates.
    expect(specOf('pjm-version').inputQuery).toBeUndefined();
    expect(specOf('sprint').inputQuery).toBeUndefined();
  });

  it('adds no kind for stages or categories, which stay generic-layer reads', () => {
    // Both are out of S2a's ten endpoints, so there is nothing to resolve against:
    // `--stage-id` and `--category-id` take ids and say where to find them.
    expect(META_KINDS.filter((kind) => /stage|categor/i.test(kind))).toEqual([]);
  });
});

describe('no PUT reaches the refined layer (vacuously, for pjm)', () => {
  it('is satisfied because pjm documents no PUT at all', () => {
    // Design D8.4 forbids a refined leaf for any `PUT`. Every other module had to
    // *decline* one; pjm has none to decline, and asserting that is cheaper and more
    // honest than asserting the absence of leaves nobody could have written.
    const puts = CATALOG.filter((entry) => entry.module === 'pjm' && entry.method === 'PUT');
    expect(puts).toEqual([]);
  });
});
