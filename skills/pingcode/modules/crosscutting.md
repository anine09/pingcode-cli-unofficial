# 跨对象资源 — relations / comments / attachments / activities

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the cross-object surface, once it exists.

**Reserved. These commands do not exist yet** — do not tell the user to run them, and do not
invent flags for them. F5 (mounted onto work items, ideas, tickets and cases rather than given a top-level group) lands the surface, and the child that lands it fills this file in the
same commit as its `test/help/<group>.test.ts`.

Why the file exists before the commands do: it is the per-module write scope that keeps parallel
children off each other's documentation (design D6.4/D6.6). One module, one file, one owner.

The shape is decided: these live **under the entity they belong to**, so the entity's own
command path supplies `principal_type` and nobody has to type it. There is deliberately no
top-level `comment` group.
