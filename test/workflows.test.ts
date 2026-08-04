import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The workflows cannot be executed here, so this suite asserts the properties
 * that would otherwise only be discovered after a push (prd 08-01-ci-cd-pipeline
 * AC4/AC7): every command they run exists as an npm script, the least-privilege
 * grants are in place, and the release job's tag/version guard is present and
 * fails on a mismatch.
 *
 * Text-level assertions on purpose: adding a YAML parser would break the
 * zero-new-dependencies rule this task is built on.
 *
 * The cross-workflow checks read the **directory** rather than a hardcoded pair,
 * so a workflow added later cannot be governed by nothing: a job this suite
 * cannot see is a job that can rot (task 08-02-full-api-coverage X2).
 */
function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const WORKFLOW_DIR = '.github/workflows';

const workflows = readdirSync(fileURLToPath(new URL(`../${WORKFLOW_DIR}`, import.meta.url)))
  .filter((name) => name.endsWith('.yml'))
  .sort()
  .map((name) => ({ name, text: read(`${WORKFLOW_DIR}/${name}`) }));

const ci = read(`${WORKFLOW_DIR}/ci.yml`);
const release = read(`${WORKFLOW_DIR}/release.yml`);
const catalogCheck = read(`${WORKFLOW_DIR}/catalog-check.yml`);
const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  bin: Record<string, string>;
  version: string;
};

function npmScriptsUsedIn(workflow: string): string[] {
  const used = new Set<string>();
  const re = /npm run ([a-z:]+)/g;
  for (let match = re.exec(workflow); match !== null; match = re.exec(workflow)) {
    const name = match[1];
    if (name !== undefined) used.add(name);
  }
  if (/npm test\b/.test(workflow)) used.add('test');
  return [...used].sort();
}

describe('workflows', () => {
  it('are each governed by an explicit block below', () => {
    // Adding a workflow means adding its own assertions; the loops in this
    // describe cover every file, the per-file describes cover the rest.
    expect(workflows.map((w) => w.name)).toEqual(['catalog-check.yml', 'ci.yml', 'release.yml']);
  });

  it('only run npm scripts that exist, so a rename cannot break CI silently', () => {
    for (const { name, text } of workflows) {
      for (const script of npmScriptsUsedIn(text)) {
        expect(Object.keys(pkg.scripts), `${name}: ${script}`).toContain(script);
      }
    }
  });

  it('are actually parsed by the check above, drift watch included', () => {
    // Guards against the loop passing vacuously: a workflow whose commands this
    // suite cannot see would be governed by nothing.
    expect(npmScriptsUsedIn(catalogCheck)).toContain('catalog:check');
    expect(npmScriptsUsedIn(ci)).toContain('typecheck');
    expect(npmScriptsUsedIn(release)).toContain('build');
  });

  it('smoke the binary at the path package.json declares', () => {
    const binary = pkg.bin['pingcode'];
    expect(binary).toBe('dist/bin/pingcode.js');
    // The drift watch is excluded on purpose: it never installs dependencies and
    // never builds, so there is no bundle for it to smoke.
    for (const workflow of [ci, release]) {
      expect(workflow).toContain(`node ${binary} --version`);
      expect(workflow).toContain(`node ${binary} --help`);
    }
  });

  it('pin every action to a major tag', () => {
    for (const { name, text } of workflows) {
      const uses = text.match(/uses: \S+/g) ?? [];
      expect(uses.length, name).toBeGreaterThan(0);
      for (const line of uses) expect(line, `${name}: ${line}`).toMatch(/@v\d+$/);
    }
  });
});

describe('ci.yml', () => {
  it('triggers on pushes to main and on every pull request', () => {
    expect(ci).toMatch(/on:\s*\n\s+push:\s*\n\s+branches: \[main\]\s*\n\s+pull_request:/);
  });

  it('cancels superseded runs per ref', () => {
    expect(ci).toContain('cancel-in-progress: true');
    expect(ci).toContain('group: ci-${{ github.ref }}');
  });

  it('grants read-only permissions', () => {
    expect(ci).toContain('permissions:\n  contents: read');
    expect(ci).not.toContain('contents: write');
  });

  it('covers the supported node range', () => {
    expect(ci).toContain("node: ['20', '22', '24']");
  });

  it('runs the full gate order, and the hygiene checks in their own job', () => {
    const order = ['npm ci', 'npm run typecheck', 'npm test', 'npm run build', 'npm run skill:install -- --dry-run'];
    let cursor = -1;
    for (const step of order) {
      const at = ci.indexOf(step);
      expect(at, step).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(ci).toContain('npm run scan:secrets -- "$RANGE"');
    expect(ci).toContain('npm run check:commits -- "$RANGE"');
  });

  it('passes untrusted PR input through env, never into the shell', () => {
    expect(ci).toContain('PR_TITLE: ${{ github.event.pull_request.title }}');
    expect(ci).not.toMatch(/run:.*github\.event\.pull_request\.title/);
  });
});

describe('release.yml', () => {
  it('runs only for v-prefixed tags', () => {
    expect(release).toMatch(/on:\s*\n\s+push:\s*\n\s+tags: \['v\*'\]/);
  });

  it('asserts the tag matches package.json before doing anything else', () => {
    const guard = release.indexOf('assert the tag matches package.json');
    expect(guard).toBeGreaterThan(-1);
    // The guard runs before install/build, so a mistyped tag fails in seconds.
    expect(guard).toBeLessThan(release.indexOf('npm ci'));
    expect(release).toContain('if [ "${TAG}" != "v${version}" ]; then');
    expect(release).toContain('exit 1');
    expect(release).toContain('TAG: ${{ github.ref_name }}');
  });

  it("reads the version from package.json rather than hardcoding today's", () => {
    expect(release).toContain(`require('./package.json').version`);
    expect(release).not.toContain(pkg.version);
  });

  it('elevates contents: write on the release job only, at job level', () => {
    expect(release).toContain('permissions:\n  contents: read');
    expect(release).toMatch(/jobs:[\s\S]*permissions:\n(?: *#[^\n]*\n)* {6}contents: write/);
  });

  it('attaches the packed tarball with auto-generated notes', () => {
    expect(release).toContain('npm pack --silent');
    expect(release).toContain('gh release create "$TAG" "$TARBALL" --title "$TAG" --generate-notes');
  });

  it('never publishes to npm — that is an explicit non-goal', () => {
    expect(release).not.toContain('npm publish');
    expect(release).not.toContain('NPM_TOKEN');
  });
});

describe('catalog-check.yml', () => {
  it('is a scheduled job with a manual escape hatch, and no PR trigger at all', () => {
    expect(catalogCheck).toMatch(/on:\s*\n\s+schedule:\s*\n(?:\s*#[^\n]*\n)*\s+- cron: '[^']+'/);
    expect(catalogCheck).toContain('workflow_dispatch:');
    expect(catalogCheck).not.toContain('pull_request');
    expect(catalogCheck).not.toContain('branches: [main]');
  });

  it('is not wired into the gates, which is the whole point (design D2.5)', () => {
    // Upstream drift must never be able to redden `main` or block a release: it
    // depends on a third-party host and on changes unrelated to the open PR.
    expect(ci).not.toContain('catalog:check');
    expect(ci).not.toContain('catalog:sync');
    expect(release).not.toContain('catalog:check');
  });

  it('may write issues and nothing else', () => {
    expect(catalogCheck).toContain('permissions:\n  contents: read');
    expect(catalogCheck).toContain('issues: write');
    expect(catalogCheck).not.toContain('contents: write');
    // The standard token, not a PAT and not a third-party action.
    expect(catalogCheck).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    for (const line of catalogCheck.match(/uses: \S+/g) ?? []) {
      expect(line, line).toMatch(/^uses: actions\//);
    }
  });

  it('maintains one long-lived issue instead of a weekly duplicate stream', () => {
    // Find by label → edit in place; a comment (the only thing that notifies) is
    // sent only when the drift digest changes.
    expect(catalogCheck).toContain('gh issue list --label "$LABEL" --state open');
    expect(catalogCheck).toContain('gh issue edit "$number" --body-file "$BODY"');
    expect(catalogCheck).toContain('drift-digest: $digest');
    expect(catalogCheck).toMatch(/case "\$previous" in\n\s+\*"drift-digest: \$DIGEST"\*\)/);
    // …and it closes itself once upstream matches again, so an open issue always
    // means live drift.
    expect(catalogCheck).toContain('gh issue close "$number" --reason completed');
  });

  it('stays green on drift and fails only when the check could not run', () => {
    const drift = "if: steps.check.outputs.status == 'drift'";
    expect(catalogCheck).toContain(drift);
    // The single `exit 1` belongs to the broken-tooling step, never to drift.
    const broken = catalogCheck.indexOf("if: steps.check.outputs.status == 'broken'");
    expect(broken).toBeGreaterThan(catalogCheck.lastIndexOf(drift));
    expect(catalogCheck.indexOf('exit 1')).toBeGreaterThan(broken);
    expect(catalogCheck.match(/exit 1/g)).toHaveLength(1);
  });

  it('runs on a Node that can strip types, on one version only', () => {
    // `scripts/catalog-sync.ts` needs `--experimental-strip-types` (>= 22.6), so
    // ci.yml's Node 20 leg could not run it; and a matrix would prove nothing
    // about the vendor's docs.
    expect(catalogCheck).toContain("node-version: '24'");
    expect(catalogCheck).not.toMatch(/^\s+(strategy|matrix):/m);
  });
});
