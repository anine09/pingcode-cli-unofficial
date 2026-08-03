import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  findById,
  findByMethodPath,
  matchPath,
  methodsFor,
  missingRequired,
  normalizePath,
  PAGED_OVERRIDE_KEYS,
  unfilledPathParams,
  type CatalogEntry,
  type CatalogMethod,
} from '../src/core/catalog/index';
import { ENDPOINTS } from '../src/core/endpoints';
import {
  declaredHash,
  deriveCatalog,
  deriveId,
  diffCatalogs,
  EXPECTED_ENTRIES,
  isClean,
  normalizeMethod,
  parseGenerated,
  renderGenerated,
  sha256,
  splitGenerated,
} from '../scripts/catalog-sync';

/**
 * The catalog is data, and data gets four kinds of test (design D2.4/D2.8):
 *
 *  1. **integrity** — the vendored file still hashes to what its header claims,
 *     so a hand edit is a red build rather than a silent lie;
 *  2. **counts** — 459 entries, every one `/v1`, and the two histograms that
 *     cross-check the scrape against research §2 from independent directions;
 *  3. **matching** — the algorithm `pingcode api` will route on, including the
 *     singular/plural area trap that has bitten every module so far;
 *  4. **derivation** — the generator's pure functions, against a fixture, so
 *     nothing here needs the network.
 */

const generatedPath = fileURLToPath(new URL('../src/core/catalog/catalog.generated.ts', import.meta.url));
const generatedText = readFileSync(generatedPath, 'utf8');

describe('generated file integrity', () => {
  it('hashes to the value its provenance header declares', () => {
    const { body } = splitGenerated(generatedText);
    expect(declaredHash(generatedText)).toBe(sha256(body));
  });

  it('fails the hash check when a single byte of the body changes', () => {
    const { body } = splitGenerated(generatedText);
    const tampered = body.replace('"id":"', '"iD":"');
    expect(tampered).not.toBe(body);
    expect(sha256(tampered)).not.toBe(declaredHash(generatedText));
  });

  it('declares its source, snapshot date and entry count in the header', () => {
    const { header } = splitGenerated(generatedText);
    expect(header).toContain('GENERATED FILE — DO NOT EDIT.');
    expect(header).toContain('source:   https://open.pingcode.com/api_data.js');
    expect(header).toMatch(/snapshot: \d{4}-\d{2}-\d{2}/);
    expect(header).toMatch(/upstream sha256: [0-9a-f]{64}/);
    expect(header).toContain(`entries:  ${EXPECTED_ENTRIES}`);
  });

  it('round-trips through the reader `catalog:check` uses', () => {
    const parsed = parseGenerated(generatedText);
    expect(parsed).toHaveLength(EXPECTED_ENTRIES);
    expect(parsed.map((e) => e.id)).toEqual(CATALOG.map((e) => e.id));
  });
});

function histogram<T extends string>(values: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

describe('catalog counts', () => {
  it('holds exactly 459 entries', () => {
    expect(CATALOG).toHaveLength(459);
    expect(EXPECTED_ENTRIES).toBe(459);
  });

  it('has no path outside /v1', () => {
    expect(CATALOG.filter((e) => !e.path.startsWith('/v1/')).map((e) => e.path)).toEqual([]);
  });

  it('excludes the oauth2 authorize page', () => {
    // Not `/v1`, not JSON, and a browser redirect rather than a callable
    // endpoint (design D2.8). `pingcode api` must treat it as an unknown path.
    expect(CATALOG.some((e) => e.path.includes('authorize'))).toBe(false);
    expect(matchPath('/oauth2/authorize')).toEqual([]);
  });

  it('matches the method histogram', () => {
    expect(histogram(CATALOG.map((e) => e.method))).toEqual({
      GET: 250,
      POST: 96,
      PATCH: 54,
      DELETE: 49,
      PUT: 10,
    });
  });

  it('matches the token-type histogram, with the three token-less grants', () => {
    expect(histogram(CATALOG.map((e) => e.tokenType ?? '(none)'))).toEqual({
      APP: 388,
      ENT: 61,
      USER: 7,
      '(none)': 3,
    });
    // The three that need no token are exactly the ways to get one, which is
    // what design D2.3 assumed and why the union stays three-valued.
    expect(CATALOG.filter((e) => e.tokenType === undefined).map((e) => e.id).sort()).toEqual([
      'auth.token.authorization_code',
      'auth.token.client_credentials',
      'auth.token.refresh_token',
    ]);
  });

  it('accounts for all 61 enterprise-token-only endpoints', () => {
    const ent = CATALOG.filter((e) => e.tokenType === 'ENT');
    expect(ent).toHaveLength(61);
    // DevOps 54 (scm 36 + release 12 + build 6) + Nexus/CES 5 + the two pjm bulk
    // writes — the composition the CICD phase depends on.
    expect(histogram(ent.map((e) => e.module))).toEqual({
      scm: 36,
      release: 12,
      build: 6,
      nexus: 5,
      pjm: 2,
    });
    expect(
      ent.filter((e) => e.module === 'pjm').map((e) => `${e.method} ${e.path}`).sort(),
    ).toEqual(['POST /v1/pjm/sprints/bulk', 'POST /v1/pjm/versions/bulk']);
  });

  it('refuses the 7 user-token-only endpoints as a stable set', () => {
    expect(
      CATALOG.filter((e) => e.tokenType === 'USER').map((e) => `${e.method} ${e.path}`).sort(),
    ).toEqual([
      'GET /v1/myself',
      'GET /v1/permission/my/global',
      'GET /v1/permission/my/pilot',
      'GET /v1/permission/my/principal',
      'POST /v1/permission/check/global',
      'POST /v1/permission/check/pilot',
      'POST /v1/permission/check/principal',
    ]);
  });

  it('matches the area histogram from the other direction', () => {
    // Research §2 counted areas by hand from the doc navigation; the scrape
    // derives them from the URL. Both summing to 459 is the cross-check.
    const modules = histogram(CATALOG.map((e) => e.module));
    expect(modules).toEqual({
      pjm: 145,
      ship: 101,
      testhub: 65,
      scm: 36,
      directory: 23,
      wiki: 19,
      release: 12,
      reviews: 8,
      permission: 7,
      build: 6,
      nexus: 5,
      workloads: 5,
      attachments: 5,
      participants: 4,
      relations: 4,
      comments: 4,
      auth: 3,
      workload_types: 2,
      security: 2,
      activities: 2,
      myself: 1,
    });
    expect(Object.values(modules).reduce((a, b) => a + b, 0)).toBe(459);
  });

  it('gives every entry a unique id and a title', () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
    expect(CATALOG.filter((e) => e.title === '')).toEqual([]);
    expect(CATALOG.filter((e) => e.id === '' || e.module === '' || e.group === '')).toEqual([]);
  });

  it('separates a collection-level write from the item-level one', () => {
    // 批量部分更新工作项属性 sits on the collection path with the same verb as the
    // single-item PATCH; the `_all` suffix is what keeps the two ids apart.
    expect(findByMethodPath('PATCH', '/v1/pjm/work_items')?.id).toBe('pjm.work_items.update_all');
    expect(findByMethodPath('PATCH', '/v1/pjm/work_items/w1')?.id).toBe('pjm.work_items.update');
    // …and no entry needed the numeric last-resort discriminator.
    expect(CATALOG.filter((e) => /\.\d+$/.test(e.id)).map((e) => e.id)).toEqual([]);
  });

  it('declares no scope for exactly the endpoints the docs leave blank', () => {
    // 27 cross-cutting + the 2 `*/bulk` writes + the 3 token grants (research
    // §1.4). `api describe` must say "the docs declare none", never guess a name.
    const blank = CATALOG.filter((e) => e.scopes.length === 0);
    expect(blank).toHaveLength(32);
    expect(histogram(blank.map((e) => e.module))).toEqual({
      attachments: 5,
      comments: 4,
      participants: 4,
      relations: 4,
      reviews: 8,
      activities: 2,
      pjm: 2,
      auth: 3,
    });
  });

  it('carries no deprecation marker yet, but keeps the field', () => {
    expect(CATALOG.filter((e) => e.deprecated)).toEqual([]);
    expect(CATALOG.every((e) => typeof e.deprecated === 'boolean')).toBe(true);
  });

  it('lists path placeholders in path order', () => {
    const entry = findById('testhub.libraries.plans.runs.bulk');
    expect(entry?.path).toBe('/v1/testhub/libraries/{library_id}/plans/{plan_id}/runs/bulk');
    expect(entry?.pathParams).toEqual(['library_id', 'plan_id']);
    for (const e of CATALOG) {
      expect(e.pathParams).toEqual([...e.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]));
    }
  });
});

describe('paged classification', () => {
  it('applies the hand-written overrides on top of the generated heuristic', () => {
    expect(findByMethodPath('GET', '/v1/myself')?.paged).toBe(false);
    expect(findByMethodPath('GET', '/v1/pjm/projects/abc/progress')?.paged).toBe(false);
    expect(findByMethodPath('GET', '/v1/wiki/pages/p1/content')?.paged).toBe(false);
    // …while real collections keep the heuristic's verdict.
    expect(findByMethodPath('GET', '/v1/pjm/work_items')?.paged).toBe('query');
    expect(findByMethodPath('GET', '/v1/pjm/processes')?.paged).toBe('query');
    expect(findByMethodPath('POST', '/v1/pjm/work_items/search')?.paged).toBe('search');
  });

  it('has no dead override row', () => {
    // A resync that moves a path must not leave a silently-inert correction.
    for (const key of PAGED_OVERRIDE_KEYS) {
      const [method, pathValue] = key.split(' ');
      const hit = CATALOG.filter((e) => e.method === method && e.path === pathValue);
      expect(hit.length, `override ${key} matches nothing`).toBeGreaterThan(0);
    }
  });

  it('pages exactly the five search endpoints through the body', () => {
    expect(CATALOG.filter((e) => e.paged === 'search').map((e) => e.path).sort()).toEqual([
      '/v1/pjm/work_items/search',
      '/v1/ship/ideas/search',
      '/v1/ship/tickets/search',
      '/v1/testhub/cases/search',
      '/v1/testhub/runs/search',
    ]);
  });

  it('never pages a write', () => {
    expect(
      CATALOG.filter((e) => e.paged === 'query' && e.method !== 'GET').map((e) => e.id),
    ).toEqual([]);
  });

  /**
   * Design D2.3 requires the heuristic's verdict on all 459 entries to be
   * reviewable once, by a human, rather than trusted. This is that artefact:
   * every paged endpoint, one line each. A resync that changes a verdict shows
   * up here as a snapshot diff.
   */
  it('records the paged verdict for review', () => {
    const lines = CATALOG.filter((e) => e.paged !== false)
      .map((e) => `${String(e.paged).padEnd(6)} ${e.method.padEnd(4)} ${e.path}`)
      .sort();
    expect({ paged: lines.length, unpaged: CATALOG.length - lines.length }).toEqual({
      paged: 136,
      unpaged: 323,
    });
    expect(lines.join('\n')).toMatchSnapshot();
  });
});

describe('path matching', () => {
  it('substitutes a single segment per placeholder', () => {
    const hits = matchPath('/v1/testhub/cases/abc123');
    expect(hits.map((e) => e.id).sort()).toEqual([
      'testhub.cases.delete',
      'testhub.cases.get',
      'testhub.cases.update',
    ]);
    expect(methodsFor('/v1/testhub/cases/abc123')).toEqual(['DELETE', 'GET', 'PATCH']);
  });

  it('separates the singular area segment from its plural twin', () => {
    // The trap every module carries: `/testhub/case/*`, `/ship/idea/*` and
    // `/pjm/work_item/*` are config views, the plural forms are the resources.
    expect(matchPath('/v1/testhub/case/states').map((e) => e.id)).toEqual([
      'testhub.case.states.list',
    ]);
    expect(matchPath('/v1/ship/idea/states').map((e) => e.id)).toEqual(['ship.idea.states.list']);
    expect(matchPath('/v1/pjm/work_item/types').map((e) => e.id)).toEqual([
      'pjm.work_item.types.list',
    ]);
    // …and none of them is reachable as "an item of the plural collection".
    expect(matchPath('/v1/testhub/case/states').map((e) => e.path)).not.toContain(
      '/v1/testhub/cases/{case_id}',
    );
    expect(matchPath('/v1/ship/ideas/states').map((e) => e.id).sort()).toEqual([
      'ship.ideas.get',
      'ship.ideas.update',
    ]);
    expect(matchPath('/v1/pjm/work_items/types').map((e) => e.id).sort()).toEqual([
      'pjm.work_items.delete',
      'pjm.work_items.get',
      'pjm.work_items.update',
    ]);
  });

  it('prefers an exact segment over a wildcard', () => {
    expect(matchPath('/v1/pjm/work_items/search').map((e) => e.id)).toEqual([
      'pjm.work_items.search',
    ]);
    expect(matchPath('/v1/testhub/cases/bulk').map((e) => e.id).sort()).toEqual([
      'testhub.cases.bulk',
      'testhub.cases.bulk_update',
    ]);
  });

  it('never matches across a different segment count', () => {
    expect(matchPath('/v1/pjm/work_items/abc/def/ghi')).toEqual([]);
    expect(matchPath('/v1/pjm')).toEqual([]);
    expect(matchPath('/v1/pjm/nonesuch')).toEqual([]);
  });

  it('resolves a method + path to one entry, and reports the supported methods', () => {
    expect(findByMethodPath('GET', '/v1/pjm/projects/p1')?.id).toBe('pjm.projects.get');
    // `DELETE /v1/pjm/projects/{id}` does not exist upstream: a project cannot be
    // deleted through the API (research §3.8.1), so the caller gets the real set.
    expect(findByMethodPath('DELETE', '/v1/pjm/projects/p1')).toBeUndefined();
    expect(methodsFor('/v1/pjm/projects/p1')).toEqual(['GET', 'PATCH']);
  });

  it('tolerates a missing leading slash, a trailing slash and a query string', () => {
    expect(normalizePath('v1/pjm/projects/')).toBe('/v1/pjm/projects');
    expect(normalizePath('/v1/pjm/work_items?project_id=x')).toBe('/v1/pjm/work_items');
    expect(matchPath('v1/pjm/projects/').map((e) => e.id).sort()).toEqual([
      'pjm.projects.create',
      'pjm.projects.list',
    ]);
  });

  it('reports placeholders the caller forgot to substitute', () => {
    expect(unfilledPathParams('/v1/wiki/pages/{page_id}/content')).toEqual(['page_id']);
    expect(unfilledPathParams('/v1/wiki/pages/abc/content')).toEqual([]);
  });

  it('finds every curated path in endpoints.ts', () => {
    // The only automatic detector of an upstream path migration: upstream ships
    // no changelog, so a moved path shows up here first (design D2.4).
    const sample = 'sample-id';
    const paths = Object.values(ENDPOINTS).map((value) =>
      typeof value === 'function' ? value(sample, sample) : value,
    );
    expect(paths.length).toBeGreaterThan(40);
    const unmatched = paths.filter((p) => matchPath(p).length === 0);
    expect(unmatched).toEqual([]);
  });
});

describe('required-parameter validation', () => {
  const attachments = findByMethodPath('GET', '/v1/attachments');

  it('names the documented required fields that are absent', () => {
    expect(attachments).toBeDefined();
    expect(missingRequired(attachments as CatalogEntry, {})).toEqual([
      { kind: 'query', name: 'principal_type' },
      { kind: 'query', name: 'principal_id' },
    ]);
  });

  it('is satisfied by presence alone, never by a value shape', () => {
    expect(
      missingRequired(attachments as CatalogEntry, {
        query: ['principal_type', 'principal_id', 'comment_id'],
      }),
    ).toEqual([]);
  });

  it('checks body fields for writes', () => {
    const comment = findByMethodPath('POST', '/v1/comments');
    expect(comment?.body.some((p) => p.required)).toBe(true);
    const missing = missingRequired(comment as CatalogEntry, { body: [] });
    expect(missing.every((m) => m.kind === 'body')).toBe(true);
    expect(missing.length).toBeGreaterThan(0);
  });

  it('ignores nested `field[].sub` documentation rows', () => {
    const entry: CatalogEntry = {
      id: 'x.create',
      module: 'x',
      group: 'X',
      method: 'POST',
      path: '/v1/x',
      pathParams: [],
      query: [],
      body: [
        { name: 'updates', type: 'Object[]', required: true },
        { name: 'updates.id', type: 'String', required: true },
      ],
      paged: false,
      scopes: [],
      title: 'x',
      deprecated: false,
    };
    expect(missingRequired(entry, { body: ['updates'] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Generator (no network: a fixture standing in for the 2.37 MB bundle)
// ---------------------------------------------------------------------------

const fixture = `define({ "api": [
  {
    "type": "",
    "url": "",
    "group": "DevOps_数据集成",
    "groupTitle": "DevOps_数据集成",
    "name": "代码",
    "title": ""
  },
  {
    "type": "get",
    "url": "/v1/scm/commits/{commit_id_or_sha}",
    "group": "提交",
    "groupTitle": "提交",
    "name": "获取一个提交",
    "title": "",
    "permission": [{ "name": "企业令牌" }],
    "scopes": [{ "name": "pcp:read:devops:code" }],
    "parameter": { "fields": { "路径参数": [
      { "field": "commit_id_or_sha", "type": "String" }
    ] } }
  },
  {
    "type": "GET",
    "url": "/v1/scm/commits?repository_id={repository_id}",
    "group": "提交",
    "groupTitle": "提交",
    "name": "获取提交列表",
    "title": "",
    "permission": [{ "name": "企业令牌" }],
    "scopes": [{ "name": "pcp:read:devops:code" }],
    "parameter": { "fields": { "查询参数": [
      { "field": "repository_id", "type": "String" },
      { "field": "branch_id", "type": "String", "optional": true }
    ] } }
  },
  {
    "type": "DEL",
    "url": "/v1/scm/branches/{branch_id}",
    "group": "代码分支",
    "groupTitle": "代码分支",
    "name": "删除一个代码分支",
    "title": "",
    "permission": [{ "name": "企业令牌" }]
  },
  {
    "type": "POST",
    "url": "/v1/pjm/work_items/search",
    "group": "工作项",
    "groupTitle": "工作项",
    "name": "搜索工作项列表",
    "title": "",
    "permission": [{ "name": "企业令牌/用户令牌" }],
    "scopes": [{ "name": "pcp:read:pjm:workitem" }],
    "parameter": { "fields": { "Parameter": [
      { "field": "conditions", "type": "Object[]", "optional": true }
    ] } }
  },
  {
    "type": "GET",
    "url": "https://{oauth2_root}/authorize?response_type=code",
    "group": "授权码",
    "groupTitle": "鉴权",
    "name": "请求授权",
    "title": ""
  }
] });
`;

describe('generator derivation', () => {
  const entries = deriveCatalog(fixture);

  it('drops nav stubs and the non-v1 authorize page', () => {
    expect(entries.map((e) => e.id)).toEqual([
      'pjm.work_items.search',
      'scm.branches.delete',
      'scm.commits.get',
      'scm.commits.list',
    ]);
  });

  it('normalizes the inconsistent upstream method spellings', () => {
    expect(normalizeMethod('get')).toBe('GET');
    expect(normalizeMethod('DEL')).toBe('DELETE');
    expect(normalizeMethod('Patch')).toBe('PATCH');
    expect(normalizeMethod('TRACE')).toBeUndefined();
    expect(entries.find((e) => e.id === 'scm.branches.delete')?.method).toBe('DELETE');
  });

  it('moves the documented query string out of the path', () => {
    const list = entries.find((e) => e.id === 'scm.commits.list');
    expect(list?.path).toBe('/v1/scm/commits');
    expect(list?.query).toEqual([
      { name: 'repository_id', type: 'String', required: true },
      { name: 'branch_id', type: 'String', required: false },
    ]);
    expect(list?.pathParams).toEqual([]);
  });

  it('derives module, group, token type, scopes and title', () => {
    const get = entries.find((e) => e.id === 'scm.commits.get');
    expect(get).toMatchObject({
      module: 'scm',
      group: '提交',
      method: 'GET',
      path: '/v1/scm/commits/{commit_id_or_sha}',
      pathParams: ['commit_id_or_sha'],
      paged: false,
      tokenType: 'ENT',
      scopes: ['read:devops:code'],
      title: '获取一个提交',
      deprecated: false,
    });
  });

  it('derives ids from (method, path) alone', () => {
    expect(deriveId('GET', '/v1/pjm/projects')).toBe('pjm.projects.list');
    expect(deriveId('GET', '/v1/pjm/projects/{project_id}')).toBe('pjm.projects.get');
    expect(deriveId('PATCH', '/v1/pjm/projects/{project_id}')).toBe('pjm.projects.update');
    expect(deriveId('PUT', '/v1/wiki/pages/{page_id}/content')).toBe('wiki.pages.content.replace');
    expect(deriveId('POST', '/v1/pjm/work_items/search')).toBe('pjm.work_items.search');
    expect(deriveId('POST', '/v1/testhub/cases/bulk')).toBe('testhub.cases.bulk');
    expect(deriveId('PATCH', '/v1/testhub/cases/bulk')).toBe('testhub.cases.bulk_update');
    expect(deriveId('GET', '/v1/myself')).toBe('myself.get');
    // The singular/plural pair cannot collapse onto one id.
    expect(deriveId('GET', '/v1/testhub/case/states')).toBe('testhub.case.states.list');
    expect(deriveId('GET', '/v1/testhub/cases/{case_id}')).toBe('testhub.cases.get');
  });

  it('separates the two documented POST /v1/attachments bodies', () => {
    const twins = deriveCatalog(`define({ "api": [
      { "type": "POST", "url": "/v1/attachments", "group": "附件", "groupTitle": "附件",
        "name": "上传一个代码段", "title": "", "permission": [{ "name": "企业令牌/用户令牌" }],
        "parameter": { "fields": { "请求参数": [{ "field": "title", "type": "String" }] } } },
      { "type": "POST", "url": "/v1/attachments?principal_type={principal_type}", "group": "附件",
        "groupTitle": "附件", "name": "上传一个文件", "title": "",
        "permission": [{ "name": "企业令牌/用户令牌" }],
        "parameter": { "fields": { "请求参数 form-data": [{ "field": "file", "type": "File" }] } } }
    ] });`);
    expect(twins.map((e) => e.id)).toEqual([
      'attachments.create.json',
      'attachments.create.multipart',
    ]);
  });

  it('separates the three token grants by their literal grant_type', () => {
    const grants = deriveCatalog(`define({ "api": [
      { "type": "get", "url": "/v1/auth/token?grant_type=client_credentials", "group": "客户端凭据",
        "groupTitle": "客户端凭据", "name": "获取企业令牌", "title": "" },
      { "type": "get", "url": "/v1/auth/token?grant_type=refresh_token", "group": "授权码",
        "groupTitle": "授权码", "name": "刷新用户令牌", "title": "" }
    ] });`);
    expect(grants.map((e) => e.id)).toEqual([
      'auth.token.client_credentials',
      'auth.token.refresh_token',
    ]);
    expect(grants.every((e) => e.tokenType === undefined)).toBe(true);
  });

  it('refuses a bundle that is not the AMD wrapper', () => {
    expect(() => deriveCatalog('window.api = []')).toThrow();
    expect(() => deriveCatalog('define({ "nope": 1 })')).toThrow(/api/);
  });
});

describe('generator rendering and drift', () => {
  const entries = deriveCatalog(fixture);
  const rendered = renderGenerated(entries, { upstreamHash: 'a'.repeat(64), snapshot: '2026-08-03' });

  it('writes a self-describing, self-verifying file', () => {
    const { body } = splitGenerated(rendered);
    expect(declaredHash(rendered)).toBe(sha256(body));
    expect(rendered).toContain("import type { CatalogEntry } from './types';");
    expect(parseGenerated(rendered)).toEqual(entries);
  });

  it('reports nothing when the snapshot matches upstream', () => {
    expect(isClean(diffCatalogs(entries, entries))).toBe(true);
  });

  it('reports an added and a removed endpoint', () => {
    const [first, ...rest] = entries;
    expect(first).toBeDefined();
    const drift = diffCatalogs(rest, entries);
    expect(drift.added).toEqual([`${first?.method} ${first?.path}  (${first?.id})`]);
    expect(diffCatalogs(entries, rest).removed).toHaveLength(1);
  });

  it('re-joins a moved path and a changed method into one line', () => {
    const moved = entries.map((e) =>
      e.id === 'scm.commits.list' ? { ...e, id: 'scm.commit.list', path: '/v1/scm/commit' } : e,
    );
    expect(diffCatalogs(entries, moved).pathChanged).toEqual([
      'GET /v1/scm/commits → GET /v1/scm/commit  (获取提交列表)',
    ]);
    const remethoded = entries.map((e) =>
      e.id === 'scm.commits.list'
        ? { ...e, id: 'scm.commits.create', method: 'POST' as CatalogMethod }
        : e,
    );
    expect(diffCatalogs(entries, remethoded).methodChanged).toEqual([
      'GET /v1/scm/commits → POST /v1/scm/commits  (获取提交列表)',
    ]);
  });

  it('reports a scope change on a stable id', () => {
    const rescoped = entries.map((e) =>
      e.id === 'scm.commits.get' ? { ...e, scopes: ['write:devops:code'] } : e,
    );
    expect(diffCatalogs(entries, rescoped).scopeChanged).toEqual([
      'scm.commits.get: [read:devops:code] → [write:devops:code]',
    ]);
  });

  it('reports a paged or token-type change as a field change', () => {
    const retokened = entries.map((e) =>
      e.id === 'scm.commits.get' ? { ...e, tokenType: 'APP' as const } : e,
    );
    expect(diffCatalogs(entries, retokened).otherChanged).toEqual([
      'scm.commits.get: tokenType changed',
    ]);
  });
});
