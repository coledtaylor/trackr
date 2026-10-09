/**
 * Decisions the pages make that do not touch the DOM or Helm: what to show
 * first, what to pick by default, how a time reads. Kept here so node:test can
 * check them without a browser.
 */

const ITEM_ID = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A time as the tools write it: "14:12" today, "Oct 6 14:12" this year,
 * "Oct 6 2025 14:12" before that. Local time.
 *
 * @param {string | null | undefined} iso
 * @param {Date} [now]
 * @returns {string}
 */
export function timeLabel(iso, now = new Date()) {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  if (sameDay) return clock
  const day = `${MONTHS[at.getMonth()]} ${at.getDate()}`
  return at.getFullYear() === now.getFullYear() ? `${day} ${clock}` : `${day} ${at.getFullYear()} ${clock}`
}

/**
 * Find results with an exact ID match first; the rest keep the service's
 * next-up order. Typing "TC-12" should land on TC-12 even when it is done and
 * sorts last.
 *
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {string} text
 * @returns {T[]}
 */
export function exactIdFirst(items, text) {
  const match = ITEM_ID.exec(text.trim())
  if (!match) return items
  const wanted = `${match[1].toUpperCase()}-${Number(match[2])}`
  const index = items.findIndex((item) => item.id === wanted)
  if (index <= 0) return items
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)]
}

/**
 * Open tasks in a portfolio: the sum of its projects'.
 *
 * @param {{ projects: { counts: { open: number } }[] }} portfolio
 */
export function openCount(portfolio) {
  return portfolio.projects.reduce((sum, project) => sum + project.counts.open, 0)
}

/**
 * @typedef {{ kind: 'portfolio' | 'workflow' | 'project' | 'item', uid: number, portfolio?: number, project?: number }} Viewing
 */

/**
 * The project a new task goes in unless the user picks another: the one on
 * screen (a project's tab, or the project of a task or epic on screen), else
 * the first project of a portfolio on screen, else the last one used, else the
 * first there is.
 *
 * @param {{ uid: number, portfolio: { uid: number } }[]} projects every project
 * @param {Viewing[]} viewing tabs on screen, most recent first
 * @param {number | null} lastUsed
 * @returns {number | null} a project uid
 */
export function defaultProject(projects, viewing, lastUsed) {
  const exists = (/** @type {number | undefined} */ uid) => uid !== undefined && projects.some((project) => project.uid === uid)
  for (const view of viewing) {
    if (view.kind === 'project' && exists(view.uid)) return view.uid
    if (view.kind === 'item' && exists(view.project)) return /** @type {number} */ (view.project)
    if (view.kind === 'portfolio') {
      const first = projects.find((project) => project.portfolio.uid === view.uid)
      if (first) return first.uid
    }
  }
  if (lastUsed !== null && exists(lastUsed)) return lastUsed
  return projects[0]?.uid ?? null
}

/**
 * After the portfolio changes under a form, keep the chosen option when the
 * new portfolio has one of the same name; otherwise its default.
 *
 * @param {{ uid: number, name: string, isDefault: boolean }[]} options
 * @param {string | null} previousName
 * @returns {number | null}
 */
export function carryOption(options, previousName) {
  if (previousName !== null) {
    const same = options.find((option) => option.name.toLowerCase() === previousName.toLowerCase())
    if (same) return same.uid
  }
  return (options.find((option) => option.isDefault) ?? options[0])?.uid ?? null
}

/**
 * How long ago, as a list column says it: "now", "5m", "2h", "3d", "2w",
 * "4mo", "1y".
 *
 * @param {string} iso
 * @param {Date} [now]
 */
export function age(iso, now = new Date()) {
  const ms = now.getTime() - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 35) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/**
 * How a priority is drawn: the most urgent of several as the urgent mark,
 * the rest as one to three bars, more for more urgent. A portfolio with one
 * priority draws nothing: there is nothing to tell apart.
 *
 * @param {number} rank 1 is the most urgent
 * @param {number} count how many priorities the portfolio has
 * @returns {{ urgent: boolean, bars: number }}
 */
export function priorityMark(rank, count) {
  if (count <= 1) return { urgent: false, bars: 0 }
  if (rank <= 1) return { urgent: true, bars: 0 }
  const steps = count - 1
  return { urgent: false, bars: Math.max(1, Math.min(3, Math.round((3 * (count - rank + 1)) / steps))) }
}

const LIST_RANK = { active: 0, 'not-started': 1, done: 2, closed: 3 }

/**
 * The order a project's list shows its status groups in: work under way
 * first, in workflow order; then work waiting, the status nearest to started
 * first; then finished work.
 *
 * @template {{ group: keyof typeof LIST_RANK, position?: number }} S
 * @param {S[]} statuses in the portfolio's order
 * @returns {S[]}
 */
export function listOrder(statuses) {
  const indexed = statuses.map((status, index) => ({ status, index }))
  indexed.sort((a, b) => {
    const rank = LIST_RANK[a.status.group] - LIST_RANK[b.status.group]
    if (rank !== 0) return rank
    return a.status.group === 'not-started' ? b.index - a.index : a.index - b.index
  })
  return indexed.map(({ status }) => status)
}

/**
 * The statuses a board shows as columns, in workflow order: every status
 * something is in, the default, the first and last not-started status (where
 * work is parked and where it is next), and the first active and done
 * statuses, so an empty project still has somewhere to put work.
 *
 * @template {{ uid: number, group: string, isDefault: boolean }} S
 * @param {S[]} statuses in the portfolio's order
 * @param {Set<number>} used uids of the statuses items are in
 * @returns {S[]}
 */
export function boardColumns(statuses, used) {
  const of = (/** @type {string} */ group) => statuses.filter((status) => status.group === group)
  const always = new Set(
    [of('not-started')[0], of('not-started').at(-1), of('active')[0], of('done')[0]]
      .filter((status) => status !== undefined)
      .map((status) => status.uid)
  )
  return statuses.filter((status) => used.has(status.uid) || status.isDefault || always.has(status.uid))
}

/**
 * The line under the open count: "down 6 in 14 days".
 *
 * @param {number[]} series
 */
export function trend(series) {
  if (series.length < 2) return ''
  const change = /** @type {number} */ (series.at(-1)) - series[0]
  const span = `in ${series.length} days`
  if (change === 0) return `no change ${span}`
  return `${change > 0 ? 'up' : 'down'} ${Math.abs(change)} ${span}`
}

/**
 * Plain text as paragraphs, split on blank lines, each a run of text and
 * `code` spans. Descriptions and handoffs are plain text, and agents put
 * backticks round names. Single line breaks stay in the text.
 *
 * @param {string} text
 * @returns {{ code: boolean, text: string }[][]}
 */
export function paragraphs(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t]*\n)+/)
    .map((paragraph) => paragraph.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, ''))
    .filter((paragraph) => paragraph.trim() !== '')
    .map(codeSpans)
}

/**
 * Text as a run of plain text and `code` spans. A backtick with no partner on
 * its line stays as written.
 *
 * @param {string} text
 * @returns {{ code: boolean, text: string }[]}
 */
export function codeSpans(text) {
  return text
    .split(/`([^`\n]+)`/)
    .map((part, index) => ({ code: index % 2 === 1, text: part }))
    .filter((part) => part.text !== '')
}

/**
 * An epic's tasks by project: the home project first, then the portfolio's
 * order, only projects with tasks in them. Cancelled tasks are listed but not
 * counted, as on the portfolio page: they are not work left or done.
 *
 * @template {{ project: { uid: number }, status: { group: string } }} T
 * @template {{ uid: number }} P
 * @param {T[]} tasks
 * @param {P[]} projects in the portfolio's order
 * @param {number} home the epic's project
 * @returns {{ project: P, home: boolean, tasks: T[], done: number, active: number, total: number }[]}
 */
export function epicGroups(tasks, projects, home) {
  const ordered = [...projects.filter((project) => project.uid === home), ...projects.filter((project) => project.uid !== home)]
  return ordered
    .map((project) => {
      const mine = tasks.filter((task) => task.project.uid === project.uid)
      const counted = mine.filter((task) => task.status.group !== 'closed')
      return {
        project,
        home: project.uid === home,
        tasks: mine,
        done: counted.filter((task) => task.status.group === 'done').length,
        active: counted.filter((task) => task.status.group === 'active').length,
        total: counted.length
      }
    })
    .filter((group) => group.tasks.length > 0)
}

/** What each kind of link is called, in the order the add form offers them. */
export const LINK_KINDS = /** @type {const} */ ([
  ['branch', 'Branch'],
  ['pr', 'Pull request'],
  ['commit', 'Commit'],
  ['file', 'File'],
  ['url', 'Link']
])

/**
 * How a link reads: its label when it has one, with the kind and value under
 * it; otherwise the value, under it the kind. Machine values are monospaced.
 *
 * @param {{ kind: string, value: string, label: string }} link
 * @returns {{ text: string, meta: string, mono: boolean }}
 */
export function linkText(link) {
  const kind = LINK_KINDS.find(([key]) => key === link.kind)?.[1] ?? link.kind
  if (link.label) return { text: link.label, meta: `${kind} · ${link.value}`, mono: false }
  return { text: link.value, meta: kind, mono: link.kind !== 'url' }
}

/** What each kind of reference is called, in the order the form offers them. */
export const REF_KINDS = /** @type {const} */ ([
  ['artifact', 'Artifact'],
  ['doc', 'Doc'],
  ['file', 'File'],
  ['url', 'Link']
])

/**
 * Whether a reference's title says no more than its target: the same text,
 * or for a file the path inside its project folder it was stored as, which a
 * file added without a title gets.
 *
 * @param {{ kind: string, target: string, title: string }} reference
 */
export function refTitleIsTarget(reference) {
  if (reference.title === reference.target) return true
  if (reference.kind !== 'file' || /^(?:[A-Za-z]:)?[\\/]/.test(reference.title)) return false
  const slashed = (/** @type {string} */ path) => path.replace(/\\/g, '/')
  return slashed(reference.target).endsWith(`/${slashed(reference.title)}`)
}

/**
 * How a reference's name reads: its title, or when it has none of its own a
 * web address without its scheme and a file's path in monospace.
 *
 * @param {{ kind: string, target: string, title: string }} reference
 * @returns {{ text: string, mono: boolean }}
 */
export function refName(reference) {
  if (!refTitleIsTarget(reference)) return { text: reference.title, mono: false }
  if (reference.kind === 'file') return { text: reference.title, mono: true }
  return { text: reference.target.replace(/^https?:\/\//i, ''), mono: false }
}

/**
 * What pressing a reference does: open its address in the Browser tab, open
 * a file with the program the computer opens it with, or copy what neither
 * takes (a plain http address, a file that is not there).
 *
 * @param {{ kind: string, target: string }} reference
 * @param {boolean} missing a file that is no longer there
 * @returns {{ via: 'browser' | 'system' | 'copy', target: string }}
 */
export function refAction(reference, missing) {
  if (reference.kind === 'file') return { via: missing ? 'copy' : 'system', target: reference.target }
  const address = openableAddress(reference.target)
  return address === null ? { via: 'copy', target: reference.target } : { via: 'browser', target: address }
}

/** @typedef {'windows' | 'mac' | 'linux'} Platform */

/**
 * The computer the page runs on, from the browser's user agent.
 *
 * @param {string} userAgent
 * @returns {Platform}
 */
export function platformOf(userAgent) {
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'mac'
  return 'linux'
}

/**
 * Files that run rather than open: programs, scripts, installers and
 * shortcuts. A reference can be written by an agent, so pressing one of these
 * shows it in its folder instead of running it.
 */
const RUNNABLE = new Set([
  'app', 'appimage', 'bash', 'bat', 'bin', 'cmd', 'com', 'command', 'cpl', 'desktop', 'exe', 'hta', 'jar', 'js', 'jse',
  'lnk', 'msi', 'msp', 'pif', 'ps1', 'psm1', 'py', 'pyw', 'reg', 'run', 'scr', 'sh', 'tool', 'url', 'vbe', 'vbs', 'wsf', 'wsh', 'zsh'
])

/**
 * The program (a key of the manifest's `exec`) and arguments that open a file
 * the way the computer opens it, or for a file that would run, show it in its
 * folder. No shell is involved: the path is one argument.
 *
 * @param {string} path absolute, as the service gives it
 * @param {Platform} platform
 * @returns {{ program: 'explorer' | 'open' | 'xdg-open', args: string[], reveals: boolean }}
 */
export function fileOpener(path, platform) {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  const reveals = dot > 0 && RUNNABLE.has(name.slice(dot + 1).toLowerCase())
  // Explorer takes the path after "/select," as its own argument: quoted
  // together with it, a path with a space opens Documents instead.
  if (platform === 'windows') return { program: 'explorer', args: reveals ? ['/select,', path] : [path], reveals }
  if (platform === 'mac') return { program: 'open', args: reveals ? ['-R', path] : [path], reveals }
  return { program: 'xdg-open', args: [reveals ? path.slice(0, Math.max(path.lastIndexOf('/'), 1)) : path], reveals }
}

/**
 * Inherited references by where they come from, in the order given (nearest
 * first), each source once.
 *
 * @template {{ from: { level: string, uid: number } }} R
 * @param {R[]} inherited
 * @returns {{ from: R['from'], refs: R[] }[]}
 */
export function refSources(inherited) {
  /** @type {Map<string, { from: R['from'], refs: R[] }>} */
  const sources = new Map()
  for (const reference of inherited) {
    const key = `${reference.from.level} ${reference.from.uid}`
    const source = sources.get(key) ?? { from: reference.from, refs: /** @type {R[]} */ ([]) }
    source.refs.push(reference)
    sources.set(key, source)
  }
  return [...sources.values()]
}

/**
 * The prompt that starts a session on an item.
 *
 * @param {{ id: string }} item
 */
export function sessionPrompt(item) {
  return `work on ${item.id}`
}

/**
 * The folder a session on a project starts in: its first, the one the pages
 * show. Null when the project has none.
 *
 * @param {{ folders: string[] }} project
 * @returns {string | null}
 */
export function sessionFolder(project) {
  return project.folders[0] ?? null
}

/**
 * @typedef {'busy' | 'idle' | 'waiting' | 'shell' | null} Activity
 * @typedef {{ id: string, state: 'running' | 'ended', activity: Activity }} ListedSession
 * @typedef {{ running: true, activity: Activity } | { running: false }} LiveState
 */

/**
 * Whether the session holding a claim still runs, from Helm's session list.
 * Trackr's tools are served only to sessions Helm hosts, and Helm lists every
 * one it started since it opened, so a claim missing from the list is a
 * session that has ended: before Helm last started, or long enough ago to
 * fall off the list. Null when Helm's list could not be read.
 *
 * @param {string} id the session id the claim recorded from a tool call
 * @param {ListedSession[] | null} sessions
 * @returns {LiveState | null}
 */
export function liveState(id, sessions) {
  if (sessions === null) return null
  /** @type {ListedSession | null} */
  let found = null
  // The list is oldest first; the latest entry for an id is the one that counts.
  for (const session of sessions) if (session.id === id) found = session
  return found !== null && found.state === 'running' ? { running: true, activity: found.activity } : { running: false }
}

const ACTIVITY = { busy: 'working', idle: 'idle', waiting: 'waiting for you', shell: 'running a command' }

/**
 * How a session's state reads beside its name: "working", "not running".
 * When Helm's list could not be read, when the session last wrote instead.
 *
 * @param {LiveState | null} live
 * @param {string} lastActive when it last wrote, or ''
 * @returns {string}
 */
export function sessionPhrase(live, lastActive) {
  if (live === null) return lastActive ? `last active ${lastActive}` : ''
  if (!live.running) return 'not running'
  return live.activity === null ? 'running' : ACTIVITY[live.activity]
}

/**
 * The address `helm.open` takes from a link's value: an `https` address with
 * no user name or password, up to 2048 characters. Null for anything else,
 * which the page copies instead.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function openableAddress(value) {
  const text = value.trim()
  if (text.length > 2048 || !/^https:\/\//i.test(text)) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== '' ? text : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The workflow page

/** Status groups in the order the workflow page and the board read them. */
export const STATUS_GROUPS = /** @type {const} */ ([
  { group: 'not-started', label: 'Not started', meaning: 'open, nobody on it' },
  { group: 'active', label: 'Active', meaning: 'someone is on it' },
  { group: 'done', label: 'Done', meaning: 'counts as finished' },
  { group: 'closed', label: 'Closed', meaning: 'finished without doing it' }
])

/** A portfolio key, as the service checks it: a letter, then up to nine letters or digits. */
export const PORTFOLIO_KEY = /^[A-Z][A-Z0-9]{0,9}$/

/**
 * A key for a new portfolio's name, before one is typed: the capitals of
 * "TideCast" (TC), the first letters of "Plugin SDK" (PS), or the first four
 * letters of a single word (HELM). Empty when the name has no letters.
 *
 * @param {string} name
 */
export function suggestKey(name) {
  const words = name.match(/[A-Za-z0-9]+/g) ?? []
  const start = words.findIndex((word) => /^[A-Za-z]/.test(word))
  if (start === -1) return ''
  const usable = words.slice(start)
  const capitals = usable.join('').match(/[A-Z]/g) ?? []
  const key =
    usable.length > 1
      ? usable.map((word) => word.charAt(0)).join('')
      : capitals.length > 1 && /^[A-Z]/.test(usable[0])
        ? capitals.join('')
        : usable[0].slice(0, 4)
  return key.toUpperCase().slice(0, 4)
}

/**
 * The statuses in each group, in the portfolio's order.
 *
 * @template {{ uid: number, group: string }} S
 * @param {S[]} statuses
 */
export function statusesByGroup(statuses) {
  return STATUS_GROUPS.map((group) => ({ ...group, statuses: statuses.filter((status) => status.group === group.group) }))
}

/**
 * The list with the entry at `from` moved to `to`.
 *
 * @template T
 * @param {T[]} list
 * @param {number} from
 * @param {number} to
 */
export function moved(list, from, to) {
  const copy = list.slice()
  if (from < 0 || from >= copy.length || to < 0 || to >= copy.length || from === to) return copy
  const [entry] = copy.splice(from, 1)
  copy.splice(to, 0, entry)
  return copy
}

/**
 * Every status uid in its new order after one moved inside its group. The
 * groups are laid end to end, so the board reads not-started to closed.
 *
 * @param {{ uid: number, group: string }[]} statuses
 * @param {string} group
 * @param {number} from index inside the group
 * @param {number} to index inside the group
 */
export function statusOrder(statuses, group, from, to) {
  return statusesByGroup(statuses).flatMap((entry) => (entry.group === group ? moved(entry.statuses, from, to) : entry.statuses).map((status) => status.uid))
}

/**
 * Where a deleted status's items go unless the person picks another: the
 * next status in its group, else the one before, else the default.
 *
 * @template {{ uid: number, group: string, isDefault: boolean }} S
 * @param {S[]} statuses
 * @param {number} uid the status going away
 * @returns {S | null}
 */
export function replacementStatus(statuses, uid) {
  const leaving = statuses.find((status) => status.uid === uid)
  if (!leaving) return null
  const group = statuses.filter((status) => status.group === leaving.group)
  const index = group.indexOf(leaving)
  return group[index + 1] ?? group[index - 1] ?? statuses.find((status) => status.isDefault && status.uid !== uid) ?? statuses.find((status) => status.uid !== uid) ?? null
}
