import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RPC_METHODS, dispatch } from '../service/rpc.mjs'
import { MIGRATIONS } from '../service/schema.mjs'
import { WorkStore } from '../service/store.mjs'
import { memoryStore, tempDir } from './helpers.mjs'

describe('rpc', () => {
  test('every listed method exists on the store', () => {
    const store = memoryStore()
    for (const method of RPC_METHODS) assert.equal(typeof (/** @type {any} */ (store)[method]), 'function', method)
  })

  test('maps store errors to statuses and refuses unlisted methods', () => {
    const store = memoryStore()
    assert.deepEqual(dispatch(store, { method: 'getItem', args: ['TC-1'] }), {
      status: 404,
      body: { error: { code: 'not-found', message: 'TC-1 does not exist.' } }
    })
    assert.equal(dispatch(store, { method: 'createPortfolio', args: [{ key: '1', name: 'x' }] }).status, 400)
    store.createPortfolio({ key: 'TC', name: 'TideCast' })
    assert.equal(dispatch(store, { method: 'createPortfolio', args: [{ key: 'TC', name: 'x' }] }).status, 409)
    for (const method of ['close', 'transaction', 'run', 'constructor', '__proto__']) {
      assert.equal(dispatch(store, { method, args: [] }).status, 400, method)
    }
    assert.equal(dispatch(store, { method: 'listPortfolios', args: 'no' }).status, 400)
    assert.equal(dispatch(store, null).status, 400)
  })
})

describe('the service process', () => {
  const token = 'test-token'
  const { dir, remove } = tempDir()
  const file = join(dir, 'data dir', 'work.db')
  /** @type {import('node:child_process').ChildProcess} */
  let child
  let port = 0

  before(async () => {
    port = await freePort()
    child = spawn(process.execPath, [fileURLToPath(new URL('../service/main.mjs', import.meta.url))], {
      env: { ...process.env, HELM_SERVICE_PORT: String(port), HELM_SERVICE_TOKEN: token, HELM_TRACKR_DB: file },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    const stdout = /** @type {import('node:stream').Readable} */ (child.stdout)
    let output = ''
    while (!output.includes('serving')) {
      const [chunk] = await once(stdout, 'data')
      output += String(chunk)
    }
  })

  after(async () => {
    if (child.exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    remove()
  })

  /**
   * @param {string} path
   * @param {RequestInit} [init]
   * @param {string} [withToken]
   */
  const call = (path, init = {}, withToken = token) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...init.headers, 'helm-service-token': withToken } })

  /**
   * @param {string} method
   * @param {unknown[]} args
   */
  const rpc = async (method, args) => {
    const response = await call('/rpc', { method: 'POST', body: JSON.stringify({ method, args }) })
    return { status: response.status, body: await response.json() }
  }

  test('refuses a request without the token', async () => {
    assert.equal((await call('/health', {}, 'wrong')).status, 401)
    assert.equal((await call('/rpc', { method: 'POST', body: '{}' }, '')).status, 401)
  })

  test('answers health with the schema version', async () => {
    assert.deepEqual(await (await call('/health')).json(), { ok: true, schema: MIGRATIONS.length })
  })

  test('creates and reads through rpc, into the file it was given', async () => {
    assert.equal((await rpc('createPortfolio', [{ key: 'TC', name: 'TideCast' }])).status, 200)
    assert.equal((await rpc('createProject', [{ portfolio: 'TC', name: 'Desktop' }])).status, 200)
    const created = await rpc('createItem', [{ project: 'Desktop', title: 'Over the wire' }])
    assert.equal(created.body.result.id, 'TC-1')
    const missing = await rpc('getItem', ['TC-9'])
    assert.deepEqual(missing, { status: 404, body: { error: { code: 'not-found', message: 'TC-9 does not exist.' } } })

    // Another process reading the same file sees the write.
    const reader = new WorkStore(file)
    assert.equal(reader.getItem('TC-1').title, 'Over the wire')
    reader.close()
  })

  test('says what is wrong with a bad request', async () => {
    const response = await call('/rpc', { method: 'POST', body: 'not json' })
    assert.equal(response.status, 400)
    assert.equal((await call('/rpc')).status, 405)
    assert.equal((await call('/elsewhere')).status, 404)
  })
})

/** @returns {Promise<number>} */
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  server.close()
  await once(server, 'close')
  return address.port
}
