/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * The background module: answers the tools the manifest offers Claude Code
 * sessions, and keeps the rail badge at the number of tasks in progress.
 *
 * The host runs it in an isolate of its own, with `floti` and
 * BroadcastChannel and no window: no DOM, no localStorage and no tabs. It
 * imports only Trackr's own files, by relative path.
 *
 * The tools themselves run in the service, next to the database; this module
 * hands each call over with the session that made it and returns the
 * service's text as the reply. After a call that writes, it tells the pages
 * the data changed and recounts the badge.
 */

import { announceChange, listen, rpc } from './shared/work.js'

/**
 * The pages and this module are checked as one program, where the global
 * `floti` is a page's bridge. Here it is the background's, which has no
 * window to open anything in.
 */
const host = /** @type {import('@coledtaylor/helm-plugin-sdk').FlotiBackground} */ (/** @type {unknown} */ (floti))

const TOOLS = ['find', 'get', 'create', 'update']
const WRITES = new Set(['create', 'update'])

// Registered as the module starts, before anything it awaits: a session can
// call as soon as the plugin is up.
for (const name of TOOLS) {
  host.tools.handle(name, async (args, { session, signal }) => {
    const response = await host.fetch('service:/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, args, session: { id: session.id, name: session.name, cwd: session.cwd } }),
      signal
    })
    let body = null
    try {
      body = await response.json()
    } catch {
      // Reported below with the status.
    }
    if (!response.ok || typeof body?.text !== 'string') {
      throw new Error(body?.error?.message ?? `The Trackr service answered ${response.status}.`)
    }
    if (WRITES.has(name)) {
      announceChange()
      void updateBadge()
    }
    return body.text
  })
}

let badgeSeq = 0

/** The badge is the number of tasks in an active status, across every portfolio. */
async function updateBadge() {
  const seq = ++badgeSeq
  try {
    const { total } = /** @type {{ total: number }} */ (await rpc('findItems', { groups: ['active'], kind: 'task', limit: 1 }))
    if (seq === badgeSeq) await host.badge.set(total)
  } catch (error) {
    console.error('trackr: could not count the tasks in progress', error)
  }
}

listen((message) => {
  if (message.type === 'changed') void updateBadge()
})

void updateBadge()
