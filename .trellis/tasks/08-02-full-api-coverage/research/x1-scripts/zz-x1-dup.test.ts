import { it } from 'vitest';
import { CATALOG } from '../src/core/catalog/index';
it('dups', () => {
  const by = new Map<string, string[]>();
  for (const e of CATALOG) {
    const k = `${e.method} ${e.path}`;
    by.set(k, [...(by.get(k) ?? []), `${e.id} :: ${e.title}`]);
  }
  const out: string[] = [];
  for (const [k, ids] of by) if (ids.length > 1) out.push(`${k}\n    ${ids.join('\n    ')}`);
  console.log(`duplicate method+path groups: ${out.length}\n${out.join('\n')}`);
});
