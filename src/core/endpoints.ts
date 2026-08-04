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

  // -------------------------------------------------------------------------
  // 迭代 (sprints) + 发布 (versions) — research §3.8.5-6, live-verified
  // 2026-08-04 (design D15). The planning half of pjm: what a sprint or a
  // release *is*, as opposed to the work items inside it.
  // -------------------------------------------------------------------------
  //
  // Both families are project-scoped through the **path**, both are day-granular,
  // and both have an organisation-level `POST …/bulk` twin that is **企业令牌
  // only and declares no scope at all** — two of the three non-DevOps ENT-only
  // endpoints in the whole API ([S§3.8.5]/[S§7]A). `pingcode api describe` says so
  // per endpoint; the refined leaves repeat it in `--help`.
  //
  // Missing symmetry, upstream, deliberately not worked around:
  //
  //  - **there is no sprint DELETE** ([S§3.8.5]). The path supports GET and PATCH
  //    only, so a sprint created by mistake is permanent. `pingcode api DELETE`
  //    refuses it at the catalog pre-flight, which is the honest answer.
  //  - **there is no project DELETE** either ([S§3.8.1]).
  //  - a version *does* delete, and cleanly — see below.
  //  - pjm has **no `PUT` anywhere**, so design D8.4 (PUT never gets a refined
  //    leaf) is satisfied vacuously here rather than by omission.
  //
  // Live findings, 2026-08-04, public cloud (design D15). None of these are in
  // the docs, and four of them contradict what the docs or the catalog say:
  //
  //  - **`?name=` is a SUBSTRING, case-insensitive filter on both lists**, not the
  //    exact match scm's platform/branch `?name=` and release's environment
  //    `?name=` are (design D11.2, D14). `?name=print` returned all four
  //    `Sprint N` rows and `?name=2` returned only `Sprint 2`. So it is a real
  //    search, and the flag is documented as one — but it is *not* a candidate
  //    enumerator, which is why the two resolvers still load the whole list.
  //  - **`?status=` filters, and is enum-validated** (400 `100003` on a bad
  //    value). On the sprint list it names the sprint's own `status`
  //    (`pending|in_progress|completed`); on the **version** list it names the
  //    stage's `type` (`pending|in_progress|published`) — a version resource has
  //    no `status` field at all, so the filter is named after a field that does
  //    not exist in the response.
  //  - **`?stage_id=` on the version list is silently ignored** (all rows came
  //    back, including those in other stages), so no flag exposes it (D11.2's
  //    rule: a dead filter is worse than no filter). `?assignee_id=` and
  //    `?keywords=` are ignored on the sprint list for the same reason.
  //  - **the server snaps the window to whole days.** A `start_at` of 12:00 was
  //    stored as `00:00:00` and an `end_at` of 12:00 as `23:59:59` of the same
  //    date, on create *and* on patch, for both families. That is exactly the
  //    asymmetry `parseDateBoundaryFlag` already implements, so `--start` /
  //    `--end` take dates rather than instants here.
  //  - **`versions.stage_id` is documented (and catalogued) as required on
  //    `POST /v1/pjm/versions/bulk` and is not**: a bulk create without it
  //    answered 200 and defaulted to the first stage, exactly as the single
  //    create does. No `OPTIONAL_QUERY_OVERRIDES`-style row was added, because
  //    `missingRequired` only checks top-level body keys and this one is nested
  //    (`versions.stage_id`), so nothing is refused — the only cost is one
  //    misleading line in `api describe`.
  //  - **both bulk endpoints are atomic, and neither is capped.** A batch whose
  //    *second* entry collided with an existing name created nothing (sprints:
  //    400 `100390`; versions: 400 `100001`), and a 60-entry version batch was
  //    accepted in full — so the CLI invents no client-side limit, unlike
  //    testhub's runs bulk where 50 is documented ([TH§7]). Two entries sharing a
  //    name *within* one batch is HTTP **500** `100000`, and still creates
  //    nothing. An empty array is 400 `100039`.
  //  - **the project segment is enforced on three of the five version verbs.**
  //    `GET` and `PATCH …/projects/{any}/versions/{version_id}` **ignore it
  //    entirely** and act on the version in its real project (verified by writing
  //    through a foreign project id and reading the change back through the right
  //    one), while `DELETE` refuses with 400 `1003107` `发布与项目不匹配`. The
  //    sprint family enforces it on both verbs (400 `100309` `'project'不匹配`).
  //  - **a sprint cannot be created in a kanban project**, and the refusal is
  //    400 `100300` `'project'资源不存在` — the same code an absent project id
  //    returns. The list answers 200 with zero rows instead. Versions have no
  //    such restriction and work in kanban projects too. This is why `100300` is
  //    **not** in `ERROR_CODE_OVERRIDES`: it conflates "no such project" with
  //    "this project has no iteration module".
  //  - **deleting a version detaches it from every work item that referenced it**
  //    — 200, and the work item's `versions`/`version` field is simply gone. No
  //    refusal (unlike a release environment in use, D14.7) and no orphan
  //    (unlike an scm branch, D12.5). The DELETE response is the deleted version.
  //  - **`operate_at` alone is silently ignored.** Sent without a `stage_id` it
  //    answers 200 and echoes the *old* value; it is only honoured alongside a
  //    stage change, and moving to a stage that has no recorded `operate_at`
  //    *requires* it (400 `100395`
  //    `输入的'operate_at'必须在开始和发布时间之间`). `progress`, `changelog`,
  //    `description` on a version and any other undocumented key are accepted and
  //    dropped, which is the API-wide behaviour D11.3 recorded.
  //  - **no field in either family is a `*_name` upsert.** Probed with
  //    `assignee_name`: 200, ignored, and no ghost user appeared in the directory
  //    — so unlike scm's `sender_name` / `owner_name` (D12.1) there is no hazard
  //    here, and consequently no warning anywhere.

  /** GET + PATCH only — **no DELETE exists** ([S§3.8.5]). The project segment is enforced. */
  projectSprint: (projectId: string, sprintId: string): string =>
    `/v1/pjm/projects/${encodeURIComponent(projectId)}/sprints/${encodeURIComponent(sprintId)}`,
  /** Org-level, **企业令牌 only, no declared scope**. Each entry carries its own `project_id`. */
  sprintsBulk: '/v1/pjm/sprints/bulk',

  /** 发布 = release = version. Unrelated to `/v1/wiki/pages/{id}/versions` ([S§6]). */
  projectVersions: (projectId: string): string =>
    `/v1/pjm/projects/${encodeURIComponent(projectId)}/versions`,
  /** GET/PATCH ignore the project segment; DELETE enforces it (400 `1003107`). */
  projectVersion: (projectId: string, versionId: string): string =>
    `/v1/pjm/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
  /** Org-level, **企业令牌 only, no declared scope**, and `stage_id` is not really required. */
  versionsBulk: '/v1/pjm/versions/bulk',

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

  // -------------------------------------------------------------------------
  // scm (源码管理 / DevOps 数据集成) — research §3.12.1-3, live-verified 2026-08-03
  // -------------------------------------------------------------------------
  //
  // Three warnings that apply to every path below.
  //
  //  1. **`/v1/scm/products` is a *hosting platform*, not a ship product.** The two
  //     resources share a URL segment and nothing else: a ship product is 产品 in
  //     产品管理, an scm "product" is 托管平台 — a GitHub/GitLab/SVN server record.
  //     The CLI therefore calls it `scm platform`, and the resolver kind is
  //     `scm-platform`, so the two can never be confused at a call site.
  //  2. **The whole area is 企业令牌-only** ([S§3.12]): these are the write-back
  //     integration endpoints a CI system uses, and `client_credentials` — which is
  //     the only flow this CLI has — is exactly the token they want. Scopes are
  //     `pcp:read:devops:code` / `pcp:write:devops:code`.
  //  3. **`PUT` is deliberately absent here.** All three families document a fifth
  //     verb (`PUT …/products/{id}`, `…/users/{id}`, `…/repositories/{id}`) that
  //     replaces the whole record and blanks every field the caller omits. Design
  //     D8.4 keeps every `PUT` out of the refined layer; they stay reachable as
  //     `pingcode api PUT /v1/scm/products/<id>` and nowhere else.
  //
  // Live findings (2026-08-03, public cloud) that the docs do not state:
  //
  //  - `GET /v1/scm/products?name=` is an **exact, case-insensitive** filter, not a
  //    fuzzy one: `name=github` returns the platform named `Github`, `name=git`
  //    returns nothing. So it cannot stand in for a search, and name resolution
  //    loads the (short) list and matches client-side instead.
  //  - `GET …/repositories?name=` is **silently ignored** — only `full_name`
  //    filters. Passing `name` returned all 38 repositories of the platform.
  //    `scm repo list` therefore exposes `--full-name` and not `--name`.
  //  - a repository's `owner_name` is an **upsert**: an unknown git username is
  //    created as a platform user rather than rejected (200 + a fresh owner id).
  //  - **unknown body fields are silently dropped**, not rejected: posting
  //    `user_id` / `email` to `…/users` returned 200 and stored neither. So a
  //    misspelled field name fails quietly, which is why the CLI sends only the
  //    documented ones.
  //  - Absence is answered with HTTP **400** and a per-resource code:
  //    `100200` platform, `100202` repository, `100209` platform user — on `GET`
  //    *and* on `PATCH*`. All three are in `ERROR_CODE_OVERRIDES` (exit 5).
  //    A path segment that is not an ObjectId is a real `404` + `100002`
  //    (`资源路径错误`) instead, which the status-first mapping already handles.
  //  - Other codes seen and deliberately left on exit 7: `100003` (`type` is not a
  //    valid enum value) and `100220` (`'product'已经存在`, a duplicate platform name).

  /** 托管平台. `?name=` is an exact, case-insensitive filter (live 2026-08-03). */
  scmPlatforms: '/v1/scm/products',
  scmPlatform: (platformId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}`,

  /**
   * 托管平台用户 — a **git author identity**, not a PingCode member.
   *
   * The resource carries `name` / `display_name` / `html_url` / `avatar_url` and
   * **no reference to a PingCode member** (live 2026-08-03: the response has no
   * `user`, no `user_id`, no `email`, and posting those field names is accepted and
   * ignored). Attribution works through the name string: a commit's
   * `committer_name` and a branch's `sender_name` are matched against these records
   * ([S§3.12.7]), which is why creating them is a prerequisite for S1b's write-back
   * rather than optional configuration.
   *
   * `?name=` is an exact filter here too, and a name is unique per platform.
   */
  scmPlatformUsers: (platformId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/users`,
  scmPlatformUser: (platformId: string, userId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/users/${encodeURIComponent(userId)}`,

  /** 代码仓库. `full_name` (`owner/name`) is unique per platform; `name` is not. */
  scmRepositories: (platformId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories`,
  scmRepository: (platformId: string, repositoryId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}`,

  // -------------------------------------------------------------------------
  // scm, part 2: 代码分支 / 提交 / 提交引用 — research §3.12.4, §3.12.7,
  // live-verified 2026-08-03 (design D12)
  // -------------------------------------------------------------------------
  //
  // The three warnings above still apply. Four more, specific to these families:
  //
  //  1. **代码分支 is the one scm family with a `DELETE` and no `PUT`.** Every other
  //     family has the mirror shape (a `PUT` and no `DELETE`), so "complete the
  //     family by adding a replace" is a mistake waiting to happen here — there is
  //     nothing to add. `test/help/scm.test.ts` asserts no `replace` leaf exists.
  //  2. **提交 is org-level: `/v1/scm/commits` carries no platform and no
  //     repository.** It is the only scm resource addressed outside a 托管平台
  //     (live: an unfiltered list returned 3725 rows spanning every platform), which
  //     is why `scm commit …` takes no `--platform` while every other leaf demands
  //     one. A consequence worth stating: an unfiltered `commit list` is a whole-org
  //     scan, so `?sha=` / `?work_item_id=` are the intended entry points.
  //  3. **提交引用 needs BOTH `meta_type` and `meta_id`, and both are required
  //     query parameters** — so "list every ref in this repository" is not an
  //     operation this API offers; refs are listed per branch. `meta_type` accepts
  //     only `branch` (live: `commit` → 400 `100003`, enum rejection).
  //  4. **`sha` is the one identifier this API shape-validates.** A non-SHA `sha`
  //     body field is 400 `100003` (`'sha'不是有效的字符串(不是SHA格式)`), and
  //     `GET /v1/scm/commits/{…}` accepts a full 40-hex SHA or a 24-hex id but
  //     **not an abbreviated SHA** (live: an 8-char prefix is 404 `100002`). The CLI
  //     still validates nothing client-side — ids pass through untouched — but the
  //     help text says so, because "abbreviated SHA" is what a git user will try.
  //
  // Live findings (2026-08-03) that the docs do not state:
  //
  //  - a branch's **`sender_name` is an upsert**, exactly like a repository's
  //    `owner_name`: an unknown git username returned 200 and created a fresh
  //    托管平台用户. A commit's **`committer_name` is NOT** — it is a flat string on
  //    the commit and created nothing, which follows from `POST /v1/scm/commits`
  //    having no platform in its path to create an identity in.
  //  - **`work_item_identifiers` silently drops unknown identifiers**: a mixed
  //    `["YYHC-10", "NOSUCH-99999"]` returned 200 with only the real one linked. The
  //    array's *shape* is validated (an empty string is rejected) but its elements'
  //    existence is not, so a caller cannot tell a partial link from a full one by
  //    status alone — the response's own `work_items` is the only evidence, which is
  //    why the commands compare the two and warn.
  //  - `?name=` on the branch list is an **exact, case-insensitive** filter that is
  //    genuinely honoured — unlike the repository list's, which is ignored. Branch
  //    names are unique per repository (a duplicate is 400 `100217`), so this is a
  //    complete name→id lookup in one request and needs no resolver row.
  //  - `is_default` differs by verb: `POST` takes `true` or `false`, `PATCH` takes
  //    **only `true`** (400 `100005` otherwise) and additionally clears the flag on
  //    whichever branch held it. The first branch created in an empty repository
  //    becomes the default with no field sent.
  //  - **the default branch cannot be deleted** (400 `100223`), and deleting a branch
  //    does **not** clean up its 提交引用: afterwards
  //    `GET …/refs?meta_type=branch&meta_id=<deleted>` answers **HTTP 500**
  //    (`100000`) while the ref itself still reads by id. Refs have no `DELETE`, so
  //    that is permanent — hence the unusually specific `--yes` consequence text.
  //  - Absence is answered with HTTP **400** and a per-resource code, as elsewhere in
  //    scm: `100201` branch (on `GET`/`PATCH`/`DELETE` *and* on a `POST …/refs` whose
  //    `meta_id` is unknown), `100206` commit (on `GET` by id *or* by SHA, and on a
  //    `POST …/refs` whose `sha` is unknown), `100207` reference. All three are in
  //    `ERROR_CODE_OVERRIDES` (exit 5).
  //  - Deliberately left on exit 7: `100217`/`100214`/`100215` (duplicate branch /
  //    commit / ref — conflicts, not absences), `100005` (`is_default` validation),
  //    `100223` (the default-branch refusal: the branch plainly exists) and `100000`
  //    (a genuine 500).

  /**
   * 代码分支. `?name=` is exact and case-insensitive; names are unique per
   * repository, so it is a complete lookup rather than a search.
   */
  scmBranches: (platformId: string, repositoryId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}/branches`,
  scmBranch: (platformId: string, repositoryId: string, branchId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}/branches/${encodeURIComponent(branchId)}`,

  /** 提交 — **org-level**, no platform or repository in the path. `?sha=`, `?work_item_id=`. */
  scmCommits: '/v1/scm/commits',
  /**
   * `GET` one 提交 by **id or full SHA** (the path parameter is literally
   * `{commit_id_or_sha}`). Whatever the caller typed goes through verbatim: no shape
   * check, ever. An abbreviated SHA is not accepted upstream.
   */
  scmCommit: (commitIdOrSha: string): string =>
    `/v1/scm/commits/${encodeURIComponent(commitIdOrSha)}`,

  /** 提交引用 — repository-scoped, and the list requires `meta_type` + `meta_id`. */
  scmRefs: (platformId: string, repositoryId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}/refs`,
  scmRef: (platformId: string, repositoryId: string, refId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}/refs/${encodeURIComponent(refId)}`,

  // -------------------------------------------------------------------------
  // scm, part 3: 拉取请求 / 代码评审 — research §3.12.5-6 (design D13)
  // -------------------------------------------------------------------------
  //
  // The three warnings at the top of the scm section still apply (a "product" is a
  // hosting platform, the whole area is 企业令牌-only, `PUT` never reaches the refined
  // layer). Four more, specific to these two families:
  //
  //  1. **A code review here is NOT the cross-object `/v1/reviews` resource.** Two
  //     unrelated things share the word: `/v1/reviews` (8 endpoints, generic layer) is
  //     a polymorphic 评审 object addressed by `principal_type` + `pilot_id` and used
  //     by 需求/用例 review flows, while these four are 代码评审 — a review event on one
  //     pull request, reachable only under `…/pull_requests/{id}/reviews`. They share
  //     no id space and no field set. Do not "unify" them.
  //  2. **Both families keep their `PUT` out of the refined layer** (D8.4), so each
  //     contributes four leaves, not five. The exclusion rests on the general rule that
  //     a replacement blanks every field you do not send — **not**, as an earlier
  //     revision of this comment claimed, on `PUT` promoting `source_branch_id` to
  //     required where `POST` leaves it optional. The S1c smoke falsified that: `POST`
  //     requires `source_branch_id` too (`100224 源分支是必填字段`, at every status), so
  //     the catalog's `required: false` for it is wrong and the CLI marks the flag
  //     required. Source and target must also differ (`100211`).
  //  3. **`PATCH …/pull_requests/{id}` requires `status`** — the only PATCH in scm with
  //     a mandatory field ([S§3.12.5]; the review PATCH has none). A partial update
  //     that only changes the title therefore cannot be expressed as one request, so
  //     the command layer re-reads the pull request and re-emits its current status,
  //     the same read-modify-write testhub's run patch settled on ([TH§7]). Confirmed
  //     live: a status-less PATCH answers `100008 'status'是必填字段`, and the resulting
  //     PATCH is genuinely partial — untouched counts and work-item links survive it.
  //  4. **A review is addressed under its pull request, so its path has three parents**
  //     (platform, repository, pull request) — the deepest path in the CLI. There is no
  //     org-wide or repository-wide review list: reviews are enumerated one pull
  //     request at a time, exactly as refs are enumerated one branch at a time. Note
  //     that `GET …/pull_requests/{unknown}/reviews` returns **200 with an empty list**
  //     rather than a not-found code — the one scm child list that hides a missing
  //     parent (a missing platform or repository still yields `100200`/`100202`).
  //
  // Field shapes worth knowing before writing a command (docs + the shipped examples;
  // read/write asymmetries follow the module's usual pattern):
  //
  //  - reads return **references** (`author`, `merged_by`, `reviewer`,
  //    `source_branch`, `target_branch`) while writes take **name/id scalars**
  //    (`creator_name`, `merged_by_name`, `reviewer_name`, `source_branch_id`,
  //    `target_branch_id`). The two never appear in the same payload.
  //  - `status` is a closed enum on both: `open|closed|merged|abandoned` for a pull
  //    request, `comment|approved|request_changes` for a review. Neither is validated
  //    client-side — a value the server later accepts must not be refused by a CLI
  //    that shipped before it.
  //  - `number` is unique per repository and is the only human-readable key a pull
  //    request has (there is no `identifier` and no `short_id`), which is why the list
  //    exposes `?number=`. That filter is **real and exact** (S1c smoke: two pull
  //    requests, `?number=` returned exactly the matching one and zero rows for an
  //    unused number) — unlike the repository list's `?name=`, which is silently
  //    ignored (D11.2). `?work_item_id=` filters too, and rejects an unknown id with
  //    `100317`, which already maps to exit 5.
  //  - `merged_at` / `merged_commit_sha` / `merged_by_name` are documented as required
  //    **when `status` is `merged`**, and the server does enforce it: omitting them
  //    answers `100212 请提供'merged_at'，'merged_commit_sha'，'merged_by_name'值`. The
  //    CLI passes the conditional through rather than second-guessing it.
  //  - `creator_name`, `merged_by_name` and `reviewer_name` all **upsert** a platform
  //    user, so an unknown git username silently becomes a permanent identity (scm has
  //    no user DELETE). Verified live for all three; a commit's `committer_name` does
  //    **not**, because that path carries no platform (D12.1).
  //  - a review's `submitted_at` is required on create; there is no `created_at` on the
  //    resource, so it is the only time a review carries.
  //
  // **No DELETE in either family**, like the rest of scm: a pull request and a review
  // are permanent once written.

  /**
   * 拉取请求 — repository-scoped. `?number=` and `?work_item_id=` are the two
   * documented filters.
   */
  scmPullRequests: (platformId: string, repositoryId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}/pull_requests`,
  scmPullRequest: (platformId: string, repositoryId: string, pullRequestId: string): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}/pull_requests/${encodeURIComponent(pullRequestId)}`,

  /**
   * 代码评审 — nested under one 拉取请求, and **not** the cross-object `/v1/reviews`
   * resource (see the note above). The list takes no query parameters at all.
   */
  scmPullRequestReviews: (
    platformId: string,
    repositoryId: string,
    pullRequestId: string,
  ): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}/pull_requests/${encodeURIComponent(pullRequestId)}/reviews`,
  scmPullRequestReview: (
    platformId: string,
    repositoryId: string,
    pullRequestId: string,
    reviewId: string,
  ): string =>
    `/v1/scm/products/${encodeURIComponent(platformId)}/repositories/${encodeURIComponent(repositoryId)}/pull_requests/${encodeURIComponent(pullRequestId)}/reviews/${encodeURIComponent(reviewId)}`,

  // -------------------------------------------------------------------------
  // build (构建记录) + release (环境 / 部署) — the other two DevOps areas,
  // research §3.12.8-10, live-verified 2026-08-04 (design D14)
  // -------------------------------------------------------------------------
  //
  // Same area, same token type as scm: **企业令牌 only**, because these are the
  // write-back endpoints a CI system calls. Different scopes though —
  // `pcp:read:devops:build` / `pcp:write:devops:build` for builds and
  // `pcp:read:devops:deploy` / `pcp:write:devops:deploy` for **both** environments
  // and deploys (there is no separate `release` scope).
  //
  // Three structural facts, before the surprises:
  //
  //  1. **Everything here is organisation-level.** No platform, no repository, no
  //     project appears in any of these six paths — a build record and a deploy are
  //     free-standing facts joined to work items by `work_item_identifiers` and
  //     nothing else. So these two groups take no parent flag at all, the way
  //     `scm commit` does not (D12.6), and unlike every other scm leaf.
  //  2. **A deploy is the one resource here with a parent**, and it is an
  //     environment (`env_id` in the body, `environment` on reads).
  //  3. **`PUT` stays out of the refined layer** (D8.4): `PUT /v1/build/builds/{id}`,
  //     `…/environments/{id}` and `…/deploys/{id}` are reachable only as
  //     `pingcode api PUT <path>`.
  //
  // Live findings (2026-08-04, public cloud) — the docs state none of these:
  //
  //  - **`GET /v1/release/environments?name=` is NOT required**, though both the
  //    vendor docs and therefore the catalog mark it `required: true`. An unfiltered
  //    list returns every environment (HTTP 200). The refined `release env list`
  //    consequently never sends it unless asked; the generic layer needed a
  //    correction row (`PARAM_REQUIRED_OVERRIDES` in `core/catalog/index.ts`), or
  //    `pingcode api GET /v1/release/environments` would refuse a call the API
  //    accepts. When it *is* sent it is an **exact, case-insensitive** filter —
  //    `name=cli-smoke-prod` and `name=CLI-SMOKE-PROD` both match, `name=cli-smoke`
  //    matches nothing — the same shape as a platform's or a branch's `?name=`.
  //  - **`GET /v1/build/builds` honours no filter whatsoever.** It documents none,
  //    and `?identifier=`, `?name=`, `?status=`, `?provider=` and `?work_item_id=`
  //    were each probed live and **silently ignored** (all four rows came back every
  //    time). So `build list` offers paging only and is always a whole-organisation
  //    scan; a silently-dead filter is worse than no filter (D11.2).
  //  - **`GET /v1/release/deploys?env_id=` does filter**, exactly, and an unknown but
  //    well-formed id yields 200 with zero rows rather than an error. `?status=`,
  //    `?release_name=` and `?work_item_id=` are ignored, so only the documented one
  //    is exposed.
  //  - **A build `identifier` is not unique.** Two builds were created with
  //    `identifier: "9001"` and both were accepted, so an identifier can never be a
  //    lookup key here — and since the list has no filter either, the only way to
  //    reach a build is the id from `build create` or a page walk.
  //  - **An environment name IS unique per organisation** (`100105
  //    '<name>'环境已经存在`), which together with the exact `?name=` filter is what
  //    makes `release-env` a resolvable metadata kind.
  //  - **`env_id` and the three timestamps are shape-validated server-side**, which
  //    is rare on this API (`sha` was the only known case, D12.2): a non-ObjectId
  //    `env_id` is 400 `100003` (`不是有效的id`) and an out-of-range `start_at` — `0`,
  //    or milliseconds instead of seconds — is 400 `100004`
  //    (`数值不是有效的时间戳`). The CLI still validates no id shape; it converts
  //    date input to unix **seconds** and lets the server judge the rest.
  //  - **`html_url` must be a URL and cannot be cleared**: `html_url: ""` is 400
  //    `100003` (`不是URL格式`), so there is no way to remove one once set.
  //  - **`work_item_identifiers` silently drops unknown identifiers** on both
  //    families, exactly as in scm (D12.4): a mixed `["YYHC-10","NOSUCH-99999"]`
  //    returned 200 with only the real one linked, and `[""]` is rejected
  //    (`100006`). PATCH **replaces** the whole set and `[]` clears it. The commands
  //    therefore compare what was asked for against the response's `work_items`.
  //  - **`env_id` is NOT patchable on a deploy, though the docs list it as updatable.**
  //    `PATCH /v1/release/deploys/{id}` with an `env_id` answers 200 **and echoes the new
  //    environment in the response body**, but a following `GET` still returns the old one.
  //    Reproduced twice through raw HTTP (with and without a `status` in the same request)
  //    after the CLI smoke first surfaced it. This is the worst shape a silent failure can
  //    take — the response confirms a change that did not happen — so `release deploy
  //    update` offers no `--env` at all and there is no way to move a deploy between
  //    environments. Every *other* PATCH field on both families was verified to persist by
  //    reading the record back.
  //  - **A deploy's time window can only be moved end-first.** A new `start_at` is
  //    validated against the **stored** `end_at`, not against an `end_at` sent in the same
  //    request: moving a window forward in one PATCH is 400 `100102`
  //    (`开始时间必须小于等于已存在的结束时间`). Two calls in a fixed order work. On a create the
  //    equivalent check is 400 `100041` (`开始时间必须小于等于结束时间`) — a different code for
  //    the same class of rule.
  //  - **Nothing here takes a `*_name` reference field**, so — unlike scm's
  //    `sender_name` / `owner_name` / `creator_name` — no flag in these two groups can
  //    upsert a ghost identity. Probed for, and deliberately not warned about
  //    (asserting a hazard that does not exist is as wrong as omitting one that does,
  //    D12.1).
  //  - **Deleting an environment that a deploy references is refused**, 400 `100106`
  //    (`'environment'正在使用，不能被删除`) — and once the referencing deploys are
  //    gone the delete succeeds. This is the **opposite** of the scm branch/ref
  //    hazard (D12.5), where deleting a parent orphaned children and left a permanent
  //    HTTP 500: the release family enforces referential integrity server-side, so
  //    nothing here can be orphaned.
  //  - Absence is HTTP **400** with one stable code per resource, as everywhere else:
  //    `100203` build (on `GET`, `PATCH` **and** `DELETE`), `100204` deploy
  //    (`GET`/`PATCH`), `100205` environment (`GET`/`PATCH`, and on
  //    `POST /v1/release/deploys` when `env_id` names no environment). All three are
  //    in `ERROR_CODE_OVERRIDES` (exit 5). A path segment that is not an ObjectId is
  //    a real 404 + `100002`, which the status-first mapping already handles.
  //  - Deliberately left on exit 7: `100105` (duplicate environment name — a
  //    uniqueness conflict), `100106` (the in-use refusal — the environment plainly
  //    exists), and `100003` / `100004` / `100006` / `100008` (input validation,
  //    `100008` being the cross-module "missing required field" code), plus `100102` /
  //    `100041` (the two time-window rules above — both are validation, and both concern a
  //    record that plainly exists).

  /** 构建记录 — org-level, and **no filter of any kind** on the list (live 2026-08-04). */
  buildRecords: '/v1/build/builds',
  buildRecord: (buildId: string): string => `/v1/build/builds/${encodeURIComponent(buildId)}`,

  /** 环境 — org-level. `?name=` is exact, case-insensitive and **optional**, despite the docs. */
  releaseEnvironments: '/v1/release/environments',
  releaseEnvironment: (environmentId: string): string =>
    `/v1/release/environments/${encodeURIComponent(environmentId)}`,

  /** 部署 — org-level, scoped to an environment by `env_id`, which is also its only filter. */
  releaseDeploys: '/v1/release/deploys',
  releaseDeploy: (deployId: string): string =>
    `/v1/release/deploys/${encodeURIComponent(deployId)}`,
} as const;
