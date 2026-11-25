#!/usr/bin/env node
/**
 * Verify both the build output and the actual npm tarball as standalone CLIs.
 *
 * Every CLI invocation uses this Node executable by absolute path and an empty
 * PATH. A working smoke check therefore cannot be supplied by npm, a shim, or a
 * leftover standalone installation.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const expectedVersion = packageJson.version;
const packageName = packageJson.name;
assert.equal(typeof expectedVersion, 'string', 'package.json must contain a version');
assert.equal(typeof packageName, 'string', 'package.json must contain a package name');

const builtEntry = path.join(repoRoot, 'dist', 'bin', 'pingcode.js');
assert.ok(existsSync(builtEntry), `missing ${builtEntry}; run npm run build first`);

function outputOf(result) {
  return [result.stdout, result.stderr]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join('\n')
    .slice(-2_000);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`${command} could not run: ${result.error.message}`);
  }
  return result;
}

function expectSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} exited ${result.status ?? 'without a status'}${outputOf(result) === '' ? '' : `\n${outputOf(result)}`}`,
  );
}

function createSandbox(tempRoot, name) {
  const root = path.join(tempRoot, name);
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const config = path.join(root, 'config');
  const emptyPath = path.join(root, 'empty-path');
  for (const directory of [home, data, config, emptyPath]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    home,
    data,
    config,
    emptyPath,
    legacyDir: path.join(home, '.local', 'share', 'pingcode-cli'),
    dataInstallDir: path.join(data, 'pingcode-cli'),
  };
}

function runCli(entry, args, sandbox, updatesEnabled = false) {
  const env = {
    ...process.env,
    HOME: sandbox.home,
    XDG_DATA_HOME: sandbox.data,
    XDG_CONFIG_HOME: path.join(sandbox.home, '.config'),
    PINGCODE_CONFIG_DIR: sandbox.config,
    PATH: sandbox.emptyPath,
    PINGCODE_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
  };
  if (updatesEnabled) delete env.PINGCODE_NO_UPDATE_CHECK;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return run(process.execPath, [entry, ...args], { env });
}

function assertNoInstallDirectories(sandbox, label) {
  const created = [sandbox.legacyDir, sandbox.dataInstallDir].filter((directory) => existsSync(directory));
  assert.deepEqual(created, [], `${label} created installation directories: ${created.join(', ')}`);
}

function smokeDirectCommands(entry, sandbox, label) {
  const version = runCli(entry, ['--version'], sandbox);
  expectSuccess(version, `${label} --version`);
  assert.equal(version.stdout, `${expectedVersion}\n`, `${label} --version output was not exact`);

  const help = runCli(entry, ['--help'], sandbox);
  expectSuccess(help, `${label} --help`);

  const authStatus = runCli(entry, ['auth', 'status'], sandbox);
  expectSuccess(authStatus, `${label} auth status`);
  assertNoInstallDirectories(sandbox, label);
}

function snapshotTree(root) {
  const entries = [];
  function visit(current, relativePath) {
    const stat = lstatSync(current);
    const entry = {
      path: relativePath,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    if (stat.isFile()) entry.content = readFileSync(current).toString('base64');
    entries.push(entry);
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) {
        visit(path.join(current, name), relativePath === '' ? name : path.join(relativePath, name));
      }
    }
  }
  visit(root, '');
  return entries;
}

function smokeSameVersionHint(entry, sandbox) {
  const hintPath = path.join(sandbox.config, 'update-available');
  const cooldownPath = path.join(sandbox.config, 'auto-update-check');
  writeFileSync(hintPath, `${JSON.stringify({ version: expectedVersion }, null, 2)}\n`);
  writeFileSync(cooldownPath, '');
  const now = new Date();
  utimesSync(cooldownPath, now, now);

  const result = runCli(entry, ['self-update', '--help'], sandbox, true);
  expectSuccess(result, 'built self-update --help with a same-version hint');
  assert.ok(
    !result.stderr.includes('Update available:'),
    `a same-version hint was announced:\n${outputOf(result)}`,
  );
  assert.ok(!existsSync(hintPath), 'the stale same-version hint was not removed');
}

function smokeLegacyWarning(entry, sandbox) {
  mkdirSync(sandbox.legacyDir, { recursive: true });
  writeFileSync(path.join(sandbox.legacyDir, 'sentinel'), 'leave this standalone directory untouched\n');
  const before = snapshotTree(sandbox.legacyDir);

  const result = runCli(entry, ['self-update', '--help'], sandbox, true);
  expectSuccess(result, 'built self-update --help with a legacy standalone directory');
  const warning = `Deprecated standalone installation found at ${sandbox.legacyDir}; it is ignored and can be deleted.`;
  assert.ok(result.stderr.includes(warning), `missing legacy warning:\n${outputOf(result)}`);
  assert.deepEqual(snapshotTree(sandbox.legacyDir), before, 'the legacy standalone directory was modified');
  assert.ok(!existsSync(sandbox.dataInstallDir), 'the legacy warning created an XDG installation directory');
}

function packedTarball(packDirectory) {
  const result = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], {
    env: process.env,
    timeout: 120_000,
  });
  expectSuccess(result, 'npm pack --json --ignore-scripts');

  const manifest = JSON.parse(result.stdout);
  assert.ok(Array.isArray(manifest) && manifest.length === 1, 'npm pack did not return exactly one package');
  assert.equal(manifest[0]?.version, expectedVersion, 'npm pack returned an unexpected package version');
  const filename = manifest[0]?.filename;
  assert.equal(typeof filename, 'string', 'npm pack did not return a tarball filename');
  const tarball = path.join(packDirectory, filename);
  assert.ok(existsSync(tarball), `npm pack tarball is missing: ${tarball}`);
  return tarball;
}

function unpackTarball(tarball, destination) {
  mkdirSync(destination, { recursive: true });
  const result = run('tar', ['-xzf', tarball, '-C', destination], {
    env: process.env,
    timeout: 30_000,
  });
  expectSuccess(result, 'tar -xzf');
  return path.join(destination, 'package', 'dist', 'bin', 'pingcode.js');
}

function smokePackedRuntimeVersionReadback(entry, sandbox) {
  const packagePath = path.resolve(path.dirname(entry), '..', '..', 'package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(manifest.name, packageName, 'unpacked package.json has an unexpected package name');
  assert.equal(manifest.version, expectedVersion, 'unpacked package.json has an unexpected version');

  const runtimeVersion = '9.9.9-runtime-readback';
  manifest.version = runtimeVersion;
  writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = runCli(entry, ['--version'], sandbox);
  expectSuccess(result, 'packed runtime package.json readback --version');
  assert.equal(
    result.stdout,
    `${runtimeVersion}\n`,
    'packed CLI did not read the mutated package.json version at runtime',
  );
  assertNoInstallDirectories(sandbox, 'packed runtime package.json readback');
}

let tempRoot;
try {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pingcode-cli-npm-smoke-'));

  const builtSandbox = createSandbox(tempRoot, 'built');
  smokeDirectCommands(builtEntry, builtSandbox, 'built package');
  smokeSameVersionHint(builtEntry, builtSandbox);
  smokeLegacyWarning(builtEntry, builtSandbox);
  process.stdout.write(
    `built package: version ${expectedVersion}; --help/auth status passed; same-version hint removed; legacy directory unchanged\n`,
  );

  const packDirectory = path.join(tempRoot, 'pack');
  const extractDirectory = path.join(tempRoot, 'unpacked');
  mkdirSync(packDirectory, { recursive: true });
  const packedEntry = unpackTarball(packedTarball(packDirectory), extractDirectory);
  const packedSandbox = createSandbox(tempRoot, 'packed');
  smokeDirectCommands(packedEntry, packedSandbox, 'packed package');
  smokePackedRuntimeVersionReadback(packedEntry, packedSandbox);
  process.stdout.write(
    `packed package: version ${expectedVersion}; --help/auth status passed; runtime package.json readback passed; no installation directories created\n`,
  );
} catch (error) {
  process.stderr.write(`smoke-npm-package: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (tempRoot !== undefined) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(
        `smoke-npm-package: could not remove ${tempRoot}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
