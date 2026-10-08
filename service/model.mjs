/**
 * The vocabulary of the model: status groups, colours, icons, link kinds and
 * the defaults a new portfolio starts with. Kept apart from the store so the
 * pages can share it once they are built.
 */

/**
 * What a status means, whatever it is called. Helm and agents read the group,
 * never the name, so a custom status like "Awaiting launch" still counts as
 * done.
 *
 * - `not-started`: open, nobody on it.
 * - `active`: someone is on it.
 * - `done`: finished.
 * - `closed`: finished without doing it.
 */
export const STATUS_GROUPS = /** @type {const} */ (['not-started', 'active', 'done', 'closed'])

/** Groups whose items are still open work. */
export const OPEN_GROUPS = /** @type {const} */ (['not-started', 'active'])

/**
 * The order `find` lists groups in: work under way first, then work waiting,
 * then what is finished.
 */
export const GROUP_RANK = { active: 0, 'not-started': 1, done: 2, closed: 3 }

/**
 * Categorical colours for projects (and available to statuses). They are
 * names, not hex: each theme draws them in its own shade.
 */
export const PROJECT_COLOURS = /** @type {const} */ (['blue', 'orange', 'green', 'amber', 'pink'])

/** Theme tones a status can be drawn in, on top of the categorical colours. */
export const TONES = /** @type {const} */ (['subtle', 'muted', 'accent', 'warn', 'danger', 'success'])

export const COLOURS = /** @type {readonly string[]} */ ([...TONES, ...PROJECT_COLOURS])

/** The status icon shapes the board draws. */
export const STATUS_ICONS = /** @type {const} */ ([
  'backlog',
  'planning',
  'todo',
  'doing',
  'review',
  'blocked',
  'done',
  'launch',
  'cancelled'
])

/** The icon a new status gets when none is chosen. */
export const DEFAULT_ICON_FOR_GROUP = { 'not-started': 'todo', active: 'doing', done: 'done', closed: 'cancelled' }

/** What a link points at. */
export const LINK_KINDS = /** @type {const} */ (['branch', 'pr', 'commit', 'file', 'artifact', 'url'])

/** The path of a claude.ai artifact page: /artifact/{id} or /code/artifact/{uuid}. */
const ARTIFACT_PATH = /^\/(?:code\/)?artifact\/[A-Za-z0-9_-]+\/?$/

/**
 * Whether an address is a claude.ai artifact, the kind of page an `artifact`
 * link points at: a mockup, a design document. Agents read these with their
 * Artifact tool, which takes only claude.ai artifact links.
 *
 * @param {string} value
 */
export function isArtifactAddress(value) {
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.hostname === 'claude.ai' && url.username === '' && url.password === '' && ARTIFACT_PATH.test(url.pathname)
}

export const ITEM_KINDS = /** @type {const} */ (['epic', 'task'])

/**
 * A new portfolio's statuses, in board order. `isDefault` is what a new item
 * starts in.
 */
export const DEFAULT_STATUSES = [
  { name: 'Backlog', group: 'not-started', colour: 'subtle', icon: 'backlog', isDefault: true },
  { name: 'Planning', group: 'not-started', colour: 'muted', icon: 'planning' },
  { name: 'To do', group: 'not-started', colour: 'muted', icon: 'todo' },
  { name: 'In progress', group: 'active', colour: 'accent', icon: 'doing' },
  { name: 'In review', group: 'active', colour: 'warn', icon: 'review' },
  { name: 'Blocked', group: 'active', colour: 'danger', icon: 'blocked' },
  { name: 'Done', group: 'done', colour: 'success', icon: 'done' },
  { name: 'Cancelled', group: 'closed', colour: 'subtle', icon: 'cancelled' }
]

/** A new portfolio's priorities, most urgent first. */
export const DEFAULT_PRIORITIES = [
  { name: 'Urgent' },
  { name: 'High' },
  { name: 'Normal', isDefault: true },
  { name: 'Low' }
]

/** A portfolio key: what IDs start with. TC, HELM, WB. */
export const PORTFOLIO_KEY = /^[A-Z][A-Z0-9]{0,9}$/

/** An item ID as people and agents write it: TC-123. */
export const ITEM_ID = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/

export const LIMITS = {
  name: 120,
  title: 300,
  description: 100_000,
  criterion: 2_000,
  handoffField: 20_000,
  log: 4_000,
  linkValue: 2_000,
  sessionName: 200,
  folders: 50
}
