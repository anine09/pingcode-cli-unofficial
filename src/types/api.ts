/**
 * The stable import path for every hand-written API type.
 *
 * **This file is a re-export shell.** The types themselves live one per module in
 * `src/types/{common,pjm,ship,testhub,scm,crosscutting}.ts`; F1 split them out of
 * the single 773-line file this used to be (design D6.5). The split is mechanical
 * and behaviour-free: every name that was exported from here is still exported from
 * here, so **no import path anywhere in `src/` or `test/` changed**.
 *
 * Why the split, and why now: S1–S4 run in parallel and each needs to add types.
 * Adding them to one shared file means four concurrent edits to the middle of the
 * same file — the least mergeable shape there is. Doing it now costs one mechanical
 * move; doing it after four children have each added a few hundred lines costs that
 * move four times, on top of their diffs.
 *
 * Where to add a new type:
 *
 * | Module | File |
 * |---|---|
 * | pjm (project / work item / sprint / version) | `types/pjm.ts` |
 * | ship (product / idea / ticket) | `types/ship.ts` |
 * | testhub (library / case / plan / run) | `types/testhub.ts` |
 * | scm / build / release | `types/scm.ts` |
 * | relations / comments / attachments / activities | `types/crosscutting.ts` |
 * | shared by all of the above | `types/common.ts` |
 *
 * Conventions that apply to every one of those files:
 * - Field names mirror the API (snake_case) so `--json` output stays faithful to
 *   the PingCode docs and agents can use the documented names.
 * - All timestamps are 10-digit unix **seconds** (research §2/§6.7); conversion to
 *   local time happens only at the human output boundary.
 * - Every resource carries an index signature so fields we did not enumerate
 *   (custom `properties`, new API fields) survive into `--json` untouched.
 * - Two documented inconsistencies are normalised **once**, under `api/parse/`:
 *   `is_archived`/`is_deleted` arrive as numbers `0/1` (research §6.10), and list
 *   responses use `versions` (array) while single-GET shows `version` (object)
 *   (research §4.2).
 */

export * from './common';
export * from './pjm';
export * from './ship';
export * from './testhub';
export * from './scm';
export * from './crosscutting';
