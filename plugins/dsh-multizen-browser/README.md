# dsh-multizen-browser

把 DSH 侧边栏的浏览器换成 **MultiZen 指纹浏览器**。

## 为什么需要它

宿主侧边栏的 browser tab 是一个 `sandboxed iframe`（`@deepseek-ai/dsh-client-ui-sidebar-browser` 里的 `WEB_BROWSER_SANDBOX`）。抖音、小红书、X、YouTube 这些站点要么发 `X-Frame-Options: DENY`，要么在 JS 里检测 `window.top !== window.self`，直接拒绝被嵌入。改配置绕不过去 —— 那是站点的安全策略。

这个插件让侧边栏的 iframe 指向**自己的同源页面**（同源不受 XFO 限制），页面里用 `<canvas>` 显示 MultiZen 里那个**真实 Chromium 窗口**的画面，鼠标键盘转发过去。于是你看到的是真浏览器，带着 profile 的 Cookie、指纹、代理。

## 结构

| 路由 | 作用 |
|---|---|
| `GET /multizen-view?url=&target=` | 同源查看器（工具栏 + canvas） |
| `WS /multizen-cdp` | 桥接 MultiZen Chromium 的 CDP（默认 `127.0.0.1:9222`） |
| `GET /multizen-status` | 健康探针：能不能连上、连的是哪个 target |

`dsh-better-sidebar` 的 `sidebar_open` 已改成：`http(s)` URL 自动改写成 `/multizen-view?url=…`。设 `DSH_MULTIZEN_VIEW_OFF=1` 可关掉这个改写。

## 三个必须知道的坑

### 1. 未获得焦点的 target 一帧都不出

CloakBrowser（MultiZen 的 Chromium）里，一个从未被带到前台的 page target **什么都不画**：`Page.startScreencast` 返回 `{}` 然后永久静默，`Page.captureScreenshot` 会一直返回同一张冻结的旧图。

必须先把渲染器唤醒：

```js
await send('Page.bringToFront')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
```

三步都做完，screencast 才正常出帧。**只做 metrics override 不够**（实测）。

### 2. CDP 的 `send()` 返回整条消息，不是 `result`

```js
const m = await send('Page.getLayoutMetrics')
m.result.visualViewport.clientWidth   // ✓
m.visualViewport.clientWidth          // ✗ undefined
```

### 3. `registerUpgrade` 交给你的是**原始 socket**

```js
// 插件内部
wss.handleUpgrade(req, socket, head, ws => { viewer = ws })
```

如果外层先把 socket 升级成 WebSocket 再传进来，`viewer` 永远是 `undefined`，连接既不关闭也不响应 —— 看起来像"连上了但没反应"。

测试 harness 必须原样传：`r.handler(req, socket, head)`。

### 4. 输入走 DOM 合成，不走 Input 域

CloakBrowser 吞掉 DevTools 的 `Input.dispatchMouseEvent`（返回 ok 但没效果）。点击/滚动/按键全部通过 `Runtime.evaluate` 合成：`pointerover → pointerenter → pointerdown → pointerup → mouseover → mousedown → mouseup → click`，配合 `elementFromPoint` 和原生 `value` setter。

## 安装

```powershell
# 源码
C:\Users\lt\.dsh\dsh-multizen-browser\

# 拷进 profile
$dst = "C:\Users\lt\.dsh\profiles\desktop\node_modules\dsh-multizen-browser"
New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
Copy-Item 每个文件...

# 在 profile 的 cordis.patch.yml 末尾加挂载条目（用 - insert: 而不是 - id:）
- insert:
    - id: multizen-browser
      name: dsh-multizen-browser
      config:
        cdpEndpoint: "http://127.0.0.1:9222"
        inputMode: dom
        quality: 72
        maxWidth: 1600
        maxHeight: 1200
```

**手拷目录不会自动合并 `cordis.patch.yml`** —— 只有 `dsh plugin add` 才会。必须自己往 profile 的 patch 文件里写 `- insert:`。

重启 DSH 生效。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `cdpEndpoint` | `http://127.0.0.1:9222` | MultiZen 的 CDP 端口 |
| `quality` | 72 | JPEG 质量 |
| `maxWidth` / `maxHeight` | 1600 / 1200 | screencast 缩放上限 |
| `inputMode` | `dom` | 合成 DOM 事件（不要改） |
| `watchdogMs` | 1500 | screencast 多久没帧就切轮询 |
| `captureIntervalMs` | 450 | 轮询间隔 |

## 验证

```powershell
cd C:\Users\lt\.dsh\profiles\desktop
node <拷贝过来的 harness>.mjs
```

预期输出：

```
[1] GET /multizen-view → 200, 8913 字节, 含 canvas: true
[2] GET /multizen-status → 200: {"ok":true,...}
[3] ready → {"t":"ready","vw":1424,"vh":771}
[5] 15s 内帧数: 10+   ← 出帧
```

输入链路的完整验证用 `test/input-test.mjs`：点击关弹窗 → 滚轮 → 导航，会落 4 张 jpg 到 `_test/` 供肉眼对比。

## 回滚

```powershell
# 插件挂载
删掉 profile cordis.patch.yml 末尾那段 - insert:

# sidebar_open 改写
Copy-Item "C:\Users\lt\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\lib\index.js.bak-predirect" `
          "C:\Users\lt\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\lib\index.js" -Force
```

⚠️ `dsh-better-sidebar` 升级会覆盖 `lib/index.js`，改写随之丢失 —— 升级后重新打一次，或设 `DSH_MULTIZEN_VIEW_OFF=1` 先关掉。

## 已知限制

- **只管 AI 打开的 URL**。用户手动在侧边栏点「+」新建 browser tab 并输入网址，走的还是宿主原生 iframe，仍会被 XFO 拦。要覆盖这条路径得改 `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-client-ui-sidebar-browser\lib\client.js`（需管理员权限，DSH 升级即丢）—— 本次没做。
- 一次只桥接一个 target。新开 MultiZen 窗口需要刷新侧边栏重新挑 target。
- 画面走 screencast，静止时不出帧是正常的（省带宽）；有变化才推。
