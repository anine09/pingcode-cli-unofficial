import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type { ScmPlatform, ScmPlatformUser, ScmRepository } from '../types/api';
import {
  compact,
  fetchPageOf,
  iterateOf,
  parseScmPlatform,
  parseScmPlatformUser,
  parseScmRepository,
} from './parse';

/**
 * `/v1/scm/**` — 源码管理, the write-back integration surface a CI system uses
 * ([S§3.12]). S1a covers the three families everything else hangs off: 托管平台,
 * 托管平台用户 and 代码仓库.
 *
 * Four facts shape this file:
 *
 *  - **An scm "product" is a hosting platform**, not a ship product. Every wrapper
 *    below therefore says `platform`, and the path helpers in
 *    `core/endpoints.ts` are the only place the `products` segment appears.
 *  - **Everything is platform-scoped.** A repository id, a platform-user id and
 *    (later) a branch or PR id are only addressable under the platform they belong
 *    to — the path carries it, so there is no org-wide variant to fall back on.
 *  - **The area is 企业令牌-only.** No wrapper here works with a user token, which
 *    is fine: `client_credentials` is the only flow this CLI has.
 *  - **No `PUT`, and no `DELETE` either.** The `PUT` of each family is excluded by
 *    design (D8.4: full replacement blanks omitted fields) and reachable only as
 *    `pingcode api PUT …`. `DELETE` simply does not exist upstream for these three
 *    families, so — as with ship — no delete wrapper can be added later.
 *
 * Nothing here formats or resolves: names become ids in `core/metadata`, rendering
 * happens in `cli/`.
 */

// ---------------------------------------------------------------------------
// 托管平台 hosting platforms
// ---------------------------------------------------------------------------

export type PlatformListQuery = {
  /**
   * **Exact, case-insensitive** match on the platform name — not a search
   * (live 2026-08-03: `name=git` matches nothing while `name=github` matches
   * `Github`). Name *resolution* therefore loads the whole list instead.
   */
  name?: string | undefined;
};

/** Required: `name` (unique per org), `type` (one of the nine documented values). */
export type CreatePlatformInput = {
  name: string;
  type: string;
  description?: string | undefined;
};

/** Any subset. `PATCH`, never `PUT` — the `PUT` twin would blank what it is not sent. */
export type UpdatePlatformInput = {
  name?: string | undefined;
  type?: string | undefined;
  description?: string | undefined;
};

export async function listPlatforms(
  ctx: Ctx,
  query: PlatformListQuery = {},
  page: PageRequest = {},
): Promise<Page<ScmPlatform>> {
  return await fetchPageOf(ctx, ENDPOINTS.scmPlatforms, { ...query }, page, parseScmPlatform);
}

export function iteratePlatforms(
  ctx: Ctx,
  query: PlatformListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<ScmPlatform, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.scmPlatforms, { ...query }, options, parseScmPlatform);
}

export async function getPlatform(ctx: Ctx, platformId: string): Promise<ScmPlatform> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.scmPlatform(platformId),
  });
  return parseScmPlatform(raw);
}

export async function createPlatform(
  ctx: Ctx,
  input: CreatePlatformInput,
): Promise<ScmPlatform> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.scmPlatforms,
    body: compact(input),
  });
  return parseScmPlatform(raw);
}

export async function updatePlatform(
  ctx: Ctx,
  platformId: string,
  patch: UpdatePlatformInput,
): Promise<ScmPlatform> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.scmPlatform(platformId),
    body: compact(patch),
  });
  return parseScmPlatform(raw);
}

// ---------------------------------------------------------------------------
// 托管平台用户 platform users (git identities)
// ---------------------------------------------------------------------------

export type PlatformUserListQuery = {
  /** Exact match on the git username, which is unique per platform. */
  name?: string | undefined;
};

/**
 * Required: `name` — the git username commits and branches are attributed by.
 * There is **no** PingCode-member field to send; see `ScmPlatformUser`.
 */
export type CreatePlatformUserInput = {
  name: string;
  display_name?: string | undefined;
  html_url?: string | undefined;
  avatar_url?: string | undefined;
};

export type UpdatePlatformUserInput = {
  name?: string | undefined;
  display_name?: string | undefined;
  html_url?: string | undefined;
  avatar_url?: string | undefined;
};

export async function listPlatformUsers(
  ctx: Ctx,
  platformId: string,
  query: PlatformUserListQuery = {},
  page: PageRequest = {},
): Promise<Page<ScmPlatformUser>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.scmPlatformUsers(platformId),
    { ...query },
    page,
    parseScmPlatformUser,
  );
}

export function iteratePlatformUsers(
  ctx: Ctx,
  platformId: string,
  query: PlatformUserListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<ScmPlatformUser, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.scmPlatformUsers(platformId),
    { ...query },
    options,
    parseScmPlatformUser,
  );
}

export async function getPlatformUser(
  ctx: Ctx,
  platformId: string,
  userId: string,
): Promise<ScmPlatformUser> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.scmPlatformUser(platformId, userId),
  });
  return parseScmPlatformUser(raw);
}

export async function createPlatformUser(
  ctx: Ctx,
  platformId: string,
  input: CreatePlatformUserInput,
): Promise<ScmPlatformUser> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.scmPlatformUsers(platformId),
    body: compact(input),
  });
  return parseScmPlatformUser(raw);
}

export async function updatePlatformUser(
  ctx: Ctx,
  platformId: string,
  userId: string,
  patch: UpdatePlatformUserInput,
): Promise<ScmPlatformUser> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.scmPlatformUser(platformId, userId),
    body: compact(patch),
  });
  return parseScmPlatformUser(raw);
}

// ---------------------------------------------------------------------------
// 代码仓库 repositories
// ---------------------------------------------------------------------------

export type RepositoryListQuery = {
  /**
   * `owner/name`, exact. The **only** filter this list honours: `?name=` is
   * silently ignored and returns every repository of the platform (live
   * 2026-08-03), which is why no `name` field exists on this type.
   */
  full_name?: string | undefined;
};

/** Required: `name`, `full_name` (`owner/name`, unique per platform). */
export type CreateRepositoryInput = {
  name: string;
  full_name: string;
  description?: string | undefined;
  is_fork?: boolean | undefined;
  is_private?: boolean | undefined;
  /**
   * A 托管平台用户 **name**, not an id — the server resolves it to the owner ref, and
   * **creates the platform user if the name is unknown** (live 2026-08-03: an
   * unknown `owner_name` returned 200 with a fresh owner id, and the identity then
   * appeared in the platform's user list). A typo therefore manufactures an
   * undeletable ghost identity rather than failing.
   */
  owner_name?: string | undefined;
  html_url?: string | undefined;
  /** Link templates, stored verbatim: `{branch}` / `{sha}` / `{base}...{head}` / `{number}`. */
  branches_url?: string | undefined;
  commits_url?: string | undefined;
  compare_url?: string | undefined;
  pulls_url?: string | undefined;
};

/** Any subset of the create fields. */
export type UpdateRepositoryInput = {
  name?: string | undefined;
  full_name?: string | undefined;
  description?: string | undefined;
  is_fork?: boolean | undefined;
  is_private?: boolean | undefined;
  owner_name?: string | undefined;
  html_url?: string | undefined;
  branches_url?: string | undefined;
  commits_url?: string | undefined;
  compare_url?: string | undefined;
  pulls_url?: string | undefined;
};

export async function listRepositories(
  ctx: Ctx,
  platformId: string,
  query: RepositoryListQuery = {},
  page: PageRequest = {},
): Promise<Page<ScmRepository>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.scmRepositories(platformId),
    { ...query },
    page,
    parseScmRepository,
  );
}

export function iterateRepositories(
  ctx: Ctx,
  platformId: string,
  query: RepositoryListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<ScmRepository, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.scmRepositories(platformId),
    { ...query },
    options,
    parseScmRepository,
  );
}

export async function getRepository(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
): Promise<ScmRepository> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.scmRepository(platformId, repositoryId),
  });
  return parseScmRepository(raw);
}

export async function createRepository(
  ctx: Ctx,
  platformId: string,
  input: CreateRepositoryInput,
): Promise<ScmRepository> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.scmRepositories(platformId),
    body: compact(input),
  });
  return parseScmRepository(raw);
}

export async function updateRepository(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  patch: UpdateRepositoryInput,
): Promise<ScmRepository> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.scmRepository(platformId, repositoryId),
    body: compact(patch),
  });
  return parseScmRepository(raw);
}
