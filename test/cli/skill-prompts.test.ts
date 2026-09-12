import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseTargets, defaultTargetPromptIO } from '../../src/cli/prompts/target-select';
import type { SkillTarget } from '../../src/core/paths';
import type { TargetPromptIO } from '../../src/cli/prompts/target-select';

let root: string;
let savedEnv: NodeJS.ProcessEnv;

/**
 * `detectCurrentAgent` reads the real `process.env`, and a developer machine
 * (or CI runner) is itself inside some agent — so detection tests must start
 * from a blank slate or they assert against whatever happens to be exported.
 */
function cleanEnv(): void {
  process.env = { PATH: process.env['PATH'] };
}

/** A fake prompt surface that records calls and answers from a script. */
function fakeIo(answer: string[] | 'aborted', canPrompt = true): TargetPromptIO & {
  calls: { labels: string[]; defaults: string[] }[];
} {
  const calls: { labels: string[]; defaults: string[] }[] = [];
  return {
    calls,
    canPrompt: () => canPrompt,
    select: async (labels, defaults) => {
      calls.push({ labels: [...labels], defaults: [...defaults] });
      return answer;
    },
  };
}

function target(name: string, label: string, dir: string): SkillTarget {
  return { name, label, dir };
}

/** Build a catalog of three agents, `installed` holding the skill on disk. */
function fixture(installed: string[]): SkillTarget[] {
  const targets = [
    target('claude-code', 'Claude Code (global)', path.join(root, 'claude')),
    target('cursor', 'Cursor (global)', path.join(root, 'cursor')),
    target('opencode', 'OpenCode (global)', path.join(root, 'opencode')),
  ];
  for (const name of installed) {
    const dir = targets.find((t) => t.name === name)!.dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), 'version: 1.0.0\n');
  }
  return targets;
}

describe('chooseTargets', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'skill-prompt-'));
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it('maps the chosen labels back to their targets', async () => {
    const targets = fixture([]);
    const io = fakeIo(['claude-code']);
    const chosen = await chooseTargets(targets, io);

    expect(chosen).toEqual([targets[0]]);
    expect(io.calls[0]!.labels).toEqual([
      'Claude Code (global)',
      'Cursor (global)',
      'OpenCode (global)',
    ]);
  });

  it('passes the option labels through untouched', async () => {
    // The id-for-`(global)` swap belongs to the default IO; `chooseTargets` itself
    // is label-agnostic so a custom IO can render whatever it wants.
    const targets = fixture([]);
    const io = fakeIo([]);
    await chooseTargets(targets, io);

    expect(io.calls[0]!.labels).toEqual(targets.map((t) => t.label));
  });

  it('pre-selects agents that already have the skill installed', async () => {
    cleanEnv();
    const targets = fixture(['cursor']);
    const io = fakeIo([]);
    await chooseTargets(targets, io);

    expect(io.calls[0]!.defaults).toEqual(['cursor']);
  });

  it('pre-selects the agent we appear to be running inside', async () => {
    cleanEnv();
    process.env['CLAUDECODE'] = '1';
    const targets = fixture([]);
    const io = fakeIo([]);
    await chooseTargets(targets, io);

    expect(io.calls[0]!.defaults).toEqual(['claude-code']);
  });

  it('unions installed agents with the detected one', async () => {
    cleanEnv();
    process.env['CLAUDE_CODE'] = '1';
    const targets = fixture(['opencode']);
    const io = fakeIo([]);
    await chooseTargets(targets, io);

    expect(io.calls[0]!.defaults).toEqual(['claude-code', 'opencode']);
  });

  it('pre-selects nothing when neither installed nor detected', async () => {
    cleanEnv();
    const targets = fixture([]);
    const io = fakeIo([]);
    await chooseTargets(targets, io);

    expect(io.calls[0]!.defaults).toEqual([]);
  });

  it('returns null when the user cancels', async () => {
    cleanEnv();
    const io = fakeIo('aborted');
    expect(await chooseTargets(fixture([]), io)).toBeNull();
  });

  it('returns [] when the user confirms an empty selection', async () => {
    // Distinct from a cancel: nothing to write either way, but a different story.
    cleanEnv();
    const io = fakeIo([]);
    expect(await chooseTargets(fixture([]), io)).toEqual([]);
  });

  it('drops names the caller did not put in the catalog', async () => {
    cleanEnv();
    const io = fakeIo(['claude-code', 'not-in-catalog']);
    expect(await chooseTargets(fixture([]), io)).toHaveLength(1);
  });
});

describe('defaultTargetPromptIO', () => {
  /** The TTY half of `canPrompt` — tests must fake it to reach the CI half. */
  function asTty(): () => void {
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    return () => {
      if (original === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', original);
    };
  }

  it('prompts on a TTY outside CI', () => {
    savedEnv = { ...process.env };
    delete process.env['CI'];
    const restore = asTty();
    try {
      expect(defaultTargetPromptIO([]).canPrompt()).toBe(true);
    } finally {
      restore();
      process.env = savedEnv;
    }
  });

  it('never prompts under CI', () => {
    savedEnv = { ...process.env };
    process.env['CI'] = 'true';
    const restore = asTty();
    try {
      expect(defaultTargetPromptIO([]).canPrompt()).toBe(false);
    } finally {
      restore();
      process.env = savedEnv;
    }
  });

  it('treats an empty CI as absent', () => {
    savedEnv = { ...process.env };
    process.env['CI'] = '';
    const restore = asTty();
    try {
      expect(defaultTargetPromptIO([]).canPrompt()).toBe(true);
    } finally {
      restore();
      process.env = savedEnv;
    }
  });

  it('never prompts off a TTY', () => {
    // The test runner's stdout is not a TTY, so no CI stub is needed here.
    expect(defaultTargetPromptIO([]).canPrompt()).toBe(false);
  });
});
