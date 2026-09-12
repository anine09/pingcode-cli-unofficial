/**
 * Skill file operations (design D10).
 *
 * All file-system work lives here because the `cli/` layer is forbidden
 * from importing `node:fs` directly. The command layer stays thin: it
 * parses flags, calls these functions, and renders.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { SkillTarget } from './paths';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface SkillInfo {
  name: string;
  version: string;
  fileCount: number;
  sizeBytes: number;
}

export interface SkillStatus {
  target: SkillTarget;
  installed: boolean;
  info?: SkillInfo;
}

export interface InstallResult {
  target: string;
  action: 'written' | 'overwritten' | 'skipped' | 'removed' | 'not-found';
  path?: string;
}

// ---------------------------------------------------------------------------
// payload collection
// ---------------------------------------------------------------------------

const SKILL_DIR_NAME = 'pingcode';
const MODULES_DIR_NAME = 'modules';
const SKILL_MD = 'SKILL.md';

export function skillSourceDir(sourceRoot: string): string {
  return path.join(sourceRoot, 'skills', SKILL_DIR_NAME);
}

export interface SkillPayload {
  relative: string;
  source: string;
}

export function collectSkillPayload(skillDir: string): SkillPayload[] {
  const files: SkillPayload[] = [
    { relative: SKILL_MD, source: path.join(skillDir, SKILL_MD) },
  ];
  const modulesDir = path.join(skillDir, MODULES_DIR_NAME);
  if (!existsSync(modulesDir)) return files;
  for (const entry of readdirSync(modulesDir).sort()) {
    if (!entry.endsWith('.md')) continue;
    files.push({
      relative: path.join(MODULES_DIR_NAME, entry),
      source: path.join(modulesDir, entry),
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// version extraction
// ---------------------------------------------------------------------------

export function readSkillVersion(skillDir: string): string | undefined {
  const mdPath = path.join(skillDir, SKILL_MD);
  try {
    const content = readFileSync(mdPath, 'utf8');
    const match = content.match(/^version:\s*(.+)$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// install / uninstall / update
// ---------------------------------------------------------------------------

/**
 * Group targets that resolve to the same directory, preserving first-seen order.
 *
 * Several agents share a global skill dir — `codex`, `cline`, `universal` and
 * `warp` all read `~/.agents/skills` — so 48 agents collapse to 43 directories
 * and the payload is written once per directory instead of once per agent.
 */
function groupByDir(targets: SkillTarget[]): Map<string, SkillTarget[]> {
  const groups = new Map<string, SkillTarget[]>();
  for (const target of targets) {
    const group = groups.get(target.dir);
    if (group === undefined) groups.set(target.dir, [target]);
    else group.push(target);
  }
  return groups;
}

/** Label for a directory group. A lone agent keeps its plain, unchanged label. */
function groupLabel(group: SkillTarget[]): string {
  return group.map((target) => target.label).join(', ');
}

export function installSkill(
  sourceRoot: string,
  targets: SkillTarget[],
  force = false,
  dryRun = false,
): InstallResult[] {
  const skillDir = skillSourceDir(sourceRoot);
  if (!existsSync(skillDir)) {
    return targets.map((t) => ({ target: t.label, action: 'not-found' }));
  }

  const payload = collectSkillPayload(skillDir);
  const results: InstallResult[] = [];

  for (const [dir, group] of groupByDir(targets)) {
    const label = groupLabel(group);
    if (!existsSync(dir) && !dryRun) {
      mkdirSync(dir, { recursive: true });
    }

    for (const file of payload) {
      const dest = path.join(dir, file.relative);
      const exists = existsSync(dest);

      if (exists && !force) {
        results.push({ target: label, action: 'skipped', path: dest });
        continue;
      }

      // Dry-run still reports the action, it just never touches the disk.
      if (!dryRun) {
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(file.source, dest);
      }
      results.push({
        target: label,
        action: exists ? 'overwritten' : 'written',
        path: dest,
      });
    }
  }

  return results;
}

export function uninstallSkill(
  targets: SkillTarget[],
  dryRun = false,
): InstallResult[] {
  const results: InstallResult[] = [];

  for (const [dir, group] of groupByDir(targets)) {
    if (!existsSync(dir)) {
      results.push({ target: groupLabel(group), action: 'not-found' });
      continue;
    }

    if (!dryRun) rmSync(dir, { recursive: true, force: true });
    results.push({ target: groupLabel(group), action: 'removed', path: dir });
  }

  return results;
}

// ---------------------------------------------------------------------------
// list / status
// ---------------------------------------------------------------------------

export function listSkillStatus(
  targets: SkillTarget[],
): SkillStatus[] {
  return targets.map((target) => {
    if (!existsSync(target.dir)) {
      return { target, installed: false };
    }

    const info = buildSkillInfo(target.dir);
    return { target, installed: true, info };
  });
}

function buildSkillInfo(dir: string): SkillInfo {
  let fileCount = 0;
  let sizeBytes = 0;

  function walk(dirPath: string): void {
    for (const entry of readdirSync(dirPath)) {
      const full = path.join(dirPath, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else {
        fileCount += 1;
        sizeBytes += st.size;
      }
    }
  }

  walk(dir);

  const version = readSkillVersion(dir) ?? 'unknown';

  return { name: SKILL_DIR_NAME, version, fileCount, sizeBytes };
}
