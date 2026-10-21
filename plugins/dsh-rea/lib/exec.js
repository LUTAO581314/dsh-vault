/**
 * Bounded subprocess helper.
 *
 * Every probe in this bundle is a short, read-only, argument-array spawn with a
 * hard timeout and a byte cap. Nothing here takes a shell string from the model:
 * `rea_doctor` records whether a tool exists, it does not run analysis.
 *
 * @module dsh-rea/exec
 */
import { execFile } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

/**
 * Run a command and resolve with its outcome. Never rejects for a non-zero exit:
 * "not installed" is a normal readiness answer, not an exception.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ ok: boolean, exitCode: number | null, stdout: string, stderr: string, error?: string, ms: number }>}
 */
export function run(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000;
  const maxBytes = options.maxBytes ?? 8 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: maxBytes, shell: false },
      (error, stdout, stderr) => {
        const ms = Date.now() - started;
        const out = String(stdout ?? '').slice(0, maxBytes).trim();
        const err = String(stderr ?? '').slice(0, 2048).trim();
        if (error === null) {
          resolve({ ok: true, exitCode: 0, stdout: out, stderr: err, ms });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        const reason =
          error.code === 'ENOENT' ? 'not found on PATH' : error.killed === true ? `timed out after ${timeoutMs}ms` : error.message;
        resolve({ ok: false, exitCode: code, stdout: out, stderr: err, error: reason, ms });
      },
    );
  });
}

/**
 * Locate an executable without executing it (`where` on Windows, `which`
 * elsewhere). Returns the first absolute path, or undefined.
 *
 * @param {string} name
 * @returns {Promise<string | undefined>}
 */
export async function findOnPath(name) {
  const result = IS_WIN ? await run('where', [name], { timeoutMs: 4000 }) : await run('which', [name], { timeoutMs: 4000 });
  if (!result.ok) return undefined;
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
  return first === undefined ? undefined : first;
}

/**
 * Resolve the first existing path among candidates (checked with the caller's
 * `exists` predicate so this module stays fs-free and testable).
 *
 * @param {string[]} candidates
 * @param {(path: string) => Promise<boolean>} exists
 * @returns {Promise<string | undefined>}
 */
export async function firstExisting(candidates, exists) {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && (await exists(candidate))) return candidate;
  }
  return undefined;
}

export { IS_WIN };
