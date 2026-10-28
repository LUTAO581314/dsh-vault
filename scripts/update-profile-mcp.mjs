import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [dshHome, tokenPathArg, patchPathArg, mode, helperPathOverride] = process.argv.slice(2)
if (!dshHome || !tokenPathArg) {
  console.error('Usage: node update-profile-mcp.mjs <dsh-home> <token-file> [patch-file] [--dry-run]')
  process.exit(2)
}

const tokenPath = tokenPathArg.replace(/^%APPDATA%/i, process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
const profileDir = path.join(dshHome, 'profiles', 'desktop')
const patchPath = patchPathArg && patchPathArg !== '--dry-run'
  ? patchPathArg
  : path.join(profileDir, 'cordis.patch.yml')
const helperPath = helperPathOverride || path.join(profileDir, 'node_modules', 'dsh-armory', 'lib', 'mcp-config.js')
const templatePath = new URL('../profiles/desktop/mcp-servers.json', import.meta.url)

try {
  const token = readFileSync(tokenPath, 'utf8').trim()
  if (!token) throw new Error('empty_token')
  const template = JSON.parse(readFileSync(templatePath, 'utf8'))
  const configured = template.multizen
  if (!configured?.name || !configured.transport || !configured.url) throw new Error('invalid_server_config')
  if (!existsSync(helperPath)) throw new Error('missing_mcp_helper')

  const { readManagedMcpServers, updateManagedMcpPatch } = await import(pathToFileURL(helperPath).href)
  const previous = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const existing = readManagedMcpServers(previous).servers.find(server => server.name === configured.name)
  const spec = {
    ...existing,
    name: configured.name,
    transport: configured.transport,
    url: configured.url,
    headers: {
      ...(existing?.headers || {}),
      [configured.authHeader]: configured.authScheme + ' ' + token,
    },
  }
  const next = updateManagedMcpPatch(previous, [spec])

  if (mode === '--dry-run') {
    process.stdout.write(JSON.stringify({ action: 'update', server: configured.name, target: patchPath, bytes: Buffer.byteLength(next) }) + '\n')
    process.exit(0)
  }

  await mkdir(path.dirname(patchPath), { recursive: true })
  const tempPath = patchPath + '.' + randomUUID() + '.tmp'
  let file
  try {
    file = await open(tempPath, 'wx', 0o600)
    await file.writeFile(next, 'utf8')
    await file.sync()
    await file.close()
    file = undefined
    await rename(tempPath, patchPath)
  } finally {
    await file?.close()
    await unlink(tempPath).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  process.stdout.write('Configured the MultiZen MCP entry in the DSH desktop profile.\n')
} catch {
  console.error('Could not configure the MultiZen MCP entry. Check that MultiZen, dsh-armory, and its local token file are installed.')
  process.exitCode = 1
}
