import assert from 'node:assert/strict'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { dispatchTool } from '../service/rpc.mjs'
import { WorkStore } from '../service/store.mjs'
import { parseArtifact, parseLink, runTool } from '../service/tools.mjs'

const HOME = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'
const DESKTOP = join(HOME, 'code', 'tidecast')
const API = join(HOME, 'code', 'tidecast-reporting')

/** A clock the test moves by hand. */
function clock(iso = '2026-10-06T14:00:00.000Z') {
  let at = Date.parse(iso)
  return {
    now: () => new Date(at),
    /** @param {string} next */
    set: (next) => {
      at = Date.parse(next)
    }
  }
}

/** @type {WorkStore} */
let store
/** @type {ReturnType<typeof clock>} */
let time

const s3 = { id: 'sess-3', name: 'saved views s3', cwd: DESKTOP }
const s4 = { id: 'sess-4', name: 'saved views s4', cwd: join(DESKTOP, 'reports') }
const api = { id: 'sess-api', name: 'api work', cwd: join(API, 'src') }
const elsewhere = { id: 'sess-x', name: 'elsewhere', cwd: join(HOME, 'Downloads') }

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{ id: string, name: string, cwd: string }} session
 */
const call = (name, args, session) => runTool(store, name, args, session, { now: time.now, timeZone: 'UTC', home: HOME })

beforeEach(() => {
  time = clock()
  store = new WorkStore(':memory:', { now: time.now })
  store.createPortfolio({ key: 'TC', name: 'TideCast' })
  store.createProject({ portfolio: 'TC', name: 'Desktop', folders: [DESKTOP] })
  store.createProject({ portfolio: 'TC', name: 'Reporting API', folders: [API] })
})

/** The plan from the design reference, made the way an agent makes it. */
const PLAN = {
  items: [
    { ref: 'e', kind: 'epic', title: 'Saved views', priority: 'High' },
    {
      ref: 'a',
      epic: 'e',
      title: 'View names in the usage report',
      ac: ['The usage report names each view', 'The CSV has a view column']
    },
    {
      ref: 'b',
      epic: 'e',
      title: 'Deleting a view keeps its history',
      priority: 'High',
      waitsOn: ['a'],
      ac: ['Deleting a view removes it from the tab', 'The usage report still names its punches'],
      links: ['branch feat/saved-views', { kind: 'pr', value: '#412', label: 'draft' }]
    },
    { epic: 'e', project: 'Reporting API', title: 'Ingest keeps view_type', waitsOn: ['b'] }
  ]
}

describe('create', () => {
  test('makes a whole plan in one call and answers with the IDs', () => {
    assert.equal(call('create', PLAN, s3), 'TC-1 epic Saved views (Desktop) · TC-2, TC-3, TC-4 · spans Desktop, Reporting API')
    const ingest = store.getItem('TC-4')
    assert.equal(ingest.project.name, 'Reporting API')
    assert.deepEqual(ingest.waitingOn, ['TC-3'])
    assert.equal(store.getItem('TC-3').links.length, 2)
  })

  test('tasks outside a new epic get a line each', () => {
    call('create', { items: [{ kind: 'epic', title: 'Old epic' }] }, s3)
    const reply = call(
      'create',
      {
        items: [
          { ref: 'x', title: 'Fix the crash', epic: 'TC-1' },
          { title: 'After the crash', waitsOn: ['x'], project: 'Reporting API' }
        ]
      },
      s3
    )
    assert.equal(reply, ['TC-2 Fix the crash (Desktop) · epic TC-1', 'TC-3 After the crash (Reporting API) · waits on TC-2'].join('\n'))
  })

  test('the project comes from the epic before the folder', () => {
    call('create', { items: [{ kind: 'epic', title: 'API epic', project: 'Reporting API' }] }, s3)
    assert.equal(call('create', { items: [{ title: 'In the epic', epic: 'TC-1' }] }, s3), 'TC-2 In the epic (Reporting API) · epic TC-1')
  })

  test('outside every project folder, a project must be named', () => {
    assert.throws(() => call('create', { items: [{ title: 'Lost' }] }, elsewhere), {
      message: `items[0] has no project, and ~/Downloads is in no project's folders. Pass project.`
    })
  })

  test('a failure anywhere in the call creates nothing', () => {
    assert.throws(() => call('create', { items: [{ title: 'Fine' }, { title: 'Bad', status: 'Doing' }] }, s3), /Doing is not a status here/)
    assert.equal(store.findItems({}).total, 0)
    assert.equal(call('create', { items: [{ title: 'First' }] }, s3), 'TC-1 First (Desktop)')
  })

  test('logs who created each item', () => {
    call('create', PLAN, s3)
    assert.deepEqual(store.getItem('TC-2').log.entries.map((e) => `${e.by}: ${e.text}`), ['saved views s3: Created'])
    assert.equal(store.getItem('TC-2').createdBy, 'saved views s3')
  })

  test('refuses unknown fields, refs that look like IDs, and refs that do not exist', () => {
    assert.throws(() => call('create', { items: [{ title: 'x', assignee: 'me' }] }, s3), {
      message: 'items[0] does not take "assignee". It takes ref, kind, project, epic, title, description, status, priority, ac, waitsOn, links, artifacts.'
    })
    assert.throws(() => call('create', { items: [{ ref: 'TC-9', title: 'x' }] }, s3), /looks like an ID/)
    assert.throws(() => call('create', { items: [{ title: 'x', waitsOn: ['nope'] }] }, s3), {
      message: 'items[0].waitsOn: nope is not an ID or a ref from this call.'
    })
    assert.throws(() => call('create', { items: [] }, s3), /at least one item/)
  })
})

describe('create portfolios and projects', () => {
  const NEWCO = join(HOME, 'code', 'newco')

  test('a portfolio starts with the default statuses and priorities, and the reply has its key', () => {
    assert.equal(
      call('create', { items: [{ kind: 'portfolio', key: 'nw', name: 'Newco', description: 'The new thing' }] }, elsewhere),
      'NW portfolio Newco · statuses Backlog, Planning, To do, In progress, In review, Blocked, Done, Cancelled · priorities Urgent, High, Normal, Low'
    )
    const portfolio = store.getPortfolio('NW')
    assert.equal(portfolio.description, 'The new thing')
    assert.equal(portfolio.statuses.find((status) => status.isDefault)?.name, 'Backlog')
    assert.equal(portfolio.priorities.find((priority) => priority.isDefault)?.name, 'Normal')
  })

  test('a project goes in the portfolio it names, with its folders', () => {
    const reply = call(
      'create',
      { items: [{ kind: 'project', portfolio: 'tc', name: 'Mobile', colour: 'Green', folders: [join(HOME, 'code', 'tidecast-mobile'), 'docs'] }] },
      elsewhere
    )
    assert.equal(reply, 'project TC/Mobile · ~/code/tidecast-mobile, ~/Downloads/docs')
    const mobile = store.getProject('Mobile', 'TC')
    assert.equal(mobile.colour, 'green')
    assert.deepEqual(mobile.folders, [join(HOME, 'code', 'tidecast-mobile'), join(HOME, 'Downloads', 'docs')])
    assert.equal(call('create', { items: [{ kind: 'project', portfolio: 'TC', name: 'Loose' }] }, elsewhere), 'project TC/Loose · no folders: no session lands in it until it has one')
  })

  test('a key already taken is refused with the reason, and nothing in the call is created', () => {
    const items = [{ kind: 'portfolio', key: 'NW', name: 'Newco' }, { kind: 'portfolio', key: 'TC', name: 'Again' }, { title: 'A task', project: 'Desktop' }]
    assert.throws(() => call('create', { items }, s3), { code: 'conflict', message: 'items[1]: A portfolio with the key TC already exists.' })
    assert.deepEqual(store.listPortfolios().map((portfolio) => portfolio.key), ['TC'])
    assert.equal(store.findItems({}).total, 0)
  })

  test('a folder another project owns is refused with the reason, and nothing in the call is created', () => {
    const items = [
      { kind: 'portfolio', key: 'NW', name: 'Newco' },
      { kind: 'project', portfolio: 'NW', name: 'App', folders: [NEWCO] },
      { kind: 'project', portfolio: 'NW', name: 'Web', folders: [DESKTOP] }
    ]
    assert.throws(() => call('create', { items }, s3), { code: 'conflict', message: `items[2]: ${DESKTOP} already belongs to TideCast/Desktop.` })
    assert.deepEqual(store.listPortfolios().map((portfolio) => portfolio.key), ['TC'])
    assert.equal(store.resolveFolder(NEWCO), null)
  })

  test('epics and tasks can name a portfolio and project made in the same call, in any order', () => {
    const session = { id: 'sess-nw', name: 'newco setup', cwd: join(NEWCO, 'src') }
    const reply = call(
      'create',
      {
        items: [
          { ref: 'e', kind: 'epic', title: 'First release', project: 'NW/App' },
          { epic: 'e', title: 'Scaffold the app', ac: ['It builds'] },
          { title: 'Lands by folder' },
          { kind: 'project', portfolio: 'NW', name: 'App', folders: [NEWCO] },
          { kind: 'portfolio', key: 'NW', name: 'Newco' }
        ]
      },
      session
    )
    assert.equal(
      reply,
      [
        'NW portfolio Newco · statuses Backlog, Planning, To do, In progress, In review, Blocked, Done, Cancelled · priorities Urgent, High, Normal, Low',
        'project NW/App · ~/code/newco',
        'NW-1 epic First release (App) · NW-2',
        'NW-3 Lands by folder (App)'
      ].join('\n')
    )
    assert.equal(store.getItem('NW-2').status.name, 'Backlog')
    assert.equal(store.getItem('NW-3').project.uid, store.getProject('App', 'NW').uid)
  })

  test('refuses an unknown kind, fields of another kind, and a colour that is not a project colour', () => {
    assert.throws(() => call('create', { items: [{ kind: 'team', name: 'x' }] }, s3), {
      message: 'items[0].kind is task, epic, project or portfolio, not "team".'
    })
    assert.throws(() => call('create', { items: [{ kind: 'portfolio', key: 'NW', name: 'Newco', title: 'x' }] }, s3), {
      message: 'items[0] does not take "title". It takes kind, key, name, description.'
    })
    assert.throws(() => call('create', { items: [{ kind: 'project', name: 'App' }] }, s3), { message: 'items[0].portfolio must be text.' })
    assert.throws(() => call('create', { items: [{ kind: 'project', portfolio: 'TC', name: 'App', colour: 'danger' }] }, s3), {
      message: 'items[0].colour is one of blue, orange, green, amber, pink.'
    })
    assert.throws(() => call('create', { items: [{ kind: 'project', portfolio: 'XX', name: 'App' }] }, s3), {
      code: 'not-found',
      message: 'items[0]: There is no portfolio XX.'
    })
  })
})

describe('get', () => {
  /** The task from the design reference, part way through. */
  function midway() {
    call('create', PLAN, s3)
    call('update', { items: [{ id: 'TC-2', status: 'Done' }] }, s3)
    time.set('2026-10-06T13:30:00.000Z')
    call('update', { items: [{ id: 'TC-3', status: 'In progress', description: 'A deleted view disappears going forward.' }] }, s3)
    time.set('2026-10-06T14:12:00.000Z')
    call(
      'update',
      {
        items: [
          {
            id: 'TC-3',
            ac: { check: [1] },
            handoff: { done: 'Soft-delete column and migration', left: "The usage report's label lookup", next: 'Let view_label() read deleted rows' },
            log: { text: 'Soft-delete column and migration', ref: 'a41c9e2' },
            links: { add: ['file reports/view_label.py'] }
          }
        ]
      },
      s3
    )
  }

  test('a task, as the design reference shows it', () => {
    midway()
    time.set('2026-10-07T09:00:00.000Z')
    assert.equal(
      call('get', { ids: ['TC-3'] }, s4),
      [
        'TC-3 Deleting a view keeps its history',
        'task · In progress · High · TideCast/Desktop (~/code/tidecast) · epic TC-1 Saved views',
        'session: saved views s3, last active Oct 6 14:12',
        'waits on: TC-2 Done (Desktop)',
        'blocks: TC-4 Backlog (Reporting API)',
        'links: branch feat/saved-views · PR #412 (draft) · file reports/view_label.py',
        '',
        '## Description',
        'A deleted view disappears going forward.',
        '',
        '## Acceptance criteria 1/2',
        '1 [x] Deleting a view removes it from the tab',
        '2 [ ] The usage report still names its punches',
        '',
        '## Where it stands (saved views s3, Oct 6 14:12)',
        'Done: Soft-delete column and migration',
        "Left: The usage report's label lookup",
        'Next: Let view_label() read deleted rows',
        '',
        '## Log, all 3',
        'Oct 6 14:00 saved views s3: Created',
        'Oct 6 13:30 saved views s3: Backlog -> In progress · description',
        'Oct 6 14:12 saved views s3: Soft-delete column and migration · AC 1/2 · handoff · link +1 (a41c9e2)'
      ].join('\n')
    )
  })

  test('an epic lists its tasks by project', () => {
    midway()
    assert.equal(
      call('get', { ids: ['TC-1'], log: 0 }, s3),
      [
        'TC-1 Saved views',
        'epic · Backlog · High · TideCast/Desktop (~/code/tidecast) · 1 of 3 tasks done · spans Desktop, Reporting API',
        '',
        '## Tasks',
        'Desktop',
        '  TC-3 In progress · High · Deleting a view keeps its history · AC 1/2 · session saved views s3',
        '  TC-2 Done · Normal · View names in the usage report · AC 0/2',
        'Reporting API',
        '  TC-4 Backlog · Normal · Ingest keeps view_type · waits on TC-3'
      ].join('\n')
    )
  })

  test('the log is the latest lines, and says how many there are', () => {
    midway()
    const reply = call('get', { ids: ['TC-3'], log: 1 }, s3)
    assert.match(reply, /## Log, latest 1 of 3\nOct 6 14:12 saved views s3: Soft-delete/)
  })

  test('several IDs, one of them missing', () => {
    call('create', { items: [{ title: 'Only one' }] }, s3)
    const reply = call('get', { ids: ['TC-1', 'TC-9'], log: 0 }, s3)
    assert.equal(reply, ['TC-1 Only one', 'task · Backlog · Normal · TideCast/Desktop (~/code/tidecast)', '', '---', '', 'TC-9 does not exist.'].join('\n'))
    assert.throws(() => call('get', { ids: ['TC-9'] }, s3), { message: 'TC-9 does not exist.' })
    assert.throws(() => call('get', {}, s3), /ids is a list of IDs/)
  })

  test('a date in another year shows the year', () => {
    call('create', { items: [{ title: 'Old' }] }, s3)
    time.set('2027-01-02T08:00:00.000Z')
    assert.match(call('get', { ids: ['TC-1'] }, s3), /Oct 6 2026 14:00 saved views s3: Created/)
  })
})

describe('update', () => {
  test('at the end of a session, as the design reference shows it', () => {
    call('create', PLAN, s3)
    call('update', { items: [{ id: 'TC-2', status: 'Done' }, { id: 'TC-3', status: 'In progress', ac: { check: [1] } }] }, s3)
    const reply = call(
      'update',
      {
        items: [
          {
            id: 'TC-3',
            status: 'Done',
            ac: { check: [2] },
            handoff: { done: 'Label lookup reads deleted rows', left: '', next: '' },
            log: 'Verified usage report with a seeded deleted view',
            links: { add: ['commit b7f02c1'] }
          }
        ]
      },
      s3
    )
    assert.equal(reply, ['TC-3 In progress -> Done · AC 2/2 · handoff · log +1 · link +1', 'Now ready: TC-4 (Reporting API)'].join('\n'))
    assert.equal(store.getItem('TC-3').session, null, 'a finished task lets go of its session')
    assert.deepEqual(store.getItem('TC-3').log.entries.at(-1), {
      at: '2026-10-06T14:00:00.000Z',
      by: 'saved views s3',
      text: 'Verified usage report with a seeded deleted view · In progress -> Done · AC 2/2 · handoff · link +1',
      ref: null
    })
  })

  test('done with a criterion unchecked is allowed and said', () => {
    call('create', { items: [{ title: 'T', ac: ['a', 'b', 'c'], status: 'In progress' }] }, s3)
    assert.equal(
      call('update', { items: [{ id: 'TC-1', status: 'Done', ac: { check: [1, 2] }, log: 'Shipped' }] }, s3),
      'TC-1 In progress -> Done · AC 2/3, 1 unchecked · log +1'
    )
  })

  test('done without touching criteria still reports them', () => {
    call('create', { items: [{ title: 'T', ac: ['a', 'b'] }] }, s3)
    assert.equal(call('update', { items: [{ id: 'TC-1', status: 'Done' }] }, s3), 'TC-1 Backlog -> Done · AC 0/2, 2 unchecked')
  })

  test('a second session is told who had the task, and gets it', () => {
    call('create', { items: [{ title: 'Shared' }] }, s3)
    time.set('2026-10-06T14:12:00.000Z')
    call('update', { items: [{ id: 'TC-1', status: 'In progress' }] }, s3)
    call('update', { items: [{ id: 'TC-1', status: 'To do' }] }, s3)
    assert.equal(store.getItem('TC-1').session, null, 'leaving the active group lets go')
    call('update', { items: [{ id: 'TC-1', status: 'In progress' }] }, s3)
    time.set('2026-10-06T16:00:00.000Z')
    const reply = call('update', { items: [{ id: 'TC-1', status: 'In review' }] }, s4)
    assert.equal(
      reply,
      [
        'TC-1 In progress -> In review',
        'TC-1 was being worked on by saved views s3 (last active Oct 6 14:12). It is recorded as this session\'s now; check with the user if that session may still be running.'
      ].join('\n')
    )
    assert.equal(store.getItem('TC-1').session?.name, 'saved views s4')
  })

  test('the same session working on its task keeps it fresh', () => {
    call('create', { items: [{ title: 'Mine', status: 'In progress' }] }, s3)
    time.set('2026-10-06T18:00:00.000Z')
    call('update', { items: [{ id: 'TC-1', log: 'still at it' }] }, s3)
    assert.equal(store.getItem('TC-1').session?.activeAt, '2026-10-06T18:00:00.000Z')
    call('update', { items: [{ id: 'TC-1', log: 'drive-by' }] }, s4)
    assert.equal(store.getItem('TC-1').session?.name, 'saved views s3', 'a log line from another session does not take it')
  })

  test('fields, criteria edits, links and dependencies, each said once', () => {
    call('create', PLAN, s3)
    const reply = call(
      'update',
      {
        items: [
          {
            id: 'TC-3',
            title: 'Deleting a view keeps all of its history',
            priority: 'Urgent',
            project: 'Reporting API',
            epic: null,
            ac: { edit: { 2: 'The usage report names deleted views' }, remove: [1], add: ['A new one'] },
            links: { remove: ['PR #412'] },
            waitsOn: { remove: ['TC-2'] }
          }
        ]
      },
      s3
    )
    assert.equal(reply, 'TC-3 priority High -> Urgent · title · moved Desktop -> Reporting API · epic TC-1 -> none · AC 0/2 · link -1 · waits on -1')
    const task = store.getItem('TC-3')
    assert.deepEqual(task.criteriaList.map((c) => c.text), ['The usage report names deleted views', 'A new one'])
    assert.deepEqual(task.links.map((l) => l.value), ['feat/saved-views'])
    assert.deepEqual(task.waitingOn, [])
  })

  test('nothing to change says so and logs nothing', () => {
    call('create', { items: [{ title: 'T' }] }, s3)
    assert.equal(call('update', { items: [{ id: 'TC-1', status: 'backlog' }] }, s3), 'TC-1 unchanged')
    assert.equal(store.getItem('TC-1').log.total, 1)
  })

  test('cancelling is how an agent drops work; it frees what waited', () => {
    call('create', { items: [{ ref: 'a', title: 'A' }, { title: 'B', waitsOn: ['a'] }] }, s3)
    assert.equal(call('update', { items: [{ id: 'TC-1', status: 'Cancelled' }] }, s3), 'TC-1 Backlog -> Cancelled\nNow ready: TC-2 (Desktop)')
  })

  test('a failure anywhere in the call changes nothing', () => {
    call('create', { items: [{ title: 'A' }, { title: 'B' }] }, s3)
    assert.throws(
      () => call('update', { items: [{ id: 'TC-1', status: 'Done' }, { id: 'TC-2', ac: { check: [3] } }] }, s3),
      { message: 'TC-2 has no criteria.' }
    )
    assert.equal(store.getItem('TC-1').status.name, 'Backlog')
  })

  test('bad arguments name the field', () => {
    call('create', { items: [{ title: 'A' }] }, s3)
    assert.throws(() => call('update', { items: [{ id: 'TC-1', state: 'Done' }] }, s3), /TC-1 does not take "state"/)
    assert.throws(() => call('update', { items: [{ id: 'TC-1', ac: { check: ['1'] } }] }, s3), /criterion numbers/)
    assert.throws(() => call('update', { items: [{ id: 'TC-1', handoff: 'done' }] }, s3), /TC-1.handoff must be an object/)
    assert.throws(() => call('update', { items: [{ id: 'TC-1', links: { add: ['jira X-1'] } }] }, s3), /is not a link/)
    assert.throws(() => call('update', { items: [{ title: 'no id' }] }, s3), /items\[0\].id must be text/)
  })
})

describe('find', () => {
  function board() {
    call('create', PLAN, s3)
    call(
      'create',
      {
        items: [
          { title: 'Running a report causes a crash', status: 'To do', priority: 'Urgent' },
          { title: 'The editor does not display', status: 'Done' }
        ]
      },
      s3
    )
    call('create', { items: [{ title: 'Token endpoint returns tenant_id', status: 'In progress' }] }, api)
  }

  test('no arguments: open work in this folder’s project, next first', () => {
    board()
    assert.equal(
      call('find', {}, s3),
      [
        'TideCast/Desktop, open: 4',
        'TC-5 To do · Urgent · Running a report causes a crash',
        'TC-1 epic Backlog · High · Saved views',
        'TC-3 Backlog · High · Deleting a view keeps its history · epic TC-1 · AC 0/2 · waits on TC-2',
        'TC-2 Backlog · Normal · View names in the usage report · epic TC-1 · AC 0/2'
      ].join('\n')
    )
  })

  test('a deeper folder picks its own project', () => {
    board()
    assert.equal(
      call('find', {}, api),
      [
        'TideCast/Reporting API, open: 2',
        'TC-7 In progress · Normal · Token endpoint returns tenant_id · session api work',
        'TC-4 Backlog · Normal · Ingest keeps view_type · epic TC-1 · waits on TC-3'
      ].join('\n')
    )
  })

  test('outside every project it lists every portfolio and says why', () => {
    board()
    const reply = call('find', { limit: 2 }, elsewhere)
    assert.equal(
      reply,
      [
        'every portfolio, open: 6',
        'TC-7 In progress · Normal · Token endpoint returns tenant_id · Reporting API · session api work',
        'TC-5 To do · Urgent · Running a report causes a crash · Desktop',
        '4 more. Raise limit or narrow the filter.',
        "~/Downloads is in no project's folders, so this is every portfolio. Pass project to narrow it."
      ].join('\n')
    )
  })

  test('filters: ready, status, text, epic, portfolio', () => {
    board()
    assert.equal(call('find', { ready: true }, s3).split('\n')[0], 'TideCast/Desktop, open, ready: 3')
    assert.equal(call('find', { status: 'Done' }, s3), 'TideCast/Desktop, Done: 1\nTC-6 Done · Normal · The editor does not display')
    assert.equal(call('find', { status: 'any', text: 'view' }, s3).split('\n')[0], 'TideCast/Desktop, "view": 3')
    assert.equal(call('find', { text: 'tc-4' }, api).split('\n')[1], 'TC-4 Backlog · Normal · Ingest keeps view_type · epic TC-1 · waits on TC-3')
    assert.equal(
      call('find', { epic: 'TC-1' }, elsewhere).split('\n')[0],
      'epic TC-1 Saved views, open: 3'
    )
    assert.equal(call('find', { portfolio: 'tc', status: ['In progress', 'To do'] }, s3).split('\n')[0], 'TideCast, In progress or To do: 2')
    assert.equal(call('find', { project: 'TC/Reporting API', text: 'nothing like it' }, s3), 'TideCast/Reporting API, open, "nothing like it": none')
  })

  test('bad filters say what they take', () => {
    assert.throws(() => call('find', { status: [] }, s3), /status is a status name/)
    assert.throws(() => call('find', { limit: 0 }, s3), /limit is a whole number from 1 to 200/)
    assert.throws(() => call('find', { owner: 'me' }, s3), /find does not take "owner"/)
    assert.throws(() => call('find', { project: 'Mobile' }, s3), { message: 'There is no project called Mobile.' })
  })
})

describe('links written as text', () => {
  test('parse the ways an agent writes them', () => {
    assert.deepEqual(parseLink('commit b7f02c1', 'x'), { kind: 'commit', value: 'b7f02c1' })
    assert.deepEqual(parseLink('PR #412', 'x'), { kind: 'pr', value: '412' })
    assert.deepEqual(parseLink('file reports/view label.py', 'x'), { kind: 'file', value: 'reports/view label.py' })
    assert.deepEqual(parseLink('https://example.com/a', 'x'), { kind: 'url', value: 'https://example.com/a' })
    assert.deepEqual(parseLink('https://claude.ai/artifact/abc', 'x'), { kind: 'artifact', value: 'https://claude.ai/artifact/abc' })
    assert.deepEqual(parseLink('artifact https://claude.ai/artifact/abc', 'x'), { kind: 'artifact', value: 'https://claude.ai/artifact/abc' })
    assert.throws(() => parseLink('branch', 'x'), /is not a link/)
  })
})

describe('artifacts', () => {
  const MOCKUP = 'https://claude.ai/artifact/mock1'
  const DESIGN = 'https://claude.ai/code/artifact/0b6f-42aa'

  test('parse an address or {url, label}, and refuse anything else', () => {
    assert.deepEqual(parseArtifact(MOCKUP, 'x'), { kind: 'artifact', value: MOCKUP, label: undefined })
    assert.deepEqual(parseArtifact({ url: ` ${DESIGN} `, label: ' Sync design ' }, 'x'), { kind: 'artifact', value: DESIGN, label: 'Sync design' })
    assert.throws(() => parseArtifact('https://example.com/artifact/abc', 'x'), {
      message: 'x: "https://example.com/artifact/abc" is not a claude.ai artifact. Give its address, like https://claude.ai/artifact/…, or {url, label}.'
    })
    assert.throws(() => parseArtifact('http://claude.ai/artifact/abc', 'x'), /is not a claude.ai artifact/)
    assert.throws(() => parseArtifact('https://claude.ai/chat/abc', 'x'), /is not a claude.ai artifact/)
    assert.throws(() => parseArtifact({ url: MOCKUP, kind: 'artifact' }, 'x'), /x does not take "kind"/)
    assert.throws(() => parseArtifact(42, 'x'), /x: that is not a claude.ai artifact/)
  })

  test("get lists them in their own section, the epic's after the task's, and not among links", () => {
    call(
      'create',
      {
        items: [
          { ref: 'e', kind: 'epic', title: 'Saved views', artifacts: [{ url: DESIGN, label: 'Saved views design' }, MOCKUP] },
          { epic: 'e', title: 'Rename a view', links: ['branch feat/rename'], artifacts: [{ url: MOCKUP, label: 'Rename mockup' }] }
        ]
      },
      s3
    )
    assert.equal(
      call('get', { ids: ['TC-2'], log: 0 }, s3),
      [
        'TC-2 Rename a view',
        'task · Backlog · Normal · TideCast/Desktop (~/code/tidecast) · epic TC-1 Saved views',
        'links: branch feat/rename',
        '',
        '## Artifacts',
        'Mockups and design documents for this work. Read one with the Artifact tool (action read) when the work touches it.',
        `Rename mockup · ${MOCKUP}`,
        `Saved views design · ${DESIGN} · from epic TC-1`
      ].join('\n')
    )
    const epic = call('get', { ids: ['TC-1'], log: 0 }, s3)
    assert.ok(epic.includes(`## Artifacts\nMockups and design documents for this work. Read one with the Artifact tool (action read) when the work touches it.\nSaved views design · ${DESIGN}\n${MOCKUP}\n`))
    assert.ok(!epic.includes('links:'))
  })

  test('an artifact link made before the field shows as an artifact', () => {
    call('create', { items: [{ title: 'Old', links: [`artifact ${MOCKUP}`] }] }, s3)
    const text = call('get', { ids: ['TC-1'], log: 0 }, s3)
    assert.ok(text.endsWith(`## Artifacts\nMockups and design documents for this work. Read one with the Artifact tool (action read) when the work touches it.\n${MOCKUP}`))
    assert.ok(!text.includes('links:'))
  })

  test('update adds, relabels and removes them, and says so', () => {
    call('create', { items: [{ title: 'T', links: ['branch feat/x'] }] }, s3)
    assert.equal(call('update', { items: [{ id: 'TC-1', artifacts: { add: [MOCKUP, DESIGN] } }] }, s3), 'TC-1 artifact +2')
    call('update', { items: [{ id: 'TC-1', artifacts: { add: [{ url: MOCKUP, label: 'Settings mockup' }] } }] }, s3)
    assert.deepEqual(
      store.getItem('TC-1').links.map((l) => [l.kind, l.value, l.label]),
      [
        ['branch', 'feat/x', ''],
        ['artifact', MOCKUP, 'Settings mockup'],
        ['artifact', DESIGN, '']
      ]
    )
    assert.equal(call('update', { items: [{ id: 'TC-1', artifacts: { remove: [DESIGN] }, links: { remove: ['feat/x'] } }] }, s3), 'TC-1 link -1 · artifact -1')
    assert.deepEqual(store.getItem('TC-1').links.map((l) => l.value), [MOCKUP])
    assert.equal(store.getItem('TC-1').log.entries.at(-1)?.text, 'link -1 · artifact -1')
    assert.throws(() => call('update', { items: [{ id: 'TC-1', artifacts: { remove: [DESIGN] } }] }, s3), {
      message: `TC-1.artifacts.remove: there is no artifact ${DESIGN}.`
    })
    assert.throws(() => call('update', { items: [{ id: 'TC-1', artifacts: { add: ['https://example.com'] } }] }, s3), /TC-1.artifacts.add: .* is not a claude.ai artifact/)
    assert.throws(() => call('update', { items: [{ id: 'TC-1', artifacts: [MOCKUP] }] }, s3), /TC-1.artifacts must be an object/)
  })

  test('a link of kind artifact must be a claude.ai artifact too', () => {
    assert.throws(() => call('create', { items: [{ title: 'T', links: ['artifact https://example.com/x'] }] }, s3), /is not a claude.ai artifact/)
    assert.throws(() => call('create', { items: [{ title: 'T', artifacts: ['nope'] }] }, s3), /items\[0\].artifacts: "nope" is not a claude.ai artifact/)
  })
})

describe('the service route', () => {
  test('answers text, and refusals with their status', () => {
    const format = { now: time.now, timeZone: 'UTC', home: HOME }
    assert.deepEqual(dispatchTool(store, { name: 'create', args: { items: [{ title: 'Over HTTP' }] }, session: s3 }, format), {
      status: 200,
      body: { text: 'TC-1 Over HTTP (Desktop)' }
    })
    assert.deepEqual(dispatchTool(store, { name: 'get', args: { ids: ['TC-2'] }, session: s3 }, format), {
      status: 404,
      body: { error: { code: 'not-found', message: 'TC-2 does not exist.' } }
    })
    assert.equal(dispatchTool(store, { name: 'delete', args: {}, session: s3 }).status, 400)
    // A session Helm described oddly still gets an answer, logged as "a session".
    assert.equal(dispatchTool(store, { name: 'update', args: { items: [{ id: 'TC-1', log: 'x' }] } }, format).status, 200)
    assert.equal(store.getItem('TC-1').log.entries.at(-1)?.by, 'a session')
  })
})
