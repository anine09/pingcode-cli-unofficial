import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existingLegacyStandalone, legacyStandalonePath } from '../src/core/legacy-standalone';
import { readInstalledVersion } from '../src/core/update';
import { VERSION } from '../src/version';

const TEMP_HOME = path.join(import.meta.dirname ?? '.', '.tmp-legacy-standalone');

beforeEach(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe('legacy standalone awareness', () => {
  it('locates the retired layout only when it exists', () => {
    const expected = path.join(TEMP_HOME, '.local', 'share', 'pingcode-cli');
    expect(legacyStandalonePath(TEMP_HOME)).toBe(expected);
    expect(existingLegacyStandalone(TEMP_HOME)).toBeUndefined();

    mkdirSync(expected, { recursive: true });
    expect(existingLegacyStandalone(TEMP_HOME)).toBe(expected);
  });

  it('does not mistake a file for a legacy installation directory', () => {
    const expected = legacyStandalonePath(TEMP_HOME);
    mkdirSync(path.dirname(expected), { recursive: true });
    writeFileSync(expected, 'not a directory');

    expect(existingLegacyStandalone(TEMP_HOME)).toBeUndefined();
  });

  it('never lets a legacy copy supply the running version', () => {
    const legacy = legacyStandalonePath(TEMP_HOME);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'package.json'), JSON.stringify({
      name: 'pingcode-cli-unofficial',
      version: '0.0.0-legacy',
    }));

    expect(existsSync(legacy)).toBe(true);
    expect(readInstalledVersion()).toBe(VERSION);
  });
});
