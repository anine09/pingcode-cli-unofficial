import { readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program';

/**
 * Gate G4 (design §9, implement.md S7):
 *  - `--help` snapshots for the root and every command group, so CLI drift is
 *    caught directly rather than by parsing prose;
 *  - every `pingcode <group> <sub>` **command path** mentioned in `SKILL.md`
 *    resolves in the commander tree. Flag-level parsing of the markdown is
 *    deliberately not attempted.
 */

const skillPath = fileURLToPath(new URL('../skills/pingcode/SKILL.md', import.meta.url));

function group(program: Command, name: string): Command {
  const found = program.commands.find((command) => command.name() === name);
  if (found === undefined) throw new Error(`command group "${name}" is not registered`);
  return found;
}

function leafPaths(command: Command, prefix: string[] = []): string[][] {
  const own = [...prefix, command.name()];
  const children = command.commands.filter((child) => child.name() !== 'help');
  if (children.length === 0) return [own];
  return children.flatMap((child) => leafPaths(child, own));
}

describe('command surface', () => {
  const program = buildProgram();

  it('registers the five command groups', () => {
    expect(program.commands.map((command) => command.name()).filter((n) => n !== 'help')).toEqual([
      'auth',
      'product',
      'project',
      'testhub',
      'settings',
    ]);
  });

  it('registers every subcommand and nothing else', () => {
    const paths = program.commands
      .filter((command) => command.name() !== 'help')
      .flatMap((command) => leafPaths(command))
      .map((parts) => parts.join(' '));
    expect(paths).toEqual([
      'auth login',
      'auth status',
      'auth logout',
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
      'project list',
      'project get',
      'project work-item list',
      'project work-item get',
      'project work-item create',
      'project work-item update',
      'project work-item transition',
      'project meta types',
      'project meta states',
      'project meta priorities',
      'project meta sprints',
      'testhub libraries list',
      'testhub libraries get',
      'testhub cases list',
      'testhub cases get',
      'testhub cases create',
      'testhub cases update',
      'testhub plans list',
      'testhub plans get',
      'testhub runs list',
      'testhub runs patch',
      'testhub runs bulk',
      'testhub meta case-states',
      'testhub meta case-types',
      'testhub meta important-levels',
      'testhub meta run-statuses',
      'settings users',
    ]);
  });

  it('accepts the global flags after the subcommand too', () => {
    // commander binds an option to the command it follows, so each leaf repeats
    // the global flags (hidden from its own help).
    for (const parts of program.commands
      .filter((command) => command.name() !== 'help')
      .flatMap((command) => leafPaths(command))) {
      let cursor: Command = program;
      for (const part of parts) cursor = group(cursor, part);
      const flags = cursor.options.map((option) => option.long);
      expect(flags, parts.join(' ')).toEqual(
        expect.arrayContaining(['--host', '--json', '--dry-run', '--no-cache', '--verbose']),
      );
    }
  });

  it('never binds -v (it would collide with --version/--verbose)', () => {
    expect(program.options.map((option) => option.short)).not.toContain('-v');
  });
});

describe('--help snapshots', () => {
  const program = buildProgram();

  it('root', () => {
    expect(program.helpInformation()).toMatchSnapshot();
  });

  for (const name of ['auth', 'product', 'project', 'testhub', 'settings']) {
    it(name, () => {
      expect(group(program, name).helpInformation()).toMatchSnapshot();
    });
  }

  // The resource subgroups and the three `meta` subgroups are one level down now,
  // so they need their own snapshots — the parent group help only lists them.
  for (const [parent, child] of [
    ['product', 'idea'],
    ['product', 'ticket'],
    ['product', 'meta'],
    ['project', 'work-item'],
    ['project', 'meta'],
    ['testhub', 'libraries'],
    ['testhub', 'cases'],
    ['testhub', 'plans'],
    ['testhub', 'runs'],
    ['testhub', 'meta'],
  ] as const) {
    it(`${parent} ${child}`, () => {
      expect(group(group(program, parent), child).helpInformation()).toMatchSnapshot();
    });
  }

  it('project work-item update (the widest flag set)', () => {
    expect(
      group(group(group(program, 'project'), 'work-item'), 'update').helpInformation(),
    ).toMatchSnapshot();
  });

  it('project work-item transition (--type is a lookup aid, not a patched field)', () => {
    expect(
      group(group(group(program, 'project'), 'work-item'), 'transition').helpInformation(),
    ).toMatchSnapshot();
  });

  it('product idea list (the search filter surface)', () => {
    expect(
      group(group(group(program, 'product'), 'idea'), 'list').helpInformation(),
    ).toMatchSnapshot();
  });

  it('product idea update (no --type: ship states are product-scoped)', () => {
    expect(
      group(group(group(program, 'product'), 'idea'), 'update').helpInformation(),
    ).toMatchSnapshot();
  });

  it('product ticket create (--type is required by the API)', () => {
    expect(
      group(group(group(program, 'product'), 'ticket'), 'create').helpInformation(),
    ).toMatchSnapshot();
  });

  it('product ticket transition (advisory: the server decides)', () => {
    expect(
      group(group(group(program, 'product'), 'ticket'), 'transition').helpInformation(),
    ).toMatchSnapshot();
  });
});

describe('SKILL.md agrees with the CLI (R4.5)', () => {
  const program = buildProgram();
  const skill = readFileSync(skillPath, 'utf8');

  it('exists, is frontmatter-tagged and names itself pingcode', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toMatch(/^name: pingcode$/m);
  });

  it('documents the auth gate, the json contract and the sharp edges', () => {
    expect(skill).toContain('凭据管理');
    expect(skill).toContain('pcp:read:pjm:project');
    expect(skill).toContain('pcp:read:pjm:workitem');
    expect(skill).toContain('pcp:write:pjm:workitem');
    expect(skill).toContain('pcp:read:global:team');
    expect(skill).toContain('--json');
    expect(skill).toContain('--dry-run');
    expect(skill).toMatch(/replaces, it does not merge/i);
    expect(skill).toMatch(/best effort/i);
    expect(skill).toMatch(/no endpoint supports sorting/i);
    expect(skill).toMatch(/200 requests per minute/i);
    // every exit code has a row
    for (const exit of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(skill).toContain(`| ${exit} |`);
    }
  });

  it('names every ship scope the commands need (Gate G4)', () => {
    for (const scope of [
      'pcp:read:ship:product',
      'pcp:read:ship:idea',
      'pcp:write:ship:idea',
      'pcp:read:ship:ticket',
      'pcp:write:ship:ticket',
      'pcp:read:ship:configuration',
    ]) {
      expect(skill, scope).toContain(scope);
    }
  });

  it('states the idea-vs-ticket transition asymmetry explicitly (Gate G4)', () => {
    // Since S7b the asymmetry is about *explanation*, not enforcement — and the
    // most dangerous thing an agent could now believe is that an illegal ticket
    // transition fails locally with exit 2. It does not; the server decides.
    expect(skill).toMatch(/no state change is refused locally/i);
    expect(skill).toMatch(/does \*\*not\*\* refuse a transition/i);
    expect(skill).toMatch(/expect the server's exit code, not exit 2/i);
    // the ticket half: a refusal is explained, and --dry-run previews it
    expect(skill).toMatch(/reachable from the current one/i);
    expect(skill).toMatch(/--dry-run.{0,120}reachable set/is);
    // the idea half: no flow endpoint exists at all, so no reachable set ever
    expect(skill).toMatch(/no\s+idea\s+state-flow\s+endpoint/i);
    expect(skill).toMatch(/idea\s+update\s+--state/);
    // and the one surviving local refusal, so it is not a surprise
    expect(skill).toMatch(/state it is already in/i);
  });

  it('states the ship rules that have no pjm equivalent (Gate G4)', () => {
    expect(skill).toMatch(/product-scoped/i);
    expect(skill).toMatch(/product meta members/);
    expect(skill).toMatch(/option.{0,20}_id|option ids/i);
    expect(skill).toMatch(/nothing\s+in\s+ship\s+can\s+be\s+deleted/i);
    // `--type` means something different on each module
    expect(skill).toMatch(/no\s+`--type`\s+(on|anywhere\s+on)\s+`idea`/i);
  });

  it('names every testhub scope the commands need (Gate G3)', () => {
    for (const scope of [
      'pcp:read:testhub:library',
      'pcp:read:testhub:testcase',
      'pcp:write:testhub:testcase',
      'pcp:read:testhub:testplan',
      'pcp:write:testhub:testplan',
      'pcp:read:testhub:configuration',
    ]) {
      expect(skill, scope).toContain(scope);
    }
  });

  it('states the testhub rules that only prose can carry (Gate G3)', () => {
    // Each of these is either invisible in `--help` or a silent data loss, so a
    // snapshot of the help text is not enough documentation on its own. The
    // patterns tolerate the markdown's line wrapping.
    expect(skill).toMatch(/library-scoped/i);
    expect(skill).toMatch(/never\s+share\s+a\s+state,\s+type\s+or\s+status\s+id/i);
    expect(skill).toMatch(/all-or-nothing/i);
    expect(skill).toMatch(/`?status_id`?\s+is\s+required\s+by\s+the\s+API\s+even\s+on\s+PATCH/i);
    expect(skill).toMatch(/stays\s+unassigned/i);
    expect(skill).toMatch(/only\s+way\s+to\s+delete\s+a\s+run/i);
    expect(skill).toMatch(/cannot\s+filter\s+by\s+library/i);
    expect(skill).toMatch(/important-levels`?\s+takes\s+no\s+`?--library/i);
    expect(skill).toMatch(/cannot\s+write\s+a\s+run\s+at\s+all/i);
    expect(skill).toMatch(/test_library_id/);
    expect(skill).toMatch(/`?short_id`?\s+is\s+read-only/i);
    expect(skill).toMatch(/no\s+`?--maintenance`?\s+flag/i);
    expect(skill).toMatch(/no\s+discovery\s+command|no\s+property-lookup\s+command/i);
  });

  it('no longer tells the agent that ship is out of scope', () => {
    // The frontmatter used to list "Ship products/ideas/tickets" as a do-not-use,
    // which would have suppressed the whole new surface.
    const frontmatter = skill.slice(0, skill.indexOf('\n---', 4));
    expect(frontmatter).not.toMatch(/Do NOT use[^]*Ship products/i);
    expect(frontmatter).toMatch(/产品管理|ship/i);
  });

  it('mentions no command path that the CLI does not have', () => {
    const mentioned = new Set<string>();
    // Same line only: a command path never wraps, and `\s` would swallow the
    // frontmatter's `name: pingcode` into the next key.
    const re = /pingcode((?:[ \t]+[a-z][a-z0-9-]*)+)/g;
    for (let match = re.exec(skill); match !== null; match = re.exec(skill)) {
      const tokens = (match[1] ?? '').trim().split(/\s+/).filter((token) => token !== '');
      if (tokens.length === 0) continue;
      mentioned.add(tokens.slice(0, 2).join(' '));
    }

    expect(mentioned.size).toBeGreaterThan(8);

    const missing: string[] = [];
    for (const entry of mentioned) {
      const [first, second] = entry.split(' ');
      if (first === undefined) continue;
      const top = program.commands.find((command) => command.name() === first);
      if (top === undefined) {
        missing.push(`pingcode ${entry}`);
        continue;
      }
      // Only check as deep as the tree actually goes; args are not commands.
      if (top.commands.length === 0 || second === undefined) continue;
      if (!top.commands.some((command) => command.name() === second)) {
        missing.push(`pingcode ${entry}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('mentions every command path the CLI offers', () => {
    for (const parts of program.commands
      .filter((command) => command.name() !== 'help')
      .flatMap((command) => leafPaths(command))) {
      expect(skill, parts.join(' ')).toContain(`pingcode ${parts.join(' ')}`);
    }
  });
});

describe('install-skill script', () => {
  it('is wired to the npm script and imports nothing local', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['skill:install']).toContain('scripts/install-skill.ts');

    const script = readFileSync(
      fileURLToPath(new URL('../scripts/install-skill.ts', import.meta.url)),
      'utf8',
    );
    // `node --experimental-strip-types` cannot resolve a TS import graph.
    const imports = [...script.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.every((specifier) => specifier?.startsWith('node:'))).toBe(true);
    expect(script).toContain("'skills'");
    expect(script).toContain("'SKILL.md'");
    // Both destinations are global (user-level); a project-local install is not offered.
    expect(script).toContain("'.claude', 'skills', 'pingcode'");
    expect(script).toContain("'.config', 'opencode'");
    expect(script).not.toContain('process.cwd()');
    expect(script).toContain('--dry-run');
  });
});
