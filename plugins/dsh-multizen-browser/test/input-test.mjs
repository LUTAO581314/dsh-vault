// 验证输入链路：点击能否关掉抖音登录弹窗、导航能否真的跳转。
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { writeFileSync } from 'node:fs'
import { apply } from 'dsh-multizen-browser'

const CDP = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/lt/Documents/deepseek-harness/自媒体/_test'
const routes = [], upgrades = []
apply({
  webServer: { register: r => (routes.push(r), () => {}), registerUpgrade: r => (upgrades.push(r), () => {}) },
  logger: { info: () => {}, warn: console.warn, error: console.error },
  effect: fn => fn(),
}, { cdpEndpoint: CDP, inputMode: 'dom', quality: 80, maxWidth: 1600, maxHeight: 1200 })

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const r = routes.find(r => u.pathname === r.path)
  if (!r) { res.statusCode = 404; return res.end('x') }
  r.handler(req, res)
})
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x')
  const r = upgrades.find(r => u.pathname === r.path)
  if (!r) return socket.destroy()
  r.handler(req, socket, head)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const ws = new WebSocket(`ws://127.0.0.1:${port}/multizen-cdp?url=${encodeURIComponent('https://www.douyin.com/jingxuan')}`)
let frames = 0, lastFrame = null, lastUrl = null
ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'frame') { frames++; lastFrame = m.d }
  else if (m.t === 'url') lastUrl = m.url
  else if (m.t === 'error') console.log('ERROR:', m.message)
})
await new Promise(r => ws.on('open', r))
const send = p => ws.send(JSON.stringify(p))
const wait = ms => new Promise(r => setTimeout(r, ms))
const save = (name, b64) => {
  if (!b64) return console.log(`  ${name}: 无帧`)
  writeFileSync(`${OUT}/${name}`, Buffer.from(b64, 'base64'))
  console.log(`  ${name}: ${Math.round(b64.length * 0.75 / 1024)} KB`)
}

await wait(6000)
console.log(`基线: ${frames} 帧, url=${lastUrl}`)
save('in_1_before.jpg', lastFrame)

// 1) 点击登录弹窗右上角的 ×（1424x771 视口里的约 1040,180）
console.log('\n[点击] 关闭登录弹窗 (1040,180)')
send({ t: 'click', x: 1040, y: 180, button: 0 })
await wait(2500)
console.log(`  之后 ${frames} 帧`)
save('in_2_after_click.jpg', lastFrame)

// 2) 鼠标悬停/滚动，看是否触发侧栏滚动
console.log('\n[滚轮] 页面中部向下滚 600')
send({ t: 'wheel', x: 700, y: 400, dx: 0, dy: 600 })
await wait(2500)
console.log(`  之后 ${frames} 帧`)
save('in_3_after_wheel.jpg', lastFrame)

// 3) 导航
console.log('\n[导航] 跳到 example.com')
send({ t: 'nav', url: 'https://example.com' })
await wait(5000)
console.log(`  之后 ${frames} 帧, url=${lastUrl}`)
save('in_4_after_nav.jpg', lastFrame)

ws.close(); server.close(); await wait(300)
console.log('\n=== 判定 ===')
console.log('出帧:', frames > 5 ? 'OK' : 'FAIL')
console.log('导航生效:', String(lastUrl).includes('example.com') ? 'OK' : 'FAIL (' + lastUrl + ')')
process.exit(0)
