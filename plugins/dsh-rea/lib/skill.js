/**
 * Skill install: put the upstream `reverse-engineer-anything` pack where this
 * harness discovers skills.
 *
 * Why this exists: `rea setup` writes the skill for the agents REA knows about,
 * and DSH is not on that list. The pack is shipped inside the bundle (verbatim
 * from rea-agents@6.7.0, `skills/reverse-engineer-anything/`) so the install
 * needs no network and no shell: write it once at boot, leave it alone when it
 * is already current, refresh it when the bundle ships a newer version.
 *
 * The pack is additive: one directory, one SKILL.md plus references/. Nothing
 * else in the skills root is read, moved, or deleted.
 *
 * @module dsh-rea/skill
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET_ROOT = fileURLToPath(new URL('../assets/skills/reverse-engineer-anything', import.meta.url));
const SKILL_NAME = 'reverse-engineer-anything';
const MANIFEST = '.dsh-rea.json';

/** Files the pack ships, relative to its root. Discovered from the asset tree. */
async function listPack(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) out.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  await walk(root);
  return out.sort();
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function versionOf(text) {
  return /^\s{0,4}version:\s*["']?([^"'\r\n]+)["']?/m.exec(text ?? '')?.[1]?.trim();
}

/**
 * Install (or refresh) the skill pack.
 *
 * @param {object} options
 * @param {string} options.skillsDir absolute skills root (e.g. `$DSH_HOME/skills`)
 * @param {boolean} [options.force] rewrite every file even when identical
 * @returns {Promise<{ status: 'installed'|'updated'|'current'|'skipped', target: string, version?: string, files: string[], written: string[] }>}
 */
export async function installSkillPack(options) {
  const rootExists = await stat(options.skillsDir).then(() => true).catch(() => false);
  if (!rootExists) {
    // The skills root is created by the host on first use; creating it here keeps
    // the install self-sufficient for a fresh profile.
    await mkdir(options.skillsDir, { recursive: true }).catch(() => {});
  }
  const target = path.join(options.skillsDir, SKILL_NAME);
  const files = await listPack(ASSET_ROOT);
  const bundledSkill = await readFile(path.join(ASSET_ROOT, 'SKILL.md'), 'utf8');
  const bundleVersion = versionOf(bundledSkill);

  const previousManifest = await readIfExists(path.join(target, MANIFEST));
  const hadSkill = (await stat(path.join(target, 'SKILL.md')).catch(() => undefined)) !== undefined;
  const written = [];

  for (const relative of files) {
    const source = await readFile(path.join(ASSET_ROOT, relative));
    const destination = path.join(target, ...relative.split('/'));
    const existing = await readFile(destination).catch(() => undefined);
    if (options.force !== true && existing !== undefined && existing.equals(source)) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
    written.push(relative);
  }

  const manifest = JSON.stringify(
    {
      installer: 'dsh-rea',
      skill: SKILL_NAME,
      source: 'rea-agents/skills/reverse-engineer-anything',
      version: bundleVersion,
      installedAt: new Date().toISOString(),
      files,
    },
    null,
    2,
  );
  if (manifest !== previousManifest) await writeFile(path.join(target, MANIFEST), manifest);

  const status = written.length === 0 ? 'current' : hadSkill ? 'updated' : 'installed';
  return { status, target, version: bundleVersion, files, written };
}

/**
 * Where the installed SKILL.md lives for a given skills root.
 * @param {string} skillsDir
 */
export function skillPath(skillsDir) {
  return path.join(skillsDir, SKILL_NAME, 'SKILL.md');
}

export { SKILL_NAME, ASSET_ROOT };
