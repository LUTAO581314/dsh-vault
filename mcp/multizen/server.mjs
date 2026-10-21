#!/usr/bin/env node
/**
 * MultiZen MCP adaptor — stdio MCP server that fronts MultiZen's HTTP MCP endpoint.
 *
 * Why this exists (what it fixes vs. connecting DSH straight to 127.0.0.1:7777/mcp):
 *   1) MultiZen returns `screenshot` as a TEXT block containing {"pngBase64":"..."}.
 *      Forwarded verbatim that is ~69k chars of base64 in the model context and no
 *      visible image. Here it is decoded into a real MCP image content block.
 *   2) MultiZen only accepts CSS selectors for click/type, and has no hover, no key
 *      press, no scroll, no select-by-value, no text lookup. Those are added below
 *      (evaluate_js for DOM work, raw CDP for real mouse/key events so CSS :hover
 *      and native form submit actually fire).
 *
 * Env: MZ_BASE (default http://127.0.0.1:7777), MZ_TOKEN (default: %APPDATA%\MultiZen\mcp-token)
 * stdout carries JSON-RPC only; all logging goes to stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const MZ_BASE = process.env.MZ_BASE || 'http://127.0.0.1:7777';
const MZ_MCP = MZ_BASE + '/mcp';

function readToken() {
  if (process.env.MZ_TOKEN) return process.env.MZ_TOKEN.trim();
  const p = path.join(process.env.APPDATA || '', 'MultiZen', 'mcp-token');
  return fs.readFileSync(p, 'utf8').trim();
}
const TOKEN = readToken();

const log = (...a) => process.stderr.write('[multizen-mcp] ' + a.join(' ') + '\n');

/* ------------------------------------------------------------------ MultiZen RPC */

let rpcId = 1;
async function mzRpc(method, params) {
  const res = await fetch(MZ_MCP, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(170000),
  });
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (!raw) throw new Error(`${method}: empty body (HTTP ${res.status})`);
  if (ct.includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const msg = JSON.parse(line.slice(5).trim());
      if (msg.error) throw new Error(`${method}: ` + JSON.stringify(msg.error));
      return msg.result;
    }
    throw new Error(`${method}: no data frame in SSE body`);
  }
  const msg = JSON.parse(raw);
  if (msg.error) throw new Error(`${method}: ` + JSON.stringify(msg.error));
  return msg.result;
}

let ready = null;
function ensureMZ() {
  if (!ready) {
    ready = mzRpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'multizen-adaptor', version: '1.0.0' },
    }).then((r) => {
      log('connected to MultiZen', JSON.stringify(r?.serverInfo || {}));
      return r;
    });
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

async function mzCall(name, args) {
  await ensureMZ();
  const r = await mzRpc('tools/call', { name, arguments: args || {} });
  if (r?.isError) {
    const text = (r.content || []).map((b) => b.text).filter(Boolean).join('\n');
    throw new Error(`${name} failed: ${text || 'unknown error'}`);
  }
  return r;
}

/** Run JS in the page; returns the raw string value. */
async function evalJs(profileId, expression, sessionId) {
  const args = { profile_id: profileId, expression };
  if (sessionId) args.sessionId = sessionId;
  const r = await mzCall('evaluate_js', args);
  const txt = (r.content || []).map((b) => b.text).filter(Boolean).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return txt;
  }
  // MultiZen may hand back {result:{type,value}} or the value directly.
  if (parsed && typeof parsed === 'object' && 'result' in parsed) {
    const v = parsed.result;
    return v && typeof v === 'object' && 'value' in v ? v.value : v;
  }
  return parsed;
}

/** evaluate_js helper that returns a JSON-decoded value. */
async function evalJson(profileId, body, sessionId) {
  const wrapped = `(() => { try { ${body} } catch (e) { return JSON.stringify({ error: String(e) }); } })()`;
  const v = await evalJs(profileId, wrapped, sessionId);
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/* ------------------------------------------------------------------ CDP (real input) */

const endpointCache = new Map(); // profile_id -> cdpEndpoint

async function cdpEndpoint(profileId) {
  if (endpointCache.has(profileId)) return endpointCache.get(profileId);
  // launch_profile is documented as idempotent; it is the only way to learn the endpoint.
  const r = await mzCall('launch_profile', { profile_id: profileId });
  const txt = (r.content || []).map((b) => b.text).filter(Boolean).join('\n');
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    j = {};
  }
  const ep = j.cdpEndpoint;
  if (!ep) throw new Error('launch_profile returned no cdpEndpoint: ' + txt.slice(0, 200));
  endpointCache.set(profileId, ep);
  return ep;
}

/**
 * Pick the CDP page target that matches the tab evaluate_js is driving.
 * Without this the click/hover lands in whichever tab /json/list happens to
 * list first — i.e. a background tab — and nothing appears to happen.
 */
function pickPage(pages, href) {
  if (!pages.length) return null;
  const norm = (u) => (u || '').split('#')[0];
  if (href) {
    const exact = pages.find((t) => norm(t.url) === norm(href));
    if (exact) return exact;
    try {
      const origin = new URL(href).origin;
      const same = pages.find((t) => {
        try {
          return norm(t.url) !== 'about:blank' && new URL(t.url).origin === origin;
        } catch {
          return false;
        }
      });
      if (same) return same;
    } catch {}
  }
  return pages.find((t) => t.url && t.url !== 'about:blank') || pages[0];
}

/** Send a batch of CDP commands over one websocket, in order. */
async function cdpRun(profileId, commands) {
  const href = await evalJs(profileId, 'location.href').catch(() => null);
  const base = await cdpEndpoint(profileId);
  const list = await (await fetch(base + '/json/list')).json();
  const pages = (list || []).filter((t) => t.type === 'page' && !/^(devtools|chrome-error):/.test(t.url || ''));
  const page = pickPage(pages, typeof href === 'string' ? href : null);
  if (!page) throw new Error('no CDP page target on ' + base);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP connect timeout')), 10000);
    ws.onopen = () => {
      clearTimeout(t);
      res();
    };
    ws.onerror = () => {
      clearTimeout(t);
      rej(new Error('CDP connect failed for ' + page.url));
    };
  });
  try {
    const pending = new Map();
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
    const out = [];
    for (const [i, c] of commands.entries()) {
      const id = i + 1;
      const reply = await new Promise((res, rej) => {
        const t = setTimeout(() => {
          pending.delete(id);
          rej(new Error('CDP ' + c.method + ' timeout'));
        }, 15000);
        pending.set(id, (m) => {
          clearTimeout(t);
          res(m);
        });
        ws.send(JSON.stringify({ id, method: c.method, params: c.params || {} }));
      });
      if (reply.error) throw new Error('CDP ' + c.method + ': ' + JSON.stringify(reply.error));
      out.push(reply.result);
    }
    return out;
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function cdpSend(profileId, method, params) {
  const [r] = await cdpRun(profileId, [{ method, params }]);
  return r;
}

/** Element centre in CSS pixels, via evaluate_js. */
async function elementCentre(profileId, selector, sessionId) {
  const r = await evalJson(
    profileId,
    `const el = document.querySelector(${JSON.stringify(selector)});
     if (!el) return JSON.stringify({ found: false });
     el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
     const b = el.getBoundingClientRect();
     return JSON.stringify({ found: true, x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, top: b.top, left: b.left });`,
    sessionId,
  );
  if (!r || !r.found) throw new Error('selector not found: ' + selector);
  if (r.w === 0 || r.h === 0) throw new Error('selector has zero size (not rendered): ' + selector);
  if (r.y < 0 || r.y > 20000) throw new Error('element is outside the viewport: ' + selector);
  return r;
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

function keyDef(name) {
  if (KEYMAP[name]) return KEYMAP[name];
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[A-Z]/.test(upper)
      ? 'Key' + upper
      : /[0-9]/.test(name)
        ? 'Digit' + name
        : '';
    return { key: name, code: code || undefined, keyCode: upper.charCodeAt(0), text: name };
  }
  throw new Error('unsupported key: ' + name + ' (try Enter, Tab, Escape, ArrowDown, PageDown, or a single character)');
}

/* ------------------------------------------------------------------ results */

const textResult = (text) => ({ content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] });
const jsonResult = (obj) => textResult(JSON.stringify(obj, null, 2));

/** Pull the concatenated text out of a MultiZen tool reply. */
function mzText(r) {
  return (r.content || [])
    .map((b) => b.text)
    .filter((t) => typeof t === 'string')
    .join('\n');
}

/* ------------------------------------------------------------------ tool definitions */

const P = (extra, required) => ({ type: 'object', properties: extra, required: required || [] });
const ID = { type: 'string', description: 'Profile id from list_profiles' };
const SEL = { type: 'string', description: 'CSS selector' };
const SID = { type: 'string', description: 'Optional tab target id from list_tabs (defaults to the active tab)' };

const proxySchema = {
  list_profiles: P({}),
  create_profile: P(
    {
      name: { type: 'string' },
      notes: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      proxy: { type: 'object', additionalProperties: true },
      fingerprint: { type: 'object', additionalProperties: true },
      seed: { type: 'integer' },
    },
    ['name'],
  ),
  update_profile: P({ profile_id: ID, name: { type: 'string' }, notes: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, proxy: { type: ['object', 'null'], additionalProperties: true }, fingerprint: { type: 'object', additionalProperties: true } }, ['profile_id']),
  delete_profile: P({ profile_id: ID }, ['profile_id']),
  list_fingerprint_options: P({}),
  launch_profile: P({ profile_id: ID }, ['profile_id']),
  close_profile: P({ profile_id: ID }, ['profile_id']),
  navigate: P({ profile_id: ID, url: { type: 'string' } }, ['profile_id', 'url']),
  click: P({ profile_id: ID, selector: SEL }, ['profile_id', 'selector']),
  type: P({ profile_id: ID, selector: SEL, text: { type: 'string' } }, ['profile_id', 'selector', 'text']),
  extract: P({ profile_id: ID }, ['profile_id']),
  evaluate_js: P({ profile_id: ID, expression: { type: 'string' }, sessionId: SID }, ['profile_id', 'expression']),
  wait_for_selector: P({ profile_id: ID, selector: SEL, timeout_ms: { type: 'integer' }, sessionId: SID }, ['profile_id', 'selector']),
  wait_for_navigation: P({ profile_id: ID, timeout_ms: { type: 'integer' }, sessionId: SID }, ['profile_id']),
  wait_for_load: P({ profile_id: ID, timeout_ms: { type: 'integer' }, sessionId: SID }, ['profile_id']),
  list_tabs: P({ profile_id: ID, sessionId: SID }, ['profile_id']),
  new_tab: P({ profile_id: ID, url: { type: 'string' }, sessionId: SID }, ['profile_id']),
  activate_tab: P({ profile_id: ID, target_id: { type: 'string' }, sessionId: SID }, ['profile_id', 'target_id']),
  close_tab: P({ profile_id: ID, target_id: { type: 'string' }, sessionId: SID }, ['profile_id', 'target_id']),
  get_cookies: P({ profile_id: ID, urls: { type: 'array', items: { type: 'string' } }, sessionId: SID }, ['profile_id', 'urls']),
  set_cookies: P({ profile_id: ID, cookies: { type: 'array', items: { type: 'object', additionalProperties: true } }, sessionId: SID }, ['profile_id', 'cookies']),
};

const PROXY_TOOLS = [
  ['list_profiles', 'List every browser profile: id, name, tags, isRunning, proxy, timezone, device, engine.'],
  ['create_profile', 'Create a fingerprint profile. Use list_fingerprint_options for valid device/locale/timezone/screen values.'],
  ['update_profile', 'Change a profile. Takes effect on the next launch.'],
  ['delete_profile', 'Permanently delete a profile including its cookies and extensions.'],
  ['list_fingerprint_options', 'Device families and locale groups accepted by create_profile.'],
  ['launch_profile', 'Start the profile browser window (no headless mode exists). Idempotent; returns the CDP endpoint.'],
  ['close_profile', 'Close the profile browser window.'],
  ['navigate', 'Send the active tab to a URL.'],
  ['click', 'Click an element by CSS selector.'],
  ['type', 'Type text into an element by CSS selector (replaces its current value).'],
  ['extract', 'Read the active tab: URL, title, and a trimmed accessibility tree. Use it to derive CSS selectors.'],
  ['evaluate_js', 'Evaluate a JS expression in the page and return its value.'],
  ['wait_for_selector', 'Poll until a CSS selector matches.'],
  ['wait_for_navigation', 'Poll until document.readyState is complete.'],
  ['wait_for_load', 'Alias of wait_for_navigation.'],
  ['list_tabs', 'List the profile browser tabs (target ids).'],
  ['new_tab', 'Open a tab (optionally at a URL).'],
  ['activate_tab', 'Bring a tab to the front.'],
  ['close_tab', 'Close a tab.'],
  ['get_cookies', 'Read cookies for the given URLs (urls is required).'],
  ['set_cookies', 'Write cookies into the profile.'],
];

const EXTRA_TOOLS = [
  {
    name: 'screenshot',
    description: 'Screenshot the visible viewport. Returns an actual image so it can be looked at directly.',
    inputSchema: P({ profile_id: ID }, ['profile_id']),
  },
  {
    name: 'click_text',
    description:
      'Click an element by its visible text instead of a CSS selector — the most robust way to hit buttons and links. Matches the deepest element whose visible text equals (exact=true) or contains the string.',
    inputSchema: P(
      {
        profile_id: ID,
        text: { type: 'string', description: 'Visible text to match' },
        exact: { type: 'boolean', description: 'Require an exact match after trimming (default false = contains)' },
        nth: { type: 'integer', description: 'Which match to use, 0-based (default 0)' },
        native: {
          type: 'boolean',
          description: 'Use DevTools mouse events instead of a DOM click. Off by default because CloakBrowser ignores CDP input for clicks.',
        },
        sessionId: SID,
      },
      ['profile_id', 'text'],
    ),
  },
  {
    name: 'find_text',
    description: 'Locate elements by visible text and report them (tag, selector, text, centre) without clicking. Use it when click_text is ambiguous.',
    inputSchema: P({ profile_id: ID, text: { type: 'string' }, exact: { type: 'boolean' }, sessionId: SID }, ['profile_id', 'text']),
  },
  {
    name: 'get_text',
    description: 'Read the visible text (or an attribute) of one element, or of the whole page when selector is omitted.',
    inputSchema: P({ profile_id: ID, selector: SEL, attribute: { type: 'string', description: 'e.g. href, value, src' }, sessionId: SID }, ['profile_id']),
  },
  {
    name: 'hover',
    description: 'Move a real mouse over an element (CSS :hover and JS mouseenter both fire). Fails if the element is not rendered.',
    inputSchema: P({ profile_id: ID, selector: SEL, sessionId: SID }, ['profile_id', 'selector']),
  },
  {
    name: 'press_key',
    description: 'Send a real key press: Enter, Tab, Escape, Backspace, Delete, Space, Arrow*, Home, End, PageUp, PageDown, or a single character. Submits forms the way a human would.',
    inputSchema: P({ profile_id: ID, key: { type: 'string' }, sessionId: SID }, ['profile_id', 'key']),
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a scrollable element. Positive dy scrolls down.',
    inputSchema: P(
      {
        profile_id: ID,
        dy: { type: 'integer', description: 'Vertical pixels (positive = down)' },
        dx: { type: 'integer' },
        selector: { type: 'string', description: 'Scroll this element instead of the window' },
        sessionId: SID,
      },
      ['profile_id', 'dy'],
    ),
  },
  {
    name: 'select_option',
    description: 'Choose an option in a native <select> by value or by visible label.',
    inputSchema: P({ profile_id: ID, selector: SEL, value: { type: 'string' }, label: { type: 'string' }, sessionId: SID }, ['profile_id', 'selector']),
  },
  {
    name: 'fill',
    description:
      'Set the value of an input/textarea/contenteditable in one shot: focus, replace the value through the native property setter, then fire input+change so framework state (React/Vue) updates. Reliable where MultiZen type is not.',
    inputSchema: P(
      {
        profile_id: ID,
        selector: SEL,
        value: { type: 'string', description: 'Text to put in the field; empty string clears it' },
        append: { type: 'boolean', description: 'Append to the existing value instead of replacing it' },
        sessionId: SID,
      },
      ['profile_id', 'selector', 'value'],
    ),
  },
];

const TOOLS = [
  ...PROXY_TOOLS.map(([name, description]) => ({ name, description, inputSchema: proxySchema[name] || P({}) })),
  ...EXTRA_TOOLS,
];

/* ------------------------------------------------------------------ tool dispatch */

async function dispatchScreenshot(args) {
  const r = await mzCall('screenshot', args);
  const txt = mzText(r);
  let b64 = null;
  try {
    const j = JSON.parse(txt);
    b64 = j.pngBase64 || j.base64 || j.image || j.data || null;
  } catch {
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(txt.trim())) b64 = txt.trim();
  }
  if (!b64) throw new Error('screenshot returned no PNG payload: ' + txt.slice(0, 200));
  return { content: [{ type: 'image', data: b64.replace(/\s+/g, ''), mimeType: 'image/png' }] };
}

async function dispatchClickText(args) {
  const { profile_id, text, exact, nth, native, sessionId } = args;
  const body = `
    const wantExact = ${exact ? 'true' : 'false'};
    const want = ${JSON.stringify(text || '')};
    const target = wantExact ? want.trim() : want;
    const all = Array.from(document.querySelectorAll('body *'));
    const hits = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') continue;
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!t) continue;
      const ok = wantExact ? t.toLowerCase() === target.toLowerCase() : t.toLowerCase().includes(target.toLowerCase());
      if (ok) hits.push({ el, r, t });
    }
    // Prefer the deepest / smallest match: that is the actionable node, not its wrapper.
    hits.sort((a, b) => (a.r.width * a.r.height) - (b.r.width * b.r.height));
    if (!hits.length) return JSON.stringify({ found: false });
    const pick = hits[Math.min(${Number.isInteger(nth) ? nth : 0}, hits.length - 1)];
    const el = pick.el;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const tag = el.tagName.toLowerCase();
    let selector = tag;
    if (el.id) selector = tag + '#' + el.id;
    else if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
      if (cls) selector = tag + '.' + cls;
    }
    window.__mzPick = el;
    const r2 = el.getBoundingClientRect();
    return JSON.stringify({ found: true, matches: hits.length, tag, selector, text: pick.t.slice(0, 160), href: el.getAttribute('href') || null, x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 });
  `;
  const info = await evalJson(profile_id, body, sessionId);
  if (!info || !info.found) return textResult(JSON.stringify({ found: false, text }));

  if (native) {
    // DevTools Input events. Note: CloakBrowser swallows these at the click layer (see README),
    // so this path is opt-in and only useful on engines that honour CDP input.
    await cdpRun(profile_id, [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: info.x, y: info.y, button: 'none' } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1 } },
    ]);
    return textResult(JSON.stringify({ clicked: true, mode: 'cdp-input', ...info }, null, 2));
  }

  // Default: a full synthetic pointer/mouse sequence plus the native .click(), which is what
  // actually fires handlers and default actions (navigation, form submit) on this engine.
  const out = await evalJson(
    profile_id,
    `
    const el = window.__mzPick;
    if (!el || !el.isConnected) return JSON.stringify({ ok: false, reason: 'element detached before click' });
    try { el.focus({ preventScroll: true }); } catch {}
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    const down = { ...base, buttons: 1 };
    const up = { ...base, buttons: 0 };
    let pointer = true;
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', down));
      el.dispatchEvent(new MouseEvent('mousedown', down));
      el.dispatchEvent(new PointerEvent('pointerup', up));
      el.dispatchEvent(new MouseEvent('mouseup', up));
    } catch { pointer = false; }
    el.click();
    return JSON.stringify({ ok: true, pointer });
  `,
    sessionId,
  );
  return textResult(JSON.stringify({ clicked: true, mode: 'dom', ...out, ...info }, null, 2));
}

async function dispatchFindText(args) {
  const { profile_id, text, exact, sessionId } = args;
  const body = `
    const wantExact = ${exact ? 'true' : 'false'};
    const want = ${JSON.stringify(text || '')}.trim();
    const out = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!t) continue;
      const ok = wantExact ? t.toLowerCase() === want.toLowerCase() : t.toLowerCase().includes(want.toLowerCase());
      if (!ok) continue;
      const tag = el.tagName.toLowerCase();
      let sel = tag;
      if (el.id) sel = tag + '#' + el.id;
      else if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
        if (cls) sel = tag + '.' + cls;
      }
      out.push({ tag, selector: sel, text: t.slice(0, 120), w: Math.round(r.width), h: Math.round(r.height), clickable: ['a','button','input','select','textarea','label'].includes(tag) || !!el.onclick || el.getAttribute('role') === 'button' });
    }
    out.sort((a, b) => a.w * a.h - b.w * b.h);
    return JSON.stringify({ count: out.length, matches: out.slice(0, 12) });
  `;
  return jsonResult(await evalJson(profile_id, body, sessionId));
}

async function dispatchGetText(args) {
  const { profile_id, selector, attribute, sessionId } = args;
  const body = selector
    ? `const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return JSON.stringify({ found: false });
       return JSON.stringify({ found: true, ${attribute ? `value: el.getAttribute(${JSON.stringify(attribute)})` : 'text: el.innerText, value: el.value ?? null'} });`
    : `return JSON.stringify({ found: true, url: location.href, title: document.title, text: document.body ? document.body.innerText : '' });`;
  return jsonResult(await evalJson(profile_id, body, sessionId));
}

async function dispatchHover(args) {
  const { profile_id, selector, sessionId } = args;
  const c = await elementCentre(profile_id, selector, sessionId);
  // CDP mouse movement does drive the compositor, so CSS :hover reacts to it — that is the part
  // that still works on CloakBrowser. Fire the DOM mouse events too for JS listeners.
  await cdpSend(profile_id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, button: 'none' }).catch(() => null);
  await new Promise((r) => setTimeout(r, 120));
  await cdpSend(profile_id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + 1, y: c.y + 1, button: 'none' }).catch(() => null);
  const dom = await evalJson(
    profile_id,
    `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ found: false });
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: ${c.x}, clientY: ${c.y} };
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', o));
    return JSON.stringify({ found: true });
  `,
    sessionId,
  ).catch(() => null);
  return jsonResult({ hovered: true, selector, x: Math.round(c.x), y: Math.round(c.y), dom });
}

async function dispatchPressKey(args) {
  const { profile_id, key, sessionId } = args;
  const k = keyDef(key);
  // CDP Input is swallowed on CloakBrowser, so keys are delivered as DOM events. A synthetic
  // keydown does NOT run the browser's default action, so Enter inside a form is submitted
  // explicitly and a printable character is inserted at the caret.
  const out = await evalJson(
    profile_id,
    `
    const k = ${JSON.stringify({ key: k.key, code: k.code || '', keyCode: k.keyCode, text: k.text ?? null })};
    const el = document.activeElement || document.body;
    const init = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true, composed: true };
    const kd = new KeyboardEvent('keydown', init);
    el.dispatchEvent(kd);
    let typed = false;
    if (k.text && k.text.length === 1 && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      setter.call(el, el.value.slice(0, start) + k.text + el.value.slice(end));
      el.selectionStart = el.selectionEnd = start + k.text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      typed = true;
    } else if (k.text && k.text.length === 1 && el.isContentEditable) {
      document.execCommand('insertText', false, k.text);
      typed = true;
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    let submitted = false;
    if (k.key === 'Enter' || k.keyCode === 13) {
      const form = el.form || (el.closest ? el.closest('form') : null);
      if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); submitted = true; }
    }
    return JSON.stringify({ pressed: k.key, active: el.tagName, typed, submitted, defaultPrevented: kd.defaultPrevented });
  `,
    sessionId,
  );
  return jsonResult(out);
}

async function dispatchScroll(args) {
  const { profile_id, dy, dx, selector, sessionId } = args;
  const body = selector
    ? `const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return JSON.stringify({ found: false });
       const before = el.scrollTop;
       el.scrollBy({ top: ${Number(dy) || 0}, left: ${Number(dx) || 0}, behavior: 'instant' });
       return JSON.stringify({ found: true, before, after: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });`
    : `const before = window.scrollY;
       window.scrollBy({ top: ${Number(dy) || 0}, left: ${Number(dx) || 0}, behavior: 'instant' });
       return JSON.stringify({ found: true, before, after: window.scrollY, docHeight: document.documentElement.scrollHeight, viewport: window.innerHeight });`;
  return jsonResult(await evalJson(profile_id, body, sessionId));
}

async function dispatchSelectOption(args) {
  const { profile_id, selector, value, label, sessionId } = args;
  const body = `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ found: false });
    if (el.tagName.toLowerCase() !== 'select') return JSON.stringify({ found: true, error: 'not a <select>', tag: el.tagName.toLowerCase() });
    const opts = Array.from(el.options).map(o => ({ value: o.value, label: (o.textContent || '').trim() }));
    let idx = -1;
    if (${value ? JSON.stringify(value) : 'null'} != null) idx = opts.findIndex(o => o.value === ${value ? JSON.stringify(value) : 'null'});
    if (idx < 0 && ${label ? JSON.stringify(label) : 'null'} != null) idx = opts.findIndex(o => o.label === ${label ? JSON.stringify(label) : 'null'});
    if (idx < 0) return JSON.stringify({ found: true, error: 'no matching option', options: opts.slice(0, 20) });
    el.selectedIndex = idx;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ found: true, selected: opts[idx] });
  `;
  return jsonResult(await evalJson(profile_id, body, sessionId));
}

async function dispatchFill(args) {
  const { profile_id, selector, value, append, sessionId } = args;
  const body = `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ found: false });
    const tag = el.tagName.toLowerCase();
    const next = ${JSON.stringify(value ?? '')};
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    try { el.focus({ preventScroll: true }); } catch {}
    let kind = 'other';
    if (tag === 'input' || tag === 'textarea') {
      kind = 'value';
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const before = el.value;
      setter.call(el, ${append ? 'before + next' : 'next'});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      kind = 'contenteditable';
      el.textContent = ${append ? "el.textContent + next" : 'next'};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: next, inputType: 'insertText' }));
    } else {
      return JSON.stringify({ found: true, error: 'element is not fillable', tag });
    }
    return JSON.stringify({ found: true, tag, kind, value: tag === 'input' || tag === 'textarea' ? el.value : el.textContent, length: (tag === 'input' || tag === 'textarea' ? el.value : el.textContent || '').length });
  `;
  return jsonResult(await evalJson(profile_id, body, sessionId));
}

async function callTool(name, args) {
  switch (name) {
    case 'screenshot':
      return dispatchScreenshot(args);
    case 'click_text':
      return dispatchClickText(args);
    case 'find_text':
      return dispatchFindText(args);
    case 'get_text':
      return dispatchGetText(args);
    case 'hover':
      return dispatchHover(args);
    case 'press_key':
      return dispatchPressKey(args);
    case 'scroll':
      return dispatchScroll(args);
    case 'select_option':
      return dispatchSelectOption(args);
    case 'fill':
      return dispatchFill(args);
    default: {
      if (!proxySchema[name]) throw new Error('unknown tool: ' + name);
      const r = await mzCall(name, args);
      return { content: (r.content || []).filter((b) => b.type === 'text').map((b) => ({ type: 'text', text: b.text })) };
    }
  }
}

/* ------------------------------------------------------------------ stdio JSON-RPC */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const INSTRUCTIONS = `Driver for MultiZen fingerprint-browser profiles.

Workflow: list_profiles -> launch_profile (idempotent; nothing else works before it) -> navigate ->
screenshot or get_text (see the page) -> act -> close_profile when finished.

Acting: prefer click_text("Save") over a CSS selector — it is measured, not guessed. Use find_text to
see candidates and their selectors, fill() to type into a field (MultiZen's own type does nothing on
this engine), press_key("Enter") to submit a form, hover() to open CSS/JS menus, scroll() for long
pages, select_option() for native dropdowns, and screenshot whenever you need to actually look.
Verify each action with get_text instead of assuming it landed.

Constraints: there is no headless mode — a real desktop window opens for every profile. Cookies,
logins, fingerprint, proxy and timezone persist per profile. Do not build profiles in bulk, and do
not work around CAPTCHAs or 2FA on your own — hand those to the human.`;

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'multizen', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          },
        });
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        log('call', name, JSON.stringify(args).slice(0, 300));
        try {
          const result = await callTool(name, args);
          send({ jsonrpc: '2.0', id, result });
        } catch (e) {
          log('ERROR', name, e.message);
          send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } });
        }
        return;
      }
      default:
        if (isNotification) return;
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
    }
  } catch (e) {
    log('FATAL', method, e.message);
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    log('bad JSON line', t.slice(0, 200));
    return;
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));
process.on('uncaughtException', (e) => log('uncaught', e.stack || String(e)));
process.on('unhandledRejection', (e) => log('unhandled', String(e)));
log('ready, endpoint', MZ_MCP);
