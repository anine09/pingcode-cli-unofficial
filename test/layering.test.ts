import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Design §2: `cli → {api, core}`, `api → core`, and **`core` imports neither**.
 * Plus the invariants that matter in review: `api/` never formats output and
 * `cli/` never builds URLs or reads config files directly.
 */

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const re = /(?:from|import)\s+'([^']+)'/g;
  for (let match = re.exec(source); match !== null; match = re.exec(source)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function layerOf(specifier: string, file: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(srcDir, resolved);
  return relative.split(path.sep)[0];
}

describe('layering', () => {
  const files = filesUnder(srcDir);

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('core imports neither cli nor api', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.includes(`${path.sep}core${path.sep}`))) {
      for (const specifier of importsOf(file)) {
        const layer = layerOf(specifier, file);
        if (layer === 'cli' || layer === 'api') {
          offenders.push(`${path.relative(srcDir, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('api imports core and types only', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.includes(`${path.sep}api${path.sep}`))) {
      for (const specifier of importsOf(file)) {
        const layer = layerOf(specifier, file);
        if (layer !== undefined && !['core', 'types', 'api'].includes(layer)) {
          offenders.push(`${path.relative(srcDir, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('api never imports the output/formatting layer', () => {
    for (const file of files.filter((f) => f.includes(`${path.sep}api${path.sep}`))) {
      expect(importsOf(file).join(' ')).not.toContain('output');
    }
  });

  it('cli never reads config files or builds URLs directly', () => {
    for (const file of files.filter((f) => f.includes(`${path.sep}cli${path.sep}`))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain("from 'node:fs'");
      expect(source).not.toContain('buildUrl');
    }
  });
});
