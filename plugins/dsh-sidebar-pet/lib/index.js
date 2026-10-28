import { open, mkdir, rename, unlink, readFile, stat } from 'node:fs/promises';
import { dirname, basename, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-sidebar-pet';
export const inject = ['webServer'];
const MAX_BYTES = 16 * 1024;
const MAX_SELECTED = 128;
const queues = new Map();

function fault(status, code) { return Object.assign(new Error(code), { status, code }); }

export function profileDirectory(packageDirectory = dirname(dirname(fileURLToPath(import.meta.url))), env = process.env) {
  const override = env.DSH_SIDEBAR_PET_PROFILE_DIR;
  if (override) {
    if (!isAbsolute(override)) throw fault(503, 'profile_directory_must_be_absolute');
    return resolve(override);
  }
  let current = resolve(packageDirectory);
  while (dirname(current) !== current) {
    if (basename(current) === 'node_modules' && basename(dirname(dirname(current))) === 'profiles') return dirname(current);
    current = dirname(current);
  }
  throw fault(503, 'profile_directory_unresolved');
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'selected') || !Array.isArray(value.selected)) throw fault(400, 'invalid_config');
  if (value.selected.length > MAX_SELECTED) throw fault(400, 'too_many_selections');
  for (const item of value.selected) {
    if (typeof item !== 'string' || !item.trim() || item.length > 128 || /[\u0000-\u001f\u007f]/u.test(item)) throw fault(400, 'invalid_selection');
  }
  if (new Set(value.selected).size !== value.selected.length) throw fault(400, 'duplicate_selection');
  return { selected: [...value.selected] };
}

function sameOrigin(req) {
  const headers = req.headers ?? {};
  const site = headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return false;
  if (!headers.origin) return true; // Native tools have no browser Origin header.
  if (typeof headers.origin !== 'string' || typeof headers.host !== 'string') return false;
  try {
    const origin = new URL(headers.origin);
    const protocol = req.socket?.encrypted ? 'https:' : 'http:';
    return origin.origin === protocol + '//' + headers.host && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash;
  } catch { return false; }
}

function send(res, status, body, allow) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(allow ? { allow } : {}) });
  res.end(JSON.stringify(body));
}

async function readConfig(path) {
  try {
    if ((await stat(path)).size > MAX_BYTES) throw fault(500, 'stored_config_too_large');
    const data = await readFile(path);
    if (data.length > MAX_BYTES) throw fault(500, 'stored_config_too_large');
    try { return validate(JSON.parse(data.toString('utf8'))); }
    catch { throw fault(500, 'stored_config_invalid'); }
  } catch (error) {
    if (error.code === 'ENOENT') return { selected: [] };
    throw error;
  }
}

async function writeConfig(path, value) {
  const serialized = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw fault(413, 'payload_too_large');
  // One queue per destination survives multiple plugin contexts in this module.
  const previous = queues.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temp = path + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, path);
    } finally {
      await handle?.close();
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  });
  queues.set(path, pending);
  try { await pending; } finally { if (queues.get(path) === pending) queues.delete(path); }
}

async function readBody(req) {
  const length = req.headers?.['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw fault(413, 'payload_too_large');
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] ?? '')) throw fault(415, 'json_required');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) throw fault(413, 'payload_too_large');
    chunks.push(bytes);
  }
  try { return validate(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error.status) throw error; throw fault(400, 'invalid_json'); }
}

export function apply(ctx) {
  let path, profileError;
  try { path = join(profileDirectory(), 'sidebar-pet.json'); } catch (error) { profileError = error; }
  function route(endpoint, allowed, handle) {
    ctx.effect(() => ctx.webServer.register({ name: name + endpoint, kind: 'exact', path: '/sidebar-pet/' + endpoint,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return send(res, 403, { error: 'origin_forbidden' });
        if (!allowed.includes(req.method)) return send(res, 405, { error: 'method_not_allowed' }, allowed.join(', '));
        try { await handle(req, res); }
        catch (error) { send(res, error.status ?? 500, { error: error.code && error.status ? error.code : 'storage_error' }); }
      }
    }), name + ': ' + endpoint);
  }
  route('config', ['GET', 'POST'], async (req, res) => {
    if (profileError) throw profileError;
    if (req.method === 'GET') return send(res, 200, await readConfig(path));
    const value = await readBody(req);
    await writeConfig(path, value);
    send(res, 200, value);
  });
  route('status', ['GET'], async (_req, res) => {
    if (profileError) return send(res, 503, { name, version: '0.1.0', ok: false, error: profileError.code });
    const value = await readConfig(path);
    send(res, 200, { name, version: '0.1.0', ok: true, configFile: path, selectedCount: value.selected.length, limits: { maxBytes: MAX_BYTES, maxSelected: MAX_SELECTED }, petMenuApi: '/dsh-pet-7340/menu/item', owner: name });
  });
}

// Explicit self-test mode keeps the workspace package within its four-file contract.
async function selfTest() {
  const { test } = await import('node:test');
  const assert = await import('node:assert/strict');
  const { mkdtemp, mkdir, rm, readdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { Readable } = await import('node:stream');
  await test('mock webServer routes: profile persistence, validation and lifecycle', async t => {
    const tempRoot = process.env.DSH_SIDEBAR_PET_TEST_TMPDIR || tmpdir();
    await mkdir(tempRoot, { recursive: true });
    const profile = await mkdtemp(join(tempRoot, 'sidebar-pet-test-'));
    const original = process.env.DSH_SIDEBAR_PET_PROFILE_DIR;
    process.env.DSH_SIDEBAR_PET_PROFILE_DIR = profile;
    const mount = () => {
      const routes = new Map(), disposers = [];
      apply({ webServer: { register(r) { assert.equal(r.kind, 'exact'); routes.set(r.path, r); return () => routes.delete(r.path); } }, effect(fn) { disposers.push(fn()); } });
      return { routes, dispose() { disposers.forEach(fn => fn()); } };
    };
    const request = async (host, method, body, headers = {}, endpoint = 'config') => {
      const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
      req.method = method; req.url = '/sidebar-pet/' + endpoint;
      req.headers = { host: '127.0.0.1:16143', 'content-type': 'application/json', ...headers };
      req.socket = { encrypted: false };
      let status, response, responseHeaders;
      await host.routes.get(req.url).handler(req, { writeHead(s, h) { status = s; responseHeaders = h; }, end(b) { response = JSON.parse(b); } });
      return { status, body: response, headers: responseHeaders };
    };
    let host;
    try {
      host = mount();
      await t.test('profile is derived from package location, including pnpm layout', () => {
        assert.equal(profileDirectory(join(profile, 'profiles', 'desktop', 'node_modules', '.pnpm', 'x', 'node_modules', name), {}), join(profile, 'profiles', 'desktop'));
        assert.throws(() => profileDirectory(profile, {}), /profile_directory_unresolved/);
      });
      await t.test('default and durable round trip across remount', async () => {
        assert.deepEqual((await request(host, 'GET')).body, { selected: [] });
        const config = { selected: ['宠物设置', '显示宠物'] };
        assert.equal((await request(host, 'POST', config, { origin: 'http://127.0.0.1:16143' })).status, 200);
        host.dispose(); host = mount();
        assert.deepEqual((await request(host, 'GET')).body, config);
        assert.deepEqual(JSON.parse(await readFile(join(profile, 'sidebar-pet.json'), 'utf8')), config);
      });
      await t.test('bad schema and JSON never overwrite the last good selection', async () => {
        const before = await readFile(join(profile, 'sidebar-pet.json'), 'utf8');
        for (const input of [null, [], {}, { selected: 'x' }, { selected: [1] }, { selected: [''] }, { selected: ['a', 'a'] }, { selected: ['x'], extra: true }, { selected: ['x'.repeat(129)] }, { selected: Array.from({ length: 129 }, (_, i) => String(i)) }, '{']) assert.equal((await request(host, 'POST', input)).status, 400);
        assert.equal(await readFile(join(profile, 'sidebar-pet.json'), 'utf8'), before);
      });
      await t.test('origin, method, media type and both body limits', async () => {
        assert.equal((await request(host, 'POST', { selected: [] }, { origin: 'http://evil.example' })).status, 403);
        assert.equal((await request(host, 'POST', { selected: [] }, { 'sec-fetch-site': 'cross-site' })).status, 403);
        assert.equal((await request(host, 'GET', undefined, { origin: 'null' })).status, 403);
        assert.equal((await request(host, 'DELETE')).status, 405);
        assert.equal((await request(host, 'POST', '{}', { 'content-type': 'text/plain' })).status, 415);
        assert.equal((await request(host, 'POST', '{}', { 'content-length': '17000' })).status, 413);
        assert.equal((await request(host, 'POST', ' '.repeat(17000))).status, 413);
      });
      await t.test('concurrent atomic saves leave a complete final document without temp files', async () => {
        const saves = Array.from({ length: 12 }, (_, i) => request(host, 'POST', { selected: ['item-' + i] }));
        assert.ok((await Promise.all(saves)).every(r => r.status === 200));
        assert.deepEqual((await request(host, 'GET')).body, { selected: ['item-11'] });
        assert.deepEqual(await readdir(profile), ['sidebar-pet.json']);
        assert.equal((await request(host, 'GET', undefined, {}, 'status')).body.selectedCount, 1);
      });
      await t.test('corrupt stored data reports a diagnostic error without overwriting', async () => {
        await writeFile(join(profile, 'sidebar-pet.json'), '{broken');
        assert.equal((await request(host, 'GET')).status, 500);
        assert.equal((await request(host, 'GET', undefined, {}, 'status')).body.error, 'stored_config_invalid');
      });
      await t.test('effect disposal removes all registrations', () => { host.dispose(); assert.equal(host.routes.size, 0); });
    } finally {
      host?.dispose();
      if (original === undefined) delete process.env.DSH_SIDEBAR_PET_PROFILE_DIR; else process.env.DSH_SIDEBAR_PET_PROFILE_DIR = original;
      await rm(profile, { recursive: true, force: true });
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--self-test')) await selfTest();
