import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const guardScript = path.join(repoRoot, 'scripts', 'check-npm-ownership.mjs');
const tempRepos: string[] = [];

afterEach(() => {
  for (const directory of tempRepos.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function miniRepository(source: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pingcode-npm-ownership-'));
  tempRepos.push(root);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  copyFileSync(guardScript, path.join(root, 'scripts', 'check-npm-ownership.mjs'));
  writeFileSync(path.join(root, 'src', 'bad.ts'), source);
  return root;
}

it('keeps npm as the sole owner of CLI installation', () => {
  const result = spawnSync(process.execPath, [guardScript], { cwd: repoRoot, encoding: 'utf8' });

  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

const forbiddenFixtures = [
  {
    name: 'installDir',
    source: "export const installDir = '/legacy';\n",
    line: 1,
    message: /installDir/,
  },
  {
    name: 'a literal exported VERSION',
    source: "export const VERSION = '9.9.9';\n",
    line: 1,
    message: /literal exported VERSION/,
  },
  {
    name: 'PINGCODE_INSTALL_HOME',
    source: 'export const home = process.env.PINGCODE_INSTALL_HOME;\n',
    line: 1,
    message: /PINGCODE_INSTALL_/,
  },
  {
    name: 'writeFileSync targeting process.execPath',
    source: "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.execPath, 'x');\n",
    line: 2,
    message: /direct writeFileSync mutation of the running executable/,
  },
] as const;

it.each(forbiddenFixtures)('rejects $name with a file:line diagnostic', ({ source, line, message }) => {
  const root = miniRepository(source);
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'check-npm-ownership.mjs')],
    { cwd: root, encoding: 'utf8' },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(`src/bad.ts:${line}:`);
  expect(result.stderr).toMatch(message);
});
