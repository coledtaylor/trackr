import assert from 'node:assert/strict'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { WorkStore } from '../service/store.mjs'
import { runTool } from '../service/tools.mjs'

const HOME = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'
const APP = join(HOME, 'code', 'floti')
const SITE = join(HOME, 'code', 'floti-site')

/** @type {WorkStore} */
let store
let at = Date.parse('2026-11-02T14:00:00.000Z')

const agent = { id: 'sess-1', name: 'planner', cwd: APP }

/**
 * @param {string} name
 * @param {unknown} args
 */
const call = (name, args) => runTool(store, name, args, agent, { now: () => new Date(at), timeZone: 'UTC', home: HOME, pathState: () => 'present' })

beforeEach(() => {
  at = Date.parse('2026-11-02T14:00:00.000Z')
  store = new WorkStore(':memory:', { now: () => new Date((at += 1000)) })
  store.createPortfolio({ key: 'FL', name: 'Floti' })
  store.createProject({ portfolio: 'FL', name: 'App', folders: [APP] })
  store.createProject({ portfolio: 'FL', name: 'Website', folders: [SITE] })
})

/** An initiative of two epics and their tasks, with a sequence, made the way an agent makes it. */
const PLAN = {
  items: [
    {
      ref: 'floti',
      kind: 'initiative',
      title: 'Floti 3.0',
      description: 'Helm becomes Floti.',
      references: [{ target: 'https://claude.ai/artifact/floti-design', use: 'Read before any Floti work', key: true }],
      stages: [
        { title: 'Host', goal: 'The Rust host serves every session', items: ['host', 'web'] },
        { title: 'Release', goal: 'One command installs Floti', items: ['tag', 'site'] }
      ]
    },
    { ref: 'core', kind: 'epic', title: 'Rust host', initiative: 'floti' },
    { ref: 'ship', kind: 'epic', title: 'Ship it', initiative: 'floti' },
    { ref: 'host', title: 'Sessions on the host', epic: 'core' },
    { ref: 'web', title: 'Website on the host', epic: 'core', project: 'Website' },
    { ref: 'tag', title: 'One tag for the suite', epic: 'ship', waitsOn: ['host'] },
    { ref: 'site', title: 'floti.dev', epic: 'ship', project: 'Website' },
    { ref: 'later', title: 'Updater', epic: 'ship' }
  ]
}

describe('initiatives and sequences through the tools', () => {
  test('create makes an initiative, its epics and tasks, and its sequence in one call', () => {
    const reply = call('create', PLAN)
    assert.equal(
      reply,
      [
        'FL-1 initiative Floti 3.0 (App) · FL-2, FL-3 · sequence 2 stages, 4 items',
        'FL-2 epic Rust host (App) · FL-4, FL-5 · spans App, Website · initiative FL-1',
        'FL-3 epic Ship it (App) · FL-6, FL-7, FL-8 · spans App, Website · initiative FL-1',
        "FL-1's sequence: not in a stage, 1: FL-8."
      ].join('\n')
    )
    assert.equal(store.getItem('FL-1').log.entries[0].text, 'Created · sequence 2 stages, 4 items')
    // The initiative's key reference reaches a task of its epic.
    assert.match(call('get', { ids: ['FL-6'] }), /artifact https:\/\/claude\.ai\/artifact\/floti-design · Read before any Floti work · from initiative FL-1/)
  })

  test('get shows an initiative with its epics and its sequence, stage by stage', () => {
    call('create', PLAN)
    call('update', { items: [{ id: 'FL-4', status: 'Done' }] })
    const text = call('get', { ids: ['FL-1'], log: 0 })
    assert.equal(
      text,
      [
        'FL-1 Floti 3.0',
        'initiative · Backlog · Normal · Floti/App (~/code/floti) · 2 epics · 1 of 5 tasks done · spans App, Website',
        '',
        '## Description',
        'Helm becomes Floti.',
        '',
        '## References',
        'artifact https://claude.ai/artifact/floti-design · Read before any Floti work · key',
        'Read the ones whose use fits the work: artifacts with the Artifact tool.',
        '',
        '## Epics',
        'FL-2 Backlog · Normal · Rust host · App · 1 of 2 tasks done',
        'FL-3 Backlog · Normal · Ship it · App · 0 of 3 tasks done',
        '',
        '## Sequence: 2 stages, stage 1 under way',
        '1 Host · under way, 1 of 2 · goal: The Rust host serves every session',
        '  FL-4 Done · Sessions on the host',
        '  FL-5 Backlog · Website on the host',
        '2 Release · not started, 0 of 2 · goal: One command installs Floti',
        '  FL-6 Backlog · One tag for the suite',
        '  FL-7 Backlog · floti.dev',
        'Not in a stage, 1: FL-8. update stage puts one in a stage; stages rewrites the sequence.'
      ].join('\n')
    )
  })

  test('get shows where a task and an epic sit in the sequence', () => {
    call('create', PLAN)
    assert.match(call('get', { ids: ['FL-6'] }), /^stage: 2 of 2, Release, in the sequence of FL-1$/m)
    assert.match(call('get', { ids: ['FL-8'] }), /^stage: none of the 2 in the sequence of FL-1; update stage puts it in one$/m)
    const epic = call('get', { ids: ['FL-3'] })
    assert.match(epic, /^epic · Backlog · Normal · Floti\/App \(~\/code\/floti\) · initiative FL-1 Floti 3\.0 · 0 of 3 tasks done · spans App, Website$/m)
    assert.match(epic, /^ {2}FL-6 Backlog · Normal · One tag for the suite · stage 2 · waits on FL-4$/m)
    assert.match(epic, /^Its work is in stage 2 of FL-1's sequence of 2 stages \(get FL-1 shows it\)\.$/m)
    // A whole epic in a stage puts its tasks there too.
    call('update', { items: [{ id: 'FL-3', stage: 1 }] })
    assert.match(call('get', { ids: ['FL-8'] }), /^stage: 1 of 2, Host, in the sequence of FL-1, with the rest of epic FL-3$/m)
  })

  test('update moves one item by number, title or null, and says when the order breaks a wait', () => {
    call('create', PLAN)
    assert.equal(call('update', { items: [{ id: 'FL-8', stage: 'release' }] }), 'FL-8 stage none -> 2 Release')
    assert.equal(
      call('update', { items: [{ id: 'FL-4', stage: 2 }, { id: 'FL-6', stage: 1 }] }),
      ['FL-4 stage 1 Host -> 2 Release', 'FL-6 stage 2 Release -> 1 Host', 'FL-6 is out of order: FL-6 (stage 1) waits on FL-4 (stage 2).'].join('\n')
    )
    assert.equal(call('update', { items: [{ id: 'FL-8', stage: null }] }), 'FL-8 stage 2 Release -> none')
    assert.throws(() => call('update', { items: [{ id: 'FL-8', stage: 3 }] }), /3 is not a stage of FL-1\. Its stages are 1 Host, 2 Release/)
    assert.throws(() => call('update', { items: [{ id: 'FL-8', stage: 0 }] }), /FL-8\.stage is a stage's number \(1 is the first\), its title, or null/)
    assert.throws(() => call('update', { items: [{ id: 'FL-1', stage: 1 }] }), /it holds a sequence rather than sitting in a stage/)
  })

  test('update rewrites a whole sequence, and an epic outside an initiative holds its own', () => {
    call('create', PLAN)
    const reply = call('update', {
      items: [{ id: 'FL-1', stages: [{ title: 'All of it', items: ['FL-2', 'FL-3'] }], log: 'One stage until the host ships' }]
    })
    assert.equal(reply, 'FL-1 sequence 1 stage, 2 items · log +1')
    assert.equal(store.getItem('FL-1').log.entries.at(-1)?.text, 'One stage until the host ships · sequence 1 stage, 2 items')
    assert.equal(store.planOf('FL-1').unplaced.length, 0)
    // An epic leaving takes its work out of the initiative's stages.
    assert.equal(call('update', { items: [{ id: 'FL-3', initiative: null }] }), 'FL-3 initiative FL-1 -> none · stage 1 All of it -> none')
    assert.equal(call('update', { items: [{ id: 'FL-3', stages: [{ title: 'Tag', items: ['FL-6'] }, { title: 'Ship', items: ['FL-7', 'FL-8'] }] }] }), 'FL-3 sequence 2 stages, 3 items')
    // Joining again brings its stages to the end of the initiative's.
    assert.equal(call('update', { items: [{ id: 'FL-3', initiative: 'FL-1' }] }), 'FL-3 initiative none -> FL-1')
    assert.deepEqual(store.planOf('FL-1').stages.map((stage) => stage.title), ['All of it', 'Tag', 'Ship'])
    assert.throws(() => call('update', { items: [{ id: 'FL-3', stages: [] }] }), /FL-3: FL-3 is in initiative FL-1, whose sequence its work is placed in/)
    assert.throws(() => call('update', { items: [{ id: 'FL-1', stages: [{ title: 'x', items: ['FL-1'] }] }] }), /FL-1 is not in FL-1/)
    assert.throws(() => call('update', { items: [{ id: 'FL-1', stages: [{ name: 'x' }] }] }), /FL-1\.stages\[0\] does not take "name"\. It takes title, goal, items/)
  })

  test('find takes an initiative, and lines say initiative and stage', () => {
    call('create', PLAN)
    const text = call('find', { initiative: 'FL-1' })
    assert.equal(
      text,
      [
        'initiative FL-1 Floti 3.0, open: 7',
        'FL-4 Backlog · Normal · Sessions on the host · App · epic FL-2 · stage 1',
        'FL-5 Backlog · Normal · Website on the host · Website · epic FL-2 · stage 1',
        'FL-6 Backlog · Normal · One tag for the suite · App · epic FL-3 · stage 2 · waits on FL-4',
        'FL-7 Backlog · Normal · floti.dev · Website · epic FL-3 · stage 2',
        'FL-2 epic Backlog · Normal · Rust host · App · initiative FL-1',
        'FL-3 epic Backlog · Normal · Ship it · App · initiative FL-1',
        'FL-8 Backlog · Normal · Updater · App · epic FL-3'
      ].join('\n')
    )
    assert.throws(() => call('find', { initiative: 'FL-2' }), /FL-2 is an epic, not an initiative\. Pass it as epic\./)
    assert.throws(() => call('find', { epic: 'FL-1' }), /FL-1 is an initiative, not an epic\. Pass it as initiative\./)
  })

  test('get on a portfolio lists its open initiatives and where each stands', () => {
    call('create', PLAN)
    assert.match(call('get', { ids: ['FL'] }), /## Initiatives\nFL-1 Backlog · Floti 3\.0 · 2 epics · 0 of 5 tasks done · stage 1 of 2, Host/)
  })

  test('nothing nests the wrong way, and each refusal says where', () => {
    assert.throws(
      () => call('create', { items: [{ ref: 'i', kind: 'initiative', title: 'I' }, { title: 'T', epic: 'i' }] }),
      /items\[1\]: FL-1 is an initiative, not an epic/
    )
    assert.throws(
      () => call('create', { items: [{ ref: 'e', kind: 'epic', title: 'E' }, { kind: 'epic', title: 'F', initiative: 'e' }] }),
      /items\[1\]: FL-1 is an epic, not an initiative/
    )
    assert.throws(() => call('create', { items: [{ title: 'T', stages: [] }] }), /items\[0\]: FL-1 is a task\. A sequence belongs to an initiative, or to an epic outside one/)
    assert.throws(() => call('create', { items: [{ kind: 'epic', title: 'E', stage: 1 }] }), /items\[0\]: FL-1 is in no initiative, so it is in no stage/)
  })
})
