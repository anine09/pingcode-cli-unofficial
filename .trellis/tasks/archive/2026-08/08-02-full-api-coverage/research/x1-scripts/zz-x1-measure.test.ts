import { it } from 'vitest';
import { buildProgram } from '../src/cli/program';
import { GROUPS } from '../src/cli/registry';
import { CATALOG } from '../src/core/catalog/index';
import { ENDPOINTS } from '../src/core/endpoints';
import { RESOLVABLE_KINDS, RESOLVERS } from '../src/core/metadata';

type Cmd = ReturnType<typeof buildProgram>;
function leafPaths(cmd: Cmd, prefix: string[] = []): string[][] {
  const own = [...prefix, cmd.name()];
  const kids = cmd.commands.filter((c) => c.name() !== 'help');
  if (kids.length === 0) return [own];
  return kids.flatMap((c) => leafPaths(c as Cmd, own));
}

it('measure', () => {
  const root = buildProgram();
  const roots = root.commands.filter((c) => c.name() !== 'help') as Cmd[];
  const leaves = roots.flatMap((c) => leafPaths(c)).map((p) => p.join(' '));
  const out: string[] = [];
  out.push(`GROUPS: ${GROUPS.length} :: ${GROUPS.map(([n]) => n).join(' ')}`);
  out.push(`LEAVES: ${leaves.length}`);
  for (const g of roots) out.push(`  ${g.name()} ${leafPaths(g).length}`);
  const fam = ['relation', 'comment', 'attachment', 'activity'];
  const cc = leaves.filter((l) => { const p = l.split(' '); return p.length === 4 && fam.includes(p[2] ?? ''); });
  out.push(`resolve leaves: ${leaves.filter((l) => l.startsWith('resolve ')).length}`);
  out.push(`crosscutting leaves: ${cc.length}`);
  out.push(`mounts: ${[...new Set(cc.map((l) => l.split(' ').slice(0, 2).join(' ')))].join(' | ')}`);
  out.push(`catalog: ${CATALOG.length}`);
  out.push(`kinds: ${Object.keys(RESOLVERS).length} resolvable: ${RESOLVABLE_KINDS.length}`);
  out.push('--- LEAF LIST ---');
  out.push(...leaves);
  console.log(out.join('\n'));
});
