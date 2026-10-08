/**
 * The one error the store throws on purpose. `code` is what a caller branches
 * on; `message` is written to be read by a person or an agent as it is.
 *
 * - `invalid`: the input is wrong (a missing title, an unknown status name).
 * - `not-found`: the thing named does not exist.
 * - `conflict`: the input is fine but the current state refuses it (a name
 *   already taken, a dependency that would make a cycle, a status in use).
 */
export class WorkError extends Error {
  /**
   * @param {'invalid' | 'not-found' | 'conflict'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'WorkError'
    this.code = code
  }
}

/** @param {string} message */
export const invalid = (message) => new WorkError('invalid', message)
/** @param {string} message */
export const notFound = (message) => new WorkError('not-found', message)
/** @param {string} message */
export const conflict = (message) => new WorkError('conflict', message)
