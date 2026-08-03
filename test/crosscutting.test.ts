import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommanderError, type Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRINCIPAL_TYPES, RELATION_TARGETS } from '../src/api/common';
import {
  CROSSCUTTING_FAMILIES,
  RELATION_TARGET_HELP_PREFIX,
  type CrosscuttingFamily,
} from '../src/cli/commands/_shared/crosscutting';
import { captureOutput } from '../src/cli/output';
import { buildProgram } from '../src/cli/program';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { findByMethodPath, type CatalogMethod } from '../src/core/catalog';
import { DryRunHalt, exitCodeFor } from '../src/core/errors';
import { createFakeFetch, jsonResponse, type FakeCall } from './helpers/fake';

/**
 * The cross-object families — relations / comments / attachments / activities — as
 * mounted onto five entities (PRD S0, design D5).
 *
 * Four things are proven here, and the first two are the acceptance criteria that
 * make "inject once, mount many" a claim rather than a hope:
 *
 *  1. **No family is mounted where its endpoint does not exist.** The mount table is
 *     read out of the *live commander tree* rather than restated, so a wrong mount
 *     cannot hide from this file. Note carefully what the catalog can and cannot
 *     settle: it proves the endpoint exists, **never** that a given `principal_type`
 *     is accepted by it. The second half is only knowable live, so it is a table of
 *     recorded observations (`PRINCIPAL_TYPES`) checked here — see the smoke notes in
 *     `api/common.ts` for what was probed and when.
 *  2. **Five mounts cost one help snapshot, not forty** (design D5.6). One mount is
 *     snapshotted verbatim; every other mount's help must equal it once the command
 *     path and the entity's own names are normalised away. That is what keeps this
 *     feature from swamping the help suite, and it also proves the mounts really are
 *     one implementation rather than five copies that merely look alike today.
 *  3. **The wire shape of all fourteen endpoints**, including the three asymmetries
 *     the API imposes: the principal is a query parameter on reads and deletes but a
 *     body field on the two creates, `target_type` is mandatory on the relation list,
 *     and a snippet cannot be written without the `comment_id` it hangs off.
 *  4. **The `--yes` gate fires before any request**, for all three deletes.
 */

const CLIENT_SECRET = 'SECRET-must-never-be-printed';
const ACCESS_TOKEN = 'TOKEN-must-never-be-printed';

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-crosscutting-'));
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      clientId: 'test-client',
      clientSecret: CLIENT_SECRET,
      token: {
        accessToken: ACCESS_TOKEN,
        expiresAtMs: Date.now() + THIRTY_DAYS_MS,
        obtainedAtMs: Date.now(),
      },
    }),
    { mode: 0o600 },
  );
  previousConfigDir = process.env.PINGCODE_CONFIG_DIR;
  process.env.PINGCODE_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.PINGCODE_CONFIG_DIR;
  else process.env.PINGCODE_CONFIG_DIR = previousConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the mount table, read out of the commander tree
// ---------------------------------------------------------------------------

type Mount = {
  /** e.g. `['project', 'work-item']`. */
  path: string[];
  principalType: string;
  families: CrosscuttingFamily[];
};

/**
 * Every cross-object mount in the program, discovered by walking the tree.
 *
 * The `principal_type` is read back out of the subgroup's own description, which is
 * where it is stated for the user's benefit anyway (`relation … (principal_type=idea)`).
 * That is deliberate: this test must not be handed the answer it is checking, or a
 * mount added with the wrong type would pass.
 */
function mounts(): Mount[] {
  const found = new Map<string, Mount>();

  const walk = (command: Command, prefix: string[]): void => {
    for (const child of command.commands) {
      if (child.name() === 'help') continue;
      const family = CROSSCUTTING_FAMILIES.find((candidate) => candidate === child.name());
      const declared = /principal_type=([a-z_]+)/.exec(child.description());
      if (family !== undefined && declared !== null) {
        const key = prefix.join(' ');
        const existing = found.get(key);
        if (existing === undefined) {
          found.set(key, {
            path: [...prefix],
            principalType: declared[1] ?? '',
            families: [family],
          });
        } else {
          existing.families.push(family);
          // One mount, one principal type: a subgroup declaring a different one would
          // mean two families on the same entity disagree about what it is.
          expect(existing.principalType, key).toBe(declared[1]);
        }
        continue;
      }
      walk(child, [...prefix, child.name()]);
    }
  };

  walk(buildProgram(), []);
  return [...found.values()];
}

/** The endpoints each family calls, as `(method, path template)` pairs. */
const FAMILY_ENDPOINTS: Record<CrosscuttingFamily, readonly (readonly [CatalogMethod, string])[]> =
  {
    relation: [
      ['GET', '/v1/relations'],
      ['POST', '/v1/relations'],
      ['GET', '/v1/relations/{relation_id}'],
      ['DELETE', '/v1/relations/{relation_id}'],
    ],
    comment: [
      ['GET', '/v1/comments'],
      ['POST', '/v1/comments'],
      ['GET', '/v1/comments/{comment_id}'],
      ['DELETE', '/v1/comments/{comment_id}'],
    ],
    attachment: [
      ['GET', '/v1/attachments'],
      ['POST', '/v1/attachments'],
      ['GET', '/v1/attachments/{attachment_id}'],
      ['DELETE', '/v1/attachments/{attachment_id}'],
    ],
    activity: [
      ['GET', '/v1/activities'],
      ['GET', '/v1/activities/{activity_id}'],
    ],
  };

describe('the mount table (design D5.2)', () => {
  it('mounts all four families on exactly the five entities that accept them', () => {
    expect(
      mounts().map((mount) => `${mount.path.join(' ')} → ${mount.principalType}`),
    ).toEqual([
      'product idea → idea',
      'product ticket → ticket',
      'project work-item → work_item',
      'testhub cases → test_case',
      'testhub runs → test_run',
    ]);
  });

  it('gives every mount the same four subgroups, in the same order', () => {
    for (const mount of mounts()) {
      expect(mount.families, mount.path.join(' ')).toEqual([...CROSSCUTTING_FAMILIES]);
    }
  });

  /**
   * The catalog half of the acceptance criterion. It is a real check — a family
   * mounted on a path the docs do not have would fail here — but it is only half,
   * and the half it cannot do is the interesting one: these paths exist for *every*
   * principal type, including the ones the server rejects. Hence the test below.
   */
  it('every mounted family has all of its endpoints in the catalog', () => {
    const missing: string[] = [];
    for (const mount of mounts()) {
      for (const family of mount.families) {
        for (const [method, endpointPath] of FAMILY_ENDPOINTS[family]) {
          if (findByMethodPath(method, endpointPath) === undefined) {
            missing.push(`${mount.path.join(' ')} ${family}: ${method} ${endpointPath}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * The half the catalog cannot prove: that the endpoint accepts this
   * `principal_type`. `PRINCIPAL_TYPES` is a record of live observations, not a
   * derivation — which is exactly why it is checked separately and why its comment
   * carries the date it was measured.
   */
  it('every mounted family accepts its mount\'s principal_type (live-observed)', () => {
    const wrong: string[] = [];
    for (const mount of mounts()) {
      for (const family of mount.families) {
        const accepted: readonly string[] = PRINCIPAL_TYPES[family];
        if (!accepted.includes(mount.principalType)) {
          wrong.push(`${mount.path.join(' ')} ${family}: ${mount.principalType}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The negative case, and it is not hypothetical: design D5.2 originally listed
   * `testhub plans` as a mount. Live, a test plan is not a principal in any family —
   * two of them reject it and `activities` answers HTTP 500 — so the mount moved to
   * `testhub runs`. This assertion is what stops it coming back.
   */
  it('does not mount anything on a test plan, which is not a principal', () => {
    const plans = mounts().find((mount) => mount.path.join(' ') === 'testhub plans');
    expect(plans).toBeUndefined();
  });

  it('adds no top-level group: the generic executor already covers that (design D5.4)', () => {
    const topLevel = buildProgram()
      .commands.map((command) => command.name())
      .filter((name) => (CROSSCUTTING_FAMILIES as readonly string[]).includes(name));
    expect(topLevel).toEqual([]);
  });

  it('declares a relation target set for every mounted principal type', () => {
    for (const mount of mounts()) {
      const targets: readonly string[] = RELATION_TARGETS[mount.principalType as 'work_item'] ?? [];
      expect(targets.length, mount.path.join(' ')).toBeGreaterThan(0);
      // A relation is between two *kinds*, so a set containing only the principal's
      // own kind would mean the mount should not have the family at all.
      expect(targets, mount.path.join(' ')).not.toEqual([mount.principalType]);
    }
  });
});

// ---------------------------------------------------------------------------
// one snapshot, many mounts (design D5.6)
// ---------------------------------------------------------------------------

/** The mount whose help is pinned verbatim; every other mount is compared to it. */
const REFERENCE = ['project', 'work-item'];

function commandAt(root: Command, at: readonly string[]): Command {
  let cursor = root;
  for (const name of at) {
    const next: Command | undefined = cursor.commands.find((child) => child.name() === name);
    if (next === undefined) throw new Error(`no command at ${at.join(' ')}`);
    cursor = next;
  }
  return cursor;
}

/**
 * What `pingcode … --help` actually prints for one command.
 *
 * **Not `helpInformation()`**: that renders usage, arguments and options only, and
 * commander appends `addHelpText('after', …)` in `outputHelp()`. Everything this
 * feature has to say about the API's quirks — the relation target matrix, the missing
 * file upload, the soft delete — lives in exactly that block, so comparing
 * `helpInformation()` would compare a text no user ever sees. Same reasoning, and the
 * same helper, as `test/help/api.test.ts`.
 */
function fullHelp(command: Command): string {
  let text = '';
  command.configureOutput({
    writeOut: (chunk) => {
      text += chunk;
    },
  });
  command.outputHelp();
  return text;
}

/**
 * Every cross-object `--help` of one mount, in one string: the four subgroups and all
 * fourteen leaves. Bundling them is what makes a *single* snapshot entry cover the
 * whole feature at that mount.
 */
function helpBundle(mount: readonly string[]): string {
  const root = buildProgram();
  const parent = commandAt(root, mount);
  const parts: string[] = [];
  for (const family of CROSSCUTTING_FAMILIES) {
    const group = commandAt(parent, [family]);
    parts.push(`### ${[...mount, family].join(' ')}\n${fullHelp(group)}`);
    for (const leaf of group.commands) {
      if (leaf.name() === 'help') continue;
      parts.push(`### ${[...mount, family, leaf.name()].join(' ')}\n${fullHelp(leaf)}`);
    }
  }
  return parts.join('\n');
}

/**
 * Erase everything that is *allowed* to differ between mounts, and nothing else:
 *
 *  - the command path and the entity's three names — the command noun, the
 *    `principal_type`, and the prose form the help uses (`work item`) — all replaced
 *    by one placeholder, so `work-item` / `work_item` / `work item` and the three
 *    identical spellings of `idea` normalise the same way. Whole-word only, or
 *    `work_item` would also eat the `/v1/pjm/work_items/…` in the help text;
 *  - the one line listing the accepted relation targets, which is per-principal by
 *    design and is asserted separately below.
 *
 * Whitespace is collapsed last: commander re-wraps its columns when a path gets
 * longer, and a line break moving is not a difference in the surface. Everything
 * else — every flag, every argument, every description — must match exactly.
 */
function normalise(mount: readonly string[], principalType: string): string {
  const noun = mount[mount.length - 1] ?? '';
  let text = helpBundle(mount);
  for (const token of [mount.join(' '), principalType, principalType.replace(/_/g, ' '), noun]) {
    if (token === '') continue;
    text = text.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g'), '<ENTITY>');
  }
  text = text.replace(
    new RegExp(`${escapeRegExp(RELATION_TARGET_HELP_PREFIX)}.*`, 'g'),
    `${RELATION_TARGET_HELP_PREFIX} <TARGETS>`,
  );
  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('the cross-object help surface', () => {
  it('the reference mount, verbatim — the only new snapshot entry this feature adds', () => {
    expect(helpBundle(REFERENCE)).toMatchSnapshot();
  });

  it('every other mount is the same surface modulo the command path', () => {
    const all = mounts();
    const reference = all.find((mount) => mount.path.join(' ') === REFERENCE.join(' '));
    expect(reference, 'the reference mount must exist').toBeDefined();
    const expected = normalise(REFERENCE, reference?.principalType ?? '');

    for (const mount of all) {
      if (mount.path.join(' ') === REFERENCE.join(' ')) continue;
      expect(normalise(mount.path, mount.principalType), mount.path.join(' ')).toEqual(expected);
    }
  });

  it('states the accepted relation targets of its own principal, and nothing else', () => {
    for (const mount of mounts()) {
      const help = fullHelp(commandAt(buildProgram(), [...mount.path, 'relation']));
      const line = new RegExp(`${escapeRegExp(RELATION_TARGET_HELP_PREFIX)}(.*)`).exec(help);
      expect(line, mount.path.join(' ')).not.toBeNull();
      expect((line?.[1] ?? '').trim().split(/\s+/), mount.path.join(' ')).toEqual([
        ...RELATION_TARGETS[mount.principalType as 'work_item'],
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// the wire: all fourteen endpoints, through the real command tree
// ---------------------------------------------------------------------------

type CliRun = {
  stdout: string;
  stderr: string;
  exit: number;
  calls: FakeCall[];
};

/** Run one invocation exactly as `bin/pingcode.ts` does, with `fetch` replaced. */
async function runCli(argv: string[], responses: Array<() => Response> = []): Promise<CliRun> {
  const fake = createFakeFetch(responses);
  let stdout = '';
  let stderr = '';

  const restoreOutput = captureOutput(
    (chunk) => {
      stdout += chunk;
    },
    (chunk) => {
      stderr += chunk;
    },
  );
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch as unknown as typeof globalThis.fetch;

  let exit = 0;
  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'pingcode', ...argv]);
  } catch (error) {
    if (error instanceof DryRunHalt) {
      exit = 0;
    } else if (error instanceof CommanderError) {
      exit = error.exitCode === 0 ? 0 : 2;
    } else {
      const { printError } = await import('../src/cli/output');
      printError(error, { json: argv.includes('--json') });
      exit = exitCodeFor(error);
    }
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realStderrWrite;
    restoreOutput();
  }

  return { stdout, stderr, exit, calls: fake.calls };
}

/**
 * Ids shaped like the real thing: 24-hex, and deliberately **not** identifier-shaped.
 * `AAA-1` would be read as an identifier and routed through a search endpoint instead
 * of a direct read, which is a different request and a different fake.
 */
const WORK_ITEM_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const SHIP_IDEA_ID = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const SHIP_TICKET_ID = 'ccccccccccccccccccccccc3';
const TEST_CASE_ID = 'ddddddddddddddddddddddd4';
const TEST_RUN_ID = 'eeeeeeeeeeeeeeeeeeeeeee5';

/** `GET /v1/pjm/work_items/{id}` — the one read every mount spends to get a real id. */
const workItem = () => jsonResponse({ id: WORK_ITEM_ID, identifier: 'AAA-1', title: 'parent' });

const page = (values: unknown[] = []) => () =>
  jsonResponse({ page_index: 0, page_size: 30, total: values.length, values });

const object = (body: unknown) => () => jsonResponse(body);

function urlOf(run: CliRun, index: number): URL {
  return new URL(run.calls[index]?.url ?? 'https://x.invalid/');
}

describe('every family sends the documented request', () => {
  it('resolves the reference to an id first, because no endpoint takes an identifier', async () => {
    const run = await runCli(
      ['project', 'work-item', 'comment', 'list', 'AAA-1', '--json'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 10,
            total: 1,
            values: [{ id: WORK_ITEM_ID, identifier: 'AAA-1' }],
          }),
        page([]),
      ],
    );
    expect(run.exit).toBe(0);
    // First the identifier lookup, then the comment list with the resolved id.
    expect(urlOf(run, 0).pathname).toBe('/v1/pjm/work_items');
    expect(urlOf(run, 0).searchParams.get('identifier')).toBe('AAA-1');
    expect(urlOf(run, 1).searchParams.get('principal_id')).toBe(WORK_ITEM_ID);
  });

  it('comment list / get carry the principal in the query', async () => {
    const list = await runCli(
      ['project', 'work-item', 'comment', 'list', WORK_ITEM_ID, '--json'],
      [workItem, page([{ id: 'c1', content: 'hi', is_deleted: 0 }])],
    );
    expect(list.exit).toBe(0);
    expect(urlOf(list, 1).pathname).toBe('/v1/comments');
    expect(urlOf(list, 1).searchParams.get('principal_type')).toBe('work_item');
    expect(urlOf(list, 1).searchParams.get('principal_id')).toBe(WORK_ITEM_ID);

    const get = await runCli(
      ['project', 'work-item', 'comment', 'get', WORK_ITEM_ID, 'c1', '--json'],
      [workItem, object({ id: 'c1', content: 'hi', is_deleted: 0 })],
    );
    expect(get.exit).toBe(0);
    expect(urlOf(get, 1).pathname).toBe('/v1/comments/c1');
    expect(urlOf(get, 1).searchParams.get('principal_id')).toBe(WORK_ITEM_ID);
  });

  it('comment add carries the principal in the body instead', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'comment',
        'add',
        WORK_ITEM_ID,
        '--text',
        'CI #123 failed',
        '--json',
      ],
      [workItem, object({ id: 'c9', content: 'CI #123 failed', is_deleted: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.method).toBe('POST');
    expect(urlOf(run, 1).pathname).toBe('/v1/comments');
    expect(urlOf(run, 1).searchParams.get('principal_type')).toBeNull();
    expect(run.calls[1]?.body).toEqual({
      principal_type: 'work_item',
      principal_id: WORK_ITEM_ID,
      content: 'CI #123 failed',
    });
  });

  it('renders a soft-deleted comment as deleted rather than as an empty one', async () => {
    const run = await runCli(
      ['project', 'work-item', 'comment', 'list', WORK_ITEM_ID],
      [workItem, page([{ id: 'c1', content: '', is_deleted: 1 }])],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('deleted');
  });

  it('the relation list demands target_type, which the API requires', async () => {
    const refused = await runCli(['project', 'work-item', 'relation', 'list', WORK_ITEM_ID]);
    expect(refused.exit).toBe(2);
    expect(refused.calls).toHaveLength(0);

    const run = await runCli(
      [
        'project',
        'work-item',
        'relation',
        'list',
        WORK_ITEM_ID,
        '--target-type',
        'test_case',
        '--json',
      ],
      [workItem, page([])],
    );
    expect(run.exit).toBe(0);
    expect(urlOf(run, 1).searchParams.get('target_type')).toBe('test_case');
  });

  it('relation add posts the pair with no relation type of any kind', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'relation',
        'add',
        WORK_ITEM_ID,
        '--target-type',
        'test_case',
        '--target-id',
        'case-1',
        '--json',
      ],
      [workItem, object({ id: 'r1', principal_type: 'work_item', target_type: 'test_case' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.body).toEqual({
      principal_type: 'work_item',
      principal_id: WORK_ITEM_ID,
      target_type: 'test_case',
      target_id: 'case-1',
    });
  });

  /**
   * The parent reference is accepted for signature symmetry (design D5.3) and must
   * cost nothing: `/v1/relations/{id}` needs no principal, so a resolve request here
   * would be pure waste.
   */
  it('relation get spends no request resolving the reference it does not send', async () => {
    const run = await runCli(
      ['project', 'work-item', 'relation', 'get', 'AAA-1', 'r1', '--json'],
      [object({ id: 'r1', principal_type: 'work_item', target_type: 'idea' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(urlOf(run, 0).pathname).toBe('/v1/relations/r1');
    expect(urlOf(run, 0).search).toBe('');
  });

  it('explains a rejected pair, because the API blames the wrong field', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'relation',
        'add',
        WORK_ITEM_ID,
        '--target-type',
        'work_item',
        '--target-id',
        'other',
      ],
      [
        workItem,
        () =>
          jsonResponse(
            { code: '100049', message: "不支持的'principal_type'" },
            { status: 400 },
          ),
      ],
    );
    expect(run.exit).toBe(7);
    expect(run.stderr).toContain('work_item → work_item');
    expect(run.stderr).toContain('/v1/pjm/work_items/{id}/relations');
  });

  it('explains a refused work-item type, which the message does not mention', async () => {
    const run = await runCli(
      [
        'testhub',
        'cases',
        'relation',
        'add',
        TEST_CASE_ID,
        '--target-type',
        'work_item',
        '--target-id',
        'feature-1',
      ],
      [
        object({ id: TEST_CASE_ID }),
        () =>
          jsonResponse({ code: '100107', message: '不支持的工作项类型' }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(7);
    expect(run.stderr).toContain('the kinds are fine');
    expect(run.stderr).toContain('缺陷');
  });

  it('attachment list scopes to a comment only when asked', async () => {
    const bare = await runCli(
      ['project', 'work-item', 'attachment', 'list', WORK_ITEM_ID, '--json'],
      [workItem, page([])],
    );
    expect(urlOf(bare, 1).searchParams.get('comment_id')).toBeNull();

    const scoped = await runCli(
      ['project', 'work-item', 'attachment', 'list', WORK_ITEM_ID, '--comment-id', 'c1', '--json'],
      [workItem, page([])],
    );
    expect(urlOf(scoped, 1).searchParams.get('comment_id')).toBe('c1');
  });

  it('add-snippet requires the comment_id the docs call optional', async () => {
    const missing = await runCli([
      'project',
      'work-item',
      'attachment',
      'add-snippet',
      WORK_ITEM_ID,
      '--title',
      't',
      '--format',
      'javascript',
      '--content',
      'const a = 1;',
    ]);
    expect(missing.exit).toBe(2);
    expect(missing.calls).toHaveLength(0);

    const run = await runCli(
      [
        'project',
        'work-item',
        'attachment',
        'add-snippet',
        WORK_ITEM_ID,
        '--comment-id',
        'c1',
        '--title',
        'probe',
        '--format',
        'javascript',
        '--content',
        'const a = 1;',
        '--json',
      ],
      [workItem, object({ id: 'a1', type: 'snippet', format: 'javascript' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.body).toEqual({
      principal_type: 'work_item',
      principal_id: WORK_ITEM_ID,
      comment_id: 'c1',
      title: 'probe',
      format: 'javascript',
      content: 'const a = 1;',
    });
  });

  it('add-snippet needs exactly one content source', async () => {
    const neither = await runCli([
      'project',
      'work-item',
      'attachment',
      'add-snippet',
      WORK_ITEM_ID,
      '--comment-id',
      'c1',
      '--title',
      't',
      '--format',
      'go',
    ]);
    expect(neither.exit).toBe(2);
    expect(neither.calls).toHaveLength(0);

    const both = await runCli([
      'project',
      'work-item',
      'attachment',
      'add-snippet',
      WORK_ITEM_ID,
      '--comment-id',
      'c1',
      '--title',
      't',
      '--format',
      'go',
      '--content',
      'x',
      '--content-file',
      path.join(dir, 'snippet.go'),
    ]);
    expect(both.exit).toBe(2);
    expect(both.calls).toHaveLength(0);
  });

  it('reads a snippet from a file verbatim, without parsing it', async () => {
    const file = path.join(dir, 'snippet.go');
    writeFileSync(file, 'package main\n\nfunc main() {}\n');
    const run = await runCli(
      [
        'project',
        'work-item',
        'attachment',
        'add-snippet',
        WORK_ITEM_ID,
        '--comment-id',
        'c1',
        '--title',
        'main.go',
        '--format',
        'go',
        '--content-file',
        file,
        '--json',
      ],
      [workItem, object({ id: 'a2', type: 'snippet' })],
    );
    expect(run.exit).toBe(0);
    expect((run.calls[1]?.body as { content?: string }).content).toBe(
      'package main\n\nfunc main() {}\n',
    );
  });

  it('activity list and get are reads that carry the principal', async () => {
    const list = await runCli(
      ['project', 'work-item', 'activity', 'list', WORK_ITEM_ID, '--json'],
      [workItem, page([{ id: 'ac1', template: 'update', summary: '更新了' }])],
    );
    expect(list.exit).toBe(0);
    expect(urlOf(list, 1).pathname).toBe('/v1/activities');

    const get = await runCli(
      ['project', 'work-item', 'activity', 'get', WORK_ITEM_ID, 'ac1', '--json'],
      [workItem, object({ id: 'ac1', template: 'update' })],
    );
    expect(get.exit).toBe(0);
    expect(urlOf(get, 1).pathname).toBe('/v1/activities/ac1');
    expect(urlOf(get, 1).searchParams.get('principal_type')).toBe('work_item');
  });

  it('--all walks the pages of a cross-object list', async () => {
    const run = await runCli(
      ['project', 'work-item', 'comment', 'list', WORK_ITEM_ID, '--all', '--page-size', '1', '--json'],
      [
        workItem,
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 1,
            total: 2,
            values: [{ id: 'c1', is_deleted: 0 }],
          }),
        () =>
          jsonResponse({
            page_index: 1,
            page_size: 1,
            total: 2,
            values: [{ id: 'c2', is_deleted: 0 }],
          }),
        page([]),
      ],
    );
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ count: 2, all: true });
  });
});

describe('the --yes gate (design D8.1)', () => {
  const deletes: readonly (readonly string[])[] = [
    ['project', 'work-item', 'relation', 'delete', WORK_ITEM_ID, 'r1'],
    ['project', 'work-item', 'comment', 'delete', WORK_ITEM_ID, 'c1'],
    ['project', 'work-item', 'attachment', 'delete', WORK_ITEM_ID, 'a1'],
  ];

  it('refuses every delete without --yes, before any request', async () => {
    for (const argv of deletes) {
      const run = await runCli([...argv]);
      expect(run.exit, argv.join(' ')).toBe(2);
      expect(run.calls, argv.join(' ')).toHaveLength(0);
      expect(run.stderr, argv.join(' ')).toContain('--yes');
    }
  });

  it('refuses `--yes false`, which commander would otherwise read as --yes', async () => {
    // The gate is only as strong as the parse in front of it. commander's default is to
    // silently discard an excess positional, so `--yes false` used to mean `--yes true`
    // — the exact inverse of the request — and the delete really went out. Closed
    // program-wide by `allowExcessArguments(false)` in `cli/program.ts`, which every one
    // of these mounts inherits even though `addCrosscutting` builds them after the fact.
    for (const argv of deletes) {
      const run = await runCli([...argv, '--yes', 'false']);
      expect(run.exit, argv.join(' ')).toBe(2);
      expect(run.calls, argv.join(' ')).toHaveLength(0);
      expect(run.stderr, argv.join(' ')).toContain('too many arguments');
    }
  });

  it('sends the delete once --yes is given', async () => {
    const run = await runCli(
      ['project', 'work-item', 'comment', 'delete', WORK_ITEM_ID, 'c1', '--yes', '--json'],
      [workItem, object({ id: 'c1', content: '', is_deleted: 1 })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.method).toBe('DELETE');
    expect(urlOf(run, 1).pathname).toBe('/v1/comments/c1');
  });

  it('sends no write under --dry-run, and exits 0 (design D8.3)', async () => {
    const run = await runCli(
      ['project', 'work-item', 'comment', 'add', WORK_ITEM_ID, '--text', 'x', '--dry-run'],
      [workItem],
    );
    expect(run.exit).toBe(0);
    // The reference resolution is a read and still happens; the write does not.
    expect(run.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });
});

describe('the principal type comes from the mount, never from the user', () => {
  it('has no --principal-type flag anywhere (design D5.1)', () => {
    for (const mount of mounts()) {
      for (const family of mount.families) {
        const group = commandAt(buildProgram(), [...mount.path, family]);
        for (const leaf of group.commands) {
          expect(fullHelp(leaf), `${mount.path.join(' ')} ${family} ${leaf.name()}`).not.toContain(
            '--principal-type',
          );
        }
      }
    }
  });

  it('sends each mount its own principal_type', async () => {
    const idea = await runCli(
      ['product', 'idea', 'comment', 'list', SHIP_IDEA_ID, '--json'],
      [object({ id: SHIP_IDEA_ID, identifier: 'PD-1' }), page([])],
    );
    expect(idea.exit).toBe(0);
    expect(urlOf(idea, 1).searchParams.get('principal_type')).toBe('idea');

    const ticket = await runCli(
      ['product', 'ticket', 'comment', 'list', SHIP_TICKET_ID, '--json'],
      [object({ id: SHIP_TICKET_ID, identifier: 'PD-T1' }), page([])],
    );
    expect(ticket.exit).toBe(0);
    expect(urlOf(ticket, 1).searchParams.get('principal_type')).toBe('ticket');

    const testCase = await runCli(
      ['testhub', 'cases', 'activity', 'list', TEST_CASE_ID, '--json'],
      [object({ id: TEST_CASE_ID, title: 'c' }), page([])],
    );
    expect(testCase.exit).toBe(0);
    expect(urlOf(testCase, 1).searchParams.get('principal_type')).toBe('test_case');

    const run = await runCli(
      ['testhub', 'runs', 'activity', 'list', TEST_RUN_ID, '--json'],
      [object({ id: TEST_RUN_ID }), page([])],
    );
    expect(run.exit).toBe(0);
    expect(urlOf(run, 1).searchParams.get('principal_type')).toBe('test_run');
  });
});
