import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { anchorPath, resolvePath } from '../service/folders.mjs'
import { MIGRATIONS } from '../service/schema.mjs'
import { WorkStore } from '../service/store.mjs'
import { memoryStore, seedTideCast, tempDir } from './helpers.mjs'

const USE = 'Read when changing the sync engine'
const MOCKUP = 'https://claude.ai/artifact/mock1'
const DESIGN = 'https://claude.ai/code/artifact/0b6f-42aa'

function tidecast() {
  const store = memoryStore()
  return { store, ...seedTideCast(store) }
}

/**
 * The stored form of a reference, under what the store hands back.
 *
 * @param {WorkStore} store
 * @param {number} uid
 */
function stored(store, uid) {
  return /** @type {{ target: string } | undefined} */ (store.db.prepare('SELECT target FROM refs WHERE id = ?').get(uid))?.target
}

/**
 * @param {WorkStore} store
 * @param {string} sql a count, as n
 */
function count(store, sql) {
  return Number(/** @type {{ n: number }} */ (store.db.prepare(sql).get()).n)
}

describe('migration 3', () => {
  test('moves every artifact link into refs, an epic\'s as key references, and leaves none in links', () => {
    const { dir, remove } = tempDir()
    try {
      const file = join(dir, 'work.db')
      // A database at schema 2, as PLUG-13 left it.
      const db = new DatabaseSync(file)
      db.exec(MIGRATIONS[0])
      db.exec(MIGRATIONS[1])
      db.exec('PRAGMA user_version = 2')
      const at = '2026-10-01T12:00:00.000Z'
      db.exec(`
        INSERT INTO portfolios (id, key, name, created_at, updated_at) VALUES (1, 'TC', 'TideCast', '${at}', '${at}');
        INSERT INTO statuses (id, portfolio_id, name, grp, colour, icon, position, is_default) VALUES (1, 1, 'Backlog', 'not-started', 'subtle', 'backlog', 1, 1);
        INSERT INTO priorities (id, portfolio_id, name, position, is_default) VALUES (1, 1, 'Normal', 1, 1);
        INSERT INTO projects (id, portfolio_id, name, colour, position, created_at, updated_at) VALUES (1, 1, 'Desktop', 'blue', 1, '${at}', '${at}');
        INSERT INTO items (id, portfolio_id, number, kind, project_id, epic_id, title, status_id, priority_id, position, created_at, updated_at)
          VALUES (1, 1, 1, 'epic', 1, NULL, 'Saved views', 1, 1, 1, '${at}', '${at}'),
                 (2, 1, 2, 'task', 1, 1, 'Rename a view', 1, 1, 2, '${at}', '${at}');
        INSERT INTO links (item_id, kind, value, label, position, created_at) VALUES
          (1, 'artifact', '${DESIGN}', 'Saved views design', 1, '${at}'),
          (1, 'branch', 'feat/views', '', 2, '${at}'),
          (1, 'artifact', '${MOCKUP}', '', 3, '${at}'),
          (2, 'artifact', '${MOCKUP}', 'Rename mockup', 1, '${at}'),
          (2, 'file', 'src/views.ts', '', 2, '${at}');
      `)
      db.close()

      const store = new WorkStore(file)
      try {
        assert.equal(store.schemaVersion, MIGRATIONS.length)
        assert.equal(count(store, "SELECT count(*) AS n FROM links WHERE kind = 'artifact'"), 0, 'no artifact is left in links')
        const kept = (/** @type {string} */ id) => store.getItem(id).links.map((link) => [link.kind, link.value])
        assert.deepEqual(kept('TC-1'), [['branch', 'feat/views']])
        assert.deepEqual(kept('TC-2'), [['file', 'src/views.ts']])

        const shape = (/** @type {import('../service/store.mjs').Reference} */ ref) => [ref.kind, ref.target, ref.title, ref.use, ref.key]
        assert.deepEqual(store.listRefs({ item: 'TC-1' }).map(shape), [
          ['artifact', DESIGN, 'Saved views design', 'Design or mockup for this work', true],
          ['artifact', MOCKUP, MOCKUP, 'Design or mockup for this work', true]
        ])
        assert.deepEqual(store.listRefs({ item: 'TC-2' }).map(shape), [['artifact', MOCKUP, 'Rename mockup', 'Design or mockup for this work', false]])

        // The task still sees its epic's, as it did.
        assert.deepEqual(store.inheritedRefs('TC-2').map((ref) => [ref.target, ref.from.level, ref.from.name]), [
          [DESIGN, 'epic', 'TC-1'],
          [MOCKUP, 'epic', 'TC-1']
        ])
      } finally {
        store.close()
      }
    } finally {
      remove()
    }
  })

  test('a reference has exactly one owner', () => {
    const { store, portfolio, desktop } = tidecast()
    const insert = (/** @type {string} */ owners, /** @type {number[]} */ ids) =>
      store.db
        .prepare(`INSERT INTO refs (${owners}kind, target, title, use, position, created_at) VALUES (${ids.map(() => '?, ').join('')}'url', 'https://x.dev', 'X', 'Read', 1, 'now')`)
        .run(...ids)
    assert.throws(() => insert('', []), /CHECK constraint failed/)
    assert.throws(() => insert('portfolio_id, project_id, ', [portfolio.uid, desktop.uid]), /CHECK constraint failed/)
    insert('project_id, ', [desktop.uid])
    assert.equal(store.listRefs({ project: desktop.uid }).length, 1)
  })
})

describe('references', () => {
  test('add, list, reorder and remove on each of the four owners', () => {
    const { store } = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Epic' })
    const task = store.createItem({ project: 'Desktop', title: 'Task', epic: epic.id })
    /** @type {import('../service/store.mjs').RefOwner[]} */
    const owners = [{ portfolio: 'TC' }, { project: 'Desktop', portfolio: 'TC' }, { item: epic.id }, { item: task.uid }]
    for (const owner of owners) {
      const doc = store.addRef(owner, { kind: 'doc', target: 'https://www.notion.so/design', title: 'Design', use: USE, key: true })
      const url = store.addRef(owner, { kind: 'url', target: 'https://example.com/api', use: USE })
      const artifact = store.addRef(owner, { kind: 'artifact', target: MOCKUP, title: 'Mockup', use: USE })
      assert.deepEqual(doc, { uid: doc.uid, kind: 'doc', target: 'https://www.notion.so/design', title: 'Design', use: USE, key: true })
      assert.equal(url.title, 'https://example.com/api', 'the title is the target when none is given')
      assert.equal(url.key, false)
      assert.deepEqual(store.listRefs(owner).map((ref) => ref.uid), [doc.uid, url.uid, artifact.uid])
      assert.deepEqual(store.reorderRefs(owner, [artifact.uid, doc.uid, url.uid]).map((ref) => ref.kind), ['artifact', 'doc', 'url'])
      store.removeRef(owner, doc.uid)
      assert.deepEqual(store.listRefs(owner).map((ref) => ref.kind), ['artifact', 'url'])
    }
    // Each owner kept its own.
    assert.equal(store.listRefs({ portfolio: 'TC' }).length, 2)
    assert.equal(store.listRefs({ item: task.id }).length, 2)
    assert.deepEqual(store.getItem(task.id).refs.map((ref) => ref.kind), ['artifact', 'url'])
  })

  test('the same kind and target is one reference, and the fields given replace its own', () => {
    const { store } = tidecast()
    const first = store.addRef({ project: 'Desktop' }, { kind: 'artifact', target: MOCKUP, title: 'Mockup', use: USE })
    const again = store.addRef({ project: 'Desktop' }, { kind: 'artifact', target: ` ${MOCKUP} `, key: true })
    assert.deepEqual(again, { ...first, key: true })
    const relabelled = store.addRef({ project: 'Desktop' }, { kind: 'artifact', target: MOCKUP, title: 'Settings mockup', use: 'Read for the settings page' })
    assert.deepEqual([relabelled.title, relabelled.use, relabelled.key], ['Settings mockup', 'Read for the settings page', true])
    assert.equal(store.listRefs({ project: 'Desktop' }).length, 1)
  })

  test('refuses what is not a reference', () => {
    const { store } = tidecast()
    const add = (/** @type {any} */ input) => () => store.addRef({ portfolio: 'TC' }, input)
    assert.throws(add({ kind: 'url', target: 'https://x.dev' }), {
      code: 'invalid',
      message: 'A reference needs a use line: when to read it, like "Read when changing the sync engine".'
    })
    assert.throws(add({ kind: 'url', target: 'https://x.dev', use: '  ' }), { message: 'Use line is required.' })
    assert.throws(add({ kind: 'url', target: 'https://x.dev', use: 'x'.repeat(501) }), { message: 'Use line is longer than 500 characters.' })
    assert.throws(add({ kind: 'url', target: 'https://x.dev', use: USE, title: 'x'.repeat(301) }), { message: 'Title is longer than 300 characters.' })
    assert.throws(add({ kind: 'link', target: 'https://x.dev', use: USE }), { message: "A reference's kind is one of artifact, doc, file, url." })
    assert.throws(add({ kind: 'artifact', target: 'https://claude.ai/chat/abc', use: USE }), /is not a claude.ai artifact/)
    assert.throws(add({ kind: 'doc', target: 'notion page', use: USE }), {
      message: 'notion page is not a web address. A doc reference starts with https:// or http://.'
    })
    assert.throws(add({ kind: 'url', target: 'ftp://x.dev/a', use: USE }), /is not a web address/)
    assert.throws(add({ kind: 'file', target: 'src/a.ts', use: USE }), {
      message: 'src/a.ts is not an absolute path. A file reference names the file in full.'
    })
    assert.throws(add({ kind: 'url', target: 'https://x.dev', use: USE, key: 'yes' }), { message: 'key must be true or false.' })
    assert.throws(() => store.addRef(/** @type {any} */ ({}), { kind: 'url', target: 'https://x.dev', use: USE }), {
      message: 'Say whose references: an item, a project or a portfolio.'
    })
    assert.throws(() => store.removeRef({ portfolio: 'TC' }, 99), { code: 'not-found', message: 'TC has no reference 99.' })
    assert.deepEqual(store.listRefs({ portfolio: 'TC' }), [], 'a refused add changed nothing')
  })

  test('with no kind, the target says which it is', () => {
    const { store, root } = tidecast()
    const add = (/** @type {string} */ target) => store.addRef({ portfolio: 'TC' }, { target, use: USE }).kind
    assert.deepEqual(
      [add(MOCKUP), add('https://www.notion.so/acme/Design'), add('https://example.com/a'), add(join(root, 'notes.md'))],
      ['artifact', 'doc', 'url', 'file']
    )
    assert.equal(store.addRef({ portfolio: 'TC' }, { kind: '', target: 'https://example.com/b', use: USE }).kind, 'url', 'an empty kind is no kind')
    assert.throws(() => store.addRef({ portfolio: 'TC' }, { target: 'notes.md', use: USE }), { message: 'notes.md is not an absolute path. A file reference names the file in full.' })
  })

  test('updateRef changes a reference where it is in the order', () => {
    const { store, root } = tidecast()
    const owner = { project: 'Desktop' }
    const first = store.addRef(owner, { kind: 'url', target: 'https://a.dev', use: USE })
    const second = store.addRef(owner, { kind: 'doc', target: 'https://wiki.acme.dev/sync', title: 'Sync', use: USE })
    const third = store.addRef(owner, { kind: 'url', target: 'https://c.dev', use: USE })

    // A new target with no kind takes its own kind; a title that repeated the old target follows it.
    const moved = store.updateRef(owner, first.uid, { target: MOCKUP })
    assert.deepEqual(moved, { uid: first.uid, kind: 'artifact', target: MOCKUP, title: MOCKUP, use: USE, key: false })
    // The same target keeps an explicit kind; a title of its own stays.
    const same = store.updateRef(owner, second.uid, { target: ' https://wiki.acme.dev/sync ', use: 'Read for sync', key: true })
    assert.deepEqual(same, { uid: second.uid, kind: 'doc', target: 'https://wiki.acme.dev/sync', title: 'Sync', use: 'Read for sync', key: true })
    assert.deepEqual(store.updateRef(owner, second.uid, { target: 'https://wiki.acme.dev/other' }).title, 'Sync')
    assert.equal(store.updateRef(owner, second.uid, { target: 'https://wiki.acme.dev/other', kind: 'doc' }).kind, 'doc')
    assert.equal(store.updateRef(owner, second.uid, { title: '' }).title, 'https://wiki.acme.dev/other', 'an empty title is the target')
    // A file is stored against the project's folder, as when added.
    const file = store.updateRef(owner, third.uid, { target: join(root, 'tide cast', 'docs', 'a.md') })
    assert.deepEqual([file.kind, file.title, stored(store, third.uid)], ['file', 'docs/a.md', 'docs/a.md'])
    assert.deepEqual(store.listRefs(owner).map((ref) => ref.uid), [first.uid, second.uid, third.uid], 'the order is kept')

    assert.throws(() => store.updateRef(owner, third.uid, { target: MOCKUP }), { code: 'conflict', message: `Desktop already has a reference to ${MOCKUP}.` })
    assert.throws(() => store.updateRef(owner, third.uid, { kind: 'url' }), /is not a web address/)
    assert.throws(() => store.updateRef(owner, third.uid, { use: ' ' }), { message: 'Use line is required.' })
    assert.throws(() => store.updateRef(owner, third.uid, { key: /** @type {any} */ ('yes') }), { message: 'key must be true or false.' })
    assert.throws(() => store.updateRef({ portfolio: 'TC' }, third.uid, { use: USE }), { code: 'not-found', message: `TC has no reference ${third.uid}.` })
    assert.equal(store.listRefs(owner)[2].kind, 'file', 'a refused change changed nothing')
  })

  test('reordering names each reference once', () => {
    const { store } = tidecast()
    const owner = { project: 'Desktop' }
    const a = store.addRef(owner, { kind: 'url', target: 'https://a.dev', use: USE })
    const b = store.addRef(owner, { kind: 'url', target: 'https://b.dev', use: USE })
    assert.throws(() => store.reorderRefs(owner, [a.uid]), { message: 'The new order must name each of the 2 references of Desktop once.' })
    assert.throws(() => store.reorderRefs(owner, [a.uid, a.uid]), { message: `Reference ${a.uid} is named twice in the new order.` })
    assert.throws(() => store.reorderRefs(owner, [a.uid, 99]), { message: '99 is not one of the references of Desktop.' })
    assert.deepEqual(store.reorderRefs(owner, [b.uid, a.uid]).map((ref) => ref.uid), [b.uid, a.uid])
  })

  test("an item's references go with it, and a project's with it", () => {
    const { store } = tidecast()
    const task = store.createItem({ project: 'Reporting API', title: 'Task', refs: [{ kind: 'url', target: 'https://a.dev', use: USE }] })
    store.addRef({ project: 'Reporting API' }, { kind: 'url', target: 'https://b.dev', use: USE })
    store.deleteItem(task.id)
    store.deleteProject('Reporting API')
    assert.equal(count(store, 'SELECT count(*) AS n FROM refs'), 0)
  })
})

describe('inherited references', () => {
  test("a task inherits the key references of its epic, project and portfolio, in that order", () => {
    const { store } = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Reporting API', title: 'Epic' })
    const task = store.createItem({ project: 'Desktop', title: 'Task', epic: epic.id })
    const add = (/** @type {import('../service/store.mjs').RefOwner} */ owner, /** @type {string} */ name, key = true) =>
      store.addRef(owner, { kind: 'url', target: `https://docs.dev/${name}`, title: name, use: USE, key })
    add({ portfolio: 'TC' }, 'portfolio 1')
    add({ portfolio: 'TC' }, 'portfolio quiet', false)
    add({ portfolio: 'TC' }, 'portfolio 2')
    add({ project: 'Desktop' }, 'desktop')
    add({ project: 'Reporting API' }, 'api, the epic\'s project')
    add({ item: epic.id }, 'epic 1')
    add({ item: epic.id }, 'epic quiet', false)
    add({ item: epic.id }, 'epic 2')
    add({ item: task.id }, 'task own')

    const lines = (/** @type {string} */ id) => store.inheritedRefs(id).map((ref) => `${ref.from.level} ${ref.from.name}: ${ref.title}`)
    assert.deepEqual(lines(task.id), [
      `epic ${epic.id}: epic 1`,
      `epic ${epic.id}: epic 2`,
      'project Desktop: desktop',
      'portfolio TC: portfolio 1',
      'portfolio TC: portfolio 2'
    ])
    assert.deepEqual(lines(epic.id), ["project Reporting API: api, the epic's project", 'portfolio TC: portfolio 1', 'portfolio TC: portfolio 2'])
    const loose = store.createItem({ project: 'Desktop', title: 'Loose' })
    assert.deepEqual(lines(loose.id), ['project Desktop: desktop', 'portfolio TC: portfolio 1', 'portfolio TC: portfolio 2'])
    assert.equal(store.inheritedRefs(task.id)[0].from.uid, epic.uid)
  })

  test("the item view shows what an item inherits that its own do not name, and which files are gone", () => {
    const { store, root } = tidecast()
    const epic = store.createItem({ kind: 'epic', project: 'Desktop', title: 'Epic' })
    const task = store.createItem({ project: 'Desktop', title: 'Task', epic: epic.id })
    const gone = join(root, 'gone.md')
    const here = join(root, 'here.md')
    store.addRef({ portfolio: 'TC' }, { kind: 'url', target: 'https://docs.dev/shared', title: 'Portfolio copy', use: USE, key: true })
    store.addRef({ portfolio: 'TC' }, { kind: 'file', target: gone, use: USE, key: true })
    store.addRef({ item: epic.id }, { kind: 'url', target: 'https://docs.dev/shared', title: 'Epic copy', use: USE, key: true })
    store.addRef({ item: epic.id }, { kind: 'url', target: 'https://docs.dev/mine', use: USE, key: true })
    const own = store.addRef({ item: task.id }, { kind: 'url', target: 'https://docs.dev/mine', title: 'Mine', use: USE })
    const file = store.addRef({ item: task.id }, { kind: 'file', target: here, use: USE })

    const pathState = (/** @type {string} */ path) => (path === gone ? 'missing' : path === here ? 'present' : 'unknown')
    const view = store.itemOverview(task.id, { pathState })
    assert.deepEqual(view.item.refs.map((ref) => ref.uid), [own.uid, file.uid])
    assert.deepEqual(
      view.inherited.map((ref) => [ref.title, ref.from.level]),
      [['Epic copy', 'epic'], [gone, 'portfolio']]
    )
    assert.deepEqual(view.missing, [view.inherited[1].uid])
    assert.deepEqual(store.itemOverview(epic.id, { pathState }).inherited.map((ref) => ref.title), [gone], "the epic's own copy shadows the portfolio's")

    const portfolio = store.portfolioOverview('TC', { pathState })
    assert.deepEqual([portfolio.refs.length, portfolio.missing], [2, [portfolio.refs[1].uid]])
    store.addRef({ project: 'Desktop' }, { kind: 'file', target: gone, use: USE })
    const project = store.projectOverview('Desktop', 'TC', { pathState })
    assert.deepEqual([project.refs.map((ref) => ref.target), project.missing], [[gone], [project.refs[0].uid]])
  })

  test('nothing to inherit is an empty list', () => {
    const { store } = tidecast()
    const task = store.createItem({ project: 'Desktop', title: 'Task' })
    assert.deepEqual(store.inheritedRefs(task.id), [])
  })
})

describe('file references', () => {
  test("a file inside the owner's project folder is stored relative and read back absolute", () => {
    const { store, root } = tidecast()
    const desktop = join(root, 'tide cast')
    const task = store.createItem({ project: 'Desktop', title: 'Task' })
    const inside = store.addRef({ item: task.id }, { kind: 'file', target: join(desktop, 'docs', 'sync design.md'), use: USE })
    const outside = store.addRef({ item: task.id }, { kind: 'file', target: join(root, 'elsewhere', 'notes.md'), use: USE })
    assert.equal(stored(store, inside.uid), 'docs/sync design.md')
    assert.equal(inside.target, join(desktop, 'docs', 'sync design.md'))
    assert.equal(inside.title, 'docs/sync design.md', 'the default title is the path as stored')
    assert.equal(stored(store, outside.uid), join(root, 'elsewhere', 'notes.md'))
    assert.equal(outside.target, join(root, 'elsewhere', 'notes.md'))

    // The deepest folder wins: Reporting API's folder is inside Desktop's.
    const api = store.addRef({ project: 'Reporting API' }, { kind: 'file', target: join(desktop, 'reporting api', 'README.md'), use: USE })
    assert.equal(stored(store, api.uid), 'README.md')
    assert.equal(api.target, join(desktop, 'reporting api', 'README.md'))

    // A portfolio's files stay absolute.
    const top = store.addRef({ portfolio: 'TC' }, { kind: 'file', target: join(desktop, 'ARCHITECTURE.md'), use: USE })
    assert.equal(stored(store, top.uid), join(desktop, 'ARCHITECTURE.md'))

    // Written two ways, the same file is one reference.
    store.addRef({ item: task.id }, { kind: 'file', target: `${desktop}${sep}docs${sep}.${sep}sync design.md`, title: 'Sync design', use: USE })
    assert.deepEqual(store.listRefs({ item: task.id }).map((ref) => ref.title), ['Sync design', join(root, 'elsewhere', 'notes.md')])
  })

  test("a relative file resolves under the first of the project's folders it exists in", () => {
    const { dir, remove } = tempDir()
    try {
      const store = memoryStore()
      store.createPortfolio({ key: 'TC', name: 'TideCast' })
      const app = join(dir, 'app')
      const docs = join(dir, 'docs')
      mkdirSync(join(docs, 'design'), { recursive: true })
      writeFileSync(join(docs, 'design', 'sync.md'), '# Sync')
      store.createProject({ portfolio: 'TC', name: 'Desktop', folders: [docs] })
      const ref = store.addRef({ project: 'Desktop' }, { kind: 'file', target: join(docs, 'design', 'sync.md'), use: USE })
      assert.equal(stored(store, ref.uid), 'design/sync.md')
      store.updateProject('Desktop', { folders: [app, docs] })
      assert.equal(store.listRefs({ project: 'Desktop' })[0].target, join(docs, 'design', 'sync.md'), 'not under app, where it does not exist')
    } finally {
      remove()
    }
  })

  test("changing a project's folders, or moving an item, keeps each file where it is", () => {
    const { store, root } = tidecast()
    const desktop = join(root, 'tide cast')
    const moved = join(root, 'tide cast v2')
    const task = store.createItem({ project: 'Desktop', title: 'Task' })
    const own = store.addRef({ project: 'Desktop' }, { kind: 'file', target: join(desktop, 'a.md'), use: USE })
    const mine = store.addRef({ item: task.id }, { kind: 'file', target: join(desktop, 'b.md'), use: USE })
    const later = store.addRef({ item: task.id }, { kind: 'file', target: join(moved, 'c.md'), use: USE })
    assert.equal(stored(store, later.uid), join(moved, 'c.md'))

    store.updateProject('Desktop', { folders: [moved] })
    assert.equal(store.listRefs({ project: 'Desktop' })[0].target, join(desktop, 'a.md'))
    assert.equal(stored(store, own.uid), join(desktop, 'a.md'), 'outside the folders now, so absolute')
    assert.equal(stored(store, later.uid), 'c.md', 'inside the new folder, so relative')

    store.updateProject('Desktop', { folders: [desktop] })
    assert.equal(stored(store, mine.uid), 'b.md')
    store.updateItem(task.id, { project: 'Reporting API' })
    assert.equal(stored(store, mine.uid), join(desktop, 'b.md'), 'outside Reporting API, so absolute')
    assert.deepEqual(store.listRefs({ item: task.id }).map((ref) => ref.target), [join(desktop, 'b.md'), join(moved, 'c.md')])
  })

  test('anchorPath and resolvePath', () => {
    const root = resolve('/repos')
    const folders = [join(root, 'app'), join(root, 'app', 'api')]
    assert.equal(anchorPath(join(root, 'app', 'src', 'a.ts'), folders), 'src/a.ts')
    assert.equal(anchorPath(join(root, 'app', 'api', 'b.ts'), folders), 'b.ts')
    assert.equal(anchorPath(join(root, 'app'), folders), '.')
    assert.equal(anchorPath(join(root, 'apps', 'x.ts'), folders), join(root, 'apps', 'x.ts'))
    assert.equal(anchorPath(join(root, 'app', 'a.ts'), []), join(root, 'app', 'a.ts'))
    assert.equal(resolvePath('src/a.ts', folders, () => false), join(root, 'app', 'src', 'a.ts'))
    assert.equal(resolvePath('src/a.ts', folders, (path) => path.startsWith(join(root, 'app', 'api'))), join(root, 'app', 'api', 'src', 'a.ts'))
    assert.equal(resolvePath('.', folders.slice(0, 1)), join(root, 'app'))
    assert.equal(resolvePath(join(root, 'x.ts'), folders), join(root, 'x.ts'))
    assert.equal(resolvePath('src/a.ts', []), 'src/a.ts')
  })
})
