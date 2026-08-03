import { describe, expect, it } from 'vitest';
import { GROUPS } from '../../src/cli/registry';
import { containerPaths, groupNames, helpFor, leafPaths, program } from './tree';

/**
 * The root of the command tree, and the three structural rules that do **not** grow
 * with the surface.
 *
 * Everything here is either self-satisfying (derived from `cli/registry.ts`) or a
 * traversal. That is the point: this file must not need editing when a child adds
 * leaves, and the only thing that should ever change it is adding or removing a
 * whole command group — which is one row in `GROUPS` (design D6.2).
 *
 * Deliberately **not** here any more, and not anywhere else either: the exhaustive
 * ordered list of every leaf in the CLI, and the global leaf count. Those two
 * assertions were the merge point that made parallel work impossible (design D6.1);
 * each group now asserts its own leaves in `test/help/<group>.test.ts`.
 */

describe('command tree root', () => {
  it('registers exactly the groups in cli/registry.ts, in that order', () => {
    // Self-satisfying by construction, and still worth asserting: it proves the
    // registry and the commander tree agree. A `register*` that attaches nothing,
    // or attaches its group under a different name, fails here instead of silently
    // vanishing from `--help`.
    expect(groupNames()).toEqual(GROUPS.map(([name]) => name));
  });

  it('nests exactly two levels below the root', () => {
    // The shape assertion that replaces the old leaf-count arithmetic: a leaf is
    // `group leaf` or `group subgroup leaf`, never deeper. This holds however many
    // leaves exist, so it never needs revisiting.
    const roots = program().commands.filter((command) => command.name() !== 'help');
    const containers = roots.flatMap((command) => containerPaths(command));
    const leaves = roots.flatMap((command) => leafPaths(command));

    expect(containers.filter((parts) => parts.length > 2)).toEqual([]);
    expect(leaves.every((parts) => parts.length === 2 || parts.length === 3)).toBe(true);
  });

  it('accepts the global flags after the subcommand too', () => {
    // commander binds an option to the command it follows, so each leaf repeats
    // the global flags (hidden from its own help). Traversal, not a leaf list.
    const root = program();
    for (const parts of root.commands
      .filter((command) => command.name() !== 'help')
      .flatMap((command) => leafPaths(command))) {
      let cursor = root;
      for (const part of parts) {
        const next = cursor.commands.find((command) => command.name() === part);
        if (next === undefined) throw new Error(`missing command: ${parts.join(' ')}`);
        cursor = next;
      }
      const flags = cursor.options.map((option) => option.long);
      expect(flags, parts.join(' ')).toEqual(
        expect.arrayContaining(['--host', '--json', '--dry-run', '--no-cache', '--verbose']),
      );
    }
  });

  it('never binds -v (it would collide with --version/--verbose)', () => {
    expect(program().options.map((option) => option.short)).not.toContain('-v');
  });
});

describe('root --help', () => {
  /**
   * The one snapshot a new command group legitimately moves, and the reason the
   * "adding a group is one line" claim is about *source* rather than artifacts:
   * root `--help` lists the groups, so a new group must appear here.
   *
   * Verified by adding a throwaway group during F1: the group-order assertion above
   * self-satisfied, every group suite and every other suite stayed green, and this
   * snapshot was the only thing that moved — by exactly one line. Regenerate it with
   * `npx vitest run test/help/root.test.ts -u` and read the diff: it should show your
   * group's row and nothing else.
   */
  it('root', () => {
    expect(helpFor([])).toMatchSnapshot();
  });
});
