import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { captureCodeFromLoopback, buildAuthorizeUrl, parseLoopback } from '../src/cli/commands/oauth';
import { createTestContext } from './helpers/fake';

/**
 * The OAuth authorize step (design D13). No network — the loopback is a real
 * `127.0.0.1` listener driven by a real `fetch` from the same process; the code
 * capture, timeout and busy-port paths are all exercised here.
 */

/** A free 127.0.0.1 port, by briefly binding to 0. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Wait until a port accepts a connection (the loopback has bound). */
async function waitForPort(port: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      // Any response (even 400) means the listener is up.
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`port ${port} never opened`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function ctxOn(port: number) {
  const ctx = createTestContext();
  ctx.oauth.redirectUri = `http://127.0.0.1:${port}/callback`;
  return ctx;
}

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

describe('parseLoopback', () => {
  it('defaults to 127.0.0.1:8732 when the redirect uri is absent', () => {
    expect(parseLoopback(undefined)).toEqual({ host: '127.0.0.1', port: 8732 });
  });

  it('parses the host/port out of a configured callback', () => {
    expect(parseLoopback('http://127.0.0.1:9000/callback')).toEqual({ host: '127.0.0.1', port: 9000 });
  });
});

describe('captureCodeFromLoopback (design D13, AC7)', () => {
  let blocker: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => blocker?.close(() => resolve()) ?? resolve());
    blocker = undefined;
  });

  it('catches the code off the redirect, returns the domain, and shuts down', async () => {
    const port = await freePort();
    const ctx = ctxOn(port);
    const pending = captureCodeFromLoopback(ctx, { timeoutMs: 5000 });
    await waitForPort(port);

    const response = await fetch(`http://127.0.0.1:${port}/callback?code=ABC&domain=htz`);
    expect(response.status).toBe(200);

    await expect(pending).resolves.toEqual({ code: 'ABC', domain: 'htz' });

    // The one-shot server shut down: a second connection is refused.
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('ignores a request without a code and keeps listening', async () => {
    const port = await freePort();
    const ctx = ctxOn(port);
    const pending = captureCodeFromLoopback(ctx, { timeoutMs: 5000 });
    await waitForPort(port);

    const noCode = await fetch(`http://127.0.0.1:${port}/callback`);
    expect(noCode.status).toBe(400);

    const withCode = await fetch(`http://127.0.0.1:${port}/callback?code=ZZZ`);
    expect(withCode.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: 'ZZZ' });
  });

  it('rejects with an AuthError when the redirect never arrives', async () => {
    const port = await freePort();
    const ctx = ctxOn(port);
    await expect(captureCodeFromLoopback(ctx, { timeoutMs: 60 })).rejects.toMatchObject({
      name: 'AuthError',
      message: expect.stringContaining('timed out'),
    });
  });

  it('rejects with a UsageError naming the redirect uri when the port is busy', async () => {
    const port = await freePort();
    blocker = createServer();
    await new Promise<void>((resolve) => blocker?.listen(port, '127.0.0.1', resolve));
    const ctx = ctxOn(port);
    await expect(captureCodeFromLoopback(ctx, { timeoutMs: 2000 })).rejects.toMatchObject({
      name: 'UsageError',
      message: expect.stringContaining('already in use'),
    });
  });
});
