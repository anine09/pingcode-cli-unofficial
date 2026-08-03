/**
 * Endpoint paths for the MVP surface (research §4).
 *
 * They live in `core` because both `api/*` (typed wrappers) and
 * `core/metadata.ts` (name→id resolution) need them, and `core` must not import
 * `api`. One place to change if a path ever moves.
 */
export const ENDPOINTS = {
  token: '/v1/auth/token',

  projects: '/v1/pjm/projects',
  project: (projectId: string): string => `/v1/pjm/projects/${encodeURIComponent(projectId)}`,
  projectSprints: (projectId: string): string =>
    `/v1/pjm/projects/${encodeURIComponent(projectId)}/sprints`,

  workItems: '/v1/pjm/work_items',
  /** Accepts **`id` or `short_id`** on GET (research §6.9); PATCH documents only `id`. */
  workItem: (workItemId: string): string =>
    `/v1/pjm/work_items/${encodeURIComponent(workItemId)}`,

  workItemTypes: '/v1/pjm/work_item/types',
  workItemStates: '/v1/pjm/work_item/states',
  workItemPriorities: '/v1/pjm/work_item/priorities',

  users: '/v1/directory/users',

  // -------------------------------------------------------------------------
  // Ship (产品管理) — ship research §2 tables A/B/D/J/J3/K/K3/M
  // -------------------------------------------------------------------------

  shipProducts: '/v1/ship/products',
  shipProduct: (productId: string): string =>
    `/v1/ship/products/${encodeURIComponent(productId)}`,
  /** The `assignee_id` candidate set: member `id` **is** the user/group id (ship §B). */
  shipProductMembers: (productId: string): string =>
    `/v1/ship/products/${encodeURIComponent(productId)}/members`,

  /**
   * `POST` only. The CLI never issues `GET /v1/ship/ideas`: the simple list has no
   * assignee/date/property filters, so `…/search` is the single read path (PRD D2).
   */
  shipIdeas: '/v1/ship/ideas',
  shipIdeasSearch: '/v1/ship/ideas/search',
  shipIdea: (ideaId: string): string => `/v1/ship/ideas/${encodeURIComponent(ideaId)}`,

  /** Note the **singular** `idea` segment on all four lookups (ship §J3). */
  shipIdeaStates: '/v1/ship/idea/states',
  shipIdeaPriorities: '/v1/ship/idea/priorities',
  shipIdeaSuites: '/v1/ship/idea/suites',
  shipIdeaProperties: '/v1/ship/idea/properties',

  /** `POST` only, for the same reason as `shipIdeas` (PRD D10/R11). */
  shipTickets: '/v1/ship/tickets',
  shipTicketsSearch: '/v1/ship/tickets/search',
  shipTicket: (ticketId: string): string => `/v1/ship/tickets/${encodeURIComponent(ticketId)}`,

  /** Singular `ticket` segment again (ship §K3). */
  shipTicketStates: '/v1/ship/ticket/states',
  shipTicketPriorities: '/v1/ship/ticket/priorities',
  shipTicketTypes: '/v1/ship/ticket/types',
  shipTicketChannels: '/v1/ship/ticket/channels',
  shipTicketProperties: '/v1/ship/ticket/properties',

  /**
   * Transition pre-validation for tickets (PRD D11). The plan list has **no**
   * `?product_id=` filter (ship GOTCHA #23), so finding a product's plan is an
   * O(all plans) client-side scan on the embedded `product.id`.
   */
  shipTicketStatePlans: '/v1/ship/ticket_state_plans',
  shipTicketStateFlows: (statePlanId: string): string =>
    `/v1/ship/ticket_state_plans/${encodeURIComponent(statePlanId)}/ticket_state_flows`,

  // -------------------------------------------------------------------------
  // Testhub (测试管理) — testhub research §9, the 15-endpoint MVP
  // -------------------------------------------------------------------------
  //
  // Three shapes coexist in this module and the segment spelling is the only
  // thing that tells them apart (testhub GOTCHA #2, and the same trap as ship's
  // `/v1/ship/idea/states`):
  //
  //   - **plural** `/cases`, `/runs`            → the resources themselves
  //   - **singular** `/case/…`, `/run/…`        → "what is configured for this
  //                                               library" views, `?library_id=`
  //   - **underscored** `/case_important_levels` → an org-level config list with
  //                                               no library-scoped variant
  //
  // Plans are the only resource addressed **under** their library
  // (`/libraries/{id}/plans/…`); cases and runs are flat, and carry the library
  // in the body instead (testhub §5).

  testhubLibraries: '/v1/testhub/libraries',
  testhubLibrary: (libraryId: string): string =>
    `/v1/testhub/libraries/${encodeURIComponent(libraryId)}`,
  /** `?parent_id=` — omitted = whole tree, `root` = top level, an id = direct children ([th#11]). */
  testhubLibrarySuites: (libraryId: string): string =>
    `/v1/testhub/libraries/${encodeURIComponent(libraryId)}/suites`,

  /**
   * `POST` only (case create). The CLI never issues `GET /v1/testhub/cases`: the
   * simple list has no `library_id` requirement, so unfiltered it scans every
   * visible library ([th#20]/[th#22], GOTCHA #20), and the docs themselves
   * redirect to `…/search`.
   */
  testhubCases: '/v1/testhub/cases',
  testhubCasesSearch: '/v1/testhub/cases/search',
  /** Accepts **`id` or `short_id`** on GET ([th#21]); PATCH documents only `id` (GOTCHA #19). */
  testhubCase: (caseId: string): string => `/v1/testhub/cases/${encodeURIComponent(caseId)}`,

  /** Singular `case` segment. **Scope `pcp:read:testhub:configuration`** ([th#25], GOTCHA #2). */
  testhubCaseStates: '/v1/testhub/case/states',
  /** Singular `case` segment — but only `pcp:read:testhub:testcase` ([th#27]). */
  testhubCaseTypes: '/v1/testhub/case/types',
  /** Org-level: there is **no** library-scoped variant of this one ([th#40]). */
  testhubCaseImportantLevels: '/v1/testhub/case_important_levels',

  testhubLibraryPlans: (libraryId: string): string =>
    `/v1/testhub/libraries/${encodeURIComponent(libraryId)}/plans`,
  /**
   * Plan types ([th#60]). Scope is **`pcp:read:testhub:testplan`**, not
   * `configuration` — unlike the `case/states` and `run/statuses` config views
   * this one sits beside, so a 403 here must not be blamed on the
   * configuration scope.
   *
   * The resource carries no `kind` discriminator, so which types demand a
   * `sprint_id` or a `version_id` is not knowable from this list (testhub §10.7).
   */
  testhubLibraryPlanTypes: (libraryId: string): string =>
    `/v1/testhub/libraries/${encodeURIComponent(libraryId)}/plan_types`,
  /** `plan_id` accepts **id or short_id** on GET ([th#53]); PATCH is id-only ([th#62]). */
  testhubLibraryPlan: (libraryId: string, planId: string): string =>
    `/v1/testhub/libraries/${encodeURIComponent(libraryId)}/plans/${encodeURIComponent(planId)}`,
  /**
   * The **only** way to delete a run ([th#49], GOTCHA #13). One call carries
   * `inserts[]` / `updates[]` / `deletes[]`, each capped at 50, and returns
   * counts only — never the ids of the runs it created.
   */
  testhubPlanRunsBulk: (libraryId: string, planId: string): string =>
    `/v1/testhub/libraries/${encodeURIComponent(libraryId)}/plans/${encodeURIComponent(planId)}/runs/bulk`,

  /** `POST` only, for the same reason as `testhubCases` ([th#51]/[th#56]). */
  testhubRunsSearch: '/v1/testhub/runs/search',
  /** GET accepts id or short_id ([th#52]); PATCH is id-only and **requires `status_id`** ([th#61]). */
  testhubRun: (runId: string): string => `/v1/testhub/runs/${encodeURIComponent(runId)}`,
  /** Singular `run` segment. **Scope `pcp:read:testhub:configuration`** ([th#57], GOTCHA #2). */
  testhubRunStatuses: '/v1/testhub/run/statuses',

  // -------------------------------------------------------------------------
  // Cross-object (通用) — relations / comments / attachments / activities
  // research §3.7, all live-verified 2026-08-03 (design D5, D7.0)
  // -------------------------------------------------------------------------
  //
  // These four families are polymorphic over `principal_type` + `principal_id`,
  // which is why there is **one** set of paths here and no per-module variants:
  // the mount point supplies the type (design D5.1) and `api/common.ts` is the
  // single implementation.
  //
  // **`principal_type` and `principal_id` are QUERY parameters everywhere except
  // the two `POST` bodies** (`/v1/comments`, `/v1/attachments` code snippet).
  // That asymmetry is documented and was confirmed live; it is the reason the
  // wrappers take a `PrincipalRef` and decide per call where to put it.
  //
  // The documented `principal_type` vocabularies differ per family and are **not
  // interchangeable** (from the vendor's own `allowedValues`, cross-checked live):
  //
  //   comments     work_item · test_case · test_run · idea · ticket · page
  //   attachments  work_item · test_case · test_run · idea · ticket · page
  //                (+ work_item_deliverable on the file upload and on GET one)
  //   activities   work_item · test_case · test_run · idea · ticket   ← **no page**
  //   relations    undocumented — the vendor declares no allowedValues at all,
  //                so the accepted set is the live matrix in `api/common.ts`
  //
  // Two live findings that contradict a plain reading of the docs, recorded here
  // because they change what the CLI may send (PRD R2):
  //
  //  1. a test **plan** is not a principal at all — no family accepts it, and
  //     `/v1/activities` answers an unknown `principal_type` with **HTTP 500**
  //     rather than a 400, so this must never be probed at runtime;
  //  2. `GET /v1/relations` really does **require** `target_type`: omitting it is
  //     rejected with `100049`, whose message names `principal_type` instead.

  /** `POST` (create), `GET` (list, **`target_type` required**). */
  relations: '/v1/relations',
  /**
   * `GET` / `DELETE` one relation — the **only** cross-object DELETE that takes no
   * principal query (design D5.3). Relations are stored as a mirrored pair with two
   * distinct ids; deleting either id removes both directions (live 2026-08-03).
   */
  relation: (relationId: string): string => `/v1/relations/${encodeURIComponent(relationId)}`,

  /** `POST` (create — principal in the **body**), `GET` (list — principal in the query). */
  comments: '/v1/comments',
  /**
   * `GET` / `DELETE` one comment. `principal_id` is documented optional but is
   * **required in practice**: without it the API answers
   * `'principal_id'或'review_id'不存在` (live 2026-08-03) — hence the two-positional
   * signature `comment delete <parent-ref> <comment-id>` (design D5.3).
   *
   * `DELETE` is a **soft delete**: the row stays in the list with `is_deleted: 1`. Only
   * that flag is reliable — a pjm comment also comes back with `content: ""`, while a
   * ship comment keeps its text — so callers must render the flag, not infer absence.
   */
  comment: (commentId: string): string => `/v1/comments/${encodeURIComponent(commentId)}`,

  /**
   * `POST` (two variants sharing one path) and `GET` (list).
   *
   * The file upload is `multipart/form-data` with a real `file` part — **one step,
   * no pre-signed URL** — so it cannot be sent by `core/wire.ts`, which only ever
   * `JSON.stringify`s a body. It is therefore out of the CLI's reach until that
   * (PRD R1 no-touch) file gains a multipart path; only `add-snippet` is wired up
   * (design D5.5, outcome 1 + 3).
   *
   * The code-snippet variant is `application/json` and **does** work, with one
   * undocumented constraint found live: `comment_id` is documented optional but is
   * in fact mandatory — without it every attempt returns `100039 请求参数错误`.
   * A snippet always hangs off a comment, and consequently does not appear in the
   * object-level attachment list unless `comment_id` is passed there too.
   */
  attachments: '/v1/attachments',
  /** `GET` / `DELETE` one attachment; both need the principal query (design D5.3). */
  attachment: (attachmentId: string): string =>
    `/v1/attachments/${encodeURIComponent(attachmentId)}`,

  /**
   * `GET` (list) — read-only, and the closest thing this API has to a change feed
   * (research §5: there is no webhook API and no global activity stream), but it is
   * strictly per-object.
   */
  activities: '/v1/activities',
  /** `GET` one activity record; needs the principal query. */
  activity: (activityId: string): string => `/v1/activities/${encodeURIComponent(activityId)}`,
} as const;
