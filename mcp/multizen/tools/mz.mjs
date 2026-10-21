#!/usr/bin/env node
// MultiZen MCP CLI — call any MultiZen tool without DSH.
//   node mz.mjs tools
//   node mz.mjs call list_profiles
//   node mz.mjs call navigate '{"profile_id":"...","url":"https://example.com"}'
//   node mz.mjs call screenshot '{"profile_id":"..."}' --save shot.png
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.MZ_BASE || 'http://127.0.0.1:7777';
const ENDPOINT = BASE + '/mcp';
const TOKEN =
  process.env.MZ_TOKEN ||
  (() => {
    const p = path.join(process.env.APPDATA || '', 'MultiZen', 'mcp-token');
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      throw new Error('no MZ_TOKEN and cannot read ' + p);
    }
  })();

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal: AbortSignal.timeout(180000),
  });
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (!raw) throw new Error(`${method}: empty body, HTTP ${res.status}`);
  if (ct.includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        return msg.result;
      } catch (e) {
        if (e.message.startsWith('{')) throw e;
      }
    }
    throw new Error('no data frame');
  }
  const msg = JSON.parse(raw);
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  return msg.result;
}

async function connect() {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'multizen-cli', version: '1.0.0' },
  });
}

const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'tools') {
  await connect();
  const r = await rpc('tools/list', {});
  for (const t of r.tools || []) {
    const props = t.inputSchema?.properties || {};
    const req = t.inputSchema?.required || [];
    const args = Object.keys(props).map((k) => (req.includes(k) ? k + '*' : k)).join(', ');
    console.log(`${t.name}(${args})`);
  }
} else if (cmd === 'call') {
  if (!a) throw new Error('usage: call <tool> [json]');
  const args = b ? JSON.parse(b) : {};
  await connect();
  const r = await rpc('tools/call', { name: a, arguments: args });
  const saveIdx = process.argv.indexOf('--save');
  const saveAs = saveIdx > 0 ? process.argv[saveIdx + 1] : null;
  let imgN = 0;
  for (const block of r.content || []) {
    if (block.type === 'text') {
      let handled = false;
      const t = String(block.text || '');
      // MultiZen ships screenshots as {"pngBase64":"..."} inside a TEXT block, so a naive
      // console.log dumps ~69k characters of base64. Long payloads get decoded to a file.
      if (t.length > 2000) {
        try {
          const j = JSON.parse(t);
          const b64 = j.pngBase64 || j.base64 || j.image || j.data;
          if (b64 && typeof b64 === 'string') {
            const out = saveAs || `shot-${Date.now()}-${imgN}.png`;
            fs.writeFileSync(out, Buffer.from(b64, 'base64'));
            console.log(`[image (from text block) -> ${out} ${fs.statSync(out).size} bytes]`);
            imgN++;
            handled = true;
          }
        } catch {
          /* not JSON — fall through to plain printing */
        }
      }
      if (!handled) console.log(t);
    } else if (block.type === 'image') {
      const ext = (block.mimeType || 'image/png').split('/')[1] || 'png';
      const out = saveAs || `shot-${Date.now()}-${imgN}.${ext}`;
      fs.writeFileSync(out, Buffer.from(block.data, 'base64'));
      console.log(`[image ${block.mimeType} -> ${out} ${fs.statSync(out).size} bytes]`);
      imgN++;
    } else {
      console.log(`[${block.type}] ${JSON.stringify(block).slice(0, 300)}`);
    }
  }
  if (r.isError) {
    console.error('[isError: true]');
    process.exitCode = 1;
  }
  if (r.structuredContent) {
    const s = JSON.stringify(r.structuredContent);
    console.log(s.length > 4000 ? s.slice(0, 4000) + '…' : s);
  }
} else {
  console.log('usage: node mz.mjs tools | call <tool> [json] [--save out.png]');
}
