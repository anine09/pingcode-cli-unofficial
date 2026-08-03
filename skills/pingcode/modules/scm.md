# 源码管理 (scm) — `scm`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the scm surface, once it exists.

**Reserved. These commands do not exist yet** — do not tell the user to run them, and do not
invent flags for them. S1a–S1c (hosting platforms, platform users, repositories, branches, commits, refs, pull requests, code reviews) lands the surface, and the child that lands it fills this file in the
same commit as its `test/help/<group>.test.ts`.

Why the file exists before the commands do: it is the per-module write scope that keeps parallel
children off each other's documentation (design D6.4/D6.6). One module, one file, one owner.

Two facts worth writing down now, because they are already decided:

- every scm endpoint is **企业令牌 only**, which the CLI's `client_credentials` token already is;
- `PUT` is excluded on purpose (full replacement blanks unsent fields), so there will be no
  `scm ... replace` leaf — use `PATCH`-backed `update`, or the generic escape hatch.
