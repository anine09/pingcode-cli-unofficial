/**
 * Cross-object resource types: relations / comments / attachments / activities — research §3.7.
 *
 * Reserved by F1 and filled in by F5. These types live here, and only here:
 * `src/types/api.ts` already re-exports this module, so they reach every existing
 * `from '../types/api'` import without touching a shared file (design D6.5/D6.6).
 *
 * The module-wide conventions stated in `src/types/api.ts` all apply: API
 * `snake_case` field names, 10-digit unix **seconds** timestamps, an index signature
 * on every resource so unknown fields survive into `--json`, and wire quirks
 * (`0/1` booleans) normalised exactly once under `api/parse/`.
 */

import type { Ref } from './common';

/**
 * The `principal_type` vocabulary — the "Principal" half of research §3.4's
 * Pilot/Principal pair, i.e. the work object itself rather than its container.
 *
 * This is the **union of what the four families accept**; the per-family subsets
 * are narrower and differ, which is why they are data in `api/common.ts` rather
 * than types here (activities take no `page`, relations declare no vocabulary at
 * all). A test plan is deliberately absent: live, no family accepts one.
 *
 * `work_item_deliverable` is documented only on the attachment file upload and on
 * `GET` one attachment. Neither is reachable from a curated command — the upload
 * needs multipart (design D5.5) — so it is not in this union.
 */
export type PrincipalType = 'work_item' | 'test_case' | 'test_run' | 'idea' | 'ticket' | 'page';

/** One object addressed polymorphically: the pair every cross-object call carries. */
export type Principal = {
  type: PrincipalType;
  /** A real id. Short ids and identifiers are resolved before they get here. */
  id: string;
};

/**
 * `/v1/relations` — a typed link between two objects of **different** kinds.
 *
 * There is no relation *type* anywhere in this resource (live-verified: create,
 * read back, delete). Typed work-item↔work-item links are a separate family,
 * `/v1/pjm/work_items/{id}/relations`, which does carry a `relation_type`.
 */
export type Relation = {
  id: string;
  principal_type?: string | undefined;
  /** The embedded object, with `identifier` / `title` / `html_url` when it has them. */
  principal?: Ref | undefined;
  target_type?: string | undefined;
  target?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * `/v1/comments` — plain text plus the snippets/files attached to it.
 *
 * `is_deleted` matters here more than elsewhere: deleting a comment is a **soft**
 * delete that leaves the row in the list with an empty `content` (live-verified),
 * so a caller that ignores the flag will report a comment that is no longer there.
 */
export type Comment = {
  id: string;
  content?: string | undefined;
  attachment_count?: number | undefined;
  attachments: Attachment[];
  is_reply_comment: boolean;
  replied_comment?: Ref | undefined;
  created_at?: number | undefined;
  created_by?: Ref | undefined;
  is_deleted: boolean;
  [key: string]: unknown;
};

/**
 * `/v1/attachments` — one resource, two shapes discriminated by `type`:
 *
 *  - `"file"` carries `file_type` / `ext` / `download_url`; only the API's own
 *    multipart upload can create one, so the CLI can read and delete but not write;
 *  - `"snippet"` carries `format` (the language) / `content` / `line`.
 */
export type Attachment = {
  id: string;
  title?: string | undefined;
  /** Bytes, computed by the server — never sent by a client. */
  size?: number | undefined;
  type?: string | undefined;
  /** Snippets only: the language, from the documented `format` vocabulary. */
  format?: string | undefined;
  /** Snippets only. */
  content?: string | undefined;
  /** Snippets only: line count, computed by the server. */
  line?: number | undefined;
  /** Files only. */
  file_type?: string | undefined;
  /** Files only. */
  ext?: string | undefined;
  /** Files only, and time-limited — do not cache it. */
  download_url?: string | undefined;
  created_at?: number | undefined;
  created_by?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * `/v1/activities` — one audit row.
 *
 * `template` is the machine-readable event name (`unrelate-test-case`) and `type`
 * its verb (`unrelate`); `summary` is human, Chinese and not a contract. `content`
 * is free-form and differs per template, so it is passed through untouched.
 */
export type Activity = {
  id: string;
  template?: string | undefined;
  type?: string | undefined;
  summary?: string | undefined;
  client?: string | undefined;
  content?: Record<string, unknown> | undefined;
  created_at?: number | undefined;
  created_by?: Ref | undefined;
  [key: string]: unknown;
};
