import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkStore } from '../service/store.mjs'

/**
 * A store in memory with a clock that moves a minute per reading, so
 * timestamps are predictable and distinct.
 */
export function memoryStore() {
  let tick = Date.parse('2026-10-07T12:00:00.000Z')
  return new WorkStore(':memory:', { now: () => new Date((tick += 60_000)) })
}

/**
 * The TideCast portfolio from the design: Desktop and Reporting API, with
 * folders that have spaces in them.
 *
 * @param {WorkStore} store
 * @param {string} root
 */
export function seedTideCast(store, root = join(tmpdir(), 'work tests', 'repos')) {
  const portfolio = store.createPortfolio({ key: 'TC', name: 'TideCast' })
  const desktop = store.createProject({ portfolio: 'TC', name: 'Desktop', folders: [join(root, 'tide cast')] })
  const api = store.createProject({ portfolio: 'TC', name: 'Reporting API', folders: [join(root, 'tide cast', 'reporting api')] })
  return { portfolio, desktop, api, root }
}

/** A temporary directory, removed by the returned function. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'work store '))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * The real service process on a database file, as Helm starts it: a loopback
 * port and a token in its environment. Resolves once it says it is serving,
 * with the line it said it on.
 *
 * @param {string} file what HELM_TRACKR_DB names
 * @param {{ token?: string, entry?: string }} [options] entry is the script, relative to the plugin's folder
 */
export async function startService(file, { token = 'test-token', entry = 'service/main.mjs' } = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../${entry}`, import.meta.url))], {
    env: { ...process.env, HELM_SERVICE_PORT: String(port), HELM_SERVICE_TOKEN: token, HELM_TRACKR_DB: file },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const stdout = /** @type {import('node:stream').Readable} */ (child.stdout)
  let output = ''
  while (!output.includes('serving')) {
    const [chunk] = await once(stdout, 'data')
    output += String(chunk)
  }
  return {
    port,
    token,
    child,
    /** What the service printed as it started. */
    output,
    /** Ends the process, if it is still running. */
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    }
  }
}

/** @returns {Promise<number>} */
export async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  server.close()
  await once(server, 'close')
  return address.port
}
