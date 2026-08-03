import { describe, expect, it } from 'vitest';
import { helpFor, leavesOf, subgroupsOf } from './tree';

/**
 * `product` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/product.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3).
 *
 * When you add a leaf: extend the list below, add a snapshot only if the leaf's flag
 * surface is worth pinning, and leave `test/help/root.test.ts` alone.
 */

describe('product command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('product')).toEqual([
      'product list',
      'product get',
      'product idea list',
      'product idea get',
      'product idea create',
      'product idea update',
      'product ticket list',
      'product ticket get',
      'product ticket create',
      'product ticket update',
      'product ticket transition',
      'product meta idea-states',
      'product meta idea-priorities',
      'product meta idea-suites',
      'product meta idea-properties',
      'product meta members',
      'product meta ticket-states',
      'product meta ticket-priorities',
      'product meta ticket-types',
      'product meta ticket-channels',
      'product meta ticket-properties',
    ]);
  });

  it('registers exactly these subgroups', () => {
    expect(subgroupsOf('product')).toEqual([
      'product idea',
      'product ticket',
      'product meta',
    ]);
  });
});

describe('product --help', () => {
  it('product', () => {
    expect(helpFor(['product'])).toMatchSnapshot();
  });

  it('product idea', () => {
    expect(helpFor(['product', 'idea'])).toMatchSnapshot();
  });

  it('product ticket', () => {
    expect(helpFor(['product', 'ticket'])).toMatchSnapshot();
  });

  it('product meta', () => {
    expect(helpFor(['product', 'meta'])).toMatchSnapshot();
  });

  it('product idea list (the search filter surface)', () => {
    expect(helpFor(['product', 'idea', 'list'])).toMatchSnapshot();
  });

  it('product idea update (no --type: ship states are product-scoped)', () => {
    expect(helpFor(['product', 'idea', 'update'])).toMatchSnapshot();
  });

  it('product ticket create (--type is required by the API)', () => {
    expect(helpFor(['product', 'ticket', 'create'])).toMatchSnapshot();
  });

  it('product ticket transition (advisory: the server decides)', () => {
    expect(helpFor(['product', 'ticket', 'transition'])).toMatchSnapshot();
  });
});
