# 产品管理 (ship) — `product`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the ship command surface plus the ship-specific traps.

### Products — 产品管理

A **product** (产品) is ship's parent scope, the way a project is pjm's. Resolve it first: every other
ship id is scoped to it.

```bash
pingcode product list --json
pingcode product list --keywords sales --json
pingcode product get SLC --json          # name, identifier such as SLC, or id
```

`--keywords` searches the **name only** — the identifier is not searchable server-side, so the CLI
matches it client-side over the full list. There is no `product create`/`update`/`delete`: ship has no
product DELETE at all, and `PATCH` only edits three cosmetic fields.

### `product meta` — mandatory before writing an idea or ticket

```bash
pingcode product meta idea-states       --product SLC --json
pingcode product meta idea-priorities   --product SLC --json
pingcode product meta idea-suites       --product SLC --json
pingcode product meta idea-properties   --product SLC --json
pingcode product meta members          --product SLC --json
pingcode product meta ticket-states     --product SLC --json
pingcode product meta ticket-priorities --product SLC --json
pingcode product meta ticket-types      --product SLC --json
pingcode product meta ticket-channels   --product SLC --json
pingcode product meta ticket-properties --product SLC --json
```

`product meta members` is the **only** valid source of `--assignee` values for ideas and tickets —
the organisation directory is not, because a user who is not a member of the product cannot be
assigned. `product meta idea-properties` / `product meta ticket-properties` are the only source of `--set` keys and,
for select-typed properties, of the option ids you must send instead of the display label.

### Requirements 需求 — `product idea`

```bash
pingcode product idea list --product SLC --json
pingcode product idea list --product SLC --state 待评审 --assignee zhangsan --json
pingcode product idea list --product SLC --keywords sso --page-size 20 --page 0 --json
pingcode product idea list --product SLC --all --limit 200 --json

pingcode product idea get SLC-1 --json                # identifier, id, or a pasted idea URL

pingcode product idea create --product SLC --title "Single sign-on" --dry-run --json
pingcode product idea create --product SLC --title "Single sign-on" \
  --assignee zhangsan --priority P1 --suite "客户端 / 登录" --json

pingcode product idea update SLC-1 --title "Single sign-on (v2)" --json
pingcode product idea update SLC-1 --state 开发中 --json
pingcode product idea update SLC-1 --set 需求类型=5cb7e763fda1ce4ca0010002 --json
```

`product idea list` is `POST /v1/ship/ideas/search` — the plain list endpoint cannot filter by assignee, date
or custom property, so the CLI never uses it. Note there is **no `--type`** anywhere on `idea`: ship
states are scoped to the product alone, which `--product` (or, on `update`, the idea itself) already
supplies.

### Tickets 工单 — `product ticket`

```bash
pingcode product ticket list --product SLC --json
pingcode product ticket list --product SLC --type 故障 --state 待处理 --json
pingcode product ticket list --product SLC --channel 邮件 --all --limit 200 --json

pingcode product ticket get SLC-7 --json

pingcode product ticket create --product SLC --type 故障 --title "Cannot log in" --dry-run --json
pingcode product ticket create --product SLC --type 故障 --title "Cannot log in" \
  --assignee zhangsan --priority P1 --channel 邮件 --json

pingcode product ticket update SLC-7 --title "Cannot log in (iOS)" --json
pingcode product ticket transition SLC-7 --state 处理中 --json
```

`--type` is **required** on `product ticket create` — `type_id` is a required body field, which is the one
place ship demands a lookup (`pingcode product meta ticket-types --product SLC`) before a write can even be
attempted. `--channel` can only be set at create time; there is no way to change it afterwards.

## 4b. Ship rules that will bite you

These are on top of §4, which still applies. Ship is a different module with the same machinery, and
almost every difference is a trap.

1. **Resolve the product first, and scope everything to it.** A product is to ship what a project is
   to pjm. `state_id`, `priority_id`, `suite_id`, `type_id`, `channel_id`, the `properties` keys and
   the assignable people are **all product-scoped**. They frequently *look* org-global — the same
   priority id `P0` appears under several products — but the API requires `product_id` on every
   lookup, so never carry an id from one product to another.
2. **`--assignee` must be a product member.** `pingcode product meta members --product <p>` is the
   only valid candidate set; the organisation directory (`settings users`) is not, and a non-member is
   rejected.
3. **`--state <name>` needs no companion flag here.** Unlike pjm, ship states hang off the product
   alone, so there is no `--type` on `idea` at all, and `--type` on `ticket` is a real field being
   written, not a lookup aid. `--state` and `--state-id` remain mutually exclusive.
4. **Reads go through `search`.** `product idea list` and `product ticket list` are `POST …/search`. The plain list
   endpoints exist but cannot filter by assignee, date or custom property, so the CLI never uses
   them. Search takes **one operator per field and has no `$and`/`$or`**; multiple filters are
   AND-ed. There is still no sorting anywhere.
5. **No state change is refused locally — the server decides, and a ticket refusal is explained.**
   - `pingcode product ticket transition` and `product ticket update --state` send the PATCH. If the server refuses
     it, the error `message` names the product's configured states, the current state and — when
     the state plan can be read — **the states reachable from the current one**. Read it from
     `message`: `--json` errors are `{kind,message,code,exit}` and carry no hint.
   - Want to know before you write? `product ticket transition <t> --state <s> --dry-run` prints the
     reachable set on stderr and sends nothing.
   - `pingcode product idea update --state` gets the configured states on rejection but never a reachable
     set: ship publishes no idea state-flow endpoint at all.
   - The CLI does **not** refuse a transition on its own (the one exception: moving a ticket to the
     state it is already in, which is exit 2). The server refuses atomically with no state change,
     so a local check saves nothing — and a mis-identified state plan would otherwise block a legal
     move with no escape hatch. Expect the server's exit code, not exit 2, for an illegal target.
6. **`--set key=value` sends the value verbatim, and select properties want option ids.** For a
   `select`-typed property the API expects the option's `_id`, not the label you see in the UI —
   the docs' own examples only show text properties, which is the trap. Run
   `pingcode product meta idea-properties --product <p>` (or `ticket-properties`): it prints each key and
   its `label=option_id` pairs. `properties` **replaces**, it never merges.
7. **Nothing in ship can be deleted.** There is no DELETE for products, ideas or tickets, and
   `is_archived` / `is_deleted` are read-only. A test artifact you create is permanent — mark it in
   the title (for example `[CLI smoke] …`) before you create it, not after.
8. **Ship identifiers are not lookup keys.** `SLC-1` cannot be fetched directly; the CLI resolves it
   through `search` and then filters to an exact identifier match. A pasted URL ends in a `short_id`,
   which no endpoint accepts either, so prefer an id or an identifier over a URL.
9. **`--suite` filtering on `product idea list` is undocumented.** The API lists `suite.id` as neither
   filterable nor unfilterable, so an empty result proves nothing. The CLI warns when you use it.
10. **Tags cannot be set through the API** on ideas or tickets, and `submitter_id` on a ticket is
    silently ignored under a client-credentials token — the ticket is attributed to the token owner
    with no error. The CLI exposes neither.
