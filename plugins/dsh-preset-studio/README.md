# dsh-preset-studio · Agent 预设工作室

给 DeepSeek Harness 的「Agent 预设」页加上可视化编辑：改 preset 的插件面、管理系统提示词模块、按需开关 skill。

> **一句话**：不用改 host 文件、不用重新打包 DSH，直接在设置页里配置每个 preset 用什么工具、带哪套提示词。

## 它解决什么问题

DSH 官方把「Agent 预设」页做成只读的：能看到每个 preset 声明了哪些插件，但不能改；想改只能进「创造模式」让 Agent 写 bundle。本插件接管这一页，提供：

- **插件开关**：点一下切换某个插件在该 preset 里是否启用（写进 profile patch，走官方 `configEditor`，带锁与回滚）
- **系统提示词模块**：把附加在系统提示词上的自定义内容做成可增删改的模块，按 preset 分配生效范围
- **skill 开关**：从 catalog 里摘掉不需要的 skill，省 token
- **插件体检**：静态检查重复/失败插件，或用会话默认模型做一次功能与冲突分析

## 安装

```bash
dsh plugin --profile desktop add dsh-preset-studio
```

装完**完全退出 DSH Desktop 再打开**（关窗口不算，要托盘退出），设置页侧栏会出现「Agent 预设」。

## 使用

### 插件开关

进「Agent 预设」→ 点某个 preset 卡片右下角的图标 → 详情页：

- **插件**区列该 preset 的全部插件行，点胶囊即切换启用/禁用
- 被禁用的显示删除线；`!!js` 条件禁用的标「条件启用」；挂载失败的标红
- 「详细」模式点胶囊看 `entryId`、条件表达式、挂载阶段
- 「检查」做静态体检；「AI 检查」用会话默认模型分析功能重叠（结果缓存 30 分钟）

### 系统提示词模块

列表页的「系统提示词预设」分组里直接管理：

- 模块 = 一段 markdown，注入位置由 `section` 名与 `order` 决定
- **生效范围**三选一：全部 preset、除某个之外、只勾选某几个
- 支持 `导入`（.md / .txt）、`让 Agent 创建`（复制任务文本并开新会话）、手动添加
- 标记为「默认」的模块不可删除，只能停用或修改

内置两条：`pack:base`（通用工作方式，默认作用于除创造模式外的所有 preset）与 `pack:cordis-creator`（创造模式专用）。

### skill 开关

Skill 区列出该 preset 可见的 skill，点胶囊切换：

- 被禁用的 skill 不再出现在会话的 `<available_skills>` catalog 里
- 只影响可见性：用户直接点名时 `skill` 工具仍能加载
- 目录级开关（`includeDefaultRoots` / 自定义目录）也在这里

## 自定义样式

样式在 `$DSH_HOME/preset-studio/style.css`，首次启动自动生成，改完保存 5 秒内生效（不用刷新）。

所有类名以 `.psx-` 开头，不会和官方或其他插件冲突。删除该文件后重启即可恢复默认；也可以用 `POST /preset-studio/reset-style` 重置。

## 数据与路径

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/preset-studio/modules.json` | 提示词模块定义 |
| `$DSH_HOME/preset-studio/skills.json` | 被禁用的 skill 名 |
| `$DSH_HOME/preset-studio/detected.json` | 外部提示词检测记录与基线 |
| `$DSH_HOME/preset-studio/style.css` | 自定义样式 |
| `$DSH_HOME/preset-studio/prompts/*.md` | 文件型模块的正文 |

改 preset 的插件开关与 skill 目录会写 `profiles/<name>/cordis.patch.yml`，写入走 `configEditor`（文件锁 + 原子写 + 写后校验 + 失败回滚）。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-preset-studio
```

包内另附 `uninstall-preset-studio.ps1`（仓库中），会一并清理 profile patch 里留下的 `preset-studio` 行；加 `-PurgeData` 才删除 `$DSH_HOME/preset-studio/`。

## 已知限制

- **只对之后新建的会话生效**：改 preset 定义不会影响已在运行的会话，它们保留开始时的配置
- **skill 开关只影响 catalog 可见性**：DSH 的 skill registry 没有 per-skill 禁用接口
- **MCP 工具只能看不能选**：工具可见性由 MCP server 挂载决定，宿主没有 per-tool 过滤能力
- **接管官方设置页**依赖「设置页导航读取 `entries()` 且不按 id 去重」这一实现细节。探测不到时自动跳过，侧栏会出现两条「Agent 预设」（功能不受影响），页面顶部会有提示
- 客户端只加载 `exports["./client"]` 单个文件，所以样式与逻辑都在 `client.js` 内（样式已外置到 `style.css`）

## 兼容性

在 DSH Desktop 0.2.1-rc.2（Windows）验证。理论上不依赖平台，但未在其他版本与其他系统上测试。

## 许可

MIT
