# Code Reuse Thinking Guide

> **Purpose**: Stop and think before creating new code - does it already exist?

---

## The Problem

**Duplicated code is the #1 source of inconsistency bugs.**

When you copy-paste or rewrite existing logic:
- Bug fixes don't propagate
- Behavior diverges over time
- Codebase becomes harder to understand

---

## Before Writing New Code

### Step 1: Search First

This repo is indexed by CodeGraph (`.codegraph/`). One
`codegraph_explore` / `codegraph explore` call returns the verbatim source of
the relevant symbols plus their callers — including dynamic-dispatch hops
grep cannot follow. Reach for it before a grep/read loop for "does this
exist" or "how does X work" questions.

Grep stays the fallback — for configs, docs, and anything the index does not
cover:

```bash
# Search for similar function names
grep -r "functionName" .
```

### Step 2: Ask These Questions

| Question | If Yes... |
|----------|-----------|
| Does a similar function exist? | Use or extend it |
| Is this pattern used elsewhere? | Follow the existing pattern |
| Could this be a shared utility? | Create it in the right place |
| Am I copying code from another file? | **STOP** - extract to shared |

---

## Common Duplication Patterns

### Pattern 1: Copy-Paste Functions

**Bad**: Copying a validation function to another file

**Good**: Extract to shared utilities, import where needed

### Pattern 2: Similar Components

**Bad**: Creating a new component that's 80% similar to existing

**Good**: Extend existing component with props/variants

### Pattern 3: Repeated Constants

**Bad**: Defining the same constant in multiple files

**Good**: Single source of truth, import everywhere

### Pattern 4: Repeated Payload Field Extraction

**Bad**: Multiple consumers cast the same JSON fields locally:

```typescript
const versions = (res as { versions?: string[] }).versions;
const labels = (res as { labels?: string[] }).labels;
```

This is duplicated contract logic even when the code is only two lines. Each
consumer now has its own definition of what a valid payload means.

**Good**: Put the decoder, type guard, or projection next to the data owner:

```typescript
const workItems = parseWorkItems(res); // src/api/parse/ owns the shape
```

**Rule**: If the same untyped payload field is read in 2+ places, create a
shared type guard / normalizer / projection before adding a third reader.

---

## When to Abstract

**Abstract when**:
- Same code appears 3+ times
- Logic is complex enough to have bugs
- Multiple people might need this

**Don't abstract when**:
- Only used once
- Trivial one-liner
- Abstraction would be more complex than duplication

---

## After Batch Modifications

When you've made similar changes to multiple files:

1. **Review**: Did you catch all instances?
2. **Search**: Run grep to find any missed
3. **Consider**: Should this be abstracted?

### Reducers Should Use Exhaustive Structure

When state is derived from action-like values (`action`, `kind`, `status`,
`phase`), prefer a reducer with one `switch` over scattered `if/else` updates.

```typescript
// BAD - action-specific state transitions are hard to audit
if (action === "opened") { ... }
else if (action === "comment") { ... }
else if (action === "status") { ... }

// GOOD - one reducer owns the transition table
switch (event.action) {
  case "opened":
    ...
    return;
  case "comment":
    ...
    return;
}
```

When the parsed source is the source of truth, the reducer is the documented
replay model; display code and commands should not duplicate pieces of that
replay model.

---

## Checklist Before Commit

- [ ] Searched for existing similar code (CodeGraph first, grep as fallback)
- [ ] No copy-pasted logic that should be shared
- [ ] No repeated untyped payload field extraction outside a shared decoder
- [ ] Constants defined in one place
- [ ] Similar patterns follow same structure
- [ ] Reducer/action transitions live in one reducer or command dispatcher

---

## Gotcha: Asymmetric Mechanisms Producing the Same Output

**Problem**: When two different mechanisms must produce the same result
(e.g., a command that walks target directories itself vs. one that calls the
shared engine), structural changes only propagate through the mechanism
everyone edits. The other one silently drifts.

**Symptom**: One code path handles the new layout; another still uses the old
one. No error is raised.

**Prevention**:
- **Best**: Eliminate the asymmetry — have the manual path call the shared
  engine. Skill file operations live in `src/core/skill-ops.ts`; new commands
  call it instead of re-walking directories.
- **If asymmetry is unavoidable**: Add a regression test that compares outputs
  from both mechanisms
- When restructuring directories, search for ALL code paths that reference
  the old structure

---

## Single Sources of Truth

Each concern below is owned by exactly one module. Commands import; they
never redefine.

| Concern | Owner |
|---------|-------|
| API endpoint paths & method wiring | `src/api/endpoints.ts` |
| Wire normalization (0/1 → boolean, `versions[]` vs `version`) | `src/api/parse/` |
| Command group registration | `src/cli/registry.ts` (one line per command) |
| Secret redaction | `src/core/redact.ts` (output re-exports, never re-implements) |
| Test CLI harness & credential fakes | `test/helpers/` (`cli.ts`, `fake.ts`) |

A second copy of any of these is a duplication bug even when the copies are
currently identical — the next fix will land in only one of them.
