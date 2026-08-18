import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { configFilePath } from '../../core/config';
import type { Ctx } from '../../core/context';
import { AuthError, UsageError } from '../../core/errors';
import { redactUrl } from '../../core/redact';
import { errLine } from '../output';

/**
 * The OAuth2 authorization-code authorize step (design D12/D13) — CLI layer
 * only, because it binds a local loopback listener and (best-effort) opens a
 * browser. `core` must not do either, so this does not live there.
 *
 * Two authorize channels share one URL builder:
 *  - **browser** — open the authorize URL, the operator logs in + consents, the
 *    browser redirects to the registered loopback and `captureCodeFromLoopback`
 *    catches the `?code=` off the redirect (same machine only);
 *  - **paste** — print the same URL, the operator generates a code by hand and
 *    pastes it (the remote/headless-safe fallback).
 *
 * The authorize URL carries only `client_id` (no secret), so it is safe to
 * print; it is still run through the caller's stderr channel, never stdout.
 */

/** Default registered loopback callback (design D13). */
export const DEFAULT_LOOPBACK_URI = 'http://127.0.0.1:8732/callback';

/** The host/port the loopback binds to, parsed from the registered callback. */
export type LoopbackTarget = { host: string; port: number };

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

/** Print the authorize URL to **stderr** (stdout stays JSON-only in `--json`). */
export function printAuthorizeUrl(url: string): void {
  // The URL carries only `client_id`, but redactUrl is applied defensively so a
  // future param is never leaked (design §5.0, R9).
  errLine(`authorize URL: ${redactUrl(url)}`);
  errLine('open it in a browser, log in, and consent to the requested access');
}

/**
 * Best-effort open the authorize URL in the default browser.
 *
 * Non-fatal and never awaited for correctness: the URL is always printed to
 * stderr as the fallback, so a remote/headless operator can open it by hand.
 * Errors (no browser, unsupported platform) are swallowed.
 */
export async function openBrowser(url: string): Promise<void> {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // Best effort — the printed URL is the fallback.
  }
}

/**
 * Parse the loopback host/port out of a registered callback URI.
 *
 * Defaults to `127.0.0.1:8732` (the `DEFAULT_LOOPBACK_URI`) when the URI is
 * missing or unparseable, so a missing config never blocks the browser channel.
 */
export function parseLoopback(redirectUri: string | undefined): LoopbackTarget {
  const fallback: LoopbackTarget = { host: '127.0.0.1', port: 8732 };
  if (redirectUri === undefined || redirectUri === '') return fallback;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return fallback;
  }
  const host = url.hostname === '' ? fallback.host : url.hostname;
  const port = url.port === '' ? fallback.port : Number(url.port);
  return { host, port: Number.isFinite(port) && port > 0 ? port : fallback.port };
}

export type CaptureOptions = {
  /** How long to wait for the browser redirect before giving up. */
  timeoutMs?: number | undefined;
};

/**
 * Listen on the loopback port and resolve with the `code` (and optional
 * `domain`) the browser redirects with (design D13).
 *
 * Binds to the host/port parsed from `ctx.oauth.redirectUri` (default
 * `127.0.0.1:8732`), answers exactly one `GET` carrying a `?code=` query param
 * with a short "you can close this tab" page, then shuts the server down. A
 * request without a `code` is answered `400` and ignored (the listener keeps
 * waiting).
 *
 * Failure modes:
 *  - **timeout** → `AuthError("authorization timed out")` (exit 3), hint → use
 *    the paste channel / re-run;
 *  - **port busy** (`EADDRINUSE`) → `UsageError` (exit 2) naming the configured
 *    `oauthRedirectUri` so the operator can pick a free port.
 */
export function captureCodeFromLoopback(
  ctx: Ctx,
  options: CaptureOptions = {},
): Promise<{ code: string; domain?: string }> {
  const redirectUri = ctx.oauth.redirectUri ?? DEFAULT_LOOPBACK_URI;
  const { host, port } = parseLoopback(ctx.oauth.redirectUri);
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const server: Server = createServer((req, res) => {
      let requestUrl: URL;
      try {
        requestUrl = new URL(req.url ?? '/', redirectUri);
      } catch {
        res.statusCode = 400;
        res.end('bad request');
        return;
      }
      const code = requestUrl.searchParams.get('code');
      if (code === null || code === '') {
        res.statusCode = 400;
        res.end('missing code');
        return;
      }
      const domain = requestUrl.searchParams.get('domain') ?? undefined;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><body>You can close this tab and return to the terminal.</body></html>');
      server.close(() => done(() => resolve({ code, ...(domain === undefined ? {} : { domain }) })));
    });

    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        done(() =>
          reject(
            new UsageError(`the loopback port ${port} is already in use`, {
              hint:
                `another process is listening on ${redirectUri}; stop it, or set a free port in ` +
                `${configFilePath(process.env)} as "oauthRedirectUri": "http://127.0.0.1:<free-port>/callback"`,
            }),
          ),
        );
        return;
      }
      done(() => reject(new AuthError(`could not start the OAuth loopback listener: ${error.message}`)));
    });

    const timer = setTimeout(() => {
      server.close();
      done(() =>
        reject(
          new AuthError('authorization timed out', {
            hint: 're-run `pingcode auth login`, or choose the paste channel to enter the code manually',
          }),
        ),
      );
    }, timeoutMs);

    server.listen(port, host);
  });
}
