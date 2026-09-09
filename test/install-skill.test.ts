import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Core logic re-implemented inline for unit testing (mirrors source).

type Target = {
  name: string;
  label: string;
  file: string;
};

type Args = {
  dryRun: boolean;
  force: boolean;
  requested: string[] | null;
  error?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, force: false, requested: null };
  const requested: string[] = [];
  let sawTarget = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--target' || arg.startsWith('--target=')) {
      sawTarget = true;
      let value: string | undefined;
      if (arg.startsWith('--target=')) value = arg.slice('--target='.length);
      else { i += 1; value = argv[i]; }
      if (value === undefined || value === '' || value.startsWith('-')) {
        out.error = '--target needs a value';
        break;
      }
      for (const part of value.split(',')) {
        const name = part.trim().toLowerCase();
        if (name !== '') requested.push(name);
      }
    } else if (arg.startsWith('-')) {
      out.error = `unknown option: ${arg}`;
      break;
    } else {
      out.error = `unexpected argument: ${arg}`;
      break;
    }
  }
  if (sawTarget) out.requested = requested;
  return out;
}

function selectTargets(all: Target[], requested: string[]): Target[] | string {
  if (requested.length === 0 || requested.includes('all')) return all;
  const picked: Target[] = [];
  for (const name of requested) {
    const match = all.find((t) => t.name === name);
    if (match === undefined) {
      return `unknown target: ${name} (supported: ${all.map((t) => t.name).join(', ')}, all)`;
    }
    if (!picked.includes(match)) picked.push(match);
  }
  return picked;
}

function existsSync(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

function collectPayload(skillDir: string): { relative: string; source: string }[] {
  const files: { relative: string; source: string }[] = [
    { relative: 'SKILL.md', source: path.join(skillDir, 'SKILL.md') },
  ];
  const modulesDir = path.join(skillDir, 'modules');
  if (!existsSync(modulesDir)) return files;
  for (const entry of readdirSync(modulesDir).sort()) {
    if (!entry.endsWith('.md')) continue;
    files.push({
      relative: path.join('modules', entry),
      source: path.join(modulesDir, entry),
    });
  }
  return files;
}

describe('parseArgs', () => {
  it('no args: defaults', () => {
    const args = parseArgs([]);
    expect(args.dryRun).toBe(false);
    expect(args.force).toBe(false);
    expect(args.requested).toBeNull();
  });

  it('--dry-run sets dryRun', () => {
    const args = parseArgs(['--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('--force sets force', () => {
    const args = parseArgs(['--force']);
    expect(args.force).toBe(true);
  });

  it('--target claude: single target', () => {
    const args = parseArgs(['--target', 'claude']);
    expect(args.requested).toEqual(['claude']);
  });

  it('--target=claude: equals syntax', () => {
    const args = parseArgs(['--target=claude']);
    expect(args.requested).toEqual(['claude']);
  });

  it('--target claude,opencode: comma separated', () => {
    const args = parseArgs(['--target', 'claude,opencode']);
    expect(args.requested).toEqual(['claude', 'opencode']);
  });

  it('--target with spaces around commas', () => {
    const args = parseArgs(['--target', 'claude, opencode']);
    expect(args.requested).toEqual(['claude', 'opencode']);
  });

  it('unknown flag: error', () => {
    const args = parseArgs(['--unknown']);
    expect(args.error).toBe('unknown option: --unknown');
  });

  it('--target with missing value: error', () => {
    const args = parseArgs(['--target']);
    expect(args.error).toBe('--target needs a value');
  });

  it('--target with empty value: error', () => {
    const args = parseArgs(['--target', '']);
    expect(args.error).toBe('--target needs a value');
  });

  it('unexpected positional arg: error', () => {
    const args = parseArgs(['something']);
    expect(args.error).toBe('unexpected argument: something');
  });

  it('combined flags', () => {
    const args = parseArgs(['--target', 'claude', '--dry-run', '--force']);
    expect(args.requested).toEqual(['claude']);
    expect(args.dryRun).toBe(true);
    expect(args.force).toBe(true);
  });
});

describe('selectTargets', () => {
  const allTargets: Target[] = [
    { name: 'claude', label: 'Claude Code (global)', file: '/a' },
    { name: 'opencode', label: 'OpenCode (global)', file: '/b' },
  ];

  it('empty requested returns all', () => {
    expect(selectTargets(allTargets, [])).toBe(allTargets);
  });

  it('"all" returns all', () => {
    expect(selectTargets(allTargets, ['all'])).toBe(allTargets);
  });

  it('single existing target', () => {
    const targets = selectTargets(allTargets, ['claude']) as Target[];
    expect(targets).toHaveLength(1);
    expect(targets[0]!.name).toBe('claude');
  });

  it('multiple targets preserves order', () => {
    const targets = selectTargets(allTargets, ['claude', 'opencode']) as Target[];
    expect(targets).toHaveLength(2);
    expect(targets[0]!.name).toBe('claude');
    expect(targets[1]!.name).toBe('opencode');
  });

  it('unknown target returns error string', () => {
    const result = selectTargets(allTargets, ['unknown']);
    expect(typeof result).toBe('string');
    expect(result).toContain('unknown target: unknown');
  });

  it('duplicate targets are deduplicated', () => {
    const targets = selectTargets(allTargets, ['claude', 'claude']) as Target[];
    expect(targets).toHaveLength(1);
  });
});

describe('collectPayload', () => {
  function makeSkillDir(moduleFiles: string[]): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    writeFileSync(path.join(dir, 'SKILL.md'), '# Skill\n');
    const modulesDir = path.join(dir, 'modules');
    mkdirSync(modulesDir);
    for (const f of moduleFiles) {
      writeFileSync(path.join(modulesDir, f), '#\n');
    }
    return dir;
  }

  it('returns SKILL.md when no modules dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    writeFileSync(path.join(dir, 'SKILL.md'), '# Skill\n');
    const payload = collectPayload(dir);
    expect(payload).toHaveLength(1);
    expect(payload[0]!.relative).toBe('SKILL.md');
  });

  it('includes sorted .md modules', () => {
    const dir = makeSkillDir(['z-module.md', 'a-module.md']);
    const payload = collectPayload(dir);
    expect(payload).toHaveLength(3);
    expect(payload[0]!.relative).toBe('SKILL.md');
    expect(payload[1]!.relative).toBe('modules/a-module.md');
    expect(payload[2]!.relative).toBe('modules/z-module.md');
  });

  it('skips non-markdown files in modules', () => {
    const dir = makeSkillDir(['readme.md', 'skip.txt']);
    const payload = collectPayload(dir);
    expect(payload).toHaveLength(2);
    expect(payload[1]!.relative).toBe('modules/readme.md');
  });
});
