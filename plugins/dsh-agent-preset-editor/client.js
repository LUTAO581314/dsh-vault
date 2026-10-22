/**
 * Client half of dsh-preset-studio — M2：卡片 → 详情页（只读）。
 *
 * M1 已接管官方「Agent 预设」整格（同 id + priority -1，并拦截 entries() 隐藏官方导航项）。
 * M2 增加页内子页面：点卡片右下角图标进入，展示该 preset 初始携带的
 * 插件 / MCP / Skill / 提示词模块。增删与保存是 M3，提示词编辑器是 M4。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-preset-editor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, memo } = React;

    let P = {};
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives') || {};
    } catch (error) {
      console.warn('[preset-studio] primitives unavailable:', error);
    }

    const Tag = P.Tag || ((props) => h('span', null, props.children));
    const Button = P.Button || ((props) => h('button', { type: 'button', onClick: props.onClick, disabled: props.disabled }, props.children));
    const IconBrowse = P.IconBrowseOutlineRegular;
    const IconPlus = P.IconPlusOutlineRegular;
    const IconClose = P.IconCloseOutlineRegular;
    const IconChevronLeft = P.IconChevronLeftOutlineRegular;
    const IconChevronDown = P.IconChevronDownOutlineRegular;

    const NS = 'agent-preset-registry';

    const COPY = {
      nav: 'Agent 预设',
      intro: '选择 Agent 的工具和工作方式。日常任务用「标准模式」，扩展 DSH 的能力用「创造模式」。',
      builtIn: '内置',
      promptPresets: '系统提示词预设',
      custom: '自定义',
      inUse: '新任务默认',
      setDefault: '设为新任务默认',
      configure: '配置',
      noDescription: '暂无描述。',
      emptyPrompt: '尚未安装提示词模块插件。',
      creator: '让 Agent 帮我创建预设模式',
      back: '返回',
      plugins: '插件',
      mcp: 'MCP 工具',
      skills: 'Skill',
      modules: '系统提示词模块',
      loading: '加载中…',
      none: '无',
      broken: '该预设加载失败，暂时无法查看配置',
      rowDisabled: '已禁用',
      rowConditional: '条件启用',
      rowFailed: '挂载失败',
      footerNote: '仅对之后新建的会话生效；已存在的会话保留它开始时的配置。',
      comingSoon: 'M4 接入',
      moduleTitle: '系统提示词模块',
      moduleAdd: '+ 添加模块',
      moduleEmpty: '当前没有提示词模块。',
      moduleSave: '保存',
      moduleCancel: '取消',
      moduleDelete: '删除',
      moduleDeleteHint: '只删除这条自定义模块，不影响 DSH 自带的提示词',
      moduleEdit: '编辑',
      moduleInline: '内联',
      moduleFile: '文件',
      moduleApplies: '适用于本 preset',
      moduleSkipped: '不适用于本 preset',
      moduleEnable: '启用',
      moduleEnableOn: '启用',
      moduleDisable: '停用',
      moduleOn: '已启用',
      moduleOff: '已停用',
      moduleSection: 'section 名',
      moduleOrder: 'order',
      moduleScope: '生效范围',
      moduleText: '正文',
      moduleSaved: '已保存，新会话生效',
      moduleHint: 'DSH 自带的提示词段由各插件注册，永远保留、本系统删不掉；这里管理的是叠加在它们之上的自定义模块。删除本条只会让 system prompt 回到官方原样。',
    };

    const BUILT_IN = {
      standard: { name: '标准模式', description: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。' },
      ptc: { name: 'PTC 模式', description: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。' },
      minimal: { name: '极简模式', description: 'Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。' },
      cordis: { name: '创造模式', description: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。' },
    };

    const isBuiltIn = (row) => row.name === undefined && BUILT_IN[row.id] !== undefined;
    const display = (row) => ({
      name: isBuiltIn(row) ? BUILT_IN[row.id].name : (row.name ?? row.id),
      description: isBuiltIn(row) ? BUILT_IN[row.id].description : row.description,
    });
    const requiresCodingTools = (row) => isBuiltIn(row) && (row.id === 'ptc' || row.id === 'minimal');

    const shortName = (moduleName) => {
      const tail = String(moduleName ?? '').split('/').pop() ?? '';
      return tail || String(moduleName ?? '');
    };

    // ---- 样式表 ----
    // CSS 不再内联：host 提供 GET /preset-studio/style.css（默认样式 + 用户可编辑文件），
    // 这里在激活时拉一次并注入。拉不到就用最小兜底，页面仍可用。
    const FALLBACK_CSS = '.psx-section{display:flex;flex-direction:column;gap:16px;padding:4px 0}.psx-error{color:#c0392b}';
    let styleInjected = null;
    async function loadStyle() {
      const key = 'data-plugin-css';
      const id = 'dsh-preset-studio/style.css';
      const existing = document.querySelector(`style[${key}="${id}"]`);
      let css = FALLBACK_CSS;
      try {
        const response = await fetch('/preset-studio/style.css', { cache: 'no-store' });
        if (response.ok) {
          const text = await response.text();
          if (text.trim().length > 0) css = text;
        }
      } catch {
        /* 用兜底样式 */
      }
      if (existing !== null) {
        existing.textContent = css;
        return;
      }
      const el = document.createElement('style');
      el.setAttribute(key, id);
      el.textContent = css;
      document.head.appendChild(el);
    }

    /** 样式热更新：每 5 秒重拉一次，页面隐藏时暂停。改 style.css 不用刷新。 */
    function watchStyle() {
      if (typeof document === 'undefined') return () => {};
      const timer = setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        void loadStyle();
      }, 5000);
      return () => clearInterval(timer);
    }



    /** 插件分类：市场索引当前不可达，先按包名与功能归组；将来接入市场分类时替换这里即可。 */
    function categoryOf(moduleName) {
      const name = String(moduleName ?? '');
      if (name.startsWith('@deepseek-ai/')) {
        const tail = name.split('/')[1] ?? '';
        if (tail.startsWith('tool-')) return '官方 · 工具';
        if (tail.startsWith('skill')) return '官方 · 技能';
        if (tail.startsWith('client-ui') || tail.startsWith('client-')) return '官方 · 界面';
        if (tail.includes('llm') || tail.includes('model')) return '官方 · 模型';
        if (tail.startsWith('session') || tail.startsWith('storage') || tail.startsWith('compaction')) return '官方 · 会话与存储';
        if (tail.startsWith('mcp')) return '官方 · MCP';
        if (tail.startsWith('agent') || tail.startsWith('typert') || tail.startsWith('api-')) return '官方 · 核心';
        return '官方 · 其他';
      }
      const scope = name.startsWith('@') ? name.split('/')[0] : '无 scope';
      return `第三方 · ${scope}`;
    }

    function groupByCategory(rows) {
      const groups = new Map();
      for (const row of rows) {
        const key = categoryOf(row.moduleName);
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
      }
      return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    }
    /** 生效范围编辑器：全部 / 排除某个 / 只勾选几个，三种模式都能表达。 */
    function ScopeEditor({ value, presetIds, onChange }) {
      const excluded = typeof value === 'string' && value.startsWith('!') ? value.slice(1) : null;
      const isAll = value === '*';
      const selected = Array.isArray(value) ? value : [];
      const ids = Array.isArray(presetIds) ? presetIds : [];

      const chip = (label, active, onClick, title) =>
        h(
          'button',
          {
            type: 'button',
            className: 'psx-chip psx-chipToggle',
            'data-state': active ? 'on' : 'off',
            'data-clickable': 'true',
            title,
            onClick,
          },
          h('span', null, label),
        );

      return h(
        'div',
        { className: 'psx-scope' },
        h(
          'div',
          { className: 'psx-chips' },
          chip('全部 preset', isAll, () => onChange('*'), '所有 preset 都带上这个模块'),
          chip('除创造模式', excluded === 'cordis', () => onChange('!cordis'), '除了 cordis（创造模式）之外都带上'),
          ids.map((id) =>
            chip(
              id,
              selected.includes(id),
              () => {
                const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
                onChange(next);
              },
              `仅在 ${id} 里生效`,
            ),
          ),
        ),
        h(
          'p',
          { className: 'psx-note' },
          isAll
            ? '当前：所有 preset'
            : excluded !== null
              ? `当前：除 ${excluded} 之外全部`
              : selected.length === 0
                ? '当前：不生效（至少选一个 preset，或选「全部 preset」）'
                : `当前：仅 ${selected.join(', ')}`,
        ),
      );
    }

    function auditPlugins(rows, modules) {
      const issues = [];
      const byName = new Map();
      rows.forEach((row, index) => {
        const list = byName.get(row.moduleName) ?? [];
        list.push({ row, index });
        byName.set(row.moduleName, list);
      });
      for (const [name, list] of byName) {
        if (list.length > 1) {
          issues.push({ level: 'warn', text: `重复插件：${name} 出现 ${list.length} 次（entryId: ${list.map((i) => i.row.entryId ?? '—').join(', ')}）` });
        }
      }
      const moduleSections = new Set((modules ?? []).map((entry) => entry?.section).filter(Boolean));
      for (const row of rows) {
        if (row.enabled === 'conditional' && typeof row.condition === 'string') {
          issues.push({ level: 'info', text: `${shortName(row.moduleName)} 条件启用：${row.condition}` });
        }
        if (row.fiberPhase === 'failed') {
          issues.push({ level: 'err', text: `${shortName(row.moduleName)} 挂载失败` });
        }
      }
      if (moduleSections.size > 0) {
        issues.push({ level: 'info', text: `提示词模块占用 ${moduleSections.size} 个 section 名：${[...moduleSections].join(', ')}` });
      }
      if (issues.length === 0) issues.push({ level: 'ok', text: '未发现重复插件或挂载异常。' });
      return issues;
    }

    function ChipBase({ label, state, tag, clickable, onPick, busy, hint }) {
      const props = {
        className: 'psx-chip',
        'data-state': state,
        'data-clickable': clickable ? 'true' : 'false',
        'data-busy': busy ? 'true' : 'false',
        title: [label, hint, tag, clickable ? '点击切换' : ''].filter(Boolean).join(' · '),
      };
      if (clickable && onPick && !busy) {
        props.onClick = onPick;
        props.role = 'button';
        props.tabIndex = 0;
      }
      return h('span', props, h('span', null, label), tag ? h('span', { className: 'psx-chipTag' }, tag) : null);
    }

    const Chip = memo(ChipBase);
    // ---- 公共基础设施：通知、错误边界、条目遮蔽 ----

    /**
     * 通知条挂在页面上，不挂在区块里。
     *
     * 之前每个区块自己 useNotifier()、自己渲染 toast：保存模块的提示渲染在插件区里，
     * 插件操作的提示渲染在 Skill 区旁边——说的是 A 区的事，出现在 B 区。
     * 现在只有一个 NoticeProvider（包住列表页和详情页），一条 NoticeBar 显示在最上方，
     * 谁报的都在同一处出现，不会被误读成相邻区块的状态。
     */
    const NoticeContext = React.createContext(null);

    function NoticeProvider({ children }) {
      const [toast, setToast] = useState(null);
      const notify = useCallback((text, tone) => {
        setToast({ text, tone: tone ?? (/失败|错误|不可|无法/.test(String(text)) ? 'err' : 'ok') });
      }, []);
      const clear = useCallback(() => setToast(null), []);
      const value = React.useMemo(() => ({ notify, clear, last: toast }), [notify, clear, toast]);
      return h(NoticeContext.Provider, { value }, children);
    }

    /** 读全局通知器。没被 provider 包住时退化为控制台提示——它不该在这里发生，但不许崩。 */
    function useNotifier() {
      const shared = React.useContext(NoticeContext);
      const notify = useCallback(
        (text, tone) => {
          const next = { text, tone: tone ?? (/失败|错误|不可|无法/.test(String(text)) ? "err" : "ok") };
          if (shared !== null) shared.notify(next.text, next.tone);
          else console.warn('[preset-studio]', next.text);
        },
        [shared],
      );
      const clear = useCallback(() => {
        if (shared !== null) shared.clear();
      }, [shared]);
      return { notify, clear };
    }

    /** 一条通知条。Detail 与列表页各放一处（同一个 provider，同一份状态）。 */
    function NoticeBar(props) {
      const shared = React.useContext(NoticeContext);
      const toast = props?.toast ?? shared?.last ?? null;
      if (toast === null || toast === undefined) return null;
      return h(
        'div',
        { className: 'psx-noticeBar' },
        h('p', { className: 'psx-toast', 'data-tone': toast.tone, role: 'status' }, toast.text),
      );
    }

    /** 错误边界：区块渲染崩溃时显示原因，而不是静默回落到官方条目。 */
    class StudioBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          return h(
            'div',
            { className: 'psx-toast', 'data-tone': 'err', role: 'alert' },
            h('div', null, `预设工作室渲染出错：${String(this.state.error?.message ?? this.state.error)}`),
            h(
              'button',
              { type: 'button', className: 'psx-mini', style: { marginTop: 8 }, onClick: () => this.setState({ error: null }) },
              '重试',
            ),
          );
        }
        return this.props.children;
      }
    }


    /** 官方那条「Agent 预设」在 settings.section 里的登记 id（来自 dsh-client-ui-agent-preset）。 */
    const OFFICIAL_ENTRY_ID = 'agent-presets';

    /**
     * settings.section 当前的条目数组。
     * 插件拿到的 `ctx.slots` 是渲染器的 Service 外壳（dsh-client-ui-renderer/lib/client.js:1304 起），
     * 它只公开 `entries / getVersion / subscribe / register`，**没有 `records`、`markDirty`、`onMutate`**。
     * `entries(key)` 返回的就是 SlotCore 里的原始条目对象（没有冻结），所以能直接改。
     * @param slots slots 服务
     */
    function settingsSectionEntries(slots) {
      try {
        const list = typeof slots?.entries === 'function' ? slots.entries('settings.section') : undefined;
        if (Array.isArray(list)) return list;
      } catch {
        /* 读不到 */
      }
      return null;
    }

    /**
     * 官方那条登记。同一个 id 只会有一条——我们不注册，所以如果有，那一定是官方插件放的。
     * @param slots slots 服务
     */
    function officialEntryOf(slots) {
      const list = settingsSectionEntries(slots);
      if (list === null) return null;
      for (const entry of list) {
        if (entry?.options?.id === OFFICIAL_ENTRY_ID) return entry;
      }
      return null;
    }

    /**
     * 让 settings.section 的版本号自增一次，导航与内容区才会重读条目。
     * Service 外壳没有 markDirty，只能用公开的 register：注册一条空条目再立刻释放，
     * 两次都在同一个同步调用里完成，渲染发生在之后的微任务，所以界面上永远看不到它。
     * @param slots slots 服务
     */
    function bumpSectionVersion(slots) {
      try {
        if (typeof slots?.markDirty === 'function' && slots.records?.get) {
          const record = slots.records.get('settings.section');
          if (record) {
            slots.markDirty('settings.section', record);
            return true;
          }
        }
        if (typeof slots?.register !== 'function') return false;
        const off = slots.register({ name: 'settings.section', id: '__psx_refresh__', order: 1e9, label: '' }, () => null);
        if (typeof off === 'function') off();
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 直接改官方那条：把它的渲染体和侧栏文案换成我们的。
     *
     * 不删条目、不藏、也不另建一条。渲染器每次渲染都重新读 `entry.component`
     * （dsh-client-ui-renderer/lib/client.js :814/:821/:885），改完让版本号自增一次即可。
     * 原始字段存在 `entry.__psxOriginal` 里，插件卸载时还原。
     * @returns 'taken' 改好了 | 'absent' 官方那条还没注册 | 'no-ledger' 条目读不到
     */
    function takeOverOfficialEntry(slots, component, label) {
      if (settingsSectionEntries(slots) === null) return 'no-ledger';
      const entry = officialEntryOf(slots);
      if (entry === null) return 'absent';
      if (entry.component === component) return 'taken';
      if (entry.__psxOriginal === undefined) entry.__psxOriginal = { component: entry.component, label: entry.options.label };
      entry.component = component;
      entry.options.label = label;
      bumpSectionVersion(slots);
      return 'taken';
    }

    /**
     * 还原官方那条（插件被卸载时）。换回它自己的渲染体与文案，就像我们没来过。
     * @param slots slots 服务
     */
    function restoreOfficialEntry(slots) {
      const entry = officialEntryOf(slots);
      if (entry === null || entry.__psxOriginal === undefined) return false;
      const original = entry.__psxOriginal;
      entry.component = original.component;
      if (original.label !== undefined) entry.options.label = original.label;
      delete entry.__psxOriginal;
      bumpSectionVersion(slots);
      return true;
    }

    /**
     * 接管设置页的「Agent 预设」那一格——**只有一条路：改官方那条**。
     *
     * 官方插件是 DSH 自带的静态插件，删不掉也禁不掉（内置插件页 inject 了它），
     * 但它的登记条目是活的：换渲染体最省事，条目还在、侧栏天然一条。
     * 它总比我们晚注册，所以用 `slots.subscribe('settings.section')` 盯着，它一出现就当场改；
     * 改不上（还没注册 / 登记表读不到 / 抛错）就什么都不做，原因写进诊断。
     * @param slots slots 服务
     * @param componentOf 生成我们的设置页组件（每次调用给一个新的包装件）
     * @returns { mode, why, ensure, dispose }
     */
    function installSectionControl(slots, componentOf) {
      if (slots === null || slots === undefined) return { mode: 'none', why: 'no-slots', ensure: () => {}, dispose: () => {} };
      // 标记打在**原型**上：`ctx.slots` 每次可能是新代理，实例标记挡不住重复安装，
      // 重复安装会让 entries() 层层套娃，最终递归爆栈 → 设置页卡死（"设置入口未响应"）。
      // 原型是 Object.prototype 时不能往那儿写（会污染所有对象），退回实例。
      const proto = Object.getPrototypeOf(slots);
      const host = proto !== null && proto !== Object.prototype ? proto : slots;
      if (host.__presetStudioSection !== undefined) return host.__presetStudioSection;

      const label = () => COPY.nav;
      // 组件只造一次。每次 ensure 都新建一个函数的话，`entry.component` 的标识每次都会变，
      // 任何无关的 markDirty 都会把我们这一格重新挂载一遍。
      let built = null;
      const buildOnce = () => {
        if (built === null) built = componentOf();
        return built;
      };
      const state = { mode: 'none', why: 'pending' };
      let disposed = false;
      let busy = false;
      let tookOver = false;
      let warned = false;

      const publish = () => {
        let hasOfficial = false;
        try {
          hasOfficial = officialEntryOf(slots) !== null;
        } catch {
          /* 读不到就报 false */
        }
        const diag = { mode: state.mode, via: state.mode === 'takeover' ? 'ledger' : null, hasOfficial, why: state.why };
        try {
          window.__presetStudioDiag = diag;
        } catch {
          /* 非浏览器环境 */
        }
        return diag;
      };

      const ensure = () => {
        // markDirty 会在 takeOver 内部同步回调进 onMutate → ensure()，挡一下重入。
        if (disposed || busy) return state;
        busy = true;
        try {
          const component = buildOnce();
          let verdict;
          try {
            verdict = takeOverOfficialEntry(slots, component, label);
          } catch (error) {
            verdict = null;
            state.mode = 'none';
            state.why = `takeover-failed: ${String(error?.message ?? error)}`;
          }
          if (verdict === 'taken') {
            tookOver = true;
            state.mode = 'takeover';
            state.why = 'taken-over';
          } else if (verdict !== null) {
            state.mode = 'none';
            state.why = verdict === 'absent' ? 'official-not-registered-yet' : verdict;
            // 接管不上就没有入口（我们不建第二个），所以至少让日志里有据可查。
            // 'official-not-registered-yet' 是正常时序，不记。
            if (!warned && verdict !== 'absent') {
              warned = true;
              console.warn('[preset-studio] 没能接管官方「Agent 预设」：' + state.why);
            }
          }
          publish();
          return state;
        } finally {
          busy = false;
        }
      };

      let off = null;
      try {
        // 真机上 ctx.slots 是 Service 外壳，没有 onMutate；它有 subscribe(key, fn)（微任务批量通知）。
        // 测试里的 SlotCore 假件两者都可能有，优先 subscribe——和真机走同一条路。
        if (typeof slots.subscribe === 'function') off = slots.subscribe('settings.section', () => ensure());
        else if (typeof slots.onMutate === 'function')
          off = slots.onMutate((key) => {
            if (key === 'settings.section') ensure();
          });
      } catch {
        off = null;
      }

      // 先自己试一次：官方那条若已经在了，当场改掉。
      ensure();

      const result = {
        get mode() {
          return state.mode;
        },
        get why() {
          return state.why;
        },
        ensure,
        dispose: () => {
          disposed = true;
          try {
            off?.();
          } catch {
            /* 退订失败无碍 */
          }
          if (tookOver) {
            try {
              restoreOfficialEntry(slots);
            } catch {
              /* 还原失败时保持接管状态，不影响卸载 */
            }
          }
          try {
            delete host.__presetStudioSection;
          } catch {
            host.__presetStudioSection = undefined;
          }
        },
      };
      host.__presetStudioSection = result;
      return result;
    }

    const API_BASE = '/preset-studio';
    const NS_STUDIO = 'preset-studio';

    /** host 的 HTTP 端点；桌面端和 web 端都经 webserver 提供同源 fetch。 */
    async function studioApi(path, init) {
      const response = await fetch(API_BASE + path, init);
      const data = await response.json().catch(() => null);
      if (!response.ok || data === null || data.ok === false) {
        throw new Error(data?.error ?? `HTTP ${response.status}`);
      }
      return data;
    }

    const saveModulesHttp = (modules) =>
      studioApi('/modules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modules }),
      });

    const sendCommandHttp = (command) =>
      studioApi('/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      });

    /** 读模块：HTTP 优先，失败退回 settings 快照（老通道）。 */
    async function loadModules(ctx) {
      try {
        const data = await studioApi('/state');
        return { transport: 'http', list: Array.isArray(data.modules) ? data.modules : [] };
      } catch (error) {
        const legacy = readStudioModules(ctx);
        if (legacy.status === 'error') throw error;
        return { transport: 'settings', list: legacy.list };
      }
    }

    /** inventory 读一次就缓存一小段时间：它要扫描全部 loader entry 并读包元数据，比较重。 */
    const inventoryCache = { at: 0, value: null };
    async function loadInventory(ctx, force = false) {
      const now = Date.now();
      if (!force && inventoryCache.value !== null && now - inventoryCache.at < 1500) return inventoryCache.value;
      const result = await ctx.remote.pluginInventory.list();
      if (!result.ok) throw new Error(result.error.message);
      inventoryCache.value = result.value;
      inventoryCache.at = now;
      return result.value;
    }
    const SKILL_PLUGIN = '@deepseek-ai/dsh-skill-filesystem';

    /** 从 agentPresets.read 返回的 YAML 里粗取 skill-filesystem 的配置。 */
    function extractSkillConfig(content) {
      if (typeof content !== 'string') return { found: false };
      const at = content.indexOf('dsh-skill-filesystem');
      if (at < 0) return { found: false };
      const seg = content.slice(at, at + 1500);
      const include = /\bincludeDefaultRoots:\s*(true|false)/.exec(seg);
      const dirs = [];
      const block = /customSkillDirs:\s*\r?\n((?:[ \t]*-[^\r\n]*\r?\n?)+)/.exec(seg);
      if (block !== null) {
        for (const match of block[1].matchAll(/-\s*['"]?([^'"\r\n]+?)['"]?\s*(?:\r?\n|$)/g)) dirs.push(match[1].trim());
      }
      const inline = /customSkillDirs:\s*\[(.*?)\]/.exec(seg);
      if (inline !== null && inline[1].trim().length > 0) {
        for (const part of inline[1].split(',')) {
          const value = part.trim().replace(/^['"]|['"]$/g, '');
          if (value.length > 0) dirs.push(value);
        }
      }
      return { found: true, includeDefaultRoots: include === null ? true : include[1] === 'true', customSkillDirs: dirs };
    }

    /**
     * 判断模块是否作用于某个 preset。host 侧有一份**必须完全一致**的实现。
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

    function readStudioModules(ctx) {
      try {
        const scope = ctx.configForms.get(NS_STUDIO);
        const snap = scope.getSnapshot();
        const raw = snap?.value?.modules;
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          status: snap?.status ?? 'ready',
          revision: snap?.revision,
          writable: snap?.writable !== false,
          list: Array.isArray(list) ? list : [],
        };
      } catch (error) {
        return { status: 'error', revision: undefined, writable: false, list: [], error: String(error?.message ?? error) };
      }
    }

    /** 插件预置的模块：可停用、可改，但不提供删除。 */
    const DEFAULT_MODULE_IDS = new Set(['base']);

    /** 官方段名的形态：基线还没建立（首次安装）时用它兜底，两种情况都要能警告。 */
    const OFFICIAL_SECTION_PATTERN =
      /^(harness:identity|harness:source|deployment:|tool:|plan:|mcp-resource-servers|web:surface|deliverables|structured)/;

    function isOfficialSection(name, baseline) {
      if (typeof name !== 'string' || name.length === 0) return false;
      if (Array.isArray(baseline) && baseline.includes(name)) return true;
      return OFFICIAL_SECTION_PATTERN.test(name);
    }

    function ModuleRow({ entry, presetId, presetIds, baseline, completeTaken, onSave, onRemove, saving, autoEdit }) {
      const [editing, setEditing] = useState(Boolean(autoEdit));
      const [draft, setDraft] = useState(autoEdit && typeof entry.text === 'string' ? entry.text : '');
      const [meta, setMeta] = useState({
        section: entry.section ?? 'pack:module',
        order: Number.isFinite(entry.order) ? entry.order : 0,
        presets: entry.presets ?? '*',
        mode: entry.mode === 'remove' ? 'remove' : 'inject',
      });
      const active = presetId === null || presetId === undefined ? null : appliesTo(entry, presetId);
      const locked = DEFAULT_MODULE_IDS.has(entry.id);
      const chars = typeof entry.text === 'string' ? entry.text.length : undefined;

      const beginEdit = () => {
        setDraft(typeof entry.text === 'string' ? entry.text : '');
        setMeta({
          section: entry.section ?? 'pack:module',
          order: Number.isFinite(entry.order) ? entry.order : 0,
          presets: entry.presets ?? '*',
          mode: entry.complete === true ? 'complete' : entry.mode === 'remove' ? 'remove' : 'inject',
        });
        setEditing(true);
      };

      const commitEdit = () => {
        const presets = meta.presets === '*' || meta.presets === undefined ? '*' : meta.presets;
        onSave({
          ...entry,
          section: meta.section.trim() || 'pack:module',
          order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 0,
          presets,
          mode: meta.mode === 'remove' ? 'remove' : undefined,
          complete: meta.mode === 'complete' ? true : undefined,
          text: draft,
        });
        setEditing(false);
      };

      return h(
        'div',
        { className: 'psx-module', 'data-active': active ? 'true' : 'false' },
        h(
          'div',
          { className: 'psx-moduleHead' },
          h('code', { className: 'psx-moduleName' }, entry.section ?? 'pack:module'),
          h('span', { className: 'psx-moduleMeta' }, `order ${Number.isFinite(entry.order) ? entry.order : 0}`),
          h('span', { className: 'psx-moduleMeta' }, Array.isArray(entry.presets) ? entry.presets.join(', ') : '全部 preset'),
          h(
            'span',
            { className: 'psx-moduleMeta' },
            entry.file ? `${COPY.moduleFile} ${entry.file}` : `${COPY.moduleInline} ${chars ?? 0} 字`,
          entry.mode === 'remove' ? h('span', { className: 'psx-chipTag' }, '删除段') : null,
          entry.complete === true ? h('span', { className: 'psx-chipTag' }, '整体替换') : null,
          entry.source === 'detected' ? h('span', { className: 'psx-chipTag' }, '来自插件') : null,
          ),
          active === false ? h('span', { className: 'psx-chipTag' }, COPY.moduleSkipped) : null,
          h(
            'span',
            { className: 'psx-moduleState', 'data-on': entry.enabled === false ? 'false' : 'true' },
            entry.enabled === false ? COPY.moduleOff : COPY.moduleOn,
          ),
          h(
            'span',
            { className: 'psx-moduleActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'psx-mini',
                disabled: saving || entry.file !== undefined,
                title: entry.file === undefined ? COPY.moduleEdit : '文件型模块请在文件里改',
                onClick: () => {
                  beginEdit();
                },
              },
              COPY.moduleEdit,
            ),
            h('button', { type: 'button', className: 'psx-mini', disabled: saving, onClick: () => onSave({ ...entry, enabled: entry.enabled === false }) }, entry.enabled === false ? COPY.moduleEnableOn : COPY.moduleDisable),
            locked
              ? h('span', { className: 'psx-chipTag', title: '默认模块不可删除，可以停用或修改' }, '默认')
              : h('button', { type: 'button', className: 'psx-mini psx-danger', disabled: saving, title: COPY.moduleDeleteHint, onClick: () => onRemove(entry) }, COPY.moduleDelete),
          ),
        ),
        editing
          ? h(
              'div',
              { className: 'psx-moduleEditor' },
              h(
                'div',
                { className: 'psx-metaRow' },
                h(
                  'label',
                  { className: 'psx-field' },
                  h('span', null, COPY.moduleSection),
                  h('input', {
                    className: 'psx-input',
                    value: meta.section,
                    onChange: (event) => setMeta((prev) => ({ ...prev, section: event.target.value })),
                  }),
                ),
                h(
                  'label',
                  { className: 'psx-field psx-fieldNarrow' },
                  h('span', null, COPY.moduleOrder),
                  h('input', {
                    className: 'psx-input',
                    type: 'number',
                    value: meta.order,
                    onChange: (event) => setMeta((prev) => ({ ...prev, order: event.target.value })),
                  }),
                ),
                h(
                  'div',
                  { className: 'psx-field' },
                  h('span', null, COPY.moduleScope),
                  h(ScopeEditor, {
                    value: meta.presets,
                    presetIds,
                    onChange: (next) => setMeta((prev) => ({ ...prev, presets: next })),
                  }),
                ),
              ),
              h(
                'div',
                { className: 'psx-field' },
                h('span', null, '操作'),
                h(
                  'div',
                  { className: 'psx-chips' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'psx-chip psx-chipToggle',
                      'data-state': meta.mode === 'remove' ? 'off' : 'on',
                      'data-clickable': 'true',
                      onClick: () => setMeta((prev) => ({ ...prev, mode: 'inject' })),
                    },
                    h('span', null, '注入文本'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'psx-chip psx-chipToggle',
                      'data-state': meta.mode === 'remove' ? 'on' : 'off',
                      'data-clickable': 'true',
                      title: '不注入任何文本，而是把同名的段从系统提示词里移除（可以删掉 DSH 自带的段）',
                      onClick: () => setMeta((prev) => ({ ...prev, mode: 'remove' })),
                    },
                    h('span', null, '删除同名段'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'psx-chip psx-chipToggle',
                      'data-state': meta.mode === 'complete' ? 'on' : 'off',
                      'data-clickable': 'true',
                      title:
                        completeTaken && meta.mode !== 'complete'
                          ? '这个 preset 已经有一个「整体替换」模块，再设一个会在装配时报错'
                          : '用正文整体替换系统提示词——包括 DSH 自带的工具规则。同一 preset 只能有一个',
                      onClick: () => setMeta((prev) => ({ ...prev, mode: 'complete' })),
                    },
                    h('span', null, '整体替换'),
                  ),
                ),
              ),
              meta.mode === 'complete' && completeTaken
                ? h(
                    'p',
                    { className: 'psx-toast', 'data-tone': 'err', role: 'alert' },
                    '这个 preset 已经有另一个「整体替换」模块——装配时会报 multiple complete prompt sections。请先停用或删掉另一个。',
                  )
                : null,
              meta.mode === 'complete'
                ? h('p', { className: 'psx-toast', 'data-tone': 'err' }, '整体替换会顶掉全部系统提示词（身份、工具规则、plan 约束都在内）。确认无误再保存。')
                : null,
              h('textarea', {
                className: 'psx-textarea',
                rows: meta.mode === 'remove' ? 2 : 8,
                value: draft,
                placeholder: meta.mode === 'remove' ? '（删除模式不需要正文，section 名填要移除的那一段）' : COPY.moduleText,
                disabled: meta.mode === 'remove',
                onChange: (event) => setDraft(event.target.value),
              }),
              (() => {
                const section = meta.section.trim();
                if (section.length === 0) return null;
                if (!isOfficialSection(section, baseline)) return null;
                return h(
                  'p',
                  { className: 'psx-toast', 'data-tone': 'err', role: 'alert' },
                  meta.mode === 'remove'
                    ? `⚠️ ${section} 是 DSH 自带的段，保存后它会从这个 preset 的系统提示词里被移除。`
                    : meta.mode === 'complete'
                      ? `⚠️ ${section} 是 DSH 自带的段，而你现在选的是「整体替换」——整个系统提示词只会剩下这里的正文。`
                      : `⚠️ ${section} 是 DSH 自带的段，保存后会被你这里的正文覆盖（官方原文不再生效）。`,
                );
              })(),
              h(
                'div',
                { className: 'psx-moduleEditorFoot' },
                h('button', { type: 'button', className: 'psx-mini', onClick: () => setEditing(false) }, COPY.moduleCancel),
                h('button', { type: 'button', className: 'psx-mini psx-primary', disabled: saving, onClick: commitEdit }, COPY.moduleSave),
              ),
            )
          : null,
      );
    }

    function SkillsBlock({ ctx, presetId, collapsed, onToggle }) {
      const [state, setState] = useState({ status: 'idle', found: false, includeDefaultRoots: true, customSkillDirs: [], error: null, pending: false });
      const busy = state.pending === true;
      const [draft, setDraft] = useState('');
      const { notify, clear: clearNotice } = useNotifier();
      const [available, setAvailable] = useState({ status: 'idle', skills: [], roots: [], disabled: [] });

      const loadSkills = useCallback(async () => {
        setAvailable((prev) => ({ ...prev, status: 'loading' }));
        try {
          const data = await studioApi('/skills');
          setAvailable({ status: 'ready', skills: Array.isArray(data.skills) ? data.skills : [], roots: Array.isArray(data.roots) ? data.roots : [], disabled: Array.isArray(data.disabled) ? data.disabled : [], source: data.source });
        } catch (error) {
          setAvailable({ status: 'error', skills: [], roots: [], disabled: [], error: String(error?.message ?? error) });
        }
      }, []);

      const load = useCallback(async () => {
        try {
          const result = await ctx.remote.agentPresets.read(presetId);
          if (!result.ok) throw new Error(result.error.message);
          const content = result.value?.content;
          const parsed = extractSkillConfig(content);
          setState((prev) => ({ ...prev, status: 'ready', error: null, ...parsed, raw: typeof content === 'string' ? content.slice(0, 400) : String(content) }));
        } catch (error) {
          setState((prev) => ({ ...prev, status: 'error', error: String(error?.message ?? error) }));
        }
      }, [ctx, presetId]);

      useEffect(() => {
        void load();
        void loadSkills();
      }, [load, loadSkills]);

      /** 切换单个 skill：从 catalog 里摘掉/放回（写 skills.json，下一次请求生效）。 */
      const toggleSkill = async (skillId) => {
        const current = new Set(available.disabled ?? []);
        if (current.has(skillId)) current.delete(skillId);
        else current.add(skillId);
        const next = [...current];
        setAvailable((prev) => ({ ...prev, disabled: next }));
        try {
          await studioApi('/skills', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ disabled: next }),
          });
        } catch (error) {
          setAvailable((prev) => ({ ...prev, disabled: available.disabled ?? [] }));
          notify(`切换 skill 失败：${String(error?.message ?? error)}`);
        }
      };

      const submit = async (patch) => {
        const previous = state;
        // 乐观更新：先改界面，再落盘。
        setState((prev) => ({
          ...prev,
          ...(typeof patch.includeDefaultRoots === 'boolean' ? { includeDefaultRoots: patch.includeDefaultRoots } : {}),
          ...(Array.isArray(patch.customSkillDirs) ? { customSkillDirs: patch.customSkillDirs } : {}),
        }));
        setState((prev) => ({ ...prev, pending: true }));
        clearNotice();
        try {
          await sendCommandHttp({ op: 'setSkillConfig', presetId, ...patch });
          notify('已提交，新建会话生效');
          setTimeout(() => void load(), 700);
        } catch (error) {
          setState(previous);
          notify(`操作失败：${String(error?.message ?? error)}`);
        } finally {
          setState((prev) => ({ ...prev, pending: false }));
        }
      };

      return h(
        'div',
        { className: 'psx-block' },
        h(
          'div',
          { className: 'psx-blockHead' },
          h(
            'h4',
            { className: 'psx-blockTitle' },
            h(
              'button',
              { type: 'button', className: 'psx-fold', onClick: onToggle, 'aria-expanded': !collapsed },
              IconChevronDown ? h(IconChevronDown, { size: 14 }) : h('span', null, '▾'),
            ),
            COPY.skills,
          ),
        ),
        collapsed
          ? null
          : h(
              'div',
              { className: 'psx-skill' },
              state.status === 'error' ? h('p', { className: 'psx-error' }, state.error) : null,
              state.found === false && state.status === 'ready'
                ? h('p', { className: 'psx-placeholder' }, `该 preset 没有挂载 ${SKILL_PLUGIN}`)
                : h(
                    'div',
                    { className: 'psx-skillBody' },
                    h(
                      'div',
                      { className: 'psx-chips' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'psx-chip psx-chipToggle',
                          'data-state': state.includeDefaultRoots !== false ? 'on' : 'off',
                          'data-clickable': 'true',
                          disabled: busy,
                          title: '点击切换：是否加载默认 skill 目录',
                          onClick: () =>
                            void submit({
                              includeDefaultRoots: state.includeDefaultRoots === false,
                              customSkillDirs: state.customSkillDirs,
                            }),
                        },
                        h('span', null, '默认目录'),
                        h('span', { className: 'psx-chipTag' }, state.includeDefaultRoots !== false ? '已包含' : '已关闭'),
                      ),
                      state.customSkillDirs.map((dir, index) =>
                        h(
                          'button',
                          {
                            key: `${dir}-${index}`,
                            type: 'button',
                            className: 'psx-chip psx-chipToggle',
                            'data-clickable': 'true',
                            disabled: busy,
                            title: `点击移除：${dir}`,
                            onClick: () =>
                              void submit({
                                includeDefaultRoots: state.includeDefaultRoots !== false,
                                customSkillDirs: state.customSkillDirs.filter((_, i) => i !== index),
                              }),
                          },
                          h('span', null, dir.split(/[\\/]/).filter(Boolean).pop() ?? dir),
                          h('span', { className: 'psx-chipTag' }, '×'),
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'psx-blockHead' },
                      h(
                        'h4',
                        { className: 'psx-blockTitle' },
                        '可用 skill',
                        h('span', { className: 'psx-count' }, String(available.skills.length)),
                        available.source === 'scan' ? h('span', { className: 'psx-chipTag' }, '目录扫描') : null,
                      ),
                      h('button', { type: 'button', className: 'psx-mini', disabled: available.status === 'loading', onClick: () => void loadSkills() }, '重新扫描'),
                    ),
                    available.status === 'error'
                      ? h('p', { className: 'psx-toast', 'data-tone': 'err' }, available.error)
                      : available.status === 'loading'
                        ? h('p', { className: 'psx-note' }, '扫描中…')
                        : available.skills.length === 0
                          ? h('p', { className: 'psx-muted' }, '默认目录下没有找到 skill（每个 skill 应该是 <目录>/<名字>/SKILL.md）')
                          : h(
                              'div',
                              { className: 'psx-chips' },
                              available.skills.map((skill) => {
                                const off = (available.disabled ?? []).includes(skill.id);
                                return h(
                                  'button',
                                  {
                                    key: skill.id,
                                    type: 'button',
                                    className: 'psx-chip psx-chipToggle',
                                    'data-clickable': 'true',
                                    'data-state': off ? 'off' : 'on',
                                    title: `${skill.description || skill.path}\n\n点击${off ? '启用' : '禁用'}（影响 catalog 里是否列出）`,
                                    onClick: () => void toggleSkill(skill.id),
                                  },
                                  h('span', null, skill.name),
                                  off ? h('span', { className: 'psx-chipTag' }, '已禁用') : null,
                                );
                              }),
                            ),
                    h(
                      'div',
                      { className: 'psx-dirAdd' },
                      h('input', {
                        className: 'psx-input',
                        placeholder: '添加目录：绝对路径（每条目录下的子文件夹需含 SKILL.md）',
                        value: draft,
                        disabled: busy,
                        onChange: (event) => setDraft(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key !== 'Enter' || draft.trim().length === 0) return;
                          void submit({
                            includeDefaultRoots: state.includeDefaultRoots !== false,
                            customSkillDirs: [...state.customSkillDirs, draft.trim()],
                          });
                          setDraft('');
                        },
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'psx-mini',
                          disabled: busy || draft.trim().length === 0,
                          onClick: () => {
                            void submit({
                              includeDefaultRoots: state.includeDefaultRoots !== false,
                              customSkillDirs: [...state.customSkillDirs, draft.trim()],
                            });
                            setDraft('');
                          },
                        },
                        COPY.moduleAdd,
                      ),
                    ),
                  ),
              state.status === 'ready' && state.found === false
                ? h('details', { className: 'psx-raw' }, h('summary', null, '看到的 preset 声明（前 400 字）'), h('pre', null, state.raw ?? ''))
                : null,
              h('p', { className: 'psx-note' }, '当前只支持目录级选择；按单个 skill 开关需要 DSH 的 skill filter provider（尚未提供）。'),
            ),
      );
    }

    /**
     * 注入型插件面板：扫出「哪些插件在往系统提示词里塞东西」，
     * 并对照当前模块清单标出「已接管 / 未接管 / 核心段（不接管）」。
     */
    function InjectionPanel({ modules, onBatch, saving }) {
      const [state, setState] = useState({ status: 'idle', packages: [], scanned: 0, error: null });
      // 已接管的段 = modules 里的 detected 条目；它可能被标成 enabled:false（交回插件自己注入）。
      const detectedRows = (Array.isArray(modules) ? modules : []).filter((mod) => mod?.source === 'detected');
      const adopted = new Map(detectedRows.map((mod) => [mod.section, mod.enabled !== false]));
      const takenCount = [...adopted.values()].filter(Boolean).length;
      const offCount = adopted.size - takenCount;
      const batch = (enable, sections) => {
        if (typeof onBatch !== 'function') return;
        void onBatch(enable, sections);
      };

      const scan = useCallback(async () => {
        setState({ status: 'loading', packages: [], scanned: 0, error: null });
        try {
          const data = await studioApi('/gate/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          setState({
            status: 'ready',
            packages: Array.isArray(data.packages) ? data.packages : [],
            scanned: Number(data.scanned) || 0,
            error: null,
          });
        } catch (error) {
          setState({ status: 'error', packages: [], scanned: 0, error: String(error?.message ?? error) });
        }
      }, []);

      const total = state.packages.reduce((sum, pkg) => sum + (pkg.sections?.length ?? 0), 0);

      return h(
        'div',
        { className: 'psx-block', style: { marginTop: 4 } },
        h(
          'div',
          { className: 'psx-blockHead' },
          h(
            'h4',
            { className: 'psx-blockTitle' },
            '注入型插件',
            adopted.size > 0
              ? h('span', { className: 'psx-count' }, `接管 ${takenCount} / 交回 ${offCount}`)
              : state.status === 'ready'
                ? h('span', { className: 'psx-count' }, `${state.packages.length} 个插件 / ${total} 段`)
                : null,
          ),
          h(
            'div',
            { className: 'psx-blockActions' },
            adopted.size > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'psx-mini',
                    disabled: Boolean(saving) || offCount === 0,
                    title: '把所有「已交回」的段改成由本插件接管',
                    onClick: () => batch(true),
                  },
                  offCount === 0 ? '已全部接管' : `全部接管（${offCount}）`,
                )
              : null,
            adopted.size > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'psx-mini',
                    disabled: Boolean(saving) || takenCount === 0,
                    title: '把所有「已接管」的段交回给插件自己注入',
                    onClick: () => batch(false),
                  },
                  takenCount === 0 ? '已全部交回' : `全部交回（${takenCount}）`,
                )
              : null,
            h(
              'button',
              { type: 'button', className: 'psx-mini', disabled: state.status === 'loading', onClick: () => void scan() },
              state.status === 'loading' ? '扫描中…' : '扫描',
            ),
          ),
        ),
        h(
          'p',
          { className: 'psx-note' },
          '「已接管」= 这一段由本插件注入，可以在任意 preset 里按需关掉；「已交回」= 本插件不接，恢复由插件自己注入。点胶囊即可切换，全部接管会一次性收回。',
        ),
        state.status === 'error' ? h('p', { className: 'psx-toast', 'data-tone': 'err' }, state.error) : null,
        state.status === 'ready' && state.packages.length === 0
          ? h('p', { className: 'psx-muted' }, `扫了 ${state.scanned} 个 DSH 包，没有发现注入系统提示词的插件。`)
          : null,
        state.status === 'ready' && state.packages.length > 0
          ? h(
              'div',
              { className: 'psx-modules' },
              state.packages.map((pkg) =>
                h(
                  'div',
                  { className: 'psx-module', key: pkg.name },
                  h(
                    'div',
                    { className: 'psx-moduleHead' },
                    h('code', { className: 'psx-moduleName' }, pkg.name),
                    h('span', { className: 'psx-moduleMeta' }, `${pkg.sections.length} 段`),
                  ),
                  h(
                    'div',
                    { className: 'psx-chips' },
                    (pkg.sections ?? []).map((section) =>
                      h(
                        'span',
                        {
                          key: section,
                          className: 'psx-chip',
                          'data-state': adopted.get(section) === true ? 'on' : 'off',
                          role: 'button',
                          tabIndex: 0,
                          style: { cursor: adopted.has(section) && !isOfficialSection(section, []) ? 'pointer' : undefined },
                          onClick: () => {
                            if (!adopted.has(section)) return;
                            if (isOfficialSection(section, [])) return;
                            batch(adopted.get(section) !== true, [section]);
                          },
                          title: isOfficialSection(section, [])
                            ? '核心段：属于身份/工具/计划约束，不会被自动接管'
                            : adopted.has(section)
                              ? adopted.get(section) === true
                                ? '点击交回：不再由本插件接管，恢复由插件自己注入'
                                : '点击接管：这一段改由本插件注入，可在任意 preset 里单独关掉'
                              : '未接管（没有对应的检测条目，重开会话后会自动纳管）',
                        },
                        h('span', null, section),
                        adopted.has(section) === false
                          ? null
                          : adopted.get(section) === true
                            ? h('span', { className: 'psx-chipTag' }, '已接管')
                            : h('span', { className: 'psx-chipTag' }, '已交回'),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function ModulesBlock({ ctx, presetId, presetIds }) {
      const [state, setState] = useState({ status: 'loading', list: [], transport: 'unknown', pending: false, autoEditId: null });
      const [baseline, setBaseline] = useState([]);
      const { pending: busy, autoEditId } = state;
      const { notify, clear: clearNotice } = useNotifier();

      // 基线 = 第一次装配时记录的官方段名单；用它判断「用户填的 section 名会不会覆盖 DSH 自带的段」。
      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const data = await studioApi('/health');
            if (!cancelled && Array.isArray(data.baselineSections)) setBaseline(data.baselineSections);
          } catch {
            /* 拿不到就不提示 */
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);


      const reload = useCallback(async () => {
        try {
          const loaded = await loadModules(ctx);
          setState((prev) => ({ ...prev, status: 'ready', list: loaded.list, transport: loaded.transport }));
        } catch (error) {
          setState((prev) => ({ ...prev, status: 'error', list: [], transport: 'unknown' }));
          notify(`读取失败：${String(error?.message ?? error)}`);
        }
      }, [ctx]);

      useEffect(() => {
        void reload();
      }, [reload]);

      const commit = useCallback(
        async (nextList) => {
          const previous = state.list;
          // 先让界面立刻变，再落盘；失败回滚。
          setState((prev) => ({ ...prev, list: nextList }));
          setState((prev) => ({ ...prev, pending: true }));
          clearNotice();
          try {
            await saveModulesHttp(nextList);
            notify(`已保存（${nextList.length} 个模块），新建会话生效`);
          } catch (httpError) {
            // HTTP 不可用时退回 settings 通道
            try {
              const scope = ctx.configForms.get(NS_STUDIO);
              const snap = scope.getSnapshot();
              const response = await ctx.remote.settings.update(
                NS_STUDIO,
                { modules: JSON.stringify(nextList) },
                snap?.revision,
              );
              if (!response.ok) throw new Error(response.error.message);
              notify(`已保存到 settings（${nextList.length} 个模块），新建会话生效`);
            } catch (settingsError) {
              setState((prev) => ({ ...prev, list: previous }));
              notify(`保存失败：${String(httpError?.message ?? httpError)} / ${String(settingsError?.message ?? settingsError)}`);
            }
          } finally {
            setState((prev) => ({ ...prev, pending: false }));
          }
        },
        [ctx, state.list],
      );

      const saveOne = useCallback(
        (entry) => {
          const list = state.list.map((candidate) => (candidate.id === entry.id ? entry : candidate));
          void commit(list);
        },
        [state.list, commit],
      );

      const removeOne = useCallback(
        (entry) => {
          void commit(state.list.filter((candidate) => candidate.id !== entry.id));
        },
        [state.list, commit],
      );

      const addOne = useCallback(() => {
        const index = state.list.length + 1;
        const id = `custom-${Date.now()}`;
        const entry = {
          id,
          section: `pack:custom-${index}`,
          order: 100,
          presets: '*',
          text: '',
        };
        setState((prev) => ({ ...prev, autoEditId: id }));
        void commit([...state.list, entry]);
      }, [state.list, commit]);

      const importFile = useCallback(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.md,.markdown,.txt,text/plain';
        input.onchange = async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          try {
            const text = await file.text();
            const base = String(file.name).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase();
            void commit([
              ...state.list,
              {
                id: `import-${Date.now()}`,
                section: `pack:${base || 'imported'}`,
                order: 100,
                presets: '*',
                text,
              },
            ]);
          } catch (error) {
            notify(`导入失败：${String(error?.message ?? error)}`);
          }
        };
        input.click();
      }, [state.list, commit]);

      const askAgent = useCallback(async () => {
        const task = [
          '帮我写一个 DSH 系统提示词模块。',
          '',
          '要求：',
          '1. 用 markdown，400–800 字，直接给正文，不要解释。',
          '2. 结构包含：角色定位 / 工作方式 / 输出契约 / 边界。',
          '3. 不要重复 DSH 已有的工具使用规则（read、grep、pwsh 那些）。',
          '4. 写完告诉我一个合适的 section 名（形如 pack:xxx）。',
        ].join('\n');
        let copied = false;
        try {
          await navigator.clipboard.writeText(task);
          copied = true;
        } catch {
          copied = false;
        }
        let started = false;
        try {
          const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
          if (workspace && typeof workspace.startSession === 'function') {
            workspace.startSession(undefined, { clearPreviousDraft: false });
            started = true;
          }
        } catch {
          started = false;
        }
        if (copied) {
          notify(started ? '✅ 任务文本已复制到剪贴板，已打开新会话，粘贴发送即可' : '✅ 任务文本已复制到剪贴板，请在新会话里粘贴发送');
        } else {
          notify('复制失败：浏览器拒绝了剪贴板写入，请手动复制对话里的任务说明');
        }
      }, [ctx]);

      /** 批量接管 / 交回：只动 source 为 detected 的条目，其它模块一个字都不碰。 */
      const toggleDetected = useCallback(
        (enable, sections) => {
          const wanted = Array.isArray(sections) && sections.length > 0 ? new Set(sections) : null;
          let touched = 0;
          const next = state.list.map((entry) => {
            if (entry?.source !== 'detected') return entry;
            if (wanted !== null && !wanted.has(entry.section)) return entry;
            if ((entry.enabled !== false) === Boolean(enable)) return entry;
            touched += 1;
            return { ...entry, enabled: Boolean(enable) };
          });
          if (touched === 0) return;
          void commit(next);
        },
        [state.list, commit],
      );

      return h(
        'div',
        { className: 'psx-block' },
        h(
          'div',
          { className: 'psx-blockHead' },
          h(
            'h4',
            { className: 'psx-blockTitle' },
            COPY.moduleTitle,
            h('span', { className: 'psx-count' }, String(state.list.length)),
          ),
          h(
            'div',
            { className: 'psx-blockActions' },
            h('button', { type: 'button', className: 'psx-mini', disabled: busy, onClick: importFile }, '导入'),
            h('button', { type: 'button', className: 'psx-mini', disabled: busy, title: '让 Agent 写一个模块草稿，写完用导入加回来', onClick: askAgent }, '让 Agent 创建'),
            h('button', { type: 'button', className: 'psx-mini', disabled: busy, onClick: addOne }, COPY.moduleAdd),
          ),
        ),
        h(InjectionPanel, { modules: state.list, onBatch: toggleDetected, saving: busy }),
        state.list.length === 0
          ? h('div', { className: 'psx-placeholder' }, COPY.moduleEmpty)
          : h(
              'div',
              { className: 'psx-modules' },
              state.list.map((entry, index) =>
                h(ModuleRow, {
                  key: String(entry.id ?? index),
                  entry,
                  presetId,
                  baseline,
                  completeTaken: state.list.some(
                    (candidate) => candidate.id !== entry.id && candidate.complete === true && candidate.enabled !== false,
                  ),
                  saving: busy,
                  autoEdit: autoEditId !== null && entry.id === autoEditId,
                  onSave: saveOne,
                  onRemove: removeOne,
                }),
              ),
            ),
        h('p', { className: 'psx-note' }, COPY.moduleHint),
      );
    }

    function rowState(row) {
      if (row.enabled === false) return { state: 'off', tag: COPY.rowDisabled };
      if (row.enabled === 'conditional') return { state: 'cond', tag: COPY.rowConditional };
      if (row.fiberPhase === 'failed') return { state: 'failed', tag: COPY.rowFailed };
      return { state: 'on', tag: undefined };
    }

    function Detail({ ctx, row, onBack }) {
      const [inv, setInv] = useState({ status: 'idle', error: null, entry: null });
      // 插件面状态收在一处：重载触发器 + 乐观值 + 进行中的插件。
      const [pluginState, setPluginState] = useState({ reloadKey: 0, optimistic: {}, pending: null });
      const { optimistic, pending: busy } = pluginState;

      // 以下都是彼此无关的 UI 开关（折叠/搜索/检查结果/诊断面板），各自独立比塞进一个对象更清晰；
      // 凡是「同一件事」的状态都已经收进 pluginState。
      const [collapsed, setCollapsed] = useState({ plugins: false, mcp: false, skills: false });
      const [inspect, setInspect] = useState(false);
      const [auditOn, setAuditOn] = useState(false);
      const [query, setQuery] = useState('');
      const [grouped, setGrouped] = useState(false);
      const [aiAudit, setAiAudit] = useState({ status: 'idle', text: null, error: null });

      const runAiAudit = async (pluginRows, force) => {
        setAiAudit({ status: 'loading', text: null, error: null });
        try {
          const data = await studioApi('/audit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              plugins: pluginRows.map((r) => ({ moduleName: r.moduleName, enabled: r.enabled, condition: r.condition })),
              force: force === true,
            }),
          });
          const age = typeof data.ageMs === 'number' && data.ageMs > 0 ? `（缓存，${Math.round(data.ageMs / 60000)} 分钟前）` : '';
          setAiAudit({ status: 'ready', text: `${data.text}\n\n— ${data.provider} / ${data.model}${age}`, error: null, cached: data.cached === true });
        } catch (error) {
          setAiAudit({ status: 'error', text: null, error: String(error?.message ?? error) });
        }
      };
      const [picked, setPicked] = useState(null);
      const { notify, clear: clearNotice } = useNotifier();

      const [channel, setChannel] = useState({ state: 'idle' });
      const [health, setHealth] = useState({ status: 'idle', data: null, error: null });
      const [diagOpen, setDiagOpen] = useState(false);
      const toggleBlock = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const data = await studioApi('/health');
            if (!cancelled) setHealth({ status: 'ready', data, error: null });
            if (!cancelled) setChannel({ state: 'ok', detail: 'http' });
          } catch (error) {
            if (!cancelled) {
              setChannel({ state: 'missing', detail: String(error?.message ?? error) });
              setHealth({ status: 'error', data: null, error: String(error?.message ?? error) });
            }
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [ctx, pluginState.reloadKey]);

      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const snapshot = await loadInventory(ctx, pluginState.reloadKey > 0);
            if (cancelled) return;
            const entry = (snapshot.agentPresets ?? []).find((p) => p.id === row.id);
            setInv({ status: 'ready', error: null, entry });
          } catch (error) {
            if (!cancelled) setInv({ status: 'error', error: String(error?.message ?? error), entry: null });
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [ctx, row.id, pluginState.reloadKey]);

      const togglePlugin = async (pluginRow) => {
        const nextEnabled = pluginRow.enabled === false;
        // 乐观更新：先让界面立刻响应，失败再回滚。
        setPluginState((prev) => ({ ...prev, optimistic: { ...prev.optimistic, [pluginRow.moduleName]: nextEnabled } }));
        setPluginState((prev) => ({ ...prev, pending: pluginRow.moduleName }));
        clearNotice();
        try {
          await sendCommandHttp({
            op: 'setPluginEnabled',
            presetId: row.id,
            moduleName: pluginRow.moduleName,
            enabled: nextEnabled,
          });
          setTimeout(() => setPluginState((prev) => ({ ...prev, reloadKey: prev.reloadKey + 1 })), 700);
        } catch (error) {
          setPluginState((prev) => {
            const nextOptimistic = { ...prev.optimistic };
            delete nextOptimistic[pluginRow.moduleName];
            return { ...prev, optimistic: nextOptimistic };
          });
        } finally {
          setPluginState((prev) => ({ ...prev, pending: null }));
        }
      };

      const d = display(row);
      const rows = inv.entry?.rows ?? [];
      const plugins = rows.filter((r) => !String(r.moduleName ?? '').includes('mcp-client'));
      const mcpRows = rows.filter((r) => String(r.moduleName ?? '').includes('mcp-client'));

      return h(
        'section',
        { className: 'psx-section' },
        h(
          'div',
          { className: 'psx-detailHead' },
          h(
            'button',
            { type: 'button', className: 'psx-back', onClick: onBack, title: COPY.back },
            IconChevronLeft ? h(IconChevronLeft, { size: 14 }) : h('span', null, '←'),
          ),
          h(
            'div',
            { className: 'psx-detailTitle' },
            h('div', { className: 'psx-detailName' }, d.name),
            h('div', { className: 'psx-detailSub' }, row.id),
          ),
          row.isDefault ? h(Tag, { tone: 'solid' }, COPY.inUse) : null,
        ),

        h(NoticeBar, null),
        inv.status === 'error' ? h('p', { className: 'psx-error', role: 'alert' }, inv.error) : null,
        inv.status === 'idle' ? h('p', { className: 'psx-muted' }, COPY.loading) : null,
        row.broken !== undefined ? h('p', { className: 'psx-placeholder' }, COPY.broken) : null,

        h(ModulesBlock, { ctx, presetId: row.id, presetIds: [row.id] }),

        h(
          'div',
          { className: 'psx-block' },
          h(
            'div',
            { className: 'psx-blockHead' },
            h(
              'h4',
              { className: 'psx-blockTitle' },
              h(
                'button',
                { type: 'button', className: 'psx-fold', onClick: () => toggleBlock('plugins'), 'aria-expanded': !collapsed.plugins },
                IconChevronDown ? h(IconChevronDown, { size: 14 }) : h('span', null, '▾'),
              ),
              COPY.plugins,
              h('span', { className: 'psx-count' }, String(plugins.length)),
            ),
            h(
              'div',
              { className: 'psx-blockActions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'psx-mini',
                  disabled: aiAudit.status === 'loading',
                  title: '用会话默认模型分析这批插件的功能与冲突',
                  onClick: () => void runAiAudit(plugins, aiAudit.status === 'ready'),
                },
                aiAudit.status === 'loading' ? 'AI 检查中…' : 'AI 检查',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'psx-mini',
                  'data-on': auditOn ? 'true' : 'false',
                  onClick: () => setAuditOn((prev) => !prev),
                },
                auditOn ? '检查结果 ✓' : '检查',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'psx-mini',
                  'data-on': inspect ? 'true' : 'false',
                  onClick: () => {
                    setInspect((prev) => !prev);
                    setPicked(null);
                  },
                },
                inspect ? '详细 ✓' : '详细',
              ),
            ),
          ),
          auditOn
            ? h(
                'ul',
                { className: 'psx-audit' },
                auditPlugins(plugins, readStudioModules(ctx).list).map((issue, index) =>
                  h('li', { key: index, 'data-level': issue.level }, issue.text),
                ),
              )
            : null,
          aiAudit.error !== null ? h('p', { className: 'psx-toast', 'data-tone': 'err' }, aiAudit.error) : null,
          aiAudit.text !== null
            ? h('pre', { className: 'psx-aiResult' }, aiAudit.text)
            : aiAudit.status === 'loading'
              ? h('p', { className: 'psx-note' }, '正在用默认模型分析…')
              : null,
          collapsed.plugins
            ? null
            : (() => {
                const needle = query.trim().toLowerCase();
                const matched = needle.length === 0
                  ? plugins
                  : plugins.filter((row) =>
                      [row.moduleName, row.meta?.title, row.meta?.description, row.entryId]
                        .filter(Boolean)
                        .some((value) => String(value).toLowerCase().includes(needle)),
                    );
                const renderChips = (rows) =>
                  h(
                    'div',
                    { className: 'psx-chips' },
                    rows.map((r, i) => {
                      const enabledNow = optimistic[r.moduleName] ?? r.enabled !== false;
                      const s = rowState({ ...r, enabled: enabledNow });
                      const key = `${r.entryId ?? r.moduleName}-${i}`;
                      return h(Chip, {
                        key,
                        label: shortName(r.moduleName),
                        state: s.state,
                        tag: s.tag,
                        hint: r.meta?.description,
                        clickable: true,
                        busy: busy === r.moduleName,
                        onPick: () => {
                          if (inspect) {
                            setPicked(r);
                            clearNotice();
                          } else {
                            void togglePlugin(r);
                          }
                        },
                      });
                    }),
                  );
                if (plugins.length === 0) return h('p', { className: 'psx-muted' }, COPY.none);
                return h(
                  'div',
                  { className: 'psx-catalog' },
                  h(
                    'div',
                    { className: 'psx-catalogBar' },
                    h('input', {
                      className: 'psx-input psx-search',
                      placeholder: '搜索插件（名称 / 描述）',
                      value: query,
                      onChange: (event) => setQuery(event.target.value),
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'psx-mini',
                        'data-on': grouped ? 'true' : 'false',
                        onClick: () => setGrouped((prev) => !prev),
                        title: '按功能分类分组显示',
                      },
                      grouped ? '分组 ✓' : '分组',
                    ),
                    h('span', { className: 'psx-muted' }, `${matched.length} / ${plugins.length}`),
                  ),
                  matched.length === 0
                    ? h('p', { className: 'psx-muted' }, '没有匹配的插件')
                    : grouped
                      ? h(
                          'div',
                          { className: 'psx-groups' },
                          groupByCategory(matched).map(([category, rows]) =>
                            h(
                              'div',
                              { key: category, className: 'psx-catGroup' },
                              h('div', { className: 'psx-groupHead' }, `${category} ${rows.length}`),
                              renderChips(rows),
                            ),
                          ),
                        )
                      : renderChips(matched),
                );
              })(),
          picked === null
            ? null
            : h(
                'div',
                { className: 'psx-inspect' },
                h(
                  'div',
                  { className: 'psx-inspectHead' },
                  h(
                    'div',
                    { className: 'psx-inspectTitle' },
                    h('div', { className: 'psx-inspectName' }, picked.meta?.title ?? shortName(picked.moduleName)),
                    h('code', { className: 'psx-inspectModule' }, picked.moduleName),
                  ),
                  h(
                    'div',
                    { className: 'psx-blockActions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'psx-mini',
                        disabled: busy === picked.moduleName,
                        onClick: () => void togglePlugin(picked),
                      },
                      picked.enabled === false ? '启用此插件' : '停用此插件',
                    ),
                    h('button', { type: 'button', className: 'psx-mini', onClick: () => setPicked(null) }, '收起'),
                  ),
                ),
                h(
                  'p',
                  { className: 'psx-inspectDesc' },
                  picked.meta?.description ?? '这个插件没有提供说明。',
                ),
                h(
                  'dl',
                  { className: 'psx-inspectGrid' },
                  h('dt', null, 'entryId'),
                  h('dd', null, String(picked.entryId ?? '—')),
                  h('dt', null, '状态'),
                  h('dd', null, rowState(picked).tag ?? '启用中'),
                  h('dt', null, '条件'),
                  h('dd', null, picked.condition ?? '—'),
                  h('dt', null, '挂载阶段'),
                  h('dd', null, String(picked.fiberPhase ?? '—')),
                ),
                picked.meta?.error ? h('p', { className: 'psx-note' }, `元数据告警：${picked.meta.error}`) : null,
              ),
        ),

        h(
          'div',
          { className: 'psx-block' },
          h(
            'div',
            { className: 'psx-blockHead' },
            h('h4', { className: 'psx-blockTitle' }, COPY.mcp, h('span', { className: 'psx-count' }, String(mcpRows.length))),
          ),
          mcpRows.length === 0
            ? h('p', { className: 'psx-muted' }, COPY.none)
            : h(
                'div',
                { className: 'psx-chips' },
                mcpRows.map((r, i) => {
                  const s = rowState(r);
                  return h(Chip, { key: `mcp-${i}`, label: shortName(r.moduleName), state: s.state, tag: s.tag });
                }),
              ),
        ),

        h(SkillsBlock, {
          ctx,
          presetId: row.id,
          collapsed: collapsed.skills,
          onToggle: () => toggleBlock('skills'),
        }),

        h(
          'p',
          { className: 'psx-note' },
          channel.state === 'idle'
            ? '通道：探测中…'
            : channel.state === 'ok'
              ? '通道：✅ HTTP（/preset-studio/，写文件不碰 profile）'
              : channel.state === 'missing'
                ? '通道：❌ HTTP 不可达，已退回 settings：' + String(channel.detail ?? '')
                : '通道：❌ ' + String(channel.detail ?? ''),
        ),
        h(
          'div',
          { className: 'psx-blockHead' },
          h(
            'button',
            { type: 'button', className: 'psx-mini', onClick: () => setDiagOpen((prev) => !prev) },
            diagOpen ? '诊断 ✓' : '诊断',
          ),
        ),
        diagOpen
          ? h(
              'div',
              { className: 'psx-diag' },
              health.status === 'error'
                ? h('p', { className: 'psx-toast', 'data-tone': 'err' }, `HTTP 不可达：${health.error}`)
                : health.status !== 'ready'
                  ? h('p', { className: 'psx-muted' }, '读取诊断中…')
                  : h(
                      'dl',
                      { className: 'psx-inspectGrid' },
                      h('dt', null, '通道'),
                      h('dd', null, 'HTTP ✅（/preset-studio）'),
                      h('dt', null, 'Node'),
                      h('dd', null, String(health.data.node ?? '—')),
                      h('dt', null, '模块存储'),
                      h('dd', null, String(health.data.store ?? '—')),
                      h('dt', null, '提示词目录'),
                      h('dd', null, String(health.data.promptsDir ?? '—')),
                      h('dt', null, '模块'),
                      h('dd', null, `${health.data.modules?.length ?? 0} 个：` + (health.data.modules ?? []).map((m) => `${m.section}${m.enabled ? '' : '(停用)'}`).join(', ')),
                      h('dt', null, '外部检测'),
                      h('dd', null, health.data.detected?.baselineReady ? `基线已建，已纳管 ${health.data.detected.count} 段` : '基线未建立（首次装配后生成）'),
                      h('dt', null, 'configEditor'),
                      h('dd', null, health.data.configEditor ? '可用' : '不可用'),
                      h('dt', null, '可编辑 preset 行'),
                      h('dd', null, (health.data.editablePresetRows ?? []).join(', ') || '—'),
                      h('dt', null, '官方入口'),
                      h(
                        'dd',
                        null,
                        (() => {
                          try {
                            const diag = window.__presetStudioDiag;
                            if (!diag) return '未执行（插件未激活或脚本未运行到）';
                            if (diag.mode === 'takeover') return '已接管官方那条：换的是它的渲染体，条目还在（侧栏只有一条）';
                            return `没接上（mode=${String(diag.mode ?? '—')}, official=${String(diag.hasOfficial)}, why=${String(diag.why ?? '—')}）`;
                          } catch {
                            return '无法读取';
                          }
                        })(),
                      ),
                      h('dt', null, 'skill 根'),
                      h('dd', null, (health.data.skillRoots ?? []).map((root) => `${root.source}: ${root.path}`).join('\n')),
                    ),
            )
          : null,
        h('p', { className: 'psx-note' }, COPY.footerNote),
      );
    }

    function Card({ row, saving, onMakeDefault, onOpen }) {
      const d = display(row);
      return h(
        'li',
        { className: 'psx-card', 'data-agent-preset-id': row.id, 'data-active': row.isDefault ? 'true' : 'false' },
        h(
          'button',
          {
            type: 'button',
            className: 'psx-cardMain',
            'aria-pressed': Boolean(row.isDefault),
            disabled: Boolean(row.isDefault || (row.broken === undefined && saving)),
            title: row.isDefault ? COPY.inUse : COPY.setDefault,
            onClick: () => {
              if (row.broken === undefined && !row.isDefault) onMakeDefault(row.id);
            },
          },
          h(
            'span',
            { className: 'psx-cardHead' },
            h(
              'span',
              { className: 'psx-cardIdentity' },
              h('span', { className: 'psx-cardName', title: d.name }, d.name),
              h(Tag, { tone: row.isDefault ? 'solid' : 'outline' }, row.isDefault ? COPY.inUse : null),
            ),
            h('code', { className: 'psx-cardId', title: row.id }, row.id),
          ),
          h('p', { className: 'psx-cardDesc', title: d.description ?? COPY.noDescription }, d.description ?? COPY.noDescription),
        ),
        h(
          'div',
          { className: 'psx-cardFoot' },
          h('span', { className: 'psx-cardHelp' }),
          h(
            'button',
            {
              type: 'button',
              className: 'psx-iconButton',
              title: COPY.configure,
              'aria-label': `${COPY.configure}: ${d.name}`,
              onClick: () => onOpen(row.id),
            },
            IconBrowse ? h(IconBrowse, {}) : h('span', null, '⋯'),
          ),
        ),
      );
    }

    /** 入口组件：只负责提供通知上下文，真正的页面在 StudioShell。 */
    function StudioSection(props) {
      return h(NoticeProvider, null, h(StudioShell, props));
    }

    function StudioShell({ ctx }) {
      const [state, setState] = useState({ status: 'idle', error: null, rows: [], saving: false, view: null });
      const [shadowWarn, setShadowWarn] = useState(null);

      // 没接上官方那条，等于用户点开看到的是官方旧界面——这是最难察觉的问题，所以提到页面顶部提示。
      useEffect(() => {
        const check = () => {
          try {
            const diag = window.__presetStudioDiag;
            // why === 'official-not-registered-yet' 是正常时序（官方插件比我们晚注册），
            // 这时连入口都还没有，不该弹红条；只有"该在却接不上"才是真问题。
            if (diag && diag.mode === 'none' && diag.why !== 'official-not-registered-yet') {
              setShadowWarn(
                `没接上官方那条「Agent 预设」：mode=${String(diag.mode ?? '—')}、官方条目 ${String(diag.hasOfficial)}、原因 ${String(diag.why ?? '—')}。这时点开看到的是官方旧界面。`,
              );
            } else {
              setShadowWarn(null);
            }
          } catch {
            setShadowWarn(null);
          }
        };
        check();
        const timer = setInterval(check, 2000);
        return () => clearInterval(timer);
      }, []);
      const { notify, clear: clearNotice } = useNotifier();

      /** 官方「创造模式」入口：用 cordis preset 起一个新任务，让 Agent 去写 preset/插件。 */
      const startCreator = () => {
        try {
          const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
          if (!workspace || typeof workspace.startSession !== 'function') {
            notify('当前部署没有 uiWorkspace，无法打开创造模式。可以到「插件」页用「让 Agent 创建插件」。');
            return;
          }
          workspace.startSession(undefined, { clearPreviousDraft: false, agentPreset: 'cordis' });
          clearNotice();
          try {
            ctx.get('settings')?.close?.();
          } catch {
            /* 关闭设置失败不影响已发起的会话 */
          }
        } catch (error) {
          notify(`打开创造模式失败：${String(error?.message ?? error)}`);
        }
      };

      const load = useCallback(async () => {
        try {
          const result = await ctx.remote.agentPresets.list();
          if (!result.ok) throw new Error(result.error.message);
          setState((prev) => ({ ...prev, status: 'ready', error: null, rows: result.value.presets }));
        } catch (error) {
          setState((prev) => ({ ...prev, status: 'error', error: String(error?.message ?? error) }));
        }
      }, [ctx]);

      useEffect(() => {
        void load();
      }, [load]);

      const makeDefault = useCallback(
        async (id) => {
          setState((prev) => ({ ...prev, saving: true, error: null }));
          try {
            let revision;
            try {
              const snap = ctx.configForms.get(NS).getSnapshot();
              if (snap?.status === 'ready' && snap.writable) revision = snap.revision;
            } catch {
              /* revision 只是乐观锁 */
            }
            const response = await ctx.remote.settings.update(NS, { selectedDefault: id }, revision);
            if (!response.ok) throw new Error(response.error.message);
          } catch (error) {
            setState((prev) => ({ ...prev, error: String(error?.message ?? error) }));
          } finally {
            await load();
            setState((prev) => ({ ...prev, saving: false }));
          }
        },
        [ctx, load],
      );

      const open = useCallback((id) => setState((prev) => ({ ...prev, view: id })), []);
      const back = useCallback(() => setState((prev) => ({ ...prev, view: null })), []);

      const current = state.view === null ? undefined : state.rows.find((row) => row.id === state.view);
      if (current !== undefined) {
        return h(Detail, { ctx, row: current, onBack: back });
      }

      const developerTools = (() => {
        try {
          return ctx.configForms.get('ui-settings').getSnapshot()?.value?.enabled !== false;
        } catch {
          return true;
        }
      })();

      const rows = state.rows;
      const builtIns = rows.filter((row) => isBuiltIn(row) && (developerTools || !requiresCodingTools(row)));
      const customs = rows.filter((row) => !isBuiltIn(row));

      return h(
        'section',
        { className: 'psx-section' },
        h('h2', { className: 'psx-title' }, COPY.nav),
        h('p', { className: 'psx-intro' }, COPY.intro),
        h(NoticeBar, null),
        shadowWarn === null ? null : h('p', { className: 'psx-toast', 'data-tone': 'err', role: 'alert' }, shadowWarn),
        state.error === null ? null : h('p', { className: 'psx-error', role: 'alert' }, state.error),

        h(
          'section',
          { className: 'psx-group' },
          h('h3', { className: 'psx-groupHead' }, COPY.builtIn),
          h(
            'ul',
            { className: 'psx-cards' },
            builtIns.map((row) => h(Card, { key: row.id, row, saving: state.saving, onMakeDefault: makeDefault, onOpen: open })),
          ),
        ),

        h(
          'section',
          { className: 'psx-group' },
          h('h3', { className: 'psx-groupHead' }, COPY.promptPresets),
          h(ModulesBlock, { ctx, presetId: null, presetIds: rows.map((item) => item.id) }),
        ),

        h(
          'section',
          { className: 'psx-group' },
          h('h3', { className: 'psx-groupHead' }, COPY.custom),
          h(
            'ul',
            { className: 'psx-cards' },
            customs.map((row) => h(Card, { key: row.id, row, saving: state.saving, onMakeDefault: makeDefault, onOpen: open })),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'psx-creator',
              onClick: startCreator,
              title: '打开一个创造模式任务，让 Agent 帮你写 preset 或插件',
            },
            IconPlus ? h(IconPlus, { size: 14 }) : null,
            COPY.creator,
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'remote', 'remote.agentPresets', 'remote.pluginInventory', 'remote.settings', 'configForms'],
      apply(ctx) {
        // 任何一步失败都只让「这一格没注册」，不能让整个客户端模块加载失败——
        // 模块加载链上一旦抛错，后续插件的 bundle 都不会执行。
        try {
          void loadStyle();
          ctx.effect(() => watchStyle(), 'preset-studio:style-watch');
        } catch (error) {
          console.warn('[preset-studio] style bootstrap failed:', error);
        }
        // ctx.slots 每次访问都可能是新的代理对象：缓存一次，注册与打补丁必须作用在同一个上。
        const slots = ctx.slots;
        if (slots === undefined || slots === null) {
          console.warn('[preset-studio] slots service unavailable; settings section not registered');
          return;
        }
        // 官方那条是活的：直接把它的渲染体和侧栏文案换成我们的（不删条目、不藏）。
        // 官方插件比我们晚注册是常态，所以先装机制（subscribe 盯着），第一次接管放在
        // inject 回调里——等到 settings.section 声明好了再动手。
        const control = installSectionControl(slots, () => (props) => h(StudioBoundary, null, h(StudioSection, { ...props, ctx })));
        const dispose = slots.inject('settings.section', () => {
          control.ensure();
          return () => {};
        });

        ctx.effect(
          () => () => {
            try {
              control.dispose();
            } catch {
              /* 还原失败不影响卸载 */
            }
          },
          'preset-studio:official-entry',
        );

        ctx.effect(() => dispose, 'preset-studio:section');

      },
    };
  },
});
