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
} as const;
