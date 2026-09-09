import { describe, expect, it } from 'vitest';
import { helpFor, leavesOf } from './tree';

/**
 * `skill` — list, install, remove, update the bundled pingcode skill.
 */
describe('skill command surface', () => {
  it('registers exactly these leaves', () => {
    expect(leavesOf('skill')).toEqual(['skill list', 'skill install', 'skill remove', 'skill update']);
  });
});

describe('skill --help', () => {
  it('skill', () => {
    expect(helpFor(['skill'])).toMatchSnapshot();
  });
});

describe('skill list --help', () => {
  it('list', () => {
    expect(helpFor(['skill', 'list'])).toMatchSnapshot();
  });
});

describe('skill install --help', () => {
  it('install', () => {
    expect(helpFor(['skill', 'install'])).toMatchSnapshot();
  });
});

describe('skill remove --help', () => {
  it('remove', () => {
    expect(helpFor(['skill', 'remove'])).toMatchSnapshot();
  });
});

describe('skill update --help', () => {
  it('update', () => {
    expect(helpFor(['skill', 'update'])).toMatchSnapshot();
  });
});
