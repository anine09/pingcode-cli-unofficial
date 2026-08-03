/**
 * Cross-object resource types: relations / comments / attachments / activities — research §3.7.
 *
 * **Reserved by F1, deliberately empty.** F5 adds its types here, and only
 * here: `src/types/api.ts` already re-exports this module, so a new module's types
 * reach every existing `from '../types/api'` import without touching a shared file
 * (design D6.5/D6.6).
 */
export {};
