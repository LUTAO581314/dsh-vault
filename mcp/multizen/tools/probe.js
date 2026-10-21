// Probe the MultiZen local MCP endpoint: try candidate paths, log status/headers/body.
const BASE = process.env.MZ_BASE || 'http://127.0.0.1:7777';
const TOK = process.env.MZ_TOKEN;
const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-probe', version: '0.1.0' },
  },
};

const paths = ['/mcp', '/mcp/', '/api/mcp', '/sse', '/rpc', '/', '/messages', '/stream'];

for (const p of paths) {
  for (const method of ['POST', 'GET']) {
    try {
      const headers = { Authorization: `Bearer ${TOK}`, Accept: 'application/json, text/event-stream' };
      const opt = { method, headers };
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(init);
      }
      const ctl = AbortSignal.timeout(4000);
      const res = await fetch(BASE + p, { ...opt, signal: ctl });
      const ct = res.headers.get('content-type') || '';
      let body = '';
      try {
        body = await res.text();
      } catch {}
      console.log(`${method} ${p} -> ${res.status} [${ct}] ${JSON.stringify(body.slice(0, 400))}`);
      if (res.status === 200 && body) {
        console.log('   mcp-session-id:', res.headers.get('mcp-session-id'));
      }
    } catch (e) {
      console.log(`${method} ${p} -> ERR ${e.name} ${e.message}`);
    }
  }
}
