import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { SEP, changeParts, linkParts } from './changes.mjs'
import { WorkError, invalid, notFound } from './errors.mjs'
import { displayFolder } from './folders.mjs'
import { ITEM_ID, LINK_KINDS, OPEN_GROUPS, PROJECT_COLOURS, isArtifactAddress } from './model.mjs'

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
/** @typedef {{ id: string, name: string, cwd: string }} Session */
/** @typedef {{ now?: () => Date, timeZone?: string, home?: string }} Format */

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
 * @param {Context} context
 * @param {Record<string, unknown>} args
 */
function get(context, args) {
  only(args, ['ids', 'log'], 'get')
  const ids = Array.isArray(args.ids) ? args.ids : args.ids === undefined ? [] : [args.ids]
  if (ids.length === 0 || ids.some((id) => typeof id !== 'string')) throw invalid('ids is a list of IDs, like ["TC-123"].')
  if (ids.length > MAX_BATCH) throw invalid(`get takes ${MAX_BATCH} IDs at most.`)
  const logLimit = intArg(args.log, 'log', 0, 1000) ?? LOG_DEFAULT
  const blocks = ids.map((id) => {
    try {
      return detail(context, context.store.getItem(/** @type {string} */ (id), { logLimit }))
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
  const links = item.links.filter((link) => link.kind !== 'artifact')
  if (links.length > 0) lines.push(`links: ${links.map(linkText).join(SEP)}`)

  if (item.description) lines.push('', '## Description', item.description)
  const own = item.links.filter((link) => link.kind === 'artifact')
  const artifacts = [
    ...own.map((link) => artifactLine(link, null)),
    ...item.epicArtifacts.filter((link) => !own.some((mine) => mine.value === link.value)).map((link) => artifactLine(link, item.epic?.id ?? null))
  ]
  if (artifacts.length > 0) {
    lines.push('', '## Artifacts', 'Mockups and design documents for this work. Read one with the Artifact tool (action read) when the work touches it.')
    lines.push(...artifacts)
  }
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
 * Settings page mockup · https://claude.ai/artifact/abc · from epic TC-118
 *
 * @param {{ value: string, label: string }} link
 * @param {string | null} epic the epic it comes from, when it is not the item's own
 */
function artifactLine(link, epic) {
  return [link.label, link.value, epic ? `from epic ${epic}` : ''].filter(Boolean).join(SEP)
}

// -----------------------------------------------------------------------------
// create

const CREATE_KINDS = /** @type {const} */ (['task', 'epic', 'project', 'portfolio'])
const CREATE_FIELDS = ['ref', 'kind', 'project', 'epic', 'title', 'description', 'status', 'priority', 'ac', 'waitsOn', 'links', 'artifacts']
const PORTFOLIO_FIELDS = ['kind', 'key', 'name', 'description']
const PROJECT_FIELDS = ['kind', 'portfolio', 'name', 'colour', 'folders']

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
  const portfolio = refusedAt(where, () =>
    context.store.createPortfolio({
      key: stringArg(input.key, `${where}.key`),
      name: stringArg(input.name, `${where}.name`),
      description: input.description === undefined ? undefined : textArg(input.description, `${where}.description`)
    })
  )
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
  const project = refusedAt(where, () => context.store.createProject({ portfolio, name, colour, folders }))
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
    const item = store.createItem({
      kind: /** @type {any} */ (input.kind),
      project,
      title: /** @type {string} */ (input.title),
      description: /** @type {string | undefined} */ (input.description),
      status: /** @type {string | undefined} */ (input.status),
      priority: /** @type {string | undefined} */ (input.priority),
      criteria: input.ac === undefined ? undefined : stringList(input.ac, `${where}.ac`),
      links: [
        ...(input.links === undefined ? [] : listArg(input.links, `${where}.links`).map((link) => parseLink(link, `${where}.links`))),
        ...(input.artifacts === undefined ? [] : listArg(input.artifacts, `${where}.artifacts`).map((link) => parseArtifact(link, `${where}.artifacts`)))
      ],
      by: session.name
    })
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

const UPDATE_FIELDS = ['id', 'title', 'description', 'status', 'priority', 'project', 'epic', 'ac', 'handoff', 'log', 'links', 'artifacts', 'waitsOn']

/**
 * Several items in one call: fields, criteria, handoff, a log line, links,
 * artifacts, dependencies. One line per item, then what became ready. All of it lands or
 * none of it does.
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
  const id = stringArg(input.id, `${where}.id`)
  only(input, UPDATE_FIELDS, id)
  const before = store.getItem(id, { logLimit: 0 })
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
  for (const field of /** @type {const} */ (['links', 'artifacts'])) {
    if (input[field] === undefined) continue
    const ops = objectArg(input[field], `${where}.${field}`)
    only(ops, ['add', 'remove'], `${where}.${field}`)
    const parse = field === 'links' ? parseLink : parseArtifact
    for (const value of ops.add === undefined ? [] : listArg(ops.add, `${where}.${field}.add`)) {
      linksAdded.push(store.addLink(before.uid, parse(value, `${where}.${field}.add`)))
    }
    for (const value of ops.remove === undefined ? [] : listArg(ops.remove, `${where}.${field}.remove`)) {
      const link =
        field === 'links' ? findLink(store, before.uid, value, `${where}.links.remove`) : findArtifact(store, before.uid, value, `${where}.artifacts.remove`)
      store.removeLink(before.uid, link.uid)
      linksRemoved.push(link)
    }
  }
  parts.push(...linkParts(linksAdded, linksRemoved))

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
 * A bare claude.ai artifact address is an artifact.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {{ kind: string, value: string, label?: string }}
 */
export function parseLink(value, where) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const link = /** @type {Record<string, unknown>} */ (value)
    only(link, ['kind', 'value', 'label'], where)
    return {
      kind: typeof link.kind === 'string' ? link.kind.trim().toLowerCase() : '',
      value: typeof link.value === 'string' && link.kind === 'pr' ? link.value.replace(/^#/, '') : /** @type {string} */ (link.value),
      label: /** @type {string | undefined} */ (link.label)
    }
  }
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${where}: a link is a string like "branch feat/x" or {kind, value, label}.`)
  const text = value.trim()
  if (/^https?:\/\/\S+$/i.test(text)) return { kind: isArtifactAddress(text) ? 'artifact' : 'url', value: text }
  const space = text.search(/\s/)
  const word = (space < 0 ? text : text.slice(0, space)).toLowerCase()
  const rest = space < 0 ? '' : text.slice(space).trim()
  if (!LINK_KINDS.includes(/** @type {any} */ (word)) || rest === '') {
    throw invalid(`${where}: "${text}" is not a link. Start it with one of ${LINK_KINDS.join(', ')}, or give a URL.`)
  }
  return { kind: word, value: word === 'pr' ? rest.replace(/^#/, '') : rest }
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

/**
 * An artifact as an agent writes one: its claude.ai address, or
 * `{ url, label }` where the label says what it is ("Settings page mockup").
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {{ kind: 'artifact', value: string, label?: string }}
 */
export function parseArtifact(value, where) {
  /** @type {unknown} */
  let url = value
  /** @type {string | undefined} */
  let label
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const artifact = /** @type {Record<string, unknown>} */ (value)
    only(artifact, ['url', 'label'], where)
    url = artifact.url
    label = artifact.label === undefined ? undefined : textArg(artifact.label, `${where}.label`).trim()
  }
  if (typeof url !== 'string' || !isArtifactAddress(url)) {
    const shown = typeof url === 'string' ? `"${url.trim()}"` : 'that'
    throw invalid(`${where}: ${shown} is not a claude.ai artifact. Give its address, like https://claude.ai/artifact/…, or {url, label}.`)
  }
  return { kind: 'artifact', value: url.trim(), label }
}

/**
 * The artifact to remove, by its address.
 *
 * @param {WorkStore} store
 * @param {number} uid
 * @param {unknown} value
 * @param {string} where
 */
function findArtifact(store, uid, value, where) {
  const wanted = typeof value === 'string' ? value.trim() : ''
  const link = store.getItem(uid, { logLimit: 0 }).links.find((candidate) => candidate.kind === 'artifact' && candidate.value === wanted)
  if (link === undefined) throw notFound(`${where}: there is no artifact ${wanted || String(value)}.`)
  return link
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
