import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, test } from 'node:test'
import { buildPlan, stateOf } from '../service/plan.mjs'
import { MIGRATIONS } from '../service/schema.mjs'
import { WorkStore } from '../service/store.mjs'
import { memoryStore, seedTideCast, tempDir } from './helpers.mjs'

/** @type {WorkStore} */
let store

/**
 * A portfolio with an initiative of two epics across both projects, and an
 * epic outside it.
 *
 * Launch (initiative, Desktop)
 *   Sync (epic, Desktop): a, b (Reporting API), c
 *   Brand (epic, Desktop): d
 * Loose (epic, Desktop): e, f
 */
function seed() {
  store = memoryStore()
  seedTideCast(store)
  const launch = store.createItem({ kind: 'initiative', project: 'Desktop', portfolio: 'TC', title: 'Launch' })
  const sync = store.createItem({ kind: 'epic', project: 'Desktop', portfolio: 'TC', title: 'Sync', initiative: launch.id })
  const brand = store.createItem({ kind: 'epic', project: 'Desktop', portfolio: 'TC', title: 'Brand', initiative: launch.id })
  const loose = store.createItem({ kind: 'epic', project: 'Desktop', portfolio: 'TC', title: 'Loose' })
  const task = (/** @type {string} */ title, /** @type {string} */ epic, project = 'Desktop') =>
    store.createItem({ project, portfolio: 'TC', title, epic })
  const a = task('a', sync.id)
  const b = task('b', sync.id, 'Reporting API')
  const c = task('c', sync.id)
  const d = task('d', brand.id)
  const e = task('e', loose.id)
  const f = task('f', loose.id)
  return { launch, sync, brand, loose, a, b, c, d, e, f }
}

/** @param {string} id */
const stageOf = (id) => store.getItem(id).stage

describe('initiatives', () => {
  test('an initiative holds epics, which hold tasks, and nothing else nests', () => {
    const { launch, sync, brand, a, d } = seed()
    const item = store.getItem(launch.id)
    assert.equal(item.kind, 'initiative')
    assert.deepEqual(item.epics?.map((epic) => epic.id), [sync.id, brand.id])
    assert.deepEqual(item.tasks?.map((task) => task.id).sort(), [a.id, 'TC-6', 'TC-7', d.id].sort())
    assert.deepEqual(item.spans, ['Desktop', 'Reporting API'])
    assert.deepEqual(store.getItem(a.id).initiative, { id: launch.id, title: 'Launch' })
    assert.deepEqual(store.getItem(sync.id).initiative, { id: launch.id, title: 'Launch' })

    assert.throws(() => store.updateItem(a.id, { initiative: launch.id }), /A task goes in an epic, and the epic in an initiative/)
    assert.throws(() => store.updateItem(launch.id, { epic: sync.id }), /An initiative is not inside an epic/)
    assert.throws(() => store.updateItem(sync.id, { initiative: sync.id }), /is an epic, not an initiative/)
    assert.throws(() => store.updateItem(a.id, { epic: launch.id }), /is an initiative, not an epic/)
    store.createPortfolio({ key: 'OT', name: 'Other' })
    store.createProject({ portfolio: 'OT', name: 'Elsewhere' })
    const other = store.createItem({ kind: 'initiative', project: 'Elsewhere', title: 'Other' })
    assert.throws(() => store.updateItem(sync.id, { initiative: other.id }), /in another portfolio/)
  })

  test('find takes an initiative: its epics and their tasks', () => {
    const { launch, loose } = seed()
    const { items } = store.findItems({ initiative: launch.id, limit: 100 })
    assert.deepEqual(items.map((item) => item.id).sort(), ['TC-2', 'TC-3', 'TC-5', 'TC-6', 'TC-7', 'TC-8'].sort())
    assert.throws(() => store.findItems({ initiative: loose.id }), /is an epic, not an initiative/)
    assert.deepEqual(store.findItems({ kind: 'initiative' }).items.map((item) => item.id), [launch.id])
  })

  test('key references reach an initiative’s epics and their tasks', () => {
    const { launch, sync, a, e } = seed()
    store.addRef({ item: launch.id }, { target: 'https://claude.ai/artifact/launch-design', use: 'Read before any launch work', key: true })
    store.addRef({ item: sync.id }, { target: 'https://example.com/sync', use: 'Read when syncing', key: true })
    const fromTask = store.inheritedRefs(a.id)
    assert.deepEqual(
      fromTask.map((reference) => [reference.from.level, reference.from.name, reference.target]),
      [
        ['epic', sync.id, 'https://example.com/sync'],
        ['initiative', launch.id, 'https://claude.ai/artifact/launch-design']
      ]
    )
    assert.deepEqual(store.inheritedRefs(sync.id).map((reference) => reference.from.level), ['initiative'])
    assert.deepEqual(store.inheritedRefs(e.id), [])
  })

  test('deleting an initiative leaves its epics, without one', () => {
    const { launch, sync } = seed()
    store.setPlan(launch.id, [{ title: 'One', items: [sync.id] }])
    store.deleteItem(launch.id)
    const after = store.getItem(sync.id)
    assert.equal(after.initiative, null)
    assert.equal(after.stage, null)
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM stages').get()?.n), 0)
  })
})

describe('sequences', () => {
  beforeEach(() => {
    seed()
  })

  test('a sequence is set in one call, and read with how far along each stage is', () => {
    const { launch, sync, brand, a, b, c, d } = seed()
    store.updateItem(a.id, { status: 'Done' })
    store.updateItem(b.id, { status: 'In progress' })
    const plan = store.setPlan(launch.id, [
      { title: 'Foundation', goal: 'Sync runs end to end', items: [a.id, b.id] },
      { title: 'Ship', items: [sync.id, brand.id] }
    ])
    assert.deepEqual(plan.owner, { uid: launch.uid, id: launch.id, kind: 'initiative', title: 'Launch' })
    assert.deepEqual(
      plan.stages.map((stage) => [stage.n, stage.title, stage.goal, stage.state, stage.done, stage.active, stage.total]),
      [
        [1, 'Foundation', 'Sync runs end to end', 'active', 1, 1, 2],
        [2, 'Ship', '', 'not-started', 0, 0, 2]
      ]
    )
    // Sync in stage 2 stands for c, the one of its tasks not placed alone.
    const syncEntry = plan.stages[1].items.find((entry) => entry.id === sync.id)
    assert.deepEqual(syncEntry?.rest, { done: 0, active: 0, total: 1, tasks: [c.id] })
    assert.deepEqual(plan.stages[1].items.find((entry) => entry.id === brand.id)?.rest?.tasks, [d.id])
    assert.equal(plan.current, 1)
    assert.deepEqual(plan.unplaced, [])
    assert.deepEqual(plan.progress, { done: 1, active: 1, total: 4 })
    assert.deepEqual(stageOf(a.id), { uid: plan.stages[0].uid, n: 1, title: 'Foundation' })
  })

  test('only the work a sequence plans goes in it, each item once', () => {
    const { launch, loose, a, e } = seed()
    assert.throws(() => store.setPlan(launch.id, [{ title: 'One', items: [e.id] }]), /TC-9 is not in TC-1. An initiative's stages hold its epics and their tasks/)
    assert.throws(() => store.setPlan(loose.id, [{ title: 'One', items: [a.id] }]), /TC-5 is not a task of TC-4/)
    assert.throws(() => store.setPlan(launch.id, [{ title: 'One', items: [a.id] }, { title: 'Two', items: [a.id] }]), /named in stage 1 and stage 2/)
    assert.throws(() => store.setPlan(launch.id, [{ title: ' ', items: [] }]), /Stage 1 needs a title/)
    assert.throws(() => store.setPlan('TC-2', []), /TC-2 is in initiative TC-1, whose sequence its work is placed in/)
    assert.throws(() => store.setPlan(a.id, []), /TC-5 is a task. A sequence belongs to an initiative, or to an epic outside one/)
    assert.equal(store.planOf(launch.id).stages.length, 0)
  })

  test('an epic outside an initiative holds its own sequence of its tasks', () => {
    const { loose, e, f } = seed()
    const plan = store.setPlan(loose.id, [{ title: 'First', items: [f.id] }, { title: 'Then', items: [e.id] }])
    assert.deepEqual(plan.stages.map((stage) => stage.items.map((entry) => entry.id)), [[f.id], [e.id]])
    assert.deepEqual(plan.epics, [])
  })

  test('what is in no stage, and what the order puts before what it waits on', () => {
    const { launch, sync, a, b, c, d } = seed()
    store.addDependency(a.id, d.id)
    store.addDependency(c.id, b.id)
    const plan = store.setPlan(launch.id, [
      { title: 'One', items: [a.id, c.id] },
      { title: 'Two', items: [d.id, b.id] }
    ])
    assert.deepEqual(plan.conflicts, [
      { item: a.id, stage: 1, waitsOn: d.id, waitsOnStage: 2 },
      { item: c.id, stage: 1, waitsOn: b.id, waitsOnStage: 2 }
    ])
    assert.deepEqual(plan.unplaced, [])
    // Done work holds nothing up.
    store.updateItem(d.id, { status: 'Done' })
    assert.deepEqual(store.planOf(launch.id).conflicts.map((conflict) => conflict.item), [c.id])
    // A stage's own number counts before its epic's.
    store.setPlan(launch.id, [{ title: 'One', items: [sync.id] }])
    const loose = store.planOf(launch.id)
    assert.deepEqual(loose.conflicts, [])
    assert.deepEqual(loose.unplaced.map((item) => item.id), [])
    store.setPlan(launch.id, [{ title: 'One', items: [a.id] }])
    assert.deepEqual(store.planOf(launch.id).unplaced.map((item) => item.id).sort(), [b.id, c.id].sort())
  })

  test('an epic with no tasks counts as one, and stays unplaced until placed', () => {
    const { launch } = seed()
    const empty = store.createItem({ kind: 'epic', project: 'Desktop', portfolio: 'TC', title: 'Empty', initiative: launch.id })
    assert.ok(store.planOf(launch.id).unplaced.some((item) => item.id === empty.id))
    const plan = store.setPlan(launch.id, [{ title: 'One', items: [empty.id] }])
    assert.deepEqual([plan.stages[0].total, plan.stages[0].state], [1, 'not-started'])
    assert.ok(!plan.unplaced.some((item) => item.id === empty.id))
  })

  test('one item moves by its stage: a number, a title, a uid, or out with null', () => {
    const { launch, a, e } = seed()
    const plan = store.setPlan(launch.id, [{ title: 'One' }, { title: 'Two' }])
    const moved = store.updateItem(a.id, { stage: '2' })
    assert.deepEqual(moved.changes.at(-1), { field: 'stage', from: null, to: '2 Two' })
    assert.equal(store.updateItem(a.id, { stage: 'one' }).item.stage?.n, 1)
    assert.equal(store.updateItem(a.id, { stage: plan.stages[1].uid }).item.stage?.n, 2)
    assert.deepEqual(store.updateItem(a.id, { stage: null }).changes, [{ field: 'stage', from: '2 Two', to: null }])
    assert.throws(() => store.updateItem(a.id, { stage: '3' }), /3 is not a stage of TC-1. Its stages are 1 One, 2 Two/)
    assert.throws(() => store.updateItem(e.id, { stage: '1' }), /TC-4 has no stages yet/)
    assert.throws(() => store.updateItem(launch.id, { stage: '1' }), /it holds a sequence rather than sitting in a stage/)
    const lone = store.createItem({ project: 'Desktop', portfolio: 'TC', title: 'lone' })
    assert.throws(() => store.updateItem(lone.id, { stage: '1' }), /is in no epic, so it is in no sequence/)
  })

  test('changing parents keeps a stage only inside the same sequence', () => {
    const { launch, sync, brand, loose, a, d, e } = seed()
    store.setPlan(launch.id, [{ title: 'One', items: [a.id, d.id] }])
    // Between two epics of one initiative: still placed.
    store.updateItem(a.id, { epic: brand.id })
    assert.equal(stageOf(a.id)?.n, 1)
    // Out to an epic outside it: out of the stage, and the change says so.
    const out = store.updateItem(a.id, { epic: loose.id })
    assert.deepEqual(out.changes.slice(-1), [{ field: 'stage', from: '1 One', to: null }])
    // An epic leaving takes its tasks out of the initiative's stages.
    const left = store.updateItem(brand.id, { initiative: null })
    assert.deepEqual(left.changes, [
      { field: 'initiative', from: launch.id, to: null },
      { field: 'unplaced', from: null, to: '1' }
    ])
    assert.equal(stageOf(d.id), null)
    // An epic joining brings its stages to the end of the initiative's.
    store.setPlan(loose.id, [{ title: 'Loose first', items: [e.id] }])
    store.updateItem(loose.id, { initiative: launch.id })
    const plan = store.planOf(launch.id)
    assert.deepEqual(plan.stages.map((stage) => [stage.n, stage.title]), [[1, 'One'], [2, 'Loose first']])
    assert.deepEqual(stageOf(e.id), { uid: plan.stages[1].uid, n: 2, title: 'Loose first' })
    // A deleted epic's tasks leave the initiative's stages.
    store.deleteItem(loose.id)
    assert.equal(stageOf(e.id), null)
    assert.equal(stageOf(sync.id), null)
  })

  test('stages are added, renamed, moved and deleted, each logged on the owner', () => {
    const { launch, a } = seed()
    const one = store.addStage(launch.id, { title: 'One' }, 'You')
    const three = store.addStage(launch.id, { title: 'Three', goal: 'Done' }, 'You')
    const two = store.addStage(launch.id, { title: 'Two', at: 2 }, 'You')
    assert.deepEqual(store.planOf(launch.id).stages.map((stage) => stage.title), ['One', 'Two', 'Three'])
    assert.deepEqual(three, { uid: three.uid, n: 2, title: 'Three', goal: 'Done' })
    store.updateStage(two.uid, { title: 'Second', goal: 'Halfway' }, 'You')
    store.moveStage(one.uid, 3, 'You')
    assert.deepEqual(store.planOf(launch.id).stages.map((stage) => `${stage.n} ${stage.title}`), ['1 Second', '2 Three', '3 One'])
    store.updateItem(a.id, { stage: 'Three' })
    store.deleteStage(three.uid, 'You')
    assert.deepEqual(store.planOf(launch.id).stages.map((stage) => `${stage.n} ${stage.title}`), ['1 Second', '2 One'])
    assert.equal(stageOf(a.id), null)
    assert.deepEqual(
      store.getItem(launch.id).log.entries.map((entry) => entry.text),
      [
        'stage +1 · 1 One',
        'stage +1 · 2 Three',
        'stage +1 · 2 Two',
        'stage 2 renamed Two -> Second · stage 2 goal',
        'stage 1 moved to 3: One',
        'stage -1 · 2 Three · 1 item out of the sequence'
      ]
    )
    assert.throws(() => store.moveStage(two.uid, 3, 'You'), /A stage number is 1 to 2/)
    assert.throws(() => store.addStage(launch.id, { title: 'x', at: 9 }, 'You'), /A stage number is 1 to 3/)
  })

  test('the pages place an item last in a stage or before another, logging a change of stage', () => {
    const { launch, a, b, c } = seed()
    const plan = store.setPlan(launch.id, [{ title: 'One', items: [a.id, b.id] }, { title: 'Two' }])
    store.placeItem(c.id, plan.stages[0].uid, b.id, 'You')
    assert.deepEqual(store.planOf(launch.id).stages[0].items.map((entry) => entry.id), [a.id, c.id, b.id])
    store.placeItem(b.id, plan.stages[0].uid, a.id, 'You')
    assert.deepEqual(store.planOf(launch.id).stages[0].items.map((entry) => entry.id), [b.id, a.id, c.id])
    store.placeItem(a.id, '2', null, 'You')
    assert.deepEqual(store.planOf(launch.id).stages.map((stage) => stage.items.map((entry) => entry.id)), [[b.id, c.id], [a.id]])
    store.placeItem(a.id, null, null, 'You')
    assert.deepEqual(
      store.getItem(c.id).log.entries.map((entry) => entry.text),
      ['stage none -> 1 One']
    )
    assert.deepEqual(
      store.getItem(a.id).log.entries.map((entry) => entry.text),
      ['stage 1 One -> 2 Two', 'stage 2 Two -> none']
    )
    // Moving inside its own stage is not logged.
    assert.deepEqual(store.getItem(b.id).log.entries, [])
  })

  test('find lists the earlier stage first among work of one priority', () => {
    const { launch, a, b, c } = seed()
    store.setPlan(launch.id, [{ title: 'One', items: [c.id] }, { title: 'Two', items: [a.id] }])
    const { items } = store.findItems({ epic: 'TC-2' })
    assert.deepEqual(items.map((item) => item.id), [c.id, a.id, b.id])
    // Priority still comes first.
    store.updateItem(b.id, { priority: 'High' })
    assert.deepEqual(store.findItems({ epic: 'TC-2' }).items.map((item) => item.id), [b.id, c.id, a.id])
  })

  test('the item views carry the sequence they show and the stages an item can go in', () => {
    const { launch, sync, a, e } = seed()
    store.setPlan(launch.id, [{ title: 'One', items: [a.id] }])
    const forTask = store.itemOverview(a.id)
    assert.equal(forTask.plan, null)
    assert.deepEqual(forTask.placement?.owner.id, launch.id)
    assert.deepEqual(forTask.placement?.stages.map((stage) => [stage.n, stage.title]), [[1, 'One']])
    const forEpic = store.itemOverview(sync.id)
    assert.equal(forEpic.plan?.owner.id, launch.id)
    assert.deepEqual(forEpic.initiatives.map((initiative) => initiative.id), [launch.id])
    assert.equal(store.itemOverview(launch.id).plan?.owner.id, launch.id)
    assert.equal(store.itemOverview(launch.id).placement, null)
    assert.equal(store.itemOverview('TC-4').plan?.owner.id, 'TC-4')
    assert.equal(store.itemOverview(e.id).placement?.owner.id, 'TC-4')
    const overview = store.portfolioOverview('TC')
    assert.deepEqual(
      overview.initiatives.map((initiative) => [initiative.id, initiative.epics, initiative.current, initiative.stages.length, initiative.unplaced]),
      [[launch.id, 2, 1, 1, 3]]
    )
    assert.deepEqual(store.listPortfolios()[0].initiatives.map((initiative) => initiative.id), [launch.id])
  })
})

describe('the plan, worked out', () => {
  /**
   * @param {number} uid
   * @param {'initiative' | 'epic' | 'task'} kind
   * @param {string} group
   * @param {string | null} [epic]
   */
  const item = (uid, kind, group, epic = null) =>
    /** @type {import('../service/store.mjs').ItemSummary} */ ({
      uid,
      id: `T-${uid}`,
      kind,
      title: `item ${uid}`,
      portfolio: { uid: 1, key: 'T' },
      project: { uid: 1, name: 'P', colour: 'blue' },
      epic: epic === null ? null : { id: epic, title: 'e' },
      initiative: null,
      stage: null,
      status: { uid: 1, name: group, group, colour: 'muted', icon: 'todo' },
      priority: { uid: 1, name: 'Normal' },
      criteria: { done: 0, total: 0 },
      waitingOn: [],
      session: null,
      updatedAt: ''
    })
  const owner = { uid: 100, id: 'T-100', kind: /** @type {const} */ ('initiative'), title: 'Owner' }

  test('a stage of cancelled work only is done; an empty one is empty and never current', () => {
    const plan = buildPlan(
      owner,
      [
        { id: 1, position: 1, title: 'Empty', goal: '' },
        { id: 2, position: 2, title: 'Dropped', goal: '' },
        { id: 3, position: 3, title: 'Next', goal: '' }
      ],
      [
        { item: 11, stage: 2 },
        { item: 12, stage: 3 }
      ],
      [],
      [item(11, 'task', 'closed'), item(12, 'task', 'not-started')],
      []
    )
    assert.deepEqual(plan.stages.map((stage) => stage.state), ['empty', 'done', 'not-started'])
    assert.equal(plan.current, 3)
    assert.equal(stateOf(0, { done: 0, active: 0, total: 0 }), 'empty')
  })

  test('a placement of something outside the work is ignored', () => {
    const plan = buildPlan(owner, [{ id: 1, position: 1, title: 'One', goal: '' }], [{ item: 99, stage: 1 }], [], [], [])
    assert.deepEqual(plan.stages[0].items, [])
  })
})

describe('migration 4', () => {
  test('a schema 3 database gains initiatives and sequences with every row kept', () => {
    const { dir, remove } = tempDir()
    try {
      const file = join(dir, 'work.db')
      const db = new DatabaseSync(file)
      db.exec(MIGRATIONS[0])
      db.exec(MIGRATIONS[1])
      db.exec(MIGRATIONS[2])
      db.exec('PRAGMA user_version = 3')
      db.exec(`
        INSERT INTO portfolios (id, key, name, created_at, updated_at, next_number) VALUES (1, 'TC', 'TideCast', 't', 't', 3);
        INSERT INTO statuses (id, portfolio_id, name, grp, colour, icon, position, is_default) VALUES (1, 1, 'Backlog', 'not-started', 'subtle', 'backlog', 1, 1);
        INSERT INTO priorities (id, portfolio_id, name, position, is_default) VALUES (1, 1, 'Normal', 1, 1);
        INSERT INTO projects (id, portfolio_id, name, colour, position, created_at, updated_at) VALUES (1, 1, 'Desktop', 'blue', 1, 't', 't');
        INSERT INTO items (id, portfolio_id, number, kind, project_id, title, status_id, priority_id, position, created_at, updated_at)
          VALUES (1, 1, 1, 'epic', 1, 'Sync', 1, 1, 1, 't', 't');
        INSERT INTO items (id, portfolio_id, number, kind, project_id, epic_id, title, status_id, priority_id, position, created_at, updated_at)
          VALUES (2, 1, 2, 'task', 1, 1, 'Pull', 1, 1, 2, 't', 't');
        INSERT INTO criteria (item_id, position, text) VALUES (2, 1, 'It pulls');
        INSERT INTO dependencies (item_id, waits_on_id) VALUES (2, 1);
        INSERT INTO log (item_id, at, by, text) VALUES (2, 't', 'me', 'Created');
        INSERT INTO refs (item_id, kind, target, title, use, key, position, created_at) VALUES (1, 'url', 'https://example.com', 'x', 'y', 1, 1, 't');
      `)
      db.close()

      const migrated = new WorkStore(file)
      try {
        assert.equal(migrated.schemaVersion, MIGRATIONS.length)
        const task = migrated.getItem('TC-2')
        assert.deepEqual([task.epic?.id, task.criteriaList.length, task.waitsOn.map((other) => other.id), task.log.total], ['TC-1', 1, ['TC-1'], 1])
        assert.equal(migrated.inheritedRefs('TC-2').length, 1)
        assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), [])
        assert.equal(Number(migrated.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger'").get()?.n), 2)
        const initiative = migrated.createItem({ kind: 'initiative', project: 1, title: 'Launch' })
        migrated.updateItem('TC-1', { initiative: initiative.id })
        migrated.setPlan(initiative.id, [{ title: 'One', items: ['TC-2'] }])
        assert.equal(migrated.getItem('TC-2').stage?.n, 1)
        // Foreign keys are on again: deleting the epic lets go of its task.
        migrated.deleteItem('TC-1')
        assert.equal(migrated.getItem('TC-2').epic, null)
        assert.equal(migrated.getItem('TC-2').stage, null)
      } finally {
        migrated.close()
      }
    } finally {
      remove()
    }
  })
})
