/**
 * Host half of dsh-preset-studio.
 *
 * M4 第一部分：按 preset 注入系统提示词模块。
 *
 * 机制：监听 agent/created，拿到该会话的 preset id，在 agent scope 里注册
 * systemPrompt.section。scoped section 遮蔽 host 同名 section；自定义 name 是纯新增。
 *
 * 模块清单存在本插件的 volatile settings 里（持久化到 profile patch），
 * 正文可以内联（text），也可以指向 $DSH_HOME/preset-studio/prompts/<file>。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import yaml from 'js-yaml';
import { createGate, isCoreSection } from './gate.js';

export const name = 'preset-studio';
export const inject = ['systemPrompt'];

/** 保留 `!!js` 标签，避免把条件表达式固化成求值后的布尔。 */
const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => ({ __jsExpr: data }),
});
const YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([jsType]);

/** 读出 profile patch 里某一行的 config（保留 !!js）。 */
function readPatchRowRow(file, rowId) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const patches = yaml.load(text, { schema: YAML_SCHEMA });
  if (!Array.isArray(patches)) return undefined;
  return patches.findLast?.((row) => row && row.insert === undefined && row.id === rowId);
}

const CORDIS_CREATOR_PROMPT = `# 角色

你正在「创造模式」下工作：用户希望通过对话定制 DSH——写插件、改界面、组合工具与提示词，最终产出一个可安装的 bundle。

# 工作方式

先看再写。读 DSH 安装目录里现有插件的 package.json 与 cordis.patch.yml 作为范例，确认字段含义后再生成，不要凭印象编字段。

产出物一律是 bundle 包目录，最少三件：package.json（含 dsh.bundle.patch 与 dsh.client）、cordis.patch.yml（用 insert 声明行）、入口文件（host 半 index.js，客户端半 client.js）。

客户端半用 window.__ModuleLoader__.load({ id, factory(require) {...} })，只依赖已存在的包；host 半按需 import @deepseek-ai/*，并在 package.json 里声明为 dependency 或 peerDependency——声明漏了会在启动时 import 失败，而且不报错。

安装用 pluginManager 的 install_bundle 指到包目录；装完检查 bundles 列表与加载日志，别假设成功。

# 与预设的关系

新增 preset 用 @deepseek-ai/dsh-agent-preset 行，config 里给 id / order / plugins。改已有 preset 按行 id 覆盖 config，注意覆盖是整段替换，漏掉 id 会让 preset 从列表消失。

本机已装「预设工作室」插件：它按 preset 注入系统提示词模块，模块数据在 ~/.dsh/preset-studio/modules.json。写新 preset 时不要自己再塞一份通用工作方式，交给模块系统。

# 输出契约

先给一句结论（能不能做、要改哪些文件），再给文件内容。命令与路径写全，不要省略号。不确定的字段去读源码确认，不要猜。`;

const DEFAULT_MODULES = [
  { id: 'base', section: 'pack:base', order: 0, file: 'base.md', presets: '!cordis', enabled: true },
  {
    id: 'cordis-creator',
    section: 'pack:cordis-creator',
    order: 0,
    presets: ['cordis'],
    enabled: true,
    text: CORDIS_CREATOR_PROMPT,
    source: 'builtin',
  },
];

/** 旧版本只有一个 presets='*' 的 base；升级时把它收窄成「除创造模式外」。 */
function migrateModules(list) {
  const hasBase = list.some((entry) => entry?.id === 'base');
  const hasCreator = list.some((entry) => entry?.id === 'cordis-creator');
  let changed = false;
  const next = list.map((entry) => {
    if (entry?.id === 'base' && entry.presets === '*') {
      changed = true;
      return { ...entry, presets: '!cordis' };
    }
    return entry;
  });
  if (hasBase && !hasCreator) {
    changed = true;
    next.push(DEFAULT_MODULES[1]);
  }
  return changed ? next : null;
}

/** 只有 volatile 字段会进设置表单，并持久化到 profile patch。 */
export const Config = z.object({
  modules: z
    .string()
    .default(JSON.stringify(DEFAULT_MODULES))
    .volatile()
    .description('提示词模块清单（JSON 数组）'),
  request: z
    .string()
    .default('')
    .volatile()
    .description('指令队列：客户端写入 JSON，host 轮询执行'),
});

const DEFAULT_SECTION = 'pack:module';

function promptsDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'preset-studio', 'prompts');
}

function studioDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'preset-studio');
}

/** 读自身版本，供诊断显示（避免手写版本号对不上）。 */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 原子写：先写临时文件再 rename，避免中途崩溃留下半个文件。 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 模块清单存文件，不再写 profile patch：写 patch 会触发 loader 重新组合。 */
function modulesFile() {
  return path.join(studioDir(), 'modules.json');
}

function readModulesFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(modulesFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeModulesFile(list) {
  writeFileAtomic(modulesFile(), `${JSON.stringify(list, null, 2)}\n`);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const LIMIT = 1024 * 1024; // 1 MB：配置都是几 KB，超出说明不是本插件发的
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMIT) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body ?? null));
}

// ---- 外部提示词检测：把「插件自己注入的 section」纳管成模块 ----

function detectedFile() {
  return path.join(studioDir(), 'detected.json');
}

function readDetected() {
  try {
    const parsed = JSON.parse(fs.readFileSync(detectedFile(), 'utf8'));
    if (parsed && Array.isArray(parsed.baseline) && Array.isArray(parsed.entries)) return parsed;
  } catch {
    /* 首次运行没有文件 */
  }
  return { baseline: null, entries: [] };
}

function writeDetected(state) {
  try {
    writeFileAtomic(detectedFile(), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* 写不了就不持久化，检测仍在本进程内生效 */
  }
}

function readModuleText(entry) {
  if (typeof entry.text === 'string' && entry.text.trim().length > 0) return entry.text.trim();
  if (typeof entry.file === 'string' && entry.file.trim().length > 0) {
    try {
      return fs.readFileSync(path.resolve(promptsDir(), entry.file), 'utf8').trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseModules(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** volatile 字段是引用对象：每次都要 .get()。 */
function readVolatile(holder) {
  return holder !== null && typeof holder === 'object' && typeof holder.get === 'function' ? holder.get() : holder;
}

/** volatile 字段是引用对象：每次都要 .get()，设置更新后无需重启即可生效。 */
function currentModules(config) {
  return parseModules(readVolatile(config?.modules));
}

/** 执行客户端下发的指令。 */
async function handleRequest(ctx, request) {
  if (request.op === 'setPluginEnabled') return setPluginEnabled(ctx, request);
  if (request.op === 'setSkillConfig') return setSkillConfig(ctx, request);
  throw new Error(`未知指令 ${String(request.op)}`);
}

/** 定位 preset 行的 config，并用原文（保留 !!js）回调修改。 */
async function editPresetRow(ctx, presetId, mutate) {
  const editor = ctx.get('configEditor');
  if (editor === undefined) throw new Error('configEditor 不可用');
  const rowId = `preset-${presetId}`;
  const entry = editor.entries().find((candidate) => candidate.options?.id === rowId);
  if (entry === undefined) throw new Error(`找不到 profile 行 ${rowId}`);
  const original = readPatchRowRow(editor.documentPath, rowId);
  const base = original?.config ?? structuredClone(entry.options.config ?? {});
  const next = mutate(structuredClone(base));
  await editor.edit(entry, () => next);
}

async function setPluginEnabled(ctx, request) {
  const rowId = `preset-${request.presetId}`;
  await editPresetRow(ctx, request.presetId, (config) => {
    const plugins = Array.isArray(config.plugins) ? config.plugins : [];
    const index = plugins.findIndex((row) => row?.name === request.moduleName);
    if (index < 0) throw new Error(`${rowId} 里没有插件 ${request.moduleName}`);
    const target = { ...plugins[index] };
    if (request.enabled) delete target.disabled;
    else target.disabled = true;
    plugins[index] = target;
    return { ...config, plugins };
  });
  ctx.logger?.info?.(`[preset-studio] ${rowId}: ${request.moduleName} → ${request.enabled ? 'enabled' : 'disabled'}`);
}

const SKILL_FILESYSTEM = '@deepseek-ai/dsh-skill-filesystem';

async function setSkillConfig(ctx, request) {
  const rowId = `preset-${request.presetId}`;
  await editPresetRow(ctx, request.presetId, (config) => {
    const plugins = Array.isArray(config.plugins) ? config.plugins : [];
    const index = plugins.findIndex((row) => row?.name === SKILL_FILESYSTEM);
    if (index < 0) throw new Error(`${rowId} 里没有 ${SKILL_FILESYSTEM}`);
    const row = { ...plugins[index] };
    const rawConfig = row.config && typeof row.config === 'object' ? row.config : {};
    const nextSkillConfig = { ...rawConfig };
    if (typeof request.includeDefaultRoots === 'boolean') nextSkillConfig.includeDefaultRoots = request.includeDefaultRoots;
    if (Array.isArray(request.customSkillDirs)) nextSkillConfig.customSkillDirs = request.customSkillDirs;
    row.config = nextSkillConfig;
    plugins[index] = row;
    return { ...config, plugins };
  });
  ctx.logger?.info?.(`[preset-studio] ${rowId}: skill config updated`);
}

/**
 * 判断模块是否作用于某个 preset。client 侧有一份**必须完全一致**的实现。
 * 支持：`'*'`（全部）、`'standard'`（仅它）、`'!cordis'`（除它之外全部）、
 * 以及数组形式 `['*', '!cordis']` / `['standard', 'ptc']`。
 */
function appliesTo(entry, presetId) {
  const scope = entry.presets ?? '*';
  const list = (Array.isArray(scope) ? scope : [scope])
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  if (list.length === 0) return false;
  const negatives = list.filter((item) => item.startsWith('!')).map((item) => item.slice(1));
  if (negatives.includes(presetId)) return false;
  const positives = list.filter((item) => !item.startsWith('!'));
  if (positives.length === 0) return true;
  if (positives.includes('*')) return true;
  return positives.includes(presetId);
}

function presetIdOf(agent) {
  const header = agent?.session?.header;
  if (typeof header?.agentPreset === 'string' && header.agentPreset.length > 0) return header.agentPreset;
  const projected = agent?.session?.projectionValues?.agentPreset;
  if (typeof projected === 'string' && projected.length > 0) return projected;
  return 'standard';
}

/** 体检结果缓存：同一份插件清单在 TTL 内不重复调模型。 */
const auditCache = new Map();
const AUDIT_TTL_MS = 30 * 60 * 1000;

function auditKey(plugins) {
  const shape = (Array.isArray(plugins) ? plugins : [])
    .map((row) => `${row?.moduleName ?? ''}:${row?.enabled === false ? 0 : row?.enabled === 'conditional' ? 2 : 1}`)
    .sort()
    .join('|');
  let hash = 0;
  for (let i = 0; i < shape.length; i++) hash = (hash * 31 + shape.charCodeAt(i)) | 0;
  return `${(hash >>> 0).toString(36)}:${shape.length}`;
}

/** 用会话默认模型做一次插件体检。 */
async function runAudit(ctx, plugins, force) {
  const key = auditKey(plugins);
  const hit = auditCache.get(key);
  if (force !== true && hit !== undefined && Date.now() - hit.at < AUDIT_TTL_MS) {
    return { ...hit.data, cached: true, ageMs: Date.now() - hit.at };
  }

  const llm = ctx.get('llm');
  if (llm === undefined || typeof llm.stream !== 'function') throw new Error('llm 服务不可用');
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {};
  const provider = selection.provider;
  const model = selection.model;
  if (typeof provider !== 'string' || typeof model !== 'string') throw new Error('没有可用的默认模型');

  const list = (Array.isArray(plugins) ? plugins : [])
    .map((row) => {
      const state = row.enabled === false ? '禁用' : row.enabled === 'conditional' ? '条件' : '启用';
      return `- ${row.moduleName} [${state}]${row.condition ? ` 条件: ${row.condition}` : ''}`;
    })
    .join('\n');

  const prompt = [
    '你在检查一台 DSH（DeepSeek Harness）实例的插件配置。',
    '下面是某个 Agent 预设里的插件清单：',
    '',
    list,
    '',
    '请用中文回答，控制在 400 字内：',
    '1. 这些插件大致分成哪几类能力（按功能归组，不要逐个复述）；',
    '2. 有没有功能重叠、明显冲突、或者重复安装的；',
    '3. 哪些可以关掉以省 token / 降启动成本；',
    '4. 一句话总结。',
  ].join('\n');

  let text = '';
  for await (const chunk of llm.stream({
    provider,
    model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (typeof chunk.text === 'string') text += chunk.text;
    else if (chunk.delta && typeof chunk.delta.text === 'string') text += chunk.delta.text;
  }
  const result = { text: text.trim(), provider, model };
  auditCache.set(key, { at: Date.now(), data: result });
  return { ...result, cached: false, ageMs: 0 };
}

// ---- skill 扫描：与 dsh-skill-filesystem 的 root 约定一致 ----

function skillRoots() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const agentsHome = process.env.DSH_AGENTS_HOME ?? path.join(os.homedir(), '.agents');
  const roots = [
    { source: 'dsh-home', path: path.join(home, 'skills') },
    { source: 'agents-home', path: path.join(agentsHome, 'skills') },
    { source: 'workspace', path: path.join(process.cwd(), '.dsh', 'skills') },
  ];
  const bundled = process.env.DSH_BUNDLED_SKILL_DIR;
  if (typeof bundled === 'string' && bundled.length > 0) {
    roots.push({ source: 'bundled', path: bundled });
  }
  // 安装目录里随包发布的 skill（office 系列、sandbox 诊断等）在
  // <app>/node_modules/@deepseek-ai/<pkg>/assets/<skill>/SKILL.md
  try {
    const appNodeModules = path.join(path.dirname(process.execPath), 'resources', 'app', 'node_modules', '@deepseek-ai');
    for (const pkg of fs.readdirSync(appNodeModules, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const assetsDir = path.join(appNodeModules, pkg.name, 'assets');
      let subs;
      try {
        subs = fs.readdirSync(assetsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const hasSkill = subs.some((sub) => sub.isDirectory() && fs.existsSync(path.join(assetsDir, sub.name, 'SKILL.md')));
      if (hasSkill) roots.push({ source: `bundled:${pkg.name}`, path: assetsDir });
    }
  } catch {
    /* 非打包环境（或权限不足）就跳过 */
  }
  const seen = new Set();
  return roots.filter((root) => {
    if (seen.has(root.path)) return false;
    seen.add(root.path);
    return true;
  });
}

function readFrontmatterField(text, field) {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(text);
  if (match === null) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function scanSkills(dirs) {
  const byId = new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      if (byId.has(entry.name)) continue;
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        /* 读不到就只报目录名 */
      }
      byId.set(entry.name, {
        id: entry.name,
        name: readFrontmatterField(text, 'name') ?? entry.name,
        description: readFrontmatterField(text, 'description') ?? '',
        dir,
        path: file,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- skill 单条开关：过滤 catalog 文本行（registry 没有 disable API）----

function skillStateFile() {
  return path.join(studioDir(), 'skills.json');
}

function readSkillState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(skillStateFile(), 'utf8'));
    if (parsed && Array.isArray(parsed.disabled)) return parsed;
  } catch {
    /* 首次运行 */
  }
  return { disabled: [] };
}

function writeSkillState(state) {
  writeFileAtomic(skillStateFile(), `${JSON.stringify({ disabled: state.disabled ?? [] }, null, 2)}\n`);
}

/** 从 catalog 文本里删掉被禁用的行；返回新文本（未命中时返回原文本）。 */
function filterCatalogText(text, disabled) {
  let changed = false;
  const lines = text.split('\n').filter((line) => {
    const match = /^-\s+`([^`]+)`/.exec(line.trim());
    if (match === null) return true;
    if (!disabled.has(match[1])) return true;
    changed = true;
    return false;
  });
  return changed ? lines.join('\n') : text;
}

/** 优先问 skill registry（和 armory、会话 catalog 同一份数据），失败才扫目录。
 *  注意：registry 是分 scope 的，而 skill-filesystem 注册在 preset scope 里，
 *  所以从 host 根层调用只能看到全局层的那几个 —— 只有当扫描拿不到任何 skill 时才用它兜底。 */
async function listSkills(ctx) {
  const roots = skillRoots();
  const scanned = scanSkills(roots.map((root) => root.path));
  if (scanned.length > 0) return { source: 'scan', skills: scanned };

  const service = ctx.get('skills');
  if (service !== undefined && typeof service.list === 'function') {
    try {
      const summaries = await service.list({ cwd: process.cwd() });
      if (Array.isArray(summaries) && summaries.length > 0) {
        return {
          source: 'registry',
          skills: summaries.map((item) => ({
            id: item.name,
            name: item.name,
            description: item.description ?? '',
            whenToUse: item.whenToUse,
            provider: item.provider,
            path: item.path,
          })),
        };
      }
    } catch (error) {
      ctx.logger?.warn?.(`[preset-studio] skills.list failed: ${String(error?.message ?? error)}`);
    }
  }
  return { source: 'scan', skills: scanned };
}

// ---- 样式表：内置默认 + 用户可覆盖 ----
// 首次运行把 DEFAULT_CSS 播种到 `~/.dsh/preset-studio/style.css`，之后只读文件，绝不覆盖已有内容。
const DEFAULT_CSS = `.psx-section{display:flex;flex-direction:column;gap:20px;padding:4px 0}
.psx-title{margin:0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}
.psx-intro{margin:0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#777)}
.psx-error{margin:0;font-size:12px;color:#c0392b}
.psx-group{display:flex;flex-direction:column;gap:10px}
.psx-group+.psx-group{margin-top:20px}
.psx-groupHead{margin:0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.psx-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px;margin:0;padding:0;list-style:none;align-items:stretch}
.psx-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);border-radius:12px;background:var(--dsw-alias-fill-primary,#fff);overflow:hidden;height:100%}
.psx-card[data-active="true"]{border-color:var(--dsw-alias-border-primary,#2f6feb);box-shadow:0 0 0 1px var(--dsw-alias-border-primary,#2f6feb) inset}
.psx-cardMain{display:flex;flex-direction:column;gap:10px;flex:1;padding:14px 16px 6px;background:none;border:0;text-align:left;cursor:pointer;color:inherit;font:inherit}
.psx-cardMain:disabled{cursor:default}
.psx-cardHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.psx-cardIdentity{display:flex;align-items:center;gap:8px;min-width:0}
.psx-cardName{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.psx-cardId{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.psx-cardDesc{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#555);margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.psx-cardFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px 10px}
.psx-iconButton{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:0;background:none;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer}
.psx-iconButton:hover{background:var(--dsw-alias-fill-tsp-secondary,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#555)}
.psx-placeholder{border:1px dashed var(--dsw-alias-border-secondary,#dcdcdc);border-radius:10px;padding:14px;font-size:13px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.psx-creator{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:7px 12px;border-radius:8px;border:1px dashed var(--dsw-alias-border-secondary,#dcdcdc);background:none;font-size:13px;color:var(--dsw-alias-label-secondary,#555);cursor:pointer}
.psx-creator:disabled{opacity:.6;cursor:default}
.psx-detail{display:flex;flex-direction:column;gap:18px}
.psx-detailHead{display:flex;align-items:center;gap:10px}
.psx-back{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);background:none;font-size:13px;color:var(--dsw-alias-label-secondary,#555);cursor:pointer}
.psx-back:hover{background:var(--dsw-alias-fill-tsp-secondary,rgba(0,0,0,.05))}
.psx-detailTitle{display:flex;flex-direction:column;gap:2px}
.psx-detailName{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}
.psx-detailSub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.psx-block{display:flex;flex-direction:column;gap:8px}
.psx-blockHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.psx-blockTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);margin:0}
.psx-count{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-weight:400;margin-left:6px}
.psx-chips{display:flex;flex-wrap:wrap;gap:6px}
.psx-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:4px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);background:var(--dsw-alias-fill-primary,#fff);font-size:12px;color:var(--dsw-alias-label-secondary,#555)}
.psx-chip[data-state="off"]{opacity:.55;text-decoration:line-through}
.psx-chip[data-state="failed"]{border-color:#e0a0a0;color:#c0392b}
.psx-chipTag{font-size:10px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.psx-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.psx-muted{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.psx-modules{display:flex;flex-direction:column;gap:8px}
.psx-module{border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-fill-primary,#fff)}
.psx-module[data-active="false"]{opacity:.6}
.psx-moduleHead{display:flex;align-items:center;gap:10px;padding:8px 12px;flex-wrap:wrap}
.psx-moduleName{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary,#1a1a1a)}
.psx-moduleMeta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.psx-fold{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:0;background:none;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer;padding:0;margin-right:4px;transition:transform .12s ease}
.psx-fold[aria-expanded="false"]{transform:rotate(-90deg)}
.psx-blockActions{display:flex;gap:6px}
.psx-mini[data-on="true"]{border-color:#2f6feb;color:#2f6feb;background:#f3f7ff}
.psx-chip[data-clickable="true"]{cursor:pointer}.psx-chip[data-busy="true"]{opacity:.45;pointer-events:none}
.psx-chip[data-clickable="true"]:hover{border-color:#2f6feb;color:#1f57c3}
.psx-inspect{border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-fill-secondary,#fafafa)}
.psx-inspectHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.psx-inspectGrid{display:grid;grid-template-columns:84px 1fr;gap:4px 10px;margin:0;font-size:12px}
.psx-inspectGrid dt{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.psx-inspectGrid dd{margin:0;color:var(--dsw-alias-label-secondary,#555);word-break:break-all}
.psx-moduleState{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2)}
.psx-moduleState[data-on="true"]{color:#1a7f37;border-color:#a8d5b5;background:#f2fbf5}
.psx-moduleState[data-on="false"]{color:var(--dsw-alias-label-tertiary,#8a8a8a);background:var(--dsw-alias-fill-tsp-secondary,rgba(0,0,0,.03))}
.psx-moduleActions{margin-left:auto;display:flex;gap:6px}
.psx-mini{height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);background:none;font-size:12px;color:var(--dsw-alias-label-secondary,#555);cursor:pointer}
.psx-mini:disabled{opacity:.5;cursor:default}
.psx-mini:hover:not(:disabled){background:var(--dsw-alias-fill-tsp-secondary,rgba(0,0,0,.05))}
.psx-mini.psx-primary{border-color:var(--dsw-alias-border-primary,#2f6feb);color:var(--dsw-alias-border-primary,#2f6feb)}
.psx-mini.psx-danger:hover:not(:disabled){border-color:#d98c8c;color:#c0392b}
.psx-moduleEditor{border-top:1px solid var(--dsw-alias-border-secondary,#e2e2e2);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.psx-textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);background:var(--dsw-alias-fill-secondary,#fafafa);color:inherit;resize:vertical}
.psx-moduleEditorFoot{display:flex;justify-content:flex-end;gap:8px}
.psx-cardHelp{display:flex;align-items:center;gap:4px}
.psx-toast{margin:0;padding:7px 11px;border-radius:8px;font-size:12px;line-height:1.5;display:block}
.psx-toast[data-tone="ok"]{background:#eaf7ee;color:#1a7f37;border:1px solid #b7e1c4}
.psx-toast[data-tone="err"]{background:#fdf0f0;color:#c0392b;border:1px solid #f0c2c2}
.psx-diag{padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);background:var(--dsw-alias-fill-secondary,#fafafa)}
.psx-raw{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.psx-raw pre{margin:6px 0 0;padding:8px;border-radius:6px;background:var(--dsw-alias-fill-secondary,#fafafa);white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;font-size:11px}
.psx-aiResult{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-fill-secondary,#fafafa);border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;font-family:inherit}
.psx-audit{margin:0;padding:0 0 0 18px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}
.psx-audit li[data-level="warn"]{color:#9a6700}
.psx-audit li[data-level="err"]{color:#c0392b}
.psx-audit li[data-level="ok"]{color:#1a7f37}
.psx-audit li[data-level="info"]{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.psx-catalog{display:flex;flex-direction:column;gap:10px}
.psx-catalogBar{display:flex;align-items:center;gap:8px}
.psx-search{max-width:280px;height:28px;flex:0 0 auto}
.psx-groups{display:flex;flex-direction:column;gap:12px}
.psx-catGroup{display:flex;flex-direction:column;gap:6px}
.psx-chipToggle{border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);background:var(--dsw-alias-fill-primary,#fff);font:inherit;cursor:pointer}
.psx-chipToggle[data-state="on"]{border-color:#2f6feb;color:#1f57c3;background:#f3f7ff}
.psx-chipToggle[data-state="off"]{opacity:.6}
.psx-chipToggle:disabled{opacity:.45;cursor:default}
.psx-scope{display:flex;flex-direction:column;gap:6px}
.psx-scope .psx-chips{gap:6px}
.psx-skill{display:flex;flex-direction:column;gap:10px}
.psx-skillBody{display:flex;flex-direction:column;gap:8px}
.psx-dirAdd{display:flex;gap:8px;align-items:center}
.psx-input{flex:1;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);background:var(--dsw-alias-fill-primary,#fff);font-size:12px;color:inherit}
.psx-metaRow{display:flex;gap:8px;flex-wrap:wrap}
.psx-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);flex:1;min-width:140px}
.psx-fieldNarrow{max-width:90px}
.psx-inspectTitle{display:flex;flex-direction:column;gap:2px;min-width:0}
.psx-inspectName{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}
.psx-inspectModule{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.psx-inspectDesc{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#555)}

/* ---- 视觉精修：分组分隔、区块容器、卡片质感 ---- */
.psx-section{gap:24px}
.psx-title{font-size:17px;letter-spacing:-.01em}
.psx-intro{max-width:62ch;font-size:12.5px}
.psx-group+.psx-group{padding-top:20px;border-top:1px solid var(--dsw-alias-border-secondary,#ededed)}
.psx-groupHead{font-size:10.5px;letter-spacing:.1em;color:var(--dsw-alias-label-quaternary,#9a9a9a)}
.psx-cards{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.psx-card{border-radius:14px;transition:border-color .15s ease,box-shadow .15s ease}
.psx-card:hover{border-color:#c9d8f5;box-shadow:0 2px 12px rgba(20,40,80,.07)}
.psx-block{border:1px solid var(--dsw-alias-border-secondary,#ececec);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-fill-primary,#fff);gap:10px}
.psx-detail{gap:14px}
.psx-chip{padding:4px 10px}
.psx-inspect{border-radius:10px;background:var(--dsw-alias-fill-secondary,#fafafa)}
.psx-diag{border-radius:10px}
.psx-module{border-radius:10px}
`;

function styleFile() {
  return path.join(studioDir(), 'style.css');
}

function readStyle() {
  try {
    const text = fs.readFileSync(styleFile(), 'utf8');
    if (text.trim().length > 0) return text;
  } catch {
    /* 还没播种 */
  }
  return DEFAULT_CSS;
}

function seedStyle() {
  try {
    if (!fs.existsSync(styleFile())) {
      writeFileAtomic(styleFile(), `${DEFAULT_CSS}\n`);
    }
  } catch {
    /* 写不了就用内置默认 */
  }
}
/** HTTP 端点：模块读写与指令执行，避免 client 每次操作都写 profile patch。 */
async function handleStudioHttp(ctx, getModules, setModules, req, res, gate) {
  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad url' });
  }
  if (pathname === '/preset-studio/state' && (req.method === 'GET' || req.method === 'HEAD')) {
    return sendJson(res, 200, { ok: true, modules: getModules(), promptsDir: promptsDir() });
  }
  if (pathname === '/preset-studio/modules' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.modules)) return sendJson(res, 400, { ok: false, error: 'modules must be an array' });
    try {
      setModules(body.modules);
      return sendJson(res, 200, { ok: true, count: body.modules.length });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }
  if (pathname === '/preset-studio/command' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'invalid command' });
    try {
      await handleRequest(ctx, body);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }
  if (pathname === '/preset-studio/detected' && (req.method === 'GET' || req.method === 'HEAD')) {
    const state = readDetected();
    return sendJson(res, 200, { ok: true, baselineReady: Array.isArray(state.baseline), entries: state.entries });
  }
  if (pathname === '/preset-studio/rescan' && req.method === 'POST') {
    // 清空基线：下一次装配时把当前全部 section 当成新基线，之后新增的才视为「插件注入」。
    writeDetected({ baseline: null, entries: [] });
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/preset-studio/audit' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const result = await runAudit(ctx, body?.plugins, body?.force === true);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }
  if (pathname === '/preset-studio/skills' && (req.method === 'GET' || req.method === 'HEAD')) {
    const roots = skillRoots();
    const state = readSkillState();
    const listed = await listSkills(ctx);
    return sendJson(res, 200, {
      ok: true,
      roots,
      source: listed.source,
      disabled: state.disabled,
      skills: listed.skills,
    });
  }
  if (pathname === '/preset-studio/skills' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.disabled)) return sendJson(res, 400, { ok: false, error: 'disabled must be an array' });
    try {
      writeSkillState({ disabled: body.disabled.map(String) });
      return sendJson(res, 200, { ok: true, disabled: body.disabled });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }
  // ---- 提示词段门控 ----
  if (pathname === '/preset-studio/gate' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (gate === null || gate === undefined) return sendJson(res, 503, { ok: false, error: 'gate disabled' });
    return sendJson(res, 200, { ok: true, ...gate.snapshot() });
  }
  if (pathname === '/preset-studio/gate' && req.method === 'POST') {
    if (gate === null || gate === undefined) return sendJson(res, 503, { ok: false, error: 'gate disabled' });
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'invalid body' });
    try {
      if (body.op === 'bind') {
        const entry = gate.bind(body.name, body.sections);
        return sendJson(res, 200, { ok: true, entry });
      }
      const entry = gate.update(body);
      return sendJson(res, 200, { ok: true, entry });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  }
  if (pathname === '/preset-studio/gate/scan' && req.method === 'POST') {
    if (gate === null || gate === undefined) return sendJson(res, 503, { ok: false, error: 'gate disabled' });
    try {
      const body = await readJsonBody(req);
      const roots = [];
      if (Array.isArray(body?.roots)) roots.push(...body.roots.map(String));
      const dshHome = path.dirname(studioDir());
      roots.push(path.join(dshHome, 'node_modules'));
      try {
        for (const entry of fs.readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })) {
          if (entry.isDirectory()) roots.push(path.join(dshHome, 'profiles', entry.name, 'node_modules'));
        }
      } catch {
        /* 没有 profiles 目录 */
      }
      roots.push(path.join(path.dirname(process.execPath), 'resources', 'app', 'node_modules'));
      return sendJson(res, 200, { ok: true, roots, ...gate.scan(roots, { selfName: 'dsh-agent-preset-editor' }) });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }
  if (pathname === '/preset-studio/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    const detected = readDetected();
    const editor = ctx.get('configEditor');
    let addressable = null;
    try {
      addressable = editor ? editor.entries().filter((entry) => String(entry.options?.id ?? '').startsWith('preset-')).map((entry) => entry.options.id) : null;
    } catch {
      addressable = null;
    }
    return sendJson(res, 200, {
      ok: true,
      route: true,
      version: readVersion(),
      store: modulesFile(),
      modules: getModules().map((entry) => ({
        id: entry.id,
        section: entry.section,
        enabled: entry.enabled !== false,
        source: entry.source ?? 'user',
        presets: entry.presets,
        chars: typeof entry.text === 'string' ? entry.text.length : undefined,
        file: entry.file,
      })),
      promptsDir: promptsDir(),
      detected: { baselineReady: Array.isArray(detected.baseline), count: detected.entries.length },
      baselineSections: Array.isArray(detected.baseline) ? detected.baseline : [],
      configEditor: addressable !== null,
      editablePresetRows: addressable,
      skillRoots: skillRoots(),
      node: process.version,
    });
  }
  if (pathname === '/preset-studio/reset-style' && req.method === 'POST') {
    try {
      writeFileAtomic(styleFile(), `${DEFAULT_CSS}\n`);
      return sendJson(res, 200, { ok: true, bytes: DEFAULT_CSS.length });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }
  if (pathname === '/preset-studio/style.css') {
    const css = readStyle();
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
    res.end(css);
    return;
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

/** 从 assembly 上下文里取当前会话的 preset id。 */
function presetIdFromContext(context) {
  const session = context?.agent?.session ?? context?.session;
  return (
    session?.projectionValues?.agentPreset ??
    session?.header?.agentPreset ??
    session?.agentPreset ??
    'standard'
  );
}

/** 应用 `mode: 'remove'` 的模块：从装配结果里摘掉同名段。 */
function applyRemovals(mods, presetId, sections) {
  const removals = new Set(
    mods
      .filter((entry) => entry && entry.enabled !== false && entry.mode === 'remove' && appliesTo(entry, presetId))
      .map((entry) => entry.section)
      .filter(Boolean),
  );
  if (removals.size === 0) return sections;
  const kept = sections.filter((section) => !removals.has(section?.name));
  return kept.length === sections.length ? sections : kept;
}

/** 检测并纳管「插件自己注入的提示词段」。 */
function trackExternalSections(ctx, getModules, setModules, sections) {
  const state = readDetected();
  const names = sections.map((section) => section.name).filter((name) => typeof name === 'string');

  if (!Array.isArray(state.baseline)) {
    writeDetected({ baseline: names, entries: [] });
    ctx.logger?.info?.(`[preset-studio] baseline recorded: ${names.length} section(s)`);
    return;
  }

  const known = new Set(state.baseline);
  const ours = new Set(getModules().map((entry) => entry?.section).filter(Boolean));
  const fresh = [];

  for (const section of sections) {
    const name = section?.name;
    if (typeof name !== 'string') continue;
    if (known.has(name) || ours.has(name)) continue;
    if (state.entries.some((entry) => entry.section === name)) continue;
    const text = typeof section.text === 'string' ? section.text : '';
    if (text.trim().length === 0) continue;
    fresh.push({
      section: name,
      chars: text.length,
      head: text.slice(0, 160),
      text,
      firstSeen: new Date().toISOString(),
    });
  }
  if (fresh.length === 0) return;

  state.entries = [...state.entries, ...fresh];
  writeDetected(state);

  // 自动建成模块并**默认接管**：同名 section + 插件原文 + 全部 preset 生效。
  // 接管后的效果与原来一致（同样内容覆盖同一个段名），但这份文本从此可编辑、可按 preset 关闭。
  // 用户在某个 preset 里把它的生效范围去掉，就会走「注册空段」把它遮蔽掉（见 agent/created）。
  const modules = getModules();
  const additions = fresh
    .filter((entry) => !modules.some((mod) => mod?.section === entry.section))
    .map((entry) => ({
      id: `detected-${entry.section.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
      section: entry.section,
      order: 0,
      presets: '*',
      text: entry.text,
      enabled: true,
      source: 'detected',
      snapshotAt: new Date().toISOString(),
    }));
  if (additions.length > 0) {
    setModules([...modules, ...additions]);
    ctx.logger?.info?.(`[preset-studio] adopted ${additions.length} external section(s): ${additions.map((a) => a.section).join(', ')}`);
  }
}

export function apply(ctx, config = {}) {
  // 模块清单：文件优先；文件不存在时把 settings 里的旧值迁移过来（一次性）。
  let modules = readModulesFile();
  let needWrite = false;
  if (modules === null) {
    const legacy = currentModules(config);
    modules = legacy.length > 0 ? legacy : DEFAULT_MODULES;
    needWrite = true;
  }
  const migrated = migrateModules(modules);
  if (migrated !== null) {
    modules = migrated;
    needWrite = true;
    ctx.logger?.info?.('[preset-studio] migrated modules: base 改为排除 cordis，并补上创造模式专用提示词');
  }
  if (needWrite) {
    try {
      writeModulesFile(modules);
    } catch (error) {
      ctx.logger?.warn?.(`[preset-studio] cannot write ${modulesFile()}: ${String(error?.message ?? error)}`);
    }
  }
  const getModules = () => modules;
  const setModules = (list) => {
    modules = list;
    writeModulesFile(list);
  };
  ctx.logger?.info?.(`[preset-studio] host half ready (${modules.length} module(s)); store = ${modulesFile()}`);
  seedStyle();

  // 提示词段门控：host 平面插件注册的段默认对所有 preset 生效，
  // 这里让它变成「按 preset 自行启用」。默认 inherit，不动现状。
  let gate;
  try {
    gate = createGate({ dir: studioDir(), logger: ctx.logger });
    gate.load();
  } catch (error) {
    gate = null;
    ctx.logger?.warn?.(`[preset-studio] gate disabled: ${String(error?.message ?? error)}`);
  }

  // HTTP 通道：桌面端与 web 端都经 webserver 提供同源 fetch。
  ctx.inject(['webServer'], (child) => {
    child.effect(
      () =>
        child.webServer.register({
          kind: 'prefix',
          // 不能带尾斜杠：匹配逻辑是 pathname.startsWith(`${prefix}/`)
          path: '/preset-studio',
          handler: (req, res) => {
            void handleStudioHttp(ctx, getModules, setModules, req, res, gate);
          },
        }),
      'preset-studio:route',
    );
    ctx.logger?.info?.('[preset-studio] http route registered: /preset-studio/');
  });

  // 兼容通道：老客户端仍可能写 settings.request，保留事件订阅（无副作用）。
  let lastNonce = 0;
  const drain = () => {
    const raw = readVolatile(config.request);
    if (typeof raw !== 'string' || raw.length === 0) return;
    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      return;
    }
    if (request === null || typeof request !== 'object') return;
    if (typeof request.nonce !== 'number' || request.nonce <= lastNonce) return;
    lastNonce = request.nonce;
    void handleRequest(ctx, request).catch((error) => {
      ctx.logger?.warn?.(`[preset-studio] settings request failed: ${String(error?.message ?? error)}`);
    });
  };
  ctx.on('settings/updated', (ns) => {
    if (ns === 'preset-studio') drain();
  });

  // 外部提示词检测：装配后对比基线，发现「不是我们注入、也不是首次基线」的 section，
  // 就当作插件自带提示词纳管，并自动建一个同名模块（默认停用，避免重复注入）。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next();
    try {
      const rawSections = result?.sections ?? [];
      // 先记录「外部注入」（基线对比），再应用删除规则，顺序不能反。
      trackExternalSections(ctx, getModules, setModules, rawSections);
      // 门控引擎只观测（登记段名 / 长度 / 文本头），不改装配结果。
      try {
        gate?.observe(rawSections);
      } catch (error) {
        ctx.logger?.warn?.(`[preset-studio] gate observe failed: ${String(error?.message ?? error)}`);
      }
      const presetId = presetIdFromContext(context);
      const filtered = applyRemovals(getModules(), presetId, rawSections);
      return filtered === rawSections ? result : { ...result, sections: filtered };
    } catch (error) {
      ctx.logger?.warn?.(`[preset-studio] assemble hook failed: ${String(error?.message ?? error)}`);
      return result;
    }
  });

  // skill 单条开关：catalog 是 tool-skill 在 pre-step 渲染的一段文本，
  // registry 没有 disable API，所以在请求前把被禁用的行从文本里摘掉。
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    try {
      const state = readSkillState();
      const disabled = new Set(state.disabled ?? []);
      if (disabled.size === 0) return decision;
      const messages = decision?.messages ?? [];
      if (!messages.some((message) => message?.source?.kind === 'skill-catalog')) return decision;
      const nextMessages = messages.map((message) => {
        if (message?.source?.kind !== 'skill-catalog') return message;
        const content = (message.content ?? []).map((block) => {
          if (typeof block?.text !== 'string') return block;
          const filtered = filterCatalogText(block.text, disabled);
          return filtered === block.text ? block : { ...block, text: filtered };
        });
        return { ...message, content };
      });
      return { ...decision, messages: nextMessages };
    } catch (error) {
      ctx.logger?.warn?.(`[preset-studio] skill filter failed: ${String(error?.message ?? error)}`);
      return decision;
    }
  });

  ctx.on('agent/created', ({ agent }) => {
    // 用当前内存态（HTTP 写入会同步更新），新会话立即拿到最新模块。
    const mods = getModules();
    const presetId = presetIdOf(agent);
    const active = mods.filter((entry) => entry && entry.enabled !== false && appliesTo(entry, presetId));

    // 「按 preset 启用」的落点：外部来源的模块代表某个插件的全局注入。
    //  · 在范围内  → 注入它的文本（覆盖插件原文，内容可编辑）
    //  · 不在范围内 → 注册同名空文本段，把插件那段遮掉（= 这个 preset 不要它）
    // 用户在模块编辑里把范围改成「仅 standard」，创造模式里这段就自动消失。
    const detectedOutOfScope = mods.filter(
      (entry) => entry && entry.source === 'detected' && entry.enabled !== false && !appliesTo(entry, presetId),
    );

    // 门控引擎（历史遗留的独立策略）仍然可以被显式打开，但默认不参与，
    // 避免和上面的模块范围两套机制打架。
    let denied = new Set();
    try {
      denied = gate?.deniedFor(presetId) ?? new Set();
    } catch (error) {
      ctx.logger?.warn?.(`[preset-studio] gate resolve failed: ${String(error?.message ?? error)}`);
    }
    // 同一层里同名注册会抛错，模块自己占用的段名不再阴影。
    const moduleSections = new Set(active.map((entry) => entry?.section).filter(Boolean));
    const shadow = [...new Set([...denied, ...detectedOutOfScope.map((entry) => entry?.section)])].filter(
      (sectionName) => typeof sectionName === 'string' && sectionName.length > 0 && !moduleSections.has(sectionName) && !isCoreSection(sectionName),
    );

    if (active.length === 0 && shadow.length === 0) return;

    agent.ctx.inject(['systemPrompt'], (child) => {
      // 先遮蔽，再注入模块：模块的段名优先级高于门控。
      for (const sectionName of shadow) {
        child.systemPrompt.section({ name: sectionName, order: 0, text: '' });
      }
      if (shadow.length > 0) {
        ctx.logger?.info?.(`[preset-studio] gated ${shadow.length} section(s) out of preset "${presetId}": ${shadow.join(', ')}`);
      }
      for (const entry of active) {
        const text = readModuleText(entry);
        if (text === undefined || text.length === 0) {
          ctx.logger?.warn?.(`[preset-studio] module "${String(entry.id)}" has no text (file=${String(entry.file)})`);
          continue;
        }
        child.systemPrompt.section({
          name: entry.section ?? DEFAULT_SECTION,
          order: Number.isFinite(entry.order) ? entry.order : 0,
          text,
          ...(entry.interpolate === true ? { interpolate: true } : {}),
          ...(entry.complete === true ? { complete: true } : {}),
        });
      }
      if (active.length > 0) ctx.logger?.info?.(`[preset-studio] injected ${active.length} module(s) into preset "${presetId}"`);
    });
  });
}
