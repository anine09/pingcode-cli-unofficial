/**
 * scm / build / release parsers — research §3.12.
 *
 * **Reserved by F1, deliberately empty.** S1a–S1d adds its parsers here, and only
 * here: `src/api/parse.ts` already re-exports this module, so new parsers reach
 * every existing `from '../api/parse'` import without touching a shared file
 * (design D6.5/D6.6). Import the primitives from `./common`.
 */
export {};
