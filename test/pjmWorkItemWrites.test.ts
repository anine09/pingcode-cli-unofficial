import { describe, expect, it } from 'vitest';
import { parseWorkItem, parseWorkItemLink, parseWorkItemTransitionHistory } from '../src/api/parse';
import {
  addProjectMember,
  createProject,
  getProjectMember,
  getProjectProgress,
  listProjectMembers,
  updateProject,
} from '../src/api/projects';
import {
  addWorkItemTag,
  bulkUpdateWorkItems,
  createWorkItemLink,
  deleteWorkItem,
  deleteWorkItemLink,
  deleteWorkItemTag,
  getWorkItemLink,
  getWorkItemTag,
  getWorkItemTransitionHistory,
  iterateSearchWorkItems,
  listWorkItemLinks,
  listWorkItemRelationTypes,
  listWorkItemTagVocabulary,
  listWorkItemTransitionHistories,
  searchWorkItems,
} from '../src/api/workItems';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { CATALOG } from '../src/core/catalog';
import { ENDPOINTS } from '../src/core/endpoints';
import { DryRunHalt } from '../src/core/errors';
import { META_KINDS, specOf } from '../src/core/metadata';
import { collect } from '../src/core/paginate';
import { ERROR_CODE_OVERRIDES } from '../src/core/wire';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S2b: the 工作项 write surface (bulk update, delete, typed links, tags, transition
 * history) and the 项目 write surface (create, update, progress, members) — paths,
 * bodies, normalisation, and the live facts the wrappers exist to encode.
 *
 * Injected `fetch`, zero network. What carries the weight here is the same as in
 * `test/pjmPlanning.test.ts`: the **absences** and the **contradictions**, because both
 * are what a later contributor would "fix".
 *
 *  - **no `listWorkItemTags`.** `GET …/work_items/{id}/tags` does not exist upstream
 *    (research §3.8.3): add, get-one and delete do. The work item's own `tags[]` is the
 *    only way to see them all.
 *  - **no `deleteProject` and no `removeProjectMember`.** The first does not exist at
 *    all; the second does and is deliberately left to the generic layer (the endpoint
 *    budget this child owns is 20, and `pingcode api DELETE … --yes` already reaches
 *    it).
 *  - **no paging on the work-item search.** Live 2026-08-04 it answers
 *    `page_index: 0, page_size: 30` whatever it is asked for, in the payload, at the top
 *    level, or in the query string. This is the one place pjm is *not* isomorphic to
 *    ship (design §14.1), so the test pins the behaviour rather than the intention.
 *  - **a work item's `type` is a bare slug string**, contradicting
 *    `research/s8-smoke.md` F1, which recorded the field as absent. The parser used to
 *    discard it.
 *
 * The command layer lives in `test/pjmWorkItemCommands.test.ts`.
 */

const NOW = 1_700_000_000_000;

/** Realistic 24-hex / 32-hex shapes, as the S2b smoke produced them. */
const PROJECT = '6a1c41781c7734aaad9ec23c';
const ITEM = '6a717840a2f1bc8bb00ec342';
const OTHER_ITEM = '6a717841a2f1bc8bb00ec34a';
const LINK = '6a7178503e127a186f112409';
const TAG = '6a28fbdc8e6e0432aa7f7b79';
const HISTORY = '6a717840a2f1bc8bb00ec348';
const USER = 'f5712155d0e54d0b94ffacb1384217f0';
const STATE = '68389e7f33ee52bc5c2584d0';

function ctxFor(responses: Array<() => Response>, options: { dryRun?: boolean } = {}) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
    useCache: false,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { ctx, fake };
}

function envelope(values: unknown[], page = { page_index: 0, page_size: 100 }): Response {
  return jsonResponse({ ...page, total: values.length, values });
}

// ---------------------------------------------------------------------------
// paths and the catalog
// ---------------------------------------------------------------------------

describe('work-item and project write endpoint paths', () => {
  it('builds every path S2b adds, percent-encoding each segment', () => {
    expect(ENDPOINTS.workItemsSearch).toBe('/v1/pjm/work_items/search');
    expect(ENDPOINTS.workItemRelations(ITEM)).toBe(`/v1/pjm/work_items/${ITEM}/relations`);
    expect(ENDPOINTS.workItemRelation(ITEM, LINK)).toBe(
      `/v1/pjm/work_items/${ITEM}/relations/${LINK}`,
    );
    expect(ENDPOINTS.workItemTags(ITEM)).toBe(`/v1/pjm/work_items/${ITEM}/tags`);
    expect(ENDPOINTS.workItemTag(ITEM, TAG)).toBe(`/v1/pjm/work_items/${ITEM}/tags/${TAG}`);
    expect(ENDPOINTS.workItemTransitionHistories(ITEM)).toBe(
      `/v1/pjm/work_items/${ITEM}/transition_histories`,
    );
    expect(ENDPOINTS.workItemTransitionHistory(ITEM, HISTORY)).toBe(
      `/v1/pjm/work_items/${ITEM}/transition_histories/${HISTORY}`,
    );
    expect(ENDPOINTS.projectProgress(PROJECT)).toBe(`/v1/pjm/projects/${PROJECT}/progress`);
    expect(ENDPOINTS.projectMembers(PROJECT)).toBe(`/v1/pjm/projects/${PROJECT}/members`);
    expect(ENDPOINTS.projectMember(PROJECT, USER)).toBe(
      `/v1/pjm/projects/${PROJECT}/members/${USER}`,
    );

    expect(ENDPOINTS.workItemRelation('a/b', 'c d')).toBe(
      '/v1/pjm/work_items/a%2Fb/relations/c%20d',
    );
    expect(ENDPOINTS.projectMember('a/b', 'c d')).toBe('/v1/pjm/projects/a%2Fb/members/c%20d');
  });

  it('keeps the two singular-segment vocabularies singular', () => {
    // `/v1/pjm/work_item/…` (config views of a container) vs `/v1/pjm/work_items/…`
    // (the resource). Both exist, and mixing them up is a 404 rather than an error you
    // can reason about (design D7.5 item 1).
    expect(ENDPOINTS.workItemRelationTypes).toBe('/v1/pjm/work_item/relation_types');
    expect(ENDPOINTS.workItemTagVocabulary).toBe('/v1/pjm/work_item/tags');
    expect(ENDPOINTS.workItems).toBe('/v1/pjm/work_items');
  });

  it('matches the catalog on exactly the twenty endpoints S2b owns', () => {
    const owned = new Set([
      'POST /v1/pjm/work_items/search',
      'PATCH /v1/pjm/work_items',
      'DELETE /v1/pjm/work_items/{work_item_id}',
      'POST /v1/pjm/work_items/{work_item_id}/relations',
      'GET /v1/pjm/work_items/{work_item_id}/relations',
      'GET /v1/pjm/work_items/{work_item_id}/relations/{relation_id}',
      'DELETE /v1/pjm/work_items/{work_item_id}/relations/{relation_id}',
      'POST /v1/pjm/work_items/{work_item_id}/tags',
      'GET /v1/pjm/work_items/{work_item_id}/tags/{tag_id}',
      'DELETE /v1/pjm/work_items/{work_item_id}/tags/{tag_id}',
      'GET /v1/pjm/work_items/{work_item_id}/transition_histories',
      'GET /v1/pjm/work_items/{work_item_id}/transition_histories/{transition_history_id}',
      'GET /v1/pjm/work_item/relation_types',
      'GET /v1/pjm/work_item/tags',
      'POST /v1/pjm/projects',
      'PATCH /v1/pjm/projects/{project_id}',
      'GET /v1/pjm/projects/{project_id}/progress',
      'POST /v1/pjm/projects/{project_id}/members',
      'GET /v1/pjm/projects/{project_id}/members',
      'GET /v1/pjm/projects/{project_id}/members/{member_id}',
    ]);
    expect(owned.size).toBe(20);
    const documented = new Set(
      CATALOG.filter((entry) => owned.has(`${entry.method} ${entry.path}`)).map(
        (entry) => `${entry.method} ${entry.path}`,
      ),
    );
    expect(documented).toEqual(owned);
  });

  it('has no work-item tag LIST to wrap, and no project DELETE either', () => {
    // Both absences are upstream's, both look like oversights, and both would be
    // "completed" by someone who did not check. `project member remove` *does* exist
    // upstream and is intentionally not wrapped — see the module header.
    const verbs = (path: string) =>
      CATALOG.filter((entry) => entry.path === path)
        .map((entry) => entry.method)
        .sort();
    expect(verbs('/v1/pjm/work_items/{work_item_id}/tags')).toEqual(['POST']);
    expect(verbs('/v1/pjm/work_items/{work_item_id}/tags/{tag_id}')).toEqual(['DELETE', 'GET']);
    expect(verbs('/v1/pjm/projects/{project_id}')).toEqual(['GET', 'PATCH']);
    expect(verbs('/v1/pjm/projects/{project_id}/members/{member_id}')).toEqual([
      'DELETE',
      'GET',
      'PATCH',
    ]);
  });

  it('documents the bulk update as one property, not a patch object', () => {
    // This is the fact that shapes `BulkUpdateWorkItemsInput`: `{ids, property_name,
    // property_value}`, so two properties need two calls.
    const entry = CATALOG.find((row) => row.method === 'PATCH' && row.path === '/v1/pjm/work_items');
    expect(entry?.body.map((field) => field.name)).toEqual([
      'ids',
      'property_name',
      'property_value',
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/pjm/work_items/search
// ---------------------------------------------------------------------------

describe('searchWorkItems', () => {
  it('sends the documented envelope and the filter verbatim', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: ITEM }], { page_index: 0, page_size: 30 })]);
    await searchWorkItems(
      ctx,
      { filter: { 'project.id': { in: [PROJECT] }, type: { in: ['task'] } }, keywords: 'login' },
      { pageIndex: 0, pageSize: 30 },
    );

    const call = fake.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toContain('/v1/pjm/work_items/search');
    expect(call?.body).toEqual({
      mode: 'query',
      payload: {
        filter: { 'project.id': { in: [PROJECT] }, type: { in: ['task'] } },
        keywords: 'login',
        page_index: 0,
        page_size: 30,
      },
    });
  });

  it('uses `type` (a bare slug), not `type.id`, for the work-item type filter', () => {
    // Live 2026-08-04: `type.id`, `type_id`, `work_item_type_id` are all 400 `100043`
    // `不支持使用过滤条件`, while `type` with the slug works and is enum-validated. The
    // query-string list uses `type_id`, so the two read paths genuinely differ.
    const filter: Record<string, unknown> = { type: { in: ['bug'] } };
    expect(Object.keys(filter)).toEqual(['type']);
  });

  it('still runs under --dry-run, because a search is a read', async () => {
    // `core/paginate.ts` bypasses the verb-based dry-run gate for `…/search` only.
    const { ctx, fake } = ctxFor([() => envelope([{ id: ITEM }])], { dryRun: true });
    const page = await searchWorkItems(ctx, { keywords: 'x' });
    expect(page.values).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
  });

  it('stops after one page when the endpoint refuses to advance the cursor', async () => {
    // The live behaviour: `page_index` is echoed as 0 no matter what was requested, so
    // `walkPages`' echo guard fires on the second fetch and warns instead of looping.
    // Two pages of full size would otherwise be walked forever.
    const rows = Array.from({ length: 2 }, (_, index) => ({ id: `w${index}` }));
    const { ctx, fake } = ctxFor([() => jsonResponse({ page_index: 0, page_size: 2, total: 195, values: rows })]);
    const collected = await collect(iterateSearchWorkItems(ctx, {}, { pageSize: 2 }));
    expect(collected).toHaveLength(2);
    // Exactly two calls: page 0, then page 1 whose echoed index betrays the problem.
    expect(fake.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/pjm/work_items and DELETE /v1/pjm/work_items/{id}
// ---------------------------------------------------------------------------

describe('bulkUpdateWorkItems', () => {
  it('sends ids, one property name and one value', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ inserts: 0, updates: 2, deletes: 0 })]);
    const result = await bulkUpdateWorkItems(ctx, {
      ids: [ITEM, OTHER_ITEM],
      property_name: 'state_id',
      property_value: STATE,
    });

    const call = fake.calls[0];
    expect(call?.method).toBe('PATCH');
    expect(call?.url).toContain('/v1/pjm/work_items');
    expect(call?.url).not.toContain('/search');
    expect(call?.body).toEqual({
      ids: [ITEM, OTHER_ITEM],
      property_name: 'state_id',
      property_value: STATE,
    });
    expect(result.updates).toBe(2);
  });

  it('sends `property_value` even when it is falsy, because omitting it CLEARS the field', async () => {
    // Live 2026-08-04: a body without `property_value` answered `updates: 1` and
    // emptied the field. So `compact()` must not be used on this body — and it is not.
    const { ctx, fake } = ctxFor([() => jsonResponse({ inserts: 0, updates: 1, deletes: 0 })]);
    await bulkUpdateWorkItems(ctx, { ids: [ITEM], property_name: 'story_points', property_value: 0 });
    expect(fake.calls[0]?.body).toEqual({
      ids: [ITEM],
      property_name: 'story_points',
      property_value: 0,
    });
  });

  it('reports the counts undefined rather than zero when the API omits them', async () => {
    // Zero is a *meaningful* answer here — "accepted and ignored" — so it must not be
    // manufactured by the parser.
    const { ctx } = ctxFor([() => jsonResponse({})]);
    const result = await bulkUpdateWorkItems(ctx, {
      ids: [ITEM],
      property_name: 'title',
      property_value: 'x',
    });
    expect(result.updates).toBeUndefined();
  });

  it('halts under --dry-run without sending anything', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({})], { dryRun: true });
    await expect(
      bulkUpdateWorkItems(ctx, { ids: [ITEM], property_name: 'title', property_value: 'x' }),
    ).rejects.toBeInstanceOf(DryRunHalt);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('deleteWorkItem', () => {
  it('DELETEs the item path and returns the deleted work item', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: ITEM, identifier: 'YYHC-219', title: 'x' })]);
    const item = await deleteWorkItem(ctx, ITEM);
    expect(fake.calls[0]?.method).toBe('DELETE');
    expect(fake.calls[0]?.url).toContain(`/v1/pjm/work_items/${ITEM}`);
    expect(item.identifier).toBe('YYHC-219');
  });

  it('halts under --dry-run', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({})], { dryRun: true });
    await expect(deleteWorkItem(ctx, ITEM)).rejects.toBeInstanceOf(DryRunHalt);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// typed links
// ---------------------------------------------------------------------------

describe('work-item links (the typed, same-kind family)', () => {
  it('creates a link with a target and a relation type', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: LINK, relation_type: 'relate', origin_work_item: { id: ITEM } }),
    ]);
    const link = await createWorkItemLink(ctx, ITEM, {
      target_work_item_id: OTHER_ITEM,
      relation_type: 'relate',
    });
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.url).toContain(`/v1/pjm/work_items/${ITEM}/relations`);
    expect(fake.calls[0]?.body).toEqual({
      target_work_item_id: OTHER_ITEM,
      relation_type: 'relate',
    });
    expect(link.relation_type).toBe('relate');
  });

  it('filters the list by relation type and walks pages normally', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: LINK }], { page_index: 1, page_size: 5 })]);
    const page = await listWorkItemLinks(ctx, ITEM, { relation_type: 'block' }, {
      pageIndex: 1,
      pageSize: 5,
    });
    expect(fake.calls[0]?.url).toContain('relation_type=block');
    expect(fake.calls[0]?.url).toContain('page_index=1');
    expect(page.pageIndex).toBe(1);
  });

  it('addresses one link under its own work item, and deletes it there', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: LINK, relation_type: 'relate' }),
      () => jsonResponse({ id: LINK, relation_type: 'relate' }),
    ]);
    await getWorkItemLink(ctx, ITEM, LINK);
    await deleteWorkItemLink(ctx, ITEM, LINK);
    expect(fake.calls[0]?.url).toContain(`/v1/pjm/work_items/${ITEM}/relations/${LINK}`);
    expect(fake.calls[1]?.method).toBe('DELETE');
  });

  it('parses the two richer ends without flattening them', () => {
    // `origin_work_item` / `target_work_item` carry identifier, title, type, short_id
    // and html_url — more than a `Ref` — and all of it must survive into `--json`.
    const link = parseWorkItemLink({
      id: LINK,
      relation_type: 'blocked_by',
      target_work_item: { id: OTHER_ITEM, identifier: 'YYHC-220', title: 'b', type: 'task' },
    });
    expect(link.target_work_item?.id).toBe(OTHER_ITEM);
    expect(link.target_work_item?.identifier).toBe('YYHC-220');
    expect(link.relation_type).toBe('blocked_by');
  });
});

describe('relation type vocabulary', () => {
  it('loads the whole list with no parameters at all', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        envelope([
          { id: 'r1', name: '关联', category: 'relate', is_system: 1 },
          { id: 'r2', name: '阻塞', category: 'block', is_system: 1 },
        ]),
    ]);
    const types = await listWorkItemRelationTypes(ctx);
    expect(fake.calls[0]?.url).toContain('/v1/pjm/work_item/relation_types');
    expect(fake.calls[0]?.url).not.toContain('project_id');
    expect(types.map((type) => type.category)).toEqual(['relate', 'block']);
    // `is_system` arrives as 0/1 and is normalised exactly once, here.
    expect(types[0]?.is_system).toBe(true);
  });

  it('is a resolvable metadata kind with no parent, keyed on name or category', () => {
    expect(META_KINDS).toContain('pjm-relation-type');
    const spec = specOf('pjm-relation-type');
    expect(spec.parent).toBeUndefined();
    expect(spec.parentQuery).toBeUndefined();
    expect(spec.aliases).toContain('category');
    expect(spec.cacheOnly).toBeUndefined();
  });

  it('has a pjm-work-item-tag resolver for list filtering, despite the endpoint quirks', () => {
    // The tag endpoint ignores `project_id` (returns the whole org list) and tag
    // names are not unique, so a resolver here is a compromise: it works for
    // filtering (the resolved id is valid server-side) but may hit ambiguity
    // errors for common names. The full argument is in `core/metadata/registry.ts`.
    expect(META_KINDS).toContain('pjm-work-item-tag');
    const spec = specOf('pjm-work-item-tag');
    expect(spec.parent).toBe('project');
    expect(spec.path).toBe(ENDPOINTS.workItemTagVocabulary);
  });
});

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

describe('work-item tags', () => {
  it('adds, reads and removes one tag by its tag id', async () => {
    const attachment = { id: TAG, tag: { id: TAG, name: '前端' }, work_item: { id: ITEM } };
    const { ctx, fake } = ctxFor([
      () => jsonResponse(attachment),
      () => jsonResponse(attachment),
      () => jsonResponse(attachment),
    ]);

    const added = await addWorkItemTag(ctx, ITEM, TAG);
    await getWorkItemTag(ctx, ITEM, TAG);
    await deleteWorkItemTag(ctx, ITEM, TAG);

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({ tag_id: TAG });
    expect(fake.calls[1]?.url).toContain(`/v1/pjm/work_items/${ITEM}/tags/${TAG}`);
    expect(fake.calls[2]?.method).toBe('DELETE');
    // The attachment's own `id` is the tag's id; the name only exists nested.
    expect(added.id).toBe(TAG);
    expect(added.tag?.name).toBe('前端');
  });

  it('sends the required `project_id` on the vocabulary read even though it does not filter', async () => {
    // Live 2026-08-04: three projects returned identical rows. The parameter is still
    // mandatory (an unknown project is 400 `100300`), so it is sent — and the help says
    // what it does and does not do.
    const { ctx, fake } = ctxFor([() => envelope([{ id: TAG, name: '前端' }])]);
    await listWorkItemTagVocabulary(ctx, PROJECT, { name: '前' });
    expect(fake.calls[0]?.url).toContain(`project_id=${PROJECT}`);
    expect(fake.calls[0]?.url).toContain('name=');
  });
});

// ---------------------------------------------------------------------------
// transition history
// ---------------------------------------------------------------------------

describe('transition histories', () => {
  it('lists and gets, and reads the creation row as having no from_state', async () => {
    const { ctx, fake } = ctxFor([
      () => envelope([{ id: HISTORY, from_state: null, to_state: { id: 's1', name: '打开' } }]),
      () => jsonResponse({ id: HISTORY, from_state: null, to_state: { id: 's1', name: '打开' } }),
    ]);
    const page = await listWorkItemTransitionHistories(ctx, ITEM);
    const one = await getWorkItemTransitionHistory(ctx, ITEM, HISTORY);

    expect(fake.calls[0]?.url).toContain(`/v1/pjm/work_items/${ITEM}/transition_histories`);
    expect(fake.calls[1]?.url).toContain(`/transition_histories/${HISTORY}`);
    expect(page.values[0]?.from_state).toBeUndefined();
    expect(one.to_state?.name).toBe('打开');
  });

  it('keeps its own shape rather than sharing ship\'s deserializer', () => {
    // pjm's row is `{from_state, to_state, created_by, created_at}`; ship's has its own
    // fields. One parser per shape, the [TH§11] rule.
    const row = parseWorkItemTransitionHistory({
      id: HISTORY,
      from_state: { id: 'a', name: '打开' },
      to_state: { id: 'b', name: '进行中' },
      created_by: { id: USER, name: 'luoxiutao' },
      created_at: 1785821248,
    });
    expect(row.from_state?.name).toBe('打开');
    expect(row.created_at).toBe(1785821248);
  });
});

// ---------------------------------------------------------------------------
// project writes, progress and members
// ---------------------------------------------------------------------------

describe('project create and update', () => {
  it('sends the three required fields and drops nothing else it was given', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ id: PROJECT, name: 'p', identifier: 'CLIS2B', type: 'scrum' }),
    ]);
    await createProject(ctx, {
      type: 'scrum',
      name: 'p',
      identifier: 'CLIS2B',
      description: 'd',
      members: [{ id: USER, type: 'user' }],
    });
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.url).toContain('/v1/pjm/projects');
    expect(fake.calls[0]?.body).toEqual({
      type: 'scrum',
      name: 'p',
      identifier: 'CLIS2B',
      description: 'd',
      members: [{ id: USER, type: 'user' }],
    });
  });

  it('patches only what it was given', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: PROJECT, name: 'renamed' })]);
    await updateProject(ctx, PROJECT, { name: 'renamed' });
    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ name: 'renamed' });
  });

  it('parses the fields a create echoes that a list never showed', async () => {
    // `visibility`, `process_id`, `state`, `assignee` and the window: all present on
    // create, and all of them read-only or not-patchable in the case of the first two.
    const { ctx } = ctxFor([
      () =>
        jsonResponse({
          id: PROJECT,
          visibility: 'private',
          process_id: '68389e7f33ee52bc5c2584c4',
          state: { id: 'st', name: '未开始', type: 'pending' },
          assignee: { id: USER, name: 'luoxiutao' },
          start_at: 1790827200,
          end_at: 1793419200,
          is_archived: 0,
        }),
    ]);
    const project = await updateProject(ctx, PROJECT, { name: 'x' });
    expect(project.visibility).toBe('private');
    expect(project.state?.name).toBe('未开始');
    expect(project.assignee?.name).toBe('luoxiutao');
    // Verbatim instants, NOT snapped to a day boundary the way a sprint's are.
    expect(project.start_at).toBe(1790827200);
    expect(project.is_archived).toBe(false);
  });
});

describe('project progress', () => {
  it('reads a bare count object, not a page envelope', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          work_item: { total: 183, pending_count: 52, in_progress_count: 12, completed_count: 119 },
        }),
    ]);
    const progress = await getProjectProgress(ctx, PROJECT);
    expect(fake.calls[0]?.url).toContain(`/v1/pjm/projects/${PROJECT}/progress`);
    // No paging parameters are sent: the catalog calls this `paged`, the API does not.
    expect(fake.calls[0]?.url).not.toContain('page_index');
    expect(progress.work_item?.total).toBe(183);
    expect(progress.work_item?.completed_count).toBe(119);
  });
});

describe('project members', () => {
  it('adds a member as a {member, role_id} pair', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: USER, type: 'user' })]);
    await addProjectMember(ctx, PROJECT, {
      member: { id: USER, type: 'user' },
      role_id: '100000000000000000000003',
    });
    expect(fake.calls[0]?.body).toEqual({
      member: { id: USER, type: 'user' },
      role_id: '100000000000000000000003',
    });
  });

  it('omits role_id when none was given, letting the API default to 普通成员', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: USER })]);
    await addProjectMember(ctx, PROJECT, { member: { id: USER, type: 'user' } });
    expect(fake.calls[0]?.body).toEqual({ member: { id: USER, type: 'user' } });
  });

  it('lists members and reads one by the USER id, not a membership id', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        envelope([
          {
            id: USER,
            type: 'user',
            user: { id: USER, name: 'luoxiutao', display_name: '骆秀韬' },
            role: { id: 'r', name: '管理员' },
          },
        ]),
      () => jsonResponse({ id: USER, type: 'user', user: { id: USER, name: 'luoxiutao' } }),
    ]);
    const page = await listProjectMembers(ctx, PROJECT);
    const one = await getProjectMember(ctx, PROJECT, USER);
    expect(page.values[0]?.user?.display_name).toBe('骆秀韬');
    expect(page.values[0]?.role?.name).toBe('管理员');
    expect(fake.calls[1]?.url).toContain(`/members/${USER}`);
    expect(one.id).toBe(USER);
  });
});

// ---------------------------------------------------------------------------
// the parser correction
// ---------------------------------------------------------------------------

describe('work-item `type` is a slug string on the wire', () => {
  it('keeps the string instead of discarding it through parseRef', () => {
    // `research/s8-smoke.md` F1 recorded this field as absent from every payload, and
    // the CLI was built on that: `parseRef('task')` is `undefined`, so the TYPE column
    // was blank and `--json` lost the key. Live 2026-08-04 it is present on all three
    // read paths.
    expect(parseWorkItem({ id: ITEM, type: 'task' }).type).toBe('task');
    expect(parseWorkItem({ id: ITEM }).type).toBeUndefined();
    expect(parseWorkItem({ id: ITEM, type: '' }).type).toBeUndefined();
  });

  it('survives into --json rather than being replaced by undefined', () => {
    const item = parseWorkItem({ id: ITEM, type: 'epic', title: 't' });
    expect(JSON.parse(JSON.stringify(item)).type).toBe('epic');
  });
});

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

describe('error code overrides S2b added', () => {
  it('maps the three composite-key absences and nothing else from this smoke', () => {
    expect(ERROR_CODE_OVERRIDES['100351']).toBe('not_found');
    expect(ERROR_CODE_OVERRIDES['1003108']).toBe('not_found');
    expect(ERROR_CODE_OVERRIDES['100405']).toBe('not_found');
  });

  it('leaves the tag codes, the conflicts and the filter validation on exit 7', () => {
    // `100354` names a tag the user can see (the vocabulary is org-wide, the write is
    // project-scoped) — S2a's `100300` mistake. `100357` is a real pair absence whose
    // DELETE twin answers HTTP 500, so mapping it would split one mistake in two.
    for (const code of ['100354', '100357', '100350', '100352', '100407', '100043', '100044']) {
      expect(ERROR_CODE_OVERRIDES[code], code).toBeUndefined();
    }
    // Reaffirmed: `100300` stays out, even though S2b met three cases where it really
    // does mean "no such project".
    expect(ERROR_CODE_OVERRIDES['100300']).toBeUndefined();
  });
});
