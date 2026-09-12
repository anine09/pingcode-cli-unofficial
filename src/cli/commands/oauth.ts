import { AuthError, UsageError } from '../../core/errors';
import { redactUrl } from '../../core/redact';
import { errLine } from '../output';

/**
 * The OAuth2 authorization-code authorize step (design D12) — CLI layer only.
 *
 * Paste-only authorize: the CLI prints the authorize URL, the operator logs in
 * + consents in a browser, and pastes back whatever the login flow produced
 * (the address-bar redirect URL carrying `?code=`, or the bare code). There is
 * no browser auto-open and no loopback listener: that channel was removed in
 * favour of the paste flow, which works on remote/headless machines where a
 * browser cannot be opened next to the CLI.
 *
 * The authorize URL carries only `client_id` (no secret), so it is safe to
 * print; it is still run through the caller's stderr channel, never stdout.
 */

/**
 * Build the authorize URL for a host + app client id.
 *
 * `oauthRoot(host)` = the host's origin + `/oauth2`
 * (e.g. `https://open.pingcode.com` → `https://open.pingcode.com/oauth2`),
 * per the PingCode authorize page contract. `response_type=code` requests the
 * authorization-code grant; `client_id` identifies the app.
 */
export function buildAuthorizeUrl(host: string, clientId: string): string {
  const oauthRoot = oauthRootOf(host);
  return `${oauthRoot}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}`;
}

/** The origin of `host` + `/oauth2`. */
export function oauthRootOf(host: string): string {
  let origin: string;
  try {
    origin = new URL(host).origin;
  } catch {
    // A malformed host still yields a usable-ish origin rather than throwing on
    // the URL build — the request that follows will fail with a real error.
    origin = host.replace(/\/+$/, '');
  }
  return `${origin}/oauth2`;
}

/** Print the authorize URL + paste instructions to **stderr** (stdout stays JSON-only in `--json`). */
export function printAuthorizeUrl(url: string): void {
  // The URL carries only `client_id`, but redactUrl is applied defensively so a
  // future param is never leaked (design §5.0, R9).
  errLine(`authorize URL: ${redactUrl(url)}`);
  errLine('1. open it in a browser, log in, and consent to the requested access');
  errLine('2. the browser then redirects to a URL containing ?code=... (the page may fail to load — that is fine)');
  errLine('3. copy the full URL from the address bar, or just the code, and paste it below');
}

/**
 * Pull the authorization code out of whatever the operator pasted.
 *
 * The paste accepts either the full redirect URL (the address-bar URL after
 * login, which carries ?code=...) or a bare code. A URL that carries an
 * `error` (OAuth denial) is surfaced as an AuthError instead of being sent
 * to the token endpoint, where it would fail opaquely.
 */
export function extractCode(pasted: string): string {
  const trimmed = pasted.trim();
  if (trimmed === '') {
    throw new UsageError('no authorization code entered', {
      hint: 'paste the code from the authorize page, or the full URL it redirected to',
    });
  }
  // Only scheme-prefixed input is treated as a URL; a bare code is never a URL.
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UsageError('the pasted text looks like a URL but could not be parsed', {
      hint: 'copy the full address-bar URL after the login redirect, or paste just the code',
    });
  }
  const error = url.searchParams.get('error');
  if (error !== null) {
    const description = url.searchParams.get('error_description');
    const suffix = description === null ? '' : ` (${description})`;
    throw new AuthError(`authorization was denied: ${error}${suffix}`, {
      hint: 're-run `pingcode auth login` and approve the consent screen',
    });
  }
  const code = url.searchParams.get('code');
  if (code === null || code === '') {
    throw new UsageError('the pasted URL carries no `code` parameter', {
      hint: 'copy the full address-bar URL after the login redirect, or paste just the code',
    });
  }
  return code;
}
