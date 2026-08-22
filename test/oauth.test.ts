import { createServer, type Server } from 'node:net';
import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureOutput } from '../src/cli/output';
import {
  buildAuthorizeUrl,
  captureCodeFromLoopback,
  oauthRootOf,
  openBrowser,
  parseLoopback,
  printAuthorizeUrl,
} from '../src/cli/commands/oauth';
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

describe('printAuthorizeUrl', () => {
  it('prints the redacted authorize URL and instructions to stderr, never stdout', () => {
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
    expect(stderr).toContain('open it in a browser');
  });
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

describe('openBrowser', () => {
  const spawnMock = vi.mocked(childProcess.spawn);

  beforeEach(() => {
    spawnMock.mockClear();
    spawnMock.mockReturnValue({ unref: vi.fn() } as never);
  });

  /** Temporarily override process.platform (configurable in Node) for a branch. */
  function withPlatform<T>(platform: string, fn: () => T): T {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      return fn();
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
      else Reflect.deleteProperty(process, 'platform');
    }
  }

  it('spawns xdg-open on linux, unrefs, and never throws', async () => {
    const url = 'https://open.pingcode.com/oauth2/authorize?x=1';
    await expect(openBrowser(url)).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith('xdg-open', [url], { stdio: 'ignore', detached: true });
    const child = spawnMock.mock.results[0]?.value as { unref: ReturnType<typeof vi.fn> };
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('spawns `open` on darwin', async () => {
    await withPlatform('darwin', () => openBrowser('https://example.com/auth'));
    expect(spawnMock).toHaveBeenCalledWith('open', ['https://example.com/auth'], {
      stdio: 'ignore',
      detached: true,
    });
  });

  it('spawns `cmd /c start` on win32', async () => {
    const url = 'https://example.com/auth';
    await withPlatform('win32', () => openBrowser(url));
    expect(spawnMock).toHaveBeenCalledWith('cmd', ['/c', 'start', '', url], {
      stdio: 'ignore',
      detached: true,
    });
  });

  it('swallows a spawn failure and still resolves (printed URL is the fallback)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    await expect(openBrowser('https://example.com/auth')).resolves.toBeUndefined();
  });
});

describe('parseLoopback (boundary branches)', () => {
  it('defaults on an empty string as well as undefined', () => {
    expect(parseLoopback('')).toEqual({ host: '127.0.0.1', port: 8732 });
  });

  it('defaults when the redirect uri is not a parseable URL', () => {
    expect(parseLoopback('not a url')).toEqual({ host: '127.0.0.1', port: 8732 });
  });

  it('falls back to the default host when the hostname is empty', () => {
    expect(parseLoopback('http://:8732/callback')).toEqual({ host: '127.0.0.1', port: 8732 });
  });

  it('falls back to the default port when the port is empty, non-numeric, or not positive', () => {
    expect(parseLoopback('http://127.0.0.1/callback')).toEqual({ host: '127.0.0.1', port: 8732 });
    expect(parseLoopback('http://127.0.0.1:abc/callback')).toEqual({ host: '127.0.0.1', port: 8732 });
    expect(parseLoopback('http://127.0.0.1:0/callback')).toEqual({ host: '127.0.0.1', port: 8732 });
  });

  it('parses a named host', () => {
    expect(parseLoopback('http://localhost:9000/callback')).toEqual({ host: 'localhost', port: 9000 });
  });
});
