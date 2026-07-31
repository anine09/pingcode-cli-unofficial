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
});
