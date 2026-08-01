# Journal - epsilon (Part 1)

> AI development session journal
> Started: 2026-07-31

---

## 2026-08-01 — S8 real-API smoke (pingcode-cli-mvp)

Ran the 13-step S8 list against the live cloud org (`https://open.pingcode.com`, 9 projects), target
project `RDD` (kanban). Full evidence: `.trellis/tasks/07-31-pingcode-cli-mvp/research/s8-smoke.md`.

- Green: auth status/--check, 0600 config + 0700 dir + 0600 hashed cache with no secrets, project and
  meta reads, all four work-item reference forms, paging, filters, `--all`/`--limit`, dry-run
  (provably sent nothing), create, `--state-id` transition, title update, empty patch → 2, missing
  flag → 2, unresolvable name → 2, corrupted-token → transparent 401 re-auth + replay, `--verbose`
  leaks no secret, `--json` stdout pure with empty stderr across 19 commands. `typecheck` + 200 tests
  still green; no source changed.
- Created exactly one artifact: **RDD-26** `bbbbbbbbbbbbbbbbbbbbbbbb` (`[CLI smoke] …`), awaiting a
  delete decision.
- Gate G5: (1) `page_index`/`page_size` are genuinely honoured on GET lists — echoed back, real row
  limits, 0-based offsets, empty page past the end; (2) `expires_in` is an **absolute unix-seconds
  epoch** (1788105520 vs now 1785513519), so the `n > 1e9` branch is the production one and the clamp
  never fired; (3) a second `client_credentials` call does **not** invalidate the first — both tokens
  probed 200 seconds apart from each other.
- Three deviations left unfixed because each contradicts an explicit `design.md` contract (brief says
  stop): F1 the API omits a work item's `type`, so `update/transition --state <name>` and the
  candidate-state hint are dead (only `--state-id` works); F2 missing resources return HTTP 400
  (`100317`), so exit 5 is unreachable server-side; F3 bad credentials return HTTP 400 (`100024`), so
  exit 3 never fires — while an invalid *bearer* token does correctly return 401.

---

## 2026-08-01 — S9 finish (pingcode-cli-mvp)

Full-scope check, docs, spec, cleanup. AC verdicts with per-criterion evidence now live in `prd.md`.

- Checks: `typecheck` clean; `npm test` **13 files / 213 tests**; `tsup` build 89.6 KB; root + all
  **15** leaf `--help` pages exit 0 with the right usage header; unknown command → 2;
  `skill:install --dry-run` lists both targets and writes nothing.
- AC11 done properly: searched the *actual* stored `client_id` / `client_secret` / access token as
  literal substrings across every `git ls-files` entry → **0 hits** each. Added `.pingcode/` to
  `.gitignore` as a belt-and-braces guard, since `PINGCODE_CONFIG_DIR` can point into the repo.
- AC8 is the one honest "partial": 3 / 2 / 5 are live-observed, but **403 → 4 and 429 → 6 are
  unit-tested only** (org-admin token never got denied; provoking 429 means ~200 req/min against the
  user's production org). Said so in `prd.md` rather than ticking it clean.
- `README.md` rewritten for a first-time reader: install, 凭据管理 app + the four scopes, cloud vs
  self-hosted login, command surface, the `--json` contract, the exit-code table **with** the three
  400-mapped codes, the caveats that actually bite, and the follow-up list.
- `.trellis/spec/backend/` filled from real code (layering + its test, stdout purity, exit-code
  contract, redaction, error-mapping policy, testing + API-fact discipline). `database-guidelines.md`
  became "Local State & Persistence" — no DB, but `~/.pingcode/` deserves the same rigour.
  `.trellis/spec/frontend/` marked **N/A**: no frontend, so inventing one would just mislead.
- Deleted the smoke artifact **RDD-26** (user-approved) with one direct
  `DELETE /v1/pjm/work_items/bbbbbbbbbbbbbbbbbbbbbbbb` → **HTTP 200**; RDD back to 25 items, zero
  `[CLI smoke]` titles. Two new API facts fell out (gotchas 33–34): that DELETE endpoint exists at
  all and is a **soft** delete, and its response — uniquely — *does* carry `type`, which narrows F1's
  wording without changing the `--type` flag's necessity.


