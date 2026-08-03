/**
 * Cross-object parsers: relations / comments / attachments / activities — research §3.7.
 *
 * Reserved by F1 and filled in by F5. These parsers live here, and only here:
 * `src/api/parse.ts` already re-exports this module, so they reach every existing
 * `from '../api/parse'` import without touching a shared file (design D6.5/D6.6).
 *
 * The layer's rules are unchanged: wire quirks are normalised **once** (here, the
 * `0/1` booleans `is_reply_comment` / `is_deleted`), unknown fields are preserved so
 * `--json` stays faithful, and nothing here formats output.
 */

import type { Activity, Attachment, Comment, Relation } from '../../types/crosscutting';
import { asBooleanFlag, asNumber, asRecord, asString, parseProperties, parseRef } from './common';

export function parseRelation(raw: unknown): Relation {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    principal_type: asString(record.principal_type),
    principal: parseRef(record.principal),
    target_type: asString(record.target_type),
    target: parseRef(record.target),
  };
}

/**
 * `is_reply_comment` and `is_deleted` arrive as numbers `0/1` (research §6.10), and
 * `is_deleted: 1` is the only thing that distinguishes a deleted comment from a live
 * one — the row itself stays in the list (live 2026-08-03).
 */
export function parseComment(raw: unknown): Comment {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    content: asString(record.content),
    attachment_count: asNumber(record.attachment_count),
    attachments: Array.isArray(record.attachments)
      ? record.attachments.map(parseAttachment)
      : [],
    is_reply_comment: asBooleanFlag(record.is_reply_comment),
    replied_comment: parseRef(record.replied_comment),
    created_at: asNumber(record.created_at),
    created_by: parseRef(record.created_by),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseAttachment(raw: unknown): Attachment {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    title: asString(record.title),
    size: asNumber(record.size),
    type: asString(record.type),
    format: asString(record.format),
    // Not `asString`: a snippet may legitimately be the empty string, and losing
    // that would turn "an empty file" into "no content field at all".
    content: typeof record.content === 'string' ? record.content : undefined,
    line: asNumber(record.line),
    file_type: asString(record.file_type),
    ext: asString(record.ext),
    download_url: asString(record.download_url),
    created_at: asNumber(record.created_at),
    created_by: parseRef(record.created_by),
  };
}

export function parseActivity(raw: unknown): Activity {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    template: asString(record.template),
    type: asString(record.type),
    summary: asString(record.summary),
    client: asString(record.client),
    // Free-form and template-dependent: kept as an object, never interpreted.
    content: parseProperties(record.content),
    created_at: asNumber(record.created_at),
    created_by: parseRef(record.created_by),
  };
}
