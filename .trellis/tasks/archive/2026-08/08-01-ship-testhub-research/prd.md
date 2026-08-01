# Research Ship (product) and Testhub (test) API modules

Research-only task. No production code changes. PRD-only (no `design.md` / `implement.md`) —
the deliverable is two reference documents, not a feature.

## Goal

The CLI currently covers only the `pjm` (项目管理) area: ~15 of its 145 endpoints. Two further
modules are wanted next, and neither has endpoint-level research yet. Produce that research so a
follow-up task can design `pingcode product …` and `pingcode test …` command surfaces from facts
rather than guesses.

## Scope

| Module | API area | Endpoints | Deliverable |
| --- | --- | --- | --- |
| 产品管理 / Ship | `ship` | ~101 | `research/ship-api.md` |
| 测试管理 / Testhub | `testhub` | ~65 | `research/testhub-api.md` |

Out of scope: `wiki`, `scm`, `build`, `release`, `reviews`, `nexus`, `permission`, `security`, and
anything with no REST surface at all (Flow, Insight, Goals, Plan; webhooks are Flow-UI only).

## Method

The docs site is an apiDoc SPA whose landing page scrapes to nothing. The authoritative machine-readable
source is **`https://open.pingcode.com/api_data.json`** (~2.37 MB, 579 records, ~460 real endpoints,
each with parameters, response fields, examples and per-endpoint scopes). There is no OpenAPI/Swagger
and no official SDK. Docs are Simplified Chinese only.

Two researchers run in parallel, one per area, with a hard instruction to stay inside their own area so
the reports cannot conflict.

## Established API facts the research must respect

These come from `.trellis/tasks/archive/2026-08/07-31-pingcode-cli-mvp/research/` and from the live
smoke run; the new reports must not contradict them without evidence:

- List envelope `{page_size, page_index, total, values}`; `page_index` 0-based, default 30, max 100,
  offset-only, echoed back by the server.
- Errors `{code, message}` with `code` as a **string**; this API returns **HTTP 400 where REST
  convention uses 401/404**. Known codes: `100000`, `100038` (rate limit), `100024`, `100317`, `100303`.
- Rate limit 200 req/min per identity → 429 + `x-pc-retry-after`; 2xx carries no rate-limit headers.
- Timestamps are 10-digit Unix **seconds** everywhere.
- ID shapes are **not** uniform: 24-hex ObjectIds, 32-hex users, bare string slugs for pjm system
  work-item types. Never shape-validate an id.
- Only `POST /v1/nexus/ces/find` supports sorting anywhere in the API.
- Most `*_id` values are parent-scoped, so a CLI must resolve metadata per parent before writing.

## Requirements

- R1 Each report contains a **complete** endpoint table for its area: method, path, required vs
  optional parameter names, declared scope, one-line purpose, grouped by resource family. Exhaustive,
  not illustrative.
- R2 Resource inventory with endpoint counts per family.
- R3 Response field lists for the core resources of each area, with exact field names and any doc
  inconsistency called out (singular vs plural, object vs array, `0/1` vs boolean).
- R4 The search/filter DSL for any `POST …/search` endpoint in the area: body shape, operators per
  field type, non-filterable fields.
- R5 A parent-scoping map: which id is scoped to which parent, i.e. the lookups a write requires.
- R6 Cross-module relationships to `pjm`, since the CLI already covers it.
- R7 A numbered GOTCHAS list in bug-list style — replace-vs-merge array semantics, required-together
  params, silently-ignored fields, type-conditional fields, ordering constraints.
- R8 Full enum catalogue with the exact English slugs the API expects (Testhub especially: run
  statuses, case types, priorities, plan states).
- R9 A recommended MVP subset per area (~10–15 endpoints) that would make an agent-usable command
  surface, with the reasoning for exclusions.
- R10 An explicit "could not determine from `api_data.json`" section per report.

## Acceptance Criteria

- [ ] AC1 `research/ship-api.md` and `research/testhub-api.md` exist in this task directory.
- [ ] AC2 Every endpoint table row cites a real `api_data.json` record; no invented paths or params.
- [ ] AC3 Neither report contradicts the established facts above without stating the evidence.
- [ ] AC4 Both reports contain R7 gotchas and R9 an MVP subset — a bare endpoint dump is not enough.
- [ ] AC5 Testhub's report catalogues the enums (R8), including the known
      `not_start|pass|block|failure|skip` run statuses, and confirms whether the known
      `steps[]`-is-replace-not-merge gotcha generalises to other arrays.
- [ ] AC6 No credential, token or tenant-identifiable value appears in either report — this repository
      is public and CI scans for exactly that (`npm run scan:secrets`).
- [ ] AC7 Reports are committed; the repository's production code is untouched by this task.

## Non-Goals

- Implementing any `pingcode product` / `pingcode test` command.
- Calling the live API. This is documentation research; no credentials are used.
- Deciding the eventual command surface — the MVP subsets are input to that decision, not the decision.
