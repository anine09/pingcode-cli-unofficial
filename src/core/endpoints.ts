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
} as const;
