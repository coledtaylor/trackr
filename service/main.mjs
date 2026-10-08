import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dispatch, dispatchTool } from './rpc.mjs'
import { WorkStore } from './store.mjs'

/**
 * The plugin's service: owns the Trackr database and answers the plugin's
 * pages over loopback. Helm starts it, gives it a port and a token, and stops
 * it with the plugin.
 *
 * - `GET /health` answers `{ ok, schema }`.
 * - `POST /rpc` takes `{ method, args }` and answers `{ result }`: the pages'
 *   way to the store.
 * - `POST /tool` takes `{ name, args, session }` and answers `{ text }`: a
 *   session's tool call, relayed by the background page.
 *
 * A refused call answers `{ error: { code, message } }` with 400, 404 or 409.
 *
 * Every request without Helm's token gets 401 before anything else.
 */

const MAX_BODY = 16 * 1024 * 1024

/**
 * Where the database lives unless `HELM_TRACKR_DB` says otherwise: beside
 * Helm's config, outside the plugin folder, so it survives a reinstall and the
 * installed and dev Helm share it.
 */
export function defaultDatabasePath() {
  return join(homedir(), '.config', 'helm', 'data', 'trackr', 'trackr.db')
}

/**
 * @param {{ store: WorkStore, token: string }} options
 */
export function createWorkServer({ store, token }) {
  if (!token) throw new Error('The service needs a token.')
  return createServer((request, response) => {
    /**
     * @param {number} status
     * @param {unknown} [body]
     */
    const reply = (status, body) => {
      if (body === undefined) {
        response.writeHead(status).end()
        return
      }
      const json = JSON.stringify(body)
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(json)
    }

    if (request.headers['helm-service-token'] !== token) return reply(401)

    const url = new URL(request.url ?? '/', 'http://service')
    if (url.pathname === '/health') {
      if (request.method !== 'GET') return reply(405)
      return reply(200, { ok: true, schema: store.schemaVersion })
    }
    const handler = url.pathname === '/rpc' ? dispatch : url.pathname === '/tool' ? dispatchTool : null
    if (handler === null) return reply(404)
    if (request.method !== 'POST') return reply(405)

    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let refused = false
    request.on('data', (/** @type {Buffer} */ chunk) => {
      if (refused) return
      size += chunk.length
      if (size > MAX_BODY) {
        refused = true
        reply(413, { error: { code: 'invalid', message: 'The request is too large.' } })
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (refused) return
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return reply(400, { error: { code: 'invalid', message: 'The request is not JSON.' } })
      }
      try {
        const { status, body } = handler(store, parsed)
        reply(status, body)
      } catch (error) {
        console.error('trackr: call failed', error)
        reply(500, { error: { code: 'internal', message: 'The work store failed. The plugin log in Settings has the detail.' } })
      }
    })
  })
}

function main() {
  const port = Number(process.env.HELM_SERVICE_PORT)
  const token = process.env.HELM_SERVICE_TOKEN ?? ''
  if (!Number.isInteger(port) || port <= 0 || token === '') {
    console.error('trackr: HELM_SERVICE_PORT and HELM_SERVICE_TOKEN are required. Helm sets them.')
    process.exit(1)
  }
  const file = process.env.HELM_TRACKR_DB || defaultDatabasePath()
  const store = new WorkStore(file)
  const server = createWorkServer({ store, token })
  server.listen(port, '127.0.0.1', () => console.log(`trackr: serving ${file} (schema ${store.schemaVersion})`))
  const stop = () => {
    server.close()
    store.close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
