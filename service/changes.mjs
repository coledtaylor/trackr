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

/**
 * Links added and removed: "link +2", "link -1".
 *
 * @param {unknown[]} added
 * @param {unknown[]} removed
 * @returns {string[]}
 */
export function linkParts(added, removed) {
  /** @type {string[]} */
  const parts = []
  if (added.length > 0) parts.push(`link +${added.length}`)
  if (removed.length > 0) parts.push(`link -${removed.length}`)
  return parts
}

/**
 * References added, removed and edited, whatever their kind: "ref +2",
 * "ref -1", "ref edited 1".
 *
 * @param {unknown[]} added
 * @param {unknown[]} removed
 * @param {unknown[]} [edited] ones that were there already and changed their title, use or key
 * @returns {string[]}
 */
export function refParts(added, removed, edited = []) {
  /** @type {string[]} */
  const parts = []
  if (added.length > 0) parts.push(`ref +${added.length}`)
  if (removed.length > 0) parts.push(`ref -${removed.length}`)
  if (edited.length > 0) parts.push(`ref edited ${edited.length}`)
  return parts
}
