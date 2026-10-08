import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { doneThisWeek, epicsOf, openSeries } from '../service/overview.mjs'
import { WorkStore } from '../service/store.mjs'
import { tempDir } from './helpers.mjs'

/** Local time: the views count local calendar days. */
const at = (/** @type {number} */ day, hour = 12) => new Date(2026, 9, day, hour).toISOString()

/** A store whose clock the test sets. */
function clockStore(file = ':memory:') {
  let now = new Date(2026, 9, 1, 9)
  const store = new WorkStore(file, { now: () => now })
  return {
    store,
    /** @param {number} day @param {number} [hour] */
    set(day, hour = 12) {
      now = new Date(2026, 9, day, hour)
    }
  }
}

describe('openSeries', () => {
  // Wednesday 2026-10-14, 15:00.
  const now = new Date(2026, 9, 14, 15)

  test('counts the tasks open at the end of each day, the last value being now', () => {
    const history = [
      { item: 1, grp: /** @type {const} */ ('not-started'), at: at(1) },
      { item: 1, grp: /** @type {const} */ ('done'), at: at(10) },
      { item: 2, grp: /** @type {const} */ ('not-started'), at: at(5) },
      { item: 2, grp: /** @type {const} */ ('active'), at: at(6) },
      { item: 3, grp: /** @type {const} */ ('not-started'), at: at(14, 14) }
    ]
    const series = openSeries(history, now)
    assert.equal(series.length, 14)
    // Oct 1 .. Oct 14
    assert.deepEqual(series, [1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 2])
  })

  test('does not count a task made later the same day before it existed', () => {
    const series = openSeries([{ item: 1, grp: 'not-started', at: at(14, 16) }], now)
    assert.equal(series.at(-1), 0)
  })
})

describe('doneThisWeek', () => {
  // Wednesday 2026-10-14; the week is Mon Oct 12 to Sun Oct 18.
  const now = new Date(2026, 9, 14, 15)

  test('counts tasks done now by the day they were last finished, Monday first', () => {
    const history = [
      { item: 1, grp: /** @type {const} */ ('done'), at: at(12, 9) },
      { item: 2, grp: /** @type {const} */ ('done'), at: at(14, 10) },
      { item: 3, grp: /** @type {const} */ ('done'), at: at(11, 23) },
      { item: 4, grp: /** @type {const} */ ('done'), at: at(13) },
      { item: 5, grp: /** @type {const} */ ('done'), at: at(5) },
      { item: 5, grp: /** @type {const} */ ('active'), at: at(6) },
      { item: 5, grp: /** @type {const} */ ('done'), at: at(13) }
    ]
    // 3 was done last week; 4 has been reopened.
    assert.deepEqual(doneThisWeek(history, new Set([1, 2, 3, 5]), now), [1, 1, 1, 0, 0, 0, 0])
  })
})

describe('portfolioOverview', () => {
  test('stats, waiting and sessions from real writes', () => {
    const { store, set } = clockStore()
    store.createPortfolio({ key: 'TC', name: 'TideCast' })
    store.createProject({ portfolio: 'TC', name: 'Desktop' })
    store.createProject({ portfolio: 'TC', name: 'Beacon' })
    set(2)
    const a = store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'A' })
    const b = store.createItem({ portfolio: 'TC', project: 'Beacon', title: 'B' })
    const c = store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'C', waitsOn: [a.id, b.id] })
    store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'D', waitsOn: [a.id] })
    set(13, 10)
    store.updateItem(a.id, { status: 'In progress' })
    store.claim(a.id, { id: 's1', name: 'saved views s3' })
    store.updateItem(b.id, { status: 'Done' })
    set(14, 15)

    const overview = store.portfolioOverview('TC', { home: 'C:\\Users\\nobody' })
    assert.deepEqual(overview.stats.open, { count: 3, series: [0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3], days: 14 })
    assert.deepEqual(overview.stats.active, { count: 1, sessions: ['saved views s3'], withSession: 1 })
    assert.deepEqual(overview.stats.done, { count: 1, days: [0, 1, 0, 0, 0, 0, 0] })
    assert.deepEqual(
      overview.waiting.map(({ item, waitsOn }) => [item.id, waitsOn.map((blocker) => blocker.id)]),
      [
        [c.id, [a.id]],
        ['TC-4', [a.id]]
      ]
    )
    assert.equal(overview.stats.waiting.count, 2)
    assert.equal(overview.stats.waiting.crossProject, 0, 'B is done, so C waits only on A, in its own project')
    assert.deepEqual(overview.active.map((item) => item.id), [a.id])
    store.close()
  })

  test('a task waiting on another project counts as cross-project', () => {
    const { store } = clockStore()
    store.createPortfolio({ key: 'TC', name: 'TideCast' })
    store.createProject({ portfolio: 'TC', name: 'Desktop' })
    store.createProject({ portfolio: 'TC', name: 'Beacon' })
    const b = store.createItem({ portfolio: 'TC', project: 'Beacon', title: 'B' })
    store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'C', waitsOn: [b.id] })
    assert.deepEqual(store.portfolioOverview('TC').stats.waiting, { count: 1, crossProject: 1 })
    store.close()
  })

  test('projects carry their first folder as a person writes it', () => {
    const { store } = clockStore()
    store.createPortfolio({ key: 'TC', name: 'TideCast' })
    store.createProject({ portfolio: 'TC', name: 'Desktop', folders: [join('C:\\Users\\nobody', 'repos', 'tide cast')] })
    store.createProject({ portfolio: 'TC', name: 'Loose' })
    const [desktop, loose] = store.portfolioOverview('TC', { home: 'C:\\Users\\nobody' }).portfolio.projects
    assert.equal(desktop.place, '~/repos/tide cast')
    assert.equal(loose.place, null)
    store.close()
  })
})

describe('epicsOf', () => {
  test('counts an epic per project, without cancelled tasks', () => {
    const { store } = clockStore()
    store.createPortfolio({ key: 'TC', name: 'TideCast' })
    store.createProject({ portfolio: 'TC', name: 'Desktop' })
    store.createProject({ portfolio: 'TC', name: 'Mobile' })
    store.createProject({ portfolio: 'TC', name: 'Web' })
    const epic = store.createItem({ kind: 'epic', portfolio: 'TC', project: 'Desktop', title: 'Saved views' })
    const task = (/** @type {string} */ project, /** @type {string} */ status) =>
      store.createItem({ portfolio: 'TC', project, epic: epic.id, title: `${project} ${status}`, status })
    task('Desktop', 'Done')
    task('Desktop', 'In progress')
    task('Desktop', 'To do')
    task('Web', 'Backlog')
    task('Web', 'Cancelled')
    store.createItem({ kind: 'epic', portfolio: 'TC', project: 'Mobile', title: 'Empty' })

    const [named, empty] = store.portfolioOverview('TC').epics
    assert.equal(named.id, epic.id)
    assert.deepEqual([named.done, named.total], [1, 4])
    const desktop = store.getProject('Desktop', 'TC').uid
    const web = store.getProject('Web', 'TC').uid
    assert.deepEqual(named.cells, [
      { project: desktop, done: 1, active: 1, open: 1 },
      { project: web, done: 0, active: 0, open: 1 }
    ])
    assert.deepEqual([empty.title, empty.total, empty.cells], ['Empty', 0, []])
    assert.equal(epicsOf([], []).length, 0)
    store.close()
  })
})

describe('projectOverview', () => {
  test('the project, its portfolio workflow and every item in it', () => {
    const { store } = clockStore()
    store.createPortfolio({ key: 'TC', name: 'TideCast' })
    store.createProject({ portfolio: 'TC', name: 'Desktop' })
    store.createProject({ portfolio: 'TC', name: 'Mobile' })
    store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'Later' })
    store.createItem({ portfolio: 'TC', project: 'Mobile', title: 'Elsewhere' })
    store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'Now', status: 'In progress' })
    store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'Finished', status: 'Done' })

    const overview = store.projectOverview('Desktop', 'TC')
    assert.equal(overview.project.name, 'Desktop')
    assert.deepEqual([overview.portfolio.key, overview.portfolio.nextNumber], ['TC', 5])
    assert.equal(overview.portfolio.statuses.length, 8)
    assert.deepEqual(overview.portfolio.priorities.map((priority) => priority.name), ['Urgent', 'High', 'Normal', 'Low'])
    assert.deepEqual(overview.items.map((item) => item.title), ['Now', 'Later', 'Finished'])
    store.close()
  })
})

describe('status history', () => {
  test('a status moving to another group moves its items with it', () => {
    const { store, set } = clockStore()
    store.createPortfolio({ key: 'TC', name: 'TideCast' })
    store.createProject({ portfolio: 'TC', name: 'Desktop' })
    set(13)
    store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'Shipping', status: 'In review' })
    const review = store.getPortfolio('TC').statuses.find((status) => status.name === 'In review')
    set(14, 9)
    store.updateStatus(/** @type {any} */ (review).uid, { group: 'done' })
    set(14, 15)
    assert.deepEqual(store.portfolioOverview('TC').stats.done.days, [0, 0, 1, 0, 0, 0, 0])
    store.close()
  })

  test('an older database is backfilled from what each item is now', () => {
    const { dir, remove } = tempDir()
    try {
      const file = join(dir, 'work.db')
      const first = clockStore(file)
      first.store.createPortfolio({ key: 'TC', name: 'TideCast' })
      first.store.createProject({ portfolio: 'TC', name: 'Desktop' })
      first.set(2)
      first.store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'Open' })
      const done = first.store.createItem({ portfolio: 'TC', project: 'Desktop', title: 'Finished' })
      first.set(13)
      first.store.updateItem(done.id, { status: 'Done' })
      // Back to schema 1, as a database made before the history existed.
      first.store.db.exec(`
        DROP TRIGGER status_history_insert;
        DROP TRIGGER status_history_update;
        DROP TABLE status_history;
        PRAGMA user_version = 1;`)
      first.store.close()

      const second = clockStore(file)
      second.set(14, 15)
      const overview = second.store.portfolioOverview('TC')
      assert.equal(second.store.schemaVersion, 2)
      assert.deepEqual(overview.stats.done.days, [0, 1, 0, 0, 0, 0, 0])
      assert.deepEqual(overview.stats.open.series.slice(0, 3), [0, 2, 2])
      assert.equal(overview.stats.open.series.at(-1), 1)
      second.store.close()
    } finally {
      remove()
    }
  })
})
