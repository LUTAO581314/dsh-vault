// 独立验证 dsh-multizen-browser：不重启 DSH，自己起 server 挂插件路由，
// 真实连 MultiZen 的 CDP，收帧 + 测点击是否生效。
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { apply } from 'dsh-multizen-browser'

const CDP = process.env.CDP || 'http://127.0.0.1:9222'
const START_URL = process.env.START_URL || 'https://www.douyin.com'
const routes = []
const upgrades = []

const ctx = {
  webServer: {
    register: r => (routes.push(r), () => {}),
    registerUpgrade: r => (upgrades.push(r), () => {}),
  },
  logger: {
    info: (...a) => console.log('[plugin]', ...a),
    warn: (...a) => console.warn('[plugin]', ...a),
    error: (...a) => console.error('[plugin]', ...a),
  },
  effect: fn => fn(),
}

apply(ctx, { cdpEndpoint: CDP, inputMode: 'dom', quality: 72, maxWidth: 1600, maxHeight: 1200 })
console.log('已注册 routes:', routes.map(r => r.kind + ' ' + r.path).join(', '))
console.log('已注册 upgrades:', upgrades.map(r => r.path).join(', '))

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const r = routes.find(r => (r.kind === 'exact' ? u.pathname === r.path : u.pathname.startsWith(r.path)))
  if (!r) { res.statusCode = 404; return res.end('no route') }
  r.handler(req, res)
})

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x')
  const r = upgrades.find(r => u.pathname === r.path)
  if (!r) return socket.destroy()
  // DSH's webServer hands the raw socket over; the plugin does its own
  // handleUpgrade. Passing an already-upgraded WebSocket here breaks it.
  r.handler(req, socket, head)
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
console.log('harness 监听:', base)

// ---- 1. 静态查看器 ----
const viewRes = await fetch(`${base}/multizen-view`)
const html = await viewRes.text()
console.log(`[1] GET /multizen-view → ${viewRes.status}, ${html.length} 字节, 含 canvas:`, html.includes('<canvas'), ', CSP:', (viewRes.headers.get('content-security-policy') || '(无)').slice(0, 40))

const statRes = await fetch(`${base}/multizen-status`)
console.log(`[2] GET /multizen-status → ${statRes.status}:`, (await statRes.text()).slice(0, 200))

// ---- 2. WS 桥 + 收帧 ----
const ws = new WebSocket(`ws://127.0.0.1:${port}/multizen-cdp?url=${encodeURIComponent(START_URL)}`)
let frames = 0, firstFrameBytes = 0, ready = null, lastUrl = null, errors = []

ws.on('message', raw => {
  let m
  try { m = JSON.parse(raw.toString()) } catch { return }
  if (m.t === 'ready') { ready = m; console.log('[3] ready →', JSON.stringify(m)) }
  else if (m.t === 'frame') { frames++; if (frames === 1) firstFrameBytes = m.d.length }
  else if (m.t === 'url') { lastUrl = m.url }
  else if (m.t === 'error') { errors.push(m.message); console.log('[!] error →', m.message) }
  else if (m.t === 'closed') console.log('[4] closed →', m.reason || '(已关闭)')
})
ws.on('error', e => console.log('[!] ws error:', e.message))
await new Promise(r => ws.on('open', r))
console.log('[3] WS 已连接，等待画面…')

await new Promise(r => setTimeout(r, 15000))

console.log(`[5] 15s 内帧数: ${frames}, 首帧 base64 ${firstFrameBytes} 字节 ≈ ${Math.round(firstFrameBytes * 0.75 / 1024)} KB, viewport: ${ready ? ready.vw + 'x' + ready.vh : '?'}, 当前 URL: ${lastUrl}`)

// ---- 3. 点击是否生效 ----
if (frames > 0 && ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({ t: 'click', x: 640, y: 300, button: 0 }))
  await new Promise(r => setTimeout(r, 1200))
  ws.send(JSON.stringify({ t: 'wheel', x: 640, y: 500, dx: 0, dy: 400 }))
  await new Promise(r => setTimeout(r, 1500))
  console.log('[6] 已发送 click(640,300) + wheel(dy=400)，之后帧数:', frames, ', URL:', lastUrl)
}

ws.close()
server.close()
await new Promise(r => setTimeout(r, 300))
console.log('\n=== 结论 ===')
console.log('静态页:', viewRes.status === 200 ? 'OK' : 'FAIL')
console.log('CDP 桥:', frames > 0 ? `OK（${frames} 帧）` : 'FAIL（无帧）')
console.log('错误数:', errors.length)
process.exit(frames > 0 ? 0 : 1)
