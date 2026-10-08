/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * Whether the session on a task still runs, from Helm's session list.
 *
 * An element that shows a session is marked with `markSession`. The page reads
 * Helm's list once, the first time it marks one, and repaints every marked
 * element in place when the `sessions` event says the list changed: a session
 * going from working to idle repaints a chip and never reloads a view.
 */

import { liveState, sessionPhrase } from './logic.js'

/** @typedef {import('./logic.js').ListedSession} ListedSession */

/** Null until Helm's list is read, and when it cannot be. */
/** @type {ListedSession[] | null} */
let sessions = null
let watching = false

function watch() {
  if (watching) return
  watching = true
  let heard = false
  helm.on('sessions', (list) => {
    heard = true
    sessions = list
    paintAll()
  })
  helm.sessions.list().then(
    (list) => {
      // An event that arrived first carries a newer list.
      if (heard) return
      sessions = list
      paintAll()
    },
    (error) => console.warn('trackr: Helm did not list its sessions', error)
  )
}

/**
 * Marks an element as showing a session and paints it: `is-stopped` once the
 * session no longer runs, the state in words in a `[data-session-state]`
 * inside it, and a title naming the session and its state.
 *
 * @template {HTMLElement} T
 * @param {T} node
 * @param {{ id: string, name: string }} claim
 * @param {string} lastActive when it last wrote, or ''
 * @returns {T}
 */
export function markSession(node, claim, lastActive) {
  node.dataset.session = claim.id
  node.dataset.sessionName = claim.name
  node.dataset.sessionLast = lastActive
  paint(node)
  watch()
  return node
}

function paintAll() {
  for (const node of document.querySelectorAll('[data-session]')) paint(/** @type {HTMLElement} */ (node))
}

/** @param {HTMLElement} node */
function paint(node) {
  const live = liveState(node.dataset.session ?? '', sessions)
  const last = node.dataset.sessionLast ?? ''
  const phrase = sessionPhrase(live, last)
  const stopped = live !== null && !live.running
  node.classList.toggle('is-stopped', stopped)
  node.title = [node.dataset.sessionName, phrase, stopped && last ? `last active ${last}` : ''].filter(Boolean).join(', ')
  const words = node.querySelector('[data-session-state]')
  if (words) words.textContent = phrase ? ` · ${phrase}` : ''
}
