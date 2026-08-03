import type { Command } from 'commander';
import { buildProgram } from '../../src/cli/program';

/**
 * Shared tree traversal for the `test/help/*` suites.
 *
 * F1 split the former single `test/help.test.ts` into one file per command group
 * (design D6.3). The reason is mechanical, not aesthetic: **vitest keeps one
 * snapshot file per test file**, so `test/help/project.test.ts` owns
 * `test/help/__snapshots__/project.test.ts.snap` and nothing else writes to it.
 * Eight parallel children can then each add leaves without touching a file another
 * child is also editing — the 17.6 KB single snapshot was the serialisation point
 * of the whole task tree (design D6.1).
 *
 * Two rules for anyone adding to these suites:
 *
 * 1. **Assert your own group's leaves, never the global list.** A global exhaustive
 *    leaf list is exactly the assertion this split exists to delete: every child
 *    would have to edit it, in the same place, forever.
 * 2. **Traverse, do not hardcode, anything that is not the point of the test.**
 *    The helpers below exist so a group file states its leaves once and derives
 *    everything else.
 */

/** A fresh program per call: commander is stateful, so suites must not share one. */
export function program(): Command {
  return buildProgram();
}

export function group(parent: Command, name: string): Command {
  const found = parent.commands.find((command) => command.name() === name);
  if (found === undefined) throw new Error(`command "${name}" is not registered under ${parent.name()}`);
  return found;
}

/** Walk a path of names from the root, e.g. `['project', 'work-item', 'update']`. */
export function commandAt(root: Command, path: readonly string[]): Command {
  let cursor = root;
  for (const name of path) cursor = group(cursor, name);
  return cursor;
}

/** `--help` text for a path below the root, ready to snapshot. */
export function helpFor(path: readonly string[]): string {
  return commandAt(program(), path).helpInformation();
}

/** Every leaf under `command`, as name arrays including `command` itself. */
export function leafPaths(command: Command, prefix: string[] = []): string[][] {
  const own = [...prefix, command.name()];
  const children = command.commands.filter((child) => child.name() !== 'help');
  if (children.length === 0) return [own];
  return children.flatMap((child) => leafPaths(child, own));
}

/**
 * Every command that *has* children, i.e. the containers rather than the leaves.
 * Returned relative to the root, so a top-level group is one segment and a
 * subgroup is two.
 */
export function containerPaths(command: Command, prefix: string[] = []): string[][] {
  const own = [...prefix, command.name()];
  const children = command.commands.filter((child) => child.name() !== 'help');
  if (children.length === 0) return [];
  return [own, ...children.flatMap((child) => containerPaths(child, own))];
}

/** The leaves of one group, as space-joined paths — what a group suite asserts. */
export function leavesOf(name: string): string[] {
  return leafPaths(group(program(), name)).map((parts) => parts.join(' '));
}

/** The subgroups of one group, as space-joined paths. */
export function subgroupsOf(name: string): string[] {
  return containerPaths(group(program(), name))
    .filter((parts) => parts.length === 2)
    .map((parts) => parts.join(' '));
}

/** Every top-level group name, in registration order. */
export function groupNames(): string[] {
  return program()
    .commands.map((command) => command.name())
    .filter((name) => name !== 'help');
}
