import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { SEP, changeParts, linkParts, refParts } from './changes.mjs'
import { WorkError, invalid, notFound } from './errors.mjs'
import { absoluteFolder, displayFolder, normalFolder, pathState } from './folders.mjs'
import { INHERITED_REF_LINES, ITEM_ID, LINK_KINDS, OPEN_GROUPS, PORTFOLIO_KEY, PROJECT_COLOURS, REF_KINDS, inferRefKind, isArtifactAddress, isWebAddress } from './model.mjs'
import { unshadowed } from './overview.mjs'

/**
 * The four tools Claude Code sessions call: find, get, create and update.
 *
 * Each takes the session's arguments (untrusted: Helm does not check them
 * against the schema) and the calling session, and answers with plain text
 * written to be cheap to read: one line per item, IDs first. A WorkError
 * thrown here becomes a failed call whose message the session reads.
 *
 * Every write an agent makes is logged on the item with the session's name.
 * Setting an item to an active status records the session on it; a second
 * session is told who had it and carries on.
 */

/** @typedef {import('./store.mjs').WorkStore} WorkStore */
/** @typedef {import('./store.mjs').ItemSummary} ItemSummary */
/** @typedef {import('./store.mjs').Item} Item */
/** @typedef {import('./store.mjs').Project} Project */
/** @typedef {import('./store.mjs').Portfolio} Portfolio */
/** @typedef {import('./store.mjs').Counts} Counts */
/** @typedef {import('./store.mjs').Reference} Reference */
/** @typedef {import('./store.mjs').InheritedReference} InheritedReference */
/** @typedef {import('./store.mjs').RefKind} RefKind */
/** @typedef {import('./store.mjs').RefOwner} RefOwner */
/** @typedef {import('./folders.mjs').PathState} PathState */
/** @typedef {{ kind: RefKind, target: string, title?: string, use?: string, key?: boolean }} ReferenceInput */
/** @typedef {{ cwd: string, home: string }} Paths where a file written as `~/…` or relative is read from */
/** @typedef {{ level: 'item', id: string } | { level: 'portfolio', portfolio: Portfolio } | { level: 'project', project: Project }} Named */
/** @typedef {{ id: string, name: string, cwd: string }} Session */
/** @typedef {{ now?: () => Date, timeZone?: string, home?: string, pathState?: (path: string) => PathState }} Format */

export const TOOL_NAMES = /** @type {const} */ (['find', 'get', 'create', 'update'])

const FIND_LIMIT = 25
const FIND_MAX = 200
const LOG_DEFAULT = 10
const MAX_BATCH = 100

/**
 * @param {WorkStore} store
 * @param {string} name
 * @param {unknown} args
 * @param {Session} session
 * @param {Format} [format]
 * @returns {string}
 */
export function runTool(store, name, args, session, format = {}) {
  const context = new Context(store, sessionOf(session), format)
  const input = args === undefined || args === null ? {} : args
  if (typeof input !== 'object' || Array.isArray(input)) throw invalid('The arguments must be an object.')
  switch (name) {
    case 'find':
      return find(context, /** @type {Record<string, unknown>} */ (input))
    case 'get':
      return get(context, /** @type {Record<string, unknown>} */ (input))
    case 'create':
      return create(context, /** @type {Record<string, unknown>} */ (input))
    case 'update':
      return update(context, /** @type {Record<string, unknown>} */ (input))
    default:
      throw invalid(`There is no tool ${String(name)}.`)
  }
}

/**
 * What one call needs besides its arguments: the store, the session, the
 * project its folder belongs to, and project names and folders for labels.
 */
class Context {
  /**
   * @param {WorkStore} store
   * @param {Session} session
   * @param {Format} format
   */
  constructor(store, session, format) {
    this.store = store
    this.session = session
    this.now = format.now ?? (() => new Date())
    this.timeZone = format.timeZone
    this.home = format.home ?? homedir()
    this.pathState = format.pathState ?? pathState
    /** @type {ReturnType<WorkStore['resolveFolder']> | undefined} */
    this.hereCache = undefined
    /** @type {Map<number, { name: string, folders: string[], portfolio: { key: string, name: string } }> | null} */
    this.projectCache = null
  }

  /** The project the session's folder belongs to, if any. */
  here() {
    if (this.hereCache === undefined) this.hereCache = this.session.cwd ? this.store.resolveFolder(this.session.cwd) : null
    return this.hereCache
  }

  /**
   * A project's name, folders and portfolio, read once per call. A project
   * made during the call is read on its own.
   *
   * @param {number} uid
   * @returns {{ name: string, folders: string[], portfolio: { key: string, name: string } }}
   */
  project(uid) {
    if (this.projectCache === null) {
      this.projectCache = new Map()
      for (const project of this.store.listProjects()) this.projectCache.set(project.uid, project)
    }
    let found = this.projectCache.get(uid)
    if (found === undefined) {
      found = this.store.getProject(uid)
      this.projectCache.set(uid, found)
    }
    return found
  }

  /**
   * A project named the way people name one: "Desktop", or "TC/Desktop" when
   * the name is in more than one portfolio. A bare name is looked for in the
   * session's portfolio first.
   *
   * @param {unknown} value
   */
  projectNamed(value) {
    if (typeof value !== 'string' || value.trim() === '') throw invalid('project must be a project name, like Desktop or TC/Desktop.')
    const text = value.trim()
    const slash = text.indexOf('/')
    if (slash > 0) return this.store.getProject(text.slice(slash + 1), text.slice(0, slash))
    const here = this.here()
    if (here) {
      try {
        return this.store.getProject(text, here.project.portfolio.uid)
      } catch {
        // Not in this portfolio: look everywhere.
      }
    }
    return this.store.getProject(text)
  }

  /**
   * What get and update are given to work on: an item by its ID (TC-123), a
   * portfolio by its key (TC), or a project as `projectNamed` takes one. A
   * key wins over a project with the same name, which KEY/Name still reaches.
   *
   * @param {string} text
   * @returns {Named}
   */
  named(text) {
    if (ITEM_ID.test(text)) return { level: 'item', id: text }
    if (PORTFOLIO_KEY.test(text)) {
      try {
        return { level: 'portfolio', portfolio: this.store.getPortfolio(text) }
      } catch (error) {
        if (!(error instanceof WorkError && error.code === 'not-found')) throw error
      }
    }
    try {
      return { level: 'project', project: this.projectNamed(text) }
    } catch (error) {
      if (!(error instanceof WorkError && error.code === 'not-found')) throw error
      throw notFound(`There is no item, portfolio or project ${text}. Name an item by its ID (TC-123), a portfolio by its key (TC) or a project by its name (Desktop, or TC/Desktop).`)
    }
  }

  /** Where this session reads a file written as `~/…` or relative from. @returns {Paths} */
  paths() {
    return { cwd: this.session.cwd, home: this.home }
  }

  /**
   * "Oct 6 14:12", with the year when it is not this year.
   *
   * @param {string} iso
   */
  when(iso) {
    const parts = (/** @type {Date} */ date) =>
      Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: this.timeZone,
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23'
        })
          .formatToParts(date)
          .map((part) => [part.type, part.value])
      )
    const at = parts(new Date(iso))
    const year = at.year === parts(this.now()).year ? '' : ` ${at.year}`
    return `${at.month} ${at.day}${year} ${at.hour}:${at.minute}`
  }

  /**
   * A folder as a person writes it: under home as ~, forward slashes.
   *
   * @param {string} path
   */
  folder(path) {
    return displayFolder(path, this.home)
  }

  /** "TideCast/Desktop (~/repos/tidecast)" @param {number} uid */
  projectLabel(uid) {
    const project = this.project(uid)
    const folder = project.folders[0]
    return `${project.portfolio.name}/${project.name}${folder ? ` (${this.folder(folder)})` : ''}`
  }
}

// -----------------------------------------------------------------------------
// find

/**
 * @param {Context} context
 * @param {Record<string, unknown>} args
 */
function find(context, args) {
  only(args, ['project', 'portfolio', 'epic', 'status', 'text', 'ready', 'limit'], 'find')
  const { store } = context
  /** @type {Parameters<WorkStore['findItems']>[0]} */
  const filter = {}
  let scope = ''
  let crossesProjects = true
  let note = ''

  if (args.project !== undefined) {
    const project = context.projectNamed(args.project)
    filter.project = project.uid
    scope = `${project.portfolio.name}/${project.name}`
    crossesProjects = false
  } else if (args.epic !== undefined) {
    const epic = store.getItem(stringArg(args.epic, 'epic'))
    if (epic.kind !== 'epic') throw invalid(`${epic.id} is a task, not an epic.`)
    filter.epic = epic.uid
    scope = `epic ${epic.id} ${epic.title}`
  } else if (args.portfolio !== undefined) {
    const portfolio = store.getPortfolio(stringArg(args.portfolio, 'portfolio'))
    filter.portfolio = portfolio.uid
    scope = portfolio.name
  } else {
    const here = context.here()
    if (here) {
      filter.project = here.project.uid
      scope = `${here.project.portfolio.name}/${here.project.name}`
      crossesProjects = false
    } else {
      scope = 'every portfolio'
      note = context.session.cwd
        ? `${context.folder(context.session.cwd)} is in no project's folders, so this is every portfolio. Pass project to narrow it.`
        : ''
    }
  }

  const status = args.status === undefined ? 'open' : args.status
  /** @type {string[]} */
  const described = []
  if (status === 'open') {
    filter.groups = [...OPEN_GROUPS]
    described.push('open')
  } else if (status !== 'any') {
    const names = Array.isArray(status) ? status : [status]
    if (names.length === 0 || names.some((name) => typeof name !== 'string' || name.trim() === '')) {
      throw invalid('status is a status name, a list of them, "open" (the default) or "any".')
    }
    filter.status = /** @type {string[]} */ (names)
    described.push(names.join(' or '))
  }
  if (args.ready !== undefined) {
    if (typeof args.ready !== 'boolean') throw invalid('ready is true or false.')
    if (args.ready) {
      filter.ready = true
      described.push('ready')
    }
  }
  if (args.text !== undefined) {
    filter.text = stringArg(args.text, 'text')
    described.push(JSON.stringify(filter.text))
  }
  filter.limit = intArg(args.limit, 'limit', 1, FIND_MAX) ?? FIND_LIMIT

  const { items, total } = store.findItems(filter)
  const header = `${scope}${described.length ? `, ${described.join(', ')}` : ''}: ${total === 0 ? 'none' : total}`
  const lines = [header, ...items.map((item) => itemLine(context, item, { project: crossesProjects }))]
  if (total > items.length) lines.push(`${total - items.length} more. Raise limit or narrow the filter.`)
  if (note) lines.push(note)
  return lines.join('\n')
}

/**
 * One line for one item, as find lists it:
 * TC-123 In progress · High · Deleting a view keeps its history · epic TC-118 · AC 3/4 · waits on TC-121 · session saved views s3
 *
 * @param {Context} context
 * @param {ItemSummary} item
 * @param {{ project: boolean }} show
 */
function itemLine(context, item, show) {
  const parts = [`${item.id}${item.kind === 'epic' ? ' epic' : ''} ${item.status.name}`, item.priority.name, item.title]
  if (show.project) parts.push(context.project(item.project.uid).name)
  if (item.epic) parts.push(`epic ${item.epic.id}`)
  if (item.criteria.total > 0) parts.push(`AC ${item.criteria.done}/${item.criteria.total}`)
  if (item.waitingOn.length > 0) parts.push(`waits on ${item.waitingOn.join(', ')}`)
  if (item.session) parts.push(`session ${item.session.name}`)
  return parts.join(SEP)
}

// -----------------------------------------------------------------------------
// get

/**
 * Items, portfolios and projects, a block each: an item in full, a portfolio
 * or project as a short summary and its references.
 *
 * @param {Context} context
 * @param {Record<string, unknown>} args
 */
function get(context, args) {
  only(args, ['ids', 'log'], 'get')
  const ids = Array.isArray(args.ids) ? args.ids : args.ids === undefined ? [] : [args.ids]
  if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw invalid('ids is a list of IDs, portfolio keys or project names, like ["TC-123"].')
  }
  if (ids.length > MAX_BATCH) throw invalid(`get takes ${MAX_BATCH} IDs at most.`)
  const logLimit = intArg(args.log, 'log', 0, 1000) ?? LOG_DEFAULT
  const blocks = ids.map((id) => {
    try {
      const named = context.named(/** @type {string} */ (id).trim())
      switch (named.level) {
        case 'item':
          return detail(context, context.store.getItem(named.id, { logLimit }))
        case 'project':
          return projectDetail(context, named.project)
        case 'portfolio':
          return portfolioDetail(context, named.portfolio)
      }
    } catch (error) {
      // One ID among several that does not exist is a line, not a failed call.
      if (ids.length > 1 && error instanceof Error && 'code' in error) return error.message
      throw error
    }
  })
  return blocks.join('\n\n---\n\n')
}

/**
 * @param {Context} context
 * @param {Item} item
 */
function detail(context, item) {
  const lines = [`${item.id} ${item.title}`]
  const facts = [item.kind, item.status.name, item.priority.name, context.projectLabel(item.project.uid)]
  if (item.epic) facts.push(`epic ${item.epic.id} ${item.epic.title}`)
  if (item.tasks) {
    const done = item.tasks.filter((task) => task.status.group === 'done').length
    facts.push(`${done} of ${item.tasks.length} task${item.tasks.length === 1 ? '' : 's'} done`)
    if (item.spans && item.spans.length > 1) facts.push(`spans ${item.spans.join(', ')}`)
  }
  lines.push(facts.join(SEP))
  if (item.session) lines.push(`session: ${item.session.name}${item.session.activeAt ? `, last active ${context.when(item.session.activeAt)}` : ''}`)
  const related = (/** @type {ItemSummary[]} */ list) =>
    list.map((other) => `${other.id} ${other.status.name} (${context.project(other.project.uid).name})`).join(', ')
  if (item.waitsOn.length > 0) lines.push(`waits on: ${related(item.waitsOn)}`)
  if (item.blocks.length > 0) lines.push(`blocks: ${related(item.blocks)}`)
  if (item.links.length > 0) lines.push(`links: ${item.links.map(linkText).join(SEP)}`)

  if (item.description) lines.push('', '## Description', item.description)
  lines.push(...referencesSection(context, item.refs, context.store.inheritedRefs(item.uid)))
  if (item.tasks && item.tasks.length > 0) {
    lines.push('', '## Tasks')
    /** @type {Map<string, ItemSummary[]>} */
    const byProject = new Map()
    for (const task of item.tasks) {
      const name = context.project(task.project.uid).name
      byProject.set(name, [...(byProject.get(name) ?? []), task])
    }
    for (const [name, tasks] of byProject) {
      lines.push(name)
      for (const task of tasks) {
        const parts = [`${task.id} ${task.status.name}`, task.priority.name, task.title]
        if (task.criteria.total > 0) parts.push(`AC ${task.criteria.done}/${task.criteria.total}`)
        if (task.waitingOn.length > 0) parts.push(`waits on ${task.waitingOn.join(', ')}`)
        if (task.session) parts.push(`session ${task.session.name}`)
        lines.push(`  ${parts.join(SEP)}`)
      }
    }
  }
  if (item.criteriaList.length > 0) {
    lines.push('', `## Acceptance criteria ${item.criteria.done}/${item.criteria.total}`)
    for (const criterion of item.criteriaList) lines.push(`${criterion.n} [${criterion.done ? 'x' : ' '}] ${criterion.text}`)
  }
  if (item.handoff) {
    lines.push('', `## Where it stands (${item.handoff.by}, ${context.when(item.handoff.at)})`)
    lines.push(`Done: ${item.handoff.done || '-'}`, `Left: ${item.handoff.left || '-'}`, `Next: ${item.handoff.next || '-'}`)
  }
  if (item.log.total > 0 && item.log.entries.length > 0) {
    const shown = item.log.entries.length
    lines.push('', shown === item.log.total ? `## Log, all ${shown}` : `## Log, latest ${shown} of ${item.log.total}`)
    for (const entry of item.log.entries) {
      lines.push(`${context.when(entry.at)} ${entry.by}: ${entry.text}${entry.ref ? ` (${entry.ref})` : ''}`)
    }
  }
  return lines.join('\n')
}

/** @param {{ kind: string, value: string, label: string }} link */
function linkText(link) {
  const value = link.kind === 'pr' && /^\d+$/.test(link.value) ? `#${link.value}` : link.value
  const kind = link.kind === 'pr' ? 'PR' : link.kind
  return `${kind} ${value}${link.label ? ` (${link.label})` : ''}`
}

/**
 * A portfolio: its projects, the open work in them, its description and its
 * references.
 *
 * TC TideCast
 * portfolio · projects Desktop, Reporting API · 3 open tasks, 1 active
 *
 * @param {Context} context
 * @param {Portfolio} portfolio
 */
function portfolioDetail(context, portfolio) {
  const lines = [`${portfolio.key} ${portfolio.name}`]
  const projects = portfolio.projects.length > 0 ? `projects ${portfolio.projects.map((project) => project.name).join(', ')}` : 'no projects'
  lines.push(['portfolio', projects, openWork(portfolio.projects.map((project) => project.counts))].join(SEP))
  if (portfolio.description) lines.push('', '## Description', portfolio.description)
  lines.push(...referencesSection(context, context.store.listRefs({ portfolio: portfolio.uid }), []))
  return lines.join('\n')
}

/**
 * A project: its portfolio, its folders, the open work in it and its
 * references.
 *
 * TC/Desktop
 * project · portfolio TC TideCast · ~/code/tidecast · 3 open tasks, 1 active
 *
 * @param {Context} context
 * @param {Project} project
 */
function projectDetail(context, project) {
  const lines = [`${project.portfolio.key}/${project.name}`]
  const folders = project.folders.length > 0 ? project.folders.map((folder) => context.folder(folder)).join(', ') : 'no folders'
  lines.push(['project', `portfolio ${project.portfolio.key} ${project.portfolio.name}`, folders, openWork([project.counts])].join(SEP))
  lines.push(...referencesSection(context, context.store.listRefs({ project: project.uid }), []))
  return lines.join('\n')
}

/**
 * "3 open tasks, 1 active"
 *
 * @param {Counts[]} counts
 */
function openWork(counts) {
  const open = counts.reduce((sum, count) => sum + count.open, 0)
  const active = counts.reduce((sum, count) => sum + count.active, 0)
  return `${open} open task${open === 1 ? '' : 's'}${active > 0 ? `, ${active} active` : ''}`
}

/**
 * The tool that opens each kind of reference, as the hint under the list
 * names it.
 *
 * @type {Record<RefKind, string>}
 */
const REF_TOOLS = { artifact: 'artifacts with the Artifact tool', doc: 'docs with their connector', file: 'files with Read', url: 'URLs with WebFetch' }

/**
 * The references part of get: the owner's own, then the key references it
 * inherits, nearest level first, each saying where it comes from. A target
 * shows once, at the nearest level that holds it. Past INHERITED_REF_LINES
 * inherited lines, the rest of each level is one "+N more" line naming the
 * get that lists them. A hint naming the tool for each kind shown closes it.
 * Nothing when there are none.
 *
 * ## References
 * artifact Banner mockup · https://claude.ai/artifact/abc · Read when building the banner
 * file /code/app/docs/sync.md · Read when changing sync · from epic TC-118 · missing
 * +4 more on project Desktop (get Desktop)
 * Read the ones whose use fits the work: artifacts with the Artifact tool, files with Read.
 *
 * @param {Context} context
 * @param {Reference[]} own
 * @param {InheritedReference[]} inherited in the order inheritedRefs gives them: epic, project, portfolio
 * @returns {string[]} lines, the first one blank
 */
function referencesSection(context, own, inherited) {
  const nearest = unshadowed(own, inherited)
  if (own.length + nearest.length === 0) return []
  const shown = nearest.slice(0, INHERITED_REF_LINES)
  const kinds = new Set([...own, ...shown].map((reference) => reference.kind))
  return [
    '',
    '## References',
    ...own.map((reference) => referenceLine(context, reference, null)),
    ...shown.map((reference) => referenceLine(context, reference, reference.from)),
    ...moreLines(context, nearest.slice(INHERITED_REF_LINES)),
    `Read the ones whose use fits the work: ${REF_KINDS.filter((kind) => kinds.has(kind)).map((kind) => REF_TOOLS[kind]).join(', ')}.`
  ]
}

/**
 * "+4 more on project Desktop (get Desktop)": one line per level for the
 * inherited references past the cap.
 *
 * @param {Context} context
 * @param {InheritedReference[]} hidden
 */
function moreLines(context, hidden) {
  /** @type {Map<string, { from: InheritedReference['from'], count: number }>} */
  const levels = new Map()
  for (const { from } of hidden) {
    const key = `${from.level} ${from.uid}`
    const level = levels.get(key) ?? { from, count: 0 }
    level.count += 1
    levels.set(key, level)
  }
  return [...levels.values()].map(({ from, count }) => `+${count} more on ${from.level} ${from.name} (get ${getName(context, from)})`)
}

/**
 * What get takes to show a level's references: an epic's ID, a portfolio's
 * key, a project's name, or KEY/Name when the bare name would reach
 * something else from this session.
 *
 * @param {Context} context
 * @param {InheritedReference['from']} from
 */
function getName(context, from) {
  if (from.level !== 'project') return from.name
  try {
    const named = context.named(from.name)
    if (named.level === 'project' && named.project.uid === from.uid) return from.name
  } catch (error) {
    if (!(error instanceof WorkError)) throw error
  }
  return `${context.project(from.uid).portfolio.key}/${from.name}`
}

/**
 * artifact Settings mockup · https://claude.ai/artifact/abc · Read when building the page · key
 * doc https://www.notion.so/sync-design · Read when changing sync · from epic TC-118
 * file /code/app/docs/sync.md · Read when changing sync · missing
 *
 * The title is left out when it only repeats the target, as a file's does
 * when it was added without one. `key` marks one that shows on everything
 * under its owner; `missing`, a file that is no longer there.
 *
 * @param {Context} context
 * @param {Reference} reference
 * @param {InheritedReference['from'] | null} from where it comes from, when it is not the owner's own
 */
function referenceLine(context, reference, from) {
  const named = repeatsTarget(reference) ? [`${reference.kind} ${reference.target}`] : [`${reference.kind} ${reference.title}`, reference.target]
  const parts = [...named, reference.use]
  if (from) parts.push(`from ${from.level} ${from.name}`)
  else if (reference.key) parts.push('key')
  if (reference.kind === 'file' && isAbsolute(reference.target) && context.pathState(reference.target) === 'missing') parts.push('missing')
  return parts.join(SEP)
}

/**
 * Whether a reference's title says no more than its target: the same text,
 * or for a file the path relative to its project folder that it was stored as.
 *
 * @param {Reference} reference
 */
function repeatsTarget(reference) {
  if (reference.title === reference.target) return true
  if (reference.kind !== 'file' || isAbsolute(reference.title)) return false
  const slashed = (/** @type {string} */ path) => path.replace(/\\/g, '/')
  return slashed(reference.target).endsWith(`/${slashed(reference.title)}`)
}

// -----------------------------------------------------------------------------
// create

const CREATE_KINDS = /** @type {const} */ (['task', 'epic', 'project', 'portfolio'])
const CREATE_FIELDS = ['ref', 'kind', 'project', 'epic', 'title', 'description', 'status', 'priority', 'ac', 'waitsOn', 'links', 'references']
const PORTFOLIO_FIELDS = ['kind', 'key', 'name', 'description', 'references']
const PROJECT_FIELDS = ['kind', 'portfolio', 'name', 'colour', 'folders', 'references']

/** @typedef {{ input: Record<string, unknown>, where: string }} CreateInput */

/**
 * Portfolios, projects, epics and tasks in one call. Portfolios are made
 * first, then projects, then epics and tasks, whatever order they are listed
 * in, so an item can name a project made in the same call and a project a
 * portfolio. Epics and tasks name each other with a temporary `ref` before
 * they have IDs; `epic` and `waitsOn` take a ref or an ID. All of it lands or
 * none of it does.
 *
 * @param {Context} context
 * @param {Record<string, unknown>} args
 */
function create(context, args) {
  only(args, ['items'], 'create')
  const inputs = batch(args.items, 'create')
  /** @type {{ portfolio: CreateInput[], project: CreateInput[], item: CreateInput[] }} */
  const groups = { portfolio: [], project: [], item: [] }
  inputs.forEach((input, index) => {
    const where = `items[${index}]`
    const kind = createKind(input.kind, where)
    groups[kind === 'portfolio' || kind === 'project' ? kind : 'item'].push({ input, where })
  })
  return context.store.transaction(() => {
    const lines = [
      ...groups.portfolio.map((entry) => createPortfolio(context, entry)),
      ...groups.project.map((entry) => createProject(context, entry))
    ]
    // A new project's folder may hold the session's: work it out again.
    if (groups.project.length > 0) context.hereCache = undefined
    if (groups.item.length > 0) lines.push(createItems(context, groups.item))
    return lines.join('\n')
  })
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {typeof CREATE_KINDS[number]}
 */
function createKind(value, where) {
  if (value === undefined) return 'task'
  if (!CREATE_KINDS.includes(/** @type {any} */ (value))) {
    throw invalid(`${where}.kind is ${CREATE_KINDS.join(', ').replace(/, (?=[^,]*$)/, ' or ')}, not ${JSON.stringify(value)}.`)
  }
  return /** @type {typeof CREATE_KINDS[number]} */ (value)
}

/**
 * A portfolio with the default statuses and priorities:
 * NW portfolio Newco · statuses Backlog, …, Cancelled · priorities Urgent, High, Normal, Low
 *
 * @param {Context} context
 * @param {CreateInput} entry
 */
function createPortfolio(context, { input, where }) {
  only(input, PORTFOLIO_FIELDS, where)
  const references = referencesFor(context, input.references, `${where}.references`)
  const portfolio = refusedAt(where, () =>
    context.store.createPortfolio({
      key: stringArg(input.key, `${where}.key`),
      name: stringArg(input.name, `${where}.name`),
      description: input.description === undefined ? undefined : textArg(input.description, `${where}.description`)
    })
  )
  addReferences(context.store, { portfolio: portfolio.uid }, references, `${where}.references`)
  return [
    `${portfolio.key} portfolio ${portfolio.name}`,
    `statuses ${portfolio.statuses.map((status) => status.name).join(', ')}`,
    `priorities ${portfolio.priorities.map((priority) => priority.name).join(', ')}`
  ].join(SEP)
}

/**
 * A project in a named portfolio, with its folders:
 * project NW/Desktop · ~/code/newco
 *
 * @param {Context} context
 * @param {CreateInput} entry
 */
function createProject(context, { input, where }) {
  only(input, PROJECT_FIELDS, where)
  const portfolio = stringArg(input.portfolio, `${where}.portfolio`)
  const name = stringArg(input.name, `${where}.name`)
  /** @type {string | undefined} */
  let colour
  if (input.colour !== undefined) {
    colour = typeof input.colour === 'string' ? input.colour.trim().toLowerCase() : ''
    if (!PROJECT_COLOURS.includes(/** @type {any} */ (colour))) throw invalid(`${where}.colour is one of ${PROJECT_COLOURS.join(', ')}.`)
  }
  const folders = input.folders === undefined ? undefined : stringList(input.folders, `${where}.folders`).map((folder) => folderFor(context, folder))
  const references = referencesFor(context, input.references, `${where}.references`)
  const project = refusedAt(where, () => context.store.createProject({ portfolio, name, colour, folders }))
  addReferences(context.store, { project: project.uid }, references, `${where}.references`)
  const place = project.folders.length > 0 ? project.folders.map((folder) => context.folder(folder)).join(', ') : 'no folders: no session lands in it until it has one'
  return `project ${project.portfolio.key}/${project.name}${SEP}${place}`
}

/**
 * A folder as an agent writes it: absolute, under `~`, or relative to the
 * session's folder.
 *
 * @param {Context} context
 * @param {string} folder
 */
function folderFor(context, folder) {
  if (folder === '~' || /^~[\\/]/.test(folder) || isAbsolute(folder) || !context.session.cwd) return folder
  return resolve(context.session.cwd, folder)
}

/**
 * Runs `fn`, saying which item a refusal is about.
 *
 * @template T
 * @param {string} where
 * @param {() => T} fn
 * @returns {T}
 */
function refusedAt(where, fn) {
  try {
    return fn()
  } catch (error) {
    if (error instanceof WorkError) throw new WorkError(error.code, `${where}: ${error.message}`)
    throw error
  }
}

/**
 * Epics and tasks, after any portfolios and projects of the same call.
 *
 * @param {Context} context
 * @param {CreateInput[]} inputs
 */
function createItems(context, inputs) {
  const { store, session } = context
  /** @type {Map<string, number>} */
  const refs = new Map()
  /** @type {{ input: Record<string, unknown>, where: string, uid: number }[]} */
  const made = []

  for (const { input, where } of inputs) {
    only(input, CREATE_FIELDS, where)
    const ref = input.ref === undefined ? null : stringArg(input.ref, `${where}.ref`)
    if (ref !== null) {
      if (ITEM_ID.test(ref)) throw invalid(`${where}.ref ${ref} looks like an ID. Use a short name like "a".`)
      if (refs.has(ref)) throw invalid(`The ref ${ref} is used twice.`)
    }
    const project = projectFor(context, input, refs, where)
    const references = referencesFor(context, input.references, `${where}.references`)
    const item = store.createItem({
      kind: /** @type {any} */ (input.kind),
      project,
      title: /** @type {string} */ (input.title),
      description: /** @type {string | undefined} */ (input.description),
      status: /** @type {string | undefined} */ (input.status),
      priority: /** @type {string | undefined} */ (input.priority),
      criteria: input.ac === undefined ? undefined : stringList(input.ac, `${where}.ac`),
      links: input.links === undefined ? undefined : listArg(input.links, `${where}.links`).map((link) => parseLink(link, `${where}.links`)),
      by: session.name
    })
    addReferences(store, { item: item.uid }, references, `${where}.references`)
    if (ref !== null) refs.set(ref, item.uid)
    made.push({ input, where, uid: item.uid })
  }

  for (const { input, where, uid } of made) {
    if (input.epic !== undefined) store.updateItem(uid, { epic: itemFrom(input.epic, refs, `${where}.epic`) })
    if (input.waitsOn !== undefined) {
      for (const other of listArg(input.waitsOn, `${where}.waitsOn`)) store.addDependency(uid, itemFrom(other, refs, `${where}.waitsOn`))
    }
    const item = store.getItem(uid, { logLimit: 0 })
    if (item.status.group === 'active') store.claim(uid, session)
    store.appendLog(uid, { text: 'Created', by: session.name })
  }

  return createReply(context, made.map(({ uid }) => store.getItem(uid, { logLimit: 0 })))
}

/**
 * Where a new item goes: the project it names, else its epic's, else the
 * session's.
 *
 * @param {Context} context
 * @param {Record<string, unknown>} input
 * @param {Map<string, number>} refs
 * @param {string} where
 */
function projectFor(context, input, refs, where) {
  if (input.project !== undefined) return context.projectNamed(input.project).uid
  if (input.epic !== undefined && typeof input.epic === 'string') {
    const epic = refs.has(input.epic) ? refs.get(input.epic) : ITEM_ID.test(input.epic.trim()) ? input.epic : undefined
    if (epic !== undefined) return context.store.getItem(epic, { logLimit: 0 }).project.uid
  }
  const here = context.here()
  if (here) return here.project.uid
  throw invalid(
    `${where} has no project, and ${context.session.cwd ? context.folder(context.session.cwd) : 'this session'} is in no project's folders. Pass project.`
  )
}

/**
 * TC-118 epic Saved views (Desktop) · TC-119, TC-120, TC-121 · spans Desktop, Reporting API
 * TC-130 Fix the crash (Desktop) · epic TC-100 · waits on TC-99
 *
 * @param {Context} context
 * @param {Item[]} items
 */
function createReply(context, items) {
  const epics = new Set(items.filter((item) => item.kind === 'epic').map((item) => item.id))
  const lines = []
  for (const item of items) {
    const name = context.project(item.project.uid).name
    if (item.kind === 'epic') {
      const children = items.filter((other) => other.epic?.id === item.id)
      const parts = [`${item.id} epic ${item.title} (${name})`]
      if (children.length > 0) parts.push(children.map((child) => child.id).join(', '))
      const spans = context.store.getItem(item.uid, { logLimit: 0 }).spans ?? []
      if (spans.length > 1) parts.push(`spans ${spans.join(', ')}`)
      lines.push(parts.join(SEP))
    } else if (!item.epic || !epics.has(item.epic.id)) {
      const parts = [`${item.id} ${item.title} (${name})`]
      if (item.epic) parts.push(`epic ${item.epic.id}`)
      if (item.waitingOn.length > 0) parts.push(`waits on ${item.waitingOn.join(', ')}`)
      lines.push(parts.join(SEP))
    }
  }
  return lines.join('\n')
}

// -----------------------------------------------------------------------------
// update

const UPDATE_FIELDS = ['id', 'title', 'description', 'status', 'priority', 'project', 'epic', 'ac', 'handoff', 'log', 'links', 'references', 'waitsOn']
const OWNER_UPDATE_FIELDS = ['id', 'references']

/**
 * Several items in one call: fields, criteria, handoff, a log line, links,
 * references, dependencies; and the references of portfolios and projects.
 * One line per item, then what became ready. All of it lands or none of it
 * does.
 *
 * @param {Context} context
 * @param {Record<string, unknown>} args
 */
function update(context, args) {
  only(args, ['items'], 'update')
  const inputs = batch(args.items, 'update')
  const { store } = context
  return store.transaction(() => {
    /** @type {string[]} */
    const lines = []
    /** @type {string[]} */
    const notes = []
    /** @type {Map<string, ItemSummary>} */
    const ready = new Map()
    inputs.forEach((input, index) => {
      const result = updateOne(context, input, `items[${index}]`)
      lines.push(result.line)
      if (result.note) notes.push(result.note)
      for (const item of result.ready) ready.set(item.id, item)
    })
    // Something finished in this call and then picked up again is not ready.
    const stillReady = [...ready.values()].filter((item) => {
      const now = store.getItem(item.uid, { logLimit: 0 })
      return (now.status.group === 'not-started' || now.status.group === 'active') && now.waitingOn.length === 0
    })
    if (stillReady.length > 0) {
      lines.push(`Now ready: ${stillReady.map((item) => `${item.id} (${context.project(item.project.uid).name})`).join(', ')}`)
    }
    return [...lines, ...notes].join('\n')
  })
}

/**
 * @param {Context} context
 * @param {Record<string, unknown>} input
 * @param {string} where
 * @returns {{ line: string, note: string | null, ready: ItemSummary[] }}
 */
function updateOne(context, input, where) {
  const { store, session } = context
  const named = context.named(stringArg(input.id, `${where}.id`))
  if (named.level !== 'item') return updateOwner(context, input, named)
  only(input, UPDATE_FIELDS, named.id)
  const before = store.getItem(named.id, { logLimit: 0 })
  where = before.id

  const { changes } = store.updateItem(before.uid, {
    title: /** @type {string | undefined} */ (input.title),
    description: /** @type {string | undefined} */ (input.description),
    status: /** @type {string | undefined} */ (input.status),
    priority: /** @type {string | undefined} */ (input.priority),
    project: input.project === undefined ? undefined : context.projectNamed(input.project).uid,
    epic: input.epic === undefined ? undefined : input.epic === null ? null : itemFrom(input.epic, null, `${where}.epic`)
  })
  const parts = changeParts(changes)

  const after = store.getItem(before.uid, { logLimit: 0 })
  const statusChanged = after.status.uid !== before.status.uid
  const finished = statusChanged && (after.status.group === 'done' || after.status.group === 'closed')

  const acTouched = input.ac !== undefined
  if (acTouched) applyCriteria(store, before.uid, input.ac, where)
  if (acTouched || (statusChanged && after.status.group === 'done')) {
    const { done, total } = store.getItem(before.uid, { logLimit: 0 }).criteria
    if (total > 0 || acTouched) {
      const unchecked = total - done
      parts.push(`AC ${done}/${total}${after.status.group === 'done' && unchecked > 0 ? `, ${unchecked} unchecked` : ''}`)
    }
  }

  if (input.handoff !== undefined) {
    const handoff = objectArg(input.handoff, `${where}.handoff`)
    only(handoff, ['done', 'left', 'next'], `${where}.handoff`)
    store.setHandoff(before.uid, /** @type {any} */ (handoff), session.name)
    parts.push('handoff')
  }

  /** @type {{ text: string, ref?: string } | null} */
  let logged = null
  if (input.log !== undefined) {
    if (typeof input.log === 'string') logged = { text: input.log }
    else {
      const log = objectArg(input.log, `${where}.log`)
      only(log, ['text', 'ref'], `${where}.log`)
      logged = { text: stringArg(log.text, `${where}.log.text`), ref: log.ref === undefined ? undefined : stringArg(log.ref, `${where}.log.ref`) }
    }
    parts.push('log +1')
  }

  /** @type {{ kind: string }[]} */
  const linksAdded = []
  /** @type {{ kind: string }[]} */
  const linksRemoved = []
  if (input.links !== undefined) {
    const ops = objectArg(input.links, `${where}.links`)
    only(ops, ['add', 'remove'], `${where}.links`)
    for (const value of ops.add === undefined ? [] : listArg(ops.add, `${where}.links.add`)) {
      linksAdded.push(store.addLink(before.uid, parseLink(value, `${where}.links.add`)))
    }
    for (const value of ops.remove === undefined ? [] : listArg(ops.remove, `${where}.links.remove`)) {
      const link = findLink(store, before.uid, value, `${where}.links.remove`)
      store.removeLink(before.uid, link.uid)
      linksRemoved.push(link)
    }
  }
  parts.push(...linkParts(linksAdded, linksRemoved))
  if (input.references !== undefined) parts.push(...applyReferences(context, { item: before.uid }, input.references, `${where}.references`))

  if (input.waitsOn !== undefined) {
    const waits = objectArg(input.waitsOn, `${where}.waitsOn`)
    only(waits, ['add', 'remove'], `${where}.waitsOn`)
    const added = waits.add === undefined ? [] : listArg(waits.add, `${where}.waitsOn.add`)
    const removed = waits.remove === undefined ? [] : listArg(waits.remove, `${where}.waitsOn.remove`)
    for (const other of added) store.addDependency(before.uid, itemFrom(other, null, `${where}.waitsOn.add`))
    for (const other of removed) store.removeDependency(before.uid, itemFrom(other, null, `${where}.waitsOn.remove`))
    if (added.length > 0) parts.push(`waits on +${added.length}`)
    if (removed.length > 0) parts.push(`waits on -${removed.length}`)
  }

  // The session on an item: taken when it goes active, let go when it stops
  // being active, and kept fresh while the same session works on it.
  let note = null
  if (statusChanged && after.status.group === 'active') {
    const { previous } = store.claim(before.uid, session)
    if (previous) {
      note = `${before.id} was being worked on by ${previous.name}${previous.activeAt ? ` (last active ${context.when(previous.activeAt)})` : ''}. It is recorded as this session's now; check with the user if that session may still be running.`
    }
  } else if (statusChanged && after.status.group !== 'active') {
    if (after.session) store.release(before.uid)
  } else if (parts.length > 0 && after.session?.id === session.id) {
    store.claim(before.uid, session)
  }

  if (parts.length === 0) return { line: `${before.id} unchanged`, note: null, ready: [] }

  const summary = parts.filter((part) => part !== 'log +1').join(SEP)
  const text = logged ? (summary ? `${logged.text}${SEP}${summary}` : logged.text) : summary
  store.appendLog(before.uid, { text, by: session.name, ref: logged?.ref })

  return { line: `${before.id} ${parts.join(SEP)}`, note, ready: finished ? store.readyDependents(before.uid) : [] }
}

/**
 * A portfolio or project in an update: it takes references and nothing else.
 * It has no log, so the reply line is the only record of the change.
 *
 * @param {Context} context
 * @param {Record<string, unknown>} input
 * @param {Exclude<Named, { level: 'item' }>} named
 * @returns {{ line: string, note: null, ready: ItemSummary[] }}
 */
function updateOwner(context, input, named) {
  const label = named.level === 'portfolio' ? named.portfolio.key : `${named.project.portfolio.key}/${named.project.name}`
  only(input, OWNER_UPDATE_FIELDS, `${label} is a ${named.level} and`)
  /** @type {RefOwner} */
  const owner = named.level === 'portfolio' ? { portfolio: named.portfolio.uid } : { project: named.project.uid }
  const parts = input.references === undefined ? [] : applyReferences(context, owner, input.references, `${label}.references`)
  return { line: parts.length > 0 ? `${label} ${parts.join(SEP)}` : `${label} unchanged`, note: null, ready: [] }
}

/**
 * Criteria operations, every number meaning the list as it was before the
 * call: edit, check and uncheck in place, remove, then add at the end.
 *
 * @param {WorkStore} store
 * @param {number} uid
 * @param {unknown} value
 * @param {string} where
 */
function applyCriteria(store, uid, value, where) {
  const ac = objectArg(value, `${where}.ac`)
  only(ac, ['check', 'uncheck', 'add', 'edit', 'remove'], `${where}.ac`)
  if (ac.edit !== undefined) {
    const edits = objectArg(ac.edit, `${where}.ac.edit`)
    for (const [n, text] of Object.entries(edits)) store.editCriterion(uid, Number(n), /** @type {string} */ (text))
  }
  if (ac.check !== undefined) store.setCriteriaDone(uid, numberList(ac.check, `${where}.ac.check`), true)
  if (ac.uncheck !== undefined) store.setCriteriaDone(uid, numberList(ac.uncheck, `${where}.ac.uncheck`), false)
  if (ac.remove !== undefined) {
    const numbers = [...new Set(numberList(ac.remove, `${where}.ac.remove`))].sort((a, b) => b - a)
    for (const n of numbers) store.removeCriterion(uid, n)
  }
  if (ac.add !== undefined) store.addCriteria(uid, stringList(ac.add, `${where}.ac.add`))
}

// -----------------------------------------------------------------------------
// Links

/**
 * A link as an agent writes one: `{ kind, value, label }`, or a string like
 * "commit b7f02c1", "branch feat/x", "PR #412", "file src/a.py", or a bare URL.
 * A claude.ai artifact is not a link but a reference, and is refused with a
 * pointer there.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {{ kind: string, value: string, label?: string }}
 */
export function parseLink(value, where) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const link = /** @type {Record<string, unknown>} */ (value)
    only(link, ['kind', 'value', 'label'], where)
    const kind = typeof link.kind === 'string' ? link.kind.trim().toLowerCase() : ''
    if (kind === 'artifact') throw artifactLink(where, typeof link.value === 'string' ? link.value.trim() : '')
    return {
      kind,
      value: typeof link.value === 'string' && link.kind === 'pr' ? link.value.replace(/^#/, '') : /** @type {string} */ (link.value),
      label: /** @type {string | undefined} */ (link.label)
    }
  }
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${where}: a link is a string like "branch feat/x" or {kind, value, label}.`)
  const text = value.trim()
  if (/^https?:\/\/\S+$/i.test(text)) {
    if (isArtifactAddress(text)) throw artifactLink(where, text)
    return { kind: 'url', value: text }
  }
  const space = text.search(/\s/)
  const word = (space < 0 ? text : text.slice(0, space)).toLowerCase()
  const rest = space < 0 ? '' : text.slice(space).trim()
  if (word === 'artifact') throw artifactLink(where, rest)
  if (!LINK_KINDS.includes(/** @type {any} */ (word)) || rest === '') {
    throw invalid(`${where}: "${text}" is not a link. Start it with one of ${LINK_KINDS.join(', ')}, or give a URL.`)
  }
  return { kind: word, value: word === 'pr' ? rest.replace(/^#/, '') : rest }
}

/**
 * The refusal of an artifact given as a link: links are what the work
 * produced, and an artifact is something it follows.
 *
 * @param {string} where
 * @param {string} address
 */
function artifactLink(where, address) {
  return invalid(
    `${where}: ${address ? `${address} is a claude.ai artifact, which` : 'a claude.ai artifact is something'} the work follows rather than produces. Add it to references, with a use line saying when to read it.`
  )
}

/**
 * The link to remove: by its value, or as "kind value".
 *
 * @param {WorkStore} store
 * @param {number} uid
 * @param {unknown} value
 * @param {string} where
 */
function findLink(store, uid, value, where) {
  const links = store.getItem(uid, { logLimit: 0 }).links
  const wanted = typeof value === 'string' ? value.trim() : ''
  /** @type {{ kind: string, value: string } | null} */
  let written = null
  try {
    written = parseLink(wanted, where)
  } catch {
    // Not "kind value": match the value alone.
  }
  const match = links.filter(
    (link) =>
      link.value === wanted ||
      (link.kind === 'pr' && `#${link.value}` === wanted) ||
      (written !== null && link.kind === written.kind && link.value === written.value)
  )
  if (match.length === 0) throw notFound(`${where}: there is no link ${wanted || String(value)}.`)
  if (match.length > 1) throw invalid(`${where}: ${wanted} matches more than one link. Write it as "kind value".`)
  return match[0]
}

// -----------------------------------------------------------------------------
// References: what the work follows, on a portfolio, a project, an epic or a
// task. Each says when to read it in its `use` line; the agent reads it with
// its own tools.

const REFERENCE_FIELDS = ['target', 'title', 'use', 'kind', 'key']
const USE_EXAMPLE = 'a line saying when to read it, like "Read when changing the sync engine"'

/**
 * A reference as an agent writes one: `{ target, title, use, kind?, key? }`.
 * The kind comes from the target when it is not given, and one that is given
 * must fit it. A file may be written absolute, under `~` or relative to the
 * session's folder; it comes back absolute. `use` may be missing here: a new
 * reference needs one, and `requireUse` says so.
 *
 * @param {unknown} value
 * @param {string} where
 * @param {Paths} paths
 * @returns {ReferenceInput}
 */
export function parseReference(value, where, paths) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${where}: a reference is {target, title, use}, with kind and key when wanted.`)
  }
  const reference = /** @type {Record<string, unknown>} */ (value)
  only(reference, REFERENCE_FIELDS, where)
  const written = stringArg(reference.target, `${where}.target`)
  const kind = reference.kind === undefined ? inferRefKind(written) : refKindArg(reference.kind, `${where}.kind`)
  return {
    kind,
    target: referenceTarget(kind, written, reference.kind !== undefined, where, paths),
    ...referenceFields(reference, where)
  }
}

/**
 * The title, use and key of a reference, those given.
 *
 * @param {Record<string, unknown>} reference
 * @param {string} where
 * @returns {{ title?: string, use?: string, key?: boolean }}
 */
function referenceFields(reference, where) {
  /** @type {{ title?: string, use?: string, key?: boolean }} */
  const fields = {}
  if (reference.title !== undefined) fields.title = textArg(reference.title, `${where}.title`).trim()
  if (reference.use !== undefined) {
    if (typeof reference.use !== 'string' || reference.use.trim() === '') throw invalid(`${where}.use must be ${USE_EXAMPLE}.`)
    fields.use = reference.use.trim()
  }
  if (reference.key !== undefined) {
    if (typeof reference.key !== 'boolean') throw invalid(`${where}.key is true or false: true shows it on everything under its owner.`)
    fields.key = reference.key
  }
  return fields
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {RefKind}
 */
function refKindArg(value, where) {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : value
  if (!REF_KINDS.includes(/** @type {any} */ (kind))) {
    throw invalid(`${where} is ${REF_KINDS.join(', ').replace(/, (?=[^,]*$)/, ' or ')}, not ${JSON.stringify(value)}. Leave it out to have it worked out from the target.`)
  }
  return /** @type {RefKind} */ (kind)
}

/**
 * A target checked against its kind: an artifact's claude.ai address, a doc's
 * or url's web address, or a file as an absolute path.
 *
 * @param {RefKind} kind
 * @param {string} target
 * @param {boolean} given whether the kind was given rather than worked out
 * @param {string} where
 * @param {Paths} paths
 */
function referenceTarget(kind, target, given, where, paths) {
  if (kind === 'artifact' && !isArtifactAddress(target)) {
    throw invalid(`${where}.kind is artifact, but ${target} is not a claude.ai artifact, whose address is like https://claude.ai/artifact/…. Leave kind out to have it worked out from the target.`)
  }
  if ((kind === 'doc' || kind === 'url') && !isWebAddress(target)) {
    throw invalid(`${where}.kind is ${kind}, but ${target} is not a web address. Leave kind out for a file.`)
  }
  if (kind !== 'file') return target
  if (given && isWebAddress(target)) throw invalid(`${where}.kind is file, but ${target} is a web address. Leave kind out, or use url or doc.`)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) throw invalid(`${where}.target: ${target} is not a web address or a file path.`)
  const path = filePath(target, paths)
  if (path === null) throw invalid(`${where}.target: ${target} is a relative path, and this session has no folder to read it from. Give the file's full path.`)
  return path
}

/**
 * A file as an agent writes it, as an absolute path: under `~`, relative to
 * the session's folder, or already absolute. Null when it is relative and
 * there is no folder.
 *
 * @param {string} written
 * @param {Paths} paths
 */
function filePath(written, paths) {
  let path = written
  if (path === '~' || /^~[\\/]/.test(path)) path = join(paths.home, path.slice(1))
  else if (!isAbsolute(path) && paths.cwd) path = resolve(paths.cwd, path)
  return absoluteFolder(path)
}

/**
 * @param {ReferenceInput} input
 * @param {string} where
 */
function requireUse(input, where) {
  if (input.use === undefined) throw invalid(`${where}.use is missing: a reference needs ${USE_EXAMPLE}.`)
}

/**
 * The references of a create, checked before anything is made: each is new,
 * so each needs its use line.
 *
 * @param {Context} context
 * @param {unknown} value
 * @param {string} where
 * @returns {ReferenceInput[]}
 */
function referencesFor(context, value, where) {
  if (value === undefined) return []
  return listArg(value, where).map((entry, index) => {
    const input = parseReference(entry, `${where}[${index}]`, context.paths())
    requireUse(input, `${where}[${index}]`)
    return input
  })
}

/**
 * @param {WorkStore} store
 * @param {RefOwner} owner
 * @param {ReferenceInput[]} inputs
 * @param {string} where
 */
function addReferences(store, owner, inputs, where) {
  inputs.forEach((input, index) => refusedAt(`${where}[${index}]`, () => store.addRef(owner, input)))
}

/**
 * Reference operations on one owner, in this order: `add` (a new reference,
 * or new fields for one with the same kind and target), `set` (the title, use
 * or key of one found by its target) and `remove` (by target). Adding one
 * that is there already changes only the fields given.
 *
 * @param {Context} context
 * @param {RefOwner} owner
 * @param {unknown} value
 * @param {string} where
 * @returns {string[]} the parts of the reply line: "ref +2", "ref edited 1"
 */
function applyReferences(context, owner, value, where) {
  const { store } = context
  const ops = objectArg(value, where)
  only(ops, ['add', 'set', 'remove'], where)
  /** @type {Reference[]} */
  const added = []
  /** @type {Reference[]} */
  const edited = []
  /** @type {Reference[]} */
  const removed = []

  /**
   * @param {Reference | undefined} before
   * @param {Reference} after
   */
  const record = (before, after) => {
    if (before === undefined) added.push(after)
    else if (before.title !== after.title || before.use !== after.use || before.key !== after.key) edited.push(after)
  }

  listArg(ops.add ?? [], `${where}.add`).forEach((entry, index) => {
    const at = `${where}.add[${index}]`
    const input = parseReference(entry, at, context.paths())
    const before = store.listRefs(owner).find((reference) => reference.kind === input.kind && sameTarget(reference, input.target))
    if (before === undefined) requireUse(input, at)
    record(before, refusedAt(at, () => store.addRef(owner, input)))
  })

  listArg(ops.set ?? [], `${where}.set`).forEach((entry, index) => {
    const at = `${where}.set[${index}]`
    const change = objectArg(entry, at)
    only(change, REFERENCE_FIELDS, at)
    const before = findReference(context, owner, change, at)
    const fields = referenceFields(change, at)
    if (Object.keys(fields).length === 0) throw invalid(`${at} changes nothing. Give title, use or key.`)
    record(before, refusedAt(at, () => store.addRef(owner, { kind: before.kind, target: before.target, ...fields })))
  })

  listArg(ops.remove ?? [], `${where}.remove`).forEach((entry, index) => {
    const at = `${where}.remove[${index}]`
    const named = typeof entry === 'string' ? { target: entry } : objectArg(entry, at)
    only(named, ['target', 'kind'], at)
    const reference = findReference(context, owner, named, at)
    store.removeRef(owner, reference.uid)
    removed.push(reference)
  })

  return refParts(added, removed, edited)
}

/**
 * The reference of an owner that `named.target` names, as get shows it or as
 * it was written. `named.kind` picks between two with the same target.
 *
 * @param {Context} context
 * @param {RefOwner} owner
 * @param {Record<string, unknown>} named
 * @param {string} where
 * @returns {Reference}
 */
function findReference(context, owner, named, where) {
  const target = stringArg(named.target, `${where}.target`)
  const kind = named.kind === undefined ? undefined : refKindArg(named.kind, `${where}.kind`)
  const path = isWebAddress(target) ? null : filePath(target, context.paths())
  const matches = context.store
    .listRefs(owner)
    .filter((reference) => (kind === undefined || reference.kind === kind) && (reference.target === target || (path !== null && sameTarget(reference, path))))
  if (matches.length === 0) throw notFound(`${where}: there is no reference ${target}. Name it by its target, as get shows it.`)
  if (matches.length > 1) {
    throw invalid(`${where}: ${target} is more than one reference (${matches.map((reference) => reference.kind).join(', ')}). Give {target, kind}.`)
  }
  return matches[0]
}

/**
 * Whether a reference points at `target`: a file's path compared the way
 * folders are, anything else exactly.
 *
 * @param {Reference} reference
 * @param {string} target as `parseReference` gives it
 */
function sameTarget(reference, target) {
  if (reference.kind !== 'file') return reference.target === target
  return isAbsolute(target) && normalFolder(reference.target) === normalFolder(target)
}

// -----------------------------------------------------------------------------
// Argument checks. Helm does not check arguments against the schema, so every
// one is checked here, and a mistake says which field.

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} fields
 * @param {string} where
 */
function only(value, fields, where) {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key))
  if (unknown.length > 0) {
    throw invalid(`${where} does not take ${unknown.map((key) => `"${key}"`).join(', ')}. It takes ${fields.join(', ')}.`)
  }
}

/**
 * @param {unknown} value
 * @param {string} tool
 * @returns {Record<string, unknown>[]}
 */
function batch(value, tool) {
  if (!Array.isArray(value) || value.length === 0) throw invalid(`${tool} takes items: a list of at least one item.`)
  if (value.length > MAX_BATCH) throw invalid(`${tool} takes ${MAX_BATCH} items at most.`)
  return value.map((item, index) => objectArg(item, `items[${index}]`))
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function objectArg(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${where} must be an object.`)
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {unknown[]}
 */
function listArg(value, where) {
  if (!Array.isArray(value)) throw invalid(`${where} must be a list.`)
  return value
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function stringArg(value, where) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${where} must be text.`)
  return value.trim()
}

/**
 * Text that may be empty.
 *
 * @param {unknown} value
 * @param {string} where
 */
function textArg(value, where) {
  if (typeof value !== 'string') throw invalid(`${where} must be text.`)
  return value
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function stringList(value, where) {
  return listArg(value, where).map((text, index) => stringArg(text, `${where}[${index}]`))
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function numberList(value, where) {
  return listArg(value, where).map((n) => {
    if (typeof n !== 'number' || !Number.isInteger(n)) throw invalid(`${where} is a list of criterion numbers, like [1, 3].`)
    return n
  })
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {number} min
 * @param {number} max
 * @returns {number | undefined}
 */
function intArg(value, where, min, max) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(`${where} is a whole number from ${min} to ${max}.`)
  return value
}

/**
 * An item named by a ref from this call or by its ID.
 *
 * @param {unknown} value
 * @param {Map<string, number> | null} refs the refs of this call; null where refs are not taken
 * @param {string} where
 * @returns {number | string}
 */
function itemFrom(value, refs, where) {
  const or = refs === null ? '' : ' or a ref from this call'
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${where} must be an ID like TC-123${or}.`)
  const text = value.trim()
  const ref = refs?.get(text)
  if (ref !== undefined) return ref
  if (ITEM_ID.test(text)) return text
  throw invalid(`${where}: ${text} is not an ID${or}.`)
}

/**
 * @param {unknown} value
 * @returns {Session}
 */
function sessionOf(value) {
  const session = /** @type {Partial<Session> | null | undefined} */ (value)
  return {
    id: typeof session?.id === 'string' && session.id ? session.id : 'unknown',
    name: typeof session?.name === 'string' && session.name.trim() ? session.name.trim() : 'a session',
    cwd: typeof session?.cwd === 'string' ? session.cwd : ''
  }
}
