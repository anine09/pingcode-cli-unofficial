/**
 * scm / build / release (DevOps 数据集成) resource types — research §3.12.
 *
 * S1a fills in the first three families (托管平台 / 托管平台用户 / 代码仓库); S1b–S1d add
 * branches, commits, refs, pull requests, reviews, builds and deploys **here**, and
 * only here: `src/types/api.ts` already re-exports this module, so a new module's
 * types reach every existing `from '../types/api'` import without touching a shared
 * file (design D6.5/D6.6).
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
