// 裸 CDP 探针：MultiZen 的 CloakBrowser 到底支不支持 screencast / captureScreenshot
import { WebSocket } from 'ws'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find(t => t.type === 'page')
console.log('target:', page.id, page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
let id = 0
const pending = new Map()
const events = []

ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  } else if (m.method) {
    if (m.method === 'Page.screencastFrame') {
      events.push('frame:' + Math.round(m.params.data.length / 1024) + 'KB')
      ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }))
    } else {
      events.push(m.method)
    }
  }
})

const send = (method, params) => new Promise(resolve => {
  const myId = ++id
  pending.set(myId, resolve)
  ws.send(JSON.stringify({ id: myId, method, params: params ?? {} }))
  setTimeout(() => { if (pending.delete(myId)) resolve({ timeout: true }) }, 6000)
})

await new Promise(r => ws.on('open', r))
console.log('CDP 已连接')

console.log('Page.enable       →', JSON.stringify(await send('Page.enable')))
console.log('Runtime.enable    →', JSON.stringify(await send('Runtime.enable')))
const sc = await send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1424, maxHeight: 771, everyNthFrame: 1 })
console.log('startScreencast   →', JSON.stringify(sc))

await new Promise(r => setTimeout(r, 4000))
console.log('4s 内事件:', events.length ? events.slice(0, 6).join(', ') : '(无)')

const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })
console.log('captureScreenshot →', shot.result?.data ? 'OK ' + Math.round(shot.result.data.length / 1024) + 'KB' : JSON.stringify(shot).slice(0, 160))

const shot2 = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false, fromSurface: true })
console.log('capture(fromSurface) →', shot2.result?.data ? 'OK ' + Math.round(shot2.result.data.length / 1024) + 'KB' : JSON.stringify(shot2).slice(0, 160))

// Emulation 强制尺寸后再试 screencast
await send('Page.stopScreencast')
console.log('Emulation.setDeviceMetricsOverride →', JSON.stringify((await send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 771, deviceScaleFactor: 1, mobile: false })).result ?? 'ok'))
events.length = 0
await send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1424, maxHeight: 771, everyNthFrame: 1 })
await new Promise(r => setTimeout(r, 4000))
console.log('emulation 后 4s 事件:', events.length ? events.slice(0, 8).join(', ') : '(无)')

if (shot.result?.data) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('C:/Users/lt/Documents/deepseek-harness/自媒体/_test/cdp_shot.jpg', Buffer.from(shot.result.data, 'base64'))
  console.log('已存 cdp_shot.jpg')
}

ws.close()
process.exit(0)
