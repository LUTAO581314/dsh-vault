/**
 * gate.js — 提示词段门控引擎（dsh-agent-preset-editor 的 host 半）
 *
 * 要解决的问题
 * ------------
 * host 平面上的插件往 system prompt 注册段时，对**所有** preset 的会话都生效。
 * 本引擎把它改成「按 preset 自行启用」：
 *
 *   · 默认策略 inherit —— 检测到就登记、不改变现状（不会因为升级突然少一段提示词）
 *   · 用户把某段 / 某插件切成 gate 后，未勾选的 preset 里那段就不出现
 *
 * 为什么用「同名空文本段」而不是从装配结果里删
 * --------------------------------------------
 * dsh-scope 的 merge 先写 global、再按 scope 链由远到近覆盖，最近的 scope 最终胜出；
 * dsh-system-prompt 的 section() 文档也写着「scoped section 遮蔽全局同名段」。
 * 所以在本 agent 的 scope 里注册一个同名、text 为空的段，就等于让这段消失：
 * renderPrompt 会丢弃空文本段。这条路是宿主 sanctioned 的 per-agent override，
 * 比在 system-prompt/assemble 里每帧过滤更彻底（装配期过滤对 complete 段无效）。
 *
 * 边界（做不到的，别指望）
 * ------------------------
 * 只能门控「注册成 system prompt section」的东西。
 * 注入 user 消息（agent.steer）、改 composer 草稿、改 UI 的插件，都不经过装配，
 * 本引擎管不到。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 永远不许 gate 的段：动了 agent 就失能。 */
const CORE_EXACT = new Set(['plan', 'harness:identity']);
const CORE_PREFIX = ['harness:', 'tool:', 'tools:', 'mcp:', 'deployment:persona-', 'plan:', 'team:', 'context:'];

/** @param {string} name 段名 */
export function isCoreSection(name) {
  if (typeof name !== 'string' || name.length === 0) return true;
  if (CORE_EXACT.has(name)) return true;
  return CORE_PREFIX.some((prefix) => name.startsWith(prefix));
}

const SCHEMA = 1;

/** @param {string} file */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 建一个门控引擎。
 * @param {{ dir: string, logger?: { info?: Function, warn?: Function } }} options
 */
export function createGate({ dir, logger }) {
  const file = path.join(dir, 'gates.json');

  /** @type {{ schema: number, sections: Record<string, any>, plugins: Record<string, any> }} */
  let state = { schema: SCHEMA, sections: {}, plugins: {} };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        state = {
          schema: SCHEMA,
          sections: parsed.sections && typeof parsed.sections === 'object' ? parsed.sections : {},
          plugins: parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {},
        };
      }
    } catch {
      /* 首次运行没有文件 */
    }
    return state;
  }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
      return true;
    } catch (error) {
      logger?.warn?.(`[preset-studio] cannot write ${file}: ${String(error?.message ?? error)}`);
      return false;
    }
  }

  /**
   * 登记一次装配看到的段。只记录，不改行为。
   * @param {Array<{ name?: string, text?: string }>} sections 装配出的段
   */
  function observe(sections) {
    if (!Array.isArray(sections)) return;
    let dirty = false;
    for (const section of sections) {
      const name = section?.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      const text = typeof section?.text === 'string' ? section.text : '';
      const existing = state.sections[name];
      if (existing === undefined) {
        state.sections[name] = {
          policy: 'inherit',
          core: isCoreSection(name),
          chars: text.length,
          head: text.slice(0, 160),
          firstSeen: new Date().toISOString(),
          presets: {},
        };
        dirty = true;
        continue;
      }
      // 只更新观测字段，不动 policy / presets。
      const nextChars = text.length;
      const nextHead = text.slice(0, 160);
      if (existing.chars !== nextChars || existing.head !== nextHead) {
        existing.chars = nextChars;
        existing.head = nextHead;
        dirty = true;
      }
      if (existing.core === undefined) {
        existing.core = isCoreSection(name);
        dirty = true;
      }
    }
    if (dirty) save();
  }

  /**
   * 该 preset 下应当被遮蔽的段名。
   * @param {string} presetId
   * @returns {Set<string>}
   */
  function deniedFor(presetId) {
    const denied = new Set();
    const pluginGate = (name) => {
      for (const plugin of Object.values(state.plugins)) {
        if (plugin?.policy !== 'gate') continue;
        if (!Array.isArray(plugin.sections) || !plugin.sections.includes(name)) continue;
        if (plugin.presets?.[presetId] === true) continue;
        return true;
      }
      return false;
    };
    for (const [name, entry] of Object.entries(state.sections)) {
      if (entry?.core === true || isCoreSection(name)) continue;
      const ownGate = entry?.policy === 'gate' && entry.presets?.[presetId] !== true;
      if (ownGate || pluginGate(name)) denied.add(name);
    }
    return denied;
  }

  /** 给客户端看的全量快照。 */
  function snapshot() {
    const sections = Object.entries(state.sections)
      .map(([name, entry]) => ({
        name,
        policy: entry?.policy ?? 'inherit',
        core: entry?.core === true || isCoreSection(name),
        chars: entry?.chars ?? 0,
        head: entry?.head ?? '',
        presets: entry?.presets ?? {},
        owner: entry?.owner ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const plugins = Object.entries(state.plugins).map(([key, entry]) => ({
      key,
      policy: entry?.policy ?? 'inherit',
      sections: Array.isArray(entry?.sections) ? entry.sections : [],
      presets: entry?.presets ?? {},
    }));
    return { schema: state.schema, file, sections, plugins };
  }

  /**
   * 改一条记录的开关。
   * @param {{ kind?: 'section'|'plugin', name: string, policy?: 'inherit'|'gate', presetId?: string, enabled?: boolean }} input
   */
  function update(input) {
    const kind = input?.kind === 'plugin' ? 'plugins' : 'sections';
    const name = String(input?.name ?? '');
    if (name.length === 0) throw new Error('name required');
    if (kind === 'sections' && isCoreSection(name)) throw new Error(`section "${name}" is core and cannot be gated`);

    state[kind][name] ??= { policy: 'inherit', presets: {} };
    const entry = state[kind][name];

    if (input.policy === 'inherit' || input.policy === 'gate') {
      if (input.policy === 'gate' && kind === 'sections' && state.sections[name]?.chars === 0) {
        throw new Error(`section "${name}" is currently empty; gating it changes nothing`);
      }
      entry.policy = input.policy;
    }
    if (typeof input.presetId === 'string' && typeof input.enabled === 'boolean') {
      entry.presets ??= {};
      entry.presets[input.presetId] = input.enabled;
    }
    save();
    return entry;
  }

  /**
   * 把一批段绑到某个插件名下，之后可以按插件整体 gate。
   * @param {string} key 插件名（包名）
   * @param {string[]} sections 段名
   */
  function bind(key, sections) {
    const name = String(key ?? '');
    if (name.length === 0) throw new Error('plugin name required');
    const list = (Array.isArray(sections) ? sections : []).map(String).filter((item) => item.length > 0);
    state.plugins[name] ??= { policy: 'inherit', presets: {}, sections: [] };
    const merged = new Set([...(state.plugins[name].sections ?? []), ...list]);
    state.plugins[name].sections = [...merged];
    for (const section of list) state.sections[section] ??= { policy: 'inherit', presets: {}, core: isCoreSection(section) };
    for (const section of list) state.sections[section].owner = name;
    save();
    return state.plugins[name];
  }

  /**
   * 静态扫描：哪些已装插件在往 system prompt 注册段。
   *
   * 运行时拿不到归属（装配出的段只有 name/text），只能读源码猜，必然有漏。
   * 三段式：① 挑候选包 ② 建全局常量表（跨包解析 PERSONA_PREFIX_SECTION 这类）
   * ③ 匹配 section 调用并解析 name。
   * @param {string[]} roots node_modules 根
   * @param {{ selfName?: string }} [options] 排除本插件自己
   * @returns {{ packages: Array<{ name: string, sections: string[] }>, scanned: number }}
   */
  function scan(roots, options = {}) {
    const SECTION_CALL = /systemPrompt\s*\.\s*section\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
    const NAME_FIELD = /\bname\s*:\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`|([A-Za-z_$][\w$]*))/;
    const CONST_DEF = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]([^'"`]+)['"`]/g;

    // ① 挑候选包
    const packages = [];
    let scanned = 0;
    for (const root of Array.isArray(roots) ? roots : []) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      const dirs = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name.startsWith('@')) {
          try {
            for (const inner of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
              if (inner.isDirectory() || inner.isSymbolicLink()) dirs.push(path.join(root, entry.name, inner.name));
            }
          } catch {
            /* 忽略不可读的 scope 目录 */
          }
        } else {
          dirs.push(path.join(root, entry.name));
        }
      }
      for (const pkgDir of dirs) {
        let manifest;
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        } catch {
          continue;
        }
        const pkgName = typeof manifest?.name === 'string' ? manifest.name : path.basename(pkgDir);
        if (options.selfName !== undefined && pkgName === options.selfName) continue;
        const looksDsh = manifest?.dsh !== undefined || pkgName.startsWith('@deepseek-ai/') || /(^|\/)dsh[-/]/.test(pkgName);
        if (!looksDsh) continue;
        scanned += 1;
        const files = [];
        files.push(path.join(pkgDir, typeof manifest.main === 'string' ? manifest.main : 'index.js'));
        try {
          for (const libFile of fs.readdirSync(path.join(pkgDir, 'lib'))) {
            if (libFile.endsWith('.js')) files.push(path.join(pkgDir, 'lib', libFile));
          }
        } catch {
          /* 没有 lib 目录 */
        }
        const sources = [];
        for (const entry of files) {
          try {
            if (fs.statSync(entry).size > 2 * 1024 * 1024) continue;
            sources.push(fs.readFileSync(entry, 'utf8'));
          } catch {
            /* 读不到就跳过 */
          }
        }
        if (sources.length > 0) packages.push({ name: pkgName, sources });
      }
    }

    // ② 全局常量表（跨包，解析 dsh-persona 引用的 PERSONA_PREFIX_SECTION）
    const consts = new Map();
    for (const pkg of packages) {
      for (const text of pkg.sources) {
        CONST_DEF.lastIndex = 0;
        for (let hit = CONST_DEF.exec(text); hit !== null; hit = CONST_DEF.exec(text)) consts.set(hit[1], hit[2]);
      }
    }

    // ③ 匹配 section 调用
    const found = [];
    for (const pkg of packages) {
      const sections = new Set();
      for (const text of pkg.sources) {
        SECTION_CALL.lastIndex = 0;
        for (let hit = SECTION_CALL.exec(text); hit !== null; hit = SECTION_CALL.exec(text)) {
          const field = NAME_FIELD.exec(hit[1]);
          if (field === null) continue;
          const literal = field[1] ?? field[2] ?? field[3];
          if (typeof literal === 'string' && literal.length > 0) {
            // 模板字面量（tool:${toolName}）解析不出真实段名，跳过，别制造假条目。
            if (!literal.includes('${')) sections.add(literal);
            continue;
          }
          const ident = field[4];
          if (typeof ident === 'string' && consts.has(ident)) sections.add(consts.get(ident));
        }
      }
      if (sections.size > 0) found.push({ name: pkg.name, sections: [...sections].sort() });
    }
    found.sort((a, b) => a.name.localeCompare(b.name));
    logger?.info?.(`[preset-studio] gate scan: ${found.length} package(s) inject sections out of ${scanned} dsh package(s)`);
    return { packages: found, scanned };
  }

  return { load, save, observe, deniedFor, snapshot, update, bind, scan, file };
}
