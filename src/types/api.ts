/**
 * Hand-written types for the ~15 MVP endpoints (design D5, from research §4/§4.2).
 * There is no vendored spec and no conformance script — codegen from
 * `https://open.pingcode.com/api_data.json` is a recorded follow-up.
 *
 * Conventions:
 * - Field names mirror the API (snake_case) so `--json` output stays faithful to
 *   the PingCode docs and agents can use the documented names.
 * - All timestamps are 10-digit unix **seconds** (research §2/§6.7); conversion to
 *   local time happens only at the human output boundary.
 * - Every resource carries an index signature so fields we did not enumerate
 *   (custom `properties`, new API fields) survive into `--json` untouched.
 * - Two documented inconsistencies are normalised **once**, in `api/parse.ts`:
 *   `is_archived`/`is_deleted` arrive as numbers `0/1` (research §6.10), and list
 *   responses use `versions` (array) while single-GET shows `version` (object)
 *   (research §4.2).
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

export type ProjectType = 'scrum' | 'kanban' | 'waterfall' | 'hybrid';

export type Project = {
  id: string;
  name?: string | undefined;
  identifier?: string | undefined;
  type?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

export type WorkItem = {
  id: string;
  /** Human-facing key such as `SCR-5`. */
  identifier?: string | undefined;
  /** Short key used in `html_url`, e.g. `1bAqLmTG`. */
  short_id?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  /** `epic | feature | story | task | bug | issue | …` — id may be a slug (research §6.8). */
  type?: Ref | undefined;
  state?: Ref | undefined;
  priority?: Ref | undefined;
  assignee?: Ref | undefined;
  project?: Ref | undefined;
  parent?: Ref | undefined;
  sprint?: Ref | undefined;
  board?: Ref | undefined;
  entry?: Ref | undefined;
  swimlane?: Ref | undefined;
  phase?: Ref | undefined;
  /** Always an array here, even when the API sent a single `version` object. */
  versions: Ref[];
  tags: Ref[];
  participants: Ref[];
  start_at?: number | undefined;
  end_at?: number | undefined;
  completed_at?: number | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  story_points?: number | undefined;
  estimated_workload?: number | undefined;
  remaining_workload?: number | undefined;
  properties?: Record<string, unknown> | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/** `GET /v1/pjm/work_item/types` — system types use string slugs as their id. */
export type WorkItemType = {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  [key: string]: unknown;
};

/** `GET /v1/pjm/work_item/states` — requires **both** `project_id` and `work_item_type_id`. */
export type WorkItemState = {
  id: string;
  name?: string | undefined;
  /** `pending | in_progress | completed`-style grouping, when the API sends one. */
  type?: string | undefined;
  [key: string]: unknown;
};

export type WorkItemPriority = {
  id: string;
  name?: string | undefined;
  color?: string | undefined;
  [key: string]: unknown;
};

export type Sprint = {
  id: string;
  name?: string | undefined;
  /** `pending | in_progress | completed` */
  status?: string | undefined;
  start_at?: number | undefined;
  end_at?: number | undefined;
  [key: string]: unknown;
};

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
