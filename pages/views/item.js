/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * An epic or a task: reads what the view needs and draws `epic.js` or
 * `task.js`. Drawing again keeps an open editor's field, its focus and its
 * caret, so a session writing while the person types loses nothing.
 */

import { el, fill, redraw } from '../shared/dom.js'
import { itemTitle, openProject, rpc } from '../shared/work.js'
import { createEditing } from './edit.js'
import { epicParts } from './epic.js'
import { taskParts, taskState } from './task.js'

/**
 * @typedef {import('../shared/types.js').ItemOverview} ItemOverview
 * @typedef {import('./parts.js').Host} Host
 * @typedef {import('./parts.js').View} View
 */

/**
 * @param {HTMLElement} root
 * @param {number} uid
 * @param {Host} host
 * @returns {View}
 */
export function createItemView(root, uid, host) {
  /** @type {ItemOverview | null} */
  let data = null
  /** @type {import('../shared/types.js').Item | null} set when this page deleted it */
  let deleted = null
  const editing = createEditing(
    uid,
    {
      reload: () => host.reload(),
      deleted: (item) => {
        deleted = item
      }
    },
    draw
  )
  const state = taskState()

  function draw() {
    if (data === null) return
    root.className = `view-item it it-is-${data.item.kind}`
    const shown = data
    redraw(root, () => (shown.item.kind === 'epic' ? epicParts(shown, editing) : taskParts(shown, editing, state, draw)))
  }

  /** @param {import('../shared/types.js').Item} item */
  function drawDeleted(item) {
    data = null
    root.className = 'view view-state'
    fill(root, [
      el('div', { class: 'state', attrs: { role: 'status' } }, [
        el('p', { class: 'quiet', text: `${item.id} ${item.title} was deleted.` }),
        el('button', { class: 'helm-button', text: `Open ${item.project.name}`, attrs: { type: 'button' }, on: { click: () => void openProject(item.project) } })
      ])
    ])
    helm.surface.setTitle(`${item.id} deleted`)
  }

  return {
    async load(isCurrent) {
      /** @type {ItemOverview} */
      let next
      try {
        next = /** @type {ItemOverview} */ (await rpc('itemOverview', uid))
      } catch (error) {
        // Deleted from here: say so, and offer where it was.
        if (deleted === null || /** @type {{ code?: string }} */ (error).code !== 'not-found') throw error
        if (isCurrent()) drawDeleted(deleted)
        return
      }
      if (!isCurrent()) return
      data = next
      host.setPlace({ portfolio: next.portfolio.uid, project: next.item.project.uid })
      helm.surface.setTitle(itemTitle(next.item))
      draw()
    }
  }
}
