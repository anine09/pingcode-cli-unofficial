import { describe, expect, it } from 'vitest';
import { parseScmPlatform, parseScmPlatformUser, parseScmRepository } from '../src/api/parse';
import {
  createPlatform,
  createPlatformUser,
  createRepository,
  getPlatform,
  getPlatformUser,
  getRepository,
  iteratePlatforms,
  iterateRepositories,
  listPlatformUsers,
  listPlatforms,
  listRepositories,
  updatePlatform,
  updatePlatformUser,
  updateRepository,
} from '../src/api/scm';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { CATALOG } from '../src/core/catalog';
import { ENDPOINTS } from '../src/core/endpoints';
import { DryRunHalt } from '../src/core/errors';
import { collect } from '../src/core/paginate';
import { META_KINDS, RESOLVABLE_KINDS, resolvePlatform, resolveRepository, specOf } from '../src/core/metadata';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S1a: the scm API wrappers, the two resolver rows and the endpoint paths.
 *
 * Injected `fetch`, zero network. Every assertion is either a wire fact (method,
 * path, query, body) or a live-observed behaviour recorded in the endpoint comments:
 * the platform/repository/user paths, `?name=` being exact rather than fuzzy,
 * `?name=` being *absent* from the repository list because upstream ignores it, and
 * the `full_name` alias that makes a colliding repository name resolvable.
 *
 * The one assertion here that is not about scm at all is the last one: no `PUT`
 * wrapper exists in `api/scm.ts`, because design D8.4 keeps every `PUT` in the
 * generic layer. It lives with the wrappers rather than with the help suite so that
 * "add the missing verb" fails at the layer where someone would actually add it.
 */

const NOW = 1_700_000_000_000;

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const REPO = '685d393c47512a5d5d52aa70';
const USER = '685c6ca42974f854bb4979ac';

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

describe('scm endpoint paths', () => {
  it('addresses every resource under its hosting platform', () => {
    expect(ENDPOINTS.scmPlatforms).toBe('/v1/scm/products');
    expect(ENDPOINTS.scmPlatform(PLATFORM)).toBe(`/v1/scm/products/${PLATFORM}`);
    expect(ENDPOINTS.scmPlatformUsers(PLATFORM)).toBe(`/v1/scm/products/${PLATFORM}/users`);
    expect(ENDPOINTS.scmPlatformUser(PLATFORM, USER)).toBe(
      `/v1/scm/products/${PLATFORM}/users/${USER}`,
    );
    expect(ENDPOINTS.scmRepositories(PLATFORM)).toBe(`/v1/scm/products/${PLATFORM}/repositories`);
    expect(ENDPOINTS.scmRepository(PLATFORM, REPO)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}`,
    );
  });

  it('percent-encodes ids rather than trusting their shape', () => {
    // Ids are never validated (research §6.8), so a pasted value with a slash must
    // not be able to walk out of its path segment.
    expect(ENDPOINTS.scmRepository('a/b', 'c d')).toBe(
      '/v1/scm/products/a%2Fb/repositories/c%20d',
    );
  });

  it('matches the catalog, so the refined and generic layers agree on the paths', () => {
    // The catalog is generated from the vendor docs; a typo in a hand-written path
    // would otherwise only show up live.
    const scmPaths = new Set(
      CATALOG.filter((entry) => entry.module === 'scm').map((entry) => entry.path),
    );
    for (const path of [
      '/v1/scm/products',
      '/v1/scm/products/{product_id}',
      '/v1/scm/products/{product_id}/users',
      '/v1/scm/products/{product_id}/users/{user_id}',
      '/v1/scm/products/{product_id}/repositories',
      '/v1/scm/products/{product_id}/repositories/{repository_id}',
    ]) {
      expect(scmPaths, path).toContain(path);
    }
  });
});

describe('scm normalisation', () => {
  it('keeps a platform to its five flat fields and preserves unknown ones', () => {
    const platform = parseScmPlatform({
      id: PLATFORM,
      url: 'https://open.pingcode.com/v1/scm/products/x',
      name: 'Github',
      type: 'github',
      description: null,
      future_field: 'kept',
    });
    expect(platform).toMatchObject({ id: PLATFORM, name: 'Github', type: 'github' });
    // `null` is normalised away by the shared parse layer (design §14.5).
    expect(platform.description).toBeUndefined();
    expect(platform.future_field).toBe('kept');
  });

  it('parses a platform user without inventing a PingCode member reference', () => {
    // Live 2026-08-03: the resource has no `user`/`user_id`/`email`. Attribution is
    // by the `name` string, so nothing here may synthesise a member link.
    const user = parseScmPlatformUser({
      id: USER,
      product: { id: PLATFORM, name: 'Github', type: 'github' },
      name: 'anine09',
      display_name: null,
      html_url: 'https://github.com/anine09',
      avatar_url: null,
    });
    expect(user).toMatchObject({ id: USER, name: 'anine09' });
    expect(user.product?.id).toBe(PLATFORM);
    expect(user.display_name).toBeUndefined();
    expect(user.user).toBeUndefined();
    expect(user.user_id).toBeUndefined();
  });

  it('normalises is_fork / is_private from booleans and from 0/1', () => {
    // The wire sends real booleans today, but the docs type them `Boolean` while
    // every other flag in this API arrives as 0/1 (research §6.10).
    expect(parseScmRepository({ id: REPO, is_fork: true, is_private: false })).toMatchObject({
      is_fork: true,
      is_private: false,
    });
    expect(parseScmRepository({ id: REPO, is_fork: 1, is_private: 0 })).toMatchObject({
      is_fork: true,
      is_private: false,
    });
    // Absent means false, never undefined: call sites render a yes/no cell.
    expect(parseScmRepository({ id: REPO }).is_fork).toBe(false);
  });

  it('keeps the owner as a reference and the url templates verbatim', () => {
    const repo = parseScmRepository({
      id: REPO,
      name: 'code-interpreter',
      full_name: 'acme/code-interpreter',
      owner: { id: USER, name: 'acme' },
      commits_url: 'https://github.com/acme/code-interpreter/commit/{sha}',
      created_at: 1750939964,
    });
    expect(repo.owner?.id).toBe(USER);
    expect(repo.commits_url).toBe('https://github.com/acme/code-interpreter/commit/{sha}');
    // Timestamps stay raw unix seconds through core and api.
    expect(repo.created_at).toBe(1750939964);
  });
});

describe('hosting platforms api', () => {
  it('lists platforms with the exact-name filter and paging', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: PLATFORM, name: 'Github' }])]);
    const page = await listPlatforms(ctx, { name: 'Github' }, { pageIndex: 1, pageSize: 2 });

    expect(fake.calls[0]?.method).toBe('GET');
    expect(fake.urls()[0]).toContain('/v1/scm/products?');
    expect(fake.urls()[0]).toContain('name=Github');
    expect(fake.urls()[0]).toContain('page_index=1');
    expect(fake.urls()[0]).toContain('page_size=2');
    expect(page.values[0]?.name).toBe('Github');
  });

  it('walks every page of platforms', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'p1', name: 'one' }], { page_index: 0, page_size: 1 }),
      () => envelope([], { page_index: 1, page_size: 1 }),
    ]);
    const values = await collect(iteratePlatforms(ctx, {}, { pageSize: 1 }));
    expect(values.map((platform) => platform.id)).toEqual(['p1']);
  });

  it('gets one platform', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PLATFORM, name: 'Github' })]);
    await getPlatform(ctx, PLATFORM);
    expect(fake.urls()[0]).toContain(`/v1/scm/products/${PLATFORM}`);
  });

  it('creates a platform and sends only the fields it was given', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'new', name: 'Gitea' })]);
    await createPlatform(ctx, { name: 'Gitea', type: 'other' });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.urls()[0]).toContain('/v1/scm/products');
    expect(fake.calls[0]?.body).toEqual({ name: 'Gitea', type: 'other' });
  });

  it('patches a platform with PATCH, never PUT', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PLATFORM })]);
    await updatePlatform(ctx, PLATFORM, { description: 'moved' });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ description: 'moved' });
  });

  it('sends nothing on a write under --dry-run, while reads still run', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PLATFORM })], { dryRun: true });
    await expect(createPlatform(ctx, { name: 'Gitea', type: 'other' })).rejects.toBeInstanceOf(
      DryRunHalt,
    );
    expect(fake.calls).toHaveLength(0);

    await getPlatform(ctx, PLATFORM);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('platform users api', () => {
  it('lists the git identities of one platform', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: USER, name: 'anine09' }])]);
    await listPlatformUsers(ctx, PLATFORM, { name: 'anine09' }, { pageSize: 30 });

    expect(fake.urls()[0]).toContain(`/v1/scm/products/${PLATFORM}/users?`);
    expect(fake.urls()[0]).toContain('name=anine09');
  });

  it('gets one identity by id', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: USER, name: 'anine09' })]);
    await getPlatformUser(ctx, PLATFORM, USER);
    expect(fake.urls()[0]).toContain(`/v1/scm/products/${PLATFORM}/users/${USER}`);
  });

  it('creates an identity from a git username and nothing else', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'u-new', name: 'bot' })]);
    await createPlatformUser(ctx, PLATFORM, { name: 'bot', display_name: 'Bot' });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({ name: 'bot', display_name: 'Bot' });
  });

  it('patches an identity', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: USER })]);
    await updatePlatformUser(ctx, PLATFORM, USER, { avatar_url: 'https://example.invalid/a.png' });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.urls()[0]).toContain(`/users/${USER}`);
    expect(fake.calls[0]?.body).toEqual({ avatar_url: 'https://example.invalid/a.png' });
  });
});

describe('repositories api', () => {
  it('lists repositories, filtering only by full_name', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: REPO, full_name: 'acme/cli' }])]);
    await listRepositories(ctx, PLATFORM, { full_name: 'acme/cli' }, { pageSize: 3 });

    const url = fake.urls()[0] ?? '';
    expect(url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(url).toContain('full_name=acme%2Fcli');
    // Upstream ignores `?name=` (live 2026-08-03), so the wrapper offers no way to
    // send it — a filter that silently does nothing is worse than no filter.
    expect(url).not.toContain('name=cli');
  });

  it('walks every page of repositories', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'r1' }], { page_index: 0, page_size: 1 }),
      () => envelope([{ id: 'r2' }], { page_index: 1, page_size: 1 }),
      () => envelope([], { page_index: 2, page_size: 1 }),
    ]);
    const values = await collect(iterateRepositories(ctx, PLATFORM, {}, { pageSize: 1 }));
    expect(values.map((repo) => repo.id)).toEqual(['r1', 'r2']);
  });

  it('gets one repository', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: REPO })]);
    await getRepository(ctx, PLATFORM, REPO);
    expect(fake.urls()[0]).toContain(`/repositories/${REPO}`);
  });

  it('creates a repository, keeping url templates and booleans as sent', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'r-new' })]);
    await createRepository(ctx, PLATFORM, {
      name: 'cli',
      full_name: 'acme/cli',
      owner_name: 'acme',
      is_private: false,
      commits_url: 'https://github.com/acme/cli/commit/{sha}',
    });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({
      name: 'cli',
      full_name: 'acme/cli',
      owner_name: 'acme',
      // `false` must survive: `compact` drops only `undefined`, so a repository can
      // be made public rather than silently left private.
      is_private: false,
      commits_url: 'https://github.com/acme/cli/commit/{sha}',
    });
  });

  it('patches a repository', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: REPO })]);
    await updateRepository(ctx, PLATFORM, REPO, { is_private: false });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ is_private: false });
  });
});

describe('the scm resolver rows (design D4.2)', () => {
  it('registers exactly two kinds, and both are resolvable by name', () => {
    const scmKinds = META_KINDS.filter((kind) => kind.startsWith('scm-'));
    expect(scmKinds).toEqual(['scm-platform', 'scm-repo']);
    for (const kind of scmKinds) expect(RESOLVABLE_KINDS).toContain(kind);
  });

  it('makes the platform the unparented bootstrap hop', () => {
    const spec = specOf('scm-platform');
    expect(spec.path).toBe(ENDPOINTS.scmPlatforms);
    // Nothing in scm is addressable without a platform id, so this row cannot be
    // scoped by one — exactly like `ship-product` and `testhub-library`.
    expect(spec.parent).toBeUndefined();
    expect(spec.parentQuery).toBeUndefined();
  });

  it('scopes repositories by their platform, with the id in the path', () => {
    const spec = specOf('scm-repo');
    expect(spec.parent).toBe('scm-platform');
    // A function `path` means the parent id goes in the URL, so there is no query.
    expect(typeof spec.path).toBe('function');
    expect(spec.parentQuery).toBeUndefined();
    expect(spec.aliases).toEqual(['full_name']);
  });

  it('resolves a platform by name, by id and reports an unknown one as exit 2', async () => {
    const rows = [
      { id: PLATFORM, name: 'Github' },
      { id: 'p2', name: 'GitHub Enterprise' },
    ];
    const { ctx } = ctxFor([() => envelope(rows)]);

    expect((await resolvePlatform(ctx, 'github')).id).toBe(PLATFORM);
    expect((await resolvePlatform(ctx, PLATFORM)).id).toBe(PLATFORM);
    await expect(resolvePlatform(ctx, 'gitlab')).rejects.toMatchObject({ kind: 'usage' });
  });

  it('resolves a repository by name or full_name, and refuses a colliding name', async () => {
    // Live 2026-08-03: two repositories in one platform may share a `name`; the
    // `full_name` is the unique key and the way out of the ambiguity.
    const rows = [
      { id: 'r1', name: 'cli', full_name: 'acme/cli' },
      { id: 'r2', name: 'cli', full_name: 'fork/cli' },
      { id: 'r3', name: 'docs', full_name: 'acme/docs' },
    ];
    const { ctx } = ctxFor([() => envelope(rows)]);

    expect((await resolveRepository(ctx, PLATFORM, 'docs')).id).toBe('r3');
    expect((await resolveRepository(ctx, PLATFORM, 'fork/cli')).id).toBe('r2');
    await expect(resolveRepository(ctx, PLATFORM, 'cli')).rejects.toMatchObject({
      kind: 'usage',
      message: expect.stringContaining('r1'),
    });
  });

  it('loads the repository list under the platform, without a name filter', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: 'r1', name: 'cli' }])]);
    await resolveRepository(ctx, PLATFORM, 'cli');
    const url = fake.urls()[0] ?? '';
    expect(url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(url).not.toContain('name=');
  });
});

/**
 * The three not-found overrides, asserted where a caller meets them.
 *
 * `core/wire.ts` maps a vendor `code` before it looks at the HTTP status, because
 * this API answers **400** for a missing row. The table itself is pinned in
 * `test/http.test.ts`; what matters here is that a wrapper call really does surface
 * exit 5, including on the `PATCH` paths where the same codes were observed live
 * (2026-08-03) — that is the half a table assertion cannot prove.
 */
describe('scm not-found mapping (exit 5, from HTTP 400)', () => {
  /** One 400 + vendor code, then whatever call the caller would have made. */
  async function failing(code: string, message: string, call: (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>) {
    const { ctx } = ctxFor([() => jsonResponse({ code, message }, { status: 400 })]);
    return await call(ctx).catch((error: unknown) => error);
  }

  it('maps a missing platform (100200) to exit 5', async () => {
    expect(
      await failing('100200', "'product'资源不存在", (ctx) => getPlatform(ctx, PLATFORM)),
    ).toMatchObject({ kind: 'not_found', exitCode: 5, code: '100200' });
  });

  it('maps a missing repository (100202) to exit 5', async () => {
    expect(
      await failing('100202', "'repository'资源不存在", (ctx) =>
        getRepository(ctx, PLATFORM, REPO),
      ),
    ).toMatchObject({ kind: 'not_found', exitCode: 5, code: '100202' });
  });

  it('maps a missing platform user (100209) to exit 5', async () => {
    expect(
      await failing('100209', "'user'资源不存在", (ctx) => getPlatformUser(ctx, PLATFORM, USER)),
    ).toMatchObject({ kind: 'not_found', exitCode: 5, code: '100209' });
  });

  it('maps them on PATCH too, so a write on a missing row also exits 5', async () => {
    expect(
      await failing('100202', "'repository'资源不存在", (ctx) =>
        updateRepository(ctx, PLATFORM, REPO, { description: 'x' }),
      ),
    ).toMatchObject({ kind: 'not_found', exitCode: 5, code: '100202' });
  });

  it('leaves a rejected enum value and a duplicate name on exit 7', async () => {
    // `100003` (bad `type` enum) and `100220` (duplicate platform name) were seen in
    // the same smoke and are deliberately **not** overridden: neither is an absence,
    // and calling a refused enum value "not found" sends an agent hunting for a row.
    expect(
      await failing('100003', "'type'不是有效的字符串(不是有效的枚举值)", (ctx) =>
        createPlatform(ctx, { name: 'x', type: 'nope' }),
      ),
    ).toMatchObject({ kind: 'api', exitCode: 7, code: '100003' });

    expect(
      await failing('100220', "'product'已经存在", (ctx) =>
        createPlatform(ctx, { name: 'Github', type: 'github' }),
      ),
    ).toMatchObject({ kind: 'api', exitCode: 7, code: '100220' });
  });
});

describe('no PUT reaches the refined layer (design D8.4)', () => {
  it('exposes no replace wrapper for the three families that document one', async () => {
    const scm = (await import('../src/api/scm')) as Record<string, unknown>;
    const suspicious = Object.keys(scm).filter((name) => /replace|put/i.test(name));
    expect(suspicious).toEqual([]);
  });

  it('and the catalog still knows about them, so the escape hatch works', () => {
    // `pingcode api PUT /v1/scm/products/<id>` must stay reachable: excluding a verb
    // from the refined layer is a UX decision, not a removal of capability.
    const puts = CATALOG.filter((entry) => entry.module === 'scm' && entry.method === 'PUT').map(
      (entry) => entry.path,
    );
    expect(puts).toContain('/v1/scm/products/{product_id}');
    expect(puts).toContain('/v1/scm/products/{product_id}/users/{user_id}');
    expect(puts).toContain('/v1/scm/products/{product_id}/repositories/{repository_id}');
  });
});
