import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type {
  BulkCreateResult,
  Project,
  ProjectType,
  ProjectVersion,
  Sprint,
} from '../types/api';
import {
  compact,
  fetchPageOf,
  iterateOf,
  parseBulkCreateResult,
  parseProject,
  parseProjectVersion,
  parseSprint,
} from './parse';

/**
 * `/v1/pjm/projects` (research §4 rows 2–3). Thin wrappers: no formatting, no
 * config reads, no name resolution — that is `core/metadata.ts`'s job.
 */

export type ProjectListQuery = {
  keywords?: string | undefined;
  type?: ProjectType | string | undefined;
  scope_type?: 'organization' | 'user_group' | undefined;
  scope_id?: string | undefined;
  member_type?: string | undefined;
  member_id?: string | undefined;
  /** `"startTs,endTs"` in unix seconds. */
  created_between?: string | undefined;
  updated_between?: string | undefined;
  include_archived?: boolean | undefined;
  include_deleted?: boolean | undefined;
};

export async function listProjects(
  ctx: Ctx,
  query: ProjectListQuery = {},
  page: PageRequest = {},
): Promise<Page<Project>> {
  return await fetchPageOf(ctx, ENDPOINTS.projects, { ...query }, page, parseProject);
}

export function iterateProjects(
  ctx: Ctx,
  query: ProjectListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<Project, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.projects, { ...query }, options, parseProject);
}

export async function getProject(
  ctx: Ctx,
  projectId: string,
  options: { include_archived?: boolean | undefined; include_deleted?: boolean | undefined } = {},
): Promise<Project> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.project(projectId),
    query: { ...options },
  });
  return parseProject(raw);
}

/**
 * The login/`auth status --check` verification call (design §4.3): a capability we
 * actually need, rather than `GET /v1/myself` — the org token is not user-bound
 * and `pcp:read:account:personal` may simply not be granted, so a `/v1/myself`
 * failure would reject a token that works perfectly.
 *
 * Returns the reported project total.
 */
export async function verifyAccess(ctx: Ctx): Promise<number> {
  const page = await listProjects(ctx, {}, { pageSize: 1, pageIndex: 0 });
  return page.total;
}

// ---------------------------------------------------------------------------
// 迭代 (sprints) — research §3.8.5, live-verified 2026-08-04 (design D15)
// ---------------------------------------------------------------------------
//
// The list already lives in `api/meta.ts` (`listSprints`) because it was first
// needed as a *lookup*: `--sprint <name>` on a work item resolves through it. It
// stays there — moving it would change an import path for no behavioural gain —
// so this section adds only what the list cannot do.
//
// **There is no `deleteSprint` and there never can be**: the path supports GET and
// PATCH only ([S§3.8.5], confirmed live — `pingcode api DELETE` refuses it at the
// catalog pre-flight). A sprint created by mistake is permanent.

/**
 * Required: all four. `assignee_id` is the sprint's 负责人 and there is no default —
 * omitting it is refused before the request by the catalog pre-flight.
 *
 * `start_at` / `end_at` are unix **seconds** but the resource is day-granular: the
 * server snaps them to `00:00:00` and `23:59:59` of their date (live 2026-08-04).
 */
export type CreateSprintInput = {
  name: string;
  start_at: number;
  end_at: number;
  assignee_id: string;
  description?: string | undefined;
  /** `pending | in_progress | completed`; enum-validated (400 `100003`). */
  status?: string | undefined;
  /** 迭代类别 ids. **Replaces** the whole set; `[]` clears it. */
  category_ids?: string[] | undefined;
};

/**
 * Any subset — genuinely partial, verified by read-back: patching `description`
 * alone left the window, status, assignee and categories untouched.
 *
 * Both timestamps may travel in **one** request and are validated against each
 * other (400 `100042` `开始时间必须小于结束时间`). That is worth stating because the
 * `release deploy` family is the opposite: there a new `start_at` is checked against
 * the *stored* `end_at`, so the window can only be moved end-first (design D14.6).
 */
export type UpdateSprintInput = {
  name?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  assignee_id?: string | undefined;
  description?: string | undefined;
  status?: string | undefined;
  category_ids?: string[] | undefined;
};

/** One entry of `POST /v1/pjm/sprints/bulk`, which carries its own `project_id`. */
export type BulkSprintEntry = CreateSprintInput & { project_id: string };

export async function getSprint(
  ctx: Ctx,
  projectId: string,
  sprintId: string,
): Promise<Sprint> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.projectSprint(projectId, sprintId),
  });
  return parseSprint(raw);
}

export async function createSprint(
  ctx: Ctx,
  projectId: string,
  input: CreateSprintInput,
): Promise<Sprint> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.projectSprints(projectId),
    body: compact(input),
  });
  return parseSprint(raw);
}

export async function updateSprint(
  ctx: Ctx,
  projectId: string,
  sprintId: string,
  patch: UpdateSprintInput,
): Promise<Sprint> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.projectSprint(projectId, sprintId),
    body: compact(patch),
  });
  return parseSprint(raw);
}

/**
 * `POST /v1/pjm/sprints/bulk` — **企业令牌 only and the docs declare no scope**, one
 * of the two endpoints like that outside DevOps/CES ([S§7]A).
 *
 * **Atomic** (live 2026-08-04): a batch whose second entry collided with an existing
 * sprint name created nothing at all (400 `100390`
 * `'sprint.1''sprint'资源名称已存在` — note the entry index in the message). No count
 * cap was found, so none is imposed here; an empty array is refused upstream
 * (400 `100039`).
 *
 * Returns a **bare array**, one element per entry, not the usual page envelope.
 */
export async function bulkCreateSprints(
  ctx: Ctx,
  sprints: readonly BulkSprintEntry[],
): Promise<BulkCreateResult<Sprint>[]> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.sprintsBulk,
    body: { sprints: sprints.map((entry) => compact(entry)) },
  });
  return asBulkArray(raw).map((entry) => parseBulkCreateResult(entry, 'sprint', parseSprint));
}

// ---------------------------------------------------------------------------
// 发布 (versions) — research §3.8.6, live-verified 2026-08-04 (design D15)
// ---------------------------------------------------------------------------
//
// A 发布 is a *release plan* of one project. It is not a wiki page revision and not
// a configuration scheme, both of which are also called a version or a plan
// ([S§6]) — hence `ProjectVersion` throughout.
//
// Two live asymmetries the wrappers cannot hide and therefore document:
//
//  1. **`GET` and `PATCH` ignore the project segment.** A version id is effectively
//     an organisation-wide key: patching through *another* project's path mutates
//     the version in its real project and answers 200. Only `DELETE` enforces the
//     pairing (400 `1003107`). So `projectId` is required by the URL, not by the
//     API's own consistency, and a wrong one is only caught on delete.
//  2. **`operate_at` is only honoured together with `stage_id`.** Alone it is
//     accepted, echoes the *old* value and stores nothing.

export type VersionListQuery = {
  /** **Substring**, case-insensitive — a real search, unlike scm's exact `?name=`. */
  name?: string | undefined;
  /** The **stage's** `type`: `pending | in_progress | published`. Enum-validated. */
  status?: string | undefined;
  /** `"startTs,endTs"` in unix seconds, day-granular. */
  created_between?: string | undefined;
  updated_between?: string | undefined;
};

/**
 * Required: `name`, `start_at`, `end_at`, `assignee_id`. `stage_id` is optional and
 * defaults to the first configured stage (未开始) — despite the bulk twin's docs
 * marking it required.
 *
 * Names are **unique per project** (400 `100337` `'version'已经存在`), which is what
 * makes a version name resolvable to an id.
 */
export type CreateVersionInput = {
  name: string;
  start_at: number;
  end_at: number;
  assignee_id: string;
  /** 发布阶段 id, from `pingcode api GET /v1/pjm/stages`. */
  stage_id?: string | undefined;
  /** 发布类别 ids. **Replaces** the whole set; `[]` clears it. */
  category_ids?: string[] | undefined;
};

/**
 * Any subset — genuinely partial, verified by read-back.
 *
 * `operate_at` is the one field with a precondition: it is stored **only** when
 * `stage_id` travels with it, and a move to a stage the version has not reached
 * *requires* it (400 `100395`). `progress` and `changelog` are read-only — sending
 * either is accepted and dropped, like any undocumented key on this API.
 */
export type UpdateVersionInput = {
  name?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  assignee_id?: string | undefined;
  stage_id?: string | undefined;
  /** Only meaningful alongside `stage_id`; must lie inside the version's window. */
  operate_at?: number | undefined;
  category_ids?: string[] | undefined;
};

/** One entry of `POST /v1/pjm/versions/bulk`, which carries its own `project_id`. */
export type BulkVersionEntry = CreateVersionInput & { project_id: string };

export async function listVersions(
  ctx: Ctx,
  projectId: string,
  query: VersionListQuery = {},
  page: PageRequest = {},
): Promise<Page<ProjectVersion>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.projectVersions(projectId),
    { ...query },
    page,
    parseProjectVersion,
  );
}

export function iterateVersions(
  ctx: Ctx,
  projectId: string,
  query: VersionListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<ProjectVersion, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.projectVersions(projectId),
    { ...query },
    options,
    parseProjectVersion,
  );
}

export async function getVersion(
  ctx: Ctx,
  projectId: string,
  versionId: string,
): Promise<ProjectVersion> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.projectVersion(projectId, versionId),
  });
  return parseProjectVersion(raw);
}

export async function createVersion(
  ctx: Ctx,
  projectId: string,
  input: CreateVersionInput,
): Promise<ProjectVersion> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.projectVersions(projectId),
    body: compact(input),
  });
  return parseProjectVersion(raw);
}

export async function updateVersion(
  ctx: Ctx,
  projectId: string,
  versionId: string,
  patch: UpdateVersionInput,
): Promise<ProjectVersion> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.projectVersion(projectId, versionId),
    body: compact(patch),
  });
  return parseProjectVersion(raw);
}

/**
 * Delete one 发布. **The only DELETE in the pjm planning surface** — there is none
 * for a sprint and none for a project ([S§3.8.1]/[S§3.8.5]).
 *
 * Referentially clean (live 2026-08-04): a version referenced by a work item
 * deletes anyway, and the work item's `versions` entry simply disappears. That is
 * neither the release-environment shape (refused while in use, design D14.7) nor the
 * scm-branch shape (children orphaned, a permanent HTTP 500 left behind, D12.5).
 *
 * Returns the deleted version, which is what the command layer echoes.
 */
export async function deleteVersion(
  ctx: Ctx,
  projectId: string,
  versionId: string,
): Promise<ProjectVersion> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.projectVersion(projectId, versionId),
  });
  return parseProjectVersion(raw);
}

/**
 * `POST /v1/pjm/versions/bulk` — **企业令牌 only, no declared scope**, the twin of
 * `bulkCreateSprints` and just as atomic: a batch whose second entry collided with
 * an existing name created nothing (400 `100001`
 * `versions[1]:version named … had existed`). Two entries sharing a name *inside*
 * one batch is HTTP **500** `100000`, and also creates nothing.
 *
 * 60 entries were accepted in one call, so no client-side cap is imposed — unlike
 * testhub's runs bulk, where 50 is documented ([TH§7]).
 */
export async function bulkCreateVersions(
  ctx: Ctx,
  versions: readonly BulkVersionEntry[],
): Promise<BulkCreateResult<ProjectVersion>[]> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.versionsBulk,
    body: { versions: versions.map((entry) => compact(entry)) },
  });
  return asBulkArray(raw).map((entry) =>
    parseBulkCreateResult(entry, 'version', parseProjectVersion),
  );
}

/**
 * The bulk responses are a bare top-level array — the only endpoints in the CLI
 * shaped that way. Anything else (an envelope a future version might introduce, or
 * `null`) reads as zero entries rather than throwing: the resources were created
 * either way, and inventing a parse failure would report a successful write as a
 * client error.
 */
function asBulkArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}
