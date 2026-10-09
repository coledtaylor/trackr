import { WorkError } from './errors.mjs'
import { TOOL_NAMES, runTool } from './tools.mjs'

/**
 * The store methods the plugin's pages may call through the service, by name.
 * A method not listed here cannot be reached, whatever a page sends.
 */
export const RPC_METHODS = /** @type {const} */ ([
  'createPortfolio',
  'listPortfolios',
  'getPortfolio',
  'updatePortfolio',
  'deletePortfolio',
  'addStatus',
  'updateStatus',
  'reorderStatuses',
  'deleteStatus',
  'addPriority',
  'updatePriority',
  'reorderPriorities',
  'deletePriority',
  'createProject',
  'listProjects',
  'getProject',
  'updateProject',
  'reorderProjects',
  'deleteProject',
  'resolveFolder',
  'createItem',
  'getItem',
  'updateItem',
  'deleteItem',
  'findItems',
  'portfolioOverview',
  'projectOverview',
  'itemOverview',
  'portfolioSettings',
  'editItem',
  'readyDependents',
  'addCriteria',
  'setCriteriaDone',
  'editCriterion',
  'removeCriterion',
  'addDependency',
  'removeDependency',
  'addLink',
  'removeLink',
  'listRefs',
  'addRef',
  'updateRef',
  'removeRef',
  'reorderRefs',
  'inheritedRefs',
  'setHandoff',
  'appendLog',
  'claim',
  'release'
])

/**
 * Runs one call against the store.
 *
 * @param {import('./store.mjs').WorkStore} store
 * @param {unknown} request `{ method, args }`
 * @returns {{ status: number, body: { result: unknown } | { error: { code: string, message: string } } }}
 */
export function dispatch(store, request) {
  if (typeof request !== 'object' || request === null) return failure(400, 'invalid', 'The request must be a JSON object.')
  const { method, args = [] } = /** @type {{ method?: unknown, args?: unknown }} */ (request)
  if (typeof method !== 'string' || !RPC_METHODS.includes(/** @type {any} */ (method))) {
    return failure(400, 'invalid', `There is no method ${String(method)}.`)
  }
  if (!Array.isArray(args)) return failure(400, 'invalid', 'args must be a list.')
  try {
    const fn = /** @type {(...args: unknown[]) => unknown} */ (/** @type {any} */ (store)[method])
    const result = fn.apply(store, args)
    return { status: 200, body: { result: result === undefined ? null : result } }
  } catch (error) {
    if (error instanceof WorkError) {
      const status = error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400
      return failure(status, error.code, error.message)
    }
    throw error
  }
}

/**
 * Runs one session's tool call: `{ name, args, session }`, as the background
 * page relays it. Answers `{ text }`, the reply the session reads.
 *
 * @param {import('./store.mjs').WorkStore} store
 * @param {unknown} request
 * @param {import('./tools.mjs').Format} [format]
 * @returns {{ status: number, body: { text: string } | { error: { code: string, message: string } } }}
 */
export function dispatchTool(store, request, format) {
  if (typeof request !== 'object' || request === null) return failure(400, 'invalid', 'The request must be a JSON object.')
  const { name, args, session } = /** @type {{ name?: unknown, args?: unknown, session?: unknown }} */ (request)
  if (typeof name !== 'string' || !TOOL_NAMES.includes(/** @type {any} */ (name))) {
    return failure(400, 'invalid', `There is no tool ${String(name)}.`)
  }
  try {
    return { status: 200, body: { text: runTool(store, name, args, /** @type {any} */ (session), format) } }
  } catch (error) {
    if (error instanceof WorkError) {
      const status = error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400
      return failure(status, error.code, error.message)
    }
    throw error
  }
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function failure(status, code, message) {
  return { status, body: { error: { code, message } } }
}
