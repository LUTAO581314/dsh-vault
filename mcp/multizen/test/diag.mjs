#!/usr/bin/env node
// Diagnose why native CDP mouse clicks don't hit the button, and whether MultiZen's own
// click/type work on this page. Talks to MultiZen directly (not through server.mjs).
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:7777';
const TOKEN = fs.readFileSync(path.join(process.env.APPDATA, 'MultiZen', 'mcp-token'), 'utf8').trim();
const PROFILE = process.env.MZ_PROFILE || '7d5e74ea-6c76-4196-9d4d-b848146050d8';
const PAGE = 'http://127.0.0.1:8848/';

let id = 1;
async function rpc(method, params) {
  const r = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  for (const line of raw.split('\n')) if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim()).result;
  return JSON.parse(raw).result;
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'diag', version: '1' } });
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return (r.content || []).map((b) => b.text).filter(Boolean).join('\n');
}
async function js(expr) {
  const t = await call('evaluate_js', { profile_id: PROFILE, expression: expr });
  try {
    const j = JSON.parse(t);
    return j?.result?.value ?? j?.result ?? j;
  } catch {
    return t;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call('launch_profile', { profile_id: PROFILE });
await call('navigate', { profile_id: PROFILE, url: PAGE });
await sleep(1500);

console.log('url        :', await js('location.href'));
console.log('title      :', await js('document.title'));
console.log('scrollY    :', await js('window.scrollY'));
console.log('dpr        :', await js('window.devicePixelRatio'));
console.log('innerWidth :', await js('window.innerWidth'), 'innerHeight:', await js('window.innerHeight'));

const rect = await js(
  "JSON.stringify((()=>{const b=document.getElementById('btn').getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height,cx:b.left+b.width/2,cy:b.top+b.height/2}})())",
);
console.log('btn rect   :', rect);
const cx = JSON.parse(rect).cx;
const cy = JSON.parse(rect).cy;
console.log('elementAt  :', await js(`JSON.stringify((()=>{const e=document.elementFromPoint(${cx},${cy});return e?{tag:e.tagName,id:e.id,cls:e.className}:null})())`));

// --- MultiZen's own click ---
console.log('\n[MultiZen click #btn]');
console.log(await call('click', { profile_id: PROFILE, selector: '#btn' }).catch((e) => 'threw ' + e.message));
await sleep(300);
console.log('#out after MZ click:', await js("document.getElementById('out').textContent"));

// --- MultiZen's own type ---
console.log('\n[MultiZen type #q]');
console.log(await call('type', { profile_id: PROFILE, selector: '#q', text: 'abc123' }).catch((e) => 'threw ' + e.message));
await sleep(300);
console.log('#q.value after MZ type:', await js("document.getElementById('q').value"));

// --- native CDP click at the same coordinates, instrumented ---
console.log('\n[raw CDP mouse click]');
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const pages = list.filter((t) => t.type === 'page');
console.log(
  'cdp page targets:',
  pages.map((t) => `${t.id.slice(0, 8)} ${t.url}`),
);
const page = pages.find((t) => t.url && t.url.includes('8848'));
if (!page) {
  console.log('no 8848 target found!');
} else {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
    setTimeout(rej, 8000, new Error('open timeout'));
  });
  let n = 1;
  const send = (method, params) =>
    new Promise((res) => {
      const mid = n++;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === mid) {
          ws.removeEventListener('message', onMsg);
          res(m);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  // Reset the marker so a successful click is unambiguous.
  await js("document.getElementById('out').textContent='idle'");
  const r1 = await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
  const r2 = await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  const r3 = await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  console.log('moved   :', JSON.stringify(r1.result || r1.error));
  console.log('pressed :', JSON.stringify(r2.result || r2.error));
  console.log('released:', JSON.stringify(r3.result || r3.error));
  await sleep(400);
  console.log('#out after raw CDP click:', await js("document.getElementById('out').textContent"));
  ws.close();
}

// --- what does a plain el.click() do? ---
console.log('\n[JS el.click()]');
await js("document.getElementById('out').textContent='idle'");
await js("document.getElementById('btn').click()");
await sleep(200);
console.log('#out after el.click():', await js("document.getElementById('out').textContent"));
