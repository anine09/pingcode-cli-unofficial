import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type { Page, PageRequest, PaginateOptions } from '../core/paginate';
import type {
  Activity,
  Attachment,
  Comment,
  Principal,
  PrincipalType,
  Relation,
} from '../types/api';
import {
  compact,
  fetchPageOf,
  iterateOf,
  parseActivity,
  parseAttachment,
  parseComment,
  parseRelation,
} from './parse';

/**
 * The four cross-object families — relations / comments / attachments / activities
 * (research §3.7, PRD S0, design D5).
 *
 * **One implementation, parameterised by `Principal`.** Every function here takes the
 * `{type, id}` pair and nothing else module-specific, because that pair is the only
 * thing that varies between a comment on a work item and a comment on a ticket. The
 * command layer mounts these onto five parent commands (`cli/commands/_shared/
 * crosscutting.ts`); nothing is duplicated per entity, and nothing here knows which
 * entity it is serving.
 *
 * **Where the principal rides is not uniform, and that is the API's doing:** it is a
 * query parameter on every read and delete, and a *body* field on the two creates
 * (`POST /v1/comments`, and the code-snippet `POST /v1/attachments`). The three
 * `principalQuery` / body call sites below are the whole of that asymmetry.
 *
 * Two constraints found live (2026-08-03) that the docs get wrong, both encoded here
 * rather than left to the caller:
 *
 *  - a **code snippet requires `comment_id`** even though it is documented optional;
 *    `createSnippetAttachment` therefore takes it as a required argument;
 *  - `GET /v1/relations` requires `target_type`, so `listRelations` takes it as a
 *    required argument too.
 */

// ---------------------------------------------------------------------------
// the principal pair
// ---------------------------------------------------------------------------

/** `?principal_type=…&principal_id=…` — the shape of every read and delete. */
function principalQuery(principal: Principal): Record<string, string> {
  return { principal_type: principal.type, principal_id: principal.id };
}

/**
 * Which `principal_type` values each family documents, verbatim from the vendor's
 * own `allowedValues`, with the live result of probing each one recorded beside it.
 *
 * This table is what the mount assertions in `test/crosscutting.test.ts` check
 * against. It is data, not validation: nothing at runtime refuses a value, because
 * the mount point picks it (design D5.1) and there is therefore no user input to
 * reject. Its job is to make "this family is not mounted where it does not work" a
 * testable statement.
 *
 * Live notes (all 2026-08-03, enterprise token):
 *  - every entry below answered 2xx for a real id of that kind;
 *  - a test **plan** is not a principal in any family. `comments`/`attachments`
 *    reject it with `100049`, and `activities` answers **HTTP 500** — which is why
 *    the vocabulary is a table and not a runtime probe;
 *  - `activities` genuinely omits `page`, so the sets are not interchangeable.
 */
export const PRINCIPAL_TYPES = {
  relation: ['work_item', 'test_case', 'test_run', 'idea', 'ticket', 'page'],
  comment: ['work_item', 'test_case', 'test_run', 'idea', 'ticket', 'page'],
  attachment: ['work_item', 'test_case', 'test_run', 'idea', 'ticket', 'page'],
  activity: ['work_item', 'test_case', 'test_run', 'idea', 'ticket'],
} as const satisfies Record<string, readonly PrincipalType[]>;

/**
 * Which `(principal_type, target_type)` pairs `POST/GET /v1/relations` accepts.
 *
 * **The vendor documents no vocabulary for this endpoint at all** — no
 * `allowedValues` on either field — so this matrix is purely live evidence, probed
 * pair by pair on 2026-08-03 with real ids on both sides. Two things it shows that
 * no reading of the docs would:
 *
 *  - **`work_item → work_item` is refused.** Typed work-item links are the separate
 *    `/v1/pjm/work_items/{id}/relations` family, which carries a `relation_type`.
 *    `/v1/relations` is the *cross-kind* linker, and that is its actual purpose;
 *  - **it is not symmetric.** `test_run → work_item` is accepted but
 *    `work_item → test_run` is not, and `ticket → test_case` is refused while
 *    `test_case → ticket` is too — so the direction of the call matters even though
 *    the created relation itself is stored as a mirrored pair.
 *
 * It is **advisory only**: it feeds `--help` and the hint printed when the server
 * rejects a pair, and nothing here refuses a call. A tenant on a different plan may
 * well accept more pairs than this one did, and refusing locally would make that
 * unreachable (design D3.5 — add no failure mode the API does not have).
 *
 * **The matrix is at the level of *kinds*, and the API also filters on the work item's
 * *type*.** From `test_case` only a 需求 (story) or 缺陷 (bug) target is accepted;
 * from `test_run` only a 缺陷. An epic/feature/task target is rejected with `100107`
 * `不支持的工作项类型` — even though the very same link created from the work-item side
 * succeeds for any type. That is a per-tenant, per-scheme fact this table cannot
 * express and the CLI does not try to: it would cost a request to read the target
 * before every write, in order to refuse what the server refuses anyway.
 */
export const RELATION_TARGETS = {
  work_item: ['idea', 'ticket', 'test_case', 'page'],
  idea: ['work_item', 'idea', 'ticket', 'test_case', 'page'],
  ticket: ['work_item', 'idea', 'ticket', 'page'],
  test_case: ['work_item', 'idea', 'page'],
  test_run: ['work_item'],
  page: ['work_item', 'idea', 'ticket', 'test_case'],
} as const satisfies Record<PrincipalType, readonly PrincipalType[]>;

/**
 * The documented `format` vocabulary of a code snippet, verbatim and in the docs'
 * own order. The server rejects anything else with `100039`, and since the value is
 * a closed set the list belongs in `--help` rather than in a runtime guess.
 */
export const SNIPPET_FORMATS = [
  'clike',
  'css',
  'dart',
  'django',
  'dockerfile',
  'go',
  'markdown',
  'nginx',
  'python',
  'php',
  'shell',
  'sql',
  'swift',
  'html',
  'javascript',
  'jsx',
  'pascal',
  'sass',
  'stylus',
  'vue',
  'yaml',
  'haskell',
] as const;

// ---------------------------------------------------------------------------
// relations — /v1/relations (4 endpoints)
// ---------------------------------------------------------------------------

export type CreateRelationInput = {
  target_type: PrincipalType;
  /** A real id of the target object. Never shape-checked here (quality guidelines). */
  target_id: string;
};

/** `target_type` is **required** by the server, despite reading like a filter. */
export async function listRelations(
  ctx: Ctx,
  principal: Principal,
  targetType: PrincipalType,
  page: PageRequest = {},
): Promise<Page<Relation>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.relations,
    { ...principalQuery(principal), target_type: targetType },
    page,
    parseRelation,
  );
}

export function iterateRelations(
  ctx: Ctx,
  principal: Principal,
  targetType: PrincipalType,
  options: PaginateOptions = {},
): AsyncGenerator<Relation, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.relations,
    { ...principalQuery(principal), target_type: targetType },
    options,
    parseRelation,
  );
}

/** Addressed by relation id alone — no principal query (design D5.3). */
export async function getRelation(ctx: Ctx, relationId: string): Promise<Relation> {
  const raw = await request<unknown>(ctx, { method: 'GET', path: ENDPOINTS.relation(relationId) });
  return parseRelation(raw);
}

/**
 * The principal rides in the **body** here, alongside the target. There is no
 * relation-type field: this API's `/v1/relations` has no type vocabulary at all.
 */
export async function createRelation(
  ctx: Ctx,
  principal: Principal,
  input: CreateRelationInput,
): Promise<Relation> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.relations,
    body: compact({
      principal_type: principal.type,
      principal_id: principal.id,
      target_type: input.target_type,
      target_id: input.target_id,
    }),
  });
  return parseRelation(raw);
}

/**
 * Deletes **both directions**: the API stores a relation as a mirrored pair with two
 * distinct ids, and removing either one removes the other (live-verified). So there
 * is no "half-deleted relation" state to clean up, and no second call to make.
 */
export async function deleteRelation(ctx: Ctx, relationId: string): Promise<Relation> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.relation(relationId),
  });
  return parseRelation(raw);
}

// ---------------------------------------------------------------------------
// comments — /v1/comments (4 endpoints)
// ---------------------------------------------------------------------------

export type CreateCommentInput = {
  content: string;
  /** Makes this a reply to an existing comment on the same object. */
  reply_comment_id?: string | undefined;
};

export async function listComments(
  ctx: Ctx,
  principal: Principal,
  page: PageRequest = {},
): Promise<Page<Comment>> {
  return await fetchPageOf(ctx, ENDPOINTS.comments, principalQuery(principal), page, parseComment);
}

export function iterateComments(
  ctx: Ctx,
  principal: Principal,
  options: PaginateOptions = {},
): AsyncGenerator<Comment, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.comments, principalQuery(principal), options, parseComment);
}

/** The principal is required on a single read too — a comment id alone is not enough. */
export async function getComment(
  ctx: Ctx,
  principal: Principal,
  commentId: string,
): Promise<Comment> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.comment(commentId),
    query: principalQuery(principal),
  });
  return parseComment(raw);
}

/** The principal rides in the **body** on create, unlike every read. */
export async function createComment(
  ctx: Ctx,
  principal: Principal,
  input: CreateCommentInput,
): Promise<Comment> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.comments,
    body: compact({
      principal_type: principal.type,
      principal_id: principal.id,
      content: input.content,
      reply_comment_id: input.reply_comment_id,
    }),
  });
  return parseComment(raw);
}

/**
 * A **soft** delete: the response and every subsequent list still contain the row with
 * `is_deleted` set. Whether `content` is emptied is module-dependent — live, pjm blanks
 * it and ship leaves the text in place — so `is_deleted` is the only reliable signal
 * and callers must render it rather than infer absence.
 */
export async function deleteComment(
  ctx: Ctx,
  principal: Principal,
  commentId: string,
): Promise<Comment> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.comment(commentId),
    query: principalQuery(principal),
  });
  return parseComment(raw);
}

// ---------------------------------------------------------------------------
// attachments — /v1/attachments (4 of 5 endpoints; the file upload needs multipart)
// ---------------------------------------------------------------------------

/** `comment_id` scopes every attachment call to one comment's attachments. */
export type AttachmentScope = {
  comment_id?: string | undefined;
};

export type CreateSnippetInput = {
  /**
   * **Required**, though documented optional: without it the API rejects the whole
   * request with `100039`. A snippet always belongs to a comment.
   */
  comment_id: string;
  title: string;
  /** One of `SNIPPET_FORMATS`; anything else is `100039`. */
  format: string;
  content: string;
};

/**
 * Without `comment_id` this lists only the object's own (file) attachments —
 * snippets live under their comment and do **not** appear here (live-verified).
 */
export async function listAttachments(
  ctx: Ctx,
  principal: Principal,
  scope: AttachmentScope = {},
  page: PageRequest = {},
): Promise<Page<Attachment>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.attachments,
    { ...principalQuery(principal), ...compact(scope) },
    page,
    parseAttachment,
  );
}

export function iterateAttachments(
  ctx: Ctx,
  principal: Principal,
  scope: AttachmentScope = {},
  options: PaginateOptions = {},
): AsyncGenerator<Attachment, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.attachments,
    { ...principalQuery(principal), ...compact(scope) },
    options,
    parseAttachment,
  );
}

/**
 * A comment-scoped attachment is invisible without its `comment_id`: the API answers
 * `附件不存在` (`100045`) rather than a permission error, so an omitted scope looks
 * exactly like a wrong id (live-verified).
 */
export async function getAttachment(
  ctx: Ctx,
  principal: Principal,
  attachmentId: string,
  scope: AttachmentScope = {},
): Promise<Attachment> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.attachment(attachmentId),
    query: { ...principalQuery(principal), ...compact(scope) },
  });
  return parseAttachment(raw);
}

/**
 * The `application/json` code-snippet variant — the **only** attachment a curated
 * command can create. The file upload on the same path is `multipart/form-data` in
 * one step, which `core/wire.ts` cannot send (design D5.5).
 *
 * The principal rides in the body here, as on `POST /v1/comments`.
 */
export async function createSnippetAttachment(
  ctx: Ctx,
  principal: Principal,
  input: CreateSnippetInput,
): Promise<Attachment> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.attachments,
    body: compact({
      principal_type: principal.type,
      principal_id: principal.id,
      comment_id: input.comment_id,
      title: input.title,
      format: input.format,
      content: input.content,
    }),
  });
  return parseAttachment(raw);
}

/** Hard delete, unlike a comment — and it needs the same `comment_id` scope as `get`. */
export async function deleteAttachment(
  ctx: Ctx,
  principal: Principal,
  attachmentId: string,
  scope: AttachmentScope = {},
): Promise<Attachment> {
  const raw = await request<unknown>(ctx, {
    method: 'DELETE',
    path: ENDPOINTS.attachment(attachmentId),
    query: { ...principalQuery(principal), ...compact(scope) },
  });
  return parseAttachment(raw);
}

// ---------------------------------------------------------------------------
// activities — /v1/activities (2 endpoints, read-only)
// ---------------------------------------------------------------------------

export async function listActivities(
  ctx: Ctx,
  principal: Principal,
  page: PageRequest = {},
): Promise<Page<Activity>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.activities,
    principalQuery(principal),
    page,
    parseActivity,
  );
}

export function iterateActivities(
  ctx: Ctx,
  principal: Principal,
  options: PaginateOptions = {},
): AsyncGenerator<Activity, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.activities, principalQuery(principal), options, parseActivity);
}

export async function getActivity(
  ctx: Ctx,
  principal: Principal,
  activityId: string,
): Promise<Activity> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.activity(activityId),
    query: principalQuery(principal),
  });
  return parseActivity(raw);
}
