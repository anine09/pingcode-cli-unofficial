import { afterEach, describe, expect, it } from 'vitest';
import {
  captureOutput,
  errorPayload,
  formatTimestamp,
  printDryRun,
  printError,
  printJson,
  redactHeaders,
  redactSnippet,
  redactUrl,
  renderTable,
  truncate,
} from '../src/cli/output';
import { maskIdentifier } from '../src/core/redact';
import { ApiError, NotFoundError, UsageError } from '../src/core/errors';

const SECRET = 'super-secret-value-9f3a';

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const restore = captureOutput(
    (chunk) => out.push(chunk),
    (chunk) => err.push(chunk),
  );
  return { out, err, restore };
}

let restoreOutput: (() => void) | undefined;

afterEach(() => {
  restoreOutput?.();
  restoreOutput = undefined;
});

describe('redactUrl (design §5.0, AC3/AC11)', () => {
  it('masks client_secret in the token URL', () => {
    const url = `https://open.pingcode.com/v1/auth/token?grant_type=client_credentials&client_id=abc&client_secret=${SECRET}`;
    const redacted = redactUrl(url);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain('client_secret=');
    expect(redacted).toContain('client_id=abc');
  });

  it('masks the authorization-code param too', () => {
    expect(redactUrl('https://x/y?code=abc123&keep=1')).not.toContain('abc123');
    expect(redactUrl('https://x/y?code=abc123&keep=1')).toContain('keep=1');
  });

  it('masks repeated occurrences and relative URLs', () => {
    const relative = `/v1/auth/token?client_secret=${SECRET}&client_secret=${SECRET}`;
    expect(redactUrl(relative)).not.toContain(SECRET);
  });

  it('leaves untouched URLs byte-identical', () => {
    const url = 'https://open.pingcode.com/v1/pjm/work_items?project_id=1&page_index=0';
    expect(redactUrl(url)).toBe(url);
  });

  it('keeps a trailing delimiter when the URL is embedded in a message (S8b nit)', () => {
    const message = `GET https://open.pingcode.com/v1/auth/token?client_id=abc&client_secret=${SECRET}) failed`;
    const redacted = redactUrl(message);
    expect(redacted).not.toContain(SECRET);
    // the closing paren used to be eaten along with the secret
    expect(redacted).toContain(') failed');
    expect(redacted).toContain('client_id=abc');
    expect(redactUrl('(?code=abc123)')).toBe('(?code=***REDACTED***)');
    expect(redactUrl('"?code=abc123"')).toBe('"?code=***REDACTED***"');
    expect(redactUrl("'?code=abc123'")).toBe("'?code=***REDACTED***'");
    expect(redactUrl('?code=abc123, next')).toBe('?code=***REDACTED***, next');
  });

  it('still fails safe when a secret itself contains a delimiter', () => {
    // Only a *trailing* delimiter run is restored, so no suffix of the value leaks.
    expect(redactUrl('?client_secret=ab,cd')).toBe('?client_secret=***REDACTED***');
    expect(redactUrl("?client_secret=ab'cd&x=1")).toBe('?client_secret=***REDACTED***&x=1');
    expect(redactUrl('?client_secret=a)b)c')).not.toContain('b)c');
  });

  it('never throws on garbage', () => {
    expect(redactUrl('not a url at all')).toBe('not a url at all');
    expect(redactUrl('')).toBe('');
  });
});

describe('redactHeaders / redactSnippet / maskIdentifier', () => {
  it('masks authorization regardless of case', () => {
    const redacted = redactHeaders({ Authorization: 'Bearer abc.def', Accept: 'application/json' });
    expect(redacted.Authorization).not.toContain('abc.def');
    expect(redacted.Accept).toBe('application/json');
    expect(redactHeaders({ authorization: 'Bearer x' }).authorization).not.toContain('Bearer x');
  });

  it('masks tokens inside body snippets', () => {
    const snippet = '{"access_token":"e7321ca8-f724","token_type":"Bearer"}';
    const redacted = redactSnippet(snippet);
    expect(redacted).not.toContain('e7321ca8-f724');
    expect(redacted).toContain('token_type');
  });

  it('masks client ids for display', () => {
    expect(maskIdentifier('abcdefghijklmnop')).toBe('abcd…mnop');
    expect(maskIdentifier(undefined)).toBe('(not set)');
  });
});

describe('table rendering', () => {
  type Row = { identifier: string; title: string };
  const columns = [
    { header: 'IDENTIFIER', value: (r: Row) => r.identifier },
    { header: 'TITLE', value: (r: Row) => r.title, flex: true },
  ];

  it('aligns columns', () => {
    const table = renderTable(columns, [
      { identifier: 'SCR-5', title: 'short' },
      { identifier: 'SCR-1234', title: 'another' },
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toContain('IDENTIFIER');
    expect(lines[1]?.startsWith('SCR-5   ')).toBe(true);
  });

  it('truncates to the available width', () => {
    const table = renderTable(
      columns,
      [{ identifier: 'SCR-5', title: 'x'.repeat(400) }],
      60,
    );
    for (const line of table.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
    expect(table).toContain('…');
  });

  it('strips embedded newlines so a row stays a row', () => {
    const table = renderTable(columns, [{ identifier: 'A-1', title: 'one\ntwo' }]);
    expect(table.split('\n')).toHaveLength(2);
  });
});

describe('truncate / formatTimestamp', () => {
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abcdef', 0)).toBe('');
  });

  it('formats unix seconds locally and ignores junk', () => {
    expect(formatTimestamp(1578897962)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp(0)).toBe('');
    expect(formatTimestamp('nope')).toBe('');
  });
});

describe('stdout purity (design §7.3, R3.2)', () => {
  it('keeps stdout empty on the error path in --json mode', () => {
    const cap = capture();
    restoreOutput = cap.restore;
    printError(new NotFoundError('work item not found'), { json: true });
    expect(cap.out.join('')).toBe('');
    const payload = JSON.parse(cap.err.join('')) as { error: { kind: string; exit: number } };
    expect(payload.error).toEqual({ kind: 'not_found', message: 'work item not found', exit: 5 });
  });

  it('writes human errors, hints and api codes to stderr', () => {
    const cap = capture();
    restoreOutput = cap.restore;
    printError(new UsageError('missing --project', { hint: 'pass --project <name|id>' }), {
      json: false,
    });
    expect(cap.out.join('')).toBe('');
    const err = cap.err.join('');
    expect(err).toContain('missing --project');
    expect(err).toContain('hint: pass --project <name|id>');
  });

  it('includes the API code in the json payload', () => {
    expect(errorPayload(new ApiError('请求频率过高', { code: '100038' })).code).toBe('100038');
  });

  it('redacts secrets that leaked into an error message', () => {
    const cap = capture();
    restoreOutput = cap.restore;
    printError(
      new ApiError(`GET https://open.pingcode.com/v1/auth/token?client_secret=${SECRET} failed`),
      { json: true },
    );
    expect(cap.err.join('')).not.toContain(SECRET);
  });

  it('prints json bodies on stdout only', () => {
    const cap = capture();
    restoreOutput = cap.restore;
    printJson({ values: [] });
    expect(cap.err.join('')).toBe('');
    expect(JSON.parse(cap.out.join(''))).toEqual({ values: [] });
  });
});

describe('printDryRun (design §7.3)', () => {
  const plan = {
    method: 'POST',
    url: `https://open.pingcode.com/v1/pjm/work_items?client_secret=${SECRET}`,
    headers: { Authorization: 'Bearer abc.def', 'Content-Type': 'application/json' },
    body: { title: 'hello' },
  };

  it('is a result, not a log: --json writes the plan to stdout and nothing to stderr', () => {
    const cap = capture();
    restoreOutput = cap.restore;
    printDryRun(plan, { json: true });
    expect(cap.err.join('')).toBe('');
    const payload = JSON.parse(cap.out.join('')) as {
      dry_run: boolean;
      request: { method: string; url: string; headers: Record<string, string>; body: unknown };
    };
    expect(payload.dry_run).toBe(true);
    expect(payload.request.method).toBe('POST');
    expect(payload.request.url).not.toContain(SECRET);
    expect(payload.request.headers.Authorization).not.toContain('abc.def');
    expect(payload.request.body).toEqual({ title: 'hello' });
  });

  it('writes the human plan to stderr, redacted', () => {
    const cap = capture();
    restoreOutput = cap.restore;
    printDryRun(plan, { json: false });
    expect(cap.out.join('')).toBe('');
    const err = cap.err.join('');
    expect(err).toContain('dry run');
    expect(err).not.toContain(SECRET);
    expect(err).not.toContain('abc.def');
  });
});
