// 冻结的渲染管线到底怎么唤醒：bringToFront / focusEmulation / 强制重排
import { WebSocket } from 'ws'
import { writeFileSync } from 'node:fs'

const OUT = 'C:/Users/lt/Documents/deepseek-harness/自媒体/_test'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find(t => t.id.startsWith('159B55BC8612'))
console.log('target:', page.id.slice(0, 12), page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
let id = 0
const pending = new Map()
const evts = []
ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Page.screencastFrame') {
    evts.push('frame')
    ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }))
  } else if (m.method) evts.push(m.method)
})
const send = (method, params) => new Promise(resolve => {
  const myId = ++id
  pending.set(myId, resolve)
  ws.send(JSON.stringify({ id: myId, method, params: params ?? {} }))
  setTimeout(() => { if (pending.delete(myId)) resolve({ timeout: true }) }, 8000)
})
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
  const d = r?.result?.data
  if (d) { writeFileSync(`${OUT}/${name}`, Buffer.from(d, 'base64')); console.log(`  ${name}: ${Math.round(d.length * 0.75 / 1024)}KB`) ; return d.slice(0, 40) }
  console.log(`  ${name}: 失败 ${JSON.stringify(r).slice(0, 100)}`)
  return ''
}
const wait = ms => new Promise(r => setTimeout(r, ms))

await new Promise(r => ws.on('open', r))
await send('Page.enable')
await send('Runtime.enable')

console.log('\n[0] 唤醒前截图')
const a = await shot('p2_0_wake0.jpg')

console.log('\n[1] Page.bringToFront')
console.log('  →', JSON.stringify(await send('Page.bringToFront')))
await wait(800)

console.log('\n[2] Emulation.setFocusEmulationEnabled(true)')
console.log('  →', JSON.stringify((await send('Emulation.setFocusEmulationEnabled', { enabled: true })).result ?? 'err'))
await wait(800)
const b = await shot('p2_1_wake1.jpg')
console.log('  与唤醒前相同:', a === b)

console.log('\n[3] 强制重排 (Runtime.evaluate 读 body 尺寸)')
console.log('  →', JSON.stringify((await send('Runtime.evaluate', { expression: 'document.body.offsetHeight + "x" + document.body.offsetWidth', returnByValue: true })).result?.result?.value))
await wait(800)
const c = await shot('p2_2_wake2.jpg')
console.log('  与上次相同:', b === c)

console.log('\n[4] 全量 resize 一下 (setDeviceMetricsOverride 1423 再回 1424)')
await send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 771, deviceScaleFactor: 1, mobile: false })
await wait(400)
await send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 771, deviceScaleFactor: 1, mobile: false })
await wait(800)
const d = await shot('p2_3_wake3.jpg')
console.log('  与上次相同:', c === d)

console.log('\n[5] screencast 现在出帧吗')
evts.length = 0
await send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1424, maxHeight: 771, everyNthFrame: 1 })
await wait(3000)
console.log('  3s 事件:', evts.filter(e => e === 'frame').length, '帧 /', evts.length, '事件:', evts.slice(0, 8).join(','))

ws.close()
process.exit(0)
