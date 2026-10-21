#!/usr/bin/env node
// Verifies the adaptor's added tools against a real page.
// Requires: test/serve.mjs running on 127.0.0.1:8848, MultiZen running, a profile that exists.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.MZ_PROFILE || '7d5e74ea-6c76-4196-9d4d-b848146050d8';
const PAGE = process.env.MZ_PAGE || 'http://127.0.0.1:8848/';

const child = spawn(process.execPath, [path.join(here, '..', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id != null && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  }
});
child.stderr.on('data', () => {});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        reject(new Error(method + ' timeout'));
      }
    }, 180000);
  });
}

async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (!r.result) throw new Error(name + ': ' + JSON.stringify(r.error));
  if (r.result.isError) throw new Error(name + ' isError: ' + (r.result.content || []).map((b) => b.text).join(''));
  return r.result;
}
const textOf = (r) => (r.content || []).map((b) => b.text).filter(Boolean).join('\n');
async function jtool(name, args) {
  const t = textOf(await tool(name, args));
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
async function js(expr) {
  await tool('evaluate_js', { profile_id: PROFILE, expression: expr });
  return null;
}
async function jsVal(expr) {
  const r = await tool('evaluate_js', { profile_id: PROFILE, expression: expr });
  const t = textOf(r);
  try {
    const j = JSON.parse(t);
    return j?.result?.value ?? j?.result ?? j;
  } catch {
    return t;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 1) launch + navigate
  await tool('launch_profile', { profile_id: PROFILE });
  await tool('navigate', { profile_id: PROFILE, url: PAGE });
  await sleep(1200);
  const title = await jsVal('document.title');
  check('navigate', /MZ Test Page/.test(String(title)), 'title=' + title);

  // 2) click_text -> JS handler fires
  const c1 = await jtool('click_text', { profile_id: PROFILE, text: 'Press Me' });
  await sleep(400);
  const out = await jsVal("document.getElementById('out').textContent");
  check('click_text', out === 'clicked-once', JSON.stringify(c1) + ' -> #out=' + out);

  // 3) fill + press_key('Enter') -> form submit
  const f1 = await jtool('fill', { profile_id: PROFILE, selector: '#q', value: 'hello world' });
  const pk = await jtool('press_key', { profile_id: PROFILE, key: 'Enter' });
  await sleep(500);
  const formout = await jsVal("document.getElementById('formout').textContent");
  check('fill + press_key Enter submits form', formout === 'submitted:hello world', `fill=${JSON.stringify(f1)} key=${JSON.stringify(pk)} #formout=${formout}`);

  // 4) select_option by value
  const s1 = await jtool('select_option', { profile_id: PROFILE, selector: '#sel', value: 'b' });
  const selVal = await jsVal("document.getElementById('sel').value");
  check('select_option by value', selVal === 'b', JSON.stringify(s1));

  // 5) select_option by label
  const s2 = await jtool('select_option', { profile_id: PROFILE, selector: '#sel', label: 'Gamma' });
  const selVal2 = await jsVal("document.getElementById('sel').value");
  check('select_option by label', selVal2 === 'c', JSON.stringify(s2));

  // 6) hover -> CSS :hover actually engages (this is what JS dispatchEvent cannot do)
  const before = await jsVal("getComputedStyle(document.querySelector('.menu')).display");
  await tool('hover', { profile_id: PROFILE, selector: '.hoverbox' });
  await sleep(400);
  const after = await jsVal("getComputedStyle(document.querySelector('.menu')).display");
  check('hover triggers CSS :hover', before === 'none' && after === 'block', `${before} -> ${after}`);

  // 7) scroll
  const y0 = Number(await jsVal('window.scrollY'));
  const sc = await jtool('scroll', { profile_id: PROFILE, dy: 900 });
  await sleep(300);
  const y1 = Number(await jsVal('window.scrollY'));
  check('scroll', y1 > y0 + 400, `scrollY ${y0} -> ${y1} ${JSON.stringify(sc)}`);

  // 8) get_text scoped
  const gt = await jtool('get_text', { profile_id: PROFILE, selector: '#out' });
  check('get_text selector', gt && gt.found && gt.text === 'clicked-once', JSON.stringify(gt));

  // 9) find_text
  const ft = await jtool('find_text', { profile_id: PROFILE, text: 'Hover Me' });
  check('find_text', ft && ft.count > 0, 'count=' + ft?.count);

  // 10) screenshot -> real image block
  const shot = await tool('screenshot', { profile_id: PROFILE });
  const img = (shot.content || []).find((b) => b.type === 'image');
  if (img) fs.writeFileSync(path.join(here, 'verify-shot.png'), Buffer.from(img.data, 'base64'));
  check('screenshot image block', !!img && img.mimeType === 'image/png', img ? 'png ' + fs.statSync(path.join(here, 'verify-shot.png')).size + ' bytes' : 'no image block');

  // 11) click_text on the submit button (second text target)
  await jtool('click_text', { profile_id: PROFILE, text: 'Submit Form' });
  await sleep(300);
  const formout2 = await jsVal("document.getElementById('formout').textContent");
  check('click_text second target', formout2 === 'submitted:hello world', '#formout=' + formout2);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('VERIFY FAILED:', e.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 300);
}
