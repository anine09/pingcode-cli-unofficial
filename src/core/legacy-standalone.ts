import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Location used by the retired standalone installer.
 *
 * This path is awareness-only: callers may warn that an old copy can be
 * deleted, but must never use it to resolve a version, package payload, or
 * installation state.
 */
export function legacyStandalonePath(home: string = homedir()): string {
  return path.join(home, '.local', 'share', 'pingcode-cli');
}

export function existingLegacyStandalone(home: string = homedir()): string | undefined {
  const candidate = legacyStandalonePath(home);
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}
