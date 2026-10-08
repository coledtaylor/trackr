/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * The view tab: a portfolio, its workflow, a project or an item, by the tab's parameters
 * `{ kind, uid }`. Each kind is drawn by its module in `views/`; this page
 * loads it, shows a failure in its place, tells the panel what is on screen,
 * and reads again when another page says the data changed.
 */

import { el, fill } from './shared/dom.js'
import { listen, post } from './shared/work.js'
import { createItemView } from './views/item.js'
import { createPortfolioView } from './views/portfolio.js'
import { createProjectView } from './views/project.js'
import { createWorkflowView } from './views/workflow.js'

/**
 * @typedef {import('./shared/work.js').ViewKind} Kind
 * @typedef {import('./views/parts.js').View} View
 */

const root = /** @type {HTMLElement} */ (document.getElementById('view'))
const tab = crypto.randomUUID()
const kind = /** @type {Kind} */ (String(helm.context.params.kind))
const uid = Number(helm.context.params.uid)

/** Where the shown thing sits, for the panel's default project. */
let place = { portfolio: /** @type {number | undefined} */ (undefined), project: /** @type {number | undefined} */ (undefined) }

const host = {
  /** @param {{ portfolio?: number, project?: number }} where */
  setPlace(where) {
    place = { portfolio: where.portfolio, project: where.project }
  },
  reload() {
    void load()
  }
}

const CREATE = { portfolio: createPortfolioView, workflow: createWorkflowView, project: createProjectView, item: createItemView }

/** What the tab says when the thing it shows was deleted. */
const GONE = { portfolio: 'This portfolio no longer exists.', workflow: 'This portfolio no longer exists.', project: 'This project no longer exists.', item: 'This item no longer exists.' }

/** @type {View | null} */
const view = Number.isInteger(uid) && uid > 0 && Object.hasOwn(CREATE, kind) ? CREATE[kind](root, uid, host) : null

let loadSeq = 0

async function load() {
  const seq = ++loadSeq
  const isCurrent = () => seq === loadSeq
  try {
    if (view === null) throw new Error('This tab does not name a portfolio, project or item.')
    await view.load(isCurrent)
  } catch (error) {
    if (!isCurrent()) return
    console.error('trackr: the view failed to load', error)
    const message = error instanceof Error ? error.message : String(error)
    const gone = /** @type {{ code?: string }} */ (error).code === 'not-found'
    root.className = 'view view-state'
    fill(root, [
      el('div', { class: 'state', attrs: { role: 'alert' } }, [
        el('p', { class: 'quiet', text: gone ? GONE[kind] : message }),
        gone ? null : el('button', { class: 'helm-button', text: 'Try again', attrs: { type: 'button' }, on: { click: () => void load() } })
      ])
    ])
    if (gone) helm.surface.setTitle('Gone')
  }
  announce()
}

function announce() {
  post({ type: 'view', tab, kind, uid, portfolio: place.portfolio, project: place.project, visible: helm.visible, at: Date.now() })
}

listen((message) => {
  if (message.type === 'changed') void load()
  else if (message.type === 'who') announce()
  else if (message.type === 'focus') view?.focus?.()
})

helm.on('visibility', (visible) => {
  announce()
  if (visible) void load()
})

window.addEventListener('pagehide', () => {
  post({ type: 'view', tab, kind, uid, visible: false, at: Date.now() })
})

void load()
