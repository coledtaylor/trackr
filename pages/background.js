/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * The background page: answers the tools the manifest offers Claude Code
 * sessions, and keeps the rail badge at the number of tasks in progress.
 *
 * The tools themselves run in the service, next to the database; this page
 * hands each call over with the session that made it and returns the
 * service's text as the reply. After a call that writes, it tells the other
 * pages the data changed and recounts the badge.
 */

import { announceChange, listen, rpc } from './shared/work.js'

const TOOLS = ['find', 'get', 'create', 'update']
const WRITES = new Set(['create', 'update'])

// Registered as the page starts, before anything it awaits: a session can
// call as soon as the page is up.
for (const name of TOOLS) {
  helm.tools.handle(name, async (args, { session, signal }) => {
    const response = await helm.fetch('service:/tool', {
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
    if (seq === badgeSeq) await helm.badge.set(total)
  } catch (error) {
    console.error('trackr: could not count the tasks in progress', error)
  }
}

listen((message) => {
  if (message.type === 'changed') void updateBadge()
})

void updateBadge()
