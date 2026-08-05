import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { CATALOG, matchPath } from '../src/core/catalog/index';
import { ENDPOINTS } from '../src/core/endpoints';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** helper name -> path template (placeholder-filled), then back to catalog templates. */
function templateFor(name: string): string | undefined {
  const value = (ENDPOINTS as Record<string, unknown>)[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'function') {
    const fn = value as (...a: string[]) => string;
    return fn(...new Array<string>(fn.length).fill('X'));
  }
  return undefined;
}

it('coverage', () => {
  const files = [...walk('src/api'), ...walk('src/core/metadata'), ...walk('src/cli/commands')];
  // (method, ENDPOINTS.helper) pairs
  const pairs = new Set<string>();
  const unresolved: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // explicit request specs: method then path, in either order within a small window
    const re = /ENDPOINTS\.(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const helper = m[1] as string;
      const before = text.slice(Math.max(0, m.index - 600), m.index);
      const after = text.slice(m.index, m.index + 400);
      let method: string | undefined;
      const mBefore = [...before.matchAll(/method:\s*'(GET|POST|PATCH|PUT|DELETE)'/g)].pop();
      const mAfter = after.match(/method:\s*'(GET|POST|PATCH|PUT|DELETE)'/);
      // paging helpers imply the verb
      const callCtx = before.slice(-200);
      if (/(fetchPageOf|iterateOf|listAllOf)\([^)]*$/.test(callCtx)) method = 'GET';
      else if (/(fetchSearchPageOf|iterateSearchOf)\([^)]*$/.test(callCtx)) method = 'POST';
      else if (mAfter && (!mBefore || after.indexOf(mAfter[0]) < 120)) method = mAfter[1];
      else if (mBefore) method = mBefore[1];
      if (method === undefined && /metadata/.test(file)) method = /Search$/.test(helper) ? 'POST' : 'GET';
      if (method === undefined) { unresolved.push(`${file}: ${helper}`); continue; }
      pairs.add(`${method} ${helper}`);
    }
  }
  // core/auth.ts holds the token path as a literal (TOKEN_PATH), not in ENDPOINTS.
  pairs.add('GET __TOKEN__');
  const wired = new Set<string>();
  const bad: string[] = [];
  for (const pair of pairs) {
    const [method, helper] = pair.split(' ') as [string, string];
    const template = helper === '__TOKEN__' ? '/v1/auth/token' : templateFor(helper);
    if (template === undefined) { bad.push(`no ENDPOINTS.${helper}`); continue; }
    let hits = matchPath(template).filter((e) => e.method === method);
    // The token path carries three grants; this CLI implements client_credentials only.
    if (helper === '__TOKEN__') hits = hits.filter((e) => e.id.endsWith('client_credentials'));
    // POST /v1/attachments is two catalog entries; only the JSON code-snippet half is
    // wired (the multipart file upload would need core/wire.ts, PRD R1 no-touch).
    if (hits.length > 1 && template === '/v1/attachments') hits = hits.filter((e) => e.id.endsWith('.json'));
    if (hits.length === 0) { bad.push(`${method} ${template} (${helper}) -> no catalog entry`); continue; }
    for (const e of hits) wired.add(e.id);
  }
  const byModule = new Map<string, { total: number; hit: number }>();
  for (const e of CATALOG) {
    const row = byModule.get(e.module) ?? { total: 0, hit: 0 };
    row.total += 1;
    if (wired.has(e.id)) row.hit += 1;
    byModule.set(e.module, row);
  }
  const lines = [`wired endpoints: ${wired.size} / ${CATALOG.length}`, `unresolved method: ${unresolved.length}`, ...unresolved.slice(0, 20), `bad: ${bad.length}`, ...bad, '--- per module ---'];
  for (const [mod, row] of [...byModule.entries()].sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`${mod.padEnd(14)} ${String(row.hit).padStart(3)} / ${row.total}`);
  }
  lines.push('--- wired ids ---', [...wired].sort().join('\n'));
  console.log(lines.join('\n'));
});
