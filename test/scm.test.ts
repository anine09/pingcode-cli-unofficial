import { describe, expect, it } from 'vitest';
import {
  parseScmBranch,
  parseScmCodeReview,
  parseScmCommit,
  parseScmCommitRef,
  parseScmPlatform,
  parseScmPlatformUser,
  parseScmPullRequest,
  parseScmRepository,
} from '../src/api/parse';
import {
  createBranch,
  createCommit,
  createCommitRef,
  createPlatform,
  createPlatformUser,
  createPullRequest,
  createRepository,
  createReview,
  deleteBranch,
  getBranch,
  getCommit,
  getCommitRef,
  getPlatform,
  getPlatformUser,
  getPullRequest,
  getRepository,
  getReview,
  iterateBranches,
  iterateCommits,
  iteratePlatforms,
  iteratePullRequests,
  iterateRepositories,
  iterateReviews,
  listBranches,
  listCommitRefs,
  listCommits,
  listPlatformUsers,
  listPlatforms,
  listPullRequests,
  listRepositories,
  listReviews,
  REF_META_TYPE_BRANCH,
  updateBranch,
  updatePlatform,
  updatePlatformUser,
  updatePullRequest,
  updateRepository,
  updateReview,
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
 *
 * S1b appends 代码分支 / 提交 / 提交引用 below. Their assertions carry three shape facts
 * that are easy to "tidy" into being wrong, so each is pinned:
 *  - a commit's `committer_name` stays a **string** and is never promoted to a `Ref`
 *    (the API creates no identity for it — design D12.1);
 *  - `/v1/scm/commits` takes **no platform id**, so its wrappers have no platform
 *    argument to accidentally grow;
 *  - `deleteBranch` is the module's only delete, and `updateBranch`'s `is_default` is
 *    typed `true` because the server rejects `false` outright (D12.3).
 */

const NOW = 1_700_000_000_000;

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const REPO = '685d393c47512a5d5d52aa70';
const USER = '685c6ca42974f854bb4979ac';
const BRANCH = '6a706a6d39cbed1cf7126c22';
const COMMIT = '6a706a9a919cce9794f011a3';
const REF = '6a706ac439cbed1cf7126c2d';
/** A real 40-hex SHA: the one identifier this API shape-validates (design D12.2). */
const SHA = 'e35cc1ed300bfe85da6d6b8108ddb33d28b26ae5';
const PR = '6a70a5f1919cce9794f01c3f';
const REVIEW = '6a70a62839cbed1cf7127e11';

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

  it('nests branches and refs under the repository, and commits under nothing', () => {
    expect(ENDPOINTS.scmBranches(PLATFORM, REPO)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/branches`,
    );
    expect(ENDPOINTS.scmBranch(PLATFORM, REPO, BRANCH)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/branches/${BRANCH}`,
    );
    expect(ENDPOINTS.scmRefs(PLATFORM, REPO)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/refs`,
    );
    expect(ENDPOINTS.scmRef(PLATFORM, REPO, REF)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/refs/${REF}`,
    );

    // 提交 is organisation-level: no platform, no repository (design D12.6). If this
    // ever grows a parent segment, every `scm commit` leaf's flag surface is wrong.
    expect(ENDPOINTS.scmCommits).toBe('/v1/scm/commits');
    expect(ENDPOINTS.scmCommit(SHA)).toBe(`/v1/scm/commits/${SHA}`);
    expect(ENDPOINTS.scmCommit(COMMIT)).toBe(`/v1/scm/commits/${COMMIT}`);
  });

  it('nests a pull request under the repository and a review under the pull request', () => {
    expect(ENDPOINTS.scmPullRequests(PLATFORM, REPO)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/pull_requests`,
    );
    expect(ENDPOINTS.scmPullRequest(PLATFORM, REPO, PR)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/pull_requests/${PR}`,
    );
    // Three parents deep — the deepest path in the CLI, and the reason every review
    // leaf requires `--pr-id` (design D13).
    expect(ENDPOINTS.scmPullRequestReviews(PLATFORM, REPO, PR)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/pull_requests/${PR}/reviews`,
    );
    expect(ENDPOINTS.scmPullRequestReview(PLATFORM, REPO, PR, REVIEW)).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/pull_requests/${PR}/reviews/${REVIEW}`,
    );
    // …and it is NOT the cross-object review resource, which lives at the org root.
    expect(ENDPOINTS.scmPullRequestReviews(PLATFORM, REPO, PR)).not.toBe('/v1/reviews');
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
      '/v1/scm/products/{product_id}/repositories/{repository_id}/branches',
      '/v1/scm/products/{product_id}/repositories/{repository_id}/branches/{branch_id}',
      '/v1/scm/products/{product_id}/repositories/{repository_id}/refs',
      '/v1/scm/products/{product_id}/repositories/{repository_id}/refs/{ref_id}',
      '/v1/scm/commits',
      '/v1/scm/commits/{commit_id_or_sha}',
      '/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests',
      '/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests/{pull_request_id}',
      '/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests/{pull_request_id}/reviews',
      '/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests/{pull_request_id}/reviews/{review_id}',
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

describe('scm normalisation, part 2: branches / commits / refs (S1b)', () => {
  it('parses a branch, keeping sender as a ref and work items as identifiers', () => {
    const branch = parseScmBranch({
      id: BRANCH,
      name: 'cli-smoke/s1b-e2e',
      product: { id: PLATFORM, name: '[CLI smoke] pingcode-cli', type: 'other' },
      repository: { id: REPO, name: 'pingcode-cli-unofficial', full_name: 'acme/x' },
      sender: { id: USER, name: 'cli-smoke-bot' },
      is_default: false,
      created_at: 1785750479,
      work_items: [{ id: 'w1', identifier: 'YYHC-10', title: 'a story', type: 'story' }],
      future_field: 'kept',
    });

    expect(branch.sender?.name).toBe('cli-smoke-bot');
    expect(branch.repository?.id).toBe(REPO);
    expect(branch.is_default).toBe(false);
    // `identifier` is what a write sends back as `work_item_identifiers`, so it must
    // survive as a real field rather than only through the index signature.
    expect(branch.work_items[0]?.identifier).toBe('YYHC-10');
    expect(branch.work_items[0]?.title).toBe('a story');
    expect(branch.created_at).toBe(1785750479);
    expect(branch.future_field).toBe('kept');
  });

  it('normalises a branch without work_items to [] rather than undefined', () => {
    // Call sites join this array unconditionally; an absent field must not make them
    // branch, exactly as `ShipProduct.members` and `WorkItem.tags` behave.
    expect(parseScmBranch({ id: BRANCH }).work_items).toEqual([]);
    expect(parseScmBranch({ id: BRANCH, work_items: 'nonsense' }).work_items).toEqual([]);
  });

  it('accepts is_default as 0/1 as well as a boolean', () => {
    // The wire sends a real boolean today, but every other flag in this API arrives as
    // 0/1 (research §6.10) and the docs only say `Boolean`.
    expect(parseScmBranch({ id: BRANCH, is_default: 1 }).is_default).toBe(true);
    expect(parseScmBranch({ id: BRANCH, is_default: 0 }).is_default).toBe(false);
    expect(parseScmBranch({ id: BRANCH }).is_default).toBe(false);
  });

  it("keeps a commit's committer_name a string and never invents a reference", () => {
    // Design D12.1: `POST /v1/scm/commits` has no platform in its path, so it creates
    // no identity and returns no reference. Promoting this to a `Ref` would fabricate
    // a link the data does not contain.
    const commit = parseScmCommit({
      id: COMMIT,
      sha: SHA,
      message: 'feat: x',
      committer_name: 'cli-smoke-bot',
      committed_at: 1785751200,
      tree_id: null,
      files_added: ['a.ts'],
      files_removed: [],
      files_modified: ['b.ts'],
      file_changed_count: 2,
      work_items: [{ id: 'w1', identifier: 'YYHC-10' }],
    });

    expect(commit.committer_name).toBe('cli-smoke-bot');
    expect(commit.sender).toBeUndefined();
    expect(commit.committer).toBeUndefined();
    // `null` is normalised away by the shared parse layer.
    expect(commit.tree_id).toBeUndefined();
    expect(commit.files_added).toEqual(['a.ts']);
    expect(commit.files_modified).toEqual(['b.ts']);
    expect(commit.file_changed_count).toBe(2);
    expect(commit.work_items[0]?.identifier).toBe('YYHC-10');
  });

  it('normalises the three commit file arrays to [] and drops unusable entries', () => {
    const commit = parseScmCommit({ id: COMMIT, files_added: ['a.ts', '', null, 7] });
    expect(commit.files_added).toEqual(['a.ts', '7']);
    expect(commit.files_removed).toEqual([]);
    expect(commit.files_modified).toEqual([]);
  });

  it('parses a ref, keeping the embedded commit summary and the branch meta', () => {
    const ref = parseScmCommitRef({
      id: REF,
      product: { id: PLATFORM, name: 'p' },
      repository: { id: REPO, name: 'r' },
      commit: { id: COMMIT, sha: SHA, message: 'feat: x', committer_name: 'bot', committed_at: 1 },
      meta: { id: BRANCH, name: 'cli-smoke/s1b-e2e', type: 'branch' },
    });

    expect(ref.meta?.name).toBe('cli-smoke/s1b-e2e');
    expect(ref.meta?.type).toBe('branch');
    // The embedded commit is a *summary* (no file arrays, no work_items), so it is a
    // `Ref` and its extra fields survive through the index signature.
    expect(ref.commit?.sha).toBe(SHA);
    expect(ref.commit?.committer_name).toBe('bot');
    expect(ref.commit?.files_added).toBeUndefined();
  });
});

describe('branches api (S1b)', () => {
  it('lists branches under the repository with the exact-name filter', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: BRANCH, name: 'main' }])]);
    await listBranches(ctx, PLATFORM, REPO, { name: 'main' }, { pageIndex: 0, pageSize: 30 });

    expect(fake.calls[0]?.method).toBe('GET');
    expect(fake.urls()[0]).toContain(`/v1/scm/products/${PLATFORM}/repositories/${REPO}/branches?`);
    expect(fake.urls()[0]).toContain('name=main');
  });

  it('passes work_item_id through as a query filter', async () => {
    const { ctx, fake } = ctxFor([() => envelope([])]);
    await listBranches(ctx, PLATFORM, REPO, { work_item_id: 'w1' });
    expect(fake.urls()[0]).toContain('work_item_id=w1');
  });

  it('walks every page of branches', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'b1', name: 'one' }], { page_index: 0, page_size: 1 }),
      () => envelope([], { page_index: 1, page_size: 1 }),
    ]);
    const values = await collect(iterateBranches(ctx, PLATFORM, REPO, {}, { pageSize: 1 }));
    expect(values.map((branch) => branch.id)).toEqual(['b1']);
  });

  it('gets one branch', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BRANCH, name: 'main' })]);
    await getBranch(ctx, PLATFORM, REPO, BRANCH);
    expect(fake.urls()[0]).toContain(`/branches/${BRANCH}`);
  });

  it('creates a branch and sends only the fields it was given', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BRANCH })]);
    await createBranch(ctx, PLATFORM, REPO, { name: 'feature/x', sender_name: 'bot' });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({ name: 'feature/x', sender_name: 'bot' });
  });

  it('lets create send is_default false, which only create accepts', async () => {
    // Design D12.3: POST takes true or false; PATCH takes only true, and
    // `UpdateBranchInput` is typed `true` so the rejected call cannot be written.
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BRANCH })]);
    await createBranch(ctx, PLATFORM, REPO, {
      name: 'feature/x',
      sender_name: 'bot',
      is_default: false,
      work_item_identifiers: ['YYHC-10'],
    });
    expect(fake.calls[0]?.body).toEqual({
      name: 'feature/x',
      sender_name: 'bot',
      is_default: false,
      work_item_identifiers: ['YYHC-10'],
    });
  });

  it('patches a branch with PATCH, never PUT — this family has no PUT at all', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BRANCH })]);
    await updateBranch(ctx, PLATFORM, REPO, BRANCH, { is_default: true });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ is_default: true });
  });

  it('sends an empty work_item_identifiers array, because [] is how you clear links', async () => {
    // A replace-semantics field needs `[]` to reach the wire; `compact` only drops
    // `undefined`, so this asserts the distinction survives.
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BRANCH })]);
    await updateBranch(ctx, PLATFORM, REPO, BRANCH, { work_item_identifiers: [] });
    expect(fake.calls[0]?.body).toEqual({ work_item_identifiers: [] });
  });

  it('deletes a branch and returns the deleted row', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BRANCH, name: 'gone' })]);
    const deleted = await deleteBranch(ctx, PLATFORM, REPO, BRANCH);

    expect(fake.calls[0]?.method).toBe('DELETE');
    expect(fake.urls()[0]).toContain(`/branches/${BRANCH}`);
    expect(deleted.name).toBe('gone');
  });

  it('sends no branch write under --dry-run, including the delete', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BRANCH })], { dryRun: true });
    await expect(deleteBranch(ctx, PLATFORM, REPO, BRANCH)).rejects.toBeInstanceOf(DryRunHalt);
    await expect(
      createBranch(ctx, PLATFORM, REPO, { name: 'x', sender_name: 'bot' }),
    ).rejects.toBeInstanceOf(DryRunHalt);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('commits api (S1b) — organisation-level', () => {
  it('lists commits with no platform anywhere in the path', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: COMMIT, sha: SHA }])]);
    await listCommits(ctx, { sha: SHA }, { pageIndex: 0, pageSize: 2 });

    expect(fake.urls()[0]).toContain('/v1/scm/commits?');
    expect(fake.urls()[0]).not.toContain('/products/');
    expect(fake.urls()[0]).toContain(`sha=${SHA}`);
  });

  it('walks every page of commits', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'c1', sha: SHA }], { page_index: 0, page_size: 1 }),
      () => envelope([], { page_index: 1, page_size: 1 }),
    ]);
    const values = await collect(iterateCommits(ctx, {}, { pageSize: 1 }));
    expect(values.map((commit) => commit.id)).toEqual(['c1']);
  });

  it('gets a commit by id and by full SHA, passing both through verbatim', async () => {
    // AC1: `{commit_id_or_sha}` really takes both, and nothing here inspects the shape.
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: COMMIT, sha: SHA }),
      () => jsonResponse({ id: COMMIT, sha: SHA }),
    ]);
    await getCommit(ctx, COMMIT);
    await getCommit(ctx, SHA);

    // Asserted as a URL suffix: the reference is the last path segment and nothing
    // follows it, which is what "verbatim" means here.
    expect(fake.urls()[0]).toMatch(new RegExp(`/v1/scm/commits/${COMMIT}$`));
    expect(fake.urls()[1]).toMatch(new RegExp(`/v1/scm/commits/${SHA}$`));
  });

  it('never validates or normalises the reference it is given', async () => {
    // Ids come in three shapes and an abbreviated SHA is refused *by the server*
    // (404 `100002`, live 2026-08-03). Refusing or rewriting it here would be the
    // client-side id validation `quality-guidelines.md` forbids — so an abbreviated
    // SHA, a mixed-case one and a slash all reach the wire untouched (percent-encoded).
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: COMMIT }),
      () => jsonResponse({ id: COMMIT }),
      () => jsonResponse({ id: COMMIT }),
    ]);
    await getCommit(ctx, 'e35cc1e');
    await getCommit(ctx, SHA.toUpperCase());
    await getCommit(ctx, 'a/b');

    expect(fake.urls()[0]).toContain('/v1/scm/commits/e35cc1e');
    expect(fake.urls()[1]).toContain(`/v1/scm/commits/${SHA.toUpperCase()}`);
    expect(fake.urls()[2]).toContain('/v1/scm/commits/a%2Fb');
  });

  it('creates a commit, sending the three file arrays even when empty', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: COMMIT })]);
    await createCommit(ctx, {
      sha: SHA,
      message: 'feat: x',
      committer_name: 'bot',
      committed_at: 1785751200,
      files_added: [],
      files_removed: [],
      files_modified: [],
    });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({
      sha: SHA,
      message: 'feat: x',
      committer_name: 'bot',
      committed_at: 1785751200,
      files_added: [],
      files_removed: [],
      files_modified: [],
    });
  });
});

describe('commit refs api (S1b)', () => {
  it('requires meta_type and meta_id on the list, because the endpoint does', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: REF }])]);
    await listCommitRefs(ctx, PLATFORM, REPO, {
      meta_type: REF_META_TYPE_BRANCH,
      meta_id: BRANCH,
    });

    expect(fake.urls()[0]).toContain(`/repositories/${REPO}/refs?`);
    expect(fake.urls()[0]).toContain('meta_type=branch');
    expect(fake.urls()[0]).toContain(`meta_id=${BRANCH}`);
  });

  it('gets one ref', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: REF })]);
    await getCommitRef(ctx, PLATFORM, REPO, REF);
    expect(fake.urls()[0]).toContain(`/refs/${REF}`);
  });

  it('creates a ref from a SHA plus a branch id', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: REF })]);
    await createCommitRef(ctx, PLATFORM, REPO, {
      sha: SHA,
      meta_type: REF_META_TYPE_BRANCH,
      meta_id: BRANCH,
    });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({
      sha: SHA,
      meta_type: 'branch',
      meta_id: BRANCH,
    });
  });

  it('exposes no ref update and no ref delete, because upstream has neither', async () => {
    const scm = (await import('../src/api/scm')) as Record<string, unknown>;
    expect(Object.keys(scm).filter((name) => /Ref$/.test(name) && /^(update|delete)/.test(name)))
      .toEqual([]);
  });
});

describe('scm not-found mapping, part 2 (S1b: exit 5 from HTTP 400)', () => {
  async function failing(
    code: string,
    message: string,
    call: (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>,
  ) {
    const { ctx } = ctxFor([() => jsonResponse({ code, message }, { status: 400 })]);
    return await call(ctx).catch((error: unknown) => error);
  }

  it('maps a missing branch (100201) to exit 5 on GET, PATCH and DELETE alike', async () => {
    for (const call of [
      (ctx: ReturnType<typeof ctxFor>['ctx']) => getBranch(ctx, PLATFORM, REPO, BRANCH),
      (ctx: ReturnType<typeof ctxFor>['ctx']) =>
        updateBranch(ctx, PLATFORM, REPO, BRANCH, { is_default: true }),
      (ctx: ReturnType<typeof ctxFor>['ctx']) => deleteBranch(ctx, PLATFORM, REPO, BRANCH),
    ]) {
      expect(await failing('100201', "'branch'资源不存在", call)).toMatchObject({
        kind: 'not_found',
        exitCode: 5,
        code: '100201',
      });
    }
  });

  it('maps a missing commit (100206) to exit 5, whether addressed by id or by SHA', async () => {
    for (const reference of [COMMIT, SHA]) {
      expect(
        await failing('100206', "'commit'资源不存在", (ctx) => getCommit(ctx, reference)),
      ).toMatchObject({ kind: 'not_found', exitCode: 5, code: '100206' });
    }
  });

  it('maps a missing reference (100207) to exit 5', async () => {
    expect(
      await failing('100207', "'reference'资源不存在", (ctx) =>
        getCommitRef(ctx, PLATFORM, REPO, REF),
      ),
    ).toMatchObject({ kind: 'not_found', exitCode: 5, code: '100207' });
  });

  it('maps the same two codes on ref create, where they name the absent row', async () => {
    // A create that fails because the commit or branch it *named* does not exist is a
    // not-found about that row, not a generic rejection (design D12.8).
    const create = (ctx: ReturnType<typeof ctxFor>['ctx']) =>
      createCommitRef(ctx, PLATFORM, REPO, {
        sha: SHA,
        meta_type: REF_META_TYPE_BRANCH,
        meta_id: BRANCH,
      });

    expect(await failing('100206', "'commit'资源不存在", create)).toMatchObject({
      kind: 'not_found',
      exitCode: 5,
    });
    expect(await failing('100201', "'branch'资源不存在", create)).toMatchObject({
      kind: 'not_found',
      exitCode: 5,
    });
  });

  it('leaves the conflicts, the validation and the default-branch refusal on exit 7', async () => {
    // Deliberately not overridden (design D12.8): a duplicate is not an absence, an
    // `is_default` rejection is input validation, and `100223` refuses to delete a
    // branch that plainly exists — calling any of them `not_found` would send an agent
    // looking for a row it can already see.
    const cases: [string, string, (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>][] = [
      ['100217', "'branch'已经存在", (ctx) => createBranch(ctx, PLATFORM, REPO, { name: 'x', sender_name: 'b' })],
      ['100214', "'commit'已经存在", (ctx) =>
        createCommit(ctx, {
          sha: SHA,
          message: 'm',
          committer_name: 'b',
          committed_at: 1,
          files_added: [],
          files_removed: [],
          files_modified: [],
        })],
      ['100215', "'ref'已经存在", (ctx) =>
        createCommitRef(ctx, PLATFORM, REPO, { sha: SHA, meta_type: 'branch', meta_id: BRANCH })],
      ['100005', "'is_default'不是有效的布尔值(值不为true)", (ctx) =>
        updateBranch(ctx, PLATFORM, REPO, BRANCH, { is_default: true })],
      ['100223', '默认分支不能被删除', (ctx) => deleteBranch(ctx, PLATFORM, REPO, BRANCH)],
    ];

    for (const [code, message, call] of cases) {
      expect(await failing(code, message, call), code).toMatchObject({
        kind: 'api',
        exitCode: 7,
        code,
      });
    }
  });
});

describe('scm normalisation, part 3: pull requests / code reviews (S1c)', () => {
  it('parses a pull request, keeping every reference a ref and every count a number', () => {
    const pullRequest = parseScmPullRequest({
      id: PR,
      url: 'https://open.pingcode.com/v1/scm/products/x',
      product: { id: PLATFORM, name: '[CLI smoke] pingcode-cli', type: 'other' },
      repository: { id: REPO, name: 'pingcode-cli-unofficial', full_name: 'acme/x' },
      title: 'feat: add login',
      number: 42,
      status: 'open',
      description: null,
      author: { id: USER, name: 'cli-smoke-bot' },
      source_branch: { id: BRANCH, name: 'feature/login' },
      target_branch: { id: 'b2', name: 'main' },
      created_at: 1785750479,
      merged_at: null,
      merged_commit_sha: null,
      merged_by: null,
      comments_count: 2,
      commits_count: 3,
      changed_files_count: 0,
      work_items: [{ id: 'w1', identifier: 'YYHC-10', title: 'a story', type: 'story' }],
      future_field: 'kept',
    });

    // Reads return references while writes send `creator_name` / `*_branch_id` scalars;
    // promoting either side into the other would invent a field.
    expect(pullRequest.author?.name).toBe('cli-smoke-bot');
    expect(pullRequest.source_branch?.id).toBe(BRANCH);
    expect(pullRequest.target_branch?.name).toBe('main');
    expect(pullRequest.number).toBe(42);
    expect(pullRequest.status).toBe('open');
    // `0` is a real count and must survive; `null` is normalised away by the shared
    // parse layer, which is what makes "absent" mean "not reported".
    expect(pullRequest.changed_files_count).toBe(0);
    expect(pullRequest.merged_at).toBeUndefined();
    expect(pullRequest.merged_by).toBeUndefined();
    expect(pullRequest.description).toBeUndefined();
    expect(pullRequest.work_items[0]?.identifier).toBe('YYHC-10');
    expect(pullRequest.future_field).toBe('kept');
  });

  it('normalises a pull request without work_items to [] rather than undefined', () => {
    expect(parseScmPullRequest({ id: PR }).work_items).toEqual([]);
    expect(parseScmPullRequest({ id: PR, work_items: 'nonsense' }).work_items).toEqual([]);
  });

  it('parses a code review, keeping the pull request a ref that still carries its number', () => {
    const review = parseScmCodeReview({
      id: REVIEW,
      product: { id: PLATFORM, name: 'p' },
      repository: { id: REPO, name: 'r' },
      pull_request: { id: PR, number: 42, url: 'https://open.pingcode.com/v1/x' },
      reviewer: { id: USER, name: 'cli-smoke-bot' },
      status: 'approved',
      description: 'looks good',
      submitted_at: 1785751200,
      html_url: null,
    });

    expect(review.reviewer?.name).toBe('cli-smoke-bot');
    expect(review.status).toBe('approved');
    expect(review.submitted_at).toBe(1785751200);
    // The embedded pull request is a *summary*: `number` survives through `Ref`'s index
    // signature, and nothing here promises the branches, counts or work items that a
    // full `ScmPullRequest` has.
    expect(review.pull_request?.id).toBe(PR);
    expect(review.pull_request?.number).toBe(42);
    expect(review.pull_request?.work_items).toBeUndefined();
    expect(review.html_url).toBeUndefined();
  });

  it('does not share a parser with the cross-object /v1/reviews resource', async () => {
    // Design D13: two unrelated resources share the word "review". The scm one is
    // parsed here; the polymorphic `/v1/reviews` object is generic-layer-only and has no
    // parser at all. Asserted so a later "unify the review parsers" refactor fails.
    const parse = (await import('../src/api/parse')) as Record<string, unknown>;
    expect(typeof parse.parseScmCodeReview).toBe('function');
    expect(Object.keys(parse).filter((name) => /^parse.*Review/.test(name))).toEqual([
      'parseScmCodeReview',
    ]);
  });
});

describe('pull requests api (S1c)', () => {
  it('lists pull requests under the repository with both documented filters', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: PR, number: 42 }])]);
    await listPullRequests(
      ctx,
      PLATFORM,
      REPO,
      { number: 42, work_item_id: 'w1' },
      { pageIndex: 0, pageSize: 30 },
    );

    expect(fake.calls[0]?.method).toBe('GET');
    const url = fake.urls()[0] ?? '';
    expect(url).toContain(`/v1/scm/products/${PLATFORM}/repositories/${REPO}/pull_requests?`);
    expect(url).toContain('number=42');
    expect(url).toContain('work_item_id=w1');
  });

  it('walks every page of pull requests', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'pr1', number: 1 }], { page_index: 0, page_size: 1 }),
      () => envelope([{ id: 'pr2', number: 2 }], { page_index: 1, page_size: 1 }),
      () => envelope([], { page_index: 2, page_size: 1 }),
    ]);
    const values = await collect(iteratePullRequests(ctx, PLATFORM, REPO, {}, { pageSize: 1 }));
    expect(values.map((pullRequest) => pullRequest.id)).toEqual(['pr1', 'pr2']);
  });

  it('gets one pull request by id', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PR, number: 42 })]);
    await getPullRequest(ctx, PLATFORM, REPO, PR);
    expect(fake.urls()[0]).toContain(`/pull_requests/${PR}`);
  });

  it('creates a pull request with the five required fields and nothing else', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PR })]);
    await createPullRequest(ctx, PLATFORM, REPO, {
      title: 'feat: x',
      number: 42,
      creator_name: 'bot',
      target_branch_id: 'b2',
      status: 'open',
    });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({
      title: 'feat: x',
      number: 42,
      creator_name: 'bot',
      target_branch_id: 'b2',
      status: 'open',
    });
  });

  it('sends a zero count rather than dropping it', async () => {
    // `compact` drops only `undefined`, which is what makes "0 changed files" and "no
    // count reported" different requests.
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PR })]);
    await createPullRequest(ctx, PLATFORM, REPO, {
      title: 'feat: x',
      number: 42,
      creator_name: 'bot',
      target_branch_id: 'b2',
      status: 'open',
      changed_files_count: 0,
      work_item_identifiers: ['YYHC-10'],
    });
    expect(fake.calls[0]?.body).toMatchObject({
      changed_files_count: 0,
      work_item_identifiers: ['YYHC-10'],
    });
  });

  it('patches with PATCH and always carries status, the one mandatory patch field', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PR })]);
    await updatePullRequest(ctx, PLATFORM, REPO, PR, { status: 'merged', title: 'feat: y' });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ status: 'merged', title: 'feat: y' });
  });

  it('sends an empty work_item_identifiers array, because [] is how you clear links', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PR })]);
    await updatePullRequest(ctx, PLATFORM, REPO, PR, { status: 'open', work_item_identifiers: [] });
    expect(fake.calls[0]?.body).toEqual({ status: 'open', work_item_identifiers: [] });
  });

  it('sends nothing on a pull request write under --dry-run, while reads still run', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PR })], { dryRun: true });
    await expect(
      createPullRequest(ctx, PLATFORM, REPO, {
        title: 't',
        number: 1,
        creator_name: 'bot',
        target_branch_id: 'b2',
        status: 'open',
      }),
    ).rejects.toBeInstanceOf(DryRunHalt);
    expect(fake.calls).toHaveLength(0);

    await getPullRequest(ctx, PLATFORM, REPO, PR);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('code reviews api (S1c)', () => {
  it('lists the reviews of one pull request, with no query parameters at all', async () => {
    // The endpoint documents none — not even the `?number=`-style filter the pull
    // request list has — so the wrapper takes no query argument to grow one into.
    const { ctx, fake } = ctxFor([() => envelope([{ id: REVIEW, status: 'approved' }])]);
    await listReviews(ctx, PLATFORM, REPO, PR, { pageIndex: 1, pageSize: 2 });

    const url = fake.urls()[0] ?? '';
    expect(url).toContain(`/pull_requests/${PR}/reviews?`);
    expect(url).toContain('page_index=1');
    expect(url).toContain('page_size=2');
    // Only the paging pair is on the wire.
    expect(new URL(url).searchParams.size).toBe(2);
  });

  it('walks every page of reviews', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'r1' }], { page_index: 0, page_size: 1 }),
      () => envelope([], { page_index: 1, page_size: 1 }),
    ]);
    const values = await collect(iterateReviews(ctx, PLATFORM, REPO, PR, { pageSize: 1 }));
    expect(values.map((review) => review.id)).toEqual(['r1']);
  });

  it('gets one review', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: REVIEW })]);
    await getReview(ctx, PLATFORM, REPO, PR, REVIEW);
    expect(fake.urls()[0]).toContain(`/pull_requests/${PR}/reviews/${REVIEW}`);
  });

  it('creates a review with its three required fields', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: REVIEW })]);
    await createReview(ctx, PLATFORM, REPO, PR, {
      status: 'approved',
      reviewer_name: 'bot',
      submitted_at: 1785751200,
    });

    expect(fake.calls[0]?.method).toBe('POST');
    // `submitted_at` is mandatory because the resource has no server-assigned time.
    expect(fake.calls[0]?.body).toEqual({
      status: 'approved',
      reviewer_name: 'bot',
      submitted_at: 1785751200,
    });
  });

  it('patches a review with PATCH, and has no mandatory field to carry', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: REVIEW })]);
    await updateReview(ctx, PLATFORM, REPO, PR, REVIEW, { description: 'revised' });

    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ description: 'revised' });
  });

  it('exposes no review delete, because upstream has none', async () => {
    const scm = (await import('../src/api/scm')) as Record<string, unknown>;
    expect(Object.keys(scm).filter((name) => /^delete/.test(name))).toEqual(['deleteBranch']);
  });
});

describe('scm not-found mapping, part 3 (S1c: exit 5 from HTTP 400)', () => {
  // S1c smoke, 2026-08-03, live tenant (design D13.1 item 5). The last two scm
  // families each report absence with one stable code, HTTP 400 like the six before
  // them. Before these rows a missing pull request exited 7 while a missing branch
  // exited 5 — the inconsistency D13.4 recorded when the smoke could not be run.
  async function failing(
    code: string,
    message: string,
    call: (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>,
  ) {
    const { ctx } = ctxFor([() => jsonResponse({ code, message }, { status: 400 })]);
    return await call(ctx).catch((error: unknown) => error);
  }

  it('maps a missing pull request (100208) to exit 5 on GET and PATCH alike', async () => {
    for (const call of [
      (ctx: ReturnType<typeof ctxFor>['ctx']) => getPullRequest(ctx, PLATFORM, REPO, PR),
      (ctx: ReturnType<typeof ctxFor>['ctx']) =>
        updatePullRequest(ctx, PLATFORM, REPO, PR, { status: 'open' }),
    ]) {
      expect(await failing('100208', "'pull request'资源不存在", call)).toMatchObject({
        kind: 'not_found',
        exitCode: 5,
        code: '100208',
      });
    }
  });

  it('maps 100208 on a review create too, because the named pull request is what is absent', async () => {
    expect(
      await failing('100208', "'pull request'资源不存在", (ctx) =>
        createReview(ctx, PLATFORM, REPO, PR, {
          status: 'comment',
          reviewer_name: 'bot',
          submitted_at: 1785751200,
        }),
      ),
    ).toMatchObject({ kind: 'not_found', exitCode: 5, code: '100208' });
  });

  it('maps a missing review (100222) to exit 5 on GET and PATCH alike', async () => {
    for (const call of [
      (ctx: ReturnType<typeof ctxFor>['ctx']) => getReview(ctx, PLATFORM, REPO, PR, REVIEW),
      (ctx: ReturnType<typeof ctxFor>['ctx']) =>
        updateReview(ctx, PLATFORM, REPO, PR, REVIEW, { status: 'comment' }),
    ]) {
      expect(await failing('100222', "'review'资源不存在", call)).toMatchObject({
        kind: 'not_found',
        exitCode: 5,
        code: '100222',
      });
    }
  });

  it('leaves the four input-validation and business-rule codes on exit 7', async () => {
    // All observed in the same smoke and deliberately **not** overridden: a missing
    // required field, the merged-status conditional, and a refusal about two branches
    // that both exist are none of them an absence.
    const cases: [string, string][] = [
      ['100224', '源分支是必填字段'],
      ['100008', "'status'是必填字段"],
      ['100212', "请提供'merged_at'，'merged_commit_sha'，'merged_by_name'值"],
      ['100211', '源分支和目标分支不能相同'],
    ];
    for (const [code, message] of cases) {
      expect(
        await failing(code, message, (ctx) =>
          createPullRequest(ctx, PLATFORM, REPO, {
            title: 'x',
            number: 1,
            creator_name: 'bot',
            source_branch_id: 's',
            target_branch_id: 't',
            status: 'open',
          }),
        ),
      ).toMatchObject({ kind: 'api', exitCode: 7, code });
    }
  });
});

describe('no PUT reaches the refined layer (design D8.4)', () => {
  it('exposes no replace wrapper for the five families that document one', async () => {
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
    // S1c's two, the last in the module — five families with a PUT, none with a leaf.
    expect(puts).toContain(
      '/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests/{pull_request_id}',
    );
    expect(puts).toContain(
      '/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests/{pull_request_id}/reviews/{review_id}',
    );
    // And that is all of them: scm documents exactly five, so a sixth appearing means
    // the catalog was regenerated against a changed API and this child's count is stale.
    expect(puts).toHaveLength(5);
  });

  it('confirms the branch family has no PUT upstream either, only a DELETE', () => {
    // Design D12: 代码分支 is the one scm family shaped the other way round. Asserted so
    // that "the other five have a PUT, this one is missing it" cannot be acted on — and
    // so that the delete wrapper is understood as the family's fifth verb, not as the
    // start of a set the other families should grow.
    const branchPath = '/v1/scm/products/{product_id}/repositories/{repository_id}/branches/{branch_id}';
    const methods = CATALOG.filter((entry) => entry.path === branchPath)
      .map((entry) => entry.method)
      .sort();
    expect(methods).toEqual(['DELETE', 'GET', 'PATCH']);

    const scmPuts = CATALOG.filter((entry) => entry.module === 'scm' && entry.method === 'PUT');
    expect(scmPuts.some((entry) => entry.path.includes('/branches'))).toBe(false);
    // And no scm family has both, so `deleteBranch` stays the module's only delete.
    const scmDeletes = CATALOG.filter((entry) => entry.module === 'scm' && entry.method === 'DELETE');
    expect(scmDeletes.map((entry) => entry.path)).toEqual([branchPath]);
  });
});
