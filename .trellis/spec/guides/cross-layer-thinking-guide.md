# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:

- CLI passes a flag the core layer never expected
- core hands the API layer a typed value the wire layer must re-shape
- Multiple layers implement the same normalization differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:

- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary              | Common Issues                     |
| --------------------- | --------------------------------- |
| CLI command ↔ core    | Flag parsing vs typed settings; the `--json` output contract |
| core ↔ API            | Typed request vs raw wire JSON; which token type applies |
| API ↔ PingCode wire   | `0/1` vs boolean, `versions[]` vs `version`, null vs absent |

### Step 3: Define Contracts

For each boundary:

- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: A command knows the raw wire shape

**Good**: Each layer only knows its neighbors

### Mistake 4: Every Consumer Parses The Same Payload

**Bad**: A command reads API JSON and casts fields inline:

```typescript
const versions = (res as { versions?: string[] }).versions;
const labels = (res as { labels?: string[] }).labels;
```

This looks local, but it means every consumer owns a private version of the
wire contract. The next field change updates one command and misses another.

**Good**: Decode once at the wire boundary, then consume typed values:

```typescript
const workItems = parseWorkItems(res); // src/api/parse/ owns the shape
```

**Rule**: For JSON streams, RPC payloads, or config files, create one
owner for:

- payload type definitions
- type guards and normalization from `unknown`
- projections used by commands

Command code may format values, but it must not redefine the payload
contract.

---

## Checklist for Cross-Layer Features

Before implementation:

- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens

After implementation:

- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip
- [ ] Checked that consumers import shared decoders / projections instead of
      casting payload fields locally

---

## Ownership Across Boundaries

### Ctx is the only channel from CLI to core

Commands never import `src/core/*` modules directly for behavior — they
receive `Ctx` (credentials, settings, http, output helpers) created by
`createContext`. `test/layering.test.ts` enforces the direction. Violating
it breaks the `--json` output contract and the secret redaction guarantee.

### Errors are a contract, not per-layer creativity

`src/core/errors.ts` owns the error kinds and their exit codes. The bin
layer maps them to process exit codes once; `src/api/` throws core errors,
never its own. A new failure mode means a new error kind with an assigned
exit code — not a throwaway string in one command.

### The API layer owns wire shape

`src/api/parse/` is the only place that decodes PingCode's raw JSON
(`0/1` → boolean, `versions[]` vs `version`, null vs absent). Commands
receive already-typed values and never re-cast raw fields. A second decoder
in a command is the mistake this boundary exists to prevent.

### Redaction has one owner

`src/core/redact.ts` owns secret masking; `src/cli/output/` re-exports it.
Two redaction implementations means one will be missed in a new output
path.

---

## When to Create Flow Documentation

Create detailed flow docs when:

- Feature spans 3+ layers (CLI → core → API)
- Multiple teams are involved
- Data format is complex
- Feature has caused bugs before

---

## Config / Payload Boundary

Files that multiple layers read (config, cached catalogs, JSON bodies) are
cross-layer contracts. The owner module defines the typed shape; every
consumer uses it.

```
user input → command → core/config.ts readConfig → typed Config → core/logger
```

### Checklist: After Adding A New Config Key Or Payload Field

- [ ] Add the key to the owner's type (`Config` in `src/core/config.ts` for
      config keys; a decoder in `src/api/parse/` for wire payloads)
- [ ] Add normalization at the owner, not at consumers (missing vs null,
      legacy shapes)
- [ ] Commands and output code consume the typed value, not the raw JSON
- [ ] Add at least one regression proving two different consumers read the
      same normalized value
