import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { defaultDatabasePath } from '../service/main.mjs'
import { MIGRATIONS } from '../service/schema.mjs'
import { WorkStore } from '../service/store.mjs'
import { startService, tempDir } from './helpers.mjs'

/**
 * trackr.db stays where it is at plugin API version 2: the service the
 * manifest names opens an existing database in its place, and nothing moves,
 * copies or migrates it.
 */

/** The files SQLite keeps beside a database while it is open in WAL mode. */
const SIDECARS = ['trackr.db-wal', 'trackr.db-shm']

describe('an existing trackr.db at apiVersion 2', () => {
  const { dir, remove } = tempDir()
  const data = join(dir, 'existing data')
  const file = join(data, 'trackr.db')
  const manifest = JSON.parse(readFileSync(new URL('../helm-plugin.json', import.meta.url), 'utf8'))
  /** @type {Awaited<ReturnType<typeof startService>>} */
  let service
  /** @type {string[]} */
  let dirBefore
  /** @type {string[]} */
  let dataBefore
  /** @type {bigint} */
  let identity

  before(async () => {
    const existing = new WorkStore(file)
    existing.createPortfolio({ key: 'TC', name: 'TideCast' })
    existing.createProject({ portfolio: 'TC', name: 'Desktop' })
    existing.createItem({ project: 'Desktop', title: 'Written before version 2' })
    existing.close()
    dirBefore = readdirSync(dir).sort()
    dataBefore = readdirSync(data).sort()
    identity = statSync(file, { bigint: true }).ino

    assert.equal(manifest.apiVersion, 2)
    service = await startService(file, { entry: manifest.service.node })
  })

  after(async () => {
    await service?.stop()
    remove()
  })

  /**
   * @param {string} method
   * @param {unknown[]} args
   */
  const rpc = async (method, args) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/rpc`, {
      method: 'POST',
      headers: { 'helm-service-token': service.token },
      body: JSON.stringify({ method, args })
    })
    return /** @type {any} */ (await response.json()).result
  }

  test('the service the manifest names is the one version 1 ran', () => {
    assert.equal(manifest.service.node, 'service/main.mjs')
  })

  test('the service opens the same file in the same place', async () => {
    assert.match(service.output, new RegExp(`serving ${escape(file)} \\(schema ${MIGRATIONS.length}\\)`))
    assert.equal((await rpc('getItem', ['TC-1'])).title, 'Written before version 2')
    assert.equal(statSync(file, { bigint: true }).ino, identity)
  })

  test('nothing is moved, copied or migrated beside it', async () => {
    // A write lands in the file the service was given, not a copy of it.
    await rpc('createItem', [{ project: 'Desktop', title: 'Written at version 2' }])
    assert.deepEqual(readdirSync(dir).sort(), dirBefore)
    assert.deepEqual(
      readdirSync(data)
        .filter((name) => !SIDECARS.includes(name))
        .sort(),
      dataBefore
    )
    await service.stop()
    const reader = new WorkStore(file)
    try {
      assert.equal(reader.schemaVersion, MIGRATIONS.length)
      assert.equal(reader.getItem('TC-2').title, 'Written at version 2')
    } finally {
      reader.close()
    }
  })

  test('without HELM_TRACKR_DB the database is where it has always been', () => {
    assert.equal(defaultDatabasePath(), join(homedir(), '.config', 'helm', 'data', 'trackr', 'trackr.db'))
  })
})

/** @param {string} text */
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
