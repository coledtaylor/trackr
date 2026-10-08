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
 *   portfolio key change.
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

/** Tells the other pages to read again. The sender refreshes itself. */
export function announceChange() {
  post({ type: 'changed' })
}

/** @param {{ uid: number, key: string, name: string }} portfolio */
export function openPortfolio(portfolio) {
  return helm.tabs.open('view', { kind: 'portfolio', uid: portfolio.uid }, { title: portfolio.name })
}

const FOCUS = 'trackr.workflow.focus'
const FOCUS_MS = 15_000

/**
 * A portfolio's workflow: its statuses, priorities, projects and key. With
 * `project`, that project's editor opens on it: the page takes the request
 * when it loads, or at once if it is already open.
 *
 * @param {{ uid: number, name: string }} portfolio
 * @param {number} [project]
 */
export function openWorkflow(portfolio, project) {
  if (project !== undefined) {
    try {
      localStorage.setItem(FOCUS, JSON.stringify({ portfolio: portfolio.uid, project, at: Date.now() }))
    } catch {
      // The tab still opens, without the editor.
    }
    post({ type: 'focus' })
  }
  return helm.tabs.open('view', { kind: 'workflow', uid: portfolio.uid }, { title: `${portfolio.name} workflow` })
}

/**
 * The project whose editor a workflow page was asked to open, once: taking it
 * clears it. Null when there is none for this portfolio, or it is stale.
 *
 * @param {number} portfolio
 * @returns {number | null}
 */
export function takeFocus(portfolio) {
  try {
    const raw = JSON.parse(localStorage.getItem(FOCUS) ?? 'null')
    if (raw === null || raw.portfolio !== portfolio) return null
    localStorage.removeItem(FOCUS)
    return Date.now() - raw.at < FOCUS_MS && typeof raw.project === 'number' ? raw.project : null
  } catch {
    return null
  }
}

/** @param {{ uid: number, name: string }} project */
export function openProject(project) {
  return helm.tabs.open('view', { kind: 'project', uid: project.uid }, { title: project.name })
}

/** @param {{ uid: number, id: string, title: string }} item */
export function openItem(item) {
  return helm.tabs.open('view', { kind: 'item', uid: item.uid }, { title: itemTitle(item) })
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
