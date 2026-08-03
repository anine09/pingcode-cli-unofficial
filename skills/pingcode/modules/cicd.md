# 构建与部署 (build / release) — `build`, `release`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the build and deployment write-back surface, once it exists.

**Reserved. These commands do not exist yet** — do not tell the user to run them, and do not
invent flags for them. S1d (build records, environments, deployments) lands the surface, and the child that lands it fills this file in the
same commit as its `test/help/<group>.test.ts`.

Why the file exists before the commands do: it is the per-module write scope that keeps parallel
children off each other's documentation (design D6.4/D6.6). One module, one file, one owner.

These are PingCode's **write-back** APIs: a CI job pushes the build/deploy facts it just
produced, so the work item can show them. They are not a pipeline runner.
