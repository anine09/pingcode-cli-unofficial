import { describe, expect, it } from 'vitest';
import {
  ApiError,
  AuthError,
  DryRunHalt,
  NotFoundError,
  PermissionError,
  RateLimitError,
  TransportError,
  UnexpectedError,
  UsageError,
  exitCodeFor,
  kindOf,
  toPingcodeError,
} from '../src/core/errors';

describe('exitCodeFor', () => {
  it('maps every error class to its documented exit code (design §5.2)', () => {
    expect(exitCodeFor(new UnexpectedError('boom'))).toBe(1);
    expect(exitCodeFor(new UsageError('bad flag'))).toBe(2);
    expect(exitCodeFor(new AuthError('no creds'))).toBe(3);
    expect(exitCodeFor(new PermissionError('denied'))).toBe(4);
    expect(exitCodeFor(new NotFoundError('gone'))).toBe(5);
    expect(exitCodeFor(new RateLimitError('slow down'))).toBe(6);
    expect(exitCodeFor(new ApiError('weird'))).toBe(7);
    expect(exitCodeFor(new TransportError('dns'))).toBe(8);
  });

  it('treats a dry-run halt as success', () => {
    const halt = new DryRunHalt({ method: 'POST', url: 'https://x/y', headers: {} });
    expect(exitCodeFor(halt)).toBe(0);
  });

  it('falls back to 1 for anything unrecognised', () => {
    expect(exitCodeFor(new Error('plain'))).toBe(1);
    expect(exitCodeFor('a string')).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
  });

  it('exposes exitCode on the instance too', () => {
    expect(new NotFoundError('x').exitCode).toBe(5);
  });
});

describe('error metadata', () => {
  it('keeps the API code as a string and carries hints', () => {
    const error = new ApiError('请求频率过高', { code: '100038', status: 429, hint: 'wait' });
    expect(error.code).toBe('100038');
    expect(error.status).toBe(429);
    expect(error.hint).toBe('wait');
    expect(kindOf(error)).toBe('api');
  });

  it('names the class for readable output', () => {
    expect(new UsageError('x').name).toBe('UsageError');
  });

  it('normalises unknown throwables', () => {
    expect(toPingcodeError(new Error('nope')).kind).toBe('unexpected');
    expect(toPingcodeError('nope').message).toBe('nope');
    const usage = new UsageError('keep me');
    expect(toPingcodeError(usage)).toBe(usage);
  });

  it('preserves retry-after on rate limit errors', () => {
    expect(new RateLimitError('x', { retryAfterSeconds: 42 }).retryAfterSeconds).toBe(42);
  });
});
