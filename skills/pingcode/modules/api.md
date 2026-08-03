# 通用逃生舱 — the generic executor

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the generic executor and its discovery commands, once they exist.

**Reserved. These commands do not exist yet** — do not tell the user to run them, and do not
invent flags for them. F3 (a catalog-checked passthrough for every one of the 459 v1 endpoints, plus `list` / `describe` discovery) lands the surface, and the child that lands it fills this file in the
same commit as its `test/help/<group>.test.ts`.

Why the file exists before the commands do: it is the per-module write scope that keeps parallel
children off each other's documentation (design D6.4/D6.6). One module, one file, one owner.

When it lands, this file is also where the two rules that surprise people go: its stdout is
always raw JSON (so `--json` changes nothing), and a `DELETE` needs `--yes`.
