# Live Verification

> Unit tests prove our logic; only the running API can prove the API's. And this one answers **HTTP
> 200** to things it does not do. This is how a fact about the live tenant is obtained without
> damage, and what counts as having obtained it.

---

## Overview

`quality-guidelines.md` says API facts are recorded rather than assumed. This file is the other
half — how you get them:

1. **A probe never touches your real credentials.**
2. **A write is not verified until an *independent* read-back agrees.**
3. **A filter is not a flag until it has been proven to filter.**

All three exist because each was learned by losing something: a wiped credential store, a shipped
flag that reported success and changed nothing, and an induction about `?name=` that was formed
twice and falsified twice.

---

## A probe must never see your real config

A coverage probe enumerated every action leaf of the real `buildProgram()` tree and executed each
one with an extra positional argument. The list contained `auth logout` — so the probe ran
`auth logout EXTRA` against the developer's own `~/.pingcode`, deleting `clientId`, `clientSecret`,
the token and the whole metadata cache. Only the human could restore them, and the child that needed
them was blocked until they did.

**Rule: before any script or throwaway test executes a CLI leaf it did not individually choose,
point `PINGCODE_CONFIG_DIR` at a temp directory holding a copy of the credentials.** One line, first
line:

```bash
export PINGCODE_CONFIG_DIR="$(mktemp -d)"     # then copy config.json in at 0600
```

The rest of the rule, in the order the accident taught it:

- **The enumerating probe is the dangerous shape**, not the destructive command. Nobody types
  `auth logout` by accident; a loop over `leafPaths()` calls it without ever naming it. Any generated
  leaf list also contains every `delete` leaf and every `--yes`.
- **Isolate local state even when the probe is "only structural".** That probe *did* inject a `fetch`
  that threw on contact — which is why nothing reached the tenant and only local state was lost. Both
  guards are needed: an injected `fetch` protects the server, `PINGCODE_CONFIG_DIR` protects the user.
- **In test suites, use the shared harness.** `createCliHarness` (`test/helpers/cli.ts`) owns the temp
  directory in `beforeEach`/`afterEach` and calls `buildProgram()`. Do not hand-roll a copy — see the
  harness-parity rule in `quality-guidelines.md`.
- **Live smoke runs get the same treatment**, and did from the S2-series children onward: probe phase
  through `pingcode api`, happy path through the new leaves, `PINGCODE_CONFIG_DIR` on a temp copy
  throughout. That is the convention; this file is only where it finally got written down.
- **Write to isolated tenant objects.** Several families have no DELETE, so a mistake cannot be
  cleaned up: create a `[CLI smoke]`-prefixed container and write inside it rather than into real
  data, and list whatever survives in the task's findings.

---

## HTTP 200 does not mean the field was accepted

**This API silently ignores unknown body fields instead of rejecting them.** A misspelled field name
therefore never fails — it just never takes effect. Three observed cases are worse still, because the
field is accepted, **echoed back in the response**, and never stored:

| Observed | Response says | A second `GET` says |
|---|---|---|
| `env_id` on `PATCH /v1/release/deploys/{id}` | the **new** environment | the **old** environment |
| `operate_at` sent without `stage_id` | the **old** value | unchanged |
| `description: ""` on `PATCH /v1/testhub/libraries/{id}` | accepted | unchanged |

The first one is the important one: it defeats the naive read-back habit, because the response body
*is* the lie. It was caught only because the smoke script ran a separate `get` afterwards.

**Rules:**

- **Verify every write field with an independent read-back — a second `GET`, never the write's own
  response body.** "The response echoed my value" is not evidence.
- **When a field's behaviour is in doubt, probe it twice with distinguishable values.** Send A, read
  back; send B, read back. One round cannot tell "stored" from "echoed".
- **A write field that reports success and changes nothing must not be exposed as a refined flag.** It
  is the same lie as a silently-ignored filter, and worse, because it actively rewards the careful
  caller for trusting it. Keep the field in the `api/` input type — the endpoint documents it and
  `pingcode api` may still send it — send it from no refined leaf, and say so in `--help` and the
  module doc.
- **Field names come from a live probe, not from a plausible reading of the docs.** Silent ignoring
  means a typo is indistinguishable from a no-op.
- **The CLI offers no field-clearing, anywhere.** On several fields `null` answers 200 and changes
  nothing while `[]` is a 400: "this field cannot be emptied" is a real shape on this API. Do not add
  a `--clear`/`--unset` without first proving that the clear actually clears.
- The same standard applies to a *create*: read the object back before believing a field landed. An
  undeclared field can also silently **work** (`type_id` on `POST /v1/testhub/cases/bulk`), which is
  just as much a finding and belongs in `--help` marked as undocumented-but-observed.

---

## A filter must be proven before it becomes a flag

One parameter name, `?name=`, has **four** distinct observed behaviours on this API:

| Behaviour | Observed on |
|---|---|
| silently ignored | scm repositories (`?name=` returns every row); `GET /v1/build/builds` honours no filter at all |
| exact, case-insensitive | scm platforms and branches, release environments |
| **substring**, case-insensitive, no trim | pjm sprints and versions |
| accepted, then silently ignored | ship idea transition histories — which ignores `state_id` and `keywords` too |

**Rule: never generalise a filter's behaviour from a sibling endpoint — probe the family you are
about to expose.** The induction "this API's `?name=` is exact matching" was formed after the first
two rows and falsified by the third; the generalisation is the failure, not any one of the readings.

- **A filter the server ignores MUST NOT become a flag.** A flag that lies is worse than an absent
  one, because the user believes the narrowed result. Omit it and say why in `addHelpText('after')`.
- **If the endpoint *requires* a parameter that it then ignores, expose it and label it** — that is
  the one exception, and the help text says "required by the endpoint and then ignored by it".
- **Describe the proven behaviour in the flag's help using the word that was observed** — `exact` or
  `substring` — never a bare "filter by name".
- **Name resolvers load the whole list and match client-side unless the filter is proven exact *and*
  unique.** A substring filter cannot answer "which ones exist", and a typo that matches several rows
  is precisely what a resolver must not do.
- **Paging is per-family evidence too.** Check that `page_index`/`page_size`/`total` are echoed and
  that consecutive pages are disjoint before trusting `--all` on a new family; some endpoints return
  a bare count block with no envelope at all, whatever the catalog's `paged` flag says (see
  [Catalog Drift](./catalog-drift.md)).

---

## Recording it

Recording rules live in `quality-guidelines.md` ("Real-API facts are recorded, never assumed") and
`catalog-drift.md` ("Live evidence outranks the catalog"). One addition that this task earned:

**Record the negatives.** A field, filter or error-code mapping you *rejected* is written down with
its reason — in the task's findings and, where code acts on it, in a comment beside that code. Every
rejection here is one a later child would otherwise re-add from the docs, since the docs still
promise it and the API still answers 200.

---

## Common Mistakes

- **Running an enumerating probe with the real `PINGCODE_CONFIG_DIR`.** The leaf list contains
  `auth logout`.
- **Treating a write's own response as the read-back.** On at least one path it echoes the value it
  discarded.
- **Reasoning "the sibling endpoint filters, so this one does".**
- **Exposing a flag for a documented field or filter that the server ignores.**
- **Adding a field-clearing flag** without proving the API can empty that field.
- **Recording only what worked**, which guarantees the next child repeats the probe — or, worse, does
  not.
