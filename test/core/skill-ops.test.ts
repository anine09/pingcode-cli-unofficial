import { describe, expect, it } from 'vitest';
import {
  collectSkillPayload,
  installSkill,
  listSkillStatus,
  readSkillVersion,
  skillSourceDir,
  uninstallSkill,
} from '../../src/core/skill-ops';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeSkillDir(moduleFiles: string[] = []): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-ops-'));
  const skillDir = path.join(dir, 'skills', 'pingcode');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill\nversion: 2.0.0\n');
  const modulesDir = path.join(skillDir, 'modules');
  mkdirSync(modulesDir, { recursive: true });
  for (const f of moduleFiles) {
    writeFileSync(path.join(modulesDir, f), '# module\n');
  }
  return dir;
}

function makeTarget(dir: string, name: string, label: string) {
  return { name, label, dir: path.join(dir, 'agents', name, 'skills', 'pingcode') } as const;
}

describe('skillSourceDir', () => {
  it('returns <root>/skills/pingcode', () => {
    const root = makeSkillDir();
    expect(skillSourceDir(root)).toBe(path.join(root, 'skills', 'pingcode'));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('collectSkillPayload', () => {
  it('returns SKILL.md when no modules', () => {
    const dir = makeSkillDir();
    const payload = collectSkillPayload(skillSourceDir(dir));
    expect(payload).toHaveLength(1);
    expect(payload[0]!.relative).toBe('SKILL.md');
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes sorted .md modules', () => {
    const dir = makeSkillDir(['z-module.md', 'a-module.md']);
    const payload = collectSkillPayload(skillSourceDir(dir));
    expect(payload).toHaveLength(3);
    expect(payload[0]!.relative).toBe('SKILL.md');
    expect(payload[1]!.relative).toBe('modules/a-module.md');
    expect(payload[2]!.relative).toBe('modules/z-module.md');
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips non-markdown files', () => {
    const dir = makeSkillDir(['readme.md', 'skip.txt']);
    const payload = collectSkillPayload(skillSourceDir(dir));
    expect(payload).toHaveLength(2);
    expect(payload[1]!.relative).toBe('modules/readme.md');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('readSkillVersion', () => {
  it('extracts version from frontmatter', () => {
    const dir = makeSkillDir();
    expect(readSkillVersion(skillSourceDir(dir))).toBe('2.0.0');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when SKILL.md missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-ops-'));
    expect(readSkillVersion(path.join(dir, 'nonexistent'))).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('installSkill', () => {
  it('writes all payload files to each target', () => {
    const root = makeSkillDir(['api.md']);
    const target = makeTarget(root, 'opencode', 'OpenCode');
    const results = installSkill(root, [target], false);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === 'written')).toBe(true);
    expect(readdirSync(target.dir).sort()).toEqual(['SKILL.md', 'modules']);
    rmSync(root, { recursive: true, force: true });
  });

  it('skips existing files without force', () => {
    const root = makeSkillDir();
    const target = makeTarget(root, 'opencode', 'OpenCode');
    installSkill(root, [target], false);
    const results = installSkill(root, [target], false);
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('skipped');
    rmSync(root, { recursive: true, force: true });
  });

  it('overwrites with --force', () => {
    const root = makeSkillDir();
    const target = makeTarget(root, 'opencode', 'OpenCode');
    installSkill(root, [target], false);
    const results = installSkill(root, [target], true);
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('overwritten');
    rmSync(root, { recursive: true, force: true });
  });

  it('returns not-found when source skill dir missing', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'skill-ops-'));
    const target = makeTarget(root, 'opencode', 'OpenCode');
    const results = installSkill(root, [target], false);
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('not-found');
    rmSync(root, { recursive: true, force: true });
  });

  it('creates target dir if missing', () => {
    const root = makeSkillDir();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-ops-'));
    const target = makeTarget(dir, 'opencode', 'OpenCode');
    // target.dir does not exist yet
    const results = installSkill(root, [target], false);
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('written');
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('uninstallSkill', () => {
  it('removes skill dir from target', () => {
    const root = makeSkillDir();
    const target = makeTarget(root, 'opencode', 'OpenCode');
    installSkill(root, [target], false);
    const results = uninstallSkill([target]);
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('removed');
    expect(existsSync(target.dir)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('returns not-found when target dir missing', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'skill-ops-'));
    const target = makeTarget(root, 'opencode', 'OpenCode');
    const results = uninstallSkill([target]);
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('not-found');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('listSkillStatus', () => {
  it('reports not-installed for missing dir', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'skill-ops-'));
    const target = makeTarget(root, 'opencode', 'OpenCode');
    const statuses = listSkillStatus([target]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.installed).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports installed with info for existing dir', () => {
    const root = makeSkillDir(['api.md']);
    const target = makeTarget(root, 'opencode', 'OpenCode');
    installSkill(root, [target], false);
    const statuses = listSkillStatus([target]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.installed).toBe(true);
    expect(statuses[0]!.info).toBeDefined();
    expect(statuses[0]!.info!.version).toBe('2.0.0');
    expect(statuses[0]!.info!.fileCount).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports zero files for empty skill dir', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'skill-ops-'));
    const skillDir = path.join(root, 'skills', 'pingcode');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill\n');
    const target = makeTarget(root, 'opencode', 'OpenCode');
    // copy just SKILL.md — need to create target dir (including the trailing
    // "pingcode" leaf) because makeTarget only creates the path object, not
    // the directory on disk.
    mkdirSync(target.dir, { recursive: true });
    const { copyFileSync } = require('node:fs');
    copyFileSync(path.join(skillDir, 'SKILL.md'), path.join(target.dir, 'SKILL.md'));

    const statuses = listSkillStatus([target]);
    expect(statuses[0]!.info!.fileCount).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
