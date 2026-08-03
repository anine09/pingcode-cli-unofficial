/**
 * scm / build / release (DevOps 数据集成) resource types — research §3.12.
 *
 * S1a fills in the first three families (托管平台 / 托管平台用户 / 代码仓库); S1b adds
 * branches, commits and refs; S1c adds pull requests and code reviews; S1d adds builds
 * and deploys **here**, and only here: `src/types/api.ts` already re-exports this
 * module, so a new module's types reach every existing `from '../types/api'` import
 * without touching a shared file (design D6.5/D6.6).
 *
 * Conventions are module-wide and stated once in `src/types/api.ts`: API
 * `snake_case` field names, 10-digit unix **seconds** for every timestamp, an index
 * signature on every resource so unknown fields survive into `--json`, and wire
 * quirks normalised exactly once under `api/parse/`.
 *
 * Two shapes to keep in mind while reading the types below, both verified live
 * (2026-08-03) rather than inferred from the docs:
 *
 *  - scm resources are **flat and small**. No `identifier`, no `short_id`, no
 *    `is_archived` / `is_deleted`, and only the repository carries a timestamp
 *    (`created_at`) — so the usual archive/delete plumbing has nothing to do here.
 *  - a 托管平台用户 is a **git identity**, with no link to a PingCode member; see
 *    `ScmPlatformUser`.
 */

import type { Ref } from './common';

/**
 * `GET /v1/scm/products[/{platform_id}]` — 托管平台, a code-hosting *server*
 * record ([S§3.12.1]).
 *
 * **Not a ship product.** They share the `products` URL segment and nothing else.
 *
 * `name` is unique per organisation (a duplicate create is `100220 'product'已经存在`),
 * and `type` is a closed enum used only to pick an icon: `github`, `gitlab`,
 * `bitbucket`, `coding.net`, `gogs`, `git`, `svn`, `gerrit`, `other`. It is typed
 * as a plain `string` on purpose — the CLI never refuses a value the server might
 * later accept; a bad one comes back as `100003` (exit 7).
 */
export type ScmPlatform = {
  id: string;
  url?: string | undefined;
  name?: string | undefined;
  /** One of the nine documented values; not validated client-side. */
  type?: string | undefined;
  description?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/scm/products/{platform_id}/users[/{user_id}]` — 托管平台用户
 * ([S§3.12.2]).
 *
 * **This is a git author identity, not a PingCode member**, and the distinction is
 * the whole point of the family. Live 2026-08-03 the resource is exactly
 * `{id, url, product, name, display_name, html_url, avatar_url}` — there is no
 * `user`, no `user_id` and no `email` field anywhere, on read or on write. So the
 * "mapping" this family provides is a **name-string** one: a commit's
 * `committer_name` and a branch's `sender_name` ([S§3.12.7]) are matched against
 * `name`, which is unique per platform. Nothing in the API links the row to a
 * member id; PingCode does that association elsewhere.
 */
export type ScmPlatformUser = {
  id: string;
  url?: string | undefined;
  /** The 托管平台 this identity belongs to; embedded on reads, never written. */
  product?: Ref | undefined;
  /** The git username. Unique per platform, and the join key for attribution. */
  name?: string | undefined;
  display_name?: string | undefined;
  html_url?: string | undefined;
  avatar_url?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/scm/products/{platform_id}/repositories[/{repository_id}]` — 代码仓库
 * ([S§3.12.3]).
 *
 * `full_name` (`owner/name`) is unique per platform and is the only filter the
 * list endpoint honours; `name` is not unique and `?name=` is silently ignored
 * (live 2026-08-03).
 *
 * The four `*_url` templates are how PingCode builds links back to the hosting
 * platform, with `{branch}` / `{sha}` / `{base}...{head}` / `{number}`
 * placeholders it substitutes itself. They are stored verbatim — the CLI never
 * interpolates them.
 *
 * `owner` is a **`ScmPlatformUser` reference**. Writes pass `owner_name` (a string)
 * and the server resolves it — creating the platform user when the name is unknown
 * (live 2026-08-03), so the reference here can point at a row nobody created
 * deliberately.
 */
export type ScmRepository = {
  id: string;
  url?: string | undefined;
  product?: Ref | undefined;
  name?: string | undefined;
  full_name?: string | undefined;
  description?: string | undefined;
  /** Normalised from `0/1`/boolean by `api/parse/scm.ts`. */
  is_fork: boolean;
  /** Normalised from `0/1`/boolean by `api/parse/scm.ts`. */
  is_private: boolean;
  /** A 托管平台用户 reference; written as the `owner_name` string. */
  owner?: Ref | undefined;
  html_url?: string | undefined;
  /** Link template using `{branch}`. */
  branches_url?: string | undefined;
  /** Link template using `{sha}`. */
  commits_url?: string | undefined;
  /** Link template using `{base}` and `{head}`. */
  compare_url?: string | undefined;
  /** Link template using `{number}`. */
  pulls_url?: string | undefined;
  /** Unix seconds. The only timestamp scm exposes — there is no `updated_at`. */
  created_at?: number | undefined;
  [key: string]: unknown;
};

/**
 * A work item as the scm families embed it — the `work_items[]` on a branch and on
 * a commit ([S§3.12.4], [S§3.12.7]).
 *
 * Richer than a plain `Ref` (it carries `identifier`, `title`, `type`, `short_id`,
 * `html_url` and the custom `properties` bag), and worth its own type for one
 * reason: **`identifier` is what writes take** (`work_item_identifiers`), while
 * `id` is what reads key on. A caller round-tripping a link needs the identifier,
 * so it must survive parsing rather than being flattened away.
 *
 * Deliberately structurally compatible with `Ref` — it *is* one, plus fields — so a
 * call site that only wants `refName()` can pass it straight through.
 */
export type ScmWorkItemRef = {
  id: string;
  name?: string | undefined;
  url?: string | undefined;
  /** The human key (`PLM-001`), and the value `work_item_identifiers` is written with. */
  identifier?: string | undefined;
  title?: string | undefined;
  /** A bare slug (`story`, `bug`, `task`), never an id (research §6.8). */
  type?: string | undefined;
  short_id?: string | undefined;
  html_url?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  parent_id?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/scm/products/{platform_id}/repositories/{repository_id}/branches[/{branch_id}]`
 * — 代码分支 ([S§3.12.4]).
 *
 * **The one scm family with a `DELETE` and no `PUT`**, mirroring every other
 * family's shape. There is nothing missing to add.
 *
 * Three fields carry live-verified surprises (2026-08-03, design D12):
 *
 *  - **`sender` is a `Ref` on reads but writes send `sender_name`, a string — and
 *    that write is an upsert.** An unknown git username is not rejected: the server
 *    creates a 托管平台用户 for it and points `sender` there. Since scm has no
 *    identity `DELETE`, a typo here manufactures a permanent ghost row. (A commit's
 *    `committer_name`, by contrast, creates nothing — see `ScmCommit`.)
 *  - **`is_default` is not symmetric across verbs.** `POST` accepts `true` or
 *    `false`; `PATCH` accepts **only `true`** (400 `100005` otherwise) and clears
 *    the flag on whichever branch currently holds it, so one PATCH changes two rows.
 *    The first branch created in an empty repository becomes the default unasked.
 *    And the default branch **cannot be deleted** (400 `100223`).
 *  - **`work_items` is the only evidence that a link landed.** Writes send
 *    `work_item_identifiers[]`, and an identifier that does not exist is *silently
 *    dropped* with a 200 — so this array, not the status code, is what a caller has
 *    to compare against what it asked for.
 *
 * Names are unique per repository (a duplicate is 400 `100217`), which is what makes
 * the exact `?name=` filter a complete name→id lookup.
 */
export type ScmBranch = {
  id: string;
  url?: string | undefined;
  /** The 托管平台; embedded on reads, never written (it is in the path). */
  product?: Ref | undefined;
  /** The 代码仓库; embedded on reads, never written (it is in the path). */
  repository?: Ref | undefined;
  /** Unique within the repository. */
  name?: string | undefined;
  /** The creator's git identity. Written as the `sender_name` string, and upserted. */
  sender?: Ref | undefined;
  /** Normalised from `0/1`/boolean by `api/parse/scm.ts`. */
  is_default: boolean;
  /** Linked work items. `[]` when none — never `undefined`, so call sites do not branch. */
  work_items: ScmWorkItemRef[];
  /** Unix seconds. Branches carry no `updated_at`. */
  created_at?: number | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/scm/commits[/{commit_id_or_sha}]` — 提交 ([S§3.12.7]).
 *
 * **Org-level: there is no platform and no repository in the path**, which makes it
 * the only scm resource not addressed under a 托管平台 (live 2026-08-03: an
 * unfiltered list returned 3725 rows spanning every platform). Two consequences the
 * type records because the shape alone does not explain them:
 *
 *  - **`committer_name` is a flat string, not a `Ref`** — and unlike a branch's
 *    `sender_name` it creates nothing. That is not an inconsistency: with no
 *    platform in the path there is nowhere for an identity to be created, so
 *    attribution here is a bare name that PingCode matches against 托管平台用户 rows
 *    elsewhere. Do not "fix" this into a reference.
 *  - **the detail endpoint takes an id *or* a full 40-hex SHA**, which is the point
 *    of the family for CI: a pipeline holds a SHA and never a PingCode id. An
 *    *abbreviated* SHA is rejected upstream (404), and `sha` is the one identifier
 *    this API shape-validates on write (400 `100003`) — but the CLI still validates
 *    nothing, it only says so in `--help`.
 *
 * `file_changed_count` is derived server-side from the three file arrays; it is
 * never written.
 */
export type ScmCommit = {
  id: string;
  url?: string | undefined;
  /** Full 40-hex. Unique: a duplicate create is 400 `100214`. */
  sha?: string | undefined;
  message?: string | undefined;
  /** A git username as a **plain string**, not a reference. Creates no identity. */
  committer_name?: string | undefined;
  /** Unix seconds, supplied by the caller — this is the git commit time, not a receipt. */
  committed_at?: number | undefined;
  /** The tree's SHA. Optional, and `null` on the wire when unset. */
  tree_id?: string | undefined;
  /** Always an array after parsing, `[]` when the API sent nothing. */
  files_added: string[];
  files_removed: string[];
  files_modified: string[];
  /** Server-derived total across the three arrays; not writable. */
  file_changed_count?: number | undefined;
  /** Linked work items — the only evidence an identifier actually resolved. */
  work_items: ScmWorkItemRef[];
  [key: string]: unknown;
};

/**
 * `GET /v1/scm/products/{platform_id}/repositories/{repository_id}/refs[/{ref_id}]`
 * — 提交引用 ([S§3.12.7]): the join row that says "this commit belongs to this
 * branch".
 *
 * Repository-scoped, unlike the commit it points at. Three shape facts:
 *
 *  - **the list requires both `meta_type` and `meta_id`** (query, both mandatory),
 *    so "every ref in this repository" is not an operation this API offers — refs
 *    are enumerated one branch at a time.
 *  - **`meta_type` accepts only `branch`** (live: `commit` → 400 `100003`), so the
 *    `meta` reference is always a branch today, even though the field's existence
 *    implies future kinds. It is typed as a `string` rather than a literal union for
 *    exactly that reason: the CLI never refuses a value the server might later take.
 *  - **the write takes `sha`, not a commit id**, and the commit must already exist
 *    (an unknown SHA is 400 `100206`). So the CI order is commit → ref, not both at
 *    once.
 *
 * There is **no `DELETE`**, and deleting the branch a ref points at does not remove
 * it: the ref keeps reading by id while
 * `GET …/refs?meta_type=branch&meta_id=<deleted>` starts answering HTTP 500 (live
 * 2026-08-03, design D12.5). A ref is therefore permanent, and orphaning one is a
 * one-way door.
 */
export type ScmCommitRef = {
  id: string;
  url?: string | undefined;
  product?: Ref | undefined;
  repository?: Ref | undefined;
  /**
   * The referenced commit, embedded as a summary (`id`, `sha`, `message`,
   * `committer_name`, `committed_at`) — not a full `ScmCommit`: the embedded form
   * carries no file arrays and no `work_items`, so it is parsed as a `Ref` and the
   * extra fields survive through the index signature rather than being promised.
   */
  commit?: Ref | undefined;
  /** The referenced entity — a 代码分支 today; `type` is `branch`. */
  meta?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * `GET …/repositories/{repository_id}/pull_requests[/{pull_request_id}]` — 拉取请求
 * ([S§3.12.5]).
 *
 * Repository-scoped, and **permanent**: there is no `DELETE` (only the `PUT` this CLI
 * excludes, design D8.4).
 *
 * Four shape facts the field list encodes:
 *
 *  - **read objects, write scalars.** `author` / `merged_by` are 托管平台用户 references
 *    on a read while the write sends `creator_name` / `merged_by_name` strings, and
 *    `source_branch` / `target_branch` are branch references while the write sends
 *    `source_branch_id` / `target_branch_id`. The same split as a branch's
 *    `sender`/`sender_name`; the two never appear in one payload.
 *  - **`number` is the only human key.** There is no `identifier` and no `short_id`
 *    anywhere in scm, so a pull request is addressed by its 24-hex id and *found* by
 *    its `number`, which is unique per repository.
 *  - **`status` is a closed enum** (`open|closed|merged|abandoned`), typed as a plain
 *    `string` for the module's usual reason: the CLI never refuses a value the server
 *    might later accept. The docs additionally make `merged_at`,
 *    `merged_commit_sha` and `merged_by_name` required *when* the status is `merged` —
 *    a conditional the server owns.
 *  - **`work_items` is the only evidence a link landed**, exactly as on a branch: an
 *    unknown identifier in `work_item_identifiers` is dropped with a 200.
 *
 * The six `*_count` fields are caller-supplied statistics, not server-derived — unlike
 * a commit's `file_changed_count`, nothing recomputes them.
 */
export type ScmPullRequest = {
  id: string;
  url?: string | undefined;
  /** The 托管平台; embedded on reads, never written (it is in the path). */
  product?: Ref | undefined;
  /** The 代码仓库; embedded on reads, never written (it is in the path). */
  repository?: Ref | undefined;
  title?: string | undefined;
  /** Unique within the repository, and the only value a caller can search by. */
  number?: number | undefined;
  /** One of `open` / `closed` / `merged` / `abandoned`; not validated client-side. */
  status?: string | undefined;
  description?: string | undefined;
  /** The creator's git identity. Written as the `creator_name` string. */
  author?: Ref | undefined;
  /** Written as `source_branch_id`. Optional on create — a PR may have no source. */
  source_branch?: Ref | undefined;
  /** Written as `target_branch_id`, which create **requires**. */
  target_branch?: Ref | undefined;
  /** Unix seconds, server-assigned. */
  created_at?: number | undefined;
  /** Unix seconds. Required by the docs when `status` is `merged`. */
  merged_at?: number | undefined;
  merged_commit_sha?: string | undefined;
  /** The merger's git identity. Written as the `merged_by_name` string. */
  merged_by?: Ref | undefined;
  comments_count?: number | undefined;
  review_comments_count?: number | undefined;
  commits_count?: number | undefined;
  additions_count?: number | undefined;
  deletions_count?: number | undefined;
  changed_files_count?: number | undefined;
  /** Linked work items. `[]` when none — never `undefined`, so call sites do not branch. */
  work_items: ScmWorkItemRef[];
  [key: string]: unknown;
};

/**
 * `GET …/pull_requests/{pull_request_id}/reviews[/{review_id}]` — 代码评审
 * ([S§3.12.6]): one review event on one pull request.
 *
 * ⚠️ **This is not the cross-object `/v1/reviews` resource.** That one (8 endpoints,
 * reachable only through `pingcode api`) is a polymorphic 评审 object addressed by
 * `principal_type` + `pilot_id`, with review *contents* hanging off it. This one is a
 * flat record of "someone approved / commented on / requested changes to this PR". The
 * two share a word, no id space and no field set, which is why this type lives in
 * `types/scm.ts` and nothing here imports from the crosscutting layer.
 *
 * Three shape facts:
 *
 *  - **`reviewer` is a reference on reads, `reviewer_name` a string on writes** — the
 *    same split as a pull request's `author`.
 *  - **`pull_request` is embedded as a summary** carrying `id`, `url` and `number`, so
 *    it is a `Ref` and its `number` survives through the index signature.
 *  - **`submitted_at` is the only time a review has.** It is required on create and
 *    there is no `created_at` / `updated_at` on the resource, so the caller — a CI
 *    system replaying a review event — owns the timestamp entirely.
 *
 * `status` is `comment` / `approved` / `request_changes`, typed as a `string` for the
 * usual reason. `html_url` is optional and, per the docs, its absence simply means
 * PingCode renders no jump link.
 */
export type ScmCodeReview = {
  id: string;
  url?: string | undefined;
  product?: Ref | undefined;
  repository?: Ref | undefined;
  /** The pull request this review belongs to; carries `number` beyond a plain `Ref`. */
  pull_request?: Ref | undefined;
  /** The reviewer's git identity. Written as the `reviewer_name` string. */
  reviewer?: Ref | undefined;
  /** One of `comment` / `approved` / `request_changes`; not validated client-side. */
  status?: string | undefined;
  description?: string | undefined;
  /** Unix seconds, caller-supplied and required on create. */
  submitted_at?: number | undefined;
  html_url?: string | undefined;
  [key: string]: unknown;
};
