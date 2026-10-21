/**
 * dsh-multizen-browser — host half.
 *
 * The DSH sidebar's `browser` tab is a sandboxed <iframe> pointed at a URL, and
 * real sites (douyin, xiaohongshu, youtube …) refuse to be framed. This plugin
 * gives that tab something it CAN frame: a same-origin viewer page that draws
 * the MultiZen fingerprint browser's viewport from a CDP screencast, and
 * forwards clicks / wheel / keys back into that page.
 *
 *   GET /multizen-view?url=…   the viewer (iframe-safe, same origin)
 *   WS  /multizen-cdp          CDP bridge to the MultiZen Chromium
 *
 * Input note: MultiZen runs CloakBrowser, which swallows the DevTools Input
 * domain (Input.dispatchMouseEvent returns ok but does nothing). Clicks and
 * keys are therefore synthesized inside the page through Runtime.evaluate —
 * the same workaround the multizen-mcp adapter uses.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

export const name = 'dsh-multizen-browser'
/** The only host service this plugin needs. */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  cdpEndpoint: 'http://127.0.0.1:9222',
  quality: 72,
  maxWidth: 1600,
  maxHeight: 1200,
  inputMode: 'dom',
  /** Give screencast this long to produce a frame before switching to polling. */
  watchdogMs: 1500,
  /** Poll interval for the captureScreenshot fallback. */
  captureIntervalMs: 450,
}

const VIEW_PATH = '/multizen-view'
const CDP_PATH = '/multizen-cdp'

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Fetch the CDP target list; prefers a page whose URL matches, else the first page. */
async function pickTarget(endpoint, wanted) {
  const url = `${endpoint.replace(/\/+$/, '')}/json/list`
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`CDP ${url} → ${res.status}`)
  const list = await res.json()
  const pages = list.filter(t => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && t.webSocketDebuggerUrl !== '')
  if (pages.length === 0) throw new Error('MultiZen 里没有可用的页面目标（先 launch_profile 打开一个窗口）')
  if (wanted) {
    const hit = pages.find(t => t.url === wanted) ?? pages.find(t => t.url.startsWith(wanted))
    if (hit) return hit
  }
  return pages[0]
}

/** A page-side helper that synthesizes a full pointer/mouse sequence at (x, y). */
function clickScript(x, y, button) {
  return `(() => {
  const x = ${Number(x)}, y = ${Number(y)}, button = ${Number(button) || 0};
  const el = document.elementFromPoint(x, y) || document.body;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button, buttons: button === 2 ? 2 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerover', base)); } catch {}
  try { el.dispatchEvent(new PointerEvent('pointerenter', base)); } catch {}
  try { el.dispatchEvent(new MouseEvent('mouseover', base)); } catch {}
  try { el.dispatchEvent(new PointerEvent('pointerdown', base)); } catch {}
  try { el.dispatchEvent(new MouseEvent('mousedown', base)); } catch {}
  el.focus?.({ preventScroll: true });
  const up = { ...base, buttons: 0 };
  try { el.dispatchEvent(new PointerEvent('pointerup', up)); } catch {}
  try { el.dispatchEvent(new MouseEvent('mouseup', up)); } catch {}
  try { el.dispatchEvent(new MouseEvent('click', up)); } catch {}
  return (el.tagName || '') + '|' + ((el.textContent || '').trim().slice(0, 40));
})()`
}

/** Scroll at (x, y): the nearest scrollable ancestor under the cursor, else the window. */
function scrollScript(x, y, dx, dy) {
  return `(() => {
  const x = ${Number(x)}, y = ${Number(y)}, dx = ${Number(dx) || 0}, dy = ${Number(dy) || 0};
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.body && el !== document.documentElement) {
    const s = getComputedStyle(el);
    const scrollable = /(auto|scroll|overlay)/.test(s.overflowY + s.overflowX)
      && (el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4);
    if (scrollable) { el.scrollBy({ left: dx, top: dy, behavior: 'instant' }); return 'el:' + el.tagName; }
    el = el.parentElement;
  }
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return 'window';
})()`
}

/** Type text into the focused editable, or dispatch a key press otherwise. */
function keyScript(kind, key, code, keyCode, text) {
  return `(() => {
  const key = ${JSON.stringify(key)}, code = ${JSON.stringify(code)}, keyCode = ${Number(keyCode) || 0}, kind = ${JSON.stringify(kind)}, text = ${JSON.stringify(text ?? '')};
  const el = document.activeElement || document.body;
  const editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  if (editable && kind === 'down' && text && text.length === 1) {
    if (el.isContentEditable) { el.textContent += text; }
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(el, el.value + text) : (el.value += text);
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return 'typed:' + el.tagName;
  }
  const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, view: window };
  const type = kind === 'down' ? 'keydown' : 'keyup';
  el.dispatchEvent(new KeyboardEvent(type, init));
  if (kind === 'down' && (key === 'Enter' || key === ' ')) {
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    const form = el.form ?? el.closest?.('form');
    if (key === 'Enter' && form) { form.requestSubmit?.(); return 'submitted'; }
    el.click?.();
  }
  return type + ':' + key + '@' + (el.tagName || '?');
})()`
}

/** One CDP bridge session: screencast down to the viewer, synthesized input up. */
class Bridge {
  constructor(cdpWs, viewer, cfg) {
    this.cdp = cdpWs
    this.viewer = viewer
    this.cfg = cfg
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    this.viewport = { width: 0, height: 0 }
    this.lastFrame = null
    this.frameCount = 0
    this.captureTimer = null
    this.watchdog = null
  }

  send(method, params, sessionId) {
    if (this.closed || this.cdp.readyState !== WebSocket.OPEN) return Promise.resolve(undefined)
    const id = this.nextId++
    const msg = { id, method, params: params ?? {} }
    if (sessionId) msg.sessionId = sessionId
    this.cdp.send(JSON.stringify(msg))
    return new Promise(resolve => {
      this.pending.set(id, resolve)
      setTimeout(() => { if (this.pending.delete(id)) resolve(undefined) }, 8000).unref?.()
    })
  }

  pushToViewer(payload) {
    if (this.viewer.readyState === WebSocket.OPEN) this.viewer.send(JSON.stringify(payload))
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
      userGesture: true,
    })
    return r?.result?.result?.value
  }

  async start(initialUrl) {
    this.cdp.on('message', raw => { void this.onCdpMessage(raw) })
    this.cdp.on('close', () => this.close('cdp-closed'))
    this.cdp.on('error', () => this.close('cdp-error'))

    await this.send('Page.enable')
    await this.send('Runtime.enable')

    // Verified on MultiZen's CloakBrowser: a page target that was never brought
    // to front paints nothing, so startScreencast returns {} and stays silent
    // while captureScreenshot keeps returning one frozen frame. These two wake
    // the renderer before we ask for pixels.
    await this.send('Page.bringToFront')
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    const metrics = await this.send('Page.getLayoutMetrics')
    const vp = metrics?.result?.cssVisualViewport ?? metrics?.result?.visualViewport
    if (vp) this.viewport = { width: Math.round(vp.clientWidth), height: Math.round(vp.clientHeight) }

    if (initialUrl) await this.send('Page.navigate', { url: initialUrl })

    // A backgrounded/occluded page emits NO screencast frames at all (verified
    // against MultiZen's CloakBrowser: startScreencast returns {} and stays
    // silent). An explicit metrics override makes Chromium treat the target as
    // a visible viewport, after which frames flow normally.
    if (this.viewport.width > 0 && this.viewport.height > 0) {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    }

    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.cfg.quality,
      maxWidth: this.cfg.maxWidth,
      maxHeight: this.cfg.maxHeight,
      everyNthFrame: 1,
    })
    this.pushToViewer({ t: 'ready', vw: this.viewport.width, vh: this.viewport.height })

    // A backgrounded/occluded page never paints, so startScreencast can return
    // {} and then stay silent forever (verified on MultiZen's CloakBrowser).
    // captureScreenshot always works, so fall back to polling it.
    this.watchdog = setTimeout(() => {
      if (this.closed || this.frameCount > 0) return
      this.startCaptureFallback()
    }, this.cfg.watchdogMs)
  }

  /** Poll Page.captureScreenshot, pushing only frames that actually changed. */
  startCaptureFallback() {
    if (this.captureTimer || this.closed) return
    void this.send('Page.stopScreencast')
    let lastKey = ''
    const tick = async () => {
      if (this.closed) return
      try {
        const shot = await this.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: this.cfg.quality,
          captureBeyondViewport: false,
        })
        const data = shot?.result?.data
        if (data) {
          const key = data.length + ':' + data.slice(0, 64)
          if (key !== lastKey) {
            lastKey = key
            this.frameCount += 1
            this.pushToViewer({ t: 'frame', d: data, w: this.viewport.width, h: this.viewport.height })
          }
        }
      } catch {
        /* target busy navigating — retry on the next tick */
      }
      if (!this.closed) this.captureTimer = setTimeout(tick, this.cfg.captureIntervalMs)
    }
    void tick()
  }

  async onCdpMessage(raw) {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      this.pending.get(msg.id)(msg)
      this.pending.delete(msg.id)
      return
    }

    switch (msg.method) {
      case 'Page.screencastFrame': {
        const { data, metadata, sessionId } = msg.params
        this.lastFrame = { data, metadata }
        this.frameCount += 1
        this.pushToViewer({
          t: 'frame',
          d: data,
          w: metadata?.deviceWidth ?? 0,
          h: metadata?.deviceHeight ?? 0,
          sx: metadata?.scrollOffsetX ?? 0,
          sy: metadata?.scrollOffsetY ?? 0,
        })
        // Ack every frame or the browser stops producing them.
        if (sessionId !== undefined) await this.send('Page.screencastFrameAck', { sessionId })
        break
      }
      case 'Page.frameNavigated': {
        if (msg.params?.frame?.parentId) break
        this.pushToViewer({ t: 'url', url: msg.params?.frame?.url ?? '' })
        const metrics = await this.send('Page.getLayoutMetrics')
        const vp = metrics?.result?.cssVisualViewport ?? metrics?.result?.visualViewport
        if (vp) {
          this.viewport = { width: Math.round(vp.clientWidth), height: Math.round(vp.clientHeight) }
          this.pushToViewer({ t: 'meta', vw: this.viewport.width, vh: this.viewport.height })
        }
        break
      }
      case 'Page.javascriptDialogOpening':
        await this.send('Page.handleJavaScriptDialog', { accept: true })
        break
    }
  }

  /** Handle one viewer command. */
  async onViewerMessage(raw) {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    switch (msg.t) {
      case 'nav':
        await this.send('Page.navigate', { url: msg.url })
        break
      case 'back':
      case 'forward': {
        const hist = await this.send('Page.getNavigationHistory')
        const entries = hist?.result?.entries ?? []
        const idx = hist?.result?.currentIndex ?? 0
        const target = msg.t === 'back' ? idx - 1 : idx + 1
        const entry = entries[target]
        if (entry) await this.send('Page.navigateToHistoryEntry', { entryId: entry.id })
        break
      }
      case 'reload':
        await this.send('Page.reload', { ignoreCache: false })
        break
      case 'resize':
        await this.send('Emulation.setDeviceMetricsOverride', {
          width: Math.max(320, Math.round(msg.w)),
          height: Math.max(240, Math.round(msg.h)),
          deviceScaleFactor: 1,
          mobile: false,
        }).catch(() => {})
        await this.send('Page.getLayoutMetrics').then(metrics => {
          const vp = metrics?.result?.cssVisualViewport ?? metrics?.result?.visualViewport
          if (vp) {
            this.viewport = { width: Math.round(vp.clientWidth), height: Math.round(vp.clientHeight) }
            this.pushToViewer({ t: 'meta', vw: this.viewport.width, vh: this.viewport.height })
          }
        })
        break
      case 'click':
        await this.evaluate(clickScript(msg.x, msg.y, msg.button))
        break
      case 'wheel':
        await this.evaluate(scrollScript(msg.x, msg.y, msg.dx, msg.dy))
        break
      case 'key':
        await this.evaluate(keyScript(msg.kind, msg.key, msg.code, msg.keyCode, msg.text))
        break
      case 'text': {
        const q = JSON.stringify(String(msg.text ?? ''))
        await this.evaluate(`(() => {
  const el = document.activeElement || document.body;
  if (!el) return;
  if (el.isContentEditable) { el.textContent += ${q}; }
  else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, el.value + ${q}) : (el.value += ${q});
  }
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
})()`)
        break
      }
    }
  }

  close(reason) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.captureTimer)
    clearTimeout(this.watchdog)
    try { this.cdp.close() } catch { /* already gone */ }
    this.pushToViewer({ t: 'closed', reason })
    try { this.viewer.close() } catch { /* already gone */ }
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const wss = new WebSocketServer({ noServer: true })

  const serveView = async (req, res) => {
    try {
      const html = await readFile(join(HERE, 'view.html'), 'utf8')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The viewer runs its own inline bundle and talks to /multizen-cdp on
        // this same origin; nothing else is needed.
        'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      })
      res.end(html)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`view.html 读取失败: ${error?.message ?? error}`)
    }
  }

  /** Health probe so the caller can explain WHY a page will not render. */
  const serveStatus = async (req, res) => {
    try {
      const target = await pickTarget(cfg.cdpEndpoint)
      json(res, 200, { ok: true, endpoint: cfg.cdpEndpoint, target: { id: target.id, url: target.url, title: target.title } })
    } catch (error) {
      json(res, 503, { ok: false, endpoint: cfg.cdpEndpoint, error: String(error?.message ?? error) })
    }
  }

  const onUpgrade = async (req, socket, head) => {
    let viewer
    try {
      wss.handleUpgrade(req, socket, head, ws => { viewer = ws })
    } catch {
      try { socket.destroy() } catch { /* already gone */ }
      return
    }
    if (!viewer) return

    const url = new URL(req.url ?? CDP_PATH, 'http://127.0.0.1')
    const wanted = url.searchParams.get('url') ?? undefined
    const targetId = url.searchParams.get('target') ?? undefined

    viewer.on('message', raw => { void bridge?.onViewerMessage(raw) })
    viewer.on('close', () => { bridge?.close('viewer-closed') })
    viewer.on('error', () => { bridge?.close('viewer-error') })

    let bridge
    try {
      const wsBase = cfg.cdpEndpoint.replace(/^http/, 'ws').replace(/\/+$/, '')
      const target = targetId
        ? { webSocketDebuggerUrl: `${wsBase}/devtools/page/${targetId}`, url: wanted ?? '' }
        : await pickTarget(cfg.cdpEndpoint, wanted)
      const cdp = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 8000)
        cdp.once('open', () => { clearTimeout(timer); resolve() })
        cdp.once('error', error => { clearTimeout(timer); reject(error) })
      })
      bridge = new Bridge(cdp, viewer, cfg)
      await bridge.start(wanted === target.url ? undefined : wanted)
    } catch (error) {
      try {
        viewer.send(JSON.stringify({ t: 'error', message: String(error?.message ?? error) }))
        viewer.close()
      } catch { /* viewer already gone */ }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: VIEW_PATH, handler: serveView }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/multizen-status', handler: serveStatus }))
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: CDP_PATH, handler: onUpgrade }))
  ctx.effect(() => () => { try { wss.close() } catch { /* already closed */ } })

  ctx.logger?.info?.(`[multizen-browser] viewer ${VIEW_PATH}, cdp bridge ${CDP_PATH} → ${cfg.cdpEndpoint}`)
}
