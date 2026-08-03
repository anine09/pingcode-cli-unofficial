/**
 * Shapes with no single owner: the embedded reference structure, the list envelope, the org directory user, and the token payload.
 *
 * Split out of the former single 773-line `src/types/api.ts` by F1 (design D6.5):
 * four parallel S children add types, and one shared file is the shape that cannot
 * be merged. `src/types/api.ts` re-exports every name below, so **no existing
 * import path changed**.
 *
 * Conventions are module-wide and stated once in `src/types/api.ts`: API
 * `snake_case` field names, 10-digit unix **seconds** for every timestamp, an index
 * signature on every resource so unknown fields survive into `--json`, and wire
 * quirks normalised exactly once under `api/parse/`.
 */

/** The "reference structure" every embedded resource uses (research §2.1). */
export type Ref = {
  id: string;
  name?: string | undefined;
  url?: string | undefined;
  [key: string]: unknown;
};

/** The uniform list envelope after normalisation (see `core/paginate.ts`). */
export type { Page } from '../core/paginate';

/** `GET /v1/directory/users` — user ids are **32-char hex**, not 24 (research §6.8). */
export type User = {
  id: string;
  name?: string | undefined;
  display_name?: string | undefined;
  username?: string | undefined;
  email?: string | undefined;
  is_deleted: boolean;
  [key: string]: unknown;
};

/** The token endpoint's response (research §1.3). */
export type TokenPayload = {
  access_token: string;
  token_type?: string | undefined;
  /** Documented as "过期时间"; may be a duration **or** an absolute timestamp (§4.1). */
  expires_in?: number | undefined;
  scope?: string | undefined;
};
