#!/usr/bin/env node
// End-to-end test of server.mjs over stdio: initialize -> tools/list -> a few tool calls.
//   node test-stdio.mjs            (metadata + list_profiles + get_text)
//   node test-stdio.mjs shot       (also screenshot, verifying a real image block)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.MZ_PROFILE || '7d5e74ea-6c76-4196-9d4d-b848146050d8';

const child = spawn(process.execPath, [path.join(here, '..', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('NON-JSON STDOUT:', line.slice(0, 200));
      continue;
    }
    if (msg.id != null && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        reject(new Error(method + ' timed out'));
      }
    }, 180000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const summarize = (r) => {
  if (!r.result) return 'ERROR: ' + JSON.stringify(r.error);
  return r.result;
};

try {
  const init = summarize(await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  console.log('initialize ->', JSON.stringify(init.serverInfo), '| protocol', init.protocolVersion);
  console.log('instructions chars:', (init.instructions || '').length);

  notify('notifications/initialized');

  const list = summarize(await send('tools/list', {}));
  const names = list.tools.map((t) => t.name);
  console.log(`tools/list -> ${names.length} tools`);
  console.log('  ', names.join(', '));
  const bad = list.tools.filter((t) => !t.description || !t.inputSchema);
  console.log('tools missing description/schema:', bad.length);

  const lp = summarize(await send('tools/call', { name: 'list_profiles', arguments: {} }));
  const txt = (lp.content || []).map((b) => b.text).join('\n');
  console.log('list_profiles ->', txt.length > 300 ? txt.slice(0, 300) + '…' : txt);

  const gt = summarize(await send('tools/call', { name: 'get_text', arguments: { profile_id: PROFILE } }));
  const gtTxt = (gt.content || []).map((b) => b.text).join('\n');
  console.log('get_text ->', gtTxt.length > 300 ? gtTxt.slice(0, 300) + '…' : gtTxt);

  if (process.argv[2] === 'shot') {
    const shot = summarize(await send('tools/call', { name: 'screenshot', arguments: { profile_id: PROFILE } }));
    const blocks = shot.content || [];
    for (const b of blocks) {
      console.log(`screenshot block: type=${b.type} mime=${b.mimeType} dataLen=${b.data ? b.data.length : 0}`);
      if (b.type === 'image') {
        const out = path.join(here, 'stdout-shot.png');
        const fs = await import('node:fs');
        fs.writeFileSync(out, Buffer.from(b.data, 'base64'));
        console.log('  decoded ->', out, fs.statSync(out).size, 'bytes');
      }
    }
    if (shot.isError) console.log('  isError:', blocks.map((b) => b.text).join(''));
  }
} catch (e) {
  console.error('TEST FAILED:', e.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 500);
}
