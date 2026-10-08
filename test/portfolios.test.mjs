import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { MIGRATIONS } from '../service/schema.mjs'
import { WorkStore } from '../service/store.mjs'
import { memoryStore, seedTideCast, tempDir } from './helpers.mjs'

describe('portfolios', () => {
  test('a new portfolio has the default statuses and priorities', () => {
    const store = memoryStore()
    const portfolio = store.createPortfolio({ key: 'tc', name: 'TideCast' })
    assert.equal(portfolio.key, 'TC')
    assert.deepEqual(
      portfolio.statuses.map((s) => [s.name, s.group, s.isDefault]),
      [
        ['Backlog', 'not-started', true],
        ['Planning', 'not-started', false],
        ['To do', 'not-started', false],
        ['In progress', 'active', false],
        ['In review', 'active', false],
        ['Blocked', 'active', false],
        ['Done', 'done', false],
        ['Cancelled', 'closed', false]
      ]
    )
    assert.deepEqual(
      portfolio.priorities.map((p) => [p.name, p.rank, p.isDefault]),
      [
        ['Urgent', 1, false],
        ['High', 2, false],
        ['Normal', 3, true],
        ['Low', 4, false]
      ]
    )
  })

  test('keys are unique and shaped like TC or HELM', () => {
    const store = memoryStore()
    store.createPortfolio({ key: 'TC', name: 'TideCast' })
    assert.throws(() => store.createPortfolio({ key: 'tc', name: 'Again' }), { code: 'conflict' })
    for (const key of ['', '1TC', 'T-C', 'ABCDEFGHIJK']) {
      assert.throws(() => store.createPortfolio({ key, name: 'Bad' }), { code: 'invalid' }, key)
    }
  })

  test('renaming the key renames every ID', () => {
    const store = memoryStore()
    seedTideCast(store)
    store.createItem({ project: 'Desktop', title: 'One' })
    store.updatePortfolio('TC', { key: 'TCK' })
    assert.equal(store.getItem('TCK-1').title, 'One')
    assert.throws(() => store.getItem('TC-1'), { code: 'not-found' })
  })

  test('a custom status keeps its group, so Awaiting launch counts as done', () => {
    const store = memoryStore()
    seedTideCast(store)
    const launch = store.addStatus('TC', { name: 'Awaiting launch', group: 'done', colour: 'success', icon: 'launch' })
    assert.equal(launch.group, 'done')
    const blocker = store.createItem({ project: 'Desktop', title: 'Ship it' })
    const waiting = store.createItem({ project: 'Desktop', title: 'After it', waitsOn: [blocker.id] })
    assert.deepEqual(store.getItem(waiting.id).waitingOn, ['TC-1'])
    store.updateItem(blocker.id, { status: 'awaiting launch' })
    assert.deepEqual(store.getItem(waiting.id).waitingOn, [])
  })

  test('a status gets an icon from its group when none is chosen, and rejects unknown ones', () => {
    const store = memoryStore()
    seedTideCast(store)
    assert.equal(store.addStatus('TC', { name: 'Parked', group: 'closed' }).icon, 'cancelled')
    assert.throws(() => store.addStatus('TC', { name: 'X', group: /** @type {any} */ ('later') }), { code: 'invalid' })
    assert.throws(() => store.addStatus('TC', { name: 'Y', group: 'active', colour: '#ff0000' }), { code: 'invalid' })
    assert.throws(() => store.addStatus('TC', { name: 'backlog', group: 'active' }), { code: 'conflict' })
  })

  test('the default status moves and cannot be deleted', () => {
    const store = memoryStore()
    const { portfolio } = seedTideCast(store)
    const todo = portfolio.statuses.find((s) => s.name === 'To do')
    const backlog = portfolio.statuses.find((s) => s.name === 'Backlog')
    assert.ok(todo && backlog)
    store.updateStatus(todo.uid, { isDefault: true })
    assert.equal(store.createItem({ project: 'Desktop', title: 'New' }).status.name, 'To do')
    assert.throws(() => store.deleteStatus(todo.uid), { code: 'conflict' })
    store.deleteStatus(backlog.uid)
    assert.equal(store.getPortfolio('TC').statuses.length, 7)
  })

  test('a status in use needs somewhere for its items to go', () => {
    const store = memoryStore()
    const { portfolio } = seedTideCast(store)
    const review = portfolio.statuses.find((s) => s.name === 'In review')
    assert.ok(review)
    const item = store.createItem({ project: 'Desktop', title: 'Reviewing', status: 'In review' })
    assert.throws(() => store.deleteStatus(review.uid), /1 item is in In review/)
    store.deleteStatus(review.uid, { replaceWith: 'In progress' })
    assert.equal(store.getItem(item.id).status.name, 'In progress')
  })

  test('statuses and priorities reorder', () => {
    const store = memoryStore()
    seedTideCast(store)
    const order = ['To do', 'Backlog', 'Planning', 'In progress', 'In review', 'Blocked', 'Done', 'Cancelled']
    assert.deepEqual(store.reorderStatuses('TC', order).map((s) => s.name), order)
    assert.throws(() => store.reorderStatuses('TC', ['To do']), { code: 'invalid' })
    assert.throws(() => store.reorderStatuses('TC', [...order.slice(0, 7), 'To do']), /named twice/)
    const priorities = store.reorderPriorities('TC', ['High', 'Urgent', 'Normal', 'Low'])
    assert.deepEqual(priorities.map((p) => [p.name, p.rank]), [['High', 1], ['Urgent', 2], ['Normal', 3], ['Low', 4]])
  })

  test('priorities can be added, renamed and deleted', () => {
    const store = memoryStore()
    seedTideCast(store)
    const someday = store.addPriority('TC', { name: 'Someday' })
    assert.equal(someday.rank, 5)
    store.updatePriority(someday.uid, { name: 'Eventually' })
    const item = store.createItem({ project: 'Desktop', title: 'Later', priority: 'eventually' })
    assert.equal(item.priority.name, 'Eventually')
    assert.throws(() => store.deletePriority(someday.uid), { code: 'conflict' })
    store.deletePriority(someday.uid, { replaceWith: 'Low' })
    assert.equal(store.getItem(item.id).priority.name, 'Low')
  })

  test('deleting a portfolio takes everything in it', () => {
    const store = memoryStore()
    seedTideCast(store)
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Epic' })
    const task = store.createItem({ project: 'Reporting API', epic: epic.id, title: 'Task', criteria: ['a'] })
    store.addDependency(task.id, epic.id)
    store.appendLog(task.id, { text: 'did a thing', by: 's1' })
    store.deletePortfolio('TC')
    assert.deepEqual(store.listPortfolios(), [])
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM log').get()?.n), 0)
  })

  test('listPortfolios has each portfolio with its projects and counts', () => {
    const store = memoryStore()
    seedTideCast(store)
    store.createPortfolio({ key: 'HELM', name: 'Helm' })
    store.createItem({ project: 'Desktop', title: 'Open' })
    store.createItem({ project: 'Desktop', title: 'Going', status: 'In progress' })
    store.createItem({ project: 'Desktop', title: 'Finished', status: 'Done' })
    store.createItem({ kind: 'epic', project: 'Desktop', title: 'Epics are not counted' })
    const [helm, tc] = store.listPortfolios()
    assert.equal(helm.key, 'HELM')
    assert.deepEqual(tc.projects.map((p) => p.name), ['Desktop', 'Reporting API'])
    assert.deepEqual(tc.projects[0].counts, { open: 2, active: 1, done: 1, closed: 0 })
  })
})

describe('the database file', () => {
  test('reopening keeps the data and runs no migration twice', () => {
    const { dir, remove } = tempDir()
    try {
      const file = join(dir, 'nested folder', 'work.db')
      const first = new WorkStore(file)
      seedTideCast(first)
      first.createItem({ project: 'Desktop', title: 'Persisted' })
      assert.equal(first.schemaVersion, MIGRATIONS.length)
      first.close()
      const second = new WorkStore(file)
      assert.equal(second.schemaVersion, MIGRATIONS.length)
      assert.equal(second.getItem('TC-1').title, 'Persisted')
      second.close()
    } finally {
      remove()
    }
  })

  test('a database from a newer plugin is refused, not damaged', () => {
    const { dir, remove } = tempDir()
    try {
      const file = join(dir, 'work.db')
      const store = new WorkStore(file)
      store.db.exec('PRAGMA user_version = 99')
      store.close()
      assert.throws(() => new WorkStore(file), /schema 99, newer than this plugin knows/)
    } finally {
      remove()
    }
  })

  test('two stores on one file, as the installed and dev Helm would be, never hand out one number twice', () => {
    const { dir, remove } = tempDir()
    try {
      const file = join(dir, 'work.db')
      const a = new WorkStore(file)
      const b = new WorkStore(file)
      seedTideCast(a)
      const ids = []
      for (let n = 0; n < 10; n++) {
        ids.push(a.createItem({ project: 'Desktop', title: `a${n}` }).id)
        ids.push(b.createItem({ project: 'Desktop', title: `b${n}` }).id)
      }
      assert.equal(new Set(ids).size, 20)
      assert.equal(b.getItem('TC-20').title, 'b9')
      a.close()
      b.close()
    } finally {
      remove()
    }
  })

  test('a failed call changes nothing', () => {
    const store = memoryStore()
    seedTideCast(store)
    assert.throws(() => store.createItem({ project: 'Desktop', title: 'Bad link', links: [{ kind: 'nope', value: 'x' }] }), {
      code: 'invalid'
    })
    assert.equal(store.findItems().total, 0)
    // The number was not used up either.
    assert.equal(store.createItem({ project: 'Desktop', title: 'Good' }).id, 'TC-1')
  })
})

describe('the workflow page', () => {
  test('portfolioSettings counts what uses each status, priority and project', () => {
    const store = memoryStore()
    const { desktop, api, root } = seedTideCast(store)
    store.createItem({ project: 'Desktop', title: 'One' })
    store.createItem({ project: 'Desktop', title: 'Two', status: 'Done', priority: 'High' })
    store.createItem({ kind: 'epic', project: 'Reporting API', title: 'Three' })
    const settings = store.portfolioSettings('TC', { home: join(root, '..') })
    const status = (/** @type {string} */ name) => settings.portfolio.statuses.find((s) => s.name === name)?.uid ?? -1
    const priority = (/** @type {string} */ name) => settings.portfolio.priorities.find((p) => p.name === name)?.uid ?? -1
    assert.equal(settings.items, 3)
    assert.deepEqual(settings.uses.statuses, { [status('Backlog')]: 2, [status('Done')]: 1 })
    assert.deepEqual(settings.uses.priorities, { [priority('Normal')]: 2, [priority('High')]: 1 })
    assert.deepEqual(settings.uses.projects, { [desktop.uid]: 2, [api.uid]: 1 })
    assert.deepEqual(
      settings.portfolio.projects.map((project) => project.place),
      ['~/repos/tide cast', '~/repos/tide cast/reporting api']
    )
  })
})
