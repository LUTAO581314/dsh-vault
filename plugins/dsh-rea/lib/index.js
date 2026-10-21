/**
 * dsh-rea — REA (Reverse Engineer Anything) for DeepSeek Harness.
 *
 * Three jobs, all small:
 *   1. install the upstream `reverse-engineer-anything` skill pack into the
 *      harness skills root (REA's own `rea setup` does not know about DSH);
 *   2. `rea_probe` — decide what an artifact IS and which REA line studies it,
 *      using magic bytes instead of the extension, and only suggesting tools the
 *      `rea` MCP server actually registered in this profile;
 *   3. `rea_doctor` — say whether this machine can finish the analysis it is
 *      about to promise (decompilers, adb, tshark, binwalk, node engines…).
 *
 * The 207 REA tools themselves come from the `mcp-rea` row in cordis.patch.yml,
 * not from this plugin: they are host-plane and shared, so a preset must not
 * mount a second copy.
 *
 * @module dsh-rea
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import os from 'node:os';
import path from 'node:path';
import { collectReadiness, defaultSkillsDir } from './doctor.js';
import { probeTargets } from './probe.js';
import { installSkillPack, skillPath } from './skill.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-rea';

/** Services required before this plugin loads. */
export const inject = ['tools'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  installSkill: z.boolean().default(true),
  /** Absolute skills root; defaults to `$DSH_HOME/skills`. */
  skillsDir: z.string().default(defaultSkillsDir(os.homedir())),
  mcpServerName: z.string().default('rea').description('serverName used by the mcp-rea row; rea_probe/rea_doctor count tools under mcp__<name>__'),
  probeHeadBytes: z.natural().min(512).max(65536).default(8192),
  probeMaxTargets: z.natural().min(1).max(64).default(16),
  doctorTimeoutMs: z.natural().min(500).max(30000).default(4000),
});

const TEXT = (text) => [{ type: 'text', text }];

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Every tool name visible to a plain (global-scope) view. */
function visibleToolNames(ctx) {
  try {
    return [...ctx.tools.view().visible.keys()];
  } catch {
    return [];
  }
}

/** Bare tool names of one MCP server, without the `mcp__<server>__` prefix. */
function serverTools(ctx, serverName) {
  const prefix = `mcp__${serverName}__`;
  return new Set(visibleToolNames(ctx).filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length)));
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  const resolved = { ...Config(), ...config };
  if (resolved.enabled === false) return;

  const logger = ctx.logger(name);

  if (resolved.installSkill === true) {
    void installSkillPack({ skillsDir: resolved.skillsDir })
      .then((result) => {
        if (result.status === 'current') logger.debug(`dsh-rea: skill current at ${result.target}`);
        else logger.info(`dsh-rea: skill ${result.status} (v${result.version ?? 'unknown'}) at ${result.target}`);
      })
      .catch((error) => {
        logger.warn(`dsh-rea: skill install skipped — ${message(error)}`);
      });
  }

  ctx.tools.register(
    defineTool({
      name: 'rea_probe',
      description:
        'Identify what an artifact actually is before analyzing it: reads magic bytes (not extensions), reports the format family, the REA workflow and guide for it, and the exact `mcp__rea__*` tools this profile exposes for that family. Cheaper and more reliable than guessing from a suffix, and the recommended first step of any REA session.',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string', description: 'file or directory path, absolute or relative to the harness working directory' },
          required: true,
          description: 'one or more targets to identify (a directory is classified by its layout, not walked)',
        },
        cwd: {
          type: 'string',
          description: 'base directory for relative paths (defaults to the session working directory)',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => TEXT(renderProbe(value)),
      },
      async execute(args, exec) {
        try {
          const cwd = args.cwd ?? exec.workingDirectory ?? process.cwd();
          const available = serverTools(ctx, resolved.mcpServerName);
          const targets = args.paths.slice(0, resolved.probeMaxTargets);
          const { targets: probed, families } = await probeTargets(targets, {
            cwd,
            available,
            maxBytes: resolved.probeHeadBytes,
          });
          const skipped = args.paths.length - targets.length;
          return {
            ok: true,
            cwd,
            mcpServer: resolved.mcpServerName,
            reaToolCount: available.size,
            families,
            targets: probed,
            ...(skipped > 0 ? { skipped, note: `probed the first ${targets.length} of ${args.paths.length} paths; call again for the rest` } : {}),
            ...(available.size === 0
              ? { warning: `No mcp__${resolved.mcpServerName}__* tools are registered, so no tool names can be suggested. Run rea_doctor.` }
              : {}),
          };
        } catch (error) {
          return { ok: false, error: message(error) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'rea_doctor',
      description:
        'Readiness report for REA work on this machine: Node engines, whether the rea MCP server registered its tools, whether the reverse-engineer-anything skill is installed, which decompilers/devices/capture tools exist (Ghidra, Hopper, IDA, rizin, objdump, jadx, apktool, adb + attached devices, tshark, binwalk, wabt, python), REA_* overrides, and per-family tool coverage. Run it before promising an analysis whose depth depends on a missing engine.',
      parameters: {
        family: {
          type: 'string',
          description: 'optional family id from rea_probe (native, dotnet, apk, javascript, macho, pcap, firmware…) to get a needs-only view',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => TEXT(renderDoctor(value)),
      },
      async execute(args) {
        try {
          const report = await collectReadiness({
            toolNames: visibleToolNames(ctx),
            serverName: resolved.mcpServerName,
            skillPath: skillPath(resolved.skillsDir),
            timeoutMs: resolved.doctorTimeoutMs,
          });
          if (args.family === undefined || args.family === '') return { ok: true, ...report };
          const needs = report.coverage.find((row) => row.family === args.family);
          const groups = FAMILY_GROUPS[args.family] ?? [];
          return {
            ok: true,
            ...report,
            family: args.family,
            familyCoverage: needs ?? { family: args.family, covered: false, tools: [] },
            familyChecks: report.checks.filter((check) => groups.includes(check.group)),
          };
        } catch (error) {
          return { ok: false, error: message(error) };
        }
      },
    }),
  );
}

/** Which doctor check groups matter for a family. */
const FAMILY_GROUPS = {
  native: ['runtime', 'mcp', 'skill', 'decompiler', 'scripting'],
  go: ['runtime', 'mcp', 'skill', 'decompiler'],
  rust: ['runtime', 'mcp', 'skill', 'decompiler'],
  dotnet: ['runtime', 'mcp', 'skill', 'decompiler'],
  javascript: ['runtime', 'mcp', 'skill'],
  apk: ['runtime', 'mcp', 'skill', 'android'],
  'android-source': ['runtime', 'mcp', 'skill', 'android'],
  'flutter-aot': ['runtime', 'mcp', 'skill', 'android'],
  macho: ['runtime', 'mcp', 'skill', 'decompiler'],
  'apple-app': ['runtime', 'mcp', 'skill', 'decompiler'],
  pcap: ['runtime', 'mcp', 'skill', 'network'],
  'web-capture': ['runtime', 'mcp', 'skill'],
  firmware: ['runtime', 'mcp', 'skill', 'firmware'],
  wasm: ['runtime', 'mcp', 'skill', 'wasm'],
  sqlite: ['runtime', 'mcp', 'skill'],
};

function renderProbe(value) {
  if (value.ok === false) return `rea_probe failed: ${value.error}`;
  const lines = [
    `rea_probe — ${value.targets.length} target(s) against ${value.reaToolCount} visible mcp__${value.mcpServer}__ tool(s)`,
    '',
  ];
  for (const target of value.targets) {
    lines.push(`■ ${target.label} [${target.family}] — ${target.path}`);
    if (target.kind === 'file') lines.push(`  ${target.bytes.toLocaleString()} bytes${target.ext === '' ? '' : `, ext ${target.ext}`} · basis: ${target.basis}`);
    else if (target.kind === 'directory') lines.push(`  directory, ${target.bytes} top-level entries · basis: ${target.basis}`);
    if (target.guide !== undefined) lines.push(`  guide: ${target.guide}`);
    if (target.tools.length > 0) lines.push(`  rea tools here: ${target.tools.join(', ')}`);
    if (target.next.length > 0) lines.push(`  next: ${target.next[0]}`);
    for (const note of target.notes) lines.push(`  ! ${note}`);
    lines.push('');
  }
  if (value.warning !== undefined) lines.push(`! ${value.warning}`);
  if (value.note !== undefined) lines.push(`! ${value.note}`);
  return lines.join('\n').trimEnd();
}

function renderDoctor(value) {
  if (value.ok === false) return `rea_doctor failed: ${value.error}`;
  const head = `rea_doctor — ${value.verdict.toUpperCase()} · ${value.platform} · node ${value.node} · ${value.reaToolCount} rea tool(s)`;
  const checks = value.familyChecks ?? value.checks;
  const lines = [head, ''];
  let group = '';
  for (const check of checks) {
    if (check.group !== group) {
      group = check.group;
      lines.push(`[${group}]`);
    }
    const mark = check.ok ? '✓' : check.optional === true ? '·' : '✗';
    lines.push(`  ${mark} ${check.label}`);
    if (!check.ok && check.detail !== undefined) lines.push(`      ${check.detail}`);
    if (check.hint !== undefined) lines.push(`      → ${check.hint}`);
  }
  if (value.missing.length > 0) {
    lines.push('', `blocking: ${value.missing.map((check) => check.id).join(', ')}`);
  }
  if (value.optionalMissing.length > 0) lines.push(`optional missing: ${value.optionalMissing.map((check) => check.id).join(', ')}`);
  if (value.nextSteps.length > 0) {
    lines.push('', 'next:');
    for (const step of value.nextSteps) lines.push(`  - ${step}`);
  }
  return lines.join('\n');
}
