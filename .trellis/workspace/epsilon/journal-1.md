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

