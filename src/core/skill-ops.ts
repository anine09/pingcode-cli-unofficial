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

export function installSkill(
  sourceRoot: string,
  targets: SkillTarget[],
  force = false,
): InstallResult[] {
  const skillDir = skillSourceDir(sourceRoot);
  if (!existsSync(skillDir)) {
    return targets.map((t) => ({ target: t.label, action: 'not-found' }));
  }

  const payload = collectSkillPayload(skillDir);
  const results: InstallResult[] = [];

  for (const target of targets) {
    const targetDir = target.dir;
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    for (const file of payload) {
      const dest = path.join(targetDir, file.relative);
      const exists = existsSync(dest);

      if (exists && !force) {
        results.push({ target: target.label, action: 'skipped', path: dest });
        continue;
      }

      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(file.source, dest);
      results.push({
        target: target.label,
        action: exists ? 'overwritten' : 'written',
        path: dest,
      });
    }
  }

  return results;
}

export function uninstallSkill(
  targets: SkillTarget[],
): InstallResult[] {
  const results: InstallResult[] = [];

  for (const target of targets) {
    if (!existsSync(target.dir)) {
      results.push({ target: target.label, action: 'not-found' });
      continue;
    }

    rmSync(target.dir, { recursive: true, force: true });
    results.push({ target: target.label, action: 'removed', path: target.dir });
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
