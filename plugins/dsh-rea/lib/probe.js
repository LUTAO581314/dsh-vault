/**
 * Target inspection: turn a path list into "what am I looking at, and which REA
 * line studies it".
 *
 * Read-only and bounded: a few KB per file, a shallow listing per directory,
 * never a recursive walk. The point is to hand the agent a routing decision it
 * would otherwise make by guessing from an extension.
 *
 * @module dsh-rea/probe
 */
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONVERGENCE, matchFamily, pickTools, printableRatio } from './families.js';

const HEAD_BYTES = 8 * 1024;
const DIR_ENTRY_CAP = 60;

/**
 * @typedef {object} Target
 * @property {string} path absolute path that was inspected
 * @property {'file'|'directory'|'missing'} kind
 * @property {number} [bytes] file size, or the size of the directory's top level
 * @property {string} [ext] lowercased extension
 * @property {string} family family id (`unknown` when nothing matched)
 * @property {string} label human name of the family
 * @property {string} basis why this family was chosen
 * @property {string} [guide] REA doc/guide to read before acting
 * @property {string[]} tools existing `rea` tools for this family
 * @property {string[]} next suggested first call(s)
 * @property {string[]} notes caveats worth reading before starting
 */

/**
 * Inspect one path.
 *
 * @param {string} input path as the model gave it (may be relative to `cwd`)
 * @param {{ cwd: string, available: Set<string>, maxBytes: number }} context
 * @returns {Promise<Target>}
 */
export async function probePath(input, context) {
  const absolute = path.isAbsolute(input) ? input : path.resolve(context.cwd, input);
  const base = path.basename(absolute);
  const ext = path.extname(base).toLowerCase();

  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    return {
      path: absolute,
      kind: 'missing',
      ext,
      family: 'unknown',
      label: 'missing path',
      basis: `stat failed: ${error instanceof Error ? error.message : String(error)}`,
      tools: [],
      next: [],
      notes: ['Path does not exist (or is unreadable) from the harness working directory. Check the spelling, or pass an absolute path.'],
    };
  }

  if (info.isDirectory()) return probeDirectory(absolute, base, ext, info, context);

  const handle = await open(absolute, 'r');
  let head;
  try {
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, Math.max(0, info.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const ratio = printableRatio(head);
  const textual = ratio > 0.92 && head.length > 0;
  const text = textual ? head.toString('utf8') : undefined;
  const match = matchFamily(head, base, text);
  const notes = [];

  if (textual) notes.push(`Text-like file (${Math.round(ratio * 100)}% printable) — content, not magic bytes, decided the family.`);
  if (textual && /^0x[0-9a-fA-F]+/.test((text ?? '').trim())) notes.push('Hex string detected: treat as EVM bytecode, not as source code.');
  if (ext === '.asar') notes.push('asar is a generated archive: its header is a JSON index, not a file magic; open it as an Electron bundle rather than as a raw binary.');
  if (ext === '.pck') notes.push('Godot .pck detected by name only — confirm by listing the archive before reconstructing assets.');
  if (match === null && info.size === 0) notes.push('Empty file: nothing to analyze.');
  if (match === null && textual === false) notes.push('No known magic matched: this may be an encrypted, packed, obfuscated, or sliced artifact. Start with entropy/region inspection and record the unknown instead of guessing a family.');

  const family = match ?? { id: 'unknown', label: 'unrecognized', guide: undefined, tools: [] };
  const tools = pickTools(context.available, family.tools);
  const convergence = pickTools(context.available, CONVERGENCE, 4);

  return {
    path: absolute,
    kind: 'file',
    bytes: info.size,
    ext,
    family: family.id,
    label: family.label,
    basis: match === null ? 'no matcher fired' : match.basis,
    guide: family.guide,
    tools,
    next: nextCalls(family.id, absolute, tools, convergence),
    notes,
  };
}

/**
 * Classify a directory by its layout (macOS bundle, exploded APK, Electron app,
 * unpacked firmware, plain folder).
 */
async function probeDirectory(absolute, base, ext, info, context) {
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  const names = entries.slice(0, DIR_ENTRY_CAP).map((entry) => entry.name);
  const has = (needle) => names.some((name) => name.toLowerCase() === needle.toLowerCase());
  const notes = [];
  let family = { id: 'directory', label: 'directory', guide: undefined, tools: ['artifact', 'extract_artifact'] };

  if (has('Info.plist') && (has('MacOS') || ext === '.app')) {
    family = { id: 'apple-app', label: 'macOS .app bundle', guide: 'docs/guides/apple.md', tools: ['macho', 'plist', 'keyed_archive', 'apple_application_graph'] };
    notes.push('Bundle layout confirmed by Info.plist + MacOS/: analyze the Mach-O, plists and asset catalogs separately.');
  } else if (has('AndroidManifest.xml') && (has('classes.dex') || has('smali'))) {
    family = { id: 'android-source', label: 'exploded Android app (dex/smali)', guide: 'guides/android-game-reversing.md', tools: ['android_package', 'android_class', 'android_application_graph'] };
    notes.push('Exploded APK: static analysis works on dex/smali directly; runtime observation needs a device via adb.');
  } else if (has('resources') || has('app.asar')) {
    family = { id: 'electron-app', label: 'Electron application directory', guide: 'guides/electron.md', tools: ['javascript_application', 'electron_fuses', 'recover_javascript_sources'] };
    notes.push('Electron layout: read package.json main, then the asar — the renderer bundle is the part that usually holds the logic.');
  } else if (names.some((name) => /^(squashfs-root|etc|bin|lib|usr)$/i.test(name)) && names.length > 3) {
    family = { id: 'firmware-rootfs', label: 'extracted firmware rootfs', guide: 'guides/firmware-and-devices.md', tools: ['firmware', 'artifact'] };
    notes.push('Extracted rootfs: inventory init scripts and web CGI before decompiling individual binaries.');
  }

  if (entries.length > DIR_ENTRY_CAP) notes.push(`Listed the first ${DIR_ENTRY_CAP} of ${entries.length} entries.`);

  return {
    path: absolute,
    kind: 'directory',
    bytes: entries.length,
    ext,
    family: family.id,
    label: family.label,
    basis: 'directory layout',
    guide: family.guide,
    tools: pickTools(context.available, family.tools),
    next: nextCalls(family.id, absolute, family.tools, pickTools(context.available, CONVERGENCE, 3)),
    notes: [...notes, 'Directory: name the concrete file you want analyzed (binary, asar, dex, plist) rather than the folder.'],
  };
}

/**
 * The first call to make, per family. Every name here is filtered against the
 * live tool set by `pickTools` before it reaches the model.
 */
function nextCalls(familyId, absolute, tools, convergence) {
  const call = (tool) => `${tool}({ path: ${JSON.stringify(absolute)} })`;
  const out = [];
  switch (familyId) {
    case 'native':
    case 'go':
    case 'rust':
      out.push(`binary_session({ path: ${JSON.stringify(absolute)} })`, 'then binary_overview({ session })');
      break;
    case 'dotnet':
      out.push(`inspect_managed_artifact({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'apk':
    case 'android-source':
      out.push(`inspect_android_package({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'flutter-aot':
      out.push(`identify_flutter_build({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'macho':
    case 'apple-app':
      out.push(`inspect_macho({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'javascript':
    case 'electron-app':
      out.push(`analyze_javascript_application({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'pcap':
      out.push(`inspect_pcap_capture({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'web-capture':
    case 'saz':
      out.push(`inspect_web_network_capture({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'sqlite':
      out.push(`inspect_sqlite_database({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'wasm':
      out.push(`inspect_wasm_artifact({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'evm':
      out.push(`inspect_evm_interface({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'firmware':
    case 'firmware-rootfs':
      out.push(`inspect_firmware_regions({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'plist':
      out.push(`inspect_plist({ path: ${JSON.stringify(absolute)} })`);
      break;
    case 'archive':
    case 'office-zip':
    case 'ipa':
      out.push(`inspect_artifact({ path: ${JSON.stringify(absolute)} })`, 'then extract what matters and re-probe the extracted files');
      break;
    default:
      out.push(`inspect_artifact({ path: ${JSON.stringify(absolute)} }) to see the container layout`);
  }
  for (const tool of tools.slice(0, 1)) {
    const line = call(tool);
    if (!out.some((existing) => existing.startsWith(tool))) out.push(line);
  }
  if (convergence.length > 0) out.push(`before wrapping up: ${convergence.join(', ')}`);
  return out;
}

/**
 * Probe a batch of paths. Failures are per-target, never fatal.
 *
 * @param {string[]} paths
 * @param {{ cwd: string, available: Set<string>, maxBytes?: number }} context
 * @returns {Promise<{ targets: Target[], families: string[] }>}
 */
export async function probeTargets(paths, context) {
  const targets = [];
  for (const target of paths) {
    targets.push(await probePath(target, context));
  }
  const families = [...new Set(targets.map((target) => target.family))];
  return { targets, families };
}
