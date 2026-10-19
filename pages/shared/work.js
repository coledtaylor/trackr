/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * The pages' way to the Trackr service and to each other.
 *
 * - `rpc` calls one store method through the service.
 * - The `trackr` BroadcastChannel tells every page of the plugin (panel, tabs,
 *   background) that the data changed, and lets the panel ask which tabs are
 *   on screen.
 * - `open*` open the plugin's view tab for a portfolio, its workflow, a
 *   project or an item. A tab is keyed by uid, so it survives a rename and a
 *   portfolio key change. Opened as a preview, as Helm opens a file on a
 *   click, the next preview takes its place; `opens` gives a link that
 *   click, and a double click that opens to stay.
 */

export class ServiceError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

/**
 * @template T
 * @param {string} method a name from the service's RPC_METHODS
 * @param {...unknown} args
 * @returns {Promise<T>}
 */
export async function rpc(method, ...args) {
  let response
  try {
    response = await helm.fetch('service:/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args })
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ServiceError(`The Trackr service could not be reached: ${reason}`, 'unavailable')
  }
  /** @type {any} */
  let body = null
  try {
    body = await response.json()
  } catch {
    // Reported below with the status.
  }
  if (!response.ok || body === null || !('result' in body)) {
    throw new ServiceError(body?.error?.message ?? `The Trackr service answered ${response.status}.`, body?.error?.code ?? 'internal')
  }
  return body.result
}

/**
 * @typedef {{ type: 'changed' }
 *   | { type: 'who' }
 *   | { type: 'focus' }
 *   | { type: 'view', tab: string, kind: ViewKind, uid: number,
 *       portfolio?: number, project?: number, visible: boolean, at: number }} Message
 * @typedef {'portfolio' | 'workflow' | 'project' | 'item'} ViewKind
 */

const channel = new BroadcastChannel('trackr')

/** @param {Message} message */
export function post(message) {
  channel.postMessage(message)
}

/**
 * @param {(message: Message) => void} listener
 * @returns {() => void}
 */
export function listen(listener) {
  /** @param {MessageEvent} event */
  const handler = (event) => {
    if (event.data && typeof event.data.type === 'string') listener(event.data)
  }
  channel.addEventListener('message', handler)
  return () => channel.removeEventListener('message', handler)
}

/**
 * Tells the other pages to read again. The sender refreshes itself. A tab
 * that changed something stays, as a file being edited does.
 */
export function announceChange() {
  keepTab()
  post({ type: 'changed' })
}

/**
 * Keeps this page's tab when it was opened as a preview, so the next preview
 * does not replace it. No effect in a tab that stays, or outside a tab (the
 * panel, the background page). Helm before 2.3.2 has no previews, nor `keep`.
 */
export function keepTab() {
  if (typeof helm.surface.keep === 'function') helm.surface.keep()
}

/**
 * How a view opens: `preview` as the preview the next one replaces, else to
 * stay.
 *
 * @typedef {{ preview?: boolean }} OpenHow
 * @typedef {(how: OpenHow) => unknown} Opener
 */

/**
 * The handlers that open a view the way Helm opens a file: a click previews
 * it, a double click opens it to stay. An element's `on`.
 *
 * @param {Opener} open
 */
export function opens(open) {
  return {
    click: () => void open({ preview: true }),
    dblclick: () => void open({})
  }
}

/**
 * Opens one view tab. The page it is opened from stays when that is a tab: a
 * board or a task the user follows a link from is where they are working, and
 * must not be the preview the link replaces.
 *
 * @param {{ kind: ViewKind, uid: number }} params
 * @param {string} title
 * @param {OpenHow} how
 */
function openView(params, title, how) {
  keepTab()
  return helm.tabs.open('view', params, { title, preview: how.preview === true })
}

/**
 * @param {{ uid: number, key: string, name: string }} portfolio
 * @param {OpenHow} [how]
 */
export function openPortfolio(portfolio, how = {}) {
  return openView({ kind: 'portfolio', uid: portfolio.uid }, portfolio.name, how)
}

const FOCUS = 'trackr.workflow.focus'
const FOCUS_MS = 15_000

/**
 * A project editor a workflow page is asked to open: an existing project's
 * by uid, or `'new'` for a new project's.
 *
 * @typedef {number | 'new'} ProjectFocus
 */

/**
 * A portfolio's workflow: its statuses, priorities, projects and key. With
 * `project`, that project's editor opens on it, or the new project editor
 * for `'new'`: the page takes the request when it loads, or at once if it is
 * already open.
 *
 * @param {{ uid: number, name: string }} portfolio
 * @param {ProjectFocus} [project]
 * @param {OpenHow} [how]
 */
export function openWorkflow(portfolio, project, how = {}) {
  if (project !== undefined) {
    try {
      localStorage.setItem(FOCUS, JSON.stringify({ portfolio: portfolio.uid, project, at: Date.now() }))
    } catch {
      // The tab still opens, without the editor.
    }
    post({ type: 'focus' })
  }
  return openView({ kind: 'workflow', uid: portfolio.uid }, `${portfolio.name} workflow`, how)
}

/**
 * The project editor a workflow page was asked to open, once: taking it
 * clears it. Null when there is none for this portfolio, or it is stale.
 *
 * @param {number} portfolio
 * @returns {ProjectFocus | null}
 */
export function takeFocus(portfolio) {
  try {
    const raw = JSON.parse(localStorage.getItem(FOCUS) ?? 'null')
    if (raw === null || raw.portfolio !== portfolio) return null
    localStorage.removeItem(FOCUS)
    if (Date.now() - raw.at >= FOCUS_MS) return null
    return typeof raw.project === 'number' || raw.project === 'new' ? raw.project : null
  } catch {
    return null
  }
}

/**
 * @param {{ uid: number, name: string }} project
 * @param {OpenHow} [how]
 */
export function openProject(project, how = {}) {
  return openView({ kind: 'project', uid: project.uid }, project.name, how)
}

/**
 * @param {{ uid: number, id: string, title: string }} item
 * @param {OpenHow} [how]
 */
export function openItem(item, how = {}) {
  return openView({ kind: 'item', uid: item.uid }, itemTitle(item), how)
}

/**
 * A tab's title for an item: the ID and as much of the title as reads in a tab.
 *
 * @param {{ id: string, title: string }} item
 */
export function itemTitle(item) {
  const max = 32
  const title = item.title.length > max ? `${item.title.slice(0, max - 1).trimEnd()}…` : item.title
  return `${item.id} ${title}`
}
