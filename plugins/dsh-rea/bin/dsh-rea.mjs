#!/usr/bin/env node
/**
 * dsh-rea CLI — the same checks the plugin exposes as tools, runnable in a
 * terminal (useful before the MCP server has ever started, and for CI).
 *
 *   dsh-rea doctor [--family native] [--json]
 *   dsh-rea probe <path...> [--json]
 *   dsh-rea skill [--force] [--dir <skills root>]
 *
 * Standalone doctor has no agent tool view, so it reports `0 rea tool(s)` and
 * says so; inside a session, `rea_doctor` sees the live registry.
 *
 * @module dsh-rea/bin
 */
import os from 'node:os';
import path from 'node:path';
import { collectReadiness, defaultSkillsDir } from '../lib/doctor.js';
import { probeTargets } from '../lib/probe.js';
import { installSkillPack, skillPath } from '../lib/skill.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'doctor';
const rest = argv.slice(1);
const json = rest.includes('--json');

function flag(argvList, name) {
  const at = argvList.indexOf(name);
  return at === -1 ? undefined : argvList[at + 1];
}

async function doctor() {
  const report = await collectReadiness({
    toolNames: process.env.DSH_REA_TOOL_NAMES?.split(',').filter((entry) => entry !== '') ?? [],
    serverName: process.env.DSH_REA_SERVER ?? 'rea',
    skillPath: skillPath(flag(rest, '--dir') ?? defaultSkillsDir(os.homedir())),
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [`rea doctor — ${report.verdict.toUpperCase()} · ${report.platform} · node ${report.node}`, ''];
  let group = '';
  for (const check of report.checks) {
    if (check.group !== group) {
      group = check.group;
      lines.push(`[${group}]`);
    }
    lines.push(`  ${check.ok ? '✓' : check.optional === true ? '·' : '✗'} ${check.label}`);
    if (!check.ok && check.hint !== undefined) lines.push(`      → ${check.hint}`);
  }
  lines.push('', `visible rea tools: ${report.reaToolCount} (0 means this standalone run has no agent tool view — start the harness to check the mcp row)`);
  for (const step of report.nextSteps) lines.push(`- ${step}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (report.verdict === 'blocked') process.exitCode = 1;
}

async function probe() {
  const paths = rest.filter((entry) => !entry.startsWith('--'));
  if (paths.length === 0) {
    process.stderr.write('usage: dsh-rea probe <path...>\n');
    process.exitCode = 2;
    return;
  }
  const { targets } = await probeTargets(paths, { cwd: process.cwd(), available: new Set() });
  if (json) {
    process.stdout.write(`${JSON.stringify({ targets }, null, 2)}\n`);
    return;
  }
  for (const target of targets) {
    process.stdout.write(`${target.family.padEnd(18)} ${target.path}\n`);
    if (target.guide !== undefined) process.stdout.write(`  guide: ${target.guide}\n`);
    for (const note of target.notes) process.stdout.write(`  ! ${note}\n`);
  }
}

async function skill() {
  const dir = flag(rest, '--dir') ?? defaultSkillsDir(os.homedir());
  const result = await installSkillPack({ skillsDir: dir, force: rest.includes('--force') });
  if (json) {
    process.stdout.write(`${JSON.stringify({ dir, ...result }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`skill ${result.status} → ${result.target}${result.version === undefined ? '' : ` (v${result.version})`}\n`);
  if (result.written.length > 0) process.stdout.write(`  wrote: ${result.written.join(', ')}\n`);
}

const handlers = { doctor, probe, skill };
const handler = handlers[command];
if (handler === undefined) {
  process.stderr.write(`unknown command: ${command}\nusage: dsh-rea <doctor|probe|skill>\n`);
  process.exitCode = 2;
} else {
  await handler();
}

export { doctor, probe, skill, path };
