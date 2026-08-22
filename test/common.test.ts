import { describe, expect, it } from 'vitest';
import {
  createComment,
  createRelation,
  createSnippetAttachment,
  deleteAttachment,
  deleteComment,
  deleteRelation,
  getActivity,
  getAttachment,
  getComment,
  getRelation,
  iterateActivities,
  iterateAttachments,
  iterateComments,
  iterateRelations,
  listActivities,
  listAttachments,
  listComments,
  listRelations,
  PRINCIPAL_TYPES,
  RELATION_TARGETS,
  SNIPPET_FORMATS,
  type AttachmentScope,
  type CreateCommentInput,
  type CreateRelationInput,
  type CreateSnippetInput,
} from '../src/api/common';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { ApiError, NotFoundError, exitCodeFor } from '../src/core/errors';
import { collect } from '../src/core/paginate';
import type { Principal } from '../src/types/api';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

const NOW = 1_700_000_000_000;

const PRINCIPAL: Principal = { type: 'work_item', id: 'w1' };

function ctxFor(responses: Array<() => Response>) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
  });
  return { ctx, fake };
}

/** Drain an async generator into an array (mirrors `core/paginate.collect`). */
async function drain<T>(gen: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  return await collect(gen);
}

// ---------------------------------------------------------------------------
// the recorded vocabularies (data, exercised so the module's tables are covered)
// ---------------------------------------------------------------------------

describe('common api vocabularies', () => {
  it('exports the four principal-type vocabularies', () => {
    expect(PRINCIPAL_TYPES.relation).toContain('work_item');
    expect(PRINCIPAL_TYPES.activity).not.toContain('page'); // activities omit page
    expect(PRINCIPAL_TYPES.comment).toHaveLength(6);
  });

  it('exports the live relation-target matrix', () => {
    expect(RELATION_TARGETS.work_item).not.toContain('work_item'); // refused live
    expect(RELATION_TARGETS.test_run).toEqual(['work_item']); // asymmetric
    expect(RELATION_TARGETS.page).toContain('test_case');
  });

  it('exports the documented snippet formats', () => {
    expect(SNIPPET_FORMATS[0]).toBe('clike');
    expect(SNIPPET_FORMATS).toContain('python');
    expect(SNIPPET_FORMATS).toContain('yaml');
  });
});

// ---------------------------------------------------------------------------
// relations — /v1/relations
// ---------------------------------------------------------------------------

describe('relations api', () => {
  it('lists with the principal + required target_type in the query and paging', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 2,
          page_size: 5,
          total: 9,
          values: [{ id: 'r1', principal_type: 'work_item', target_type: 'idea', target: { id: 'i1' } }],
        }),
    ]);
    const page = await listRelations(ctx, PRINCIPAL, 'idea', { pageIndex: 2, pageSize: 5 });
    expect(page.total).toBe(9);
    expect(page.values[0]?.id).toBe('r1');
    expect(page.values[0]?.target?.id).toBe('i1');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/relations');
    expect(url.searchParams.get('principal_type')).toBe('work_item');
    expect(url.searchParams.get('principal_id')).toBe('w1');
    expect(url.searchParams.get('target_type')).toBe('idea');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  it('iterates relations as an async generator (single short page)', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'r1', target_type: 'ticket' }],
        }),
    ]);
    const items = await drain(iterateRelations(ctx, PRINCIPAL, 'ticket'));
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('r1');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/relations');
    expect(url.searchParams.get('target_type')).toBe('ticket');
  });

  it('gets one relation by id, addressed by id alone (no principal query)', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'r9', target_type: 'page' })]);
    const rel = await getRelation(ctx, 'r9');
    expect(rel.id).toBe('r9');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/relations/r9');
    expect(fake.calls[0]?.method).toBe('GET');
  });

  it('creates a relation with the principal and target in the body', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'r-new', target_type: 'idea', target: { id: 'i1' } }, { status: 201 }),
    ]);
    const input: CreateRelationInput = { target_type: 'idea', target_id: 'i1' };
    const rel = await createRelation(ctx, PRINCIPAL, input);
    expect(rel.id).toBe('r-new');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({
      principal_type: 'work_item',
      principal_id: 'w1',
      target_type: 'idea',
      target_id: 'i1',
    });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/relations');
  });

  it('deletes a relation (mirrored pair — id only)', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'r9' })]);
    const rel = await deleteRelation(ctx, 'r9');
    expect(rel.id).toBe('r9');
    expect(fake.calls[0]?.method).toBe('DELETE');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/relations/r9');
  });

  it('maps a not-found relation code to NotFoundError (exit 5)', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100801', message: '关联关系不存在' }, { status: 400 }),
    ]);
    const err = await getRelation(ctx, 'r9').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(exitCodeFor(err)).toBe(5);
  });

  it('rejects with ApiError (exit 7) on an unmapped non-2xx', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100049', message: '不支持的principal_type' }, { status: 400 }),
    ]);
    const err = await listRelations(ctx, PRINCIPAL, 'idea').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(exitCodeFor(err)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// comments — /v1/comments
// ---------------------------------------------------------------------------

describe('comments api', () => {
  it('lists with the principal in the query', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'c1', content: 'hi', is_deleted: 0, is_reply_comment: 0, attachments: [] }],
        }),
    ]);
    const page = await listComments(ctx, PRINCIPAL);
    expect(page.values[0]?.is_deleted).toBe(false); // 0/1 → boolean
    expect(page.values[0]?.is_reply_comment).toBe(false);
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/comments');
    expect(url.searchParams.get('principal_id')).toBe('w1');
  });

  it('iterates comments', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'c1', is_deleted: 0, is_reply_comment: 0, attachments: [] }],
        }),
    ]);
    const items = await drain(iterateComments(ctx, PRINCIPAL));
    expect(items).toHaveLength(1);
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/comments');
  });

  it('gets one comment, carrying the principal in the query', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'c1', content: 'hi', is_deleted: 0, is_reply_comment: 0, attachments: [] }),
    ]);
    const comment = await getComment(ctx, PRINCIPAL, 'c1');
    expect(comment.content).toBe('hi');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/comments/c1');
    expect(url.searchParams.get('principal_type')).toBe('work_item');
    expect(fake.calls[0]?.method).toBe('GET');
  });

  it('creates a comment with the principal in the body, dropping an undefined reply', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'c-new', is_deleted: 0, is_reply_comment: 0, attachments: [] }, { status: 201 }),
    ]);
    const input: CreateCommentInput = { content: 'hello' }; // reply_comment_id omitted
    const comment = await createComment(ctx, PRINCIPAL, input);
    expect(comment.id).toBe('c-new');
    expect(fake.calls[0]?.body).toEqual({
      principal_type: 'work_item',
      principal_id: 'w1',
      content: 'hello',
    });
    expect(fake.calls[0]?.body).not.toHaveProperty('reply_comment_id');
  });

  it('keeps reply_comment_id when it is provided', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'c-reply', is_deleted: 0, is_reply_comment: 1, attachments: [] }, { status: 201 }),
    ]);
    const input: CreateCommentInput = { content: 'reply', reply_comment_id: 'c0' };
    await createComment(ctx, PRINCIPAL, input);
    expect(fake.calls[0]?.body).toMatchObject({ reply_comment_id: 'c0' });
  });

  it('deletes a comment (soft delete) with the principal in the query', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'c1', is_deleted: 1, is_reply_comment: 0, attachments: [] }),
    ]);
    const comment = await deleteComment(ctx, PRINCIPAL, 'c1');
    expect(comment.is_deleted).toBe(true);
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/comments/c1');
    expect(url.searchParams.get('principal_id')).toBe('w1');
    expect(fake.calls[0]?.method).toBe('DELETE');
  });

  it('maps a missing-comment code to NotFoundError (exit 5)', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100051', message: '评论资源不存在' }, { status: 400 }),
    ]);
    const err = await getComment(ctx, PRINCIPAL, 'gone').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(exitCodeFor(err)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// attachments — /v1/attachments
// ---------------------------------------------------------------------------

describe('attachments api', () => {
  it('lists the object-level attachments without a comment_id scope', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'a1', title: 'file.png', type: 'file', file_type: 'png' }],
        }),
    ]);
    const page = await listAttachments(ctx, PRINCIPAL);
    expect(page.values[0]?.title).toBe('file.png');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/attachments');
    expect(url.searchParams.get('principal_id')).toBe('w1');
    expect(url.searchParams.has('comment_id')).toBe(false); // scope omitted
  });

  it('includes comment_id in the query when a scope is given', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'a2', title: 'snip', type: 'snippet', format: 'python' }],
        }),
    ]);
    const scope: AttachmentScope = { comment_id: 'c1' };
    await listAttachments(ctx, PRINCIPAL, scope, { pageIndex: 1, pageSize: 10 });
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.searchParams.get('comment_id')).toBe('c1');
    expect(url.searchParams.get('page_index')).toBe('1');
    expect(url.searchParams.get('page_size')).toBe('10');
  });

  it('iterates attachments, honouring a comment_id scope', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'a2', title: 'snip', type: 'snippet' }],
        }),
    ]);
    const items = await drain(iterateAttachments(ctx, PRINCIPAL, { comment_id: 'c1' }));
    expect(items).toHaveLength(1);
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('comment_id')).toBe('c1');
  });

  it('gets one attachment with and without a comment_id scope', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'a1', title: 'file.png' })]);
    const att = await getAttachment(ctx, PRINCIPAL, 'a1', { comment_id: 'c1' });
    expect(att.id).toBe('a1');
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('comment_id')).toBe('c1');
    expect(fake.calls[0]?.method).toBe('GET');
  });

  it('gets one attachment with no scope (no comment_id param)', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'a1' })]);
    await getAttachment(ctx, PRINCIPAL, 'a1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/attachments/a1');
    expect(new URL(fake.urls()[0] ?? '').searchParams.has('comment_id')).toBe(false);
  });

  it('creates a code snippet with all fields compacted into the body', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'a-new', type: 'snippet', format: 'python', content: 'x' }, { status: 201 }),
    ]);
    const input: CreateSnippetInput = {
      comment_id: 'c1',
      title: 'a.py',
      format: 'python',
      content: 'print(1)',
    };
    const att = await createSnippetAttachment(ctx, PRINCIPAL, input);
    expect(att.id).toBe('a-new');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({
      principal_type: 'work_item',
      principal_id: 'w1',
      comment_id: 'c1',
      title: 'a.py',
      format: 'python',
      content: 'print(1)',
    });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/attachments');
  });

  it('deletes an attachment (hard delete) with the comment_id scope in the query', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'a1' })]);
    const att = await deleteAttachment(ctx, PRINCIPAL, 'a1', { comment_id: 'c1' });
    expect(att.id).toBe('a1');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/attachments/a1');
    expect(url.searchParams.get('comment_id')).toBe('c1');
    expect(fake.calls[0]?.method).toBe('DELETE');
  });

  it('maps a missing-attachment code to NotFoundError (exit 5)', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100045', message: '附件不存在' }, { status: 400 }),
    ]);
    const err = await getAttachment(ctx, PRINCIPAL, 'gone').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(exitCodeFor(err)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// activities — /v1/activities (read-only)
// ---------------------------------------------------------------------------

describe('activities api', () => {
  it('lists activities (no page field on the wire)', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'ac1', template: 'create', type: 'create', summary: '创建了' }],
        }),
    ]);
    const page = await listActivities(ctx, PRINCIPAL);
    expect(page.values[0]?.template).toBe('create');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/activities');
    expect(url.searchParams.get('principal_type')).toBe('work_item');
  });

  it('iterates activities', async () => {
    const { ctx } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'ac1', template: 'update' }],
        }),
    ]);
    const items = await drain(iterateActivities(ctx, PRINCIPAL));
    expect(items).toHaveLength(1);
  });

  it('gets one activity with the principal in the query', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'ac9', template: 'relate', type: 'relate', content: { a: 1 } }),
    ]);
    const activity = await getActivity(ctx, PRINCIPAL, 'ac9');
    expect(activity.id).toBe('ac9');
    expect(activity.content).toEqual({ a: 1 });
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/activities/ac9');
    expect(url.searchParams.get('principal_id')).toBe('w1');
  });

  it('maps a missing-activity code to NotFoundError (exit 5)', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100077', message: '活动记录不存在' }, { status: 400 }),
    ]);
    const err = await getActivity(ctx, PRINCIPAL, 'gone').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(exitCodeFor(err)).toBe(5);
  });

  it('surfaces an unmapped 500 as ApiError (exit 7) while iterating', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100000', message: '内部服务错误' }, { status: 500 }),
    ]);
    const gen = iterateActivities(ctx, PRINCIPAL);
    const err = await gen.next().then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(exitCodeFor(err)).toBe(7);
  });
});
