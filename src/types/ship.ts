/**
 * ship (产品管理 / 需求 / 工单) resource types — ship research §3.
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

import type { Ref } from './common';

/**
 * Ship's id shapes are even less uniform than pjm's (ship §25): products, ideas,
 * tickets and most config rows are 24-hex, org users are 32-hex, and **property
 * ids are frequently slugs** (`backlog_type`, `solution`, `identifier`). Nothing
 * below is ever shape-validated.
 */

/** `GET /v1/ship/products[/{id}]` (ship §3.1). `state`/`owner` do not exist. */
export type ShipProduct = {
  id: string;
  /** Human key such as `SLC`, unique per org — **not** searchable via `keywords`. */
  identifier?: string | undefined;
  name?: string | undefined;
  url?: string | undefined;
  scope_type?: string | undefined;
  scope_id?: string | undefined;
  /** `public | private` */
  visibility?: string | undefined;
  color?: string | undefined;
  description?: string | undefined;
  /** Embedded members carry no `role` — the member endpoints do (ship §3.1). */
  members: ShipProductMember[];
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/products/{id}/members` (ship §3.6). The member's `id` **is** the
 * user or group id, and there is no top-level `name` — the display name lives in
 * `user` / `user_group`.
 */
export type ShipProductMember = {
  id: string;
  url?: string | undefined;
  /** `user | user_group` */
  type?: string | undefined;
  user?: Ref | undefined;
  user_group?: Ref | undefined;
  role?: Ref | undefined;
  product?: Ref | undefined;
  [key: string]: unknown;
};

/** `{from,to,granularity}` — written all-or-nothing (ship GOTCHA #9). */
export type ShipDateRange = {
  from?: number | undefined;
  to?: number | undefined;
  /** `year | quarter | month | day` */
  granularity?: string | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/ideas/{id}` (ship §3.2) — ship's primary work object. */
export type ShipIdea = {
  id: string;
  /** Human key such as `SLC-1`. No endpoint accepts it as a lookup key (ship §25). */
  identifier?: string | undefined;
  /** 8-char base62, used only inside `html_url`; **not** a lookup key either. */
  short_id?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  product?: Ref | undefined;
  assignee?: Ref | undefined;
  state?: Ref | undefined;
  priority?: Ref | undefined;
  /** Requirement schedule (需求排期). */
  plan?: Ref | undefined;
  /** Requirement module (需求模块), `type` ∈ `product` | `module`. */
  suite?: Ref | undefined;
  plan_at?: ShipDateRange | undefined;
  real_at?: ShipDateRange | undefined;
  /** Read-only/computed — no write parameter exists (ship §3.2). */
  score?: number | undefined;
  progress?: number | undefined;
  /** Keys are property ids (often slugs); select values are option `_id`s. */
  properties?: Record<string, unknown> | undefined;
  participants: Ref[];
  completed_at?: number | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/tickets/{id}` (ship §3.3).
 *
 * `channel` is the single worst shape hazard in ship: it is an **object** for
 * externally submitted tickets and the bare **string** `"internal"` otherwise
 * (ship GOTCHA #3), so it is deliberately not a `Ref`.
 */
export type ShipTicket = {
  id: string;
  identifier?: string | undefined;
  short_id?: string | undefined;
  url?: string | undefined;
  html_url?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  product?: Ref | undefined;
  assignee?: Ref | undefined;
  state?: Ref | undefined;
  type?: Ref | undefined;
  customer?: Ref | undefined;
  solution?: Ref | undefined;
  priority?: Ref | undefined;
  /** `Object` **or** the literal string `"internal"`. Never follow `channel.url`. */
  channel?: Ref | string | undefined;
  /** Present in responses, but unwritable and unfilterable (ship §3.3). */
  estimated_at?: ShipDateRange | undefined;
  properties?: Record<string, unknown> | undefined;
  tags: Ref[];
  participants: Ref[];
  submitted_at?: number | undefined;
  submitted_by?: Ref | undefined;
  completed_at?: number | undefined;
  created_at?: number | undefined;
  updated_at?: number | undefined;
  created_by?: Ref | undefined;
  updated_by?: Ref | undefined;
  /** Normalised from `0/1`. */
  is_archived: boolean;
  /** Normalised from `0/1`. */
  is_deleted: boolean;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/{idea,ticket}/states?product_id=` (ship §3.6). Ticket state
 * `type` ∈ `pending|in_progress|completed|closed`; the **idea** state enum is
 * never declared anywhere in the docs (ship §9.2).
 */
export type ShipState = {
  id: string;
  name?: string | undefined;
  type?: string | undefined;
  color?: string | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/{idea,ticket}/priorities?product_id=` — `{id,url,name}`. */
export type ShipPriority = {
  id: string;
  name?: string | undefined;
  color?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/idea/suites?product_id=` — a **tree served as a flat list** with
 * `parent` references (ship §D). `type` ∈ `product` (sub-product) | `module`.
 */
export type ShipSuite = {
  id: string;
  name?: string | undefined;
  type?: string | undefined;
  parent?: Ref | undefined;
  product?: Ref | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/ticket/types?product_id=` — the product-scoped list omits `is_system`. */
export type ShipTicketType = {
  id: string;
  name?: string | undefined;
  is_system?: boolean | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/ticket/channels?product_id=` — `{id,url,name,product,description}`. */
export type ShipChannel = {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/{idea,ticket}/properties?product_id=` — the authoritative list of
 * valid `properties` keys **and** of the option `_id`s a select-typed property
 * accepts (ship GOTCHA #4/#5).
 */
export type ShipProperty = {
  id: string;
  name?: string | undefined;
  /** `text | textarea | select | multi_select | … | link` */
  type?: string | undefined;
  options: ShipPropertyOption[];
  [key: string]: unknown;
};

/** The declared key is `_id`; a PATCH example uses `id` instead (ship GOTCHA #8). */
export type ShipPropertyOption = {
  _id?: string | undefined;
  text?: string | undefined;
  parent_id?: string | undefined;
  [key: string]: unknown;
};

/** `GET /v1/ship/ticket_state_plans` — `product` is **nullable** (= org default). */
export type ShipStatePlan = {
  id: string;
  product?: Ref | undefined;
  [key: string]: unknown;
};

/**
 * `GET /v1/ship/ticket_state_plans/{plan}/ticket_state_flows` — the legal
 * transitions of a plan.
 *
 * The docs spell the source field **`form_state`** on all three state-flow
 * records while `transition_histories` spell it `from_state`, and no response
 * example exists to settle it (ship GOTCHA #2). Both keys are accepted; the
 * normalised value lands in `from_state`.
 */
export type ShipStateFlow = {
  id: string;
  from_state?: Ref | undefined;
  to_state?: Ref | undefined;
  state_plan?: Ref | undefined;
  [key: string]: unknown;
};
