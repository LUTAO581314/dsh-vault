# 提示词段门控（gate）

版本：0.49.0 起。引擎在 `gate.js`，由 `index.js` 的 host 半接线。

## 它解决什么

host 平面上的插件往 system prompt 注册段时，**对所有 preset 的会话都生效**。
本引擎把它改成「**按 preset 自行启用**」：

- 默认策略 `inherit` —— 检测到就登记，不改变现状
- 你把某段（或某个插件）切成 `gate` 之后，未勾选的 preset 里那段就不出现

## 机制

在 `agent/created` 时，对该 agent 的 scope 注册一条**同名、空文本**的 section：

```js
agent.ctx.inject(['systemPrompt'], (child) => {
  child.systemPrompt.section({ name, order: 0, text: '' });   // 遮蔽全局同名段
});
```

依据（都在宿主源码里）：

| 事实 | 出处 |
|---|---|
| 注册按**调用方 ctx 的 scope** 归档 | `dsh-system-prompt` `SystemPrompt.section()` 文档 |
| scoped section 遮蔽 global 同名段 | `dsh-scope` `ScopedLayers.merge()`：global 先写、scope 链由远到近覆盖 |
| 空文本段在渲染时被丢弃 | `renderPrompt()` 过滤 `text.length > 0` |
| 官方插件也这么做 | `dsh-subagent/lib/index.js:390` 用同名段给子代理装 persona |

选遮蔽而不是「装配期过滤」的原因：`assemble()` 在存在 `complete` 段时会把
waterfall 的结果整个换掉，装配期过滤对 `complete` 段无效；scope 遮蔽不受这个限制。

## 状态

`$DSH_HOME/preset-studio/gates.json`

```jsonc
{
  "schema": 1,
  "sections": {
    "acme:rules": {
      "policy": "gate",          // inherit | gate
      "core": false,             // 核心段恒为 true，永不可 gate
      "chars": 412,              // 最近一次观测到的长度（0 的段不许 gate）
      "head": "…前 160 字符…",
      "presets": { "standard": true, "j-space": false }
    }
  },
  "plugins": {
    "@acme/dsh-thing": { "policy": "gate", "presets": {}, "sections": ["acme:rules"] }
  }
}
```

## API（挂在 `/preset-studio` 前缀下）

> 这些路由和插件既有路由一样走宿主的 connection 围栏（Host/Origin + 会话 cookie）。
> 直接 `curl` 会拿到 **403 forbidden**；要么用浏览器打开，要么从浏览器 devtools 里
> 复制 cookie 再带上。下面的 `curl` 只是示意形状。

```bash
# 看全量策略 + 已观测到的段
curl -s http://127.0.0.1:<port>/preset-studio/gate

# 把某段切成 gate（之后未勾选的 preset 会被遮蔽）
curl -s -X POST http://127.0.0.1:<port>/preset-studio/gate \
  -H 'content-type: application/json' \
  -d '{"name":"acme:rules","policy":"gate"}'

# 给某个 preset 单独开/关
curl -s -X POST .../preset-studio/gate -d '{"name":"acme:rules","presetId":"quant-advisor","enabled":true}'

# 把一批段绑到一个插件名下，然后按插件整体 gate
curl -s -X POST .../preset-studio/gate -d '{"op":"bind","name":"@acme/dsh-thing","sections":["acme:rules","acme:extra"]}'
curl -s -X POST .../preset-studio/gate -d '{"kind":"plugin","name":"@acme/dsh-thing","policy":"gate"}'

# 静态扫描：哪些已装插件在往 system prompt 注册段
curl -s -X POST .../preset-studio/gate/scan
```

## 静态扫描的能力与局限

`scan` 读各包的 `main` + `lib/*.js`，匹配 `systemPrompt.section({ … name: … })`，
并用**跨包常量表**解析 `name: PERSONA_PREFIX_SECTION` 这类间接引用。
在 0.2.1-rc.2 上实测：327 个 dsh 包里认出 20 个注入者。

局限：

- 运行时**拿不到归属**（装配出的段只有 `name` / `text`），扫描是静态猜测，会漏
- 模板字面量段名（`tool:${toolName}`）解析不出，已跳过
- 只能发现「注册成 section」的注入

## 边界（做不到的）

- **persona 段受保护**：`deployment:persona-*` 恒为核心段。所以「某个插件偷偷改了全局
  persona」这件事，本引擎不会替你摘掉——摘掉会连你 preset 自己的 persona 一起没。
- **非 section 注入管不到**：`agent.steer` 注入 user 消息（如 dsh-answer-reviewer）、
  改 composer 草稿（如 dsh-prompt-polish）、改 UI 的插件都不经过装配。
  这类只能整插件禁用，不能在会话级按 preset 门控。
- **插件仍在运行**：门控只让它对 prompt 的可见贡献消失，插件进程照旧跑，
  它的其他副作用（定时器、HTTP 服务、会话事件）不受影响。

## 部署

改动落在 `preset-kit/studio/`，必须同步到实际加载目录并**完整重启 DSH**：

```bash
cp index.js gate.js package.json ~/.dsh/profiles/desktop/node_modules/dsh-agent-preset-editor/
```

测试：`node test/gate.test.mjs`（7 项）、`node test/pure.test.mjs`（34 项）。
