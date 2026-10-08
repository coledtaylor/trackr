import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { memoryStore, seedTideCast } from './helpers.mjs'

function tidecast() {
  const store = memoryStore()
  seedTideCast(store)
  return store
}

describe('IDs', () => {
  test('epics and tasks share one counter per portfolio', () => {
    const store = tidecast()
    store.createPortfolio({ key: 'HELM', name: 'Helm' })
    store.createProject({ portfolio: 'HELM', name: 'App' })
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Saved views' })
    const task = store.createItem({ project: 'Reporting API', epic: epic.id, title: 'Ingest keeps view_type' })
    const helm = store.createItem({ project: 'App', title: 'Elsewhere' })
    assert.deepEqual([epic.id, task.id, helm.id], ['TC-1', 'TC-2', 'HELM-1'])
    assert.equal(store.getPortfolio('TC').nextNumber, 3)
  })

  test('an ID is found in any case, and a bad one says what an ID looks like', () => {
    const store = tidecast()
    store.createItem({ project: 'Desktop', title: 'One' })
    assert.equal(store.getItem('tc-1').title, 'One')
    assert.equal(store.getItem(' TC-1 ').title, 'One')
    assert.throws(() => store.getItem('TC-2'), { code: 'not-found', message: 'TC-2 does not exist.' })
    assert.throws(() => store.getItem('123'), { code: 'invalid', message: '123 is not an ID. IDs look like TC-123.' })
  })

  test('deleting an item does not free its number', () => {
    const store = tidecast()
    store.createItem({ project: 'Desktop', title: 'One' })
    store.deleteItem('TC-1')
    assert.equal(store.createItem({ project: 'Desktop', title: 'Two' }).id, 'TC-2')
  })
})

describe('items', () => {
  test('a new task takes the portfolio defaults and records who made it', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: '  Deleting a view keeps its history  ', by: 'saved views s3' })
    assert.equal(task.title, 'Deleting a view keeps its history')
    assert.equal(task.kind, 'task')
    assert.equal(task.status.name, 'Backlog')
    assert.equal(task.priority.name, 'Normal')
    assert.equal(task.createdBy, 'saved views s3')
    assert.equal(task.project.name, 'Desktop')
  })

  test('unknown statuses and priorities name the ones there are', () => {
    const store = tidecast()
    assert.throws(() => store.createItem({ project: 'Desktop', title: 'x', status: 'Doing' }), {
      code: 'invalid',
      message: 'Doing is not a status here. Use one of: Backlog, Planning, To do, In progress, In review, Blocked, Done, Cancelled.'
    })
    assert.throws(() => store.createItem({ project: 'Desktop', title: 'x', priority: 'P1' }), /Urgent, High, Normal, Low/)
    assert.throws(() => store.createItem({ project: 'Desktop', title: '   ' }), { code: 'invalid', message: 'Title is required.' })
    assert.throws(() => store.createItem({ project: 'Nowhere', title: 'x' }), { code: 'not-found' })
  })

  test('an epic cannot have an epic, and a task cannot be an epic', () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Epic' })
    const task = store.createItem({ project: 'Desktop', title: 'Task' })
    assert.throws(() => store.createItem({ kind: 'epic', project: 'Desktop', epic: epic.id, title: 'x' }), /cannot be inside another epic/)
    assert.throws(() => store.createItem({ project: 'Desktop', epic: task.id, title: 'x' }), /TC-2 is a task, not an epic/)
  })

  test('updateItem reports each field that changed, and nothing for a field that did not', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 'Task', status: 'In progress' })
    const { item, changes } = store.updateItem(task.id, { status: 'Done', priority: 'Normal', title: 'Task' })
    assert.deepEqual(changes, [{ field: 'status', from: 'In progress', to: 'Done' }])
    assert.equal(item.status.group, 'done')
    assert.deepEqual(store.updateItem(task.id, {}).changes, [])
  })

  test('moving a task between projects keeps its ID, epic and everything on it', () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Saved views' })
    const task = store.createItem({ project: 'Desktop', epic: epic.id, title: 'Ingest keeps view_type', criteria: ['kept'] })
    store.appendLog(task.id, { text: 'started', by: 's1' })
    const { item, changes } = store.updateItem(task.id, { project: 'Reporting API' })
    assert.deepEqual(changes, [{ field: 'project', from: 'Desktop', to: 'Reporting API' }])
    assert.equal(item.id, 'TC-2')
    const moved = store.getItem('TC-2')
    assert.equal(moved.project.name, 'Reporting API')
    assert.equal(moved.epic?.id, 'TC-1')
    assert.equal(moved.criteriaList.length, 1)
    assert.equal(moved.log.total, 1)
  })

  test('an item cannot move to another portfolio', () => {
    const store = tidecast()
    store.createPortfolio({ key: 'HELM', name: 'Helm' })
    const app = store.createProject({ portfolio: 'HELM', name: 'App' })
    const task = store.createItem({ project: 'Desktop', title: 'Task' })
    assert.throws(() => store.updateItem(task.id, { project: app.uid }), /an item stays in its portfolio/)
  })

  test('an epic spans the projects its tasks are in, home first', () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Saved views' })
    store.createItem({ project: 'Reporting API', epic: epic.id, title: 'Ingest keeps view_type' })
    store.createItem({ project: 'Desktop', epic: epic.id, title: 'View names in the usage report' })
    const got = store.getItem(epic.id)
    assert.deepEqual(got.spans, ['Desktop', 'Reporting API'])
    assert.deepEqual(got.tasks?.map((t) => t.id), ['TC-2', 'TC-3'])
    assert.equal(store.getItem('TC-2').spans, null)
  })

  test('deleting an epic leaves its tasks, without an epic', () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Epic' })
    const task = store.createItem({ project: 'Desktop', epic: epic.id, title: 'Task' })
    store.deleteItem(epic.id)
    assert.equal(store.getItem(task.id).epic, null)
  })

  test('a project with items cannot be deleted; an empty one can', () => {
    const store = tidecast()
    store.createItem({ project: 'Desktop', title: 'Task' })
    assert.throws(() => store.deleteProject('Desktop'), { code: 'conflict', message: 'Desktop still has 1 item. Move or delete them first.' })
    store.deleteProject('Reporting API')
    assert.deepEqual(store.listProjects('TC').map((p) => p.name), ['Desktop'])
  })
})

describe('dependencies', () => {
  test('work across projects in a portfolio, and say what became ready', () => {
    const store = tidecast()
    const desktop = store.createItem({ project: 'Desktop', title: 'Deleting a view keeps its history', status: 'In progress' })
    const next = store.createItem({ project: 'Desktop', title: 'The editor names views', waitsOn: [desktop.id] })
    const api = store.createItem({ project: 'Reporting API', title: 'Ingest keeps view_type', waitsOn: [desktop.id] })
    const other = store.createItem({ project: 'Desktop', title: 'Also waits on another', waitsOn: [desktop.id] })
    const blocker = store.createItem({ project: 'Desktop', title: 'Still open' })
    store.addDependency(other.id, blocker.id)

    assert.deepEqual(store.getItem(api.id).waitingOn, ['TC-1'])
    assert.deepEqual(store.getItem(desktop.id).blocks.map((b) => b.id), ['TC-2', 'TC-3', 'TC-4'])
    assert.deepEqual(store.readyDependents(desktop.id), [])

    store.updateItem(desktop.id, { status: 'Done' })
    assert.deepEqual(store.readyDependents(desktop.id).map((i) => `${i.id} ${i.project.name}`), ['TC-2 Desktop', 'TC-3 Reporting API'])
    assert.deepEqual(store.getItem(other.id).waitingOn, ['TC-5'])
    assert.equal(next.waitingOn.length, 1)
  })

  test('a cancelled item no longer holds anything up', () => {
    const store = tidecast()
    const first = store.createItem({ project: 'Desktop', title: 'First' })
    const second = store.createItem({ project: 'Desktop', title: 'Second', waitsOn: [first.id] })
    store.updateItem(first.id, { status: 'Cancelled' })
    assert.deepEqual(store.getItem(second.id).waitingOn, [])
  })

  test('refuse a cycle, a self-dependency and another portfolio', () => {
    const store = tidecast()
    store.createPortfolio({ key: 'HELM', name: 'Helm' })
    store.createProject({ portfolio: 'HELM', name: 'App' })
    const a = store.createItem({ project: 'Desktop', title: 'a' })
    const b = store.createItem({ project: 'Reporting API', title: 'b', waitsOn: [a.id] })
    const c = store.createItem({ project: 'Desktop', title: 'c', waitsOn: [b.id] })
    const helm = store.createItem({ project: 'App', title: 'h' })
    assert.throws(() => store.addDependency(a.id, c.id), { code: 'conflict', message: 'TC-3 already waits on TC-1, so TC-1 cannot wait on it.' })
    assert.throws(() => store.addDependency(a.id, a.id), /cannot wait on itself/)
    assert.throws(() => store.addDependency(a.id, helm.id), /different portfolios/)
  })

  test('adding one twice is one, and removing it frees the item', () => {
    const store = tidecast()
    const a = store.createItem({ project: 'Desktop', title: 'a' })
    const b = store.createItem({ project: 'Desktop', title: 'b' })
    store.addDependency(b.id, a.id)
    store.addDependency(b.id, a.id)
    assert.equal(store.getItem(b.id).waitsOn.length, 1)
    store.removeDependency(b.id, a.id)
    assert.deepEqual(store.getItem(b.id).waitingOn, [])
  })
})

describe('acceptance criteria', () => {
  test('are numbered from 1, checked by number, and renumber when one goes', () => {
    const store = tidecast()
    const task = store.createItem({
      project: 'Desktop',
      title: 'Deleting a view keeps its history',
      criteria: ['Removed from the tab', 'Gone from the clock card', 'view_config still holds it', 'The usage report names its punches']
    })
    assert.deepEqual(task.criteria, { done: 0, total: 4 })
    store.setCriteriaDone(task.id, [1, 2, 3], true)
    assert.deepEqual(store.getItem(task.id).criteria, { done: 3, total: 4 })
    store.setCriteriaDone(task.id, [2], false)
    store.editCriterion(task.id, 4, 'The usage report still names its punches')
    const after = store.removeCriterion(task.id, 1)
    assert.deepEqual(after, [
      { n: 1, text: 'Gone from the clock card', done: false },
      { n: 2, text: 'view_config still holds it', done: true },
      { n: 3, text: 'The usage report still names its punches', done: false }
    ])
    assert.deepEqual(store.addCriteria(task.id, ['Added later']).at(-1), { n: 4, text: 'Added later', done: false })
  })

  test('a number out of range names the range', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 't', criteria: ['a', 'b'] })
    assert.throws(() => store.setCriteriaDone(task.id, [3], true), { message: 'TC-1 has criteria 1 to 2; 3 is not one.' })
    const bare = store.createItem({ project: 'Desktop', title: 'u' })
    assert.throws(() => store.removeCriterion(bare.id, 1), { message: 'TC-2 has no criteria.' })
  })

  test('marking a task done with criteria unchecked is allowed', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 't', criteria: ['a', 'b', 'c'] })
    store.setCriteriaDone(task.id, [1, 2], true)
    const { item } = store.updateItem(task.id, { status: 'Done' })
    assert.equal(item.status.name, 'Done')
    assert.deepEqual(item.criteria, { done: 2, total: 3 })
  })
})

describe('handoff, log and session', () => {
  test('the handoff is rewritten by each session; the log only grows', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 't' })
    assert.equal(task.handoff, null)
    store.setHandoff(task.id, { done: 'Soft-delete column', left: 'Label lookup', next: 'Let view_label() read deleted rows' }, 'saved views s3')
    store.appendLog(task.id, { text: 'Soft-delete column and migration', by: 'saved views s3', ref: 'a41c9e2' })
    store.setHandoff(task.id, { done: 'Label lookup reads deleted rows' }, 'saved views s4')
    store.appendLog(task.id, { text: 'Verified usage report', by: 'saved views s4' })
    const got = store.getItem(task.id)
    assert.deepEqual(
      { done: got.handoff?.done, left: got.handoff?.left, next: got.handoff?.next, by: got.handoff?.by },
      { done: 'Label lookup reads deleted rows', left: '', next: '', by: 'saved views s4' }
    )
    assert.deepEqual(
      got.log.entries.map((e) => [e.by, e.text, e.ref]),
      [
        ['saved views s3', 'Soft-delete column and migration', 'a41c9e2'],
        ['saved views s4', 'Verified usage report', null]
      ]
    )
  })

  test('the log returns the latest entries, oldest first, with the total', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 't' })
    for (let n = 1; n <= 5; n++) store.appendLog(task.id, { text: `line ${n}`, by: 's' })
    const { log } = store.getItem(task.id, { logLimit: 3 })
    assert.equal(log.total, 5)
    assert.deepEqual(log.entries.map((e) => e.text), ['line 3', 'line 4', 'line 5'])
  })

  test('a second session is told who had the task, and takes it', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 't' })
    assert.deepEqual(store.claim(task.id, { id: 's-1', name: 'saved views s3' }), { previous: null })
    assert.deepEqual(store.claim(task.id, { id: 's-1', name: 'saved views s3' }), { previous: null })
    const { previous } = store.claim(task.id, { id: 's-2', name: 'beacon auth' })
    assert.equal(previous?.name, 'saved views s3')
    assert.equal(store.getItem(task.id).session?.name, 'beacon auth')
    store.release(task.id)
    assert.equal(store.getItem(task.id).session, null)
  })

  test('every change moves updatedAt', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 't' })
    let last = task.updatedAt
    const steps = [
      () => store.addCriteria(task.id, ['a']),
      () => store.setCriteriaDone(task.id, [1], true),
      () => store.addLink(task.id, { kind: 'branch', value: 'feat/saved-views' }),
      () => store.appendLog(task.id, { text: 'x', by: 's' }),
      () => store.setHandoff(task.id, { done: 'x' }, 's'),
      () => store.claim(task.id, { id: 'a', name: 'b' }),
      () => store.updateItem(task.id, { title: 'renamed' })
    ]
    for (const step of steps) {
      step()
      const now = store.getItem(task.id).updatedAt
      assert.ok(now > last, step.toString())
      last = now
    }
  })
})

describe('links', () => {
  test('one per kind and value; a new label replaces the old', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 't', links: [{ kind: 'pr', value: '412', label: 'draft' }] })
    store.addLink(task.id, { kind: 'pr', value: '412', label: 'Soft-delete views' })
    const link = store.addLink(task.id, { kind: 'file', value: 'reports/view_label.py' })
    let links = store.getItem(task.id).links
    assert.deepEqual(links.map((l) => [l.kind, l.value, l.label]), [
      ['pr', '412', 'Soft-delete views'],
      ['file', 'reports/view_label.py', '']
    ])
    store.removeLink(task.id, link.uid)
    links = store.getItem(task.id).links
    assert.equal(links.length, 1)
    assert.throws(() => store.addLink(task.id, { kind: 'jira', value: 'x' }), { code: 'invalid' })
    assert.throws(() => store.removeLink(task.id, link.uid), { code: 'not-found' })
  })
})

describe('find', () => {
  function board() {
    const store = tidecast()
    store.createItem({ project: 'Desktop', title: 'Backlog thing' }) // TC-1
    store.createItem({ project: 'Desktop', title: 'Urgent to do', status: 'To do', priority: 'Urgent' }) // TC-2
    store.createItem({ project: 'Desktop', title: 'Normal to do', status: 'To do' }) // TC-3
    store.createItem({ project: 'Desktop', title: 'Going', status: 'In progress', priority: 'Low' }) // TC-4
    store.createItem({ project: 'Reporting API', title: 'Finished', status: 'Done' }) // TC-5
    store.createItem({ project: 'Desktop', title: 'Waiting', status: 'To do', waitsOn: ['TC-4'] }) // TC-6
    store.createItem({ project: 'Desktop', title: 'Dropped', status: 'Cancelled' }) // TC-7
    return store
  }

  test('lists next up first: under way, then by priority, then further along', () => {
    const { items, total } = board().findItems({ open: true })
    assert.equal(total, 5)
    assert.deepEqual(items.map((i) => i.id), ['TC-4', 'TC-2', 'TC-3', 'TC-6', 'TC-1'])
  })

  test('ready leaves out what waits on open work', () => {
    assert.deepEqual(board().findItems({ ready: true }).items.map((i) => i.id), ['TC-4', 'TC-2', 'TC-3', 'TC-1'])
  })

  test('filters by project, status, group, text and ID, and pages', () => {
    const store = board()
    assert.deepEqual(store.findItems({ project: 'Reporting API' }).items.map((i) => i.id), ['TC-5'])
    assert.deepEqual(store.findItems({ status: ['to do'] }).items.map((i) => i.id), ['TC-2', 'TC-3', 'TC-6'])
    assert.deepEqual(store.findItems({ groups: ['closed'] }).items.map((i) => i.id), ['TC-7'])
    assert.deepEqual(store.findItems({ text: 'to do' }).items.map((i) => i.id), ['TC-2', 'TC-3'])
    assert.deepEqual(store.findItems({ text: 'tc-5' }).items.map((i) => i.id), ['TC-5'])
    const page = store.findItems({ limit: 2, offset: 2 })
    assert.equal(page.total, 7)
    assert.deepEqual(page.items.map((i) => i.id), ['TC-3', 'TC-6'])
  })

  test('text with LIKE wildcards in it is matched as written', () => {
    const store = tidecast()
    store.createItem({ project: 'Desktop', title: '100% done_ish' })
    store.createItem({ project: 'Desktop', title: '100 done' })
    assert.deepEqual(store.findItems({ text: '100%' }).items.map((i) => i.title), ['100% done_ish'])
  })

  test('filters by epic, and refuses a task as one', () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'E' })
    store.createItem({ project: 'Reporting API', epic: epic.id, title: 'In it' })
    store.createItem({ project: 'Desktop', title: 'Not in it' })
    assert.deepEqual(store.findItems({ epic: epic.id }).items.map((i) => i.title), ['In it'])
    assert.throws(() => store.findItems({ epic: 'TC-3' }), /is a task, not an epic/)
  })
})
