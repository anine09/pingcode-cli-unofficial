import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The hooks cannot be usefully executed here (they shell out to npm and would
 * recursively run this suite), so this file asserts the properties that would
 * otherwise only be discovered when a hook silently stops firing — which is the
 * failure mode that matters: a broken hook does not fail, it just does nothing.
 *
 * Text-level assertions on purpose, same reasoning as `test/workflows.test.ts`:
 * a shell parser would break the zero-new-dependencies rule.
 *
 * The cross-hook checks read the **directory** rather than a hardcoded list, so a
 * hook added later cannot be governed by nothing; the filename set is pinned
 * separately, so a fourth hook has to be registered consciously.
 */
function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const HOOKS_DIR = '.githooks';

const hooks = readdirSync(fileURLToPath(new URL(`../${HOOKS_DIR}`, import.meta.url)))
  .sort()
  .map((name) => ({ name, text: read(`${HOOKS_DIR}/${name}`) }));

const installer = read('scripts/install-hooks.mjs');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

function npmScriptsUsedIn(hook: string): string[] {
  const used = new Set<string>();
  const re = /npm run ([a-z:]+)/g;
  for (let match = re.exec(hook); match !== null; match = re.exec(hook)) {
    const name = match[1];
    if (name !== undefined) used.add(name);
  }
  if (/npm test\b/.test(hook)) used.add('test');
  return [...used].sort();
}

describe('git hooks', () => {
  it('are exactly the three stages this repository gates on', () => {
    // Adding a hook means adding its own assertions below.
    expect(hooks.map((hook) => hook.name)).toEqual(['commit-msg', 'pre-commit', 'pre-push']);
  });

  it('only run npm scripts that exist, so a rename cannot silently disable a hook', () => {
    // The load-bearing check: a hook calling a script that no longer exists still
    // "runs" — it just fails, or worse, gets fixed by deleting the line.
    for (const { name, text } of hooks) {
      for (const script of npmScriptsUsedIn(text)) {
        expect(Object.keys(pkg.scripts), `${name}: ${script}`).toContain(script);
      }
    }
  });

  it('are actually parsed by the check above', () => {
    // Guards against the loop passing vacuously.
    const commands = Object.fromEntries(hooks.map(({ name, text }) => [name, npmScriptsUsedIn(text)]));
    expect(commands['pre-commit']).toEqual(['scan:secrets', 'typecheck']);
    expect(commands['commit-msg']).toEqual(['check:commits']);
    expect(commands['pre-push']).toEqual(['build', 'test']);
  });

  it('are executable, because a non-executable hook is skipped without a word', () => {
    for (const { name } of hooks) {
      const file = fileURLToPath(new URL(`../${HOOKS_DIR}/${name}`, import.meta.url));
      expect(() => accessSync(file, constants.X_OK), name).not.toThrow();
    }
  });

  it('are POSIX sh and abort on the first failing command', () => {
    for (const { name, text } of hooks) {
      expect(text.startsWith('#!/bin/sh\n'), name).toBe(true);
      expect(text, name).toMatch(/^set -eu?[a-z]*$/m);
    }
  });

  it('say why they exist, since a hook nobody understands gets deleted', () => {
    for (const { name, text } of hooks) {
      const comments = text.split('\n').filter((line) => line.startsWith('#') && !line.startsWith('#!'));
      expect(comments.length, name).toBeGreaterThan(2);
    }
    // The bypass property is stated where someone reaching for --no-verify reads it.
    expect(hooks.map((hook) => hook.text).join('\n')).toContain('--no-verify');
  });

  it('pass the message file through to the commit-msg gate', () => {
    const commitMsg = hooks.find((hook) => hook.name === 'commit-msg')?.text ?? '';
    // Quoted "$1": git passes a path, and a path can contain spaces.
    expect(commitMsg).toContain('npm run check:commits -- --file "$1"');
  });

  it('smoke the built bundle on push, not just typecheck and tests', () => {
    const prePush = hooks.find((hook) => hook.name === 'pre-push')?.text ?? '';
    // A build can emit an entry point that cannot start while both other gates pass.
    expect(prePush).toContain('node dist/bin/pingcode.js --version');
    expect(prePush).toContain('node dist/bin/pingcode.js --help');
  });

  it('admit the working-tree-vs-staged limitation instead of hiding it', () => {
    const preCommit = hooks.find((hook) => hook.name === 'pre-commit')?.text ?? '';
    expect(preCommit).toContain('working');
    // Documented, not fixed: `git stash --keep-index` would make an interrupted
    // hook able to lose work. It may be named in a comment, never run.
    const commands = preCommit
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n');
    expect(commands).not.toContain('git stash');
  });
});

describe('scripts/install-hooks.mjs', () => {
  it('is wired to both an explicit script and prepare', () => {
    expect(pkg.scripts['hooks:install']).toBe('node scripts/install-hooks.mjs');
    expect(pkg.scripts['prepare']).toBe('node scripts/install-hooks.mjs');
  });

  it('stays plain JavaScript, because prepare runs on Node 20', () => {
    // `prepare` runs during `npm ci`, including on the Node 20 matrix leg,
    // where `--experimental-strip-types` (>= 22.6) does not exist. A `.ts`
    // installer run through that flag would break `npm ci` there — hence `.mjs`
    // and no transpile step, unlike every other script in `scripts/`.
    for (const command of [pkg.scripts['hooks:install'], pkg.scripts['prepare']]) {
      expect(command).toContain('.mjs');
      expect(command).not.toContain('--experimental-strip-types');
    }
    expect(readdirSync(fileURLToPath(new URL('../scripts', import.meta.url)))).toContain('install-hooks.mjs');
  });

  it('imports node builtins only, so it can never need a resolved module graph', () => {
    const imports = installer.match(/from '([^']+)'/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line, line).toMatch(/from 'node:/);
  });

  it('sets core.hooksPath rather than copying files into .git/hooks', () => {
    // Copies rot the moment a hook changes; a pointer cannot.
    expect(installer).toContain("'config', 'core.hooksPath'");
    expect(installer).toContain('.githooks');
  });

  it('no-ops in CI and outside a work tree, so it can never fail an install', () => {
    expect(installer).toContain('process.env.CI');
    expect(installer).toContain('rev-parse');
    expect(installer).toContain('--is-inside-work-tree');
  });
});
