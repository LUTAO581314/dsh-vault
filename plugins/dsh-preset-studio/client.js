/**
 * Client half of dsh-preset-studio — M2：卡片 → 详情页（只读）。
 *
 * M1 已接管官方「Agent 预设」整格（同 id + priority -1，并拦截 entries() 隐藏官方导航项）。
 * M2 增加页内子页面：点卡片右下角图标进入，展示该 preset 初始携带的
 * 插件 / MCP / Skill / 提示词模块。增删与保存是 M3，提示词编辑器是 M4。
 */
window.__ModuleLoader__.load({
  id: 'dsh-preset-studio',
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

    /** 统一通知：所有区块共用一套 toast，不再各自维护 message state。 */
    function useNotifier() {
      const [toast, setToast] = useState(null);
      const notify = useCallback((text, tone) => {
        setToast({ text, tone: tone ?? (/失败|错误|不可|无法/.test(String(text)) ? 'err' : 'ok') });
      }, []);
      const clear = useCallback(() => setToast(null), []);
      const view =
        toast === null
          ? null
          : h('p', { className: 'psx-toast', 'data-tone': toast.tone, role: 'status' }, toast.text);
      return { notify, clear, view };
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

    /**
     * 遮蔽官方 settings 条目：设置页导航读的是 entries()（不按 id 去重），
     * 会把同 id 的官方条目也列出来。这里拦截读取并隐藏它。
     * @returns dispose：还原原始实现。
     */
    function installEntryShadow(slots) {
      if (slots === undefined || slots === null) return () => {};
      if (slots.__presetStudioShadow === true) return slots.__presetStudioUnshadow ?? (() => {});
      const probe = slots.entries('settings.section');
      const hasOfficial = probe.some((entry) => entry?.options?.id === 'agent-presets' && (entry.options.priority ?? 0) === 0);
      const hasOurs = probe.some((entry) => entry?.options?.id === 'agent-presets' && (entry.options.priority ?? 0) === -1);
      const diag = { hasOfficial, hasOurs, shadow: false, sameObject: slots.entries === slots.__presetStudioOriginal, reason: null };
      try {
        window.__presetStudioDiag = diag;
      } catch {
        /* 非浏览器环境 */
      }
      if (!hasOfficial || !hasOurs) {
        diag.reason = !hasOfficial ? 'official-missing' : 'own-missing';
        return () => {};
      }

      const original = slots.entries.bind(slots);
      try {
        Object.defineProperty(slots, 'entries', {
          configurable: true,
          writable: true,
          value: (key) => {
            const all = original(key);
            if (key !== 'settings.section') return all;
            const filtered = all.filter(
              (entry) => !(entry?.options?.id === 'agent-presets' && (entry.options.priority ?? 0) !== -1),
            );
            return filtered.length === all.length ? all : filtered;
          },
        });
        slots.__presetStudioShadow = true;
        if (window.__presetStudioDiag) window.__presetStudioDiag.shadow = true;
        const restore = () => {
          try {
            Object.defineProperty(slots, 'entries', { configurable: true, writable: true, value: original });
          } catch {
            /* 还原失败就保持现状 */
          }
          slots.__presetStudioShadow = false;
          if (window.__presetStudioDiag) window.__presetStudioDiag.shadow = false;
        };
        slots.__presetStudioUnshadow = restore;
        return restore;
      } catch (error) {
        console.warn('[preset-studio] cannot shadow the built-in settings entry:', error);
        if (window.__presetStudioDiag) {
          window.__presetStudioDiag.reason = `defineProperty-failed: ${String(error?.message ?? error)}`;
        }
        return () => {};
      }
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

    function appliesTo(entry, presetId) {
      const scope = entry.presets ?? '*';
      if (scope === '*') return true;
      if (Array.isArray(scope)) return scope.includes(presetId);
      return false;
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

    function ModuleRow({ entry, presetId, presetIds, onSave, onRemove, saving, autoEdit }) {
      const [editing, setEditing] = useState(Boolean(autoEdit));
      const [draft, setDraft] = useState(autoEdit && typeof entry.text === 'string' ? entry.text : '');
      const [meta, setMeta] = useState({
        section: entry.section ?? 'pack:module',
        order: Number.isFinite(entry.order) ? entry.order : 0,
        presets: entry.presets ?? '*',
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
              h('textarea', {
                className: 'psx-textarea',
                rows: 8,
                value: draft,
                placeholder: COPY.moduleText,
                onChange: (event) => setDraft(event.target.value),
              }),
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
      const { notify, clear: clearNotice, view: noticeView } = useNotifier();
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
              noticeView,
              state.status === 'ready' && state.found === false
                ? h('details', { className: 'psx-raw' }, h('summary', null, '看到的 preset 声明（前 400 字）'), h('pre', null, state.raw ?? ''))
                : null,
              h('p', { className: 'psx-note' }, '当前只支持目录级选择；按单个 skill 开关需要 DSH 的 skill filter provider（尚未提供）。'),
            ),
      );
    }

    function ModulesBlock({ ctx, presetId, presetIds }) {
      const [state, setState] = useState({ status: 'loading', list: [], transport: 'unknown', pending: false, autoEditId: null });
      const { pending: busy, autoEditId } = state;
      const { notify, clear: clearNotice, view: noticeView } = useNotifier();


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
        noticeView,
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
      const { notify, clear: clearNotice, view: noticeView } = useNotifier();

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
          noticeView,
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
                      h('dt', null, '导航遮蔽'),
                      h(
                        'dd',
                        null,
                        (() => {
                          try {
                            const diag = window.__presetStudioDiag;
                            if (!diag) return '未执行（插件未激活或脚本未运行到）';
                            if (diag.shadow) return '已生效：官方条目被隐藏';
                            return `未生效（official=${String(diag.hasOfficial)}, ours=${String(diag.hasOurs)}, reason=${String(diag.reason ?? '—')}）`;
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

    function StudioSection({ ctx }) {
      const [state, setState] = useState({ status: 'idle', error: null, rows: [], saving: false, view: null });
      const [shadowWarn, setShadowWarn] = useState(null);

      // 遮蔽失效会让侧栏出现两条「Agent 预设」——这是最难察觉的问题，所以提到页面顶部提示。
      useEffect(() => {
        const check = () => {
          try {
            const diag = window.__presetStudioDiag;
            if (diag && diag.shadow === false) {
              setShadowWarn(
                `导航遮蔽未生效：官方条目 ${String(diag.hasOfficial)}、我们的条目 ${String(diag.hasOurs)}、原因 ${String(diag.reason ?? '—')}。侧栏可能出现两条「Agent 预设」，功能不受影响。`,
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
      const { notify, clear: clearNotice, view: noticeView } = useNotifier();

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
          noticeView,
        ),
      );
    }

    return {
      inject: ['slots', 'remote', 'remote.agentPresets', 'remote.pluginInventory', 'remote.settings', 'configForms'],
      apply(ctx) {
        void loadStyle();
        ctx.effect(() => watchStyle(), 'preset-studio:style-watch');
        // ctx.slots 每次访问都可能是新的代理对象：缓存一次，注册与打补丁必须作用在同一个上。
        const slots = ctx.slots;
        const dispose = slots.inject('settings.section', () => {
          const registration = ctx.slots.register(
            { name: 'settings.section', id: 'agent-presets', order: 20, priority: -1, label: () => COPY.nav },
            (props) => h(StudioBoundary, null, h(StudioSection, { ...props, ctx })),
          );
          // 注册完成后立刻遮蔽官方条目：apply 顶层探测时我们的条目可能还没进 ledger。
          installEntryShadow(slots);
          return registration;
        });

        // 遮蔽官方条目（带探测与自愈）：官方一旦改成去重渲染，这里的探测会失败并跳过，不会误伤。
        let restore = installEntryShadow(slots);
        const retry = setInterval(() => {
          if (slots?.__presetStudioShadow === true) return;
          const next = installEntryShadow(slots);
          if (next !== restore) restore = next;
        }, 3000);
        window.addEventListener('beforeunload', () => clearInterval(retry), { once: true });

        ctx.effect(
          () => () => {
            clearInterval(retry);
            try {
              restore();
            } catch {
              /* 还原失败不影响卸载 */
            }
          },
          'preset-studio:shadow',
        );

        ctx.effect(() => dispose, 'preset-studio:section');
      },
    };
  },
});
