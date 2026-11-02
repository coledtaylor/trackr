import { OPEN_GROUPS } from './model.mjs'

/**
 * A sequence as the pages and tools read it, worked out from rows the store
 * has already read. Pure, so the tests can build one from plain data.
 *
 * A sequence is the stages a piece of work is done in, in order. It belongs
 * to its owner: an initiative, or an epic outside one. A stage holds items of
 * the owner, each in at most one stage: an initiative's epics (the whole
 * epic) and their tasks, or an epic's tasks.
 *
 * - An epic in a stage stands for its tasks that are not in a stage of their
 *   own: the rest of it. A task's stage is its own, else its epic's.
 * - A stage counts the tasks it covers, cancelled ones left out: they are not
 *   work left or done. An epic with no tasks at all counts as one, by its own
 *   status.
 * - Dependencies stay what they are. A stage that comes before something its
 *   item waits on, still open, is out of order: shown, never refused.
 */

/**
 * @typedef {import('./store.mjs').ItemSummary} ItemSummary
 * @typedef {import('./store.mjs').PlanOwner} PlanOwner
 * @typedef {'empty' | 'not-started' | 'active' | 'done'} StageState
 * @typedef {{ done: number, active: number, total: number }} Tally
 * @typedef {ItemSummary & { rest: (Tally & { tasks: string[] }) | null }} PlanEntry an epic's `rest` is its tasks not in a stage of their own
 * @typedef {{ uid: number, n: number, title: string, goal: string, state: StageState, items: PlanEntry[] } & Tally} Stage
 * @typedef {{ item: string, stage: number, waitsOn: string, waitsOnStage: number }} Conflict
 * @typedef {{
 *   owner: PlanOwner,
 *   stages: Stage[],
 *   current: number | null,
 *   progress: Tally,
 *   epics: (ItemSummary & { progress: Tally })[],
 *   unplaced: ItemSummary[],
 *   conflicts: Conflict[]
 * }} Plan
 * @typedef {Omit<Stage, 'items' | 'goal'>} StageSummary
 * @typedef {ItemSummary & { epics: number, progress: Tally, stages: StageSummary[], current: number | null, unplaced: number, conflicts: number }} InitiativeOverview
 * @typedef {{ uid: number, n: number, title: string }} StageChoice
 * @typedef {{ id: number, position: number, title: string, goal: string }} StageRow
 * @typedef {{ item: number, stage: number }} PlacementRow in stage order, then their order in the stage
 * @typedef {{ item: number, waitsOn: number }} Edge
 */

const OPEN = new Set(/** @type {readonly string[]} */ (OPEN_GROUPS))

/**
 * @param {PlanOwner} owner
 * @param {StageRow[]} stageRows the owner's stages, in order
 * @param {PlacementRow[]} placements the owner's stages' items
 * @param {ItemSummary[]} epics an initiative's epics; none for an epic
 * @param {ItemSummary[]} tasks the tasks of the work it plans: an initiative's epics' or an epic's
 * @param {Edge[]} edges dependencies between those items; others are ignored
 * @returns {Plan}
 */
export function buildPlan(owner, stageRows, placements, epics, tasks, edges) {
  /** @type {Map<number, ItemSummary>} */
  const byUid = new Map([...epics, ...tasks].map((item) => [item.uid, item]))
  /** @type {Map<number, number>} the stage number of each placed item, by uid */
  const placedIn = new Map()
  const numberOf = new Map(stageRows.map((row, index) => [row.id, index + 1]))
  for (const placement of placements) {
    const n = numberOf.get(placement.stage)
    if (n !== undefined && byUid.has(placement.item)) placedIn.set(placement.item, n)
  }
  /** @type {Map<string, number>} each epic's uid by its ID, for the tasks that name it */
  const epicUid = new Map(epics.map((epic) => [epic.id, epic.uid]))
  /** @param {ItemSummary} task */
  const epicOf = (task) => (task.epic ? epicUid.get(task.epic.id) : undefined)

  /** A task's stage: its own, else its epic's. @param {ItemSummary} item */
  const stageOf = (item) => {
    const own = placedIn.get(item.uid)
    if (own !== undefined || item.kind !== 'task') return own
    const epic = epicOf(item)
    return epic === undefined ? undefined : placedIn.get(epic)
  }

  const stages = stageRows.map((row, index) => {
    /** @type {PlanEntry[]} */
    const items = []
    const tally = { done: 0, active: 0, total: 0 }
    for (const placement of placements) {
      if (placement.stage !== row.id) continue
      const item = byUid.get(placement.item)
      if (item === undefined) continue
      if (item.kind === 'epic') {
        const own = tasks.filter((task) => epicOf(task) === item.uid)
        const rest = own.filter((task) => !placedIn.has(task.uid))
        const counted = own.length === 0 ? [item] : rest
        add(tally, counted)
        items.push({ ...item, rest: { ...count(rest), tasks: rest.map((task) => task.id) } })
      } else {
        add(tally, [item])
        items.push({ ...item, rest: null })
      }
    }
    return { uid: row.id, n: index + 1, title: row.title, goal: row.goal, state: stateOf(items.length, tally), items, ...tally }
  })

  const current = stages.find((stage) => stage.state === 'not-started' || stage.state === 'active')?.n ?? null

  const unplaced = [
    ...epics.filter((epic) => OPEN.has(epic.status.group) && !placedIn.has(epic.uid) && !tasks.some((task) => epicOf(task) === epic.uid)),
    ...tasks.filter((task) => OPEN.has(task.status.group) && stageOf(task) === undefined)
  ]

  /** @type {Conflict[]} */
  const conflicts = []
  for (const edge of edges) {
    const item = byUid.get(edge.item)
    const other = byUid.get(edge.waitsOn)
    if (item === undefined || other === undefined) continue
    if (!OPEN.has(item.status.group) || !OPEN.has(other.status.group)) continue
    const stage = stageOf(item)
    const waitsOnStage = stageOf(other)
    if (stage === undefined || waitsOnStage === undefined || waitsOnStage <= stage) continue
    conflicts.push({ item: item.id, stage, waitsOn: other.id, waitsOnStage })
  }
  conflicts.sort((a, b) => a.stage - b.stage || idNumber(a.item) - idNumber(b.item) || idNumber(a.waitsOn) - idNumber(b.waitsOn))

  // All the work it plans: every task, and each epic with no tasks as one.
  const progress = count([...tasks, ...epics.filter((epic) => !tasks.some((task) => epicOf(task) === epic.uid))])

  const withProgress = epics.map((epic) => ({ ...epic, progress: count(tasks.filter((task) => epicOf(task) === epic.uid)) }))
  return { owner, stages, current, progress, epics: withProgress, unplaced, conflicts }
}

/**
 * An initiative as the portfolio page lists it: how far along its work is,
 * its stages without their items, and how much of the plan needs a look.
 *
 * @param {ItemSummary} initiative
 * @param {Plan} plan its sequence
 * @returns {InitiativeOverview}
 */
export function initiativeOverview(initiative, plan) {
  return {
    ...initiative,
    epics: plan.epics.length,
    progress: plan.progress,
    stages: plan.stages.map(({ uid, n, title, state, done, active, total }) => ({ uid, n, title, state, done, active, total })),
    current: plan.current,
    unplaced: plan.unplaced.length,
    conflicts: plan.conflicts.length
  }
}

/**
 * What a stage is, from what is in it: empty, finished when every task it
 * covers is done (or it holds only cancelled work), under way when anything
 * in it is started or done, else not started.
 *
 * @param {number} entries
 * @param {Tally} tally
 * @returns {StageState}
 */
export function stateOf(entries, tally) {
  if (entries === 0) return 'empty'
  if (tally.done === tally.total) return 'done'
  if (tally.active > 0 || tally.done > 0) return 'active'
  return 'not-started'
}

/**
 * The stages an item can be put in, as a picker offers them.
 *
 * @param {StageRow[]} stageRows in order
 * @returns {StageChoice[]}
 */
export function stageChoices(stageRows) {
  return stageRows.map((row, index) => ({ uid: row.id, n: index + 1, title: row.title }))
}

/**
 * @param {Tally} tally
 * @param {ItemSummary[]} items
 */
function add(tally, items) {
  const counted = count(items)
  tally.done += counted.done
  tally.active += counted.active
  tally.total += counted.total
}

/**
 * @param {ItemSummary[]} items
 * @returns {Tally}
 */
function count(items) {
  const counted = items.filter((item) => item.status.group !== 'closed')
  return {
    done: counted.filter((item) => item.status.group === 'done').length,
    active: counted.filter((item) => item.status.group === 'active').length,
    total: counted.length
  }
}

/** @param {string} id */
function idNumber(id) {
  return Number(id.slice(id.lastIndexOf('-') + 1))
}
