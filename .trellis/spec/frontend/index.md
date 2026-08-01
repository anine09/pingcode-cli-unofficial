# Frontend Development Guidelines

> **Not applicable to this project.**

---

## Overview

`pingcode-cli` has **no frontend**. It is a single Node.js command-line package: no browser bundle,
no UI framework, no components, no hooks, no client-side state management. There is no React, Vue,
Svelte or DOM code anywhere in `src/`, and no runtime dependency that could introduce one (the list
is frozen at `commander` + `picocolors`).

The files listed below are the unmodified Trellis templates. They are **deliberately left unfilled**:
writing frontend conventions for a codebase that has no frontend would be invention, not
documentation, and an AI assistant reading them would be misled.

If a UI is ever added to this repository, fill them then — grounded in the code that exists at that
point.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | N/A — no frontend |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | N/A — no frontend |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | N/A — no frontend |
| [State Management](./state-management.md) | Local state, global state, server state | N/A — no frontend |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | N/A — no frontend |
| [Type Safety](./type-safety.md) | Type patterns, validation | N/A — no frontend |

---

## Where to look instead

Everything under `src/` — including the user-facing output layer (`src/cli/`) — is covered by the
backend guidelines:

- [`../backend/index.md`](../backend/index.md) — start here
- [`../backend/directory-structure.md`](../backend/directory-structure.md) — the `cli` / `api` /
  `core` layering invariant
- [`../backend/logging-guidelines.md`](../backend/logging-guidelines.md) — the stdout/stderr and
  `--json` output contract, which is this project's closest analogue to a presentation-layer rule
- [`../backend/quality-guidelines.md`](../backend/quality-guidelines.md) — strict-TypeScript rules
  and the testing policy

---

**Language**: All documentation is written in **English**.
