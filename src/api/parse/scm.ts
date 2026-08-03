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

import type { ScmPlatform, ScmPlatformUser, ScmRepository } from '../../types/api';
import { asBooleanFlag, asNumber, asRecord, asString, parseRef } from './common';

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
