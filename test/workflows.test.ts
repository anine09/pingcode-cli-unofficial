import { readFileSync } from 'node:fs';
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
 */
function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const ci = read('.github/workflows/ci.yml');
const release = read('.github/workflows/release.yml');
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
  it('only run npm scripts that exist, so a rename cannot break CI silently', () => {
    for (const workflow of [ci, release]) {
      for (const script of npmScriptsUsedIn(workflow)) {
        expect(Object.keys(pkg.scripts), script).toContain(script);
      }
    }
  });

  it('smoke the binary at the path package.json declares', () => {
    const binary = pkg.bin['pingcode'];
    expect(binary).toBe('dist/bin/pingcode.js');
    for (const workflow of [ci, release]) {
      expect(workflow).toContain(`node ${binary} --version`);
      expect(workflow).toContain(`node ${binary} --help`);
    }
  });

  it('pin every action to a major tag', () => {
    for (const workflow of [ci, release]) {
      const uses = workflow.match(/uses: \S+/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      for (const line of uses) expect(line, line).toMatch(/@v\d+$/);
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
