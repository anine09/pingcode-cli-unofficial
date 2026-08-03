import type { Command } from 'commander';
import type { Ctx } from '../../core/context';
import { UsageError } from '../../core/errors';
import {
  RESOLVABLE_KINDS,
  resolveKind,
  specOf,
  type MetaKind,
  type ResolveResult,
  type ResolverSpec,
} from '../../core/metadata';
import { addGlobalOptions } from '../globals';
import { printJson, type Column } from '../output';
import { contextFor, modeOf, printCollection, printResource } from './common';

/**
 * `pingcode resolve …` — name→id resolution as a first-class command (design D4.4).
 *
 * **Why it exists.** `pingcode api` deliberately understands nothing about the
 * business domain: it takes a path and ids, and does no name lookup (PRD non-goal).
 * That is what keeps 459 endpoints affordable — but on its own it would send an
 * agent back to the documentation site to find a `product_id`. This group closes
 * that gap by exposing the resolver table itself, so the two compose:
 *
 * ```bash
 * pingcode api GET /v1/ship/idea/states \
 *   --query product_id=$(pingcode resolve ship-product "智能客服" --json | jq -r .id)
 * ```
 *
 * **The surface is the table.** One subcommand per row of `RESOLVERS`, generated
 * here, so a new lookup appears in `--help` without this file changing. `--parent`
 * exists exactly on the rows that declare a parent, and the extra reference a
 * two-key lookup needs (`work_item_state`) comes from the row too. Nothing in this
 * file knows a single kind by name.
 *
 * **The output is `ResolveResult`, verbatim.** `--json` prints the same object the
 * `core/metadata` engine hands the refined commands — `kind`, `input`, `id`, `name`,
 * `fromCache`, `cacheKey` — because the point is to be piped into `jq -r .id`. It is
 * not reshaped, renamed or prettified here.
 */

type KindFlags = {
  parent?: string | undefined;
  type?: string | undefined;
};

export function registerResolveCommands(program: Command): void {
  const resolve = program
    .command('resolve')
    .description('name → id: resolve a name, alias or id for any of the CLI\'s lookup kinds');

  resolve.addHelpText(
    'after',
    '\nEvery lookup follows the same rules as the refined commands, because it is the same\n' +
      'engine: an id is passed through untouched, a name must match **exactly** (case-\n' +
      'insensitively) and exactly once, and the answer is cached for 24h under\n' +
      '(host, client_id, parent, kind) — bypass it with --no-cache.\n' +
      'Start with `pingcode resolve list`, which prints every kind and the parent it needs.\n' +
      '--parent takes an **id**, so the group composes with itself as well as with `api`:\n' +
      '  pingcode resolve ship-idea-state 已评审 \\\n' +
      '    --parent "$(pingcode resolve ship-product 智能客服 --json | jq -r .id)"\n' +
      '  pingcode api GET /v1/ship/idea/states \\\n' +
      '    --query product_id=$(pingcode resolve ship-product "智能客服" --json | jq -r .id)\n' +
      'Kinds that a name cannot address at all (ticket state plans and their flows) are\n' +
      'absent on purpose: nothing names them, so there is nothing to resolve.\n',
  );

  registerList(resolve);
  for (const kind of RESOLVABLE_KINDS) registerKind(resolve, kind);
}

// ---------------------------------------------------------------------------
// one subcommand per row
// ---------------------------------------------------------------------------

function registerKind(resolve: Command, kind: MetaKind): void {
  const spec = specOf(kind);
  const command = resolve
    .command(kind)
    .description(describeKind(spec))
    .argument('<name>', `${spec.label} name, alias or id (an id is verified, then passed through)`);

  // commander names are matched literally, so the four pjm kinds — whose canonical
  // spelling is the underscored `MetaKind` a `ResolveResult` reports — also answer to
  // the kebab form an agent is likelier to type.
  if (kind.includes('_')) command.alias(kind.replaceAll('_', '-'));

  const parentKind = spec.parent;
  if (parentKind !== undefined) {
    command.requiredOption(
      '--parent <id>',
      `the ${specOf(parentKind).label} id this ${spec.label} is scoped by (\`resolve ${parentKind}\` turns a name into one)`,
    );
  }

  const scopeKind = spec.scopeKind;
  if (scopeKind !== undefined && spec.scopeFlag !== undefined) {
    command.requiredOption(
      `--${spec.scopeFlag} <id>`,
      `the ${specOf(scopeKind).label} id this lookup also needs (\`resolve ${scopeKind}\` turns a name into one)`,
    );
  }

  if (spec.hint !== undefined) command.addHelpText('after', `\n${wrap(spec.hint)}\n`);

  addGlobalOptions(command, { hidden: true }).action(
    async (name: string, flags: KindFlags, self: Command) => {
      const { ctx } = contextFor(self);
      await runResolve(ctx, kind, name, flags);
    },
  );
}

function describeKind(spec: ResolverSpec): string {
  return `${spec.label} → id (${displayPath(spec)})`;
}

/**
 * The row's list endpoint, readable.
 *
 * `ENDPOINTS`' path builders `encodeURIComponent` their argument — correct for a
 * request, wrong for a description, where `%7Bparent%7D` is noise. Decoding the
 * display form back is the cheapest way to keep one source for the path.
 */
function displayPath(spec: ResolverSpec): string {
  return typeof spec.path === 'string' ? spec.path : decodeURIComponent(spec.path('{parent}'));
}

/**
 * Word-wrap a row hint. commander wraps the text it lays out itself but passes
 * `addHelpText` through verbatim, and the hints are written for an error message,
 * where they are one long line.
 */
function wrap(text: string, width = 92): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.join('\n');
}

async function runResolve(
  ctx: Ctx,
  kind: MetaKind,
  name: string,
  flags: KindFlags,
): Promise<void> {
  const spec = specOf(kind);

  const parentId = upstreamId(spec.parent, flags.parent, '--parent');
  const scopeId = upstreamId(
    spec.scopeKind,
    spec.scopeFlag === undefined ? undefined : flags[spec.scopeFlag],
    spec.scopeFlag === undefined ? '--scope' : `--${spec.scopeFlag}`,
  );

  const result = await resolveKind(ctx, kind, name, {
    ...(parentId === undefined ? {} : { parentId }),
    ...(scopeId === undefined ? {} : { scope: scopeId }),
  });

  printResolution(result, ctx);
}

/**
 * The upstream id a scoping flag carries, **verbatim** (design D4.4).
 *
 * It is deliberately not resolved by name here. Doing so would cost a second list
 * request on every invocation *including* the common case where the caller already
 * has the id, and it would turn "this id is not in the list I can see" into a
 * failure of the wrong lookup. A name is one composition away and that composition
 * is the group's whole idiom:
 *
 * ```bash
 * pingcode resolve ship-idea-state 已评审 \
 *   --parent "$(pingcode resolve ship-product 智能客服 --json | jq -r .id)"
 * ```
 */
function upstreamId(
  kind: MetaKind | undefined,
  input: string | undefined,
  flag: string,
): string | undefined {
  if (kind === undefined) return undefined;
  const trimmed = input?.trim() ?? '';
  if (trimmed === '') throw new UsageError(`${flag} is required`);
  return trimmed;
}

/**
 * stdout is the `ResolveResult`. Under `--json` that is the whole point; in human
 * mode the same fields are printed as a block, with `cacheKey` kept because it is
 * the file `--no-cache` bypasses and the one thing a stale-id report needs.
 */
function printResolution(result: ResolveResult, ctx: Ctx): void {
  const mode = modeOf(ctx);
  if (mode.json) {
    printJson(result);
    return;
  }
  printResource(
    result,
    [
      ['kind', result.kind],
      ['input', result.input],
      ['id', result.id],
      ['name', result.name ?? ''],
      ['from cache', result.fromCache ? 'yes' : 'no'],
      ['cache key', result.cacheKey ?? '(not cached)'],
    ],
    mode,
  );
}

// ---------------------------------------------------------------------------
// resolve list
// ---------------------------------------------------------------------------

type KindRow = {
  kind: MetaKind;
  label: string;
  parent: string;
  needs: string;
  path: string;
  hint: string;
};

const LIST_COLUMNS: Column<KindRow>[] = [
  { header: 'KIND', value: (row) => row.kind },
  { header: 'LABEL', value: (row) => row.label, flex: true },
  { header: 'PARENT', value: (row) => row.parent },
  { header: 'ALSO NEEDS', value: (row) => row.needs },
  { header: 'LIST ENDPOINT', value: (row) => row.path, flex: true },
];

/**
 * The discovery half of the group: an agent that does not know the kind names needs
 * one call that prints them, including which upstream id each one is scoped by —
 * because that is the flag it will have to fill in next.
 *
 * A leaf rather than a `--list` flag on the group, for two reasons: it matches
 * `api list`, and a visible option on a *group* changes the root `--help` layout for
 * every other group (design D6.2 keeps a new group to one line of diff).
 */
function registerList(resolve: Command): void {
  const command = resolve
    .command('list')
    .description('enumerate every resolvable kind, its parent scope and its list endpoint');

  command.addHelpText(
    'after',
    '\nLocal: this prints the resolver table, never the network. The KIND column is the\n' +
      'subcommand name and the `kind` field of a resolution; PARENT is the kind whose id\n' +
      '--parent takes.\n' +
      '--json prints {"values":[…],"count":N}, each row carrying the failure hint too.\n',
  );

  addGlobalOptions(command, { hidden: true }).action((_flags: unknown, self: Command) => {
    const { ctx } = contextFor(self);
    printCollection(RESOLVABLE_KINDS.map(rowFor), LIST_COLUMNS, modeOf(ctx));
  });
}

function rowFor(kind: MetaKind): KindRow {
  const spec = specOf(kind);
  return {
    kind,
    label: spec.label,
    parent: spec.parent ?? '',
    needs: spec.scopeFlag === undefined ? '' : `--${spec.scopeFlag}`,
    path: displayPath(spec),
    hint: spec.hint ?? '',
  };
}
