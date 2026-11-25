#!/usr/bin/env node
/**
 * Guard the npm-owned installation boundary.
 *
 * The CLI may read its running package and warn about an old standalone
 * directory, but it must never carry that installer forward or replace its own
 * executable. TypeScript's parser keeps comments and literals separate from
 * executable template substitutions and regular expressions.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'src');

const FORBIDDEN_TEXT = [
  {
    pattern: /\binstallDir\b/g,
    message: 'standalone installDir is forbidden; npm must be the sole CLI installer',
  },
  {
    pattern: /~\/\.local\/share/g,
    message: 'standalone ~/.local/share paths are forbidden except in non-source documentation',
  },
  {
    pattern: /PINGCODE_INSTALL_[A-Za-z0-9_]*/g,
    message: 'PINGCODE_INSTALL_* overrides are forbidden; npm must be the sole CLI installer',
  },
  {
    pattern: /\bexport\s+const\s+VERSION(?:\s*:\s*[^=;\r\n]+)?\s*=\s*(['"])[^'"\r\n]*\1/g,
    message: 'a literal exported VERSION is forbidden; read the running package version at runtime',
  },
];

const FIRST_ARGUMENT_MUTATIONS = new Set([
  'appendFile', 'appendFileSync',
  'chmod', 'chmodSync',
  'chown', 'chownSync',
  'createWriteStream',
  'lchmod', 'lchmodSync',
  'lutimes', 'lutimesSync',
  'mkdir', 'mkdirSync',
  'rm', 'rmSync',
  'rmdir', 'rmdirSync',
  'truncate', 'truncateSync',
  'unlink', 'unlinkSync',
  'utimes', 'utimesSync',
  'writeFile', 'writeFileSync',
]);

const RENAME_MUTATIONS = new Set(['rename', 'renameSync']);

const SECOND_ARGUMENT_MUTATIONS = new Set([
  'copyFile', 'copyFileSync',
  'cp', 'cpSync',
  'link', 'linkSync',
  'symlink', 'symlinkSync',
]);

function typescriptFiles(directory) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Resolve named node:fs imports such as `writeFileSync as write`. */
function filesystemAliases(source) {
  const aliases = new Map();
  const importPattern = /\bimport\s*\{([^}]+)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g;
  for (const match of source.matchAll(importPattern)) {
    for (const specifier of (match[1] ?? '').split(',')) {
      const parts = specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const original = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (original !== undefined && local !== undefined) aliases.set(local, original);
    }
  }
  return aliases;
}

function isRunningExecutable(argument) {
  const normalized = argument
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\s+/g, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/!+$/, '');
  return /^process(?:\.execPath|\[['"]execPath['"]\])$/.test(normalized) ||
    /^process(?:\.argv|\[['"]argv['"]\])\[1\]$/.test(normalized);
}

function lineNumber(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

function scanSource(file) {
  const source = readFileSync(file, 'utf8');
  const relativePath = path.relative(repoRoot, file).split(path.sep).join('/');
  const violations = [];

  for (const rule of FORBIDDEN_TEXT) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const offset = match.index ?? 0;
      violations.push({ line: lineNumber(source, offset), message: rule.message });
    }
  }

  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = filesystemAliases(source);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const localName = node.expression.text;
      const method = aliases.get(localName) ?? localName;
      const argumentIndexes = FIRST_ARGUMENT_MUTATIONS.has(method)
        ? [0]
        : RENAME_MUTATIONS.has(method)
          ? [0, 1]
          : SECOND_ARGUMENT_MUTATIONS.has(method) ? [1] : [];
      if (argumentIndexes.some((index) =>
        isRunningExecutable(node.arguments[index]?.getText(sourceFile) ?? ''))) {
        violations.push({
          line: lineNumber(source, node.getStart(sourceFile)),
          message: `direct ${method} mutation of the running executable is forbidden; npm must own CLI replacement`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return violations.map((violation) => ({ file: relativePath, ...violation }));
}

function main() {
  const violations = typescriptFiles(sourceRoot).flatMap(scanSource);
  if (violations.length === 0) return 0;

  violations.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.message.localeCompare(right.message));
  for (const violation of violations) {
    process.stderr.write(`${violation.file}:${violation.line}: ${violation.message}\n`);
  }
  process.stderr.write(`check-npm-ownership: ${violations.length} violation(s); npm must solely own CLI installation\n`);
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`check-npm-ownership: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
