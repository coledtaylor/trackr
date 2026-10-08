import { displayFolder } from './folders.mjs'
import { OPEN_GROUPS } from './model.mjs'

/**
 * What the portfolio and project views show, worked out from rows the store
 * has already read. Pure: the clock and home folder come in as arguments, so
 * the tests can pin them.
 *
 * Counts are of tasks. An epic is a container; its own status says little
 * about how much work is open.
 *
 * Days are local calendar days of the machine the service runs on, which is
 * the machine the person is at.
 */

/**
 * @typedef {import('./store.mjs').ItemSummary} ItemSummary
 * @typedef {import('./store.mjs').Portfolio} Portfolio
 * @typedef {import('./store.mjs').Project} Project
 * @typedef {import('./store.mjs').StatusGroup} StatusGroup
 * @typedef {{ item: number, grp: StatusGroup, at: string }} HistoryRow
 * @typedef {{ project: number, done: number, active: number, open: number }} EpicCell
 * @typedef {ItemSummary & { done: number, total: number, cells: EpicCell[] }} EpicOverview
 * @typedef {{ id: string, uid: number, title: string, project: { uid: number, name: string, colour: string } }} Blocker
 * @typedef {Project & { place: string | null }} PlacedProject
 */

export const SERIES_DAYS = 14

const OPEN = new Set(/** @type {readonly string[]} */ (OPEN_GROUPS))
const DAY_MS = 24 * 60 * 60 * 1000

/** @param {Date} date */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * @param {Date} date
 * @param {number} days
 */
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/**
 * History rows by item, each item's rows oldest first.
 *
 * @param {HistoryRow[]} history
 */
function byItem(history) {
  /** @type {Map<number, { grp: StatusGroup, at: number }[]>} */
  const items = new Map()
  for (const row of history) {
    const list = items.get(row.item) ?? []
    list.push({ grp: row.grp, at: Date.parse(row.at) })
    items.set(row.item, list)
  }
  for (const list of items.values()) list.sort((a, b) => a.at - b.at)
  return items
}

/**
 * Open tasks at the end of each of the last `days` days, oldest first. The
 * last value is now.
 *
 * @param {HistoryRow[]} history tasks only
 * @param {Date} now
 * @param {number} [days]
 * @returns {number[]}
 */
export function openSeries(history, now, days = SERIES_DAYS) {
  const today = startOfDay(now)
  /** @type {number[]} */
  const ends = []
  for (let k = 0; k < days - 1; k++) ends.push(addDays(today, k - (days - 2)).getTime())
  ends.push(now.getTime() + 1)
  const series = new Array(days).fill(0)
  for (const rows of byItem(history).values()) {
    let last = -1
    for (let k = 0; k < days; k++) {
      while (last + 1 < rows.length && rows[last + 1].at < ends[k]) last += 1
      if (last >= 0 && OPEN.has(rows[last].grp)) series[k] += 1
    }
  }
  return series
}

/**
 * Tasks done now that were finished this week, Monday to Sunday, by the day
 * they last entered the done group.
 *
 * @param {HistoryRow[]} history tasks only
 * @param {Set<number>} doneNow uids of tasks in the done group now
 * @param {Date} now
 * @returns {number[]} seven counts, Monday first
 */
export function doneThisWeek(history, doneNow, now) {
  const today = startOfDay(now)
  const monday = addDays(today, -((today.getDay() + 6) % 7))
  const start = monday.getTime()
  const end = addDays(monday, 7).getTime()
  const days = new Array(7).fill(0)
  for (const [item, rows] of byItem(history)) {
    if (!doneNow.has(item)) continue
    const finished = rows.filter((row) => row.grp === 'done').at(-1)
    if (!finished || finished.at < start || finished.at >= end) continue
    days[Math.floor((startOfDay(new Date(finished.at)).getTime() - start) / DAY_MS + 0.5)] += 1
  }
  return days
}

/**
 * @param {Project} project
 * @param {string} home
 * @returns {PlacedProject}
 */
export function placed(project, home) {
  return { ...project, place: project.folders.length > 0 ? displayFolder(project.folders[0], home) : null }
}

/**
 * Everything the portfolio view shows.
 *
 * @param {Portfolio} portfolio
 * @param {ItemSummary[]} items every item in the portfolio, next up first
 * @param {HistoryRow[]} history the portfolio's tasks' status history
 * @param {{ now: Date, home: string }} context
 */
export function portfolioOverview(portfolio, items, history, { now, home }) {
  const tasks = items.filter((item) => item.kind === 'task')
  const byId = new Map(items.map((item) => [item.id, item]))
  const active = tasks.filter((task) => task.status.group === 'active')
  const series = openSeries(history, now)
  const week = doneThisWeek(history, new Set(tasks.filter((task) => task.status.group === 'done').map((task) => task.uid)), now)

  const waiting = tasks
    .filter((task) => OPEN.has(task.status.group) && task.waitingOn.length > 0)
    .map((task) => ({
      item: task,
      waitsOn: task.waitingOn
        .map((id) => byId.get(id))
        .filter((blocker) => blocker !== undefined)
        .map((blocker) => ({ id: blocker.id, uid: blocker.uid, title: blocker.title, project: blocker.project }))
    }))
  const crossProject = waiting.filter(({ item, waitsOn }) => waitsOn.some((blocker) => blocker.project.uid !== item.project.uid)).length
  const sessions = [...new Set(active.filter((task) => task.session !== null).map((task) => /** @type {any} */ (task.session).name))]

  return {
    portfolio: { ...portfolio, projects: portfolio.projects.map((project) => placed(project, home)) },
    stats: {
      open: { count: tasks.filter((task) => OPEN.has(task.status.group)).length, series, days: SERIES_DAYS },
      active: { count: active.length, sessions, withSession: active.filter((task) => task.session !== null).length },
      waiting: { count: waiting.length, crossProject },
      done: { count: week.reduce((sum, n) => sum + n, 0), days: week }
    },
    epics: epicsOf(items, portfolio.projects),
    active,
    waiting
  }
}

/**
 * Each epic with its tasks counted per project, in the portfolio's project
 * order. Cancelled tasks are not counted: they are not work left or done.
 *
 * @param {ItemSummary[]} items
 * @param {Project[]} projects
 * @returns {EpicOverview[]}
 */
export function epicsOf(items, projects) {
  const epics = items.filter((item) => item.kind === 'epic')
  return epics.map((epic) => {
    const tasks = items.filter((item) => item.kind === 'task' && item.epic?.id === epic.id && item.status.group !== 'closed')
    const cells = projects
      .map((project) => {
        const mine = tasks.filter((task) => task.project.uid === project.uid)
        return {
          project: project.uid,
          done: mine.filter((task) => task.status.group === 'done').length,
          active: mine.filter((task) => task.status.group === 'active').length,
          open: mine.filter((task) => task.status.group === 'not-started').length
        }
      })
      .filter((cell) => cell.done + cell.active + cell.open > 0)
    return {
      ...epic,
      done: tasks.filter((task) => task.status.group === 'done').length,
      total: tasks.length,
      cells
    }
  })
}

/**
 * An epic's tasks as a tree of what waits on what, for reading top-down in
 * the order the work can happen. A task hangs from the task it waits on that
 * is deepest in the chain, so its depth is the length of its longest chain of
 * waits; a task that waits on nothing in the epic is a root. Each task shows
 * once, and siblings keep the order they come in.
 *
 * @param {number[]} tasks the epic's task uids, in the order to show siblings
 * @param {{ item: number, waitsOn: number }[]} edges dependencies between them; others are ignored
 * @returns {{ uid: number, depth: number }[]}
 */
export function orderOf(tasks, edges) {
  const index = new Map(tasks.map((uid, position) => [uid, position]))
  /** @type {Map<number, number[]>} */
  const waits = new Map()
  for (const edge of edges) {
    if (!index.has(edge.item) || !index.has(edge.waitsOn) || edge.item === edge.waitsOn) continue
    const list = waits.get(edge.item) ?? []
    list.push(edge.waitsOn)
    waits.set(edge.item, list)
  }

  /** @type {Map<number, number>} */
  const depths = new Map()
  /** @type {Set<number>} */
  const visiting = new Set()
  /** @param {number} uid @returns {number} */
  const depthOf = (uid) => {
    const known = depths.get(uid)
    if (known !== undefined) return known
    // The store refuses cycles; one in old data still must not loop.
    if (visiting.has(uid)) return 0
    visiting.add(uid)
    const parents = waits.get(uid) ?? []
    const depth = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(depthOf))
    visiting.delete(uid)
    depths.set(uid, depth)
    return depth
  }

  /** @type {Map<number, number[]>} */
  const children = new Map()
  /** @type {number[]} */
  const roots = []
  for (const uid of tasks) {
    const parents = waits.get(uid)
    if (!parents) {
      roots.push(uid)
      continue
    }
    let parent = parents[0]
    for (const candidate of parents) {
      const deeper = depthOf(candidate) - depthOf(parent)
      if (deeper > 0 || (deeper === 0 && Number(index.get(candidate)) < Number(index.get(parent)))) parent = candidate
    }
    const list = children.get(parent) ?? []
    list.push(uid)
    children.set(parent, list)
  }

  /** @type {{ uid: number, depth: number }[]} */
  const rows = []
  /** @param {number} uid @param {number} depth */
  const walk = (uid, depth) => {
    rows.push({ uid, depth })
    for (const child of children.get(uid) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return rows
}
