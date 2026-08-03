/**
 * scm / build / release parsers — research §3.12.
 *
 * S1a fills in the first three families; S1b–S1d add theirs **here**, and only here:
 * `src/api/parse.ts` already re-exports this module, so new parsers reach every
 * existing `from '../api/parse'` import without touching a shared file (design
 * D6.5/D6.6). Import the primitives from `./common`.
 *
 * The module-wide rule holds: this layer is the **only** place wire quirks are
 * normalised, unknown fields are always preserved so `--json` keeps everything the
 * API sent, and nothing here formats output.
 *
 * scm needs very little normalisation — the resources are flat, carry no
 * `is_archived` / `is_deleted` pair and only the repository has a timestamp. The one
 * thing worth doing centrally is `is_fork` / `is_private`: the wire sends real
 * booleans today (live 2026-08-03), but the docs type them `Boolean` while every
 * other flag in this API arrives as `0/1` (research §6.10), so they go through
 * `asBooleanFlag` and call sites never have to care which it was.
 */

import type {
  ScmBranch,
  ScmCommit,
  ScmCommitRef,
  ScmPlatform,
  ScmPlatformUser,
  ScmRepository,
  ScmWorkItemRef,
} from '../../types/api';
import {
  asBooleanFlag,
  asNumber,
  asRecord,
  asString,
  parseProperties,
  parseRef,
} from './common';

/** 托管平台 — `{id, url, name, type, description}` and nothing else ([S§3.12.1]). */
export function parseScmPlatform(raw: unknown): ScmPlatform {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    name: asString(record.name),
    type: asString(record.type),
    description: asString(record.description),
  };
}

/**
 * 托管平台用户 — a git identity. There is deliberately **no member reference** to
 * parse: the resource has none (see `ScmPlatformUser`), so nothing here invents one.
 */
export function parseScmPlatformUser(raw: unknown): ScmPlatformUser {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    product: parseRef(record.product),
    name: asString(record.name),
    display_name: asString(record.display_name),
    html_url: asString(record.html_url),
    avatar_url: asString(record.avatar_url),
  };
}

/**
 * 代码仓库. `owner` is a 托管平台用户 reference on reads even though writes take an
 * `owner_name` string, so it is parsed as a `Ref` and never as a scalar.
 */
export function parseScmRepository(raw: unknown): ScmRepository {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    product: parseRef(record.product),
    name: asString(record.name),
    full_name: asString(record.full_name),
    description: asString(record.description),
    is_fork: asBooleanFlag(record.is_fork),
    is_private: asBooleanFlag(record.is_private),
    owner: parseRef(record.owner),
    html_url: asString(record.html_url),
    branches_url: asString(record.branches_url),
    commits_url: asString(record.commits_url),
    compare_url: asString(record.compare_url),
    pulls_url: asString(record.pulls_url),
    created_at: asNumber(record.created_at),
  };
}

// ---------------------------------------------------------------------------
// 代码分支 / 提交 / 提交引用 (S1b) — live-verified 2026-08-03, design D12
// ---------------------------------------------------------------------------

/**
 * A work item as branches and commits embed it.
 *
 * Not `parseRef`, for one load-bearing reason: **`identifier` is the key writes
 * use** (`work_item_identifiers`), so it has to survive as a first-class field
 * rather than only through the index signature. The commands compare the returned
 * identifiers against the ones they asked for — that comparison is the only way to
 * notice that the API silently dropped an unknown one and still answered 200.
 *
 * `id` defaults to `''` on the same grounds as every other resource here: a row
 * without one is unusable, and a `Ref | undefined` would push the branch into every
 * call site.
 */
function parseScmWorkItemRef(raw: unknown): ScmWorkItemRef {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    url: asString(record.url),
    identifier: asString(record.identifier),
    title: asString(record.title),
    type: asString(record.type),
    short_id: asString(record.short_id),
    html_url: asString(record.html_url),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
    parent_id: asString(record.parent_id),
    properties: parseProperties(record.properties),
  };
}

/** `work_items[]`, normalised to an array so no call site has to test for one. */
function parseScmWorkItemRefs(raw: unknown): ScmWorkItemRef[] {
  return Array.isArray(raw) ? raw.map(parseScmWorkItemRef) : [];
}

/**
 * 代码分支.
 *
 * `sender` is parsed as a `Ref` because that is what reads return, even though
 * writes send an upserting `sender_name` string — the same read-object/write-scalar
 * split as a repository's `owner`.
 *
 * `is_default` goes through `asBooleanFlag` for the module's stated reason: the wire
 * sends a real boolean today (live 2026-08-03) while the docs type it `Boolean` and
 * every other flag in this API arrives as `0/1`.
 */
export function parseScmBranch(raw: unknown): ScmBranch {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    product: parseRef(record.product),
    repository: parseRef(record.repository),
    name: asString(record.name),
    sender: parseRef(record.sender),
    is_default: asBooleanFlag(record.is_default),
    work_items: parseScmWorkItemRefs(record.work_items),
    created_at: asNumber(record.created_at),
  };
}

/**
 * 提交.
 *
 * **`committer_name` stays a string.** It is tempting to normalise it into the
 * `sender`-shaped reference the branch has, but the API creates no identity for it
 * and returns no reference (live 2026-08-03: an unknown `committer_name` produced no
 * 托管平台用户 at all, because `POST /v1/scm/commits` has no platform in its path).
 * Inventing a `Ref` here would fabricate a link the data does not contain.
 *
 * The three file arrays are normalised to `[]` — they are required on write and
 * always present on read, but a defensive default costs nothing and keeps
 * `file_changed_count` reconcilable without a null check.
 */
export function parseScmCommit(raw: unknown): ScmCommit {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    sha: asString(record.sha),
    message: asString(record.message),
    committer_name: asString(record.committer_name),
    committed_at: asNumber(record.committed_at),
    tree_id: asString(record.tree_id),
    files_added: asStringList(record.files_added),
    files_removed: asStringList(record.files_removed),
    files_modified: asStringList(record.files_modified),
    file_changed_count: asNumber(record.file_changed_count),
    work_items: parseScmWorkItemRefs(record.work_items),
  };
}

/** A file-name list; anything that is not a usable string is dropped rather than kept as `undefined`. */
function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const value = asString(item);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/**
 * 提交引用.
 *
 * `commit` and `meta` are both parsed as plain `Ref`s on purpose. The embedded
 * commit is a *summary* — it carries `sha` / `message` / `committer_name` /
 * `committed_at` but no file arrays and no `work_items` — so typing it as a
 * `ScmCommit` would promise fields that are never there, and the extra ones it does
 * carry survive through `Ref`'s index signature anyway.
 */
export function parseScmCommitRef(raw: unknown): ScmCommitRef {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    product: parseRef(record.product),
    repository: parseRef(record.repository),
    commit: parseRef(record.commit),
    meta: parseRef(record.meta),
  };
}
