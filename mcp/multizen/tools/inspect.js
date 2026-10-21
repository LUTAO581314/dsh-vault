#!/usr/bin/env node
// Dump the raw content-block structure of one MultiZen tool call (no printing of payloads).
//   node inspect.js screenshot '{"profile_id":"..."}' [savePath]
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:7777';
const TOKEN = fs.readFileSync(path.join(process.env.APPDATA, 'MultiZen', 'mcp-token'), 'utf8').trim();

let id = 1;
async function rpc(method, params) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await res.text();
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim()).result;
  }
  return JSON.parse(raw).result;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'inspect', version: '1' } });
const [tool, json, save] = process.argv.slice(2);
const r = await rpc('tools/call', { name: tool, arguments: JSON.parse(json || '{}') });

console.log('result keys:', Object.keys(r));
for (const [i, b] of (r.content || []).entries()) {
  const keys = Object.keys(b);
  const len = typeof b.text === 'string' ? b.text.length : typeof b.data === 'string' ? b.data.length : 0;
  console.log(`block[${i}] type=${b.type} mime=${b.mimeType || '-'} keys=${keys} len=${len}`);
  if (b.type === 'text') {
    const t = b.text;
    // is it JSON?
    let parsed = null;
    try {
      parsed = JSON.parse(t);
    } catch {}
    if (parsed) {
      console.log('  text is JSON, keys:', Object.keys(parsed));
      for (const k of Object.keys(parsed)) {
        const v = parsed[k];
        console.log(`   - ${k}: ${typeof v === 'string' ? (v.length > 80 ? v.slice(0, 40) + `…(${v.length} chars)` : JSON.stringify(v)) : JSON.stringify(v).slice(0, 120)}`);
      }
      if (save) {
        for (const k of Object.keys(parsed)) {
          if (typeof parsed[k] === 'string' && parsed[k].length > 5000 && /^[A-Za-z0-9+/=\s]+$/.test(parsed[k])) {
            fs.writeFileSync(save, Buffer.from(parsed[k], 'base64'));
            console.log(`  decoded field "${k}" -> ${save} ${fs.statSync(save).size} bytes`);
          }
        }
      }
    } else {
      console.log('  preview:', t.slice(0, 300).replace(/\s+/g, ' '));
    }
  } else if (b.type === 'image') {
    if (save) {
      fs.writeFileSync(save, Buffer.from(b.data, 'base64'));
      console.log('  image ->', save, fs.statSync(save).size, 'bytes');
    }
  }
}
if (r.structuredContent) console.log('structuredContent keys:', Object.keys(r.structuredContent));
