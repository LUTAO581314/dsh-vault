import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_PORT = 7777

function defaultExecutable() {
  const configured = process.env.DSH_MULTIZEN_EXE?.trim()
  if (configured) return configured
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Programs', 'MultiZen', 'MultiZen.exe')
  return ''
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

async function isListening(port, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 800)
  const onAbort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    })
    return response.status >= 100 && response.status < 600
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export function apply(root, config = {}) {
  root.inject(['subprocess'], ctx => {
    const executable = String(config.executable || defaultExecutable())
    const port = numberOr(config.port, DEFAULT_PORT)
    const cwd = executable ? path.dirname(executable) : process.cwd()
    const controller = new AbortController()
    let child = null

    const log = (level, message, extra) => {
      const logger = ctx.logger
      if (typeof logger?.[level] === 'function') logger[level](message, extra)
    }

    const ensure = async () => {
      if (controller.signal.aborted) return
      if (await isListening(port, controller.signal)) {
        log('info', `dsh-multizen-launcher: MultiZen MCP already listening on ${port}`)
        return
      }
      if (!fs.existsSync(executable)) {
        log('error', `dsh-multizen-launcher: executable not found: ${executable}`)
        return
      }
      try {
        child = ctx.get('subprocess').spawn({
          argv: [executable],
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 65536 },
            stderr: { maxBytes: 65536 },
          },
          graceMs: 2000,
          signal: controller.signal,
        })
        void child.done.then(outcome => {
          if (!controller.signal.aborted) log('warn', 'dsh-multizen-launcher: MultiZen exited', outcome)
        }).catch(error => {
          if (!controller.signal.aborted) log('error', 'dsh-multizen-launcher: managed process failed', error)
        })
        log('info', `dsh-multizen-launcher: started MultiZen through DSH for MCP port ${port}`)
      } catch (error) {
        log('error', 'dsh-multizen-launcher: failed to start MultiZen through DSH', error)
      }
    }

    void ensure()
    ctx.effect(() => () => controller.abort(), 'dsh-multizen-launcher: managed process')
  })
}
