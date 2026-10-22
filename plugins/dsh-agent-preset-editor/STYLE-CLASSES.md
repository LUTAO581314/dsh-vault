# 预设工作室 · 样式类名清单

样式表位置：`~/.dsh/preset-studio/style.css`（首次启动自动生成，之后由你维护）。
改完保存 → 刷新设置页（或重启）生效。也可以再用 `dsh-custom-style` 在它上面叠一层覆盖。

## 页面骨架

| 类名 | 作用 |
|---|---|
| `.psx-section` | 整个板块的外层容器（列表页和详情页共用） |
| `.psx-title` | 板块标题「Agent 预设」 |
| `.psx-intro` | 标题下的说明文字 |
| `.psx-group` | 一个分组（内置 / 系统提示词预设 / 自定义） |
| `.psx-groupHead` | 分组标题（小号大写） |
| `.psx-error` | 错误文字 |

## 预设卡片

| 类名 | 作用 |
|---|---|
| `.psx-cards` | 卡片网格（`grid-template-columns` 控制每行几张） |
| `.psx-card` | 单张卡片；`[data-active="true"]` 是当前默认那张 |
| `.psx-cardMain` | 卡片上半可点击区（点它设为默认） |
| `.psx-cardHead` | 名称 + 标签 + id 的一行 |
| `.psx-cardName` | 预设名称 |
| `.psx-cardId` | 右上角灰色 id（`standard` 等） |
| `.psx-cardDesc` | 描述文字（默认 2 行截断） |
| `.psx-cardFoot` | 卡片底部 |
| `.psx-iconButton` | 右下角「配置」图标按钮 |
| `.psx-creator` | 底部「让 Agent 帮我创建预设模式」按钮 |

## 详情页

| 类名 | 作用 |
|---|---|
| `.psx-detailHead` | 返回 + 标题 + 默认标签 |
| `.psx-back` | 返回按钮（左箭头） |
| `.psx-detailName` / `.psx-detailSub` | 标题 / 副标题 |
| `.psx-block` | 一个分区（提示词模块 / 插件 / MCP / Skill） |
| `.psx-blockHead` | 分区标题行 |
| `.psx-blockTitle` | 分区名 |
| `.psx-count` | 分区名后面的数字 |
| `.psx-blockActions` | 分区头右侧的按钮组 |
| `.psx-fold` | 折叠三角（`aria-expanded="false"` 时旋转） |
| `.psx-placeholder` | 虚线占位框 |
| `.psx-note` / `.psx-muted` | 说明文字 / 弱化文字 |
| `.psx-toast` | 通知条；`[data-tone="ok"]` 绿、`[data-tone="err"]` 红 |
| `.psx-diag` | 诊断面板容器 |

## 提示词模块

| 类名 | 作用 |
|---|---|
| `.psx-modules` | 模块列表容器 |
| `.psx-module` | 单个模块行；`[data-active="false"]` 表示不适用于当前 preset |
| `.psx-moduleHead` | 模块头（section / order / 范围 / 状态 / 按钮） |
| `.psx-moduleName` | section 名（等宽字体） |
| `.psx-moduleMeta` | order、范围、字数等元信息 |
| `.psx-moduleState` | 启用状态徽章；`[data-on="true"]` 绿、`"false"` 灰 |
| `.psx-moduleActions` | 右侧按钮组 |
| `.psx-moduleEditor` | 展开的编辑区 |
| `.psx-metaRow` / `.psx-field` | 编辑区里的 section / order / 范围三列 |
| `.psx-textarea` | 正文 textarea |
| `.psx-mini` | 小按钮；`.psx-primary` 主按钮、`.psx-danger` 危险按钮 |
| `.psx-chipTag` | 小标签（「默认」「来自插件」「已禁用」等） |

## 插件胶囊

| 类名 | 作用 |
|---|---|
| `.psx-catalog` | 插件区容器（搜索栏 + 胶囊） |
| `.psx-catalogBar` | 搜索栏那一行 |
| `.psx-search` | 搜索输入框 |
| `.psx-chips` | 胶囊容器（`gap` 控制间距） |
| `.psx-chip` | 单个胶囊；`[data-state="off"]` 删除线、`"failed"` 红边 |
| `.psx-chipToggle` | 可点击的胶囊（skill、范围选择） |
| `.psx-groups` / `.psx-catGroup` | 按分类分组时的容器 |
| `.psx-inspect` | 「详细」模式下展开的插件详情面板 |
| `.psx-inspectGrid` | 详情里的字段表（entryId / 状态 / 条件 / 挂载阶段） |
| `.psx-aiResult` | AI 检查结果文本块 |
| `.psx-audit` | 静态检查结果列表 |

## 常用改法示例

```css
/* 卡片更圆、网格更密 */
.psx-card { border-radius: 16px; }
.psx-cards { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }

/* 胶囊更紧凑 */
.psx-chip { padding: 3px 8px; font-size: 11px; }

/* 分组标题更醒目 */
.psx-groupHead { color: #2f6feb; letter-spacing: .12em; }

/* 详情页各区之间留白更大 */
.psx-section { gap: 28px; }
```

## 注意

- 类名以 `.psx-` 开头，不会和 DSH 官方或其他插件冲突。
- 布局相关的属性（`display`、`position`）改动可能导致排版错乱，优先改颜色、间距、圆角、字号。
- 想临时试效果，可以直接在 DevTools 里改；确认后写回 `style.css`。
