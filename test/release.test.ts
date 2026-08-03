import { describe, expect, it } from 'vitest';
import { parseDeployment, parseReleaseEnvironment } from '../src/api/parse';
import {
  createDeploy,
  createEnvironment,
  getDeploy,
  getEnvironment,
  iterateDeploys,
  iterateEnvironments,
  listDeploys,
  listEnvironments,
  updateDeploy,
  updateEnvironment,
} from '../src/api/release';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { CATALOG, findByMethodPath, missingRequired, OPTIONAL_QUERY_OVERRIDE_KEYS } from '../src/core/catalog';
import { ENDPOINTS } from '../src/core/endpoints';
import { DryRunHalt } from '../src/core/errors';
import { META_KINDS, RESOLVABLE_KINDS, resolveEnvironment, specOf } from '../src/core/metadata';
import { collect } from '../src/core/paginate';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S1d: the 环境 / 部署 API wrappers, the one resolver row they add, and the catalog
 * correction the live API forced.
 *
 * Injected `fetch`, zero network. The assertions worth reading are the three the live
 * smoke (2026-08-04, design D14) changed our mind about:
 *
 *  - **`?name=` on the environment list is optional**, though the vendor docs mark it
 *    required — so the generic layer needed a correction row or
 *    `pingcode api GET /v1/release/environments` would refuse a call the API answers.
 *  - **`?env_id=` is the deploy list's only real filter**; `status`, `release_name` and
 *    `work_item_id` were probed and ignored, so no wrapper parameter exists for them.
 *  - **an environment is resolvable by name and a deploy is not**, which is why exactly
 *    one metadata kind was added rather than none or two.
 *
 * The command layer lives in `test/releaseCommands.test.ts`.
 */

const NOW = 1_700_000_000_000;

/** Live ids from the S1d smoke. */
const ENVIRONMENT = '6a70c08d919cce9794f01ac6';
const DEPLOY = '6a70c153919cce9794f01aca';
const WORK_ITEM = '6a221c5d22cc7d25d68cafdb';

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

const CREATE_DEPLOY = {
  status: 'deployed',
  env_id: ENVIRONMENT,
  release_name: 'cli-smoke 1.0.0',
  start_at: 1785700000,
  end_at: 1785700200,
  duration: 200,
} as const;

describe('release endpoint paths', () => {
  it('addresses both families at the organisation root', () => {
    // A deploy is scoped to an environment by `env_id` **in the body**, never in the
    // path — so there is no `…/environments/{id}/deploys` and `getDeploy` needs no
    // environment id (design D14).
    expect(ENDPOINTS.releaseEnvironments).toBe('/v1/release/environments');
    expect(ENDPOINTS.releaseEnvironment(ENVIRONMENT)).toBe(
      `/v1/release/environments/${ENVIRONMENT}`,
    );
    expect(ENDPOINTS.releaseDeploys).toBe('/v1/release/deploys');
    expect(ENDPOINTS.releaseDeploy(DEPLOY)).toBe(`/v1/release/deploys/${DEPLOY}`);
  });

  it('percent-encodes ids rather than trusting their shape', () => {
    expect(ENDPOINTS.releaseEnvironment('a/b')).toBe('/v1/release/environments/a%2Fb');
    expect(ENDPOINTS.releaseDeploy('c d')).toBe('/v1/release/deploys/c%20d');
  });

  it('matches the catalog: two families, six verbs each, four wrapped each', () => {
    const methods = CATALOG.filter((entry) => entry.module === 'release')
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    expect(methods).toEqual([
      'DELETE /v1/release/deploys/{deploy_id}',
      'DELETE /v1/release/environments/{env_id}',
      'GET /v1/release/deploys',
      'GET /v1/release/deploys/{deploy_id}',
      'GET /v1/release/environments',
      'GET /v1/release/environments/{env_id}',
      'PATCH /v1/release/deploys/{deploy_id}',
      'PATCH /v1/release/environments/{env_id}',
      'POST /v1/release/deploys',
      'POST /v1/release/environments',
      'PUT /v1/release/deploys/{deploy_id}',
      'PUT /v1/release/environments/{env_id}',
    ]);
  });

  it('shares one scope pair across both families, and is enterprise-token-only', () => {
    // There is no `devops:release` scope: environments ride on `devops:deploy` too, so a
    // token that can record a deploy can also create the environment it names.
    const scopes = new Set(
      CATALOG.filter((entry) => entry.module === 'release').flatMap((entry) => entry.scopes),
    );
    expect(scopes).toEqual(new Set(['read:devops:deploy', 'write:devops:deploy']));
    for (const entry of CATALOG.filter((e) => e.module === 'release')) {
      expect(entry.tokenType, entry.id).toBe('ENT');
    }
  });
});

describe('the catalog correction for the environment list (PRD R2: live wins)', () => {
  it('treats ?name= as optional, against the vendor docs', () => {
    // S1d smoke, 2026-08-04: `GET /v1/release/environments` with no query answered 200
    // and returned all four environments of the tenant. The generated entry says
    // `required: true` because 获取环境列表 documents it that way, and `missingRequired`
    // refuses the call **before** sending it — so without this correction the endpoint
    // is unreachable through `pingcode api`, not merely inconvenient.
    const entry = findByMethodPath('GET', '/v1/release/environments');
    expect(entry).toBeDefined();
    expect(entry?.query.map((param) => param.name)).toEqual(['name']);
    expect(entry?.query.every((param) => param.required)).toBe(false);
    expect(missingRequired(entry as NonNullable<typeof entry>, {})).toEqual([]);
  });

  it('has no dead correction row', () => {
    // A resync that moves a path must not leave a silently-inert correction — the same
    // guard `PAGED_OVERRIDE_KEYS` gets in `test/catalog.test.ts`.
    for (const key of OPTIONAL_QUERY_OVERRIDE_KEYS) {
      const [method, pathValue] = key.split(' ');
      const hit = CATALOG.filter((e) => e.method === method && e.path === pathValue);
      expect(hit.length, `override ${key} matches nothing`).toBeGreaterThan(0);
    }
  });

  it('leaves every other endpoint’s required flags alone', () => {
    // The correction is one row wide. `POST /v1/release/deploys` keeps its six required
    // body fields, which the live API does enforce (400 `100008`).
    const create = findByMethodPath('POST', '/v1/release/deploys');
    expect(
      create?.body.filter((param) => param.required).map((param) => param.name).sort(),
    ).toEqual(['duration', 'end_at', 'env_id', 'release_name', 'start_at', 'status']);
  });
});

describe('release normalisation', () => {
  it('keeps an environment to its four fields and preserves unknown ones', () => {
    const environment = parseReleaseEnvironment({
      id: ENVIRONMENT,
      url: 'https://open.pingcode.com/v1/release/environments/x',
      name: 'cli-smoke-prod',
      html_url: null,
      future_field: 'kept',
    });
    expect(environment).toMatchObject({ id: ENVIRONMENT, name: 'cli-smoke-prod' });
    expect(environment.html_url).toBeUndefined();
    expect(environment.future_field).toBe('kept');
  });

  it('parses the deploy’s environment as a reference, not a scalar', () => {
    // Reads return `environment: {id, url, name}`; writes send `env_id`. The two never
    // appear in one payload, the same split as a branch's `sender`/`sender_name`.
    const deploy = parseDeployment({
      id: DEPLOY,
      status: 'deployed',
      release_name: 'cli-smoke 1.0.0',
      environment: { id: ENVIRONMENT, name: 'cli-smoke-staging' },
      start_at: 1785700000,
      end_at: 1785700200,
      duration: 200,
      work_items: [{ id: WORK_ITEM, identifier: 'YYHC-10', type: 'epic' }],
    });

    expect(deploy.environment?.id).toBe(ENVIRONMENT);
    expect(deploy.environment?.name).toBe('cli-smoke-staging');
    expect(deploy.env_id).toBeUndefined();
    expect(deploy.work_items[0]?.identifier).toBe('YYHC-10');
  });

  it('defaults work_items to an array and leaves absent numbers absent', () => {
    const deploy = parseDeployment({ id: DEPLOY });
    expect(deploy.work_items).toEqual([]);
    expect(deploy.duration).toBeUndefined();
  });
});

describe('environments api', () => {
  it('lists environments with the exact-name filter and paging', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: ENVIRONMENT, name: 'cli-smoke-prod' }])]);
    const page = await listEnvironments(ctx, { name: 'cli-smoke-prod' }, { pageIndex: 1, pageSize: 2 });

    const url = fake.urls()[0] ?? '';
    expect(url).toContain('/v1/release/environments?');
    expect(url).toContain('name=cli-smoke-prod');
    expect(url).toContain('page_index=1');
    expect(page.values[0]?.name).toBe('cli-smoke-prod');
  });

  it('sends no name at all when none was given', async () => {
    // The endpoint accepts that (live 2026-08-04) even though the docs call `name`
    // required, and it is what `release env list` does by default.
    const { ctx, fake } = ctxFor([() => envelope([{ id: ENVIRONMENT }])]);
    await listEnvironments(ctx);
    expect(fake.urls()[0] ?? '').not.toContain('name=');
  });

  it('walks every page of environments', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'e1' }], { page_index: 0, page_size: 1 }),
      () => envelope([], { page_index: 1, page_size: 1 }),
    ]);
    const values = await collect(iterateEnvironments(ctx, {}, { pageSize: 1 }));
    expect(values.map((environment) => environment.id)).toEqual(['e1']);
  });

  it('gets one environment', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: ENVIRONMENT })]);
    await getEnvironment(ctx, ENVIRONMENT);
    expect(fake.urls()[0]).toContain(`/v1/release/environments/${ENVIRONMENT}`);
  });

  it('creates an environment from a name alone', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'new' })]);
    await createEnvironment(ctx, { name: 'cli-smoke-prod' });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({ name: 'cli-smoke-prod' });
  });

  it('patches an environment with PATCH, never PUT', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: ENVIRONMENT })]);
    await updateEnvironment(ctx, ENVIRONMENT, { html_url: 'https://example.invalid/prod' });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ html_url: 'https://example.invalid/prod' });
  });
});

describe('deploys api', () => {
  it('filters the deploy list by environment id only', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: DEPLOY }])]);
    await listDeploys(ctx, { env_id: ENVIRONMENT }, { pageSize: 3 });

    const url = fake.urls()[0] ?? '';
    expect(url).toContain('/v1/release/deploys?');
    expect(url).toContain(`env_id=${ENVIRONMENT}`);
    // `status`, `release_name` and `work_item_id` were probed live and silently
    // ignored, so the query type has no field for them to travel in.
    expect(url).not.toContain('status=');
  });

  it('walks every page of deploys', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'd1' }], { page_index: 0, page_size: 1 }),
      () => envelope([{ id: 'd2' }], { page_index: 1, page_size: 1 }),
      () => envelope([], { page_index: 2, page_size: 1 }),
    ]);
    const values = await collect(iterateDeploys(ctx, {}, { pageSize: 1 }));
    expect(values.map((deploy) => deploy.id)).toEqual(['d1', 'd2']);
  });

  it('gets one deploy without naming its environment', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: DEPLOY })]);
    await getDeploy(ctx, DEPLOY);
    expect(fake.urls()[0]).toContain(`/v1/release/deploys/${DEPLOY}`);
    expect(fake.urls()[0]).not.toContain('environments');
  });

  it('creates a deploy with its six required fields and the env as a scalar', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: DEPLOY })]);
    await createDeploy(ctx, { ...CREATE_DEPLOY, work_item_identifiers: ['YYHC-10'] });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({
      ...CREATE_DEPLOY,
      work_item_identifiers: ['YYHC-10'],
    });
  });

  it('patches a deploy, and an empty link array survives compaction', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: DEPLOY })]);
    await updateDeploy(ctx, DEPLOY, { status: 'not_deployed', work_item_identifiers: [] });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({
      status: 'not_deployed',
      work_item_identifiers: [],
    });
  });

  it('sends nothing on a write under --dry-run, while reads still run', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: DEPLOY })], { dryRun: true });
    await expect(createDeploy(ctx, CREATE_DEPLOY)).rejects.toBeInstanceOf(DryRunHalt);
    await expect(
      createEnvironment(ctx, { name: 'cli-smoke-prod' }),
    ).rejects.toBeInstanceOf(DryRunHalt);
    expect(fake.calls).toHaveLength(0);

    await listDeploys(ctx);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('release not-found mapping (exit 5, from HTTP 400)', () => {
  // S1d smoke, 2026-08-04: `100204 'deploy'资源不存在` and `100205 'environment'资源不存在`,
  // both on GET and PATCH, and `100205` also on a **create** whose `env_id` names no
  // environment — where exit 5 is precise rather than incidental, exactly as S1b's
  // `100201` is on `POST …/refs`.
  async function failing(
    code: string,
    message: string,
    call: (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>,
  ) {
    const { ctx } = ctxFor([() => jsonResponse({ code, message }, { status: 400 })]);
    return await call(ctx).catch((error: unknown) => error);
  }

  it('maps a missing environment on GET, PATCH and a deploy create', async () => {
    for (const call of [
      (ctx: ReturnType<typeof ctxFor>['ctx']) => getEnvironment(ctx, ENVIRONMENT),
      (ctx: ReturnType<typeof ctxFor>['ctx']) =>
        updateEnvironment(ctx, ENVIRONMENT, { name: 'x' }),
      (ctx: ReturnType<typeof ctxFor>['ctx']) => createDeploy(ctx, CREATE_DEPLOY),
    ]) {
      expect(await failing('100205', "'environment'资源不存在", call)).toMatchObject({
        kind: 'not_found',
        exitCode: 5,
        code: '100205',
      });
    }
  });

  it('maps a missing deploy on GET and PATCH alike', async () => {
    for (const call of [
      (ctx: ReturnType<typeof ctxFor>['ctx']) => getDeploy(ctx, DEPLOY),
      (ctx: ReturnType<typeof ctxFor>['ctx']) =>
        updateDeploy(ctx, DEPLOY, { status: 'deployed' }),
    ]) {
      expect(await failing('100204', "'deploy'资源不存在", call)).toMatchObject({
        kind: 'not_found',
        exitCode: 5,
        code: '100204',
      });
    }
  });

  it('leaves the duplicate name and the in-use refusal on exit 7', async () => {
    // `100105` is a uniqueness conflict (judged as `100220`/`100217` were) and `100106`
    // is a business-rule refusal: the environment plainly exists and the server is
    // protecting the deploys that point at it. Calling either "not found" would send an
    // agent hunting for a row it can see.
    expect(
      await failing('100105', "'cli-smoke-prod'环境已经存在", (ctx) =>
        createEnvironment(ctx, { name: 'cli-smoke-prod' }),
      ),
    ).toMatchObject({ kind: 'api', exitCode: 7, code: '100105' });

    expect(
      await failing('100106', "'environment'正在使用，不能被删除", (ctx) =>
        updateEnvironment(ctx, ENVIRONMENT, { name: 'x' }),
      ),
    ).toMatchObject({ kind: 'api', exitCode: 7, code: '100106' });
  });
});

describe('the release-env resolver row (design D4.2)', () => {
  it('adds exactly one kind, and it is resolvable by name', () => {
    const releaseKinds = META_KINDS.filter((kind) => kind.startsWith('release-'));
    expect(releaseKinds).toEqual(['release-env']);
    expect(RESOLVABLE_KINDS).toContain('release-env');
    // …and nothing was added for deploys: a deploy has no name at all (`release_name`
    // is free text and not unique), so there would be nothing to match on.
    expect(META_KINDS.filter((kind) => kind.includes('deploy'))).toEqual([]);
  });

  it('is an unparented bootstrap hop, like a platform or a product', () => {
    const spec = specOf('release-env');
    expect(spec.path).toBe(ENDPOINTS.releaseEnvironments);
    // Environments are organisation-level, so this row has no parent id to be scoped
    // by — which is precisely why it fits the table as it stands, unlike the branch /
    // pull-request kinds S1b and S1c declined for needing two or three parents.
    expect(spec.parent).toBeUndefined();
    expect(spec.parentQuery).toBeUndefined();
    expect(spec.aliases).toBeUndefined();
  });

  it('resolves by name and by id, and reports an unknown one as exit 2', async () => {
    const rows = [
      { id: ENVIRONMENT, name: 'cli-smoke-prod' },
      { id: 'e2', name: 'cli-smoke-staging' },
    ];
    const { ctx } = ctxFor([() => envelope(rows)]);

    expect((await resolveEnvironment(ctx, 'cli-smoke-prod')).id).toBe(ENVIRONMENT);
    // Case-insensitive, like every other lookup in the CLI.
    expect((await resolveEnvironment(ctx, 'CLI-SMOKE-PROD')).id).toBe(ENVIRONMENT);
    expect((await resolveEnvironment(ctx, ENVIRONMENT)).id).toBe(ENVIRONMENT);
    await expect(resolveEnvironment(ctx, 'production')).rejects.toMatchObject({ kind: 'usage' });
  });

  it('loads the whole list rather than filtering server-side', async () => {
    // `?name=` is exact, so it cannot answer "which environments are there" — and a
    // zero-row response would leave a failed lookup with no candidates to print. Same
    // call `scm-platform` makes.
    const { ctx, fake } = ctxFor([() => envelope([{ id: ENVIRONMENT, name: 'cli-smoke-prod' }])]);
    await resolveEnvironment(ctx, 'cli-smoke-prod');
    const url = fake.urls()[0] ?? '';
    expect(url).toContain('/v1/release/environments?');
    expect(url).not.toContain('name=');
  });
});

describe('no PUT reaches the refined layer (design D8.4)', () => {
  it('exposes no replace wrapper for either family', async () => {
    const release = (await import('../src/api/release')) as Record<string, unknown>;
    expect(Object.keys(release).filter((name) => /replace|put/i.test(name))).toEqual([]);
  });

  it('wraps no DELETE either, though upstream has two that work', async () => {
    // Both `DELETE`s exist and were verified live; they are out of scope for this task
    // (PRD, pending the parent's ruling) rather than absent upstream, so the catalog
    // keeps them and `pingcode api DELETE …` reaches them. Asserted in both directions
    // so neither half can drift: no wrapper here, both endpoints there.
    const release = (await import('../src/api/release')) as Record<string, unknown>;
    expect(Object.keys(release).filter((name) => /^delete/.test(name))).toEqual([]);

    const deletes = CATALOG.filter(
      (entry) => entry.module === 'release' && entry.method === 'DELETE',
    ).map((entry) => entry.path);
    expect(deletes.sort()).toEqual([
      '/v1/release/deploys/{deploy_id}',
      '/v1/release/environments/{env_id}',
    ]);
  });

  it('and the catalog still knows both PUTs, so the escape hatch works', () => {
    const puts = CATALOG.filter(
      (entry) => entry.module === 'release' && entry.method === 'PUT',
    ).map((entry) => entry.path);
    expect(puts.sort()).toEqual([
      '/v1/release/deploys/{deploy_id}',
      '/v1/release/environments/{env_id}',
    ]);
  });
});
