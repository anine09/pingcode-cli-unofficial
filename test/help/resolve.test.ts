import { describe, expect, it } from 'vitest';
import { META_KINDS, RESOLVABLE_KINDS, specOf } from '../../src/core/metadata';
import { commandAt, helpFor, leavesOf, program } from './tree';

/**
 * `resolve` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/resolve.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3).
 *
 * The group is **generated from `RESOLVERS`** (design D4.4), so most of what is worth
 * asserting is the relationship between the table and the command tree rather than a
 * hand-copied list: that every resolvable kind is reachable, that the two kinds no
 * name addresses are absent, and that `--parent` appears exactly where the row says a
 * parent scopes the lookup. Those hold for rows that do not exist yet, which is the
 * point — the next lookup is a row, not a command.
 *
 * The engine's behaviour is covered by `test/metadata.test.ts`,
 * `test/shipMetadata.test.ts` and `test/testhubMetadata.test.ts`, which F4 left
 * untouched on purpose.
 */

function fullHelp(path: readonly string[]): string {
  const command = commandAt(program(), path);
  let text = '';
  command.configureOutput({
    writeOut: (chunk) => {
      text += chunk;
    },
  });
  command.outputHelp();
  return text;
}

describe('resolve command surface', () => {
  it('registers one leaf per resolvable kind, in table order, behind `list`', () => {
    // Self-satisfying by construction, and that *is* the assertion: it proves the
    // generated tree and the registry agree, so a row that fails to produce a command
    // fails here instead of silently missing from `--help`.
    expect(leavesOf('resolve')).toEqual([
      'resolve list',
      ...RESOLVABLE_KINDS.map((kind) => `resolve ${kind}`),
    ]);
  });

  it('covers 27 of the 29 kinds, and omits exactly the two nothing names', () => {
    // The count is the honest half of the assertion above: it moves only when the
    // table does, and it is what catches a row that quietly stopped being resolvable.
    // 27 → 29 with S1a's `scm-platform` / `scm-repo`.
    expect(META_KINDS).toHaveLength(29);
    expect(RESOLVABLE_KINDS).toHaveLength(27);

    // Ticket state plans are found by scanning for an embedded `product.id` (ship
    // GOTCHA #23) and their flows are graph edges — neither is addressed by a name, so
    // offering `resolve ship-ticket-state-plan <name>` would be a lie.
    const omitted = META_KINDS.filter((kind) => !RESOLVABLE_KINDS.includes(kind));
    expect(omitted).toEqual(['ship-ticket-state-plan', 'ship-ticket-state-flow']);
    for (const kind of omitted) expect(specOf(kind).cacheOnly).toBe(true);
  });

  it('asks for --parent exactly where the row declares a parent, and requires it', () => {
    for (const kind of RESOLVABLE_KINDS) {
      const command = commandAt(program(), ['resolve', kind]);
      const parent = command.options.find((option) => option.long === '--parent');
      const scoped = specOf(kind).parent !== undefined;
      expect(parent !== undefined, kind).toBe(scoped);
      // Unset, the lookup would silently run against the wrong scope — ship and testhub
      // ids are per-product/per-library even when they look org-global (ship GOTCHA #26).
      if (parent !== undefined) expect(parent.required || parent.mandatory, kind).toBe(true);
    }
  });

  it('names the parent kind, not just "parent", in each --parent description', () => {
    // `--parent <id>` alone would not say *what* to pass; the row knows, and it also
    // knows which `resolve` subcommand turns that name into the id.
    const parentedKinds = RESOLVABLE_KINDS.filter((kind) => specOf(kind).parent !== undefined);
    expect(parentedKinds.length).toBeGreaterThan(15);
    for (const kind of parentedKinds) {
      const parentKind = specOf(kind).parent;
      if (parentKind === undefined) continue;
      const help = helpFor(['resolve', kind]);
      expect(help, kind).toContain(specOf(parentKind).label);
      expect(help, kind).toContain(`resolve ${parentKind}`);
    }
  });

  it('takes the second reference a two-key lookup needs as its own flag', () => {
    // `GET /v1/pjm/work_item/states` wants **both** project_id and work_item_type_id
    // (research §4), and it is the only row like that — so `--type` exists there and
    // nowhere else, straight from the row rather than from an `if (kind === …)`.
    expect(helpFor(['resolve', 'work_item_state'])).toContain('--type');
    for (const kind of RESOLVABLE_KINDS.filter((candidate) => candidate !== 'work_item_state')) {
      expect(helpFor(['resolve', kind]), kind).not.toContain('--type <');
    }
  });

  it('accepts the kebab spelling of the underscored pjm kinds', () => {
    // The canonical name is the `MetaKind` a `ResolveResult` reports, so it stays
    // underscored; commander matches names literally, so the likelier spelling is an
    // alias rather than an unknown command.
    const resolve = commandAt(program(), ['resolve']);
    for (const kind of RESOLVABLE_KINDS.filter((candidate) => candidate.includes('_'))) {
      const kebab = kind.replaceAll('_', '-');
      expect(resolve.commands.some((command) => command.aliases().includes(kebab)), kebab).toBe(
        true,
      );
    }
  });

  it('offers `resolve list` rather than a group-level flag', () => {
    // The discovery half: an agent that does not know the kind names needs one call
    // that prints them. It is a leaf, not `--list`, because a visible option on a group
    // re-lays-out the *root* `--help` for every other group (design D6.2).
    expect(helpFor(['resolve'])).toContain('list');
    expect(commandAt(program(), ['resolve']).options.some((option) => !option.hidden)).toBe(false);
  });

  it('says in --help how it composes with the generic layer', () => {
    // `pingcode api` takes ids only, on purpose. If that pairing is not documented
    // where the reader already is, the escape hatch stays unusable without the docs site.
    expect(fullHelp(['resolve'])).toMatch(/pingcode api GET/);
    expect(fullHelp(['resolve'])).toMatch(/jq -r \.id/);
  });
});

describe('resolve --help', () => {
  it('resolve (the generated kind list)', () => {
    expect(fullHelp(['resolve'])).toMatchSnapshot();
  });

  it('resolve list', () => {
    expect(fullHelp(['resolve', 'list'])).toMatchSnapshot();
  });

  it('resolve project (a root lookup: no --parent)', () => {
    expect(fullHelp(['resolve', 'project'])).toMatchSnapshot();
  });

  it('resolve work_item_state (the only two-key lookup)', () => {
    expect(fullHelp(['resolve', 'work_item_state'])).toMatchSnapshot();
  });

  it('resolve ship-idea-state (product-scoped, with the row hint)', () => {
    expect(fullHelp(['resolve', 'ship-idea-state'])).toMatchSnapshot();
  });

  it('resolve testhub-plan (parent in the path, short_id alias)', () => {
    expect(fullHelp(['resolve', 'testhub-plan'])).toMatchSnapshot();
  });
});
