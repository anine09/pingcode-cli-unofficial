import { readFileSync } from 'node:fs';

const PACKAGE_NAME = 'pingcode-cli-unofficial';

/**
 * Read the version from the package that is currently executing.
 *
 * This module lives two levels below the package root both in `src/core/` and
 * after tsup bundles it into `dist/bin/pingcode.js`, so the same package-relative
 * URL works in a checkout, an npm global install, and an unpacked tarball.
 */
export function readPackageVersion(): string | undefined {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.name !== PACKAGE_NAME) return undefined;
    return typeof record.version === 'string' ? record.version : undefined;
  } catch {
    return undefined;
  }
}

/** Fail closed rather than inventing a version when the running package is unreadable. */
export function requirePackageVersion(): string {
  const version = readPackageVersion();
  if (version === undefined) {
    throw new Error('cannot read version from the running package.json');
  }
  return version;
}

export const VERSION = requirePackageVersion();
