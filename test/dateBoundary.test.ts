import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDateBoundaryFlag } from '../src/cli/commands/common';
import { UsageError } from '../src/core/errors';

/**
 * S3: `--start` / `--end` date input.
 *
 * The failure mode this file exists to prevent is a silent off-by-one **day**:
 * mapping both ends of a range to local midnight shortens every plan by a day,
 * and the CLI would echo back exactly what it sent, so a smoke run cannot see
 * it. The boundary rule is therefore asserted against **literal** unix seconds
 * under an **explicitly fixed timezone** — never against a value recomputed
 * with the same `Date` call the helper uses, which would pass even if the rule
 * were inverted, and never against the runner's own zone.
 */

const REAL_TZ = process.env.TZ;

function withTimezone(tz: string): void {
  process.env.TZ = tz;
}

beforeEach(() => {
  withTimezone('UTC');
});

afterEach(() => {
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

function caught(run: () => unknown): UsageError {
  try {
    run();
  } catch (error) {
    return error as UsageError;
  }
  throw new Error('expected a UsageError, but the call succeeded');
}

describe('the calendar-date form maps to a local day boundary', () => {
  // Verified independently per zone; 2026-08-10 and 2026-08-31 are both well
  // clear of any DST transition in these three zones.
  const zones: Array<[string, number, number]> = [
    // tz, 2026-08-10 00:00:00 local, 2026-08-31 23:59:59 local
    ['Asia/Shanghai', 1_786_291_200, 1_788_191_999],
    ['America/New_York', 1_786_334_400, 1_788_235_199],
    ['UTC', 1_786_320_000, 1_788_220_799],
  ];

  for (const [tz, startAt, endAt] of zones) {
    it(`${tz}: --start is 00:00:00 and --end is 23:59:59, local`, () => {
      withTimezone(tz);
      expect(parseDateBoundaryFlag('2026-08-10', '--start', 'start')).toBe(startAt);
      expect(parseDateBoundaryFlag('2026-08-31', '--end', 'end')).toBe(endAt);
    });
  }

  it('the asymmetry is exactly one second short of a full day, in every zone', () => {
    for (const [tz] of zones) {
      withTimezone(tz);
      const start = parseDateBoundaryFlag('2026-08-10', '--start', 'start');
      const end = parseDateBoundaryFlag('2026-08-10', '--end', 'end');
      // Same calendar date on both flags must span the whole day, not zero.
      expect(end - start, tz).toBe(86_399);
    }
  });

  it('a range would be a day short if --end were treated like --start', () => {
    withTimezone('Asia/Shanghai');
    const end = parseDateBoundaryFlag('2026-08-31', '--end', 'end');
    const endAsStart = parseDateBoundaryFlag('2026-08-31', '--start', 'start');
    expect(end - endAsStart).toBe(86_399);
    // The literal the API must receive for "through 31 August" in UTC+8.
    expect(end).toBe(1_788_191_999);
  });

  it('follows real elapsed time across a DST transition rather than assuming 24h', () => {
    // 2026-03-08 is spring-forward in New York: that local day is 23 hours long.
    withTimezone('America/New_York');
    const start = parseDateBoundaryFlag('2026-03-08', '--start', 'start');
    const end = parseDateBoundaryFlag('2026-03-08', '--end', 'end');
    expect(start).toBe(1_772_946_000);
    expect(end).toBe(1_773_028_799);
    expect(end - start).toBe(82_799);
  });

  it('accepts a leap day', () => {
    withTimezone('UTC');
    expect(parseDateBoundaryFlag('2028-02-29', '--start', 'start')).toBe(1_835_395_200);
  });
});

describe('the unix-seconds form is passed through verbatim', () => {
  it('is not snapped to a day boundary on either flag', () => {
    withTimezone('Asia/Shanghai');
    // The escape hatch: an exact instant, used as given.
    expect(parseDateBoundaryFlag('1786291200', '--start', 'start')).toBe(1_786_291_200);
    expect(parseDateBoundaryFlag('1786291200', '--end', 'end')).toBe(1_786_291_200);
  });

  it('is timezone-independent, unlike the calendar form', () => {
    withTimezone('Asia/Shanghai');
    const shanghai = parseDateBoundaryFlag('1788191999', '--end', 'end');
    withTimezone('America/New_York');
    const newYork = parseDateBoundaryFlag('1788191999', '--end', 'end');
    expect(shanghai).toBe(newYork);
  });

  it('tolerates surrounding whitespace on both forms', () => {
    withTimezone('UTC');
    expect(parseDateBoundaryFlag('  1786291200  ', '--start', 'start')).toBe(1_786_291_200);
    expect(parseDateBoundaryFlag(' 2026-08-10 ', '--start', 'start')).toBe(1_786_320_000);
  });
});

describe('everything else is a UsageError at exit 2, before any request', () => {
  const rejected = [
    ['an unpadded month and day', '2026-8-1'],
    ['a US-style slash date', '08/31/2026'],
    ['an ISO date-time', '2026-08-31T09:00:00Z'],
    ['a bare year', '2026'],
    ['a spelled-out date', 'Aug 31 2026'],
    ['a year-month', '2026-08'],
    ['a reversed date', '31-08-2026'],
    ['a 9-digit value', '178629120'],
    ['an 11-digit value', '17862912000'],
    ['an impossible calendar date', '2026-02-30'],
    ['a 32nd day', '2026-08-32'],
    ['a 13th month', '2026-13-01'],
    ['not a date at all', 'tomorrow'],
  ] as const;

  for (const [label, value] of rejected) {
    it(`rejects ${label}: "${value}"`, () => {
      const error = caught(() => parseDateBoundaryFlag(value, '--start', 'start'));
      expect(error).toBeInstanceOf(UsageError);
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain('--start');
      expect(error.message).toContain(value);
    });
  }

  it('rejects a 13-digit millisecond value and says so specifically', () => {
    const error = caught(() => parseDateBoundaryFlag('1786291200000', '--end', 'end'));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.hint).toContain('milliseconds');
    expect(error.hint).toContain('seconds');
  });

  it('names both accepted forms in the hint', () => {
    const error = caught(() => parseDateBoundaryFlag('08/31/2026', '--end', 'end'));
    expect(error.hint).toContain('2026-08-31');
    expect(error.hint).toContain('unix seconds');
  });

  it('points at zero-padding when that is the only thing wrong', () => {
    const error = caught(() => parseDateBoundaryFlag('2026-8-1', '--start', 'start'));
    expect(error.hint).toContain('2026-8-1');
  });

  it('calls an impossible date a typo rather than rolling it into the next month', () => {
    // `new Date(2026, 1, 30)` would silently become 2026-03-01.
    const error = caught(() => parseDateBoundaryFlag('2026-02-30', '--end', 'end'));
    expect(error.message).toContain('not a real date');
  });

  it('rejects a missing or empty value, naming the flag', () => {
    expect(caught(() => parseDateBoundaryFlag(undefined, '--start', 'start')).message).toContain(
      '--start is required',
    );
    expect(caught(() => parseDateBoundaryFlag('', '--end', 'end')).message).toContain(
      '--end is required',
    );
    expect(caught(() => parseDateBoundaryFlag('   ', '--end', 'end')).message).toContain(
      '--end is required',
    );
  });

  it('does not fall back to Date.parse, which the older timestamp flag does', () => {
    // `parseTimestampFlag` accepts '2026-08-31T09:00:00Z'; this helper must not,
    // because Date.parse also accepts forms it would resolve by guessing.
    const error = caught(() => parseDateBoundaryFlag('2026-08-31T09:00:00Z', '--start', 'start'));
    expect(error).toBeInstanceOf(UsageError);
  });
});
