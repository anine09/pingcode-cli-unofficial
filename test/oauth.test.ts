import { describe, expect, it } from 'vitest';
import { captureOutput } from '../src/cli/output';
import {
  buildAuthorizeUrl,
  extractCode,
  oauthRootOf,
  printAuthorizeUrl,
} from '../src/cli/commands/oauth';
import { AuthError, UsageError } from '../src/core/errors';

/**
 * The OAuth authorize step (design D12, paste-only). No network, no child
 * processes, no listeners: `extractCode` is a pure function over the pasted
 * text, and `printAuthorizeUrl` only writes to stderr.
 */

describe('buildAuthorizeUrl (design D12 step 3)', () => {
  it('builds origin/oauth2/authorize with response_type=code and client_id', () => {
    expect(buildAuthorizeUrl('https://open.pingcode.com', 'client-123')).toBe(
      'https://open.pingcode.com/oauth2/authorize?response_type=code&client_id=client-123',
    );
  });

  it('encodes a client_id with reserved characters', () => {
    const url = buildAuthorizeUrl('https://open.pingcode.com', 'a b&c');
    expect(url).toContain('client_id=a%20b%26c');
  });
});

describe('oauthRootOf', () => {
  it('appends /oauth2 to a clean host origin', () => {
    expect(oauthRootOf('https://open.pingcode.com')).toBe('https://open.pingcode.com/oauth2');
  });

  it('strips trailing slashes before appending /oauth2', () => {
    expect(oauthRootOf('https://open.pingcode.com/')).toBe('https://open.pingcode.com/oauth2');
    expect(oauthRootOf('https://open.pingcode.com///')).toBe('https://open.pingcode.com/oauth2');
  });

  it('falls back to a slash-stripped origin (never throws) for a malformed host', () => {
    // `new URL` throws on a host with no scheme, so the catch yields the raw,
    // de-slashed host plus /oauth2 rather than aborting the URL build.
    expect(oauthRootOf('not a url')).toBe('not a url/oauth2');
  });
});

describe('extractCode', () => {
  it('pulls the code out of a pasted redirect URL', () => {
    expect(extractCode('http://127.0.0.1:8732/callback?code=ABC')).toBe('ABC');
  });

  it('ignores the domain parameter the redirect URL carries', () => {
    expect(extractCode('http://127.0.0.1:8732/callback?code=ABC&domain=htz')).toBe('ABC');
  });

  it('accepts a bare code', () => {
    expect(extractCode('ABC')).toBe('ABC');
  });

  it('trims surrounding whitespace and newlines (a terminal paste often drags them along)', () => {
    expect(extractCode('  ABC\n')).toBe('ABC');
    expect(extractCode('  http://127.0.0.1:8732/callback?code=ABC\n')).toBe('ABC');
  });

  it('rejects an empty paste with a usage error', () => {
    expect(() => extractCode('')).toThrow(UsageError);
    expect(() => extractCode('   ')).toThrow(UsageError);
  });

  it('surfaces an OAuth error URL as an AuthError (exit 3) instead of sending it to the token endpoint', () => {
    expect(() => extractCode('http://127.0.0.1:8732/callback?error=access_denied')).toThrow(
      AuthError,
    );
    expect(() => extractCode('http://127.0.0.1:8732/callback?error=access_denied')).toThrow(
      /access_denied/,
    );
  });

  it('includes the error_description in the message when present', () => {
    expect(() =>
      extractCode(
        'http://127.0.0.1:8732/callback?error=access_denied&error_description=User%20denied',
      ),
    ).toThrow(/User denied/);
  });

  it('rejects a URL without a code or error parameter', () => {
    expect(() => extractCode('http://127.0.0.1:8732/callback')).toThrow(UsageError);
    expect(() => extractCode('http://127.0.0.1:8732/callback')).toThrow(/no `code` parameter/);
  });

  it('rejects a URL-looking paste it cannot parse', () => {
    expect(() => extractCode('http://[bad')).toThrow(UsageError);
  });
});

describe('printAuthorizeUrl', () => {
  it('prints the redacted authorize URL and the 3-step paste instructions to stderr, never stdout', () => {
    let stdout = '';
    let stderr = '';
    const restore = captureOutput((chunk) => (stdout += chunk), (chunk) => (stderr += chunk));
    try {
      printAuthorizeUrl(
        'https://open.pingcode.com/oauth2/authorize?response_type=code&client_id=client-123',
      );
    } finally {
      restore();
    }
    // stdout stays JSON-only: nothing a command result would not own.
    expect(stdout).toBe('');
    expect(stderr).toContain('authorize URL: https://open.pingcode.com/oauth2/authorize');
    expect(stderr).toContain('1. open it in a browser');
    expect(stderr).toContain('2. the browser then redirects to a URL containing ?code=...');
    expect(stderr).toContain('3. copy the full URL from the address bar');
  });
});
