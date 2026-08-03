import { describe, expect, it } from 'vitest';
import { commandAt, helpFor, leavesOf, program } from './tree';

/**
 * `api` — its own leaves and its own `--help` snapshots.
 *
 * This file and `test/help/__snapshots__/api.test.ts.snap` are the write scope of
 * whoever owns this group: vitest keeps one snapshot file per test file, so adding a
 * leaf here cannot conflict with another group's child (design D6.3).
 *
 * The behaviour of the group lives in `test/apiCommand.test.ts`; this file only pins
 * the surface, plus the two contracts that have to be *visible in `--help`* to be
 * worth anything: that `--json` does nothing on the five verbs, and that a `DELETE`
 * needs `--yes`.
 *
 * **Why `fullHelp` and not `helpFor`.** `Command.helpInformation()` renders usage,
 * arguments and options only — commander appends `addHelpText('after', …)` in
 * `outputHelp()`. The notes that carry this group's two surprising rules live in
 * exactly that block, so asserting against `helpInformation()` would assert against
 * a *different* text than the one a user reads. `fullHelp` captures what
 * `pingcode api … --help` actually prints.
 */

function fullHelp(path: readonly string[]): string {
  const command = commandAt(program(), path);
  let text = '';
  command.configureOutput({
    writeOut: (chunk) => {
      text += chunk;
    },
  });
  command.outputHelp();
  return text;
}

describe('api command surface', () => {
  it('registers exactly these leaves', () => {
    // The five verbs come first because they are the point of the group; `list` and
    // `describe` are how anyone finds a path to hand them (design D3.6).
    expect(leavesOf('api')).toEqual([
      'api GET',
      'api POST',
      'api PATCH',
      'api PUT',
      'api DELETE',
      'api list',
      'api describe',
    ]);
  });

  it('accepts the lowercase spelling of every verb', () => {
    // commander matches subcommand names case-sensitively, so the lowercase forms are
    // aliases. Without them `pingcode api get /v1/…` is an unknown command, which is a
    // pointless way to fail.
    const helpText = helpFor(['api']);
    for (const verb of ['GET|get', 'POST|post', 'PATCH|patch', 'PUT|put', 'DELETE|delete']) {
      expect(helpText, verb).toContain(verb);
    }
  });

  it('says in --help that --json is a no-op on the verbs', () => {
    // stdout is raw JSON either way, so `--json` has nothing to switch. Documented
    // here, on every verb, and in skills/pingcode/modules/api.md.
    expect(fullHelp(['api'])).toMatch(/--json is a no-op on the five verbs/);
    for (const verb of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(fullHelp(['api', verb]), verb).toMatch(/--json is a no-op here/);
    }
  });

  it('documents --yes on DELETE and the PUT replacement warning', () => {
    expect(fullHelp(['api', 'DELETE'])).toMatch(/--yes is mandatory/);
    expect(fullHelp(['api', 'PUT'])).toMatch(/replaces the whole object/);
  });

  it('offers paging flags on GET and POST only', () => {
    for (const verb of ['GET', 'POST']) {
      expect(helpFor(['api', verb]), verb).toContain('--all');
    }
    for (const verb of ['PATCH', 'PUT', 'DELETE']) {
      expect(helpFor(['api', verb]), verb).not.toContain('--all');
    }
  });

  it('offers body flags on every verb the docs give a body, and not on GET', () => {
    // `DELETE /v1/pjm/stages/{stage_id}` documents an optional `replace_id` body, so
    // DELETE gets the body flags too; no documented GET has a body.
    for (const verb of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(helpFor(['api', verb]), verb).toContain('--body-file');
    }
    expect(helpFor(['api', 'GET'])).not.toContain('--body-file');
  });
});

describe('api --help', () => {
  it('api', () => {
    expect(fullHelp(['api'])).toMatchSnapshot();
  });

  it('api GET (the read verb, with paging)', () => {
    expect(fullHelp(['api', 'GET'])).toMatchSnapshot();
  });

  it('api POST (body flags plus search paging)', () => {
    expect(fullHelp(['api', 'POST'])).toMatchSnapshot();
  });

  it('api PUT (the full-replacement warning)', () => {
    expect(fullHelp(['api', 'PUT'])).toMatchSnapshot();
  });

  it('api DELETE (the --yes gate)', () => {
    expect(fullHelp(['api', 'DELETE'])).toMatchSnapshot();
  });

  it('api list', () => {
    expect(fullHelp(['api', 'list'])).toMatchSnapshot();
  });

  it('api describe', () => {
    expect(fullHelp(['api', 'describe'])).toMatchSnapshot();
  });
});
