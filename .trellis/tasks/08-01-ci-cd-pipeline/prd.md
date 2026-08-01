# CI/CD: GitHub Actions checks and tag-driven releases

## Goal

Give the repository an automated quality gate on every push/PR, and a repeatable way to cut a
release from a git tag. The project is published at
`https://github.com/anine09/pingcode-cli-unofficial` (public, single `main` branch, no npm
package yet).

## Context

- Stack: Node >= 20, strict TypeScript, ESM. Runtime deps: `commander`, `picocolors`. Dev deps:
  `typescript`, `vitest`, `tsup`, `@types/node`. `package-lock.json` **is** tracked, so `npm ci`
  is usable.
- Existing local commands: `npm run typecheck`, `npm test` (213 tests, zero network — `fetch` is
  injected), `npm run build` (tsup → `dist/bin/pingcode.js`), `npm run skill:install`.
- There is no `.github/` directory yet and no git tags yet. Current version is `0.1.0`.
- Commit conventions are already specified in `.trellis/spec/guides/commit-conventions.md`
  (Conventional Commits 1.0.0, fixed type whitelist) but nothing enforces them.
- This repo has already needed one history-wide sanitisation pass because tenant-identifiable
  values reached both file contents and commit messages. A cheap recurring scan is wanted.

## Decisions

| # | Decision |
|---|---|
| D1 | Two workflows: `ci.yml` (push to `main` + all PRs) and `release.yml` (tags `v*`). Concurrency group per ref with `cancel-in-progress` on CI only. |
| D2 | CI runs the build/test matrix on Node **20, 22, 24** (engines say >=20; 24 is the dev machine). Ubuntu only. |
| D3 | `npm ci` with `actions/setup-node` npm cache. No new dependencies of any kind — every gate is a `node:`-only script or a shell step. |
| D4 | Core gate order per matrix job: `typecheck` → `test` → `build` → built-binary smoke (`--version`, `--help`) → `npm run skill:install -- --dry-run` (non-TTY path: lists both global targets, writes nothing). |
| D5 | Secret/tenant scan is its own script `scripts/scan-secrets.ts`, also exposed as `npm run scan:secrets`, run once per CI run (not per matrix leg). It scans tracked files **and** the commit messages in the pushed/PR range. Targeted patterns only — no generic hex-id matching, which would fire on every git sha. |
| D6 | Commit-message gate is its own script `scripts/check-commits.ts` (`npm run check:commits`), validating the spec's rules: `type(scope): subject`, type from the whitelist, lowercase non-empty subject, no trailing period, subject <= 72 chars. Merge commits are exempt. On a PR it also validates the PR title (squash merges take the title). |
| D7 | Release is tag-driven: `v<semver>` must equal `package.json` version or the job fails before doing anything else. Then full checks on Node 20, `npm pack`, and a GitHub Release with auto-generated notes plus the tarball attached. **No `npm publish`** — publishing stays a Non-Goal until the package name is claimed. |
| D8 | Least privilege: `permissions: contents: read` at workflow level; only the release job elevates to `contents: write`. Actions pinned to major tags (`actions/checkout@v4`, `actions/setup-node@v4`). |
| D9 | Every gate must be runnable locally with the same command CI uses, so failures are reproducible without pushing. |

## Requirements

- R1 `.github/workflows/ci.yml`: triggers per D1, matrix per D2, steps per D3/D4.
- R2 A single non-matrix `checks` job in `ci.yml` running the secret scan (D5) and the commit
  gate (D6).
- R3 `scripts/scan-secrets.ts`: node builtins only; patterns for `client_secret=<value>`,
  `PINGCODE_CLIENT_SECRET=<value>` / `PINGCODE_CLIENT_ID=<value>` with a real-looking value,
  `Authorization: Bearer <token>` literals, and tenant hosts matching
  `<slug><digits>.pingcode.com`; must ignore its own pattern definitions, `dist/`, `node_modules/`,
  and the redaction placeholders (`***REDACTED***`, `example-tenant`, masked ids). Exit 1 with the
  file:line on any hit, exit 0 otherwise.
- R4 `scripts/check-commits.ts`: takes a commit range (or reads the PR title from env) and applies
  D6's rules; exit 1 listing every offending subject.
- R5 `.github/workflows/release.yml` per D7.
- R6 README gains a short CI/CD section: badge, what runs, how to cut a release, and how to run
  each gate locally.
- R7 `.trellis/spec/guides/commit-conventions.md` gains a line stating the rule is now
  machine-enforced, and points at `scripts/check-commits.ts`.
- R8 New scripts are covered by tests in the existing vitest suite (pure-function level: the
  subject validator and the pattern matcher), keeping the zero-network rule.

## Acceptance Criteria

- AC1 `npm run typecheck && npm test` stay green; test count goes up, not down.
- AC2 `npm run scan:secrets` exits 0 on the current clean tree, and exits 1 with a precise
  file:line when a fake `client_secret=abcdef123456` line is introduced <!-- scan-secrets:allow -->
  (verified by temporarily adding one, then removing it).
- AC3 `npm run check:commits` exits 0 for the existing history on `main`, and exits 1 for a
  deliberately malformed subject such as `Fixed stuff.`.
- AC4 Both workflow files are valid YAML and reference only existing npm scripts and existing
  files.
- AC5 After pushing, the CI run on GitHub is green — verified with `gh run list` / `gh run view`,
  not assumed.
- AC6 No new entries in `dependencies` or `devDependencies`; `package-lock.json` unchanged except
  for nothing at all.
- AC7 A release dry check: `release.yml`'s version-match step fails when tag and
  `package.json` disagree (reasoned through and unit-tested at the script level if that logic
  lives in a script).
- AC8 No secret, token or tenant-identifiable value is added to any file or commit message.

## Non-Goals

- Publishing to npm (needs the package name and an `NPM_TOKEN`).
- Cross-OS matrix (macOS/Windows runners), coverage reporting/thresholds, dependency-update bots.
- Signing or provenance/attestation for the release artifact.
- Any real PingCode API call in CI — there are no credentials in CI and none will be added.
- Auto-bumping the version or generating a CHANGELOG.
