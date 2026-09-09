import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The developer-local analogue of the CI artifact gate.
 *
 * `pingcode self-update` installs from the npm tarball, whose `files` list ships
 * `dist/` with **no `node_modules/`**. That is only survivable because tsup
 * inlines `commander` and `picocolors` — and the moment someone removes
 * `noExternal` (or the `createRequire` banner that Commander's CJS build needs)
 * the bundle silently stops being self-contained. Nothing in `npm test` would
 * notice, because the tests run against `src/` with `node_modules/` present.
 *
 * So this asserts the property on the built artifact itself: `dist/bin/pingcode.js`
 * must carry no bare `commander` / `picocolors` import specifier. It skips when
 * `dist/` is absent, because unit tests do not build.
 */

const BUNDLE = path.join(import.meta.dirname ?? '.', '..', 'dist', 'bin', 'pingcode.js');

/** A bare specifier, as opposed to the inlined copy or a path into it. */
const BARE_SPECIFIER =
  /^\s*(?:import|export)[^\n;]*from\s*['"](?:commander|picocolors)['"]/m;

describe('build artifact', () => {
  it('is present (a stale dist/ would make the assertions below vacuous)', () => {
    if (!existsSync(BUNDLE)) {
      console.warn('dist/bin/pingcode.js not found — run `npm run build` first; skipping');
      return;
    }
    expect(existsSync(BUNDLE)).toBe(true);
  });

  it('has no bare commander / picocolors import specifier', () => {
    if (!existsSync(BUNDLE)) {
      console.warn('dist/bin/pingcode.js not found — skipping (unit tests do not build)');
      return;
    }

    const source = readFileSync(BUNDLE, 'utf8');

    // What a reader of the built file would see if the deps were left external.
    expect(source).not.toMatch(BARE_SPECIFIER);
    // Same property, stated without a regex, so the intent is unambiguous.
    expect(source).not.toContain('from "commander"');
    expect(source).not.toContain("from 'commander'");
    expect(source).not.toContain('from "picocolors"');
    expect(source).not.toContain("from 'picocolors'");
  });
});
