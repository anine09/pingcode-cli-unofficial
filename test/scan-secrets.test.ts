import { describe, expect, it } from 'vitest';
import {
  ALLOW_MARKER,
  isCodeIdentifier,
  isPlaceholder,
  PATTERNS,
  scanText,
  shouldSkipPath,
} from '../scripts/scan-secrets';

/**
 * Every fixture below that contains a matching value carries the
 * `scan-secrets:allow` marker on its own line, which is how the scanner keeps
 * quiet about its own test data. That is also, deliberately, a live test of the
 * marker: if suppression broke, `npm run scan:secrets` would fail on this file.
 */
describe('scanText', () => {
  it('flags a client_secret assignment with the file and line', () => {
    const text = ['const a = 1;', 'client_secret=abcdef123456', 'const b = 2;'].join('\n'); // scan-secrets:allow
    const findings = scanText(text, 'src/thing.ts');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toBe('src/thing.ts:2');
    expect(findings[0]?.pattern).toBe('client-secret-assignment');
  });

  it('flags the query-string, JSON and env shapes of the same key', () => {
    expect(scanText('GET /v1/auth/token?client_id=x&client_secret=abcdef123456', 'a')).toHaveLength(1); // scan-secrets:allow
    expect(scanText('{"client_secret":"abcdef123456"}', 'a')).toHaveLength(1); // scan-secrets:allow
    expect(scanText('CLIENT_SECRET=abcdef123456', 'a')).toHaveLength(1); // scan-secrets:allow
  });

  it('reports a prefixed env var once, not once per overlapping pattern', () => {
    const findings = scanText('PINGCODE_CLIENT_SECRET=abcdef123456789', 'a'); // scan-secrets:allow
    expect(findings.map((f) => f.pattern)).toEqual(['pingcode-credential-env']);
  });

  it('flags the PingCode credential env vars with a real-looking value', () => {
    expect(scanText('PINGCODE_CLIENT_ID=abcdef123456789', 'a')).toHaveLength(1); // scan-secrets:allow
    expect(scanText('PINGCODE_HOST=https://open.pingcode.com', 'a')).toHaveLength(0);
    expect(scanText("PINGCODE_CLIENT_ID: 'env-id'", 'a')).toHaveLength(0);
  });

  it('flags a Bearer token literal but not the short fixtures or the docs form', () => {
    expect(scanText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload', 'a')).toHaveLength(1); // scan-secrets:allow
    expect(scanText("headers.Authorization).toBe('Bearer tok-1')", 'a')).toHaveLength(0);
    expect(scanText('Authorization: Bearer <access_token>', 'a')).toHaveLength(0);
    expect(scanText('Authorization: Bearer ***REDACTED***', 'a')).toHaveLength(0);
  });

  it('flags a tenant host but leaves the public and placeholder hosts alone', () => {
    const findings = scanText('https://acme42.pingcode.com/pjm/work_items/1bAqLmTG', 'a'); // scan-secrets:allow
    expect(findings.map((f) => f.pattern)).toEqual(['tenant-host']);
    for (const clean of [
      'https://open.pingcode.com',
      'https://example.pingcode.com/pjm',
      'https://example-tenant.pingcode.com',
      'https://acme.pingcode.com/pjm/workitems/1bAqLmTG',
      'https://pingcode.example.com',
    ]) {
      expect(scanText(clean, 'a'), clean).toEqual([]);
    }
  });

  it('never fires on a bare git sha, which is why there is no generic hex rule', () => {
    const shas = [
      '5285a0a8f3b2c1d4e5f60718293a4b5c6d7e8f90',
      'commit 6a80e74c9b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      'work item 1bAqLmTG, user 0123456789abcdef0123456789abcdef',
    ];
    for (const sha of shas) expect(scanText(sha, 'a'), sha).toEqual([]);
  });

  it('honours the allow marker on the same line only', () => {
    const suppressed = `client_secret=abcdef123456 // ${ALLOW_MARKER}`; // scan-secrets:allow
    expect(scanText(suppressed, 'a')).toEqual([]);
    expect(scanText(`// ${ALLOW_MARKER}\nclient_secret=abcdef123456`, 'a')).toHaveLength(1); // scan-secrets:allow
  });

  it('truncates the evidence so a report is safe to paste', () => {
    const findings = scanText('client_secret=abcdefghijklmnopqrstuvwxyz', 'a'); // scan-secrets:allow
    expect(findings[0]?.evidence).toBe('abcdef…yz');
  });

  it('reports each pattern once per occurrence', () => {
    const text = 'client_secret=abcdef123456\nclient_secret=zyxwvu987654'; // scan-secrets:allow
    expect(scanText(text, 'a').map((f) => f.location)).toEqual(['a:1', 'a:2']);
  });

  it('keeps every pattern global, so a second run does not skip matches', () => {
    for (const pattern of PATTERNS) expect(pattern.re.flags, pattern.name).toContain('g');
    const text = 'client_secret=abcdef123456'; // scan-secrets:allow
    expect(scanText(text, 'a')).toHaveLength(1);
    expect(scanText(text, 'a')).toHaveLength(1);
  });
});

describe('isPlaceholder', () => {
  it('treats the documented redaction placeholders as clean', () => {
    for (const value of [
      'example-tenant',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      'xxxxxxxxxxxx',
      'your-client-secret',
      'REDACTED-VALUE',
      'test-secret-value',
      'changeme-please',
    ]) {
      expect(isPlaceholder(value), value).toBe(true);
    }
  });

  it('treats a real-looking value as suspicious', () => {
    for (const value of ['abcdef123456', 'e7321ca8f724b19d0c5a', 'Zm9vYmFyYmF6cXV4']) {
      expect(isPlaceholder(value), value).toBe(false);
    }
  });
});

describe('isCodeIdentifier', () => {
  it('recognises our own source code, so the scanner does not flag it', () => {
    for (const value of ['clientSecret', 'PINGCODE_CLIENT_SECRET', 'ClientSecret', 'client_secret_present']) {
      expect(isCodeIdentifier(value), value).toBe(true);
    }
    // Regression: the two real false positives this rule was added for.
    expect(scanText('      client_secret: clientSecret,', 'src/core/auth.ts')).toEqual([]);
    expect(scanText("export const ENV_CLIENT_SECRET = 'PINGCODE_CLIENT_SECRET';", 'src/core/config.ts')).toEqual([]);
  });

  it('does not swallow a value with digits in it', () => {
    for (const value of ['abcdef123456', 'e7321ca8f724b19d0c5a', 'ABCDEF123456']) {
      expect(isCodeIdentifier(value), value).toBe(false);
    }
  });
});

describe('shouldSkipPath', () => {
  it('skips generated, vendored and binary paths', () => {
    expect(shouldSkipPath('dist/bin/pingcode.js')).toBe(true);
    expect(shouldSkipPath('node_modules/whatever/index.js')).toBe(true);
    expect(shouldSkipPath('docs/screenshot.png')).toBe(true);
  });

  it('skips its own pattern definitions', () => {
    expect(shouldSkipPath('scripts/scan-secrets.ts')).toBe(true);
    expect(shouldSkipPath('scripts/check-commits.ts')).toBe(false);
  });

  it('scans ordinary sources, specs and workflows', () => {
    for (const kept of [
      'src/core/auth.ts',
      'README.md',
      '.github/workflows/ci.yml',
      '.trellis/spec/guides/commit-conventions.md',
    ]) {
      expect(shouldSkipPath(kept), kept).toBe(false);
    }
  });
});
