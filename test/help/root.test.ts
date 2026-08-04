import { describe, expect, it } from 'vitest';
import { CROSSCUTTING_FAMILIES } from '../../src/cli/commands/_shared/crosscutting';
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

  it('nests two levels below the root, plus the injected cross-object families', () => {
    // The shape assertion that replaces the old leaf-count arithmetic. It used to read
    // "never deeper than `group subgroup leaf`", which was true until F5: design D5.2
    // mounts the four cross-object families *under* an entity subgroup, so
    // `project work-item comment add` is a legitimate fourth segment.
    //
    // The rule is tightened rather than loosened. Instead of allowing any depth, it
    // names the only third-level containers the CLI is allowed to have — the four
    // families, and only under an entity that mounts them. Anything else nesting that
    // deep is still a failure, and this stays a traversal: mounting the families on a
    // sixth entity does not touch this file.
    //
    // S2b added three more, and they are named here rather than waved through because
    // the point of the assertion is that the list is short and deliberate. All three are
    // sub-resources the API itself addresses **under** a work item —
    // `/v1/pjm/work_items/{id}/relations`, `…/tags`, `…/transition_histories` — so the
    // command path mirrors the URL path, which is the same justification the four
    // injected families have. A `project work-item link add` is therefore a legitimate
    // fourth segment; a fourth-level *container* still is not.
    const roots = program().commands.filter((command) => command.name() !== 'help');
    const containers = roots.flatMap((command) => containerPaths(command));
    const leaves = roots.flatMap((command) => leafPaths(command));

    const families: readonly string[] = [
      ...CROSSCUTTING_FAMILIES,
      // pjm work-item sub-resources (S2b): typed links, tags, state history.
      'link',
      'tag',
      'history',
    ];
    const deep = containers.filter((parts) => parts.length > 2);
    expect(deep.every((parts) => families.includes(parts[2] ?? ''))).toBe(true);
    expect(containers.filter((parts) => parts.length > 3)).toEqual([]);
    expect(
      leaves.every((parts) =>
        parts.length === 4
          ? families.includes(parts[2] ?? '')
          : parts.length === 2 || parts.length === 3,
      ),
    ).toBe(true);
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
