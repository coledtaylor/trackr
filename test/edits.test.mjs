import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { orderOf } from '../service/overview.mjs'
import { runTool } from '../service/tools.mjs'
import { memoryStore, seedTideCast } from './helpers.mjs'

function tidecast() {
  const store = memoryStore()
  seedTideCast(store)
  return store
}

describe('orderOf', () => {
  test('hangs each task from the deepest task it waits on, roots in the order given', () => {
    // 1 <- 2 <- 3 <- 4, 2 <- 5, 1 <- 6; 7 alone; 8 waits on 1 and 3.
    const edges = [
      { item: 2, waitsOn: 1 },
      { item: 3, waitsOn: 2 },
      { item: 4, waitsOn: 3 },
      { item: 5, waitsOn: 2 },
      { item: 6, waitsOn: 1 },
      { item: 8, waitsOn: 1 },
      { item: 8, waitsOn: 3 }
    ]
    assert.deepEqual(orderOf([1, 2, 3, 4, 5, 6, 7, 8], edges), [
      { uid: 1, depth: 0 },
      { uid: 2, depth: 1 },
      { uid: 3, depth: 2 },
      { uid: 4, depth: 3 },
      { uid: 8, depth: 3 },
      { uid: 5, depth: 2 },
      { uid: 6, depth: 1 },
      { uid: 7, depth: 0 }
    ])
  })

  test('ignores dependencies on tasks outside the list, and shows every task once', () => {
    const rows = orderOf([10, 11], [{ item: 11, waitsOn: 99 }, { item: 10, waitsOn: 10 }])
    assert.deepEqual(rows, [
      { uid: 10, depth: 0 },
      { uid: 11, depth: 0 }
    ])
  })
})

describe('itemOverview', () => {
  test('gives an epic its order, and the pickers what the portfolio has', () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Saved views' })
    const a = store.createItem({ project: 'Desktop', epic: epic.id, title: 'A' })
    const b = store.createItem({ project: 'Reporting API', epic: epic.id, title: 'B', waitsOn: [a.id] })
    const outside = store.createItem({ project: 'Desktop', title: 'Outside' })
    store.addDependency(a.id, outside.id)
    const done = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Finished epic', status: 'Done' })

    const view = store.itemOverview(epic.id, { home: '/nowhere' })
    assert.equal(view.item.id, epic.id)
    assert.deepEqual(
      view.order?.map((row) => [row.uid, row.depth]),
      [
        [a.uid, 0],
        [b.uid, 1]
      ]
    )
    assert.deepEqual(
      view.projects.map((project) => project.name),
      ['Desktop', 'Reporting API']
    )
    assert.equal(view.portfolio.statuses.length, 8)
    assert.equal(view.portfolio.priorities.length, 4)
    // Open epics only, so a finished one is not offered.
    assert.deepEqual(
      view.epics.map((item) => item.id),
      [epic.id]
    )
    assert.equal(done.status.name, 'Done')
  })

  test("offers a task's own epic even when it is finished", () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Old', status: 'Done' })
    const task = store.createItem({ project: 'Desktop', epic: epic.id, title: 'Leftover' })
    const view = store.itemOverview(task.id)
    assert.deepEqual(
      view.epics.map((item) => item.id),
      [epic.id]
    )
    assert.equal(view.order, null)
  })
})

describe('editItem', () => {
  test('changes fields and writes one log line by the person, in the words a session would', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 'Old title' })
    const { item } = store.editItem(task.id, { title: 'New title', status: 'To do', priority: 'High', project: 'Reporting API' }, 'You')
    assert.equal(item.title, 'New title')
    assert.equal(item.project.name, 'Reporting API')
    const log = store.getItem(task.id).log.entries
    assert.equal(log.length, 1)
    assert.equal(log[0].by, 'You')
    assert.equal(log[0].text, 'Backlog -> To do · priority Normal -> High · title · moved Desktop -> Reporting API')
  })

  test('a note leads the line; nothing changed and no note writes nothing', () => {
    const store = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 'T' })
    store.editItem(task.id, { title: 'T' }, 'You')
    assert.equal(store.getItem(task.id).log.total, 0)
    store.editItem(task.id, { note: 'Do this before TC-9', status: 'In progress' }, 'You')
    assert.equal(store.getItem(task.id).log.entries[0].text, 'Do this before TC-9 · Backlog -> In progress')
    store.editItem(task.id, { note: 'Just a note' }, 'You')
    assert.equal(store.getItem(task.id).log.entries[1].text, 'Just a note')
  })

  test("references are logged apart from links, and a task inherits its epic's key ones", () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Epic' })
    const task = store.createItem({ project: 'Desktop', title: 'Task', epic: epic.id })
    const use = 'Read when building the UI'
    const mockup = { kind: 'artifact', target: 'https://claude.ai/artifact/m1', title: 'Mockup', use, key: true }
    store.editItem(epic.id, { refs: { add: [mockup, { ...mockup, target: 'https://claude.ai/artifact/m3', key: false }] } }, 'You')
    store.editItem(
      task.id,
      {
        links: { add: [{ kind: 'branch', value: 'feat/x' }] },
        refs: { add: [{ kind: 'artifact', target: 'https://claude.ai/artifact/m2', use }, { kind: 'doc', target: 'https://notion.so/spec', use }] }
      },
      'You'
    )
    const item = store.getItem(task.id)
    assert.deepEqual(store.itemOverview(task.id).inherited.map((ref) => [ref.target, ref.title, ref.from.name]), [['https://claude.ai/artifact/m1', 'Mockup', epic.id]])
    assert.deepEqual(item.refs.map((ref) => ref.kind), ['artifact', 'doc'])
    assert.deepEqual(store.itemOverview(epic.id).inherited, [])
    const [mockup2, spec] = item.refs
    store.editItem(task.id, { refs: { edit: [{ uid: mockup2.uid, title: 'Mockup 2' }, { uid: spec.uid, use }] } }, 'You')
    assert.deepEqual(store.getItem(task.id).refs.map((ref) => ref.title), ['Mockup 2', 'https://notion.so/spec'])
    store.editItem(task.id, { links: { remove: item.links.map((link) => link.uid) }, refs: { remove: item.refs.map((ref) => ref.uid) } }, 'You')
    assert.deepEqual(
      store.getItem(task.id).log.entries.map((entry) => entry.text),
      ['link +1 · ref +2', 'ref edited 1', 'link -1 · ref -2'],
      'an edit that changes nothing is not counted'
    )
    assert.throws(() => store.editItem(task.id, { refs: { add: [{ kind: 'artifact', target: 'https://example.com', use }] } }, 'You'), {
      code: 'invalid',
      message: "https://example.com is not a claude.ai artifact. An artifact's address is like https://claude.ai/artifact/… or https://claude.ai/code/artifact/…."
    })
    assert.throws(() => store.editItem(task.id, { links: { add: [{ kind: 'artifact', value: 'https://claude.ai/artifact/m2' }] } }, 'You'), {
      code: 'invalid',
      message: "A link's kind is one of branch, pr, commit, file, url."
    })
  })


  test('dependencies, links and where it stands, logged by ID and count', () => {
    const store = tidecast()
    const first = store.createItem({ project: 'Desktop', title: 'First' })
    const task = store.createItem({ project: 'Reporting API', title: 'Second' })
    store.editItem(task.id, { waitsOn: { add: [first.id] }, links: { add: [{ kind: 'branch', value: 'feat/x' }] } }, 'You')
    let item = store.getItem(task.id)
    assert.deepEqual(item.waitingOn, [first.id])
    assert.equal(item.links[0].value, 'feat/x')
    store.editItem(
      task.id,
      { waitsOn: { remove: [first.id] }, links: { remove: [item.links[0].uid] }, handoff: { done: 'A', left: 'B', next: 'C' } },
      'You'
    )
    item = store.getItem(task.id)
    assert.deepEqual(item.waitingOn, [])
    assert.equal(item.links.length, 0)
    assert.deepEqual({ ...item.handoff, at: '' }, { done: 'A', left: 'B', next: 'C', by: 'You', at: '' })
    assert.deepEqual(
      item.log.entries.map((entry) => entry.text),
      [`waits on ${first.id} · link +1`, `no longer waits on ${first.id} · link -1 · handoff`]
    )
  })

  test('a refused part changes nothing at all', () => {
    const store = tidecast()
    const a = store.createItem({ project: 'Desktop', title: 'A' })
    const b = store.createItem({ project: 'Desktop', title: 'B', waitsOn: [a.id] })
    assert.throws(() => store.editItem(a.id, { title: 'Renamed', waitsOn: { add: [b.id] } }, 'You'), { code: 'conflict' })
    const item = store.getItem(a.id)
    assert.equal(item.title, 'A')
    assert.equal(item.log.total, 0)
  })

  test('moving out of an active status lets the session go; finishing says what became ready', () => {
    const store = tidecast()
    const a = store.createItem({ project: 'Desktop', title: 'A', status: 'In progress' })
    const b = store.createItem({ project: 'Reporting API', title: 'B', status: 'To do', waitsOn: [a.id] })
    store.claim(a.id, { id: 's1', name: 'saved views s3' })
    store.editItem(a.id, { status: 'In review' }, 'You')
    assert.equal(store.getItem(a.id).session?.name, 'saved views s3')
    const { ready } = store.editItem(a.id, { status: 'Done' }, 'You')
    assert.equal(store.getItem(a.id).session, null)
    assert.deepEqual(
      ready.map((item) => item.id),
      [b.id]
    )
  })

  test("a session's get shows the person's edits", () => {
    const store = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Saved views' })
    const task = store.createItem({ project: 'Desktop', title: 'Deleting a view' })
    store.editItem(
      task.id,
      {
        title: 'Deleting a view keeps its history',
        epic: epic.id,
        priority: 'High',
        links: { add: [{ kind: 'pr', value: '#412', label: 'Soft-delete views' }] },
        handoff: { done: 'Migration', left: 'Report', next: 'Seed a deleted view' }
      },
      'You'
    )
    store.addCriteria(task.id, ['Gone from the Views tab'])
    store.setCriteriaDone(task.id, [1], true)
    const text = runTool(store, 'get', { ids: [task.id] }, { id: 's2', name: 'reader', cwd: '/nowhere' }, { home: '/nowhere', timeZone: 'UTC' })
    assert.match(text, /Deleting a view keeps its history/)
    assert.match(text, /High/)
    assert.match(text, new RegExp(`epic ${epic.id} Saved views`))
    assert.match(text, /PR #412/)
    assert.match(text, /1 \[x\] Gone from the Views tab/)
    assert.match(text, /Next: Seed a deleted view/)
  })
})
