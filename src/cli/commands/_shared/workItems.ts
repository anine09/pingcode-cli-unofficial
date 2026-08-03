import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import type { ScmWorkItemRef } from '../../../types/api';

/**
 * The work-item link contract, shared by every DevOps family that has one.
 *
 * **Why this file exists.** Five resources across two command groups carry the same
 * pair of fields — `work_item_identifiers[]` going in, `work_items[]` coming back —
 * with the same semantics: an identifier that does not exist is *silently dropped* and
 * the call still returns 200. scm's branch, commit and pull request use it (S1b/S1c),
 * and S1d's build record and deploy use it identically (verified live 2026-08-04, so
 * this is not an assumption carried over from scm).
 *
 * S1b/S1c kept these three helpers in `scm/branch.ts`, which was right while scm was
 * their only consumer: it was already that group's de-facto shared module, and
 * promoting them into `cli/commands/common.ts` — a file every parallel child edits —
 * would have created a merge point for no functional gain (design D13.6). A **second
 * command group** needing them changes that calculation, but not in favour of
 * `common.ts`: `build.ts` importing from `scm/branch.ts` would say that a CI build
 * record is somehow about code branches, which it is not. So the shared thing moves to
 * `_shared/`, where `crosscutting.ts` already establishes the pattern for command code
 * that belongs to no single group, and `scm/branch.ts` re-exports it so scm's four
 * importers are untouched.
 *
 * `oneLine` travels with them rather than living in `common.ts`, because every consumer
 * of a `work_items` table also renders a free-text cell beside it (a commit message, a
 * build's `result_overview`). Note `_shared/crosscutting.ts` has its own copy: that is
 * a different layer with no dependency on this one, and D13.6 deliberately left it
 * alone — the count of copies is 2, not 3, and unifying them is a tidy-up for whoever
 * next has a reason to touch both.
 */

/**
 * The identifiers of an embedded `work_items[]`.
 *
 * `identifier` (`PLM-001`) is the key **writes** use, so it has to survive parsing as a
 * first-class field; `name` is the fallback for a row that somehow lacks one.
 */
export function identifiersOf(workItems: ScmWorkItemRef[]): string[] {
  const out: string[] = [];
  for (const item of workItems) {
    const identifier = item.identifier ?? item.name;
    if (identifier !== undefined && identifier !== '') out.push(identifier);
  }
  return out;
}

/** A table cell must stay on one line; the API's text fields frequently do not. */
export function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Report the work-item links the API accepted-and-ignored.
 *
 * The API returns **200** for an identifier that does not exist and simply omits it
 * from `work_items` (live 2026-08-03 on an scm branch, and again 2026-08-04 on a build
 * record and a deploy: `["YYHC-10", "NOSUCH-99999"]` linked only the first). So the
 * status code cannot distinguish a full link from a partial one, and an agent that
 * trusts exit 0 believes a link happened that did not.
 *
 * This is not inference about server semantics — the response body contains the
 * answer, it was simply never compared against the request. Exit stays **0**: the
 * write did succeed, the warning goes to stderr, and under `--json` the authoritative
 * `work_items` array is already on stdout.
 */
export function warnUnlinkedWorkItems(
  ctx: Ctx,
  requested: string[] | undefined,
  linked: ScmWorkItemRef[],
): void {
  if (requested === undefined || requested.length === 0) return;
  const got = new Set(identifiersOf(linked).map((value) => value.toLowerCase()));
  const missing = requested.filter((identifier) => !got.has(identifier.trim().toLowerCase()));
  if (missing.length === 0) return;
  ctx.logger.warn(
    `the API accepted the request but linked no work item for: ${missing.join(', ')} — ` +
      'an unknown identifier is silently ignored rather than rejected, so check the spelling ' +
      '(identifiers look like PLM-001, and they are not ids)',
  );
}

/**
 * `--work-item` values, trimmed and rejected when blank (the API rejects `""` too:
 * 400 `100006` on a build, `100039`-class elsewhere).
 *
 * Exported alongside `warnUnlinkedWorkItems` and `identifiersOf`: the three are one
 * contract — validate what you send, then check what came back.
 */
export function workItemIdentifiers(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const identifiers = values.map((value) => value.trim());
  if (identifiers.some((identifier) => identifier === '')) {
    throw new UsageError('--work-item must not be empty', {
      hint: 'pass a work item identifier such as PLM-001, or omit the flag',
    });
  }
  return identifiers;
}
