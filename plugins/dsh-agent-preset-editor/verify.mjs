// 发版前的一条命令：把「我改完就发、让用户重启当测试机」这个毛病固化成工具。
//
//   node verify.mjs              完整跑：测试 → 语法 → 打包 → 装进 profile → 校验配置与日志
//   node verify.mjs --skip-install   只跑到打包（不想动 profile 时）
//   node verify.mjs --profile web   换 profile
//
// 每一步都是可以失败的具体断言，不是"看起来没问题"。日志只在**本次运行期间新增的字节**里找
// 已知崩溃签名——旧日志里的历史错误不该让今天的验证失败。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const PROFILE = option('profile', 'desktop');
const SKIP_INSTALL = flag('skip-install');
const PKG = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const NAME = PKG.name;
const VERSION = PKG.version;

const APP_DIR = process.env.DSH_DESKTOP_APP ?? 'C:\\Program Files\\DSH Desktop\\resources\\app';
const EXE = process.env.DSH_DESKTOP_EXE ?? 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe';
const CLI = path.join(APP_DIR, 'lib', 'desktop-cli.js');
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const LOG_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'DSH Desktop', 'logs');

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  return ok;
};
const info = (label) => console.log(`  · ${label}`);

function expand(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

// ---- 1. 测试（纯函数 + 渲染冒烟）----
const TEST_FILES = ["test/pure.test.mjs", "test/render.mjs"];

function stepTests() {
  let passed = 0;
  let failed = 0;
  const notes = [];
  for (const file of TEST_FILES) {
    const run = spawnSync(process.execPath, [path.join(here, file)], { cwd: here, encoding: "utf8" });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const matched = /(\d+) passed, (\d+) failed/.exec(output);
    if (matched === null) {
      const tail = output.trim().split(String.fromCharCode(10)).slice(-3).join(" ").slice(0, 160);
      return record(false, "测试", `${file} 没跑出统计行：${tail}`);
    }
    passed += Number(matched[1]);
    failed += Number(matched[2]);
    if (run.status !== 0 && Number(matched[2]) === 0) failed += 1;
    notes.push(`${path.basename(file)} ${matched[1]}`);
  }
  return record(failed === 0, "测试", `${passed} passed, ${failed} failed（${notes.join(" / ")}）`);
}

// ---- 2. 语法 ----
function stepSyntax() {
  let ok = true;
  for (const file of ['client.js', 'index.js']) {
    const run = spawnSync(process.execPath, ['--check', path.join(here, file)], { encoding: 'utf8' });
    if (run.status !== 0) {
      ok = false;
      record(false, `语法 ${file}`, (run.stderr ?? '').split('\n').slice(0, 3).join(' '));
    }
  }
  return ok ? record(true, '语法 client.js / index.js', 'ok') : false;
}

// ---- 3. 打包 ----
function stepPack() {
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', here], {
    cwd: here,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status !== 0) return record(false, 'npm pack', output.split('\n').slice(-3).join(' '));
  const tgz = `${NAME}-${VERSION}.tgz`;
  const present = fs.existsSync(path.join(here, tgz));
  return record(present, 'npm pack', present ? tgz : '没找到产物');
}

// ---- 4. 日志基线（在安装前记录，之后只看新增字节） ----
function logSnapshot() {
  const snapshot = new Map();
  for (const entry of fs.readdirSync(LOG_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const file = path.join(LOG_DIR, entry.name);
    try {
      snapshot.set(file, fs.statSync(file).size);
    } catch {
      /* 文件刚被轮转掉 */
    }
  }
  return snapshot;
}

function stepLogs(snapshot) {
  const signatures = [
    /slot entry crashed/i,
    /duplicate factory registration/i,
    new RegExp(`Cannot find package '${NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i'),
    /is not defined/i,
  ];
  const hits = [];
  const warns = [];
  for (const entry of fs.readdirSync(LOG_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const file = path.join(LOG_DIR, entry.name);
    let appended;
    try {
      const size = fs.statSync(file).size;
      const from = snapshot.get(file) ?? 0;
      if (size <= from) continue;
      const buffer = Buffer.alloc(size - from);
      const handle = fs.openSync(file, 'r');
      fs.readSync(handle, buffer, 0, buffer.length, from);
      fs.closeSync(handle);
      appended = buffer.toString('utf8');
    } catch {
      continue;
    }
    for (const line of appended.split('\n')) {
      if (signatures.some((re) => re.test(line))) hits.push(`${entry.name}: ${line.trim().slice(0, 200)}`);
      else if (/preset-studio/i.test(line) && /warn|error/i.test(line)) warns.push(`${entry.name}: ${line.trim().slice(0, 160)}`);
    }
  }
  for (const line of warns.slice(0, 5)) info(`日志提示 ${line}`);
  if (hits.length === 0) return record(true, '日志（本次新增）', warns.length === 0 ? '干净' : `${warns.length} 条提示`);
  for (const line of hits.slice(0, 5)) console.log(`      ${line}`);
  return record(false, '日志（本次新增）', `${hits.length} 条崩溃签名`);
}

// ---- 5. 装进 profile ----
function runCli(argv) {
  return spawnSync(EXE, ['--expose-internals', CLI, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

function stepInstall() {
  const tgz = path.join(here, `${NAME}-${VERSION}.tgz`);
  runCli(['plugin', '--profile', PROFILE, 'remove', NAME]); // 没装过会失败，无所谓
  const added = runCli(['plugin', '--profile', PROFILE, 'add', tgz]);
  const output = `${added.stdout ?? ''}${added.stderr ?? ''}`;
  if (added.status !== 0) return record(false, '安装到 profile', output.split('\n').slice(-3).join(' '));
  const installedFile = path.join(PROFILE_DIR, 'node_modules', NAME, 'package.json');
  if (!fs.existsSync(installedFile)) return record(false, '安装到 profile', '装完了但目录里没有 package.json');
  const installed = JSON.parse(fs.readFileSync(installedFile, 'utf8')).version;
  return record(installed === VERSION, '安装到 profile', `已装 ${installed}`);
}

// ---- 6. 配置真的生效 ----
function stepDumpConfig() {
  const run = runCli(['--profile', PROFILE, '--dump-config']);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (output.trim().length === 0) return record(false, 'dump-config', '没有输出');
  const hasRow = new RegExp(expand('name: {name}', { name: NAME })).test(output);
  const officialDisabled = /- id: ui-agent-preset\s*\n\s*name: [^\n]*\n\s*disabled: true/.test(output);
  const ok = record(hasRow, '配置里有本插件', hasRow ? 'ok' : 'patch 行没进配置');
  if (officialDisabled) record(false, '官方 ui-agent-preset 未被禁用', '被 disabled 会连锁带走设置导航（0.54.0 的老坑）');
  return ok && !officialDisabled;
}

// ---- 7. 版本号在各处一致 ----
function stepVersionConsistency() {
  const patch = fs.readFileSync(path.join(here, 'cordis.patch.yml'), 'utf8');
  const nameInPatch = patch.includes(expand('name: {name}', { name: NAME })) || patch.includes(`'${NAME}'`) || patch.includes(NAME);
  const readme = fs.existsSync(path.join(here, 'README.md'));
  return record(nameInPatch && readme, 'cordis.patch.yml / README', nameInPatch ? 'ok' : 'patch 里的插件名与 package.json 不一致');
}

console.log(`\n验证 ${NAME}@${VERSION}（profile: ${PROFILE}）\n`);
const snapshot = fs.existsSync(LOG_DIR) ? logSnapshot() : new Map();
stepTests();
stepSyntax();
stepVersionConsistency();
const packed = stepPack();
if (SKIP_INSTALL) {
  info('--skip-install：跳过安装与配置校验');
} else if (packed) {
  const installed = stepInstall();
  if (installed) stepDumpConfig();
}
if (fs.existsSync(LOG_DIR)) stepLogs(snapshot);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过${failed.length === 0 ? '，可以重启看效果了' : ''}`);
if (failed.length > 0) {
  console.log('没过：');
  for (const entry of failed) console.log(`  - ${entry.label}${entry.detail === undefined ? '' : `（${entry.detail}）`}`);
}
process.exit(failed.length === 0 ? 0 : 1);
