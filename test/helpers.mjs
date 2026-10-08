import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkStore } from '../service/store.mjs'

/**
 * A store in memory with a clock that moves a minute per reading, so
 * timestamps are predictable and distinct.
 */
export function memoryStore() {
  let tick = Date.parse('2026-10-07T12:00:00.000Z')
  return new WorkStore(':memory:', { now: () => new Date((tick += 60_000)) })
}

/**
 * The TideCast portfolio from the design: Desktop and Reporting API, with
 * folders that have spaces in them.
 *
 * @param {WorkStore} store
 * @param {string} root
 */
export function seedTideCast(store, root = join(tmpdir(), 'work tests', 'repos')) {
  const portfolio = store.createPortfolio({ key: 'TC', name: 'TideCast' })
  const desktop = store.createProject({ portfolio: 'TC', name: 'Desktop', folders: [join(root, 'tide cast')] })
  const api = store.createProject({ portfolio: 'TC', name: 'Reporting API', folders: [join(root, 'tide cast', 'reporting api')] })
  return { portfolio, desktop, api, root }
}

/** A temporary directory, removed by the returned function. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'work store '))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
