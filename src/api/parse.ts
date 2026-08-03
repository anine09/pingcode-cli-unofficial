/**
 * The stable import path for the API layer's parsing / normalisation helpers.
 *
 * **This file is a re-export shell.** The parsers themselves live one file per
 * module under `src/api/parse/`; F1 split them out of the single 897-line file this
 * used to be (design D6.5). Every name that was exported from here is still
 * exported from here, so **no import path anywhere in `src/` or `test/` changed**.
 *
 * Why the split, and why now: S1–S4 run in parallel and each adds parsers. In one
 * shared file that is four concurrent edits to the middle of the same file — the
 * least mergeable shape there is. Doing it now costs one mechanical move; doing it
 * after four children have each added a few hundred lines costs that move four
 * times, on top of their diffs.
 *
 * What lives where:
 *
 * | Contents | File |
 * |---|---|
 * | `asRecord` / `asString` / `asNumber` / `asBooleanFlag` / `parseRef` / `parseRefList` / `parseProperties` | `parse/common.ts` |
 * | `Parser<T>`, `fetchPageOf` / `iterateOf` / `listAllOf` / `fetchSearchPageOf` / `iterateSearchOf` / `compact` | `parse/common.ts` |
 * | pjm resources | `parse/pjm.ts` |
 * | ship resources | `parse/ship.ts` |
 * | testhub resources | `parse/testhub.ts` |
 * | scm / build / release | `parse/scm.ts` |
 * | relations / comments / attachments / activities | `parse/crosscutting.ts` |
 *
 * The invariants this layer owns are unchanged and still apply to every file above:
 *
 * - It is the **only** place the two documented inconsistencies are handled
 *   (design §8): `is_archived`/`is_deleted` arriving as numbers `0/1`
 *   (research §6.10), and `versions` (array, list responses) vs `version` (object,
 *   single GET) (research §4.2). Call sites never repeat this.
 * - Unknown fields are preserved so `--json` stays faithful to the API and custom
 *   `properties` are never silently dropped.
 * - Nothing here formats output — `api/` must not import `cli/output`
 *   (`test/layering.test.ts`).
 */

export * from './parse/common';
export * from './parse/pjm';
export * from './parse/ship';
export * from './parse/testhub';
export * from './parse/scm';
export * from './parse/crosscutting';
