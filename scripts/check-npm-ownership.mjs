#!/usr/bin/env node
/**
 * Guard the npm-owned installation boundary.
 *
 * The CLI may read its running package and warn about an old standalone
 * directory, but it must never carry that installer forward or replace its own
 * executable. This check is deliberately dependency-free so it can run in CI
 * before npm ci.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SECOND_ARGUMENT_MUTATIONS = new Set([
  'copyFile', 'copyFileSync',
  'cp', 'cpSync',
  'link', 'linkSync',
  'rename', 'renameSync',
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

/** Hide comments and string bodies without changing offsets or line numbers. */
function maskCommentsAndStrings(source) {
  const masked = source.split('');
  let state = 'code';
  let escaped = false;

  const hide = (index) => {
    if (source[index] !== '\n' && source[index] !== '\r') masked[index] = ' ';
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      hide(index);
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      hide(index);
      if (char === '*' && next === '/') {
        hide(index + 1);
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      hide(index);
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (state === 'single' && char === "'") ||
        (state === 'double' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      hide(index);
      hide(index + 1);
      index += 1;
      state = 'line-comment';
    } else if (char === '/' && next === '*') {
      hide(index);
      hide(index + 1);
      index += 1;
      state = 'block-comment';
    } else if (char === "'") {
      hide(index);
      state = 'single';
    } else if (char === '"') {
      hide(index);
      state = 'double';
    } else if (char === '`') {
      hide(index);
      state = 'template';
    }
  }

  return masked.join('');
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

/** Split a call's arguments while ignoring commas in nested syntax and strings. */
function callArguments(source, openParen) {
  const args = [];
  const stack = ['('];
  let start = openParen + 1;
  let state = 'code';
  let escaped = false;

  for (let index = openParen + 1; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (state === 'single' && char === "'") ||
        (state === 'double' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      state = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      stack.push(char);
    } else if (char === ')' || char === ']' || char === '}') {
      stack.pop();
      if (stack.length === 0) {
        args.push(source.slice(start, index));
        return args;
      }
    } else if (char === ',' && stack.length === 1) {
      args.push(source.slice(start, index));
      start = index + 1;
    }
  }

  return [];
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

  const code = maskCommentsAndStrings(source);
  const aliases = filesystemAliases(source);
  const callPattern = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (const match of code.matchAll(callPattern)) {
    const localName = match[1] ?? '';
    const method = aliases.get(localName) ?? localName;
    const argumentIndex = FIRST_ARGUMENT_MUTATIONS.has(method)
      ? 0
      : SECOND_ARGUMENT_MUTATIONS.has(method)
        ? 1
        : -1;
    if (argumentIndex === -1) continue;

    const openParen = (match.index ?? 0) + match[0].lastIndexOf('(');
    const args = callArguments(source, openParen);
    if (isRunningExecutable(args[argumentIndex] ?? '')) {
      const offset = match.index ?? 0;
      violations.push({
        line: lineNumber(source, offset),
        message: `direct ${method} mutation of the running executable is forbidden; npm must own CLI replacement`,
      });
    }
  }

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
