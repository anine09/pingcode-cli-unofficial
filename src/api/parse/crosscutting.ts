/**
 * Cross-object parsers: relations / comments / attachments / activities — research §3.7.
 *
 * **Reserved by F1, deliberately empty.** F5 adds its parsers here, and only
 * here: `src/api/parse.ts` already re-exports this module, so new parsers reach
 * every existing `from '../api/parse'` import without touching a shared file
 * (design D6.5/D6.6). Import the primitives from `./common`.
 */
export {};
