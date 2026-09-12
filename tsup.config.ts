import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'bin/pingcode': 'src/bin/pingcode.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  shims: false,
  /**
   * The published tarball has no `node_modules/` (`package.json#files` only
   * ships `dist/`, `skills/` and `README.md`), so the two runtime deps must be
   * inlined. `commander` resolves to its CJS build, whose `require("events")`
   * calls need a real `require` to land on — an ESM output has none, hence the
   * `createRequire` banner. Both keys are required: `noExternal` alone dies with
   * `Dynamic require of "events" is not supported`, and tsup's `shims: true`
   * does not inject `createRequire` into the ESM output.
   */
  noExternal: [
    'commander',
    'picocolors',
    // `@clack/prompts` powers the `skill install` target picker. Its tree comes
    // in whole for the same reason as the two above, plus `sisteransi`, which is
    // CJS and therefore needs the `createRequire` banner further down.
    '@clack/prompts',
    '@clack/core',
    'sisteransi',
    'fast-wrap-ansi',
    'fast-string-width',
  ],
  esbuildOptions(options) {
    options.banner = {
      ...options.banner,
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    };
  },
});
