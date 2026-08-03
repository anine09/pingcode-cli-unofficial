import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type {
  ScmBranch,
  ScmCommit,
  ScmCommitRef,
  ScmPlatform,
  ScmPlatformUser,
  ScmRepository,
} from '../types/api';
import {
  compact,
  fetchPageOf,
  iterateOf,
  parseScmBranch,
  parseScmCommit,
  parseScmCommitRef,
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
 *  - **No `PUT`.** The `PUT` of each family that has one is excluded by design
 *    (D8.4: full replacement blanks omitted fields) and reachable only as
 *    `pingcode api PUT …`.
 *
 * S1b adds 代码分支, 提交 and 提交引用, and each of them bends one of the rules above:
 *
 *  - **代码分支 has a `DELETE` and no `PUT`** — the exact mirror of the other five
 *    families. So `deleteBranch` below is the module's only delete wrapper, and it is
 *    not the start of a set: nothing else here can grow one.
 *  - **提交 is not platform-scoped at all.** `/v1/scm/commits` carries no
 *    `product_id`, so its three wrappers take no platform argument. It is the one
 *    org-level resource in the module.
 *  - **提交引用's list is not optional-filtered**: `meta_type` and `meta_id` are
 *    both *required* query parameters, which is why `ScmRefListQuery` has no
 *    optional fields and `listCommitRefs` takes it as a positional rather than
 *    defaulting it to `{}`.
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

// ---------------------------------------------------------------------------
// 代码分支 branches (S1b)
// ---------------------------------------------------------------------------

export type BranchListQuery = {
  /**
   * **Exact, case-insensitive** match on the branch name, and genuinely honoured —
   * unlike the repository list's `name`, which the server ignores (D11.2). Branch
   * names are unique per repository, so this is a complete name→id lookup in one
   * request, which is why branches need no resolver row (design D12.7).
   */
  name?: string | undefined;
  /** Only branches linked to this work item **id** (not its identifier). */
  work_item_id?: string | undefined;
};

/**
 * Required: `name` (unique in the repository), `sender_name`.
 *
 * ⚠️ **`sender_name` is an upsert.** An unknown git username is not rejected — the
 * server creates a 托管平台用户 for it (live 2026-08-03), and scm exposes no identity
 * `DELETE`, so a typo leaves a permanent row behind. Callers should create the
 * identity deliberately with `createPlatformUser` first.
 */
export type CreateBranchInput = {
  name: string;
  sender_name: string;
  /** Accepted as `true` **or** `false` here; `PATCH` takes only `true`. */
  is_default?: boolean | undefined;
  /** Work item **identifiers** (`PLM-001`), not ids. Unknown ones are silently dropped. */
  work_item_identifiers?: string[] | undefined;
};

/**
 * The only two patchable fields, and `is_default` is really an *action*: the server
 * rejects `false` outright (400 `100005`) and setting `true` clears the flag on
 * whichever branch held it. Typed as `true` rather than `boolean` so the impossible
 * call does not type-check.
 */
export type UpdateBranchInput = {
  is_default?: true | undefined;
  /** Replaces the whole link set; `[]` clears it. */
  work_item_identifiers?: string[] | undefined;
};

export async function listBranches(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  query: BranchListQuery = {},
  page: PageRequest = {},
): Promise<Page<ScmBranch>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.scmBranches(platformId, repositoryId),
    { ...query },
    page,
    parseScmBranch,
  );
}

export function iterateBranches(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  query: BranchListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<ScmBranch, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.scmBranches(platformId, repositoryId),
    { ...query },
    options,
    parseScmBranch,
  );
}

export async function getBranch(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  branchId: string,
): Promise<ScmBranch> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.scmBranch(platformId, repositoryId, branchId),
  });
  return parseScmBranch(raw);
}

export async function createBranch(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  input: CreateBranchInput,
): Promise<ScmBranch> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.scmBranches(platformId, repositoryId),
    body: compact(input),
  });
  return parseScmBranch(raw);
}

export async function updateBranch(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  branchId: string,
  patch: UpdateBranchInput,
): Promise<ScmBranch> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.scmBranch(platformId, repositoryId, branchId),
    body: compact(patch),
  });
  return parseScmBranch(raw);
}

/**
 * The module's **only** delete, and the only one it can ever have.
 *
 * Returns the deleted branch, so a caller can report what went — but the `--yes`
 * gate in `cli/commands/scm/branch.ts` still names the branch *before* sending,
 * because a confirmation that arrives with the corpse is not a confirmation.
 *
 * Two live refusals worth knowing before calling it: the repository's **default
 * branch cannot be deleted** (400 `100223`), and deleting a branch does **not**
 * remove the 提交引用 rows pointing at it — those keep reading by id while the
 * ref *list* for that branch id starts answering HTTP 500 (design D12.5). Refs have
 * no delete, so that is permanent.
 */
export async function deleteBranch(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  branchId: string,
): Promise<ScmBranch> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.scmBranch(platformId, repositoryId, branchId),
  });
  return parseScmBranch(raw);
}

// ---------------------------------------------------------------------------
// 提交 commits (S1b) — org-level: no platform, no repository
// ---------------------------------------------------------------------------

export type CommitListQuery = {
  /** Full 40-hex SHA, exact. */
  sha?: string | undefined;
  /** Work item **id**, not its identifier. */
  work_item_id?: string | undefined;
};

/**
 * Everything except `tree_id` and `work_item_identifiers` is required — including
 * all three file arrays, which must be sent even when empty.
 *
 * `committer_name` is a plain git username and, unlike a branch's `sender_name`,
 * **creates no identity** (live 2026-08-03): with no platform in this endpoint's
 * path there is nowhere for one to be created. So a misspelled committer here
 * produces a commit attributed to nobody rather than a ghost row — bad, but
 * recoverable in a different way, and the two must not be documented as one hazard.
 */
export type CreateCommitInput = {
  /** Full 40-hex. This is the one identifier the server shape-validates (400 `100003`). */
  sha: string;
  message: string;
  committer_name: string;
  /** Unix seconds: the git commit time, supplied by the caller. */
  committed_at: number;
  tree_id?: string | undefined;
  files_added: string[];
  files_removed: string[];
  files_modified: string[];
  /** Work item **identifiers**. Unknown ones are silently dropped with a 200. */
  work_item_identifiers?: string[] | undefined;
};

export async function listCommits(
  ctx: Ctx,
  query: CommitListQuery = {},
  page: PageRequest = {},
): Promise<Page<ScmCommit>> {
  return await fetchPageOf(ctx, ENDPOINTS.scmCommits, { ...query }, page, parseScmCommit);
}

export function iterateCommits(
  ctx: Ctx,
  query: CommitListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<ScmCommit, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.scmCommits, { ...query }, options, parseScmCommit);
}

/**
 * One commit **by id or by full SHA** — the path parameter is literally
 * `{commit_id_or_sha}`, and this is the family's reason to exist for CI: a pipeline
 * holds a SHA and never a PingCode id.
 *
 * `commitIdOrSha` is passed through **verbatim**. No shape check, no normalisation,
 * no case folding: ids in this API have three shapes and validating them
 * client-side is forbidden (`quality-guidelines.md`). An abbreviated SHA is refused
 * upstream (404 `100002`), which is the server's answer to give, not ours.
 */
export async function getCommit(ctx: Ctx, commitIdOrSha: string): Promise<ScmCommit> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.scmCommit(commitIdOrSha),
  });
  return parseScmCommit(raw);
}

export async function createCommit(ctx: Ctx, input: CreateCommitInput): Promise<ScmCommit> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.scmCommits,
    body: compact(input),
  });
  return parseScmCommit(raw);
}

// ---------------------------------------------------------------------------
// 提交引用 commit refs (S1b)
// ---------------------------------------------------------------------------

/** The only documented `meta_type`; a different value is a server-side enum rejection. */
export const REF_META_TYPE_BRANCH = 'branch';

/**
 * **Both fields are required** by the endpoint, so neither is optional here and
 * `listCommitRefs` takes this as a positional argument rather than defaulting it.
 * That is the type expressing a real limitation: there is no way to list every ref
 * in a repository — they are enumerated one branch at a time.
 */
export type RefListQuery = {
  meta_type: string;
  meta_id: string;
};

/** Required: all three. `sha` must name a commit that already exists (else 400 `100206`). */
export type CreateRefInput = {
  sha: string;
  meta_type: string;
  meta_id: string;
};

export async function listCommitRefs(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  query: RefListQuery,
  page: PageRequest = {},
): Promise<Page<ScmCommitRef>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.scmRefs(platformId, repositoryId),
    { ...query },
    page,
    parseScmCommitRef,
  );
}

export function iterateCommitRefs(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  query: RefListQuery,
  options: PaginateOptions = {},
): AsyncGenerator<ScmCommitRef, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.scmRefs(platformId, repositoryId),
    { ...query },
    options,
    parseScmCommitRef,
  );
}

export async function getCommitRef(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  refId: string,
): Promise<ScmCommitRef> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.scmRef(platformId, repositoryId, refId),
  });
  return parseScmCommitRef(raw);
}

export async function createCommitRef(
  ctx: Ctx,
  platformId: string,
  repositoryId: string,
  input: CreateRefInput,
): Promise<ScmCommitRef> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.scmRefs(platformId, repositoryId),
    body: compact(input),
  });
  return parseScmCommitRef(raw);
}
