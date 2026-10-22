# dsh-agent-preset-editor · Agent 预设编辑器

给 DeepSeek Harness 的「Agent 预设」页加上可视化编辑：改 preset 的插件面、管理系统提示词模块、把插件注入的提示词收归 preset 管理、按需开关 skill。

> **一句话**：不用改 host 文件、不用重新打包 DSH，直接在设置页里配置每个 preset 用什么工具、带哪套提示词。

## 它解决什么问题

DSH 官方把「Agent 预设」页做成只读的：能看到每个 preset 声明了哪些插件，但不能改；想改只能进「创造模式」让 Agent 写 bundle。本插件接管这一页，提供五件事：

### 1. 插件开关

点一下切换某个插件在该 preset 里是否启用。写入走官方 `configEditor`（文件锁 + 原子写 + 写后校验 + 失败回滚），不直接改你的配置文件。

### 2. 系统提示词模块

把附加在系统提示词上的内容做成可增删改的模块，每个模块有：

- `section` 名 —— 决定注入位置。**填成官方段的名字就是覆盖那一段**（如 `tool:read`）
- `order` —— 同层内的排序
- **生效范围** —— 全部 preset / 除某个之外 / 只勾选某几个
- **操作模式** —— 注入文本 / 删除同名段 / 整体替换全部

编辑时如果 `section` 命中官方段，会立刻红条警告「你正在覆盖 DSH 自带的段」。

### 3. 接管插件注入的提示词

这是本插件最独特的能力。DSH 里很多插件会往系统提示词里塞内容（`dsh-persona` 加人设、`dsh-plan-mode` 加计划约束、`dsh-gitbash` 加 shell 规则…），它们**对所有会话全局生效**，你没法控制。

本插件会：

1. 在装配时发现「不是基线、不是我们注入」的段
2. **自动接管** —— 按原文建一个同名模块，`source: 'detected'`，默认全部 preset 生效
3. 从此这段文本可编辑、可按 preset 关闭：**范围不含某个 preset 时，该 preset 里它会注册空段被遮蔽掉**

「注入型插件」面板可以扫出全部注入者（含跨包常量引用解析，能认出只有 `name: PERSONA_PREFIX_SECTION` 这种写法的插件）。

**核心段受保护**：`harness:identity`、`tool:*`、`plan:*`、`mcp:*`、`deployment:persona-*` 等永不自动接管，避免一开就把 agent 弄失能。

### 4. skill 开关

skill 区列出该 preset 可见的全部 skill（数据源是 skill registry，不是扫目录），点胶囊切换：

- 被禁用的 skill 不再出现在会话的 `<available_skills>` catalog 里
- 只影响可见性：用户直接点名时 `skill` 工具仍能加载、执行
- 目录级开关（`includeDefaultRoots` / 自定义目录）也在这里

### 5. 自定义样式

样式在 `$DSH_HOME/preset-studio/style.css`，首次启动自动生成，改完保存 5 秒内生效（不用刷新）。所有类名以 `.psx-` 开头。

文件以 `/* @psx-version: <版本> */` 打头。插件升级时版本对不上，会先把旧文件备份成 `style.css.<旧版本>.bak` 再按新默认重写——所以升级即修样式，不会因为「文件已经存在」而永远停在旧样式上。改过的内容在 `.bak` 里。

## 安装

```bash
dsh plugin --profile desktop add dsh-agent-preset-editor
```

装完**完全退出 DSH Desktop 再打开**（关窗口不算，要托盘退出），设置页侧栏会出现「Agent 预设」。

## 使用

进「Agent 预设」→ 点某个 preset 卡片右下角的图标 → 详情页：

| 区域 | 能做什么 |
|---|---|
| **插件** | 点胶囊切换启用/禁用；「详细」看 `entryId`、条件表达式、挂载阶段；「检查」做静态体检；「AI 检查」用会话默认模型分析功能重叠（结果缓存 30 分钟） |
| **MCP 工具** | 只读展示该 preset 挂载的 MCP 工具 |
| **Skill** | 单个 skill 开关 + 目录级配置 |
| **系统提示词模块** | 模块增删改、范围、操作模式；底部「注入型插件」面板可扫描全部注入者 |

### 接管插件提示词的典型操作

想让 `dsh-gitbash` 的 shell 规则只在「标准模式」生效：

1. 详情页 → 系统提示词模块，找到 `tool:bash`（标着「来自插件」）
2. 点「编辑」→ 生效范围从「全部 preset」改成只勾 `standard`
3. 保存 → 其他 preset 里这段自动消失

## 数据与路径

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/preset-studio/modules.json` | 提示词模块定义（含接管的插件段） |
| `$DSH_HOME/preset-studio/skills.json` | 被禁用的 skill 名 |
| `$DSH_HOME/preset-studio/detected.json` | 外部提示词基线与被接管的段 |
| `$DSH_HOME/preset-studio/gates.json` | 段门控策略（可选，默认不参与） |
| `$DSH_HOME/preset-studio/style.css` | 自定义样式 |
| `$DSH_HOME/preset-studio/prompts/*.md` | 文件型模块的正文 |

改 preset 的插件开关与 skill 目录会写 `profiles/<name>/cordis.patch.yml`，写入走 `configEditor`。

所有 JSON 写入用「临时文件 + rename」，中途崩溃不会留下半个文件。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-agent-preset-editor
```

包内另附 `uninstall.ps1`，会一并清理 profile patch 里留下的行；加 `-PurgeData` 才删除 `$DSH_HOME/preset-studio/`。

## 已知限制

- **只对之后新建的会话生效**：改 preset 定义不影响已在运行的会话
- **接管的提示词是快照**：模块里存的是检测那一刻的原文。插件升级改了提示词后，删除该模块，下次装配会重新抓取
- **skill 开关只影响 catalog 可见性**：DSH 的 skill registry 没有 per-skill 禁用接口
- **MCP 工具只能看不能选**：工具可见性由 MCP server 挂载决定，宿主没有 per-tool 过滤能力
- **整体替换（complete）每个 preset 只能有一个**：设了两个装配时会报错，UI 会提前拦截
- **接管官方设置页**只有一条路：直接改官方那条，不删、不藏、也不另建一条。把它的 `entry.component` 和 `entry.options.label` 换成我们的，原件留在 `entry.__psxOriginal` 里，插件卸载时还原。渲染器每次渲染都重新读 `entry.component`（`dsh-client-ui-renderer/lib/client.js`），所以改完 markDirty 一次就生效，条目还在、侧栏天然一条。插件拿到的 `ctx.slots` 是渲染器的 Service 外壳，只有 `entries / subscribe / register / getVersion`（没有 `records`/`markDirty`/`onMutate`），所以条目从公开的 `entries()` 取、版本号用「注册一条空条目再当场释放」自增、用 `subscribe('settings.section')` 等官方晚注册。官方还没出现、或连 `entries()` 都读不到时**什么都不做**（绝不注册第二个「Agent 预设」），页面顶部红条会写明 `mode` 与原因，这时点开看到的是官方旧界面
- **客户端只加载 `exports["./client"]` 单个文件**：样式已外置到 `style.css`，逻辑仍在 `client.js` 内

## 兼容性

在 DSH Desktop 0.2.1-rc.2（Windows）验证。未在其他版本与其他系统测试。

## 开发

```bash
npm test         # 111 项断言 = 纯函数 78 + 渲染冒烟 33
node verify.mjs  # 发版前必跑：测试 → 语法 → 打包 → 装进 profile → 校验配置与日志里的崩溃签名
```

`npm test` 跑两个文件：

- `test/pure.test.mjs`（78 项）：范围判定 / 官方段识别 / skill 解析 / catalog 过滤 / 段删除 / 官方条目接管与还原（含「绝不注册第二个」的回归断言）/ 样式版本 / 防漂移。纯函数，不碰 React。
- `test/render.mjs`（33 项）：**不用 react-dom**，自己写了一个 40 行的迷你渲染器（`useState/useMemo/useEffect/useContext` 全部极简实现，真 React 只提供 `createElement`/`createContext`/`Component`），把 `client.js` 整段 bundle 在假环境里跑起来：apply → 等官方那条出现 → 改它的渲染体（登记表仍一条）→ 渲染列表页 → 点卡片进详情 → 点「检查 / 详细 / AI 检查」→ 返回再进一次。还带三条 harness 自检：组件抛错必须被报成「组件 X 渲染失败：原因」、**hook 条件调用必须被抓到**（React #300 的成因）、setState 不收敛必须报错。

`prepack` 会自动跑测试，不通过打不了包。`verify.mjs` 额外检查三件测试覆盖不到的事：装进 profile 后版本对不对、`--dump-config` 里本插件那行在不在（且官方 `ui-agent-preset` 没被 `disabled`）、本次运行期间日志里有没有新增崩溃签名（`slot entry crashed` / `duplicate factory registration` / `is not defined`）。

## 许可

MIT
