import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, test } from 'node:test'
import { absoluteFolder, folderHolds, normalFolder } from '../service/folders.mjs'
import { memoryStore, seedTideCast } from './helpers.mjs'

describe('folder resolution', () => {
  test('the deepest folder holding the working directory picks the project, spaces and all', () => {
    const store = memoryStore()
    const { root } = seedTideCast(store)
    const resolve = (/** @type {string} */ cwd) => store.resolveFolder(cwd)?.project.name ?? null
    assert.equal(resolve(join(root, 'tide cast')), 'Desktop')
    assert.equal(resolve(join(root, 'tide cast', 'ui', 'main window')), 'Desktop')
    assert.equal(resolve(join(root, 'tide cast', 'reporting api')), 'Reporting API')
    assert.equal(resolve(join(root, 'tide cast', 'reporting api', 'src')), 'Reporting API')
    assert.equal(resolve(join(root, 'tide cast reporting')), null, 'a sibling that shares a prefix is not inside')
    assert.equal(resolve(root), null)
    assert.equal(resolve('relative/path'), null)
  })

  test('a trailing separator and, on Windows, case do not matter', () => {
    const store = memoryStore()
    const { root } = seedTideCast(store)
    assert.equal(store.resolveFolder(join(root, 'tide cast') + sep)?.project.name, 'Desktop')
    if (process.platform === 'win32') {
      assert.equal(store.resolveFolder(join(root, 'TIDE CAST', 'Reporting API'))?.project.name, 'Reporting API')
    }
  })

  test('the answer names the folder that matched, as it was stored', () => {
    const store = memoryStore()
    const { root } = seedTideCast(store)
    const found = store.resolveFolder(join(root, 'tide cast', 'reporting api', 'src'))
    assert.equal(found?.folder, join(root, 'tide cast', 'reporting api'))
    assert.equal(found?.project.portfolio.key, 'TC')
  })

  test('a folder belongs to one project', () => {
    const store = memoryStore()
    const { root } = seedTideCast(store)
    assert.throws(() => store.createProject({ portfolio: 'TC', name: 'Web', folders: [join(root, 'tide cast')] }), {
      code: 'conflict',
      message: `${join(root, 'tide cast')} already belongs to TideCast/Desktop.`
    })
    // The refused project was not created.
    assert.deepEqual(store.listProjects('TC').map((p) => p.name), ['Desktop', 'Reporting API'])
  })

  test('folders are replaced as a whole, deduplicated, and must be absolute', () => {
    const store = memoryStore()
    const { root } = seedTideCast(store)
    const web = join(root, 'tidecast ui')
    const project = store.updateProject('Desktop', { folders: [web, web + '\\', join(root, 'tide cast')] })
    assert.deepEqual(project.folders, [web, join(root, 'tide cast')])
    assert.throws(() => store.updateProject('Desktop', { folders: ['repos/tidecast'] }), { code: 'invalid' })
    assert.deepEqual(store.getProject('Desktop').folders, [web, join(root, 'tide cast')], 'a refused update changed nothing')
  })

  test('~ is the home folder', () => {
    assert.equal(absoluteFolder('~'), absoluteFolder(homedir()))
    assert.equal(absoluteFolder('~/code/tide cast'), join(homedir(), 'code', 'tide cast'))
  })

  test('normal form and holding, on both platforms', () => {
    assert.equal(normalFolder('C:\\Users\\Me\\Repo', 'win32'), 'c:\\users\\me\\repo')
    assert.equal(normalFolder('/home/Me/Repo', 'linux'), '/home/Me/Repo')
    const a = ['', 'x', 'repo'].join(sep)
    assert.ok(folderHolds(a, a))
    assert.ok(folderHolds(a, a + sep + 'src'))
    assert.ok(!folderHolds(a, a + 's'))
  })
})
