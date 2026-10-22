// 渲染冒烟测试：在没有浏览器的情况下把客户端那棵树渲染一遍。
//
// 为什么需要它：`pluginState is not defined` 这种错误是**第一帧就炸**的，静态检查抓不到，
// 之前只能靠用户重启后贴截图发现。app 里没有 react-dom（找过，只有 react），于是这里自己
// 走一遍元素树：真 React 只提供 createElement/createContext/Component，渲染、hook 状态、
// 重渲染由下面这个 renderer 实现。它不是 React 的替代品，是一个足够严的冒烟器：
//   · 组件体里任何未定义变量 / 空指针 / 写错的 props 都会抛，并报出组件名链
//   · hook 调用顺序在重渲染之间必须一致
//   · 渲染完等异步数据落地后再渲染一轮，然后模拟点击进入详情页再渲染
//
// 用法：node test/render.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const React = require('react');
const h = React.createElement;

let passed = 0;
const failures = [];
const ok = (label, value) => {
  if (value) {
    passed += 1;
    return;
  }
  failures.push(label);
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`);
};

// ---------------------------------------------------------------- 极简渲染器

const FRAGMENT = Symbol.for('react.fragment');
const PROVIDER = Symbol.for('react.provider');
const MEMO = Symbol.for('react.memo');
const FORWARD_REF = Symbol.for('react.forward_ref');

function isElement(value) {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

class Renderer {
  constructor() {
    this.slots = new Map(); // 实例路径 → hook 槽位
    this.effects = []; // 本轮要跑的 effect
    this.contexts = []; // context 值栈
    this.dirty = false;
    this.depth = 0;
  }

  /** 反复渲染直到没有 setState 引发的脏标记；渲染不收敛要报错，不能静默。 */
  render(root) {
    let tree = null;
    for (let pass = 0; pass < 40; pass += 1) {
      this.dirty = false;
      this.effects = [];
      this.depth = 0;
      this.contexts = [];
      tree = this.node(root, 'root');
      for (const effect of this.effects) {
        effect.run();
      }
      if (!this.dirty) return tree;
    }
    throw new Error('渲染不收敛：setState 在 40 轮内没有停下来');
  }

  contextValue(context) {
    for (let i = this.contexts.length - 1; i >= 0; i -= 1) {
      if (this.contexts[i].context === context) return this.contexts[i].value;
    }
    return context._currentValue;
  }

  node(value, key) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      return value.map((child, index) => this.node(child, `${key}.${index}`)).filter((child) => child !== null);
    }
    if (!isElement(value)) return null;

    const { type, props } = value;
    if (type === undefined || type === null) return null;
    if (type === FRAGMENT || type === React.Fragment) return this.children(props.children, key);
    if (type.$$typeof === PROVIDER) {
      this.contexts.push({ context: type._context, value: props.value });
      const out = this.children(props.children, key);
      this.contexts.pop();
      return out;
    }
    if (type.$$typeof === MEMO) return this.node({ ...value, type: type.type }, key);
    if (type.$$typeof === FORWARD_REF) return this.node({ ...value, type: (p) => type.render(p, null) }, key);
    if (typeof type === 'function') {
      if (type.prototype && type.prototype.isReactComponent) return this.classComponent(type, props, key);
      return this.functionComponent(type, props, key);
    }
    // 宿主元素保留成节点：onClick 等事件处理器在 props 上，摊平就没法模拟交互了
    return { tag: String(type), props, children: this.children(props.children, key) };
  }

  children(children, key) {
    return this.node(children, `${key}>`);
  }

  functionComponent(type, props, key) {
    const name = type.displayName || type.name || 'Anonymous';
    const slotsKey = `${key}#${name}`;
    let record = this.slots.get(slotsKey);
    if (record === undefined) {
      record = { hooks: [], cursor: 0, mounted: false };
      this.slots.set(slotsKey, record);
    }
    record.cursor = 0;
    const previous = Renderer.current;
    Renderer.current = record;
    this.depth += 1;
    try {
      const out = this.children(type(props), key);
      // hook 顺序自检：同一组件两次渲染的 hook 数量必须一致，不一致就是 React #300 的成因
      if (record.hookCount === undefined) record.hookCount = record.cursor;
      else if (record.hookCount !== record.cursor) {
        throw new Error(`hook 数量变了（上次 ${record.hookCount} 个，这次 ${record.cursor} 个）—— 有 hook 被条件调用`);
      }
      return out;
    } catch (error) {
      throw this.annotate(error, name);
    } finally {
      Renderer.current = previous;
      this.depth -= 1;
    }
  }

  classComponent(type, props, key) {
    const name = type.displayName || type.name || 'Anonymous';
    const slotsKey = `${key}#${name}`;
    let record = this.slots.get(slotsKey);
    if (record === undefined) {
      record = { instance: new type(props) };
      record.instance.updater = {
        isMounted: () => true,
        enqueueSetState: (target, partial) => {
          const patch = typeof partial === 'function' ? partial(target.state, target.props) : partial;
          target.state = { ...target.state, ...patch };
          this.dirty = true;
        },
        enqueueForceUpdate: () => {
          this.dirty = true;
        },
        enqueueReplaceState: (target, next) => {
          target.state = next;
          this.dirty = true;
        },
      };
      record.instance.props = props;
      record.instance.state = record.instance.state ?? null;
      if (typeof record.instance.componentDidMount === 'function') {
        this.effects.push({ run: () => record.instance.componentDidMount() });
      }
      this.slots.set(slotsKey, record);
    }
    record.instance.props = props;
    this.depth += 1;
    try {
      return this.children(record.instance.render(), key);
    } catch (error) {
      // 错误边界：类组件里声明了 getDerivedStateFromError 就让它接住
      if (typeof type.getDerivedStateFromError === 'function') {
        record.instance.state = { ...record.instance.state, ...type.getDerivedStateFromError(error) };
        return this.children(record.instance.render(), key);
      }
      throw this.annotate(error, name);
    } finally {
      this.depth -= 1;
    }
  }

  annotate(error, name) {
    const wrapped = new Error(`组件 ${name} 渲染失败：${error && error.message ? error.message : String(error)}`);
    wrapped.cause = error;
    wrapped.stack = `${wrapped.message}\n${error && error.stack ? error.stack.split('\n').slice(1, 6).join('\n') : ''}`;
    return wrapped;
  }
}

// ---------------------------------------------------------------- hook 实现

Renderer.current = null;

function record() {
  const current = Renderer.current;
  if (current === null) throw new Error('hook 在组件外被调用');
  const index = current.cursor;
  current.cursor += 1;
  if (current.hooks[index] === undefined) current.hooks[index] = { value: undefined, deps: undefined };
  return { hooks: current.hooks, index };
}

function sameDeps(prev, next) {
  if (prev === undefined) return false;
  if (prev.length !== next.length) return false;
  return prev.every((item, index) => Object.is(item, next[index]));
}

const hook = {
  useState(initial) {
    const { hooks, index } = record();
    if (hooks[index].value === undefined) hooks[index].value = typeof initial === 'function' ? initial() : initial;
    const setter = (next) => {
      const slot = hooks[index];
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      const active = Renderer.active;
      if (active !== null) active.dirty = true;
    };
    return [hooks[index].value, setter];
  },
  useRef(initial) {
    const { hooks, index } = record();
    if (hooks[index].value === undefined) hooks[index].value = { current: initial };
    return hooks[index].value;
  },
  useMemo(factory, deps) {
    const { hooks, index } = record();
    if (!sameDeps(hooks[index].deps, deps)) {
      hooks[index].value = factory();
      hooks[index].deps = deps;
    }
    return hooks[index].value;
  },
  useCallback(factory, deps) {
    return hook.useMemo(() => factory, deps);
  },
  useEffect(effect, deps) {
    const { hooks, index } = record();
    const changed = !sameDeps(hooks[index].deps, deps);
    hooks[index].deps = deps;
    if (!changed) return undefined;
    const active = Renderer.active;
    active.effects.push({
      run: () => {
        const cleanup = effect();
        return cleanup;
      },
    });
    return undefined;
  },
  useLayoutEffect(effect, deps) {
    return hook.useEffect(effect, deps);
  },
  useContext(context) {
    const active = Renderer.active;
    return active.contextValue(context);
  },
};

function installDispatcher() {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  internals.ReactCurrentDispatcher.current = hook;
}

// ---------------------------------------------------------------- 假环境

function makeDom() {
  const styles = new Map();
  const document = {
    visibilityState: 'visible',
    head: {
      appendChild: (el) => {
        styles.set(el.dataset?.pluginCss ?? el.getAttribute?.('data-plugin-css') ?? '', el);
        return el;
      },
    },
    querySelector: (selector) => {
      const matched = /\[([^\]=]+)="([^"]+)"\]/.exec(selector);
      if (matched === null) return null;
      return styles.get(matched[2]) ?? null;
    },
    createElement: (tag) => ({
      tagName: String(tag).toUpperCase(),
      dataset: {},
      attributes: {},
      textContent: '',
      setAttribute(key, value) {
        this.attributes[key] = value;
        if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
      },
      getAttribute(key) {
        return this.attributes[key] ?? this.dataset[key.slice(5)] ?? null;
      },
      remove() {
        styles.delete(this.dataset.pluginCss);
      },
      parentNode: null,
    }),
  };
  const timers = new Set();
  const window = {
    document,
    location: { href: 'http://127.0.0.1:43120/' },
    setInterval: (fn) => {
      timers.add(fn);
      return timers.size;
    },
    clearInterval: () => {},
    setTimeout: (fn) => {
      timers.add(fn);
      return timers.size;
    },
    clearTimeout: () => {},
  };
  return { document, window, timers };
}

const STYLE_CSS = '.psx-section{display:flex}';

function makeFetch(log) {
  return async (url, init) => {
    const target = String(url);
    log.push(target);
    if (target.includes('/style.css')) {
      return { ok: true, status: 200, headers: { get: () => 'text/css' }, text: async () => STYLE_CSS, json: async () => ({}) };
    }
    const body = (() => {
      if (target.includes('/state')) return { ok: true, modules: [], promptsDir: 'C:/tmp/prompts' };
      if (target.includes('/health')) return { ok: true, baselineSections: [], version: 'test', channel: 'http' };
      if (target.includes('/skills')) return { ok: true, skills: [], includeDefaultRoots: true, customSkillDirs: [], disabled: [] };
      if (target.includes('/detected')) return { ok: true, modules: [] };
      if (target.includes('/gate/scan')) return { ok: true, sections: [], found: 0 };
      if (target.includes('/audit')) return { ok: true, text: '没有发现冲突', provider: 'test', model: 'test-model' };
      return { ok: true };
    })();
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

function makeSlots() {
  // 照真机：插件拿到的 ctx.slots 是渲染器 Service 外壳（dsh-client-ui-renderer/lib/client.js:1304 起），
  // 只有 inject / register / entries / subscribe（微任务通知）/ getVersion——没有 records、markDirty、onMutate。
  const record = { entries: [], version: 0 };
  const listeners = new Set();
  const registered = [];
  const announce = () => {
    record.version += 1;
    queueMicrotask(() => {
      for (const listener of [...listeners]) listener();
    });
  };
  const slots = {
    inject: (_name, callback) => {
      const result = callback();
      return typeof result === 'function' ? result : () => {};
    },
    register: (options, component) => {
      const entry = { component, options: { ...options } };
      registered.push(entry);
      record.entries = [...record.entries, entry];
      announce();
      return () => {
        record.entries = record.entries.filter((item) => item !== entry);
        announce();
      };
    },
    entries: (key) => (key === 'settings.section' ? record.entries : []),
    subscribe: (key, listener) => {
      if (key !== 'settings.section') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => record.version,
  };
  return { slots, registered, record, announce };
}

/**
 * 模拟官方 dsh-client-ui-agent-preset 的登记——现实里它总比我们晚一步。
 * 条目形状与 SlotCore 一致：`{ component, options }`。
 */
function registerOfficialPlugin({ record, announce }) {
  const entry = {
    component: () => null,
    options: { id: 'agent-presets', order: 20, label: () => 'Agent 预设' },
  };
  // 记一份出厂渲染体：announce() 会同步触发接管，之后 entry.component 已经不是原装了。
  entry.__origin = entry.component;
  record.entries = [...record.entries, entry];
  announce();
  return entry;
}

/** 假的 preset 名单：列表页应该为每一条渲染一张卡片。 */
const presets = [
  { id: 'standard', name: '标准模式', description: '处理代码、文件和资料，适合大多数任务。', isDefault: true },
  { id: 'cordis', name: '创造模式', description: '用对话定制 DSH。' },
];

function makeCtx(slots) {
  const inventory = {
    entries: [
      {
        entryId: 'preset-studio-test',
        moduleName: 'dsh-agent-preset-editor',
        meta: { name: 'dsh-agent-preset-editor' },
        enabled: true,
      },
      { entryId: 'dsh-tool-bash', moduleName: '@deepseek-ai/dsh-tool-bash', meta: {}, enabled: true },
    ],
    agentPresets: [
      {
        id: 'standard',
        isDefault: true,
        rows: [
          { entryId: 'dsh-tool-bash', moduleName: '@deepseek-ai/dsh-tool-bash', meta: {}, enabled: true },
          { entryId: 'dsh-skill-filesystem', moduleName: '@deepseek-ai/dsh-skill-filesystem', meta: {}, enabled: true },
        ],
      },
    ],
  };
  const configForms = {
    get: (ns) => ({
      getSnapshot: () => ({
        status: 'ready',
        writable: true,
        revision: 1,
        value: ns === 'agent-preset-registry' ? { selectedDefault: 'standard', modules: [] } : { enabled: true },
      }),
    }),
  };
  return {
    effect: (factory) => {
      const cleanup = factory();
      return typeof cleanup === 'function' ? cleanup : () => {};
    },
    inject: (_names, callback) => callback(),
    slots,
    locale: { bind: () => () => 'Agent 预设' },
    get: (name) => (name === 'uiWorkspace' ? { startSession: () => {} } : undefined),
    configForms,
    remote: {
      agentPresets: {
        list: async () => ({ ok: true, value: { presets } }),
        read: async () => ({ ok: true, value: { plugins: inventory.entries } }),
        select: async () => ({ ok: true }),
      },
      pluginInventory: { list: async () => ({ ok: true, value: inventory }) },
      settings: { update: async () => ({ ok: true }) },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
  };
}

// ---------------------------------------------------------------- 跑起来

const dom = makeDom();
globalThis.window = dom.window;
globalThis.document = dom.document;
globalThis.fetch = makeFetch([]);
installDispatcher();

const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
let factory = null;
globalThis.window.__ModuleLoader__ = {
  load: (definition) => {
    factory = definition.factory;
  },
};

const fakeRequire = (name) => {
  if (name === 'react') return React;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
  return {};
};

// 把 bundle 文本当函数跑一遍：它只有一条语句 window.__ModuleLoader__.load({...})。
new Function(source)();
if (typeof factory !== 'function') throw new Error('bundle 没有调用 __ModuleLoader__.load');
const module = factory(fakeRequire);
ok('客户端模块导出了 apply', typeof module?.apply === 'function');
ok('declare 了 inject', Array.isArray(module?.inject) && module.inject.includes('slots'));

const slotsFixture = makeSlots();
const { slots, registered, record: sectionRecord } = slotsFixture;
const ctx = makeCtx(slots);
Renderer.active = null;

try {
  module.apply(ctx);
  passed += 1;
} catch (error) {
  failures.push(`apply 抛错：${error.message}`);
}

// apply 时官方那条还没注册（现实里也确实比我们晚）：什么都别建，等它出现。
check('假件没有 records（和真机一样）', 'records' in slots, false);
check('官方没来时一条也不注册（不造第二个入口）', registered.length, 0);
check('登记表此时是空的', sectionRecord.entries.length, 0);
check('diag 说清原因', globalThis.window.__presetStudioDiag?.why, 'official-not-registered-yet');

// 官方插件此刻注册 —— 我们应该当场把它的渲染体换成我们的，条目本身不动。
const official = registerOfficialPlugin(slotsFixture);
const officialOriginal = official.__origin;
await new Promise((resolve) => setTimeout(resolve, 0)); // subscribe 是微任务通知
check('登记表里只有官方那一条', sectionRecord.entries.filter((entry) => entry.options.id === 'agent-presets').length, 1);
ok('留下的是官方注册的那条（我们没另建）', sectionRecord.entries.includes(official));
check('登记表里没留下我们注册的条目（版本自增用的临时条目已释放）', sectionRecord.entries.length, 1);
ok('官方那条的渲染体被换成了我们的', official.component !== officialOriginal);
check('diagnostic 报告接管成功', globalThis.window.__presetStudioDiag?.mode, 'takeover');
const renderComponent = official.component;

// 第一帧：列表页
const renderer = new Renderer();
Renderer.active = renderer;
let tree = null;
try {
  tree = renderer.render(h(renderComponent, {}));
  passed += 1;
} catch (error) {
  failures.push(`列表页渲染抛错：${error.message}\n${error.stack ?? ''}`);
}
ok('列表页渲染出内容', textOf(tree).length > 0);

/** 节点的纯文本。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node.props) return textOf(node.children ?? node.props.children);
  return "";
}

/** 子节点：宿主节点的渲染结果在 children 上，raw 元素在 props.children 上。 */
function kids(node) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) return node;
  return node.children ?? node.props?.children ?? null;
}

/** 按 className 找节点（自外向内）。 */
function findByClass(node, className, hits = []) {
  if (node === null || node === undefined || typeof node !== "object") return hits;
  if (Array.isArray(node)) {
    for (const child of node) findByClass(child, className, hits);
    return hits;
  }
  const own = node.props?.className;
  if (typeof own === "string" && own.split(/\s+/).includes(className)) hits.push(node);
  findByClass(kids(node), className, hits);
  return hits;
}

/** 按文本找节点（自外向内），用来模拟点击。 */
function findByText(node, text, hits = []) {
  if (node === null || node === undefined || typeof node !== "object") return hits;
  if (Array.isArray(node)) {
    for (const child of node) findByText(child, text, hits);
    return hits;
  }
  if (textOf(node).includes(text)) hits.push(node);
  findByText(kids(node), text, hits);
  return hits;
}

const shellText = textOf(tree);
ok("列表页外壳渲染出标题", shellText.includes("Agent 预设"));
ok("列表页外壳渲染出引导语", shellText.includes("标准模式") || shellText.includes("工具和工作方式"));
ok("数据落地前不显示卡片", findByClass(tree, "psx-card").length === 0);

// 异步数据落地后再渲染（fetch/remote 都是 promise）
await new Promise((resolve) => setTimeout(resolve, 30));
try {
  tree = renderer.render(h(renderComponent, {}));
  passed += 1;
} catch (error) {
  failures.push(`数据落地后渲染抛错：${error.message}
${error.stack ?? ""}`);
}

const cardsNow = findByClass(tree, "psx-card");
ok("数据落地后渲染出预设卡片", cardsNow.length === presets.length);
ok(
  "卡片上写着 preset 名称",
  findByClass(tree, "psx-cardName").map((node) => textOf(node)).join("|").includes("标准模式"),
);
ok("卡片上写着 preset id", findByClass(tree, "psx-cardId").map((node) => textOf(node)).join("|").includes("cordis"));

// 点第一张卡片 → 进入详情页（Detail 的渲染体就是 pluginState 那次崩的地方）
const cards = findByClass(tree, 'psx-iconButton').filter((node) => typeof node.props?.onClick === 'function');
if (cards.length === 0) {
  failures.push('没找到可点击的预设卡片');
} else {
  try {
    cards[0].props.onClick();
    tree = renderer.render(h(renderComponent, {}));
    passed += 1;
  } catch (error) {
    failures.push(`详情页渲染抛错：${error.message}\n${error.stack ?? ''}`);
  }
  const detailText = textOf(tree);
  ok("详情页显示 preset id", detailText.includes("standard"));
  ok("详情页出现系统提示词模块区", detailText.includes("系统提示词模块"));
  ok("详情页出现插件区", detailText.includes("插件"));
  ok("详情页出现 MCP 工具区", detailText.includes("MCP 工具"));
  ok("详情页出现 Skill 区", detailText.includes("Skill"));

  // 详情页里的按钮：点「检查」/「详细」/「AI 检查」都不该抛（找不到按钮要报错，不能静默跳过）
  for (const label of ["检查", "详细", "AI 检查"]) {
    const buttons = findByText(tree, label).filter((node) => typeof node.props?.onClick === "function");
    if (buttons.length === 0) {
      failures.push(`详情页没找到「${label}」按钮`);
      continue;
    }
    try {
      buttons[0].props.onClick();
      tree = renderer.render(h(renderComponent, {}));
      passed += 1;
    } catch (error) {
      failures.push(`点「${label}」后渲染抛错：${error.message}`);
    }
  }
  // 返回列表再进详情一次：hook 顺序不一致会在这里炸
  const back = findByClass(tree, 'psx-back');
  if (back.length === 0) {
    failures.push('详情页没找到返回按钮');
  } else {
    try {
      back[0].props.onClick();
      tree = renderer.render(h(renderComponent, {}));
      const again = findByClass(tree, 'psx-iconButton').filter((node) => typeof node.props?.onClick === 'function');
      again[0].props.onClick();
      tree = renderer.render(h(renderComponent, {}));
      passed += 1;
    } catch (error) {
      failures.push(`返回-再进入抛错：${error.message}`);
    }
  }
}

// harness 自检：组件抛错必须被报成「组件 X 渲染失败：原因」，不能静默吞掉
try {
  renderer.render(h(function Boom() { throw new Error("boom"); }, {}));
  failures.push("渲染器把组件抛错吞掉了");
} catch (error) {
  ok("组件抛错被渲染器报出来（带组件名）", String(error.message).includes("Boom") && String(error.message).includes("boom"));
}

// harness 自检：hook 条件调用必须被抓到（这就是 React #300 的成因）
try {
  const Probe = (props) => {
    hook.useState(0);
    if (props.extra) hook.useRef(null);
    return h("span", null, "probe");
  };
  renderer.render(h(Probe, { extra: false }));
  renderer.render(h(Probe, { extra: true }));
  failures.push("渲染器没抓到 hook 条件调用");
} catch (error) {
  ok("hook 条件调用被抓到", String(error.message).includes("hook 数量变了"));
}

// ---------------------------------------------------------------- 结果
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('');
  for (const failure of failures) console.log(`✗ ${failure}`);
  process.exit(1);
}
// 客户端自己会留定时器（样式轮询等），事件循环不会自己排空 —— 显式退出
process.exit(0);
