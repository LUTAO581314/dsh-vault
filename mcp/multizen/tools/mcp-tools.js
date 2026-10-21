// Full MCP client: initialize -> tools/list, print every tool with schema summary.
const BASE = process.env.MZ_BASE || 'http://127.0.0.1:7777';
const TOK = process.env.MZ_TOKEN;
const URL_ = BASE + '/mcp';

async function rpc(method, params, id = 1) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOK}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    // SSE framing: lines "event: message" / "data: {...}"
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try { return JSON.parse(line.slice(5).trim()); } catch {}
      }
    }
    throw new Error('no data frame in SSE');
  }
  if (!text) throw new Error(`empty body, status ${res.status}`);
  return JSON.parse(text);
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'dsh-probe', version: '0.1.0' },
});
console.log('=== initialize ===');
console.log(JSON.stringify(init.result?.serverInfo));
console.log('--- instructions ---');
console.log(init.result?.instructions || '(none)');

const tools = await rpc('tools/list', {}, 2);
const list = tools.result?.tools || [];
console.log(`\n=== tools: ${list.length} ===`);
for (const t of list) {
  const props = t.inputSchema?.properties || {};
  const req = t.inputSchema?.required || [];
  const args = Object.keys(props).map((k) => (req.includes(k) ? k + '*' : k)).join(', ');
  console.log(`\n[${t.name}]  args(${args})`);
  console.log(`  ${(t.description || '').split('\n')[0]}`);
  if (process.env.VERBOSE) console.log('  schema: ' + JSON.stringify(t.inputSchema));
}
require('fs').writeFileSync(
  process.env.OUTFILE || 'mz-tools.json',
  JSON.stringify(tools.result, null, 2),
);
console.log('\nsaved -> ' + (process.env.OUTFILE || 'mz-tools.json'));
