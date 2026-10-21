/**
 * Readiness: does this machine have what a given analysis needs?
 *
 * REA itself is one `npx` away, but its real work is delegated depth — Ghidra,
 * Hopper, IDA, JADX, apktool, adb, tshark, binwalk — and the failure mode without
 * those is a session that opens, then produces `unsupported`/`limitation` output
 * the model misreads as "the answer is no such function". So: check first, say
 * what is missing, and let the agent pick a family it can actually finish.
 *
 * Everything here is read-only: version flags, PATH lookups, one `adb devices`.
 *
 * @module dsh-rea/doctor
 */
import { stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FAMILIES, pickTools } from './families.js';
import { IS_WIN, findOnPath, firstExisting, run } from './exec.js';

/** Families a `rea_doctor` report tracks coverage for. */
const COVERAGE = [
  'native',
  'dotnet',
  'javascript',
  'apk',
  'flutter-aot',
  'macho',
  'pcap',
  'web-capture',
  'sqlite',
  'wasm',
  'firmware',
];

/**
 * External depth tools, grouped by what they unlock.
 * `paths` are absolute candidates tried before PATH lookup.
 */
const EXTERNALS = [
  {
    id: 'ghidra',
    group: 'decompiler',
    label: 'Ghidra',
    unlocks: 'native PE/ELF/Mach-O session analysis (REA delegates most of its depth here)',
    bins: ['analyzeHeadless', 'ghidraRun', 'analyzeHeadless.bat'],
    paths: () => [process.env.GHIDRA_HOME && path.join(process.env.GHIDRA_HOME, 'support', 'analyzeHeadless'), process.env.GHIDRA_HOME && path.join(process.env.GHIDRA_HOME, 'support', 'analyzeHeadless.bat')],
    hint: 'Install Ghidra and set GHIDRA_HOME, or put analyzeHeadless on PATH.',
    version: ['-version'],
  },
  {
    id: 'hopper',
    group: 'decompiler',
    label: 'Hopper',
    unlocks: 'fast Mach-O / native navigation on macOS',
    bins: ['hopper', 'Hopper'],
    paths: () => ['/Applications/Hopper Disassembler.app/Contents/MacOS/hopper'],
    hint: 'macOS only. Not required when Ghidra is present.',
    platforms: ['darwin'],
  },
  {
    id: 'ida',
    group: 'decompiler',
    label: 'IDA Pro',
    unlocks: 'decompilation when the user already holds a licence',
    bins: ['idat64', 'idat', 'idat64.exe', 'idat.exe'],
    paths: () => ['C:\\Program Files\\IDA Professional 9.0\\idat64.exe', 'C:\\Program Files\\IDA Pro 8.4\\idat64.exe'],
    hint: 'Optional — REA works without IDA. Licence and install are the user’s business; never fetch or patch it.',
    version: ['-v'],
  },
  {
    id: 'rizin',
    group: 'decompiler',
    label: 'rizin / radare2',
    unlocks: 'cheap triage (strings, xrefs, structure) without a full decompiler',
    bins: ['rizin', 'rz-bin', 'radare2', 'r2'],
    paths: () => [],
    hint: 'Install rizin (or radare2) for triage when no decompiler is available.',
    version: ['-v'],
  },
  {
    id: 'objdump',
    group: 'decompiler',
    label: 'binutils objdump',
    unlocks: 'minimal disassembly / section listing',
    bins: ['objdump', 'llvm-objdump'],
    paths: () => [],
    hint: 'Usually present with a toolchain (mingw / llvm / build-essential).',
    version: ['--version'],
  },
  {
    id: 'jadx',
    group: 'android',
    label: 'JADX',
    unlocks: 'DEX → Java decompilation for APK work',
    bins: ['jadx', 'jadx.bat'],
    paths: () => ['C:\\Program Files\\jadx\\bin\\jadx.bat'],
    hint: 'Install jadx; REA also has its own DEX readers, so this is depth rather than a prerequisite.',
    version: ['--version'],
  },
  {
    id: 'apktool',
    group: 'android',
    label: 'apktool',
    unlocks: 'resource + manifest decoding, rebuildable smali trees',
    bins: ['apktool', 'apktool.bat'],
    paths: () => [],
    hint: 'Install apktool for resource-level APK work.',
    version: ['--version'],
  },
  {
    id: 'adb',
    group: 'android',
    label: 'adb (Android platform-tools)',
    unlocks: 'runtime observation: logcat, package inspection, screen capture',
    bins: ['adb', 'adb.exe'],
    paths: () => [process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', IS_WIN ? 'adb.exe' : 'adb'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe')],
    hint: 'Install platform-tools and put adb on PATH. Without it, APK analysis stays static.',
    version: ['version'],
    devices: true,
  },
  {
    id: 'tshark',
    group: 'network',
    label: 'tshark (Wireshark CLI)',
    unlocks: 'field-level packet decoding for pcap work',
    bins: ['tshark', 'tshark.exe'],
    paths: () => ['C:\\Program Files\\Wireshark\\tshark.exe'],
    hint: 'Install Wireshark; REA reads captures itself, tshark adds protocol depth.',
    version: ['-v'],
  },
  {
    id: 'binwalk',
    group: 'firmware',
    label: 'binwalk',
    unlocks: 'firmware region carving and signature scanning',
    bins: ['binwalk'],
    paths: () => [],
    hint: 'Install binwalk (or unblob) for firmware images.',
    version: ['--help'],
  },
  {
    id: 'unblob',
    group: 'firmware',
    label: 'unblob',
    unlocks: 'modern firmware extraction (more formats than binwalk)',
    bins: ['unblob'],
    paths: () => [],
    hint: 'Optional alternative to binwalk.',
  },
  {
    id: 'wasm-objdump',
    group: 'wasm',
    label: 'wabt (wasm-objdump)',
    unlocks: 'section-level WASM inspection',
    bins: ['wasm-objdump'],
    paths: () => [],
    hint: 'Install wabt for hand-level WASM checks.',
  },
  {
    id: 'python',
    group: 'scripting',
    label: 'Python',
    unlocks: 'glue scripts, pwntools-driven verification',
    bins: ['python', 'python3', 'py'],
    paths: () => [],
    hint: 'A Python 3 on PATH is enough; REA does not require it.',
    version: ['--version'],
  },
];

/** REA's own engine constraint, mirrored so the report can be trusted offline. */
const NODE_RANGE = { min22: [22, 19, 0], min24: [24, 11, 0], min26: [26, 0, 0] };

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function gte(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return true;
    if (a[index] < b[index]) return false;
  }
  return true;
}

function nodeSupported(version) {
  const [major] = version;
  if (major === 22) return gte(version, NODE_RANGE.min22);
  if (major === 23) return false;
  if (major === 24) return gte(version, NODE_RANGE.min24);
  if (major === 25) return false;
  return gte(version, NODE_RANGE.min26);
}

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the version line out of the installed skill's frontmatter.
 * @param {string} file
 */
async function skillInfo(file) {
  try {
    const text = await readFile(file, 'utf8');
    // Frontmatter only: the body reuses words like "version" in prose.
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? text.slice(0, 2000);
    const pick = (key) => new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '');
    const version = pick('version');
    const name = pick('name');
    return { present: true, file, name, version, bytes: Buffer.byteLength(text) };
  } catch {
    return { present: false, file };
  }
}

/**
 * Collect the readiness report.
 *
 * @param {object} options
 * @param {string[]} options.toolNames every tool name visible to the caller (global scope)
 * @param {string} options.serverName MCP server name (default `rea`)
 * @param {string} options.skillPath absolute path of the installed SKILL.md
 * @param {number} [options.timeoutMs] per-check timeout
 * @returns {Promise<object>} report
 */
export async function collectReadiness(options) {
  const timeoutMs = options.timeoutMs ?? 4000;
  const serverName = options.serverName ?? 'rea';
  const prefix = `mcp__${serverName}__`;
  const reaTools = (options.toolNames ?? []).filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));

  const checks = [];
  const push = (check) => checks.push(check);

  // ── runtime ───────────────────────────────────────────────────────────────
  const nodeVersion = parseVersion(process.versions.node) ?? [0, 0, 0];
  push({
    id: 'node',
    group: 'runtime',
    label: `Node ${process.versions.node} on ${process.platform}/${process.arch}`,
    ok: nodeSupported(nodeVersion),
    detail: nodeSupported(nodeVersion) ? 'satisfies rea-agents engines (^22.19 || ^24.11 || >=26)' : 'outside rea-agents engines (^22.19 || ^24.11 || >=26) — npx will refuse to run the server',
    hint: 'Install a supported Node (LTS 24.11+ or 26+) and restart the harness.',
  });

  // ── MCP surface ───────────────────────────────────────────────────────────
  push({
    id: 'mcp-rea',
    group: 'mcp',
    label: `rea MCP tools visible: ${reaTools.length}`,
    ok: reaTools.length > 0,
    detail:
      reaTools.length > 0
        ? 'tool names are prefixed mcp__' + serverName + '__ in this profile'
        : `no ${prefix}* tools registered — the mcp-rea row is disabled, failed to start, or still downloading the package`,
    hint: `Check the \`mcp-${serverName}\` row in the profile patch, then rerun \`npx -y rea-agents@latest mcp\` in a terminal to see the startup error.`,
  });

  // ── skill ─────────────────────────────────────────────────────────────────
  const skill = await skillInfo(options.skillPath);
  push({
    id: 'skill',
    group: 'skill',
    label: skill.present ? `skill installed: reverse-engineer-anything (v${skill.version ?? 'unknown'})` : 'skill not installed',
    ok: skill.present,
    detail: skill.present ? `upstream playbook available at ${skill.file}` : `expected at ${options.skillPath} — the bundle installs it at boot when installSkill is on`,
    hint: 'Skill carries the upstream decision trees (which artifact type, which depth, how to write findings).',
  });

  // ── REA CLI itself ────────────────────────────────────────────────────────
  const cli = await findOnPath(IS_WIN ? 'rea.cmd' : 'rea');
  const cliAlt = cli ?? (await findOnPath('rea'));
  const npx = await findOnPath(IS_WIN ? 'npx.cmd' : 'npx');
  push({
    id: 'npx',
    group: 'mcp',
    label: npx === undefined ? 'npx missing' : `npx: ${npx}`,
    ok: npx !== undefined,
    detail: 'the MCP row launches the server through npx',
    hint: 'npx ships with Node; if it is missing, the Node install is incomplete.',
  });
  push({
    id: 'rea-cli',
    group: 'mcp',
    label: cliAlt === undefined ? 'rea CLI: optional, not installed globally' : `rea CLI: ${cliAlt}`,
    ok: true,
    optional: cliAlt === undefined,
    detail:
      cliAlt === undefined
        ? 'not needed — the MCP row runs the package through npx. Install with `npm i -g rea-agents` only if you want `rea setup` / `rea doctor` in a terminal.'
        : 'installed globally; `rea doctor` runs REA’s own readiness report.',
    hint: 'Optional convenience, not a prerequisite.',
  });
  if (cliAlt !== undefined) {
    const version = await run(cliAlt, ['--version'], { timeoutMs });
    if (version.ok && version.stdout !== '') push({ id: 'rea-version', group: 'mcp', label: `rea --version → ${version.stdout.split(/\r?\n/)[0]}`, ok: true, detail: version.stdout });
  }

  // ── external depth tools ──────────────────────────────────────────────────
  for (const external of EXTERNALS) {
    if (external.platforms !== undefined && !external.platforms.includes(process.platform)) {
      push({
        id: external.id,
        group: external.group,
        label: `${external.label}: not applicable on ${process.platform}`,
        ok: true,
        optional: true,
        detail: external.hint,
      });
      continue;
    }
    const fromPath = await Promise.all((external.bins ?? []).map((bin) => findOnPath(bin)));
    const found = fromPath.find((candidate) => candidate !== undefined) ?? (await firstExisting(external.paths?.() ?? [], exists));
    let detail = external.unlocks;
    let devices;
    if (found !== undefined && external.version !== undefined) {
      const version = await run(found, external.version, { timeoutMs });
      const line = (version.stdout !== '' ? version.stdout : version.stderr).split(/\r?\n/).find((text) => text.trim() !== '');
      if (line !== undefined) detail = `${external.unlocks} — ${line.trim().slice(0, 120)}`;
    }
    if (found !== undefined && external.devices === true) {
      const listing = await run(found, ['devices', '-l'], { timeoutMs });
      const attached = listing.ok ? listing.stdout.split(/\r?\n/).filter((line) => /\bdevice\b/.test(line) && !/List of devices/.test(line)).length : 0;
      devices = attached;
      detail = `${detail} — ${attached} device${attached === 1 ? '' : 's'} attached`;
    }
    push({
      id: external.id,
      group: external.group,
      label: `${external.label}: ${found ?? 'not found'}`,
      ok: found !== undefined,
      optional: external.id !== 'ghidra',
      detail,
      devices,
      hint: found === undefined ? external.hint : undefined,
    });
  }

  // ── environment overrides ─────────────────────────────────────────────────
  const overrides = Object.entries(process.env)
    .filter(([key]) => key.startsWith('REA_'))
    .map(([key, value]) => `${key}=${value}`);
  push({
    id: 'env',
    group: 'mcp',
    label: overrides.length > 0 ? `REA_* overrides: ${overrides.length}` : 'no REA_* overrides',
    ok: true,
    optional: true,
    detail: overrides.length > 0 ? overrides.join(', ') : 'defaults in use (schema profiles, response caps and timeouts are tunable via REA_* variables on the mcp row)',
  });

  // ── per-family coverage ───────────────────────────────────────────────────
  const coverage = COVERAGE.map((familyId) => {
    const family = FAMILIES.find((entry) => entry.id === familyId);
    const tools = pickTools(reaTools, family?.tools ?? [], 4);
    return { family: familyId, label: family?.label ?? familyId, tools, covered: tools.length > 0 };
  });
  for (const row of coverage) {
    const unobservable = reaTools.length === 0;
    push({
      id: `family:${row.family}`,
      group: 'coverage',
      label: `${row.label}: ${unobservable ? 'unknown (no rea tools visible)' : row.covered ? `${row.tools.length} tool(s)` : 'no tool visible'}`,
      ok: unobservable ? true : row.covered,
      optional: unobservable,
      detail: unobservable
        ? 'coverage cannot be measured without a tool view — see the mcp check above'
        : row.covered
          ? row.tools.join(', ')
          : 'the family is recognized by rea_probe but this profile exposes no tool for it',
    });
  }

  const missing = checks.filter((check) => check.ok === false && check.optional !== true);
  const optionalMissing = checks.filter((check) => check.ok === false && check.optional === true);
  const verdict = missing.length === 0 ? 'ready' : reaTools.length === 0 ? 'blocked' : 'partial';

  return {
    verdict,
    platform: `${process.platform}/${process.arch}`,
    node: process.versions.node,
    serverName,
    reaToolCount: reaTools.length,
    skill: { path: skill.file, present: skill.present, version: skill.version, name: skill.name },
    checks,
    coverage,
    missing,
    optionalMissing,
    nextSteps: buildNextSteps(verdict, missing, optionalMissing, serverName),
  };
}

function buildNextSteps(verdict, missing, optionalMissing, serverName) {
  const steps = [];
  if (verdict === 'blocked') {
    steps.push(`The rea MCP server is not exposing tools. Run \`npx -y rea-agents@latest mcp\` in a terminal (it speaks JSON-RPC on stdio) and read the first error, then check the \`mcp-${serverName}\` row config.`);
  }
  for (const check of missing) {
    if (check.id === 'node') steps.push('Upgrade Node to 24.11+ (or 26+) and restart the harness; npx will otherwise refuse rea-agents.');
    else if (check.id === 'skill') steps.push('Enable `installSkill` on the dsh-rea row (or drop the upstream SKILL.md into $DSH_HOME/skills/reverse-engineer-anything/) so the agent gets the upstream playbook.');
    else if (check.hint !== undefined) steps.push(`${check.label} — ${check.hint}`);
  }
  if (missing.length === 0) steps.push('Readiness is sufficient: rea_probe the target, then open a session in the matching family and collect evidence.');
  const depth = optionalMissing.filter((check) => check.group === 'decompiler').map((check) => check.id);
  if (depth.length > 0 && verdict !== 'blocked') steps.push(`No decompiler among ${depth.join('/')} works for triage only — expect disassembly-level answers, not pseudo-code, and say so in the report.`);
  return steps;
}

/** Convenience for the CLI: the platform's default skills dir. */
export function defaultSkillsDir(homeDir = os.homedir()) {
  const dshHome = process.env.DSH_HOME ?? path.join(homeDir, '.dsh');
  return path.join(dshHome, 'skills');
}
