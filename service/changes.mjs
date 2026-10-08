/**
 * How a change to an item's fields reads in its log and in a tool's reply.
 * A session's update and the user's edit in a page write the same words.
 */

/** Between the parts of one log line or reply line. */
export const SEP = ' · '

/** @typedef {import('./store.mjs').Change} Change */

/** @type {Record<string, (change: Change) => string>} */
const DESCRIBE = {
  status: (change) => `${change.from} -> ${change.to}`,
  priority: (change) => `priority ${change.from} -> ${change.to}`,
  title: () => 'title',
  description: () => 'description',
  project: (change) => `moved ${change.from} -> ${change.to}`,
  epic: (change) => `epic ${change.from ?? 'none'} -> ${change.to ?? 'none'}`
}

const ORDER = ['status', 'priority', 'title', 'description', 'project', 'epic']

/**
 * The changes `updateItem` reports, as words, status first.
 *
 * @param {Change[]} changes
 * @returns {string[]}
 */
export function changeParts(changes) {
  /** @type {string[]} */
  const parts = []
  for (const field of ORDER) {
    const change = changes.find((candidate) => candidate.field === field)
    if (change) parts.push(DESCRIBE[field](change))
  }
  return parts
}
