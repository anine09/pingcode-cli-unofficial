import { describe, expect, it } from 'vitest';
import { listSprints, listUsers, listWorkItemStates, listWorkItemTypes } from '../src/api/meta';
import {
  asBooleanFlag,
  parseProject,
  parseRef,
  parseRefList,
  parseUser,
  parseWorkItem,
} from '../src/api/parse';
import { getProject, listProjects, verifyAccess } from '../src/api/projects';
import {
  createWorkItem,
  findWorkItemByIdentifier,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
} from '../src/api/workItems';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

const NOW = 1_700_000_000_000;

function ctxFor(responses: Array<() => Response>) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
  });
  return { ctx, fake };
}

describe('normalisation (design §8)', () => {
  it('turns 0/1 flags into booleans (research §6.10)', () => {
    expect(asBooleanFlag(0)).toBe(false);
    expect(asBooleanFlag(1)).toBe(true);
    expect(asBooleanFlag('0')).toBe(false);
    expect(asBooleanFlag('1')).toBe(true);
    expect(asBooleanFlag(false)).toBe(false);
    expect(asBooleanFlag(true)).toBe(true);
    expect(asBooleanFlag(undefined)).toBe(false);

    const project = parseProject({ id: 'p1', name: 'Acme', is_archived: 1, is_deleted: 0 });
    expect(project.is_archived).toBe(true);
    expect(project.is_deleted).toBe(false);
  });

  it('normalises `versions` (array) and `version` (object) to one array (research §4.2)', () => {
    const fromList = parseWorkItem({
      id: 'w1',
      versions: [{ id: 'v1', name: '1.0' }, { id: 'v2' }],
    });
    expect(fromList.versions.map((v) => v.id)).toEqual(['v1', 'v2']);

    const fromSingle = parseWorkItem({ id: 'w1', version: { id: 'v9', name: '9.0' } });
    expect(fromSingle.versions).toHaveLength(1);
    expect(fromSingle.versions[0]?.id).toBe('v9');

    expect(parseWorkItem({ id: 'w1' }).versions).toEqual([]);
  });

  it('keeps timestamps as raw unix seconds (research §7)', () => {
    const item = parseWorkItem({ id: 'w1', created_at: 1578897962, end_at: '1578897999' });
    expect(item.created_at).toBe(1578897962);
    expect(item.end_at).toBe(1578897999);
  });

  it('preserves unknown fields and custom properties for --json consumers', () => {
    const item = parseWorkItem({
      id: 'w1',
      title: 'x',
      properties: { prop_a: 'custom' },
      future_field: 'kept',
    });
    expect(item.properties).toEqual({ prop_a: 'custom' });
    expect(item.future_field).toBe('kept');
  });

  it('parses reference structures and drops ones without an id', () => {
    expect(parseRef({ id: 'a', name: 'A', url: 'u' })).toMatchObject({ id: 'a', name: 'A' });
    expect(parseRef({ name: 'no id' })).toBeUndefined();
    expect(parseRefList([{ id: 'a' }, 'junk', { name: 'x' }])).toHaveLength(1);
    expect(parseRefList('nope')).toEqual([]);
  });

  it('tolerates id shapes of every kind (research §6.8)', () => {
    expect(parseWorkItem({ id: 'w', type: { id: 'story', name: '用户故事' } }).type?.id).toBe('story');
    expect(parseUser({ id: 'a0417f68e846aae315c85d24643678a9' }).id).toHaveLength(32);
    expect(parseProject({ id: '5eb623f6a70571487ea47000' }).id).toHaveLength(24);
  });
});

describe('projects api', () => {
  it('lists projects through the standard envelope', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'p1', name: 'Acme', is_archived: 0, is_deleted: 0 }],
        }),
    ]);
    const page = await listProjects(ctx, { keywords: 'Acme', include_archived: false });
    expect(page.total).toBe(1);
    expect(page.values[0]?.name).toBe('Acme');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/pjm/projects');
    expect(url.searchParams.get('keywords')).toBe('Acme');
    expect(url.searchParams.get('include_archived')).toBe('false');
  });

  it('gets one project by id', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'p1', name: 'Acme', is_archived: 1 })]);
    const project = await getProject(ctx, 'p1', { include_archived: true });
    expect(project.is_archived).toBe(true);
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/pjm/projects/p1');
  });

  it('verifies access with a capability call, not /v1/myself (design §4.3)', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 1, total: 7, values: [] }),
    ]);
    expect(await verifyAccess(ctx)).toBe(7);
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/pjm/projects');
    expect(url.searchParams.get('page_size')).toBe('1');
    expect(fake.urls().join()).not.toContain('/v1/myself');
  });
});

describe('work items api', () => {
  it('lists with filters and paging', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 1,
          page_size: 5,
          total: 9,
          values: [{ id: 'w1', title: 'a', is_archived: 0, is_deleted: 0 }],
        }),
    ]);
    const page = await listWorkItems(
      ctx,
      { project_id: 'p1', type_id: 'story', state_id: 's1' },
      { pageIndex: 1, pageSize: 5 },
    );
    expect(page.values[0]?.title).toBe('a');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/pjm/work_items');
    expect(url.searchParams.get('type_id')).toBe('story');
    expect(url.searchParams.get('page_index')).toBe('1');
  });

  it('gets a work item by id or short_id', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: 'w1', short_id: '1bAqLmTG', identifier: 'SCR-5' }),
    ]);
    const item = await getWorkItem(ctx, '1bAqLmTG');
    expect(item.identifier).toBe('SCR-5');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/pjm/work_items/1bAqLmTG');
  });

  it('finds by identifier through the list endpoint', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 10, total: 1, values: [{ id: 'w1' }] }),
    ]);
    const found = await findWorkItemByIdentifier(ctx, 'SCR-5');
    expect(found).toHaveLength(1);
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('identifier')).toBe('SCR-5');
  });

  it('creates with a compacted body', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'new' }, { status: 201 })]);
    const created = await createWorkItem(ctx, {
      project_id: 'p1',
      type_id: 'task',
      title: 'hello',
      description: undefined,
      assignee_id: 'u1',
    });
    expect(created.id).toBe('new');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({
      project_id: 'p1',
      type_id: 'task',
      title: 'hello',
      assignee_id: 'u1',
    });
  });

  it('patches only the provided fields (design §7.2)', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'w1', state: { id: 's2' } })]);
    await updateWorkItem(ctx, 'w1', { state_id: 's2', title: undefined });
    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ state_id: 's2' });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/pjm/work_items/w1');
  });
});

describe('meta api', () => {
  it('lists work item types for a project', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 100,
          total: 2,
          values: [{ id: 'story', name: '用户故事' }, { id: 'bug', name: '缺陷' }],
        }),
    ]);
    const types = await listWorkItemTypes(ctx, 'p1');
    expect(types.map((t) => t.id)).toEqual(['story', 'bug']);
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('project_id')).toBe('p1');
  });

  it('requires both project and type for states', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 's1', name: 'Done' }] }),
    ]);
    await listWorkItemStates(ctx, 'p1', 'story');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/pjm/work_item/states');
    expect(url.searchParams.get('project_id')).toBe('p1');
    expect(url.searchParams.get('work_item_type_id')).toBe('story');
  });

  it('lists sprints under the project path', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 100,
          total: 1,
          values: [{ id: 'sp1', name: 'Sprint 1', status: 'in_progress' }],
        }),
    ]);
    const sprints = await listSprints(ctx, 'p1', { status: 'in_progress' });
    expect(sprints[0]?.status).toBe('in_progress');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/pjm/projects/p1/sprints');
  });

  it('lists directory users with CSV params', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'a0417f68e846aae315c85d24643678a9', name: '张三', is_deleted: 0 }],
        }),
    ]);
    const page = await listUsers(ctx, { emails: ['a@x.com', 'b@x.com'] });
    expect(page.values[0]?.is_deleted).toBe(false);
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('emails')).toBe('a@x.com,b@x.com');
  });
});
