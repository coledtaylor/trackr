import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { WorkStore } from '../service/store.mjs'
import { startService, tempDir } from './helpers.mjs'

/**
 * Trackr's background module as the host runs it at plugin API version 2: a
 * module with `floti` and BroadcastChannel and no window. Here `floti` is a
 * stand-in whose `fetch` reaches a real service process on a trackr.db in the
 * test's own folder, whose `tools.handle` keeps the handlers, and whose
 * `badge.set` records each count.
 */

/**
 * @typedef {(args: Record<string, unknown>, call: { session: { id: string, name: string, cwd: string }, signal: AbortSignal }) => Promise<unknown>} Handler
 */

/**
 * A stand-in for the host's `floti` in a background module. Every call is
 * recorded by name. The calls that need a window reject as the host's do.
 *
 * @param {{ port: number, token: string }} service
 * @param {typeof fetch} send the real fetch, which the module itself never has
 */
function standInFloti(service, send) {
  /** @type {Map<string, Handler>} */
  const handlers = new Map()
  /** @type {(number | null)[]} */
  const badges = []
  /** @type {string[]} */
  const calls = []
  const events = new EventEmitter()

  /** @param {string} name */
  const needsClient = (name) => () => {
    calls.push(name)
    return Promise.reject(Object.assign(new Error(`${name}: a background script has no window`), { code: 'unavailable' }))
  }

  const floti = Object.freeze({
    apiVersion: 2,
    context: Object.freeze({ plugin: 'trackr', surface: 'background', name: 'background', params: Object.freeze({}) }),
    visible: false,
    /**
     * @param {string | URL | Request} input
     * @param {RequestInit} [init]
     */
    fetch(input, init = {}) {
      const url = String(input)
      calls.push(`fetch ${url}`)
      if (!url.startsWith('service:/')) return Promise.reject(new Error(`${url} is not in the manifest's network`))
      const headers = new Headers(init.headers)
      headers.set('helm-service-token', service.token)
      return send(`http://127.0.0.1:${service.port}${url.slice('service:'.length)}`, { ...init, headers })
    },
    exec: needsClient('exec'),
    open: needsClient('open'),
    tabs: Object.freeze({ open: needsClient('tabs.open') }),
    surface: Object.freeze({
      setTitle: () => void calls.push('surface.setTitle'),
      keep: () => void calls.push('surface.keep')
    }),
    status: Object.freeze({ set: async () => void calls.push('status.set') }),
    badge: Object.freeze({
      /** @param {number | null} count */
      set: async (count) => {
        calls.push('badge.set')
        badges.push(count)
        events.emit('badge')
      }
    }),
    settings: Object.freeze({ get: async () => (calls.push('settings.get'), {}) }),
    secrets: Object.freeze({ state: async () => (calls.push('secrets.state'), 'missing'), request: needsClient('secrets.request') }),
    sessions: Object.freeze({ start: needsClient('sessions.start'), list: needsClient('sessions.list') }),
    tools: Object.freeze({
      /**
       * @param {string} name
       * @param {Handler} handler
       */
      handle(name, handler) {
        calls.push(`tools.handle ${name}`)
        handlers.set(name, handler)
        return () => handlers.delete(name)
      }
    }),
    on: () => {
      calls.push('on')
      return () => {}
    }
  })

  /**
   * Resolves once the badge has been set to `count`, on the badge being set:
   * polled at each set, never on a timer.
   *
   * @param {number} count
   * @param {number} [from] how many sets to look past, so an earlier count does not answer
   */
  async function badgeBecomes(count, from = 0) {
    while (!badges.slice(from).includes(count)) await once(events, 'badge')
  }

  return { floti, handlers, badges, calls, badgeBecomes }
}

/**
 * What the module runs with besides `floti`: BroadcastChannel as the isolate
 * has it, and no localStorage or global fetch, which the isolate does not
 * have either. Every channel it opens is closed by `restore`, so nothing keeps
 * the test process running.
 */
function isolateGlobals() {
  const realFetch = globalThis.fetch
  const RealChannel = globalThis.BroadcastChannel
  /** @type {BroadcastChannel[]} */
  const channels = []
  class TrackedChannel extends RealChannel {
    /** @param {string} name */
    constructor(name) {
      super(name)
      channels.push(this)
    }
  }
  const missing = (/** @type {string} */ name) => ({
    configurable: true,
    get() {
      throw new ReferenceError(`${name} is not defined in a background module`)
    }
  })
  const saved = ['fetch', 'localStorage', 'BroadcastChannel', 'floti'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  Object.defineProperty(globalThis, 'fetch', missing('fetch'))
  Object.defineProperty(globalThis, 'localStorage', missing('localStorage'))
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, writable: true, value: TrackedChannel })
  return {
    realFetch,
    RealChannel,
    /** @param {unknown} floti */
    install(floti) {
      Object.defineProperty(globalThis, 'floti', { configurable: true, value: floti })
    },
    restore() {
      for (const channel of channels) channel.close()
      for (const [name, descriptor] of saved) {
        const key = /** @type {string} */ (name)
        if (descriptor) Object.defineProperty(globalThis, key, /** @type {PropertyDescriptor} */ (descriptor))
        else delete (/** @type {any} */ (globalThis))[key]
      }
    }
  }
}

describe('the background module at apiVersion 2', () => {
  const { dir, remove } = tempDir()
  const folder = join(dir, 'tide cast')
  const file = join(dir, 'data dir', 'trackr.db')
  const session = { id: 'sess-1', name: 'saved views', cwd: folder }
  /** @type {Awaited<ReturnType<typeof startService>>} */
  let service
  /** @type {ReturnType<typeof isolateGlobals>} */
  let globals
  /** @type {ReturnType<typeof standInFloti>} */
  let host
  /** A page of the plugin, listening on and posting to the `trackr` channel. */
  /** @type {BroadcastChannel} */
  let page
  /** @type {unknown[]} */
  const heard = []

  before(async () => {
    mkdirSync(folder, { recursive: true })
    const seed = new WorkStore(file)
    seed.createPortfolio({ key: 'TC', name: 'TideCast' })
    seed.createProject({ portfolio: 'TC', name: 'Desktop', folders: [folder] })
    seed.close()
    service = await startService(file)

    globals = isolateGlobals()
    host = standInFloti(service, globals.realFetch)
    globals.install(host.floti)
    page = new globals.RealChannel('trackr')
    page.addEventListener('message', (event) => heard.push(/** @type {MessageEvent} */ (event).data))
    // A path the type check does not follow: the module is a page's file, checked with the pages.
    await import(pathToFileURL(join(import.meta.dirname, '..', 'pages', 'background.js')).href)
    await host.badgeBecomes(0)
  })

  after(async () => {
    page?.close()
    globals?.restore()
    await service?.stop()
    remove()
  })

  /**
   * A tool call as the host makes it.
   *
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  const call = (name, args) => {
    const handler = host.handlers.get(name)
    assert.ok(handler, `no handler for ${name}`)
    return handler(args, { session, signal: new AbortController().signal })
  }

  /**
   * The same call made to the service directly, as the version 1 background
   * page relayed it: what the session would have read.
   *
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  const direct = async (name, args) => {
    const response = await globals.realFetch(`http://127.0.0.1:${service.port}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'helm-service-token': service.token },
      body: JSON.stringify({ name, args, session })
    })
    return /** @type {{ text: string }} */ (await response.json()).text
  }

  test('registers find, get, create and update as it loads, and asks nothing of a window', () => {
    assert.deepEqual([...host.handlers.keys()], ['find', 'get', 'create', 'update'])
    const window = host.calls.filter((name) => /^(open|tabs\.|surface\.|sessions\.|secrets\.request)/.test(name))
    assert.deepEqual(window, [])
    assert.deepEqual(host.badges, [0])
  })

  test('create answers through the service, tells the pages, and the badge counts the task in progress', async () => {
    const before = host.badges.length
    const text = await call('create', { items: [{ title: 'Over the wire', status: 'In progress' }] })
    assert.equal(typeof text, 'string')
    assert.match(/** @type {string} */ (text), /TC-1/)
    await host.badgeBecomes(1, before)
    assert.ok(heard.some((message) => /** @type {any} */ (message)?.type === 'changed'))
  })

  test('get and find answer what the service answers', async () => {
    const got = await call('get', { ids: ['TC-1'] })
    assert.equal(got, await direct('get', { ids: ['TC-1'] }))
    assert.match(/** @type {string} */ (got), /Over the wire/)

    const found = await call('find', {})
    assert.equal(found, await direct('find', {}))
    assert.match(/** @type {string} */ (found), /TC-1 In progress/)
  })

  test('update answers through the service and the badge follows', async () => {
    const before = host.badges.length
    const text = await call('update', { items: [{ id: 'TC-1', status: 'Done' }] })
    assert.match(/** @type {string} */ (text), /^TC-1 In progress -> Done/)
    await host.badgeBecomes(0, before)
    assert.match(await direct('get', { ids: ['TC-1'] }), /Done/)
  })

  test('a refused call fails with the service message', async () => {
    await assert.rejects(call('get', { ids: ['TC-9'] }), { message: 'TC-9 does not exist.' })
  })

  test('a change a page announces recounts the badge', async () => {
    await direct('create', { items: [{ title: 'Made in a tab', status: 'In progress' }] })
    const before = host.badges.length
    page.postMessage({ type: 'changed' })
    await host.badgeBecomes(1, before)
  })

  test('reaches the service only through floti.fetch', () => {
    const fetched = host.calls.filter((name) => name.startsWith('fetch ')).map((name) => name.slice('fetch '.length))
    assert.ok(fetched.length > 0)
    assert.ok(fetched.every((url) => url === 'service:/tool' || url === 'service:/rpc'), fetched.join(', '))
  })
})
