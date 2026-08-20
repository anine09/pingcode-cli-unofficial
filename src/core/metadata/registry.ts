import { ENDPOINTS } from '../endpoints';

/**
 * The resolver registry: **one row per resolvable kind**, and the only place a new
 * name→id lookup is declared (design D4.2).
 *
 * Before this table the same six facts — label, list endpoint, parent scope, the
 * query parameter the parent rides in, the alias keys and the failure hint — were
 * spelled out in ~700 lines of near-identical resolver bodies, and `MetaKind` was a
 * hand-written union that had to be kept in step by hand. Here the union is
 * *derived* (`keyof typeof RESOLVERS`), so the two can no longer disagree: adding a
 * row adds a kind, and deleting one makes every call site that named it a compile
 * error.
 *
 * **This file is data.** It imports `core/endpoints.ts` and nothing else — no `Ctx`,
 * no `http`, no cache. The engine that reads it lives in `./resolve.ts`.
 *
 * Two rules the rows encode and every resolver inherits from that engine:
 *
 *  - **ids are never shape-validated.** 24-hex for most resources, 32-hex for users,
 *    8-char base62 for testhub `short_id`s and bare slugs for system work-item types
 *    and ship properties (research §6.8, ship GOTCHA #4) — so resolution tries an
 *    exact id match first and only then matches names.
 *  - **most ids are parent-scoped** (research §6.13): a project for pjm, a product
 *    for ship, a library for testhub. `parent` names the upstream kind whose id
 *    scopes this one and therefore keys its cache, so an id from another parent is
 *    never reachable through a cached list — even though ship's ids frequently
 *    *look* org-global (ship GOTCHA #26).
 */

/** The three scoping families, named once. Nothing else in the table repeats them. */
const PROJECT_SCOPED = { parent: 'project', parentQuery: 'project_id' } as const;
const PRODUCT_SCOPED = { parent: 'ship-product', parentQuery: 'product_id' } as const;
const LIBRARY_SCOPED = { parent: 'testhub-library', parentQuery: 'library_id' } as const;

/**
 * `case/states` and `run/statuses` need `pcp:read:testhub:configuration` while
 * `case/types`, right beside them, needs only `testcase` (testhub GOTCHA #2) — and a
 * token without it can write no run at all, which the server's bare 403 never says.
 */
const CONFIGURATION_SCOPE_HINT =
  'this lookup needs the pcp:read:testhub:configuration scope — a token granted only ' +
  'testcase+testplan cannot resolve state or status ids, and therefore cannot write a run at all';

/** Names are unique among siblings only, so the computed path is the typeable spelling. */
const SUITE_AMBIGUITY_HINT =
  'two modules in different branches may share a name — pass the full path ("Parent / Child") or the id';

/**
 * The table. Deliberately un-annotated so `MetaKind` can be derived from its keys;
 * `RESOLVERS` below re-exports it `satisfies Record<MetaKind, ResolverSpec>`, which
 * type-checks every row — including that each `parent` names a real kind — without
 * making the two declarations circular.
 */
const TABLE = {
  // ---- pjm (项目管理) ----------------------------------------------------------

  /** `GET /v1/pjm/projects` has no exact-name filter (research §4), hence the whole-list load. */
  project: { label: 'project', path: ENDPOINTS.projects, aliases: ['identifier'] },
  work_item_type: { label: 'work item type', path: ENDPOINTS.workItemTypes, ...PROJECT_SCOPED },

  /**
   * The one two-key lookup: `GET /v1/pjm/work_item/states` requires **both**
   * `project_id` and `work_item_type_id` (research §4), so the type rides in
   * `scopeQuery` and also discriminates the cache key. A state name without a type is
   * therefore unresolvable — exit 2, never a guess (see `resolveWorkItemState`).
   */
  work_item_state: {
    label: 'state',
    path: ENDPOINTS.workItemStates,
    ...PROJECT_SCOPED,
    scopeQuery: 'work_item_type_id',
    scopeKind: 'work_item_type',
    scopeFlag: 'type',
    hint: "state changes are workflow-validated: the state must belong to this type's state scheme",
  },

  work_item_priority: { label: 'priority', path: ENDPOINTS.workItemPriorities, ...PROJECT_SCOPED },

  /**
   * 看板 — `GET /v1/pjm/projects/{project_id}/boards`. Project-scoped through
   * the path, like sprints and versions. Board names are unique per project
   * (a duplicate create is 400 `100001`), so the project-scoped cache key is
   * what keeps two projects' identically named boards apart.
   *
   * Needed by `work-item list --board <name>`: the REST list takes `board_id`
   * and the search filter takes `board.id`.
   */
  'pjm-board': {
    label: 'board',
    path: ENDPOINTS.projectBoards,
    ...PROJECT_SCOPED,
    hint: 'list boards with `pingcode project board list --project <p>`',
  },

  /**
   * 看板栏 (board entries / columns). Board-scoped: both the project id and the
   * board id ride in the path. The resolver is project-scoped (parent = project)
   * and uses a custom `boardChildren` loader that lists every board of the
   * project, then lists the entries of each — because the user does not always
   * know which board an entry belongs to, and the API has no project-level
   * entry list.
   *
   * Needed by `work-item list --entry <name>`: the REST list takes `entry_id`
   * and the search filter takes `entry.id`.
   */
  'pjm-board-entry': {
    label: 'board entry',
    path: ENDPOINTS.projectBoards,
    ...PROJECT_SCOPED,
    load: 'boardChildren',
    boardChildPath: ENDPOINTS.projectBoardEntries,
    hint: 'entries belong to a board — list them with `pingcode project board entry list --project <p> --board <b>`',
  },

  /**
   * 泳道 (swimlanes). Same two-level shape as board entries: board-scoped on
   * the API, project-scoped in the resolver with a `boardChildren` loader.
   *
   * Needed by `work-item list --swimlane <name>`: the REST list takes
   * `swimlane_id` and the search filter takes `swimlane.id`.
   */
  'pjm-board-swimlane': {
    label: 'swimlane',
    path: ENDPOINTS.projectBoards,
    ...PROJECT_SCOPED,
    load: 'boardChildren',
    boardChildPath: ENDPOINTS.projectBoardSwimlanes,
    hint: 'swimlanes belong to a board — list them with `pingcode project board swimlane list --project <p> --board <b>`',
  },

  /**
   * 工作项标签 — `GET /v1/pjm/work_item/tags?project_id=`. The endpoint
   * **requires** `project_id` but **ignores** it (returns the whole org's tag
   * list regardless — see the block above `workItemTagVocabulary` in
   * `core/endpoints.ts`), and tag names are not unique. The resolver is
   * therefore project-scoped for cache-key purposes only: the actual list is
   * the same for every project. A name that matches multiple tags produces an
   * ambiguity error listing the candidates — pass the id instead.
   *
   * Needed by `work-item list --tag <name>`: the REST list takes `tag_id` and
   * the search filter takes `tags.id`.
   */
  'pjm-work-item-tag': {
    label: 'work item tag',
    path: ENDPOINTS.workItemTagVocabulary,
    ...PROJECT_SCOPED,
    hint:
      'the tag endpoint ignores project_id (returns the whole org list), and names repeat — ' +
      'pass the id if a name is ambiguous',
  },

  /**
   * 工作项关联类型 — the vocabulary `POST /v1/pjm/work_items/{id}/relations` cannot be
   * called without, and the **only** row S2b adds.
   *
   * It passes all four tests a row is judged by, which is unusual — most candidates fail
   * one:
   *
   *  - **no parent.** `GET /v1/pjm/work_item/relation_types` takes no parameters at all,
   *    so the single `parent` slot `ResolverSpec` offers is not even needed. Same shape
   *    as `release-env` and `scm-platform`.
   *  - **the names are unique**, and so are the `category` slugs: nine rows, 被阻塞 /
   *    阻塞 / 结果 / 原因 / 重复 / 关联 / 副本 / 拷贝 / 提及 (live 2026-08-04, matching
   *    F5's table exactly).
   *  - **it is configuration, and about as static as configuration gets**: all nine rows
   *    report `is_system: 1`, so a 24 h cache cannot go stale in any way that matters.
   *  - **no server-side name filter to be tempted by** — the endpoint has no query
   *    parameters, so the whole (nine-row) list is loaded and a failed lookup prints the
   *    real candidates.
   *
   * `category` is an alias because it is the **stable** key: the ids are 24-hex and
   * differ per tenant, while `relate` / `block` / `blocked_by` do not. The write accepts
   * either (verified live: both the id and the slug create the link, and the response
   * echoes the slug), so the resolved `id` is what gets sent and `--relation relate`
   * still works.
   *
   * The kind is spelled `pjm-relation-type` rather than `relation_type` because
   * "relation" is the other overloaded word in this API: the cross-kind `/v1/relations`
   * family (design D7.6) has no type vocabulary at all, and a bare `resolve
   * relation-type` would look like it belonged to it.
   */
  'pjm-relation-type': {
    label: 'relation type',
    path: ENDPOINTS.workItemRelationTypes,
    aliases: ['category'],
    hint:
      'these are the typed work-item↔work-item link kinds (关联 / 阻塞 / 被阻塞 / …), used by ' +
      '`pingcode project work-item link add`; the cross-kind `work-item relation` family has no ' +
      'types. List them with `pingcode project meta relation-types`, and prefer the stable ' +
      'category slug (relate, block, blocked_by, cause, caused_by, clone, cloned_by, duplicate, ' +
      'mention) over the per-tenant id',
  },

  //
  // **工作项标签 gets no row, and that decision is the interesting half of S2b.**
  // `GET /v1/pjm/work_item/tags?project_id=` looks exactly like the three
  // project-scoped rows above, and it is the only tag enumerator the API has, so a
  // `pjm-work-item-tag` row was the obvious move. Live 2026-08-04 killed it on the one
  // test that matters more than convenience — **would the answer be right?**
  //
  //  - **`project_id` is required and then ignored.** Three different projects returned
  //    the identical 23 rows, byte for byte, and the same rows as the org-level
  //    `GET /v1/pjm/work_item_tags`. So the row would have to claim a project parent
  //    (the query parameter is mandatory) while caching a list the parent does not
  //    scope: N identical cache entries asserting a scoping the API does not have.
  //  - **the resolver would be confidently wrong.** Tags *are* really project-scoped on
  //    the write side: `POST …/work_items/{id}/tags` refused **all 23** ids for a work
  //    item in one project (400 `100354` `'tag'资源不存在`) while accepting **8 of the
  //    same 23** for a work item in another — every id tried, both ways, 2026-08-04.
  //    A row here would answer "the id of tag POC in
  //    project YYHC" with an id that project cannot use — the resolver contract is a
  //    name in a scope → the id valid in that scope, and this endpoint cannot honour
  //    it.
  //  - **the names are not unique**: four `后端`, three `前端`, three `算法`, two
  //    `运维`. The commonest tags would resolve to an ambiguity error listing four
  //    indistinguishable candidates.
  //
  // `project work-item tag add` therefore resolves a name **in the command layer**,
  // uncached, against the work item's own project, and explains `100354` when the
  // server refuses the id. That is the honest shape: one live lookup whose result is
  // not promoted to a cached fact.
  //
  /** The project id rides in the **path** here, so there is no `parentQuery`. */
  sprint: {
    label: 'sprint',
    path: ENDPOINTS.projectSprints,
    parent: 'project',
    hint: 'sprints only exist for scrum/hybrid projects (research §6.14)',
  },

  /**
   * 发布 (a release plan of one project), and the only row S2a adds.
   *
   * It fits the table as it stands: the project id rides in the **path**, exactly
   * like `sprint`, so one parent slot and no engine change. It earns the row on the
   * same three tests every kind is judged by:
   *
   *  - **the name is a key.** Version names are unique per project — a duplicate
   *    create is 400 `100337` `'version'已经存在` (live 2026-08-04) — and the
   *    project-scoped cache key is what keeps two projects' identically named
   *    releases apart.
   *  - **the collection is configuration-like.** A project has a handful of
   *    releases, edited rarely, so a 24 h cache is an optimisation rather than a
   *    stale-answer generator. That is the judgement that *denied* rows to build
   *    records and deploys (design D14.4), which grow once per CI run.
   *  - **the whole list is loaded, not filtered server-side.** `?name=` here is a
   *    **substring** match, not the exact one scm's platform and release's
   *    environment lists offer (design D11.2, D14) — so it cannot answer "which
   *    releases are there", and using it as an `inputQuery` would turn one typo
   *    into several candidates. Loading the list also means a failed lookup prints
   *    the real names.
   *
   * The kind is spelled `pjm-version` although the other pjm rows are unprefixed:
   * "version" is the API's most overloaded word — a pjm release, a wiki page
   * revision, a configuration scheme and two kinds of plan all answer to it
   * ([S§6], design D7.2) — and this name is user-visible as
   * `pingcode resolve pjm-version`.
   *
   * A cached id here *can* go stale in a way a sprint's cannot, because a version
   * is the one thing in the planning surface that deletes. Every write goes through
   * `runWrite`, so a rejected id is invalidated and re-resolved exactly once.
   */
  'pjm-version': {
    label: 'release',
    path: ENDPOINTS.projectVersions,
    parent: 'project',
    hint:
      'a 发布/version here is a project release plan — not a wiki page revision and not a ' +
      'configuration scheme; list them with `pingcode project version list --project <p>`',
  },

  /**
   * Users are an unbounded set, so the candidate list is a `keywords` **search over
   * the input itself** (`inputQuery`), and those keywords discriminate the cache key.
   * An empty result is then not proof of a typo, so the input is passed through as an
   * id — which is what `passThroughWhenEmpty` means.
   */
  user: {
    label: 'user',
    path: ENDPOINTS.users,
    inputQuery: 'keywords',
    aliases: ['display_name', 'username', 'email'],
    passThroughWhenEmpty: true,
  },

  // ---- ship (产品管理): the parent is a product --------------------------------

  /**
   * `GET /v1/ship/products` searches **names only** — `identifier` is not a `keywords`
   * target (ship §5) — so the whole (small) list is loaded and the identifier is
   * matched client-side as an alias. That is what makes `--product SLC` work.
   */
  'ship-product': { label: 'product', path: ENDPOINTS.shipProducts, aliases: ['identifier'] },

  /**
   * `GET /v1/ship/products/{id}/members` returns membership rows whose `id` **is** the
   * user or group id, with no top-level `name` — the display name lives inside `user` /
   * `user_group` (ship §3.6). Hence its own loader.
   */
  'ship-product-member': {
    label: 'product member',
    path: ENDPOINTS.shipProductMembers,
    parent: 'ship-product',
    load: 'productMembers',
    hint: 'only members of this product can be assigned; add them in PingCode first',
  },

  'ship-idea-state': {
    label: 'idea state',
    path: ENDPOINTS.shipIdeaStates,
    ...PRODUCT_SCOPED,
    hint:
      'idea states are scoped to the product; unlike tickets, ship exposes no idea state-flow ' +
      'endpoint, so a transition can only be validated by the server',
  },
  'ship-idea-priority': { label: 'idea priority', path: ENDPOINTS.shipIdeaPriorities, ...PRODUCT_SCOPED },
  'ship-idea-suite': {
    label: 'suite',
    path: ENDPOINTS.shipIdeaSuites,
    ...PRODUCT_SCOPED,
    load: 'suiteTree',
    hint: SUITE_AMBIGUITY_HINT,
  },
  'ship-idea-property': {
    label: 'idea property',
    path: ENDPOINTS.shipIdeaProperties,
    ...PRODUCT_SCOPED,
    hint:
      'property ids are often slugs (backlog_type, identifier), never 24-hex — list them with ' +
      '`pingcode product meta idea-properties --product <p>`',
  },

  'ship-ticket-state': { label: 'ticket state', path: ENDPOINTS.shipTicketStates, ...PRODUCT_SCOPED },
  'ship-ticket-priority': { label: 'ticket priority', path: ENDPOINTS.shipTicketPriorities, ...PRODUCT_SCOPED },
  'ship-ticket-type': {
    label: 'ticket type',
    path: ENDPOINTS.shipTicketTypes,
    ...PRODUCT_SCOPED,
    hint:
      'type_id is required to create a ticket — list the types with ' +
      '`pingcode product meta ticket-types --product <p>`',
  },
  'ship-ticket-channel': {
    label: 'ticket channel',
    path: ENDPOINTS.shipTicketChannels,
    ...PRODUCT_SCOPED,
    hint: 'the channel can only be set when the ticket is created, never patched afterwards',
  },
  'ship-ticket-property': {
    label: 'ticket property',
    path: ENDPOINTS.shipTicketProperties,
    ...PRODUCT_SCOPED,
    hint:
      'property ids are often slugs (solution, identifier), never 24-hex — list them with ' +
      '`pingcode product meta ticket-properties --product <p>`',
  },
  /**
   * `GET /v1/ship/products/{id}/customers` (ship §H) — the vocabulary `--customer` resolves
   * a name against. The product id rides in the **path** (no `parentQuery`), exactly like
   * `sprint`, so the parent slot names `ship-product` for cache keying only. Customer
   * `name` is the resolvable key; ids are 24-hex ([S§]5).
   */
  'ship-ticket-customer': {
    label: 'ticket customer',
    path: ENDPOINTS.shipProductCustomers,
    parent: 'ship-product',
    hint: 'customers are scoped to the product — list them with `pingcode product meta ticket-customers --product <p>`',
  },
  /** `GET /v1/ship/ticket/solutions?product_id=` (ship §K3) — the `--solution` vocabulary. */
  'ship-ticket-solution': {
    label: 'ticket solution',
    path: ENDPOINTS.shipTicketSolutions,
    ...PRODUCT_SCOPED,
    hint: 'list solutions with `pingcode product meta ticket-solutions --product <p>`',
  },
  /**
   * `GET /v1/ship/ticket/tags?product_id=` (ship §K3) — the `--tag` vocabulary. The same
   * rows are also reachable as product tags (`/v1/ship/products/{id}/tags`, catalog L332);
   * the ticket-scoped view is the one the ticket `tags.id` search filter addresses, so it is
   * the resolver's source ([S§]K3).
   */
  'ship-ticket-tag': {
    label: 'ticket tag',
    path: ENDPOINTS.shipTicketTags,
    ...PRODUCT_SCOPED,
    hint: 'list ticket tags with `pingcode product meta ticket-tags --product <p>`',
  },

  /**
   * `cacheOnly`: which plan a product uses is found by scanning every plan for the
   * embedded `product.id` — the list has **no `?product_id=` filter** (ship GOTCHA
   * #23) — so there is no name to resolve, only an answer to cache under the product.
   */
  'ship-ticket-state-plan': {
    label: 'ticket state plan',
    path: ENDPOINTS.shipTicketStatePlans,
    parent: 'ship-product',
    cacheOnly: true,
  },

  /**
   * `cacheOnly`, and parented by the **state plan** rather than the product (design
   * §13.3): two products sharing a plan share the answer, and a product whose plan
   * changes gets a different key for free. The rows are transition edges, not
   * candidates, so `loadTicketStateFlows` owns the encoding.
   */
  'ship-ticket-state-flow': {
    label: 'ticket state flow',
    path: ENDPOINTS.shipTicketStateFlows,
    parent: 'ship-ticket-state-plan',
    cacheOnly: true,
  },

  // ---- testhub (测试管理): the parent is a library ------------------------------
  //
  // Same substitution as ship, plus one split that is load-bearing: the lookups live
  // at three URL shapes. `case/states`, `case/types` and `run/statuses` are
  // *singular*-segment config views taking `?library_id=`; `case_important_levels` is
  // an *underscored* org-level list taking nothing; suites, plans and plan types live
  // *under* `/libraries/{id}/…` and so carry the parent in the path instead.

  /**
   * The bootstrap hop: nothing else in testhub is reachable without a `library_id`, so
   * it has **no parent** and its cache key carries none. Names-only search ([th#12]),
   * exactly as ship products, hence the client-side `identifier` alias behind `--library LIB`.
   */
  'testhub-library': { label: 'test library', path: ENDPOINTS.testhubLibraries, aliases: ['identifier'] },

  /**
   * Case modules (模块) — a tree served flat, joined by a **`parent` reference object**
   * ([th#9], [th#11]). The whole tree is loaded (there is a `?parent_id=` filter, and
   * using it would hide the branches a collision has to be detected across).
   */
  'testhub-suite': {
    label: 'suite',
    path: ENDPOINTS.testhubLibrarySuites,
    parent: 'testhub-library',
    load: 'suiteTree',
    hint: SUITE_AMBIGUITY_HINT,
  },

  /** `state_id` — the only route to changing a case's state ([th#25], [th#28]). */
  'testhub-case-state': {
    label: 'case state',
    path: ENDPOINTS.testhubCaseStates,
    ...LIBRARY_SCOPED,
    hint: `${CONFIGURATION_SCOPE_HINT}. A case's state can only be changed through PATCH /cases/{id}`,
  },

  /** `type_id`. The one config view in this group that needs no `configuration` scope. */
  'testhub-case-type': { label: 'case type', path: ENDPOINTS.testhubCaseTypes, ...LIBRARY_SCOPED },

  /**
   * `important_level_id`, and **deliberately not library-scoped**: the one lookup in
   * the module with no `?library_id=` variant anywhere ([th#40], testhub §5). Keying
   * it per library would shard one identical list into N entries and imply a scoping
   * the API does not have.
   */
  'testhub-case-important-level': {
    label: 'important level',
    path: ENDPOINTS.testhubCaseImportantLevels,
    hint: 'importance levels are organisation-wide in testhub — there is no per-library variant',
  },

  /**
   * `status_id` — the hard prerequisite for every run write ([th#57], GOTCHA #5/#10).
   * These items carry **no slug**: the English slug a run reports (`pass`) and the id
   * a write needs are joined only through the localized `name` (通过), a correspondence
   * the docs never state, and a tenant may add its own. Which is exactly why this is
   * name resolution against the live list rather than a hardcoded map.
   */
  'testhub-run-status': {
    label: 'run status',
    path: ENDPOINTS.testhubRunStatuses,
    ...LIBRARY_SCOPED,
    hint:
      `${CONFIGURATION_SCOPE_HINT}. Run statuses have no slug field, so they resolve by their ` +
      'localized name (通过 / 受阻 / 失败 / 跳过 / 未测), and a tenant may have added its own',
  },

  /**
   * `short_id` is an alias on purpose: `GET …/plans/{plan_id}` accepts one ([th#53])
   * but `bulkRuns` needs the real id in its path and PATCH is id-only (GOTCHA #19), so
   * resolving a short_id here is what lets one reference work on a read and a write.
   * Plan names are unique per library ([th#47]), so a collision means two libraries —
   * which the library-scoped cache key already keeps apart.
   */
  'testhub-plan': {
    label: 'test plan',
    path: ENDPOINTS.testhubLibraryPlans,
    parent: 'testhub-library',
    aliases: ['short_id'],
  },

  /**
   * The `type_id` plan creation requires ([th#47], [th#60]). Scope is
   * `pcp:read:testhub:testplan`, **not** `configuration`, so this row carries no
   * configuration-scope hint — a misplaced one would send a 403 investigation down the
   * wrong path. A plan type has no `kind` discriminator (testhub §10.7), so nothing
   * here can warn that the named type demands a `sprint_id`.
   */
  'testhub-plan-type': {
    label: 'plan type',
    path: ENDPOINTS.testhubLibraryPlanTypes,
    parent: 'testhub-library',
    hint: 'list the types configured for this library with `pingcode testhub meta plan-types --library <library>`',
  },

  /**
   * The `state_id` `PATCH …/plans/{plan_id}` takes, and the **only row S3 adds**.
   *
   * It is org-level, so it has no parent — the same shape as
   * `testhub-case-important-level` and for the same reason, but verified rather than
   * inferred: `GET /v1/testhub/plan_states` takes no parameters at all, there is no
   * `?library_id=` variant anywhere in the module, and the three ids it returns are
   * exactly what a plan PATCH accepts (live 2026-08-04).
   *
   * It passes the tests a row is judged by:
   *
   *  - **the names are unique and they are keys**: 未开始 / 进行中 / 已完成, one per
   *    `type` (`pending` / `in_progress` / `completed`);
   *  - **it is configuration, and as static as it gets**: all three rows report
   *    `is_system: 1`, so a 24 h cache cannot go stale in any way that matters;
   *  - **the whole list is loaded** — the endpoint has no name filter to be tempted
   *    by, so a failed lookup prints the real candidates.
   *
   * The kind is spelled `testhub-plan-state` rather than `plan-state` because
   * "state" is this module's most overloaded word: a *case* state (设计/就绪/废弃), a
   * *plan* state (this one) and a *run* result (通过/失败/…) are three different
   * vocabularies behind three endpoints, and `pingcode resolve` prints the kind
   * names.
   *
   * **S3 deliberately adds no `testhub-case-property` row**, although
   * `GET /v1/testhub/case/properties?library_id=` looks exactly like the
   * product-scoped `ship-idea-property` / `ship-ticket-property` rows it would
   * mirror. Live 2026-08-04 killed it on the only test that matters — *would the
   * answer be usable?*
   *
   *  - **the rows are built-in fields, not custom properties.** All 8 on this tenant
   *    are, and their `id`s are the field keys themselves: `state_id`, `description`,
   *    `steps`, `type`, `important_level`, `maintenance_uid`, `precondition`,
   *    `test_type`.
   *  - **resolving a name to one of those ids would produce a harmful write.** The
   *    only consumer would be `--set`, which builds the `properties` map, and
   *    `properties: {important_level: …}` answers **HTTP 500** while
   *    `properties: {description: 'x'}` answers 200 and rewrites the **top-level**
   *    `description` — i.e. the resolver would hand `--set` a key that silently
   *    edits a different field. Ship's equivalent is safe because its rows really
   *    are custom properties.
   *  - **an unknown `properties` key is already refused upstream** (400 `100043`),
   *    so the client-side lookup buys no error-quality either.
   *
   * `testhub meta case-properties` therefore exists as a *read* only, and its help
   * says which rows are `--set`-able. Same judgement S2b made for work-item tags:
   * a lookup that cannot honour "a name in this scope → an id valid in that scope"
   * does not get a row.
   */
  'testhub-plan-state': {
    label: 'plan state',
    path: ENDPOINTS.testhubPlanStates,
    hint:
      'plan states are organisation-wide (未开始 / 进行中 / 已完成) and are not case states or ' +
      'run results — list them with `pingcode testhub meta plan-states`',
  },

  // ---- scm (源码管理): the parent is a hosting platform ------------------------
  //
  // Same substitution again — a project for pjm, a product for ship, a library for
  // testhub, a **托管平台** for scm — with one thing worth stating because the URL
  // hides it: `/v1/scm/products` is a *hosting platform*, not a ship product, so
  // `scm-platform` and `ship-product` are different kinds over an identically-shaped
  // path and must never share a cache entry. They do not: the kind is part of the
  // cache key.

  /**
   * The bootstrap hop of the whole module: a repository, a platform user and (in
   * S1b/S1c) a branch, PR or review id are all addressed *under* a platform, so
   * nothing in scm resolves without this one first. No parent, therefore no parent
   * in its cache key.
   *
   * The list is loaded whole rather than filtered server-side on purpose: `?name=`
   * is an **exact, case-insensitive** match (live 2026-08-03), so it cannot answer
   * "which platforms are there" — and an org has a handful of platforms, not
   * thousands. Loading the list also means a failed lookup can print the real
   * candidates.
   */
  'scm-platform': {
    label: 'hosting platform',
    path: ENDPOINTS.scmPlatforms,
    hint:
      'a hosting platform is 托管平台 (a GitHub/GitLab/SVN server record), never a ship product; ' +
      'its name is unique per organisation — list them with `pingcode scm platform list`',
  },

  /**
   * The platform id rides in the **path** here, so there is no `parentQuery`.
   *
   * `full_name` (`owner/name`) is an alias because it is the unique key: repository
   * *names* collide freely inside one platform (a fork and its upstream, `.github`
   * in two orgs), and when they do, this resolver reports the ambiguity and the
   * `full_name` is what disambiguates it without looking up an id. Verified live
   * 2026-08-03 on two repositories sharing a name: the ambiguity error lists both
   * ids, and the `full_name` resolves each unambiguously.
   *
   * Note it is the *client* that filters: `GET …/repositories?name=` is silently
   * ignored upstream (live 2026-08-03), so a server-side name filter is not an
   * option even where one appears to exist.
   *
   * The label is `repo`, matching the command (`pingcode scm repo`) — and it also
   * pluralises correctly in the engine's `"x" matches 2 ${label}s` message, which
   * `repository` would not.
   */
  'scm-repo': {
    label: 'repo',
    path: ENDPOINTS.scmRepositories,
    parent: 'scm-platform',
    aliases: ['full_name'],
    hint:
      'repository names are unique only per platform, so pass the full_name (owner/name) or the id ' +
      'when two collide — list them with `pingcode scm repo list --platform <platform>`',
  },

  // ---- release (部署) -----------------------------------------------------------
  //
  // **The only row S1d adds, and the only one it should.** The other two DevOps
  // collections it landed are deliberately absent, for reasons that are the mirror
  // image of this row's:
  //
  //  - **构建记录 gets no row.** Its `identifier` is not unique (two builds may both be
  //    `"9001"`, live 2026-08-04), its list honours **no filter at all**, and a new
  //    record appears on every CI run — so there is no name to resolve, and a 24 h
  //    cached list of build records would be a stale-answer generator rather than an
  //    optimisation. Same judgement S1b made for branches (D12.7 reason 2), only
  //    stronger: branches at least have unique names.
  //  - **部署 gets no row.** A deploy has no name whatsoever — `release_name` is free
  //    text and not unique — so `resolve` would have nothing to match on.

  /**
   * 环境, and the bootstrap hop of the `release` group: `POST /v1/release/deploys`
   * takes an `env_id`, and the caller of a deploy write is a pipeline that knows it is
   * shipping to "production", not to a 24-hex id. Without this row the only route from
   * that name to that id would be `release env list --json | jq`, which is exactly the
   * gap `pingcode resolve` exists to close.
   *
   * It fits the table exactly as it stands — **no parent** (environments are
   * organisation-level, like `scm-platform` and `ship-product`), so no engine change
   * and no second parent slot. That is the difference from the kinds S1b/S1c declined:
   * a branch, a pull request and a review each needed two or three parent ids, which
   * `ResolverSpec` cannot express.
   *
   * Caching is right here, unlike for the two collections above: environments are
   * standing configuration — a handful of named deploy targets an organisation edits
   * rarely — not per-run records.
   *
   * The list is loaded whole rather than filtered server-side, the same call
   * `scm-platform` makes and for the same reason: `?name=` is an **exact,
   * case-insensitive** match (live 2026-08-04), so it cannot answer "which
   * environments are there", and loading the list means a failed lookup prints the
   * real candidates instead of an unhelpful zero-row silence.
   */
  'release-env': {
    label: 'environment',
    path: ENDPOINTS.releaseEnvironments,
    hint:
      'environment names are unique per organisation — list them with ' +
      '`pingcode release env list`, or create one with `pingcode release env create --name <name>`',
  },
} as const;

/**
 * Every metadata kind, **derived from the table** rather than written twice. The
 * failure mode this removes — a resolver added and the union not, or the reverse —
 * type-checked perfectly and only showed up as a cache key nobody ever read.
 */
export type MetaKind = keyof typeof TABLE;

/** What one row declares. Every field is read by `./resolve.ts` and nothing else. */
export type ResolverSpec = {
  /** Human label in error messages: `no ${label} matches "…"`. */
  label: string;
  /**
   * The list endpoint. A **function** means the parent id goes in the path
   * (`/libraries/{id}/plans`), in which case there is no `parentQuery`.
   */
  path: string | ((parentId: string) => string);
  /** The upstream kind whose id scopes this one, and therefore keys its cache. */
  parent?: MetaKind;
  /** The query parameter the parent id rides in, when it is not in the path. */
  parentQuery?: string;
  /**
   * A second scoping parameter, which also discriminates the cache key. Exactly one
   * kind needs it: work-item states are scoped by `(project, work item type)`.
   */
  scopeQuery?: string;
  /**
   * Which kind produces the `scopeQuery` value, and the flag `pingcode resolve` takes
   * it on. Declared here rather than special-cased in the command, so the CLI needs no
   * `if (kind === 'work_item_state')` branch; the flag name is a literal union so that
   * reading it off commander's options stays typed.
   */
  scopeKind?: MetaKind;
  scopeFlag?: 'type';
  /**
   * The query parameter the **user's own input** rides in, for unbounded sets that
   * cannot be listed whole. Implies the cache key is keyed by that input.
   */
  inputQuery?: string;
  /** Extra row keys a user may reasonably type (identifier, username, short_id, …). */
  aliases?: readonly string[];
  /** Guidance appended to the candidate list on a failed lookup. */
  hint?: string;
  /** An empty candidate list means "unbounded set, assume an id" rather than a typo. */
  passThroughWhenEmpty?: boolean;
  /** Non-default candidate loader; `undefined` is the plain paged list. */
  load?: 'suiteTree' | 'productMembers' | 'boardChildren';
  /**
   * For `load: 'boardChildren'`: builds the child-list path from the project id
   * and a board id. The loader lists every board of the project, then lists the
   * children (entries or swimlanes) of each.
   */
  boardChildPath?: (projectId: string, boardId: string) => string;
  /**
   * This kind is a **cache namespace, not a name lookup**: something else (a scan, a
   * transition graph) produces its ids, so `pingcode resolve` does not offer it and
   * `resolveKind` refuses it.
   */
  cacheOnly?: boolean;
};

/** The table, type-checked row by row while keeping the literal keys `MetaKind` needs. */
export const RESOLVERS = TABLE satisfies Record<MetaKind, ResolverSpec>;

/** Registration order, which is the order `pingcode resolve list` prints. */
export const META_KINDS = Object.keys(RESOLVERS) as MetaKind[];

/**
 * The rows a caller can resolve a name against. `pingcode resolve` enumerates exactly
 * this, so its command surface follows the table by construction (design D4.4).
 */
export const RESOLVABLE_KINDS: readonly MetaKind[] = META_KINDS.filter(
  (kind) => specOf(kind).cacheOnly !== true,
);

/**
 * Read one row, widened to `ResolverSpec`. Not decoration: `RESOLVERS` keeps its
 * literal type (that is where `MetaKind` comes from), and reading `.hint` off the
 * resulting union of row types would not compile for the rows that omit it.
 */
export function specOf(kind: MetaKind): ResolverSpec {
  return RESOLVERS[kind];
}

/** The list path for one lookup: from the parent id when the row's `path` is a function. */
export function pathOf(spec: ResolverSpec, parentId: string | undefined): string {
  return typeof spec.path === 'string' ? spec.path : spec.path(parentId ?? '');
}
