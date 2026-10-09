import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SEP, changeParts, linkParts, refParts } from './changes.mjs'
import { conflict, invalid, notFound } from './errors.mjs'
import { absoluteFolder, anchorPath, folderHolds, normalFolder, pathState, resolvePath } from './folders.mjs'
import {
  COLOURS,
  DEFAULT_ICON_FOR_GROUP,
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES,
  ITEM_ID,
  ITEM_KINDS,
  LIMITS,
  LINK_KINDS,
  OPEN_GROUPS,
  isArtifactAddress,
  isWebAddress,
  PORTFOLIO_KEY,
  PROJECT_COLOURS,
  REF_KINDS,
  STATUS_GROUPS,
  STATUS_ICONS,
  inferRefKind
} from './model.mjs'
import { missingFiles, orderOf, placed, portfolioOverview, unshadowed } from './overview.mjs'
import { MIGRATIONS } from './schema.mjs'

/**
 * @typedef {'not-started' | 'active' | 'done' | 'closed'} StatusGroup
 * @typedef {{ uid: number, name: string, group: StatusGroup, colour: string, icon: string, isDefault: boolean }} Status
 * @typedef {{ uid: number, name: string, rank: number, isDefault: boolean }} Priority
 * @typedef {{ open: number, active: number, done: number, closed: number }} Counts
 * @typedef {{ uid: number, name: string, colour: string, folders: string[], portfolio: { uid: number, key: string, name: string }, counts: Counts }} Project
 * @typedef {{ uid: number, key: string, name: string, description: string, nextNumber: number, projects: Project[] }} PortfolioSummary
 * @typedef {PortfolioSummary & { statuses: Status[], priorities: Priority[] }} Portfolio
 * @typedef {{ id: string, name: string, activeAt: string | null }} SessionClaim
 * @typedef {{
 *   uid: number, id: string, kind: 'epic' | 'task', title: string,
 *   portfolio: { uid: number, key: string },
 *   project: { uid: number, name: string, colour: string },
 *   epic: { id: string, title: string } | null,
 *   status: { uid: number, name: string, group: StatusGroup, colour: string, icon: string },
 *   priority: { uid: number, name: string },
 *   criteria: { done: number, total: number },
 *   waitingOn: string[],
 *   session: SessionClaim | null,
 *   updatedAt: string
 * }} ItemSummary
 * @typedef {{ n: number, text: string, done: boolean }} Criterion
 * @typedef {{ uid: number, kind: string, value: string, label: string }} Link
 * @typedef {'artifact' | 'doc' | 'file' | 'url'} RefKind
 * @typedef {{ uid: number, kind: RefKind, target: string, title: string, use: string, key: boolean }} Reference
 * @typedef {Reference & { from: { level: 'epic' | 'project' | 'portfolio', uid: number, name: string } }} InheritedReference
 * @typedef {{ kind?: string, target: string, title?: string, use?: string, key?: boolean }} RefInput
 * @typedef {{ kind?: string, target?: string, title?: string, use?: string, key?: boolean }} RefPatch
 * @typedef {import('./folders.mjs').PathState} PathState
 * @typedef {{ item: Ref } | { project: Ref, portfolio?: Ref } | { portfolio: Ref }} RefOwner
 * @typedef {{ at: string, by: string, text: string, ref: string | null }} LogEntry
 * @typedef {{ done: string, left: string, next: string, by: string, at: string }} Handoff
 * @typedef {ItemSummary & {
 *   description: string, createdAt: string, createdBy: string | null,
 *   criteriaList: Criterion[], links: Link[], refs: Reference[],
 *   waitsOn: ItemSummary[], blocks: ItemSummary[],
 *   handoff: Handoff | null, log: { entries: LogEntry[], total: number },
 *   tasks: ItemSummary[] | null, spans: string[] | null
 * }} Item
 * @typedef {{ field: string, from: string | null, to: string | null }} Change
 * @typedef {number | string} Ref
 */

/** Columns every item summary reads. `i` is the item. */
const SUMMARY_SELECT = `
  SELECT i.id, i.number, i.kind, i.title, i.updated_at,
         i.session_id, i.session_name, i.session_active_at,
         p.id AS p_id, p.key AS p_key,
         j.id AS j_id, j.name AS j_name, j.colour AS j_colour,
         e.number AS e_number, e.title AS e_title,
         s.id AS s_id, s.name AS s_name, s.grp AS s_grp, s.colour AS s_colour, s.icon AS s_icon,
         r.id AS r_id, r.name AS r_name,
         (SELECT count(*) FROM criteria c WHERE c.item_id = i.id) AS c_total,
         (SELECT count(*) FROM criteria c WHERE c.item_id = i.id AND c.done = 1) AS c_done,
         (SELECT group_concat(w.number) FROM dependencies d
            JOIN items w ON w.id = d.waits_on_id
            JOIN statuses ws ON ws.id = w.status_id
           WHERE d.item_id = i.id AND ws.grp IN ('not-started', 'active')) AS waiting
    FROM items i
    JOIN portfolios p ON p.id = i.portfolio_id
    JOIN projects j ON j.id = i.project_id
    JOIN statuses s ON s.id = i.status_id
    JOIN priorities r ON r.id = i.priority_id
    LEFT JOIN items e ON e.id = i.epic_id`

/**
 * "Next up first": work under way, then work waiting, then finished work;
 * inside a group the more urgent first, then the status further along the
 * workflow (To do before Backlog), then the item's own place in its list.
 */
const NEXT_UP_ORDER = `
  ORDER BY CASE s.grp WHEN 'active' THEN 0 WHEN 'not-started' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
           r.position, s.position DESC, i.position, i.number`

/** An item has nothing it waits on that is still open. */
const READY = `NOT EXISTS (
  SELECT 1 FROM dependencies d
    JOIN items w ON w.id = d.waits_on_id
    JOIN statuses ws ON ws.id = w.status_id
   WHERE d.item_id = i.id AND ws.grp IN ('not-started', 'active'))`

/**
 * Columns every reference reads. `anchor` is the project whose folders a
 * relative file is under: the owner, or the owning item's project.
 */
const REF_SELECT = `
  SELECT r.id, r.kind, r.target, r.title, r.use, r.key, r.position, coalesce(r.project_id, i.project_id) AS anchor
    FROM refs r
    LEFT JOIN items i ON i.id = r.item_id`

/**
 * The work store: portfolios, projects, epics and tasks in one SQLite file.
 *
 * Every method is synchronous and every write runs in a transaction, so a
 * failed call changes nothing. Items are named by their ID (`'TC-123'`) or
 * their internal `uid`; portfolios by key or uid; projects by uid, or by name
 * inside a portfolio.
 *
 * The file may be open in two processes at once (the installed Helm and a dev
 * build): WAL lets readers run beside a writer, writes take the lock up front
 * (`BEGIN IMMEDIATE`) and wait up to five seconds for it.
 */
export class WorkStore {
  /**
   * @param {string} file the database file, or `':memory:'`
   * @param {{ now?: () => Date }} [options] `now` is the clock, for tests
   */
  constructor(file, options = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.now = options.now ?? (() => new Date())
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.statements = new Map()
    this.depth = 0
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    try {
      if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
      this.migrate()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() {
    this.statements.clear()
    this.db.close()
  }

  /** The schema version this database is at. */
  get schemaVersion() {
    return Number(this.row('PRAGMA user_version').user_version)
  }

  // ---------------------------------------------------------------------------
  // Plumbing

  /** @private */
  migrate() {
    const version = this.schemaVersion
    if (version > MIGRATIONS.length) {
      throw new Error(
        `The work database is at schema ${version}, newer than this plugin knows (${MIGRATIONS.length}). Update the plugin.`
      )
    }
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[index])
        this.db.exec(`PRAGMA user_version = ${index + 1}`)
      })
    }
  }

  /**
   * Runs `fn` in a transaction: all of it lands or none of it does. Nests,
   * through savepoints.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    const outer = this.depth === 0
    const savepoint = `sp${this.depth}`
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this.depth++
    try {
      const result = fn()
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`)
      return result
    } catch (error) {
      this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      throw error
    } finally {
      this.depth--
    }
  }

  /**
   * @private
   * @param {string} sql
   */
  statement(sql) {
    let statement = this.statements.get(sql)
    if (statement === undefined) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /**
   * @private
   * @param {string} sql
   * @param {...any} params
   * @returns {any}
   */
  row(sql, ...params) {
    return this.statement(sql).get(...params)
  }

  /**
   * @private
   * @param {string} sql
   * @param {...any} params
   * @returns {any[]}
   */
  rows(sql, ...params) {
    return this.statement(sql).all(...params)
  }

  /**
   * An item's links, in their order.
   *
   * @private
   * @param {number} itemId
   * @returns {Link[]}
   */
  linkRows(itemId) {
    return this.rows('SELECT id, kind, value, label FROM links WHERE item_id = ? ORDER BY position', itemId).map((link) => ({
      uid: link.id,
      kind: link.kind,
      value: link.value,
      label: link.label
    }))
  }

  /**
   * @private
   * @param {string} sql
   * @param {...any} params
   */
  run(sql, ...params) {
    return this.statement(sql).run(...params)
  }

  /** @private */
  stamp() {
    return this.now().toISOString()
  }

  // ---------------------------------------------------------------------------
  // Portfolios

  /**
   * Creates a portfolio with the default statuses and priorities, or the ones
   * given.
   *
   * @param {{ key: string, name: string, description?: string,
   *   statuses?: { name: string, group: StatusGroup, colour?: string, icon?: string, isDefault?: boolean }[],
   *   priorities?: { name: string, isDefault?: boolean }[] }} input
   * @returns {Portfolio}
   */
  createPortfolio(input) {
    const key = portfolioKey(input?.key)
    const name = requiredText(input.name, 'name', LIMITS.name)
    const description = optionalText(input.description, 'description', LIMITS.description) ?? ''
    const statuses = input.statuses ?? DEFAULT_STATUSES
    const priorities = input.priorities ?? DEFAULT_PRIORITIES
    if (!Array.isArray(statuses) || statuses.length === 0) throw invalid('A portfolio needs at least one status.')
    if (!Array.isArray(priorities) || priorities.length === 0) throw invalid('A portfolio needs at least one priority.')
    return this.transaction(() => {
      if (this.row('SELECT 1 FROM portfolios WHERE key = ?', key)) throw conflict(`A portfolio with the key ${key} already exists.`)
      const at = this.stamp()
      const uid = Number(
        this.run(
          'INSERT INTO portfolios (key, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          key,
          name,
          description,
          at,
          at
        ).lastInsertRowid
      )
      statuses.forEach((status, index) => this.insertStatus(uid, status, index + 1))
      priorities.forEach((priority, index) => this.insertPriority(uid, priority, index + 1))
      this.ensureDefault('statuses', uid)
      this.ensureDefault('priorities', uid)
      return this.getPortfolio(uid)
    })
  }

  /** @returns {PortfolioSummary[]} every portfolio with its projects, by key */
  listPortfolios() {
    const projects = this.listProjects()
    return this.rows('SELECT * FROM portfolios ORDER BY key').map((row) => ({
      ...portfolioOf(row),
      projects: projects.filter((project) => project.portfolio.uid === row.id)
    }))
  }

  /**
   * @param {Ref} ref key or uid
   * @returns {Portfolio}
   */
  getPortfolio(ref) {
    const row = this.portfolioRow(ref)
    return {
      ...portfolioOf(row),
      statuses: this.statusesOf(row.id),
      priorities: this.prioritiesOf(row.id),
      projects: this.listProjects(row.id)
    }
  }

  /**
   * Renaming the key renames every ID in the portfolio: TC-123 becomes
   * NEW-123.
   *
   * @param {Ref} ref
   * @param {{ key?: string, name?: string, description?: string }} patch
   * @returns {Portfolio}
   */
  updatePortfolio(ref, patch) {
    return this.transaction(() => {
      const row = this.portfolioRow(ref)
      const key = patch.key === undefined ? row.key : portfolioKey(patch.key)
      const name = patch.name === undefined ? row.name : requiredText(patch.name, 'name', LIMITS.name)
      const description = optionalText(patch.description, 'description', LIMITS.description) ?? row.description
      if (key !== row.key && this.row('SELECT 1 FROM portfolios WHERE key = ?', key)) {
        throw conflict(`A portfolio with the key ${key} already exists.`)
      }
      this.run(
        'UPDATE portfolios SET key = ?, name = ?, description = ?, updated_at = ? WHERE id = ?',
        key,
        name,
        description,
        this.stamp(),
        row.id
      )
      return this.getPortfolio(row.id)
    })
  }

  /**
   * Deletes a portfolio and everything in it. The UI asks first; agents have
   * no way here.
   *
   * @param {Ref} ref
   */
  deletePortfolio(ref) {
    this.transaction(() => {
      const row = this.portfolioRow(ref)
      // Items reference projects, statuses and priorities without a cascade,
      // so they go first; their criteria, links, log and dependencies follow
      // them.
      this.run('DELETE FROM items WHERE portfolio_id = ?', row.id)
      this.run('DELETE FROM portfolios WHERE id = ?', row.id)
    })
  }

  // ---------------------------------------------------------------------------
  // Statuses and priorities

  /**
   * @param {Ref} portfolio
   * @param {{ name: string, group: StatusGroup, colour?: string, icon?: string, isDefault?: boolean }} input
   * @returns {Status}
   */
  addStatus(portfolio, input) {
    return this.transaction(() => {
      const row = this.portfolioRow(portfolio)
      const uid = this.insertStatus(row.id, input, this.nextPosition('statuses', row.id))
      if (input.isDefault === true) this.setDefault('statuses', row.id, uid)
      return this.statusesOf(row.id).find((status) => status.uid === uid) ?? unreachable()
    })
  }

  /**
   * @param {number} uid
   * @param {{ name?: string, group?: StatusGroup, colour?: string, icon?: string, isDefault?: boolean }} patch
   * @returns {Status}
   */
  updateStatus(uid, patch) {
    return this.transaction(() => {
      const row = this.row('SELECT * FROM statuses WHERE id = ?', uid)
      if (!row) throw notFound(`Status ${uid} does not exist.`)
      const name = patch.name === undefined ? row.name : requiredText(patch.name, 'name', LIMITS.name)
      const group = patch.group === undefined ? row.grp : statusGroup(patch.group)
      const colour = patch.colour === undefined ? row.colour : colourOf(patch.colour)
      const icon = patch.icon === undefined ? row.icon : statusIcon(patch.icon)
      this.assertNameFree('statuses', row.portfolio_id, name, uid)
      this.run('UPDATE statuses SET name = ?, grp = ?, colour = ?, icon = ? WHERE id = ?', name, group, colour, icon, uid)
      // Its items change group with it. The history triggers watch items, so
      // this one is recorded here.
      if (group !== row.grp) {
        this.run('INSERT INTO status_history (item_id, grp, at) SELECT id, ?, ? FROM items WHERE status_id = ?', group, this.stamp(), uid)
      }
      if (patch.isDefault === true) this.setDefault('statuses', row.portfolio_id, uid)
      if (patch.isDefault === false && row.is_default === 1) {
        throw invalid('Make another status the default instead: a portfolio always has one.')
      }
      return this.statusesOf(row.portfolio_id).find((status) => status.uid === uid) ?? unreachable()
    })
  }

  /**
   * @param {Ref} portfolio
   * @param {Ref[]} order every status of the portfolio, by uid or name, in the new order
   * @returns {Status[]}
   */
  reorderStatuses(portfolio, order) {
    return this.transaction(() => {
      const row = this.portfolioRow(portfolio)
      this.reorder('statuses', row.id, order)
      return this.statusesOf(row.id)
    })
  }

  /**
   * Deletes a status. One that items are in needs `replaceWith`, which they
   * move to.
   *
   * @param {number} uid
   * @param {{ replaceWith?: Ref }} [options]
   */
  deleteStatus(uid, options = {}) {
    this.transaction(() => this.deleteOption('statuses', 'status_id', uid, options.replaceWith))
  }

  /**
   * @param {Ref} portfolio
   * @param {{ name: string, isDefault?: boolean }} input
   * @returns {Priority}
   */
  addPriority(portfolio, input) {
    return this.transaction(() => {
      const row = this.portfolioRow(portfolio)
      const uid = this.insertPriority(row.id, input, this.nextPosition('priorities', row.id))
      if (input.isDefault === true) this.setDefault('priorities', row.id, uid)
      return this.prioritiesOf(row.id).find((priority) => priority.uid === uid) ?? unreachable()
    })
  }

  /**
   * @param {number} uid
   * @param {{ name?: string, isDefault?: boolean }} patch
   * @returns {Priority}
   */
  updatePriority(uid, patch) {
    return this.transaction(() => {
      const row = this.row('SELECT * FROM priorities WHERE id = ?', uid)
      if (!row) throw notFound(`Priority ${uid} does not exist.`)
      const name = patch.name === undefined ? row.name : requiredText(patch.name, 'name', LIMITS.name)
      this.assertNameFree('priorities', row.portfolio_id, name, uid)
      this.run('UPDATE priorities SET name = ? WHERE id = ?', name, uid)
      if (patch.isDefault === true) this.setDefault('priorities', row.portfolio_id, uid)
      if (patch.isDefault === false && row.is_default === 1) {
        throw invalid('Make another priority the default instead: a portfolio always has one.')
      }
      return this.prioritiesOf(row.portfolio_id).find((priority) => priority.uid === uid) ?? unreachable()
    })
  }

  /**
   * @param {Ref} portfolio
   * @param {Ref[]} order every priority, most urgent first
   * @returns {Priority[]}
   */
  reorderPriorities(portfolio, order) {
    return this.transaction(() => {
      const row = this.portfolioRow(portfolio)
      this.reorder('priorities', row.id, order)
      return this.prioritiesOf(row.id)
    })
  }

  /**
   * @param {number} uid
   * @param {{ replaceWith?: Ref }} [options]
   */
  deletePriority(uid, options = {}) {
    this.transaction(() => this.deleteOption('priorities', 'priority_id', uid, options.replaceWith))
  }

  /**
   * @private
   * @param {number} portfolioId
   * @param {any} input
   * @param {number} position
   */
  insertStatus(portfolioId, input, position) {
    const name = requiredText(input?.name, 'status name', LIMITS.name)
    const group = statusGroup(input.group)
    const colour = input.colour === undefined ? 'muted' : colourOf(input.colour)
    const icon = input.icon === undefined ? DEFAULT_ICON_FOR_GROUP[group] : statusIcon(input.icon)
    this.assertNameFree('statuses', portfolioId, name)
    const uid = Number(
      this.run(
        'INSERT INTO statuses (portfolio_id, name, grp, colour, icon, position) VALUES (?, ?, ?, ?, ?, ?)',
        portfolioId,
        name,
        group,
        colour,
        icon,
        position
      ).lastInsertRowid
    )
    if (input.isDefault === true) this.setDefault('statuses', portfolioId, uid)
    return uid
  }

  /**
   * @private
   * @param {number} portfolioId
   * @param {any} input
   * @param {number} position
   */
  insertPriority(portfolioId, input, position) {
    const name = requiredText(input?.name, 'priority name', LIMITS.name)
    this.assertNameFree('priorities', portfolioId, name)
    const uid = Number(
      this.run('INSERT INTO priorities (portfolio_id, name, position) VALUES (?, ?, ?)', portfolioId, name, position)
        .lastInsertRowid
    )
    if (input.isDefault === true) this.setDefault('priorities', portfolioId, uid)
    return uid
  }

  /**
   * @private
   * @param {'statuses' | 'priorities'} table
   * @param {number} portfolioId
   * @param {string} name
   * @param {number} [except]
   */
  assertNameFree(table, portfolioId, name, except = -1) {
    const taken = this.row(
      `SELECT 1 FROM ${table} WHERE portfolio_id = ? AND name = ? COLLATE NOCASE AND id <> ?`,
      portfolioId,
      name,
      except
    )
    if (taken) throw conflict(`There is already a ${table === 'statuses' ? 'status' : 'priority'} called ${name}.`)
  }

  /**
   * @private
   * @param {'statuses' | 'priorities'} table
   * @param {number} portfolioId
   * @param {number} uid
   */
  setDefault(table, portfolioId, uid) {
    this.run(`UPDATE ${table} SET is_default = 0 WHERE portfolio_id = ? AND is_default = 1`, portfolioId)
    this.run(`UPDATE ${table} SET is_default = 1 WHERE id = ?`, uid)
  }

  /**
   * Makes the first option the default when none was marked.
   *
   * @private
   * @param {'statuses' | 'priorities'} table
   * @param {number} portfolioId
   */
  ensureDefault(table, portfolioId) {
    if (this.row(`SELECT 1 FROM ${table} WHERE portfolio_id = ? AND is_default = 1`, portfolioId)) return
    const first = this.row(`SELECT id FROM ${table} WHERE portfolio_id = ? ORDER BY position LIMIT 1`, portfolioId)
    this.setDefault(table, portfolioId, first.id)
  }

  /**
   * @private
   * @param {'statuses' | 'priorities' | 'projects'} table
   * @param {number} portfolioId
   */
  nextPosition(table, portfolioId) {
    return Number(this.row(`SELECT coalesce(max(position), 0) + 1 AS next FROM ${table} WHERE portfolio_id = ?`, portfolioId).next)
  }

  /**
   * @private
   * @param {'statuses' | 'priorities' | 'projects'} table
   * @param {number} portfolioId
   * @param {Ref[]} order
   */
  reorder(table, portfolioId, order) {
    const rows = this.rows(`SELECT id, name FROM ${table} WHERE portfolio_id = ?`, portfolioId)
    if (!Array.isArray(order) || order.length !== rows.length) {
      throw invalid(`The new order must name each of the ${rows.length} ${table} once.`)
    }
    const seen = new Set()
    const ids = order.map((ref) => {
      const row = rows.find((candidate) => matchesRef(candidate, ref))
      if (!row) throw invalid(`${String(ref)} is not one of this portfolio's ${table}.`)
      if (seen.has(row.id)) throw invalid(`${row.name} is named twice in the new order.`)
      seen.add(row.id)
      return row.id
    })
    ids.forEach((id, index) => this.run(`UPDATE ${table} SET position = ? WHERE id = ?`, index + 1, id))
  }

  /**
   * @private
   * @param {'statuses' | 'priorities'} table
   * @param {'status_id' | 'priority_id'} column
   * @param {number} uid
   * @param {Ref | undefined} replaceWith
   */
  deleteOption(table, column, uid, replaceWith) {
    const noun = table === 'statuses' ? 'status' : 'priority'
    const row = this.row(`SELECT * FROM ${table} WHERE id = ?`, uid)
    if (!row) throw notFound(`That ${noun} does not exist.`)
    if (row.is_default === 1) throw conflict(`${row.name} is the default ${noun}. Make another one the default first.`)
    const used = Number(this.row(`SELECT count(*) AS n FROM items WHERE ${column} = ?`, uid).n)
    if (used > 0) {
      if (replaceWith === undefined) {
        throw conflict(`${used} item${used === 1 ? ' is' : 's are'} ${table === 'statuses' ? 'in' : 'at'} ${row.name}. Say which ${noun} they move to.`)
      }
      const target = this.optionRow(table, row.portfolio_id, replaceWith)
      if (target.id === uid) throw invalid(`${row.name} cannot replace itself.`)
      this.run(`UPDATE items SET ${column} = ?, updated_at = ? WHERE ${column} = ?`, target.id, this.stamp(), uid)
    }
    this.run(`DELETE FROM ${table} WHERE id = ?`, uid)
  }

  /**
   * @private
   * @param {'statuses' | 'priorities'} table
   * @param {number} portfolioId
   * @param {Ref} ref uid or name
   */
  optionRow(table, portfolioId, ref) {
    const row =
      typeof ref === 'number'
        ? this.row(`SELECT * FROM ${table} WHERE id = ? AND portfolio_id = ?`, ref, portfolioId)
        : this.row(`SELECT * FROM ${table} WHERE name = ? COLLATE NOCASE AND portfolio_id = ?`, String(ref).trim(), portfolioId)
    if (row) return row
    const names = this.rows(`SELECT name FROM ${table} WHERE portfolio_id = ? ORDER BY position`, portfolioId).map((r) => r.name)
    throw invalid(`${String(ref)} is not a ${table === 'statuses' ? 'status' : 'priority'} here. Use one of: ${names.join(', ')}.`)
  }

  /**
   * @private
   * @param {number} portfolioId
   * @returns {Status[]}
   */
  statusesOf(portfolioId) {
    return this.rows('SELECT * FROM statuses WHERE portfolio_id = ? ORDER BY position', portfolioId).map((row) => ({
      uid: row.id,
      name: row.name,
      group: row.grp,
      colour: row.colour,
      icon: row.icon,
      isDefault: row.is_default === 1
    }))
  }

  /**
   * @private
   * @param {number} portfolioId
   * @returns {Priority[]}
   */
  prioritiesOf(portfolioId) {
    return this.rows('SELECT * FROM priorities WHERE portfolio_id = ? ORDER BY position', portfolioId).map(
      (row, index) => ({ uid: row.id, name: row.name, rank: index + 1, isDefault: row.is_default === 1 })
    )
  }

  /**
   * @private
   * @param {Ref} ref
   */
  portfolioRow(ref) {
    const row =
      typeof ref === 'number'
        ? this.row('SELECT * FROM portfolios WHERE id = ?', ref)
        : typeof ref === 'string'
          ? this.row('SELECT * FROM portfolios WHERE key = ?', ref.trim().toUpperCase())
          : undefined
    if (!row) throw notFound(`There is no portfolio ${String(ref)}.`)
    return row
  }

  // ---------------------------------------------------------------------------
  // Projects

  /**
   * @param {{ portfolio: Ref, name: string, colour?: string, folders?: string[] }} input
   * @returns {Project}
   */
  createProject(input) {
    return this.transaction(() => {
      const portfolio = this.portfolioRow(input?.portfolio)
      const name = requiredText(input.name, 'name', LIMITS.name)
      this.assertProjectNameFree(portfolio.id, name)
      const colour = input.colour === undefined ? this.nextProjectColour(portfolio.id) : colourOf(input.colour)
      const at = this.stamp()
      const uid = Number(
        this.run(
          'INSERT INTO projects (portfolio_id, name, colour, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          portfolio.id,
          name,
          colour,
          this.nextPosition('projects', portfolio.id),
          at,
          at
        ).lastInsertRowid
      )
      if (input.folders !== undefined) this.setFolders(uid, input.folders)
      return this.getProject(uid)
    })
  }

  /**
   * @param {Ref} [portfolio] only this portfolio's
   * @returns {Project[]} in the portfolio's order
   */
  listProjects(portfolio) {
    const portfolioId = portfolio === undefined ? null : this.portfolioRow(portfolio).id
    const rows = this.rows(
      `SELECT j.*, p.key AS p_key, p.name AS p_name FROM projects j JOIN portfolios p ON p.id = j.portfolio_id
        WHERE ?1 IS NULL OR j.portfolio_id = ?1 ORDER BY p.key, j.position`,
      portfolioId
    )
    return this.projectsOf(rows)
  }

  /**
   * @param {Ref} ref uid, or a name when `portfolio` is given or the name is unique
   * @param {Ref} [portfolio]
   * @returns {Project}
   */
  getProject(ref, portfolio) {
    return this.projectsOf([this.projectRow(ref, portfolio)])[0]
  }

  /**
   * @param {Ref} ref
   * @param {{ name?: string, colour?: string, folders?: string[] }} patch
   * @param {Ref} [portfolio]
   * @returns {Project}
   */
  updateProject(ref, patch, portfolio) {
    return this.transaction(() => {
      const row = this.projectRow(ref, portfolio)
      const name = patch.name === undefined ? row.name : requiredText(patch.name, 'name', LIMITS.name)
      if (name.toLowerCase() !== row.name.toLowerCase()) this.assertProjectNameFree(row.portfolio_id, name)
      const colour = patch.colour === undefined ? row.colour : colourOf(patch.colour)
      this.run('UPDATE projects SET name = ?, colour = ?, updated_at = ? WHERE id = ?', name, colour, this.stamp(), row.id)
      if (patch.folders !== undefined) this.setFolders(row.id, patch.folders)
      return this.getProject(row.id)
    })
  }

  /**
   * @param {Ref} portfolio
   * @param {Ref[]} order every project of the portfolio, by uid or name
   * @returns {Project[]}
   */
  reorderProjects(portfolio, order) {
    return this.transaction(() => {
      const row = this.portfolioRow(portfolio)
      this.reorder('projects', row.id, order)
      return this.listProjects(row.id)
    })
  }

  /**
   * Deletes an empty project. One with items is refused: move or delete them
   * first.
   *
   * @param {Ref} ref
   * @param {Ref} [portfolio]
   */
  deleteProject(ref, portfolio) {
    this.transaction(() => {
      const row = this.projectRow(ref, portfolio)
      const count = Number(this.row('SELECT count(*) AS n FROM items WHERE project_id = ?', row.id).n)
      if (count > 0) throw conflict(`${row.name} still has ${count} item${count === 1 ? '' : 's'}. Move or delete them first.`)
      this.run('DELETE FROM projects WHERE id = ?', row.id)
    })
  }

  /**
   * The project a working directory belongs to: the one with the deepest
   * folder that holds it.
   *
   * @param {string} cwd
   * @returns {{ project: Project, folder: string } | null}
   */
  resolveFolder(cwd) {
    if (typeof cwd !== 'string') return null
    const absolute = absoluteFolder(cwd)
    if (absolute === null) return null
    const target = normalFolder(absolute)
    /** @type {{ project_id: number, path: string, norm: string } | null} */
    let best = null
    for (const folder of this.rows('SELECT project_id, path, norm FROM project_folders')) {
      if (folderHolds(folder.norm, target) && (best === null || folder.norm.length > best.norm.length)) best = folder
    }
    return best === null ? null : { project: this.getProject(best.project_id), folder: best.path }
  }

  /**
   * Replaces a project's folders. A folder can belong to one project only.
   *
   * @private
   * @param {number} projectId
   * @param {unknown} folders
   */
  setFolders(projectId, folders) {
    if (!Array.isArray(folders)) throw invalid('folders must be a list of absolute paths.')
    if (folders.length > LIMITS.folders) throw invalid(`A project can have ${LIMITS.folders} folders at most.`)
    /** @type {Map<string, string>} */
    const byNorm = new Map()
    for (const folder of folders) {
      if (typeof folder !== 'string' || folder.trim() === '') throw invalid('Each folder must be a path.')
      const absolute = absoluteFolder(folder)
      if (absolute === null) throw invalid(`${folder} is not an absolute path.`)
      byNorm.set(normalFolder(absolute), absolute)
    }
    // Files stored relative to the old folders are read against them first,
    // then stored against the new ones.
    const files = this.filePaths('r.project_id = ?1 OR r.item_id IN (SELECT id FROM items WHERE project_id = ?1)', projectId)
    this.run('DELETE FROM project_folders WHERE project_id = ?', projectId)
    let position = 0
    for (const [norm, path] of byNorm) {
      const owner = this.row(
        `SELECT j.name, p.name AS p_name FROM project_folders f JOIN projects j ON j.id = f.project_id
           JOIN portfolios p ON p.id = j.portfolio_id WHERE f.norm = ?`,
        norm
      )
      if (owner) throw conflict(`${path} already belongs to ${owner.p_name}/${owner.name}.`)
      this.run('INSERT INTO project_folders (project_id, path, norm, position) VALUES (?, ?, ?, ?)', projectId, path, norm, ++position)
    }
    this.storeFiles(files, [...byNorm.values()])
  }

  /**
   * A project's folders, in its order.
   *
   * @private
   * @param {number} projectId
   * @returns {string[]}
   */
  foldersOf(projectId) {
    return this.rows('SELECT path FROM project_folders WHERE project_id = ? ORDER BY position', projectId).map((row) => row.path)
  }

  /**
   * @private
   * @param {number} portfolioId
   * @param {string} name
   */
  assertProjectNameFree(portfolioId, name) {
    if (this.row('SELECT 1 FROM projects WHERE portfolio_id = ? AND name = ? COLLATE NOCASE', portfolioId, name)) {
      throw conflict(`There is already a project called ${name} in this portfolio.`)
    }
  }

  /**
   * The first colour no project in the portfolio has, or the next in turn.
   *
   * @private
   * @param {number} portfolioId
   */
  nextProjectColour(portfolioId) {
    const used = this.rows('SELECT colour FROM projects WHERE portfolio_id = ?', portfolioId).map((row) => row.colour)
    return PROJECT_COLOURS.find((colour) => !used.includes(colour)) ?? PROJECT_COLOURS[used.length % PROJECT_COLOURS.length]
  }

  /**
   * @private
   * @param {Ref} ref
   * @param {Ref} [portfolio]
   */
  projectRow(ref, portfolio) {
    const select = 'SELECT j.*, p.key AS p_key, p.name AS p_name FROM projects j JOIN portfolios p ON p.id = j.portfolio_id'
    if (typeof ref === 'number') {
      const row = this.row(`${select} WHERE j.id = ?`, ref)
      if (!row) throw notFound(`Project ${ref} does not exist.`)
      return row
    }
    if (typeof ref !== 'string' || ref.trim() === '') throw invalid('Name a project.')
    const name = ref.trim()
    const rows =
      portfolio === undefined
        ? this.rows(`${select} WHERE j.name = ? COLLATE NOCASE`, name)
        : this.rows(`${select} WHERE j.name = ? COLLATE NOCASE AND j.portfolio_id = ?`, name, this.portfolioRow(portfolio).id)
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) {
      throw invalid(`More than one portfolio has a project called ${name}: ${rows.map((row) => `${row.p_key}/${row.name}`).join(', ')}. Say which.`)
    }
    throw notFound(`There is no project called ${name}.`)
  }

  /**
   * @private
   * @param {any[]} rows project rows with p_key and p_name
   * @returns {Project[]}
   */
  projectsOf(rows) {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const marks = ids.map(() => '?').join(', ')
    const folders = this.rows(`SELECT project_id, path FROM project_folders WHERE project_id IN (${marks}) ORDER BY position`, ...ids)
    const counts = this.rows(
      `SELECT i.project_id, s.grp, count(*) AS n FROM items i JOIN statuses s ON s.id = i.status_id
        WHERE i.project_id IN (${marks}) AND i.kind = 'task' GROUP BY i.project_id, s.grp`,
      ...ids
    )
    return rows.map((row) => {
      const mine = counts.filter((count) => count.project_id === row.id)
      const of = (/** @type {string} */ group) => Number(mine.find((count) => count.grp === group)?.n ?? 0)
      return {
        uid: row.id,
        name: row.name,
        colour: row.colour,
        folders: folders.filter((folder) => folder.project_id === row.id).map((folder) => folder.path),
        portfolio: { uid: row.portfolio_id, key: row.p_key, name: row.p_name },
        counts: { open: of('not-started') + of('active'), active: of('active'), done: of('done'), closed: of('closed') }
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Items

  /**
   * Creates an epic or a task and gives it the portfolio's next number.
   *
   * @param {{ kind?: 'epic' | 'task', project: Ref, portfolio?: Ref, epic?: Ref | null, title: string,
   *   description?: string, status?: Ref, priority?: Ref, criteria?: string[],
   *   links?: { kind: string, value: string, label?: string }[], refs?: RefInput[], waitsOn?: Ref[], by?: string }} input
   * @returns {Item}
   */
  createItem(input) {
    return this.transaction(() => {
      const kind = input?.kind ?? 'task'
      if (!ITEM_KINDS.includes(/** @type {any} */ (kind))) throw invalid(`kind must be epic or task, not ${String(kind)}.`)
      const project = this.projectRow(input.project, input.portfolio)
      const title = requiredText(input.title, 'title', LIMITS.title)
      const description = optionalText(input.description, 'description', LIMITS.description) ?? ''
      const status = input.status === undefined ? this.defaultOption('statuses', project.portfolio_id) : this.optionRow('statuses', project.portfolio_id, input.status)
      const priority =
        input.priority === undefined ? this.defaultOption('priorities', project.portfolio_id) : this.optionRow('priorities', project.portfolio_id, input.priority)
      const epicId = input.epic == null ? null : this.epicFor(kind, project.portfolio_id, input.epic)
      const by = optionalText(input.by, 'by', LIMITS.sessionName) ?? null
      const number = Number(
        this.row('UPDATE portfolios SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number', project.portfolio_id)
          .number
      )
      // One sequence per portfolio, so a list that crosses projects is in the
      // order the items were made until someone reorders them.
      const position = Number(this.row('SELECT coalesce(max(position), 0) + 1 AS next FROM items WHERE portfolio_id = ?', project.portfolio_id).next)
      const at = this.stamp()
      const uid = Number(
        this.run(
          `INSERT INTO items (portfolio_id, number, kind, project_id, epic_id, title, description, status_id, priority_id,
                              position, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          project.portfolio_id,
          number,
          kind,
          project.id,
          epicId,
          title,
          description,
          status.id,
          priority.id,
          position,
          by,
          at,
          at
        ).lastInsertRowid
      )
      if (input.criteria !== undefined) this.addCriteria(uid, input.criteria)
      for (const link of input.links ?? []) this.addLink(uid, link)
      for (const ref of input.refs ?? []) this.addRef({ item: uid }, ref)
      for (const waitsOn of input.waitsOn ?? []) this.addDependency(uid, waitsOn)
      return this.getItem(uid)
    })
  }

  /**
   * Everything about one item. A task's log is its latest `logLimit` entries,
   * oldest first; an epic also lists its tasks and the projects they are in.
   * `refs` are its own references; what it inherits is `inheritedRefs`.
   *
   * @param {Ref} ref
   * @param {{ logLimit?: number }} [options]
   * @returns {Item}
   */
  getItem(ref, options = {}) {
    const row = this.itemRow(ref)
    const logLimit = clampInt(options.logLimit, 0, 10_000, 20)
    const summary = this.summaries('WHERE i.id = ?', [row.id])[0]
    const criteriaList = this.rows('SELECT text, done FROM criteria WHERE item_id = ? ORDER BY position', row.id).map(
      (criterion, index) => ({ n: index + 1, text: criterion.text, done: criterion.done === 1 })
    )
    const links = this.linkRows(row.id)
    const refs = this.listRefs({ item: row.id })
    const total = Number(this.row('SELECT count(*) AS n FROM log WHERE item_id = ?', row.id).n)
    const entries = this.rows('SELECT at, by, text, ref FROM log WHERE item_id = ? ORDER BY id DESC LIMIT ?', row.id, logLimit)
      .reverse()
      .map((entry) => ({ at: entry.at, by: entry.by, text: entry.text, ref: entry.ref }))
    const tasks = row.kind === 'epic' ? this.summaries(`WHERE i.epic_id = ? ${NEXT_UP_ORDER}`, [row.id]) : null
    return {
      ...summary,
      description: row.description,
      createdAt: row.created_at,
      createdBy: row.created_by,
      criteriaList,
      links,
      refs,
      waitsOn: this.summaries(`WHERE i.id IN (SELECT waits_on_id FROM dependencies WHERE item_id = ?) ${NEXT_UP_ORDER}`, [row.id]),
      blocks: this.summaries(`WHERE i.id IN (SELECT item_id FROM dependencies WHERE waits_on_id = ?) ${NEXT_UP_ORDER}`, [row.id]),
      handoff:
        row.handoff_at === null
          ? null
          : { done: row.handoff_done, left: row.handoff_left, next: row.handoff_next, by: row.handoff_by, at: row.handoff_at },
      log: { entries, total },
      tasks,
      spans: tasks === null ? null : spansOf(summary.project.name, tasks)
    }
  }

  /**
   * Changes an item's fields. Moving a task to another project keeps its ID;
   * the project must be in the same portfolio.
   *
   * @param {Ref} ref
   * @param {{ title?: string, description?: string, status?: Ref, priority?: Ref, project?: Ref, epic?: Ref | null, position?: number }} patch
   * @returns {{ item: ItemSummary, changes: Change[] }} the item after, and each field that changed
   */
  updateItem(ref, patch) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      const before = this.summaries('WHERE i.id = ?', [row.id])[0]
      /** @type {Change[]} */
      const changes = []
      /** @type {Record<string, unknown>} */
      const set = {}
      if (patch.title !== undefined) {
        const title = requiredText(patch.title, 'title', LIMITS.title)
        if (title !== row.title) {
          set.title = title
          changes.push({ field: 'title', from: row.title, to: title })
        }
      }
      if (patch.description !== undefined) {
        const description = optionalText(patch.description, 'description', LIMITS.description) ?? ''
        if (description !== row.description) {
          set.description = description
          changes.push({ field: 'description', from: null, to: null })
        }
      }
      if (patch.status !== undefined) {
        const status = this.optionRow('statuses', row.portfolio_id, patch.status)
        if (status.id !== row.status_id) {
          set.status_id = status.id
          changes.push({ field: 'status', from: before.status.name, to: status.name })
        }
      }
      if (patch.priority !== undefined) {
        const priority = this.optionRow('priorities', row.portfolio_id, patch.priority)
        if (priority.id !== row.priority_id) {
          set.priority_id = priority.id
          changes.push({ field: 'priority', from: before.priority.name, to: priority.name })
        }
      }
      if (patch.project !== undefined) {
        const project = this.projectRow(patch.project, row.portfolio_id)
        if (project.portfolio_id !== row.portfolio_id) {
          throw invalid(`${before.id} cannot move to ${project.p_key}/${project.name}: an item stays in its portfolio.`)
        }
        if (project.id !== row.project_id) {
          set.project_id = project.id
          changes.push({ field: 'project', from: before.project.name, to: project.name })
        }
      }
      if (patch.epic !== undefined) {
        const epicId = patch.epic === null ? null : this.epicFor(row.kind, row.portfolio_id, patch.epic)
        if (epicId !== row.epic_id) {
          set.epic_id = epicId
          const epic = epicId === null ? null : this.summaries('WHERE i.id = ?', [epicId])[0]
          changes.push({ field: 'epic', from: before.epic?.id ?? null, to: epic?.id ?? null })
        }
      }
      if (patch.position !== undefined) {
        if (typeof patch.position !== 'number' || !Number.isFinite(patch.position)) throw invalid('position must be a number.')
        set.position = patch.position
      }
      // An item's files stored relative to its project's folders move to the
      // new project's.
      const files = set.project_id === undefined ? null : this.filePaths('r.item_id = ?', row.id)
      const columns = Object.keys(set)
      if (columns.length > 0) {
        this.run(
          `UPDATE items SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          ...columns.map((column) => /** @type {any} */ (set[column])),
          this.stamp(),
          row.id
        )
      }
      if (files !== null) this.storeFiles(files, this.foldersOf(/** @type {number} */ (set.project_id)))
      return { item: this.summaries('WHERE i.id = ?', [row.id])[0], changes }
    })
  }

  /**
   * Deletes an item, its criteria, links, references, log and dependencies. An epic's
   * tasks stay, without an epic. The UI asks first; agents cancel instead.
   *
   * @param {Ref} ref
   */
  deleteItem(ref) {
    this.transaction(() => {
      const row = this.itemRow(ref)
      this.run('DELETE FROM items WHERE id = ?', row.id)
    })
  }

  /**
   * Items matching a filter, next up first.
   *
   * @param {{ portfolio?: Ref, project?: Ref, epic?: Ref, kind?: 'epic' | 'task', status?: Ref | Ref[],
   *   groups?: StatusGroup[], open?: boolean, ready?: boolean, text?: string, limit?: number, offset?: number }} [filter]
   * @returns {{ items: ItemSummary[], total: number }} the page asked for, and how many match in all
   */
  findItems(filter = {}) {
    /** @type {string[]} */
    const where = []
    /** @type {unknown[]} */
    const params = []
    const portfolio = filter.portfolio === undefined ? null : this.portfolioRow(filter.portfolio)
    if (portfolio) {
      where.push('i.portfolio_id = ?')
      params.push(portfolio.id)
    }
    if (filter.project !== undefined) {
      where.push('i.project_id = ?')
      params.push(this.projectRow(filter.project, portfolio?.id).id)
    }
    if (filter.epic !== undefined) {
      const epic = this.itemRow(filter.epic)
      if (epic.kind !== 'epic') throw invalid(`${formatId(epic.p_key, epic.number)} is a task, not an epic.`)
      where.push('i.epic_id = ?')
      params.push(epic.id)
    }
    if (filter.kind !== undefined) {
      if (!ITEM_KINDS.includes(/** @type {any} */ (filter.kind))) throw invalid('kind must be epic or task.')
      where.push('i.kind = ?')
      params.push(filter.kind)
    }
    if (filter.status !== undefined) {
      const names = (Array.isArray(filter.status) ? filter.status : [filter.status]).map((status) => {
        if (typeof status !== 'string' && typeof status !== 'number') throw invalid('status must be a name.')
        return status
      })
      const ids = names.filter((status) => typeof status === 'number')
      const text = names.filter((status) => typeof status === 'string').map((status) => String(status).trim().toLowerCase())
      where.push(
        `(s.id IN (${ids.map(() => '?').join(', ') || 'NULL'}) OR lower(s.name) IN (${text.map(() => '?').join(', ') || 'NULL'}))`
      )
      params.push(...ids, ...text)
    }
    const groups = filter.groups ?? (filter.open === true ? [...OPEN_GROUPS] : undefined)
    if (groups !== undefined) {
      if (!Array.isArray(groups)) throw invalid('groups must be a list.')
      groups.forEach(statusGroup)
      where.push(`s.grp IN (${groups.map(() => '?').join(', ') || 'NULL'})`)
      params.push(...groups)
    }
    if (filter.ready === true) where.push(`s.grp IN ('not-started', 'active') AND ${READY}`)
    if (filter.text !== undefined && filter.text !== '') {
      if (typeof filter.text !== 'string') throw invalid('text must be a string.')
      const text = filter.text.trim()
      const id = ITEM_ID.exec(text)
      where.push(`(instr(lower(i.title), lower(?)) > 0 OR instr(lower(i.description), lower(?)) > 0${id ? ' OR (p.key = ? AND i.number = ?)' : ''})`)
      params.push(text, text)
      if (id) params.push(id[1].toUpperCase(), Number(id[2]))
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limit = clampInt(filter.limit, 1, 1000, 50)
    const offset = clampInt(filter.offset, 0, Number.MAX_SAFE_INTEGER, 0)
    const total = Number(
      this.row(
        `SELECT count(*) AS n FROM items i JOIN portfolios p ON p.id = i.portfolio_id JOIN statuses s ON s.id = i.status_id ${clause}`,
        ...params
      ).n
    )
    const items = this.summaries(`${clause} ${NEXT_UP_ORDER} LIMIT ? OFFSET ?`, [...params, limit, offset])
    return { items, total }
  }

  /**
   * Everything the portfolio view shows: the portfolio with its projects, the
   * stat cards, the epics counted per project, and the tasks in progress and
   * waiting on another task.
   *
   * @param {Ref} ref key or uid
   * @param {{ home?: string, pathState?: (path: string) => PathState }} [options]
   */
  portfolioOverview(ref, options = {}) {
    const portfolio = this.getPortfolio(ref)
    const items = this.summaries(`WHERE i.portfolio_id = ? ${NEXT_UP_ORDER}`, [portfolio.uid])
    const history = this.rows(
      `SELECT h.item_id AS item, h.grp, h.at FROM status_history h JOIN items i ON i.id = h.item_id
        WHERE i.portfolio_id = ? AND i.kind = 'task' ORDER BY h.item_id, h.at, h.id`,
      portfolio.uid
    )
    const refs = this.listRefs({ portfolio: portfolio.uid })
    return {
      ...portfolioOverview(portfolio, items, history, { now: this.now(), home: options.home ?? homedir() }),
      refs,
      missing: missingFiles(refs, options.pathState ?? pathState)
    }
  }

  /**
   * Everything the project view shows: the project, its portfolio's statuses
   * and priorities, every item in it, next up first, and its references.
   *
   * @param {Ref} ref uid, or a name with `portfolio`
   * @param {Ref} [portfolio]
   * @param {{ home?: string, pathState?: (path: string) => PathState }} [options]
   */
  projectOverview(ref, portfolio, options = {}) {
    const project = this.getProject(ref, portfolio)
    const owner = this.portfolioRow(project.portfolio.uid)
    const refs = this.listRefs({ project: project.uid })
    return {
      project: placed(project, options.home ?? homedir()),
      portfolio: {
        uid: owner.id,
        key: owner.key,
        name: owner.name,
        nextNumber: owner.next_number,
        statuses: this.statusesOf(owner.id),
        priorities: this.prioritiesOf(owner.id)
      },
      items: this.summaries(`WHERE i.project_id = ? ${NEXT_UP_ORDER}`, [project.uid]),
      refs,
      missing: missingFiles(refs, options.pathState ?? pathState)
    }
  }

  /**
   * Everything the epic and task views show: the item with its log, what the
   * pickers offer (the portfolio's statuses, priorities, projects and open
   * epics), for an epic the order its tasks can be done in, the key
   * references it inherits that its own do not name, and which of all its
   * file references are gone (`missing`, by uid).
   *
   * @param {Ref} ref
   * @param {{ home?: string, logLimit?: number, pathState?: (path: string) => PathState }} [options]
   */
  itemOverview(ref, options = {}) {
    const row = this.itemRow(ref)
    const item = this.getItem(row.id, { logLimit: options.logLimit ?? 500 })
    const owner = this.portfolioRow(row.portfolio_id)
    const home = options.home ?? homedir()
    const epics = this.summaries(
      `WHERE i.portfolio_id = ? AND i.kind = 'epic' AND (s.grp IN ('not-started', 'active') OR i.id = ?) ${NEXT_UP_ORDER}`,
      [owner.id, row.epic_id ?? -1]
    )
    let order = null
    if (row.kind === 'epic') {
      const tasks = this.rows('SELECT id FROM items WHERE epic_id = ? ORDER BY position, number', row.id).map((task) => Number(task.id))
      const edges = this.rows(
        `SELECT d.item_id AS item, d.waits_on_id AS waitsOn FROM dependencies d
           JOIN items a ON a.id = d.item_id JOIN items b ON b.id = d.waits_on_id
          WHERE a.epic_id = ?1 AND b.epic_id = ?1`,
        row.id
      ).map((edge) => ({ item: Number(edge.item), waitsOn: Number(edge.waitsOn) }))
      order = orderOf(tasks, edges)
    }
    const inherited = unshadowed(item.refs, this.inheritedRefs(row.id))
    return {
      item,
      portfolio: {
        uid: owner.id,
        key: owner.key,
        name: owner.name,
        statuses: this.statusesOf(owner.id),
        priorities: this.prioritiesOf(owner.id)
      },
      projects: this.listProjects(owner.id).map((project) => placed(project, home)),
      epics,
      order,
      inherited,
      missing: missingFiles([...item.refs, ...inherited], options.pathState ?? pathState)
    }
  }

  /**
   * What the workflow page shows: the portfolio with its statuses, priorities
   * and projects, and how many items use each of them, so a delete can say
   * what moves with it.
   *
   * @param {Ref} ref
   * @param {{ home?: string }} [options]
   * @returns {{ portfolio: Omit<Portfolio, 'projects'> & { projects: (Project & { place: string | null })[] }, items: number,
   *   uses: { statuses: Record<number, number>, priorities: Record<number, number>, projects: Record<number, number> } }}
   */
  portfolioSettings(ref, options = {}) {
    const portfolio = this.getPortfolio(ref)
    const home = options.home ?? homedir()
    /** @param {'status_id' | 'priority_id' | 'project_id'} column */
    const tally = (column) =>
      Object.fromEntries(
        this.rows(`SELECT ${column} AS uid, count(*) AS n FROM items WHERE portfolio_id = ? GROUP BY ${column}`, portfolio.uid).map((row) => [
          Number(row.uid),
          Number(row.n)
        ])
      )
    return {
      portfolio: { ...portfolio, projects: portfolio.projects.map((project) => placed(project, home)) },
      items: Number(this.row('SELECT count(*) AS n FROM items WHERE portfolio_id = ?', portfolio.uid).n),
      uses: { statuses: tally('status_id'), priorities: tally('priority_id'), projects: tally('project_id') }
    }
  }

  /**
   * An edit from the pages: fields, dependencies, links, references, where it stands and
   * a note, in one transaction and one log line by `by`, the way a session's
   * update is logged. Moving an item out of an active status lets go of its
   * session. Criteria have their own methods and are not logged: the list
   * shows them.
   *
   * @param {Ref} ref
   * @param {{ title?: string, description?: string, status?: Ref, priority?: Ref, project?: Ref, epic?: Ref | null,
   *   waitsOn?: { add?: Ref[], remove?: Ref[] },
   *   links?: { add?: { kind: string, value: string, label?: string }[], remove?: number[] },
   *   refs?: { add?: RefInput[], edit?: (RefPatch & { uid: number })[], remove?: number[] },
   *   handoff?: { done?: string, left?: string, next?: string },
   *   note?: string }} patch
   * @param {string} by who made it, as the log names them
   * @returns {{ item: ItemSummary, ready: ItemSummary[] }} ready: what finishing the item freed
   */
  editItem(ref, patch, by) {
    return this.transaction(() => {
      const author = requiredText(by, 'by', LIMITS.sessionName)
      const row = this.itemRow(ref)
      const before = this.summaries('WHERE i.id = ?', [row.id])[0]
      const { changes } = this.updateItem(row.id, {
        title: patch.title,
        description: patch.description,
        status: patch.status,
        priority: patch.priority,
        project: patch.project,
        epic: patch.epic
      })
      const parts = changeParts(changes)

      for (const other of patch.waitsOn?.add ?? []) {
        this.addDependency(row.id, other)
        parts.push(`waits on ${this.idOf(other)}`)
      }
      for (const other of patch.waitsOn?.remove ?? []) {
        this.removeDependency(row.id, other)
        parts.push(`no longer waits on ${this.idOf(other)}`)
      }
      const added = (patch.links?.add ?? []).map((link) => this.addLink(row.id, link))
      const kinds = new Map(this.linkRows(row.id).map((link) => [link.uid, link.kind]))
      const removed = (patch.links?.remove ?? []).map((uid) => {
        const kind = kinds.get(uid)
        this.removeLink(row.id, uid)
        return { kind }
      })
      parts.push(...linkParts(added, removed))
      const refsAdded = (patch.refs?.add ?? []).map((input) => this.addRef({ item: row.id }, input))
      const own = new Map(this.listRefs({ item: row.id }).map((reference) => [reference.uid, JSON.stringify(reference)]))
      const refsEdited = (patch.refs?.edit ?? []).filter(
        ({ uid, ...fields }) => JSON.stringify(this.updateRef({ item: row.id }, uid, fields)) !== own.get(uid)
      )
      const refsRemoved = patch.refs?.remove ?? []
      for (const uid of refsRemoved) this.removeRef({ item: row.id }, uid)
      parts.push(...refParts(refsAdded, refsRemoved, refsEdited))
      if (patch.handoff !== undefined) {
        this.setHandoff(row.id, patch.handoff, author)
        parts.push('handoff')
      }
      const note = optionalText(patch.note, 'note', LIMITS.log) ?? ''

      const after = this.summaries('WHERE i.id = ?', [row.id])[0]
      const statusChanged = after.status.uid !== before.status.uid
      if (statusChanged && after.status.group !== 'active' && after.session) this.release(row.id)

      const summary = parts.join(SEP)
      const text = note && summary ? `${note}${SEP}${summary}` : note || summary
      if (text) this.appendLog(row.id, { text, by: author })
      const finished = statusChanged && (after.status.group === 'done' || after.status.group === 'closed')
      return { item: this.summaries('WHERE i.id = ?', [row.id])[0], ready: finished ? this.readyDependents(row.id) : [] }
    })
  }

  /**
   * The open items waiting on this one that nothing else holds up any more.
   * After finishing an item, these are what became ready.
   *
   * @param {Ref} ref
   * @returns {ItemSummary[]}
   */
  readyDependents(ref) {
    const row = this.itemRow(ref)
    return this.summaries(
      `WHERE i.id IN (SELECT item_id FROM dependencies WHERE waits_on_id = ?)
         AND s.grp IN ('not-started', 'active') AND ${READY} ${NEXT_UP_ORDER}`,
      [row.id]
    )
  }

  // ---------------------------------------------------------------------------
  // Acceptance criteria. Numbered from 1, in order, as people read them.

  /**
   * @param {Ref} ref
   * @param {string[]} texts
   * @returns {Criterion[]}
   */
  addCriteria(ref, texts) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      if (!Array.isArray(texts)) throw invalid('Criteria must be a list of sentences.')
      let position = Number(this.row('SELECT coalesce(max(position), 0) AS last FROM criteria WHERE item_id = ?', row.id).last)
      for (const text of texts) {
        this.run('INSERT INTO criteria (item_id, position, text) VALUES (?, ?, ?)', row.id, ++position, requiredText(text, 'criterion', LIMITS.criterion))
      }
      this.touch(row.id)
      return this.criteriaOf(row.id)
    })
  }

  /**
   * Checks or unchecks criteria by number.
   *
   * @param {Ref} ref
   * @param {number[]} numbers
   * @param {boolean} done
   * @returns {Criterion[]}
   */
  setCriteriaDone(ref, numbers, done) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      if (!Array.isArray(numbers)) throw invalid('Name the criteria by number.')
      if (typeof done !== 'boolean') throw invalid('done must be true or false.')
      const ids = this.criterionIds(row.id)
      for (const n of numbers) this.run('UPDATE criteria SET done = ? WHERE id = ?', done ? 1 : 0, criterionId(ids, n, row))
      this.touch(row.id)
      return this.criteriaOf(row.id)
    })
  }

  /**
   * @param {Ref} ref
   * @param {number} n
   * @param {string} text
   * @returns {Criterion[]}
   */
  editCriterion(ref, n, text) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      const id = criterionId(this.criterionIds(row.id), n, row)
      this.run('UPDATE criteria SET text = ? WHERE id = ?', requiredText(text, 'criterion', LIMITS.criterion), id)
      this.touch(row.id)
      return this.criteriaOf(row.id)
    })
  }

  /**
   * Removes a criterion. Those after it are numbered one lower.
   *
   * @param {Ref} ref
   * @param {number} n
   * @returns {Criterion[]}
   */
  removeCriterion(ref, n) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      this.run('DELETE FROM criteria WHERE id = ?', criterionId(this.criterionIds(row.id), n, row))
      this.touch(row.id)
      return this.criteriaOf(row.id)
    })
  }

  /**
   * @private
   * @param {number} itemId
   * @returns {number[]}
   */
  criterionIds(itemId) {
    return this.rows('SELECT id FROM criteria WHERE item_id = ? ORDER BY position', itemId).map((row) => row.id)
  }

  /**
   * @private
   * @param {number} itemId
   * @returns {Criterion[]}
   */
  criteriaOf(itemId) {
    return this.rows('SELECT text, done FROM criteria WHERE item_id = ? ORDER BY position', itemId).map((row, index) => ({
      n: index + 1,
      text: row.text,
      done: row.done === 1
    }))
  }

  // ---------------------------------------------------------------------------
  // Dependencies. Across projects, inside one portfolio.

  /**
   * Makes `ref` wait on `waitsOn`. Adding one that exists changes nothing.
   *
   * @param {Ref} ref
   * @param {Ref} waitsOn
   */
  addDependency(ref, waitsOn) {
    this.transaction(() => {
      const item = this.itemRow(ref)
      const other = this.itemRow(waitsOn)
      const itemId = formatId(item.p_key, item.number)
      const otherId = formatId(other.p_key, other.number)
      if (item.id === other.id) throw invalid(`${itemId} cannot wait on itself.`)
      if (item.portfolio_id !== other.portfolio_id) throw invalid(`${itemId} and ${otherId} are in different portfolios.`)
      const cycle = this.row(
        `WITH RECURSIVE chain(id) AS (
           SELECT waits_on_id FROM dependencies WHERE item_id = ?
           UNION SELECT d.waits_on_id FROM dependencies d JOIN chain c ON d.item_id = c.id)
         SELECT 1 FROM chain WHERE id = ? LIMIT 1`,
        other.id,
        item.id
      )
      if (cycle) throw conflict(`${otherId} already waits on ${itemId}, so ${itemId} cannot wait on it.`)
      const added = this.run('INSERT OR IGNORE INTO dependencies (item_id, waits_on_id) VALUES (?, ?)', item.id, other.id)
      if (Number(added.changes) > 0) this.touch(item.id)
    })
  }

  /**
   * @param {Ref} ref
   * @param {Ref} waitsOn
   */
  removeDependency(ref, waitsOn) {
    this.transaction(() => {
      const item = this.itemRow(ref)
      const other = this.itemRow(waitsOn)
      const removed = this.run('DELETE FROM dependencies WHERE item_id = ? AND waits_on_id = ?', item.id, other.id)
      if (Number(removed.changes) > 0) this.touch(item.id)
    })
  }

  // ---------------------------------------------------------------------------
  // Links

  /**
   * Adds a link. The same kind and value twice is one link; a new label
   * replaces the old one.
   *
   * @param {Ref} ref
   * @param {{ kind: string, value: string, label?: string }} input
   * @returns {Link}
   */
  addLink(ref, input) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      const kind = input?.kind
      if (!LINK_KINDS.includes(/** @type {any} */ (kind))) throw invalid(`A link's kind is one of ${LINK_KINDS.join(', ')}.`)
      const value = requiredText(input.value, 'link', LIMITS.linkValue)
      const label = optionalText(input.label, 'label', LIMITS.title) ?? ''
      const existing = this.row('SELECT id FROM links WHERE item_id = ? AND kind = ? AND value = ?', row.id, kind, value)
      if (existing) {
        if (input.label !== undefined) this.run('UPDATE links SET label = ? WHERE id = ?', label, existing.id)
      } else {
        const position = Number(this.row('SELECT coalesce(max(position), 0) + 1 AS next FROM links WHERE item_id = ?', row.id).next)
        this.run(
          'INSERT INTO links (item_id, kind, value, label, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          row.id,
          kind,
          value,
          label,
          position,
          this.stamp()
        )
      }
      this.touch(row.id)
      const link = this.row('SELECT id, kind, value, label FROM links WHERE item_id = ? AND kind = ? AND value = ?', row.id, kind, value)
      return { uid: link.id, kind: link.kind, value: link.value, label: link.label }
    })
  }

  /**
   * @param {Ref} ref
   * @param {number} linkUid
   */
  removeLink(ref, linkUid) {
    this.transaction(() => {
      const row = this.itemRow(ref)
      const removed = this.run('DELETE FROM links WHERE id = ? AND item_id = ?', linkUid, row.id)
      if (Number(removed.changes) === 0) throw notFound(`${formatId(row.p_key, row.number)} has no link ${linkUid}.`)
      this.touch(row.id)
    })
  }

  // ---------------------------------------------------------------------------
  // References: what the work follows, held by a portfolio, a project or an
  // item. A key reference also shows on everything under its owner. A file
  // inside one of its owner's project folders is stored relative to it and
  // read back as an absolute path; a portfolio's files stay absolute.

  /**
   * @param {RefOwner} owner
   * @returns {Reference[]} in their order
   */
  listRefs(owner) {
    const holder = this.refOwner(owner)
    return this.references(this.rows(`${REF_SELECT} WHERE r.${holder.column} = ? ORDER BY r.position`, holder.id))
  }

  /**
   * Adds a reference. The same kind and target twice is one reference: the
   * fields given replace its own. A new one needs `use`, the line that says
   * when to read it; its title is the target when none is given. With no
   * kind, the target says which it is (inferRefKind).
   *
   * @param {RefOwner} owner
   * @param {RefInput} input
   * @returns {Reference}
   */
  addRef(owner, input) {
    return this.transaction(() => {
      const holder = this.refOwner(owner)
      const kind = input?.kind === undefined || input.kind === '' ? inferRefKind(String(input?.target ?? '')) : refKind(input.kind)
      const target = refTarget(kind, input.target, holder.folders)
      const title = optionalText(input.title, 'title', LIMITS.refTitle)
      const use = input.use === undefined ? undefined : requiredText(input.use, 'use line', LIMITS.refUse)
      if (input.key !== undefined && typeof input.key !== 'boolean') throw invalid('key must be true or false.')
      const existing = this.row(`SELECT id FROM refs WHERE ${holder.column} = ? AND kind = ? AND target = ?`, holder.id, kind, target)
      let uid
      if (existing) {
        uid = Number(existing.id)
        if (title !== undefined) this.run('UPDATE refs SET title = ? WHERE id = ?', title || target, uid)
        if (use !== undefined) this.run('UPDATE refs SET use = ? WHERE id = ?', use, uid)
        if (input.key !== undefined) this.run('UPDATE refs SET key = ? WHERE id = ?', input.key ? 1 : 0, uid)
      } else {
        if (use === undefined) throw invalid('A reference needs a use line: when to read it, like "Read when changing the sync engine".')
        const position = Number(this.row(`SELECT coalesce(max(position), 0) + 1 AS next FROM refs WHERE ${holder.column} = ?`, holder.id).next)
        uid = Number(
          this.run(
            `INSERT INTO refs (${holder.column}, kind, target, title, use, key, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            holder.id,
            kind,
            target,
            title || target,
            use,
            input.key ? 1 : 0,
            position,
            this.stamp()
          ).lastInsertRowid
        )
      }
      this.touchOwner(holder)
      return this.references(this.rows(`${REF_SELECT} WHERE r.id = ?`, uid))[0]
    })
  }

  /**
   * Changes a reference where it is in its owner's order. A new target with
   * no kind takes the kind it reads as; a title that only repeated the old
   * target follows the new one. A target the owner already has in another
   * reference is refused.
   *
   * @param {RefOwner} owner
   * @param {number} uid
   * @param {RefPatch} patch
   * @returns {Reference}
   */
  updateRef(owner, uid, patch) {
    return this.transaction(() => {
      const holder = this.refOwner(owner)
      const row = this.row(`SELECT kind, target, title, use, key FROM refs WHERE id = ? AND ${holder.column} = ?`, uid, holder.id)
      if (!row) throw notFound(`${holder.name} has no reference ${uid}.`)
      const current = this.references(this.rows(`${REF_SELECT} WHERE r.id = ?`, uid))[0]
      const input = typeof patch === 'object' && patch !== null ? patch : {}
      const retargeted = input.target !== undefined && String(input.target).trim() !== current.target
      const kind =
        input.kind !== undefined && input.kind !== '' ? refKind(input.kind) : retargeted ? inferRefKind(String(input.target)) : /** @type {RefKind} */ (row.kind)
      const target = retargeted || kind !== row.kind ? refTarget(kind, retargeted ? input.target : current.target, holder.folders) : String(row.target)
      const title = optionalText(input.title, 'title', LIMITS.refTitle)
      const use = input.use === undefined ? String(row.use) : requiredText(input.use, 'use line', LIMITS.refUse)
      if (input.key !== undefined && typeof input.key !== 'boolean') throw invalid('key must be true or false.')
      const taken = this.row(`SELECT 1 FROM refs WHERE ${holder.column} = ? AND kind = ? AND target = ? AND id <> ?`, holder.id, kind, target, uid)
      if (taken) throw conflict(`${holder.name} already has a reference to ${retargeted ? String(input.target).trim() : current.target}.`)
      const followsTarget = title === undefined && row.title === row.target
      this.run(
        'UPDATE refs SET kind = ?, target = ?, title = ?, use = ?, key = ? WHERE id = ?',
        kind,
        target,
        followsTarget ? target : title || (title === undefined ? String(row.title) : target),
        use,
        input.key === undefined ? Number(row.key) : input.key ? 1 : 0,
        uid
      )
      this.touchOwner(holder)
      return this.references(this.rows(`${REF_SELECT} WHERE r.id = ?`, uid))[0]
    })
  }

  /**
   * @param {RefOwner} owner
   * @param {number} uid
   */
  removeRef(owner, uid) {
    this.transaction(() => {
      const holder = this.refOwner(owner)
      const removed = this.run(`DELETE FROM refs WHERE id = ? AND ${holder.column} = ?`, uid, holder.id)
      if (Number(removed.changes) === 0) throw notFound(`${holder.name} has no reference ${uid}.`)
      this.touchOwner(holder)
    })
  }

  /**
   * @param {RefOwner} owner
   * @param {number[]} order every reference of the owner, by uid, in the new order
   * @returns {Reference[]}
   */
  reorderRefs(owner, order) {
    return this.transaction(() => {
      const holder = this.refOwner(owner)
      const ids = new Set(this.rows(`SELECT id FROM refs WHERE ${holder.column} = ?`, holder.id).map((row) => Number(row.id)))
      if (!Array.isArray(order) || order.length !== ids.size) {
        throw invalid(`The new order must name each of the ${ids.size} references of ${holder.name} once.`)
      }
      const seen = new Set()
      for (const uid of order) {
        if (!ids.has(uid)) throw invalid(`${String(uid)} is not one of the references of ${holder.name}.`)
        if (seen.has(uid)) throw invalid(`Reference ${uid} is named twice in the new order.`)
        seen.add(uid)
      }
      order.forEach((uid, index) => this.run('UPDATE refs SET position = ? WHERE id = ?', index + 1, uid))
      this.touchOwner(holder)
      return this.listRefs(owner)
    })
  }

  /**
   * The key references an item inherits: its epic's, then its project's, then
   * its portfolio's, each in its owner's order. An epic, and a task outside
   * one, start at the project. `from` says whose each is; its name is the
   * epic's ID, the project's name or the portfolio's key.
   *
   * @param {Ref} ref
   * @returns {InheritedReference[]}
   */
  inheritedRefs(ref) {
    const row = this.itemRow(ref)
    const rows = this.rows(
      `SELECT * FROM (
         SELECT 0 AS level, * FROM (${REF_SELECT} WHERE r.item_id = ?1 AND r.key = 1)
         UNION ALL SELECT 1, * FROM (${REF_SELECT} WHERE r.project_id = ?2 AND r.key = 1)
         UNION ALL SELECT 2, * FROM (${REF_SELECT} WHERE r.portfolio_id = ?3 AND r.key = 1))
        ORDER BY level, position`,
      row.epic_id,
      row.project_id,
      row.portfolio_id
    )
    if (rows.length === 0) return []
    const levels = /** @type {const} */ (['epic', 'project', 'portfolio'])
    const sources = [
      row.epic_id === null ? null : { level: levels[0], uid: Number(row.epic_id), name: this.idOf(Number(row.epic_id)) },
      { level: levels[1], uid: Number(row.project_id), name: String(this.projectRow(Number(row.project_id)).name) },
      { level: levels[2], uid: Number(row.portfolio_id), name: String(row.p_key) }
    ]
    return this.references(rows).map((reference, index) => ({ ...reference, from: sources[Number(rows[index].level)] ?? unreachable() }))
  }

  /**
   * Whose references: the item, the project or the portfolio named, with the
   * folders its files are stored against. A portfolio has none.
   *
   * @private
   * @param {RefOwner} owner
   * @returns {{ column: 'item_id' | 'project_id' | 'portfolio_id', id: number, name: string, folders: string[] }}
   */
  refOwner(owner) {
    const named = /** @type {Record<string, unknown>} */ (typeof owner === 'object' && owner !== null ? owner : {})
    if (named.item !== undefined) {
      const row = this.itemRow(/** @type {Ref} */ (named.item))
      return { column: 'item_id', id: Number(row.id), name: formatId(row.p_key, row.number), folders: this.foldersOf(row.project_id) }
    }
    if (named.project !== undefined) {
      const row = this.projectRow(/** @type {Ref} */ (named.project), /** @type {Ref | undefined} */ (named.portfolio))
      return { column: 'project_id', id: Number(row.id), name: String(row.name), folders: this.foldersOf(row.id) }
    }
    if (named.portfolio !== undefined) {
      const row = this.portfolioRow(/** @type {Ref} */ (named.portfolio))
      return { column: 'portfolio_id', id: Number(row.id), name: String(row.key), folders: [] }
    }
    throw invalid('Say whose references: an item, a project or a portfolio.')
  }

  /**
   * @private
   * @param {{ column: 'item_id' | 'project_id' | 'portfolio_id', id: number }} holder
   */
  touchOwner(holder) {
    if (holder.column === 'item_id') this.touch(holder.id)
    else this.run(`UPDATE ${holder.column === 'project_id' ? 'projects' : 'portfolios'} SET updated_at = ? WHERE id = ?`, this.stamp(), holder.id)
  }

  /**
   * Reference rows as callers see them, a relative file back under the first
   * of its project's folders it exists in.
   *
   * @private
   * @param {any[]} rows read through REF_SELECT
   * @returns {Reference[]}
   */
  references(rows) {
    /** @type {Map<number, string[]>} */
    const folders = new Map()
    return rows.map((row) => {
      let target = String(row.target)
      if (row.kind === 'file' && row.anchor !== null && !isAbsolute(target)) {
        const anchor = Number(row.anchor)
        if (!folders.has(anchor)) folders.set(anchor, this.foldersOf(anchor))
        target = resolvePath(target, folders.get(anchor) ?? [])
      }
      return { uid: Number(row.id), kind: row.kind, target, title: row.title, use: row.use, key: row.key === 1 }
    })
  }

  /**
   * The file references a condition matches, each as an absolute path read
   * against the folders it is stored against now.
   *
   * @private
   * @param {string} where a condition on `r`, the references
   * @param {...any} params
   * @returns {{ uid: number, path: string }[]}
   */
  filePaths(where, ...params) {
    return this.references(this.rows(`${REF_SELECT} WHERE r.kind = 'file' AND (${where})`, ...params)).map((reference) => ({
      uid: reference.uid,
      path: reference.target
    }))
  }

  /**
   * Stores files read by `filePaths` against new folders. One that comes to
   * equal another reference of its owner is that reference, and goes.
   *
   * @private
   * @param {{ uid: number, path: string }[]} files
   * @param {readonly string[]} folders
   */
  storeFiles(files, folders) {
    for (const file of files) {
      const updated = this.run('UPDATE OR IGNORE refs SET target = ? WHERE id = ?', anchorPath(file.path, folders), file.uid)
      if (Number(updated.changes) === 0) this.run('DELETE FROM refs WHERE id = ?', file.uid)
    }
  }

  // ---------------------------------------------------------------------------
  // Work tracking: where it stands, the log, and the session on it

  /**
   * Rewrites "where it stands". Each session replaces the last one's.
   *
   * @param {Ref} ref
   * @param {{ done?: string, left?: string, next?: string }} handoff
   * @param {string} by who wrote it: a session's name, or the user
   * @returns {Handoff}
   */
  setHandoff(ref, handoff, by) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      const author = requiredText(by, 'by', LIMITS.sessionName)
      const done = optionalText(handoff?.done, 'done', LIMITS.handoffField) ?? ''
      const left = optionalText(handoff.left, 'left', LIMITS.handoffField) ?? ''
      const next = optionalText(handoff.next, 'next', LIMITS.handoffField) ?? ''
      const at = this.stamp()
      this.run(
        `UPDATE items SET handoff_done = ?, handoff_left = ?, handoff_next = ?, handoff_by = ?, handoff_at = ?, updated_at = ?
          WHERE id = ?`,
        done,
        left,
        next,
        author,
        at,
        at,
        row.id
      )
      return { done, left, next, by: author, at }
    })
  }

  /**
   * Adds a line to the item's log. The log only grows.
   *
   * @param {Ref} ref
   * @param {{ text: string, by: string, ref?: string }} entry `ref` is what the line is about: a commit, a PR
   * @returns {LogEntry}
   */
  appendLog(ref, entry) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      const text = requiredText(entry?.text, 'log', LIMITS.log)
      const by = requiredText(entry.by, 'by', LIMITS.sessionName)
      const about = optionalText(entry.ref, 'ref', LIMITS.linkValue) ?? null
      const at = this.stamp()
      this.run('INSERT INTO log (item_id, at, by, text, ref) VALUES (?, ?, ?, ?, ?)', row.id, at, by, text, about)
      this.touch(row.id)
      return { at, by, text, ref: about }
    })
  }

  /**
   * Records that a session is working on the item. Another session may
   * already have it: that one is returned, and replaced, never refused.
   *
   * @param {Ref} ref
   * @param {{ id: string, name: string }} session
   * @returns {{ previous: SessionClaim | null }} the other session that had it
   */
  claim(ref, session) {
    return this.transaction(() => {
      const row = this.itemRow(ref)
      const id = requiredText(session?.id, 'session id', LIMITS.sessionName)
      const name = requiredText(session.name, 'session name', LIMITS.sessionName)
      const previous =
        row.session_id !== null && row.session_id !== id
          ? { id: row.session_id, name: row.session_name, activeAt: row.session_active_at }
          : null
      const at = this.stamp()
      this.run('UPDATE items SET session_id = ?, session_name = ?, session_active_at = ?, updated_at = ? WHERE id = ?', id, name, at, at, row.id)
      return { previous }
    })
  }

  /**
   * Clears the session on an item.
   *
   * @param {Ref} ref
   */
  release(ref) {
    this.transaction(() => {
      const row = this.itemRow(ref)
      this.run('UPDATE items SET session_id = NULL, session_name = NULL, session_active_at = NULL, updated_at = ? WHERE id = ?', this.stamp(), row.id)
    })
  }

  // ---------------------------------------------------------------------------
  // Item helpers

  /**
   * @private
   * @param {Ref} ref an ID like TC-123, or a uid
   */
  itemRow(ref) {
    const select = 'SELECT i.*, p.key AS p_key FROM items i JOIN portfolios p ON p.id = i.portfolio_id'
    if (typeof ref === 'number') {
      const row = this.row(`${select} WHERE i.id = ?`, ref)
      if (!row) throw notFound(`Item ${ref} does not exist.`)
      return row
    }
    if (typeof ref !== 'string') throw invalid('Name an item by its ID, like TC-123.')
    const match = ITEM_ID.exec(ref.trim())
    if (!match) throw invalid(`${ref} is not an ID. IDs look like TC-123.`)
    const row = this.row(`${select} WHERE p.key = ? AND i.number = ?`, match[1].toUpperCase(), Number(match[2]))
    if (!row) throw notFound(`${match[1].toUpperCase()}-${Number(match[2])} does not exist.`)
    return row
  }

  /**
   * @private
   * @param {Ref} ref
   */
  idOf(ref) {
    const row = this.itemRow(ref)
    return formatId(row.p_key, row.number)
  }

  /**
   * The epic a task may be put in.
   *
   * @private
   * @param {string} kind the item's kind
   * @param {number} portfolioId
   * @param {Ref} ref
   */
  epicFor(kind, portfolioId, ref) {
    if (kind === 'epic') throw invalid('An epic cannot be inside another epic.')
    const epic = this.itemRow(ref)
    const id = formatId(epic.p_key, epic.number)
    if (epic.kind !== 'epic') throw invalid(`${id} is a task, not an epic.`)
    if (epic.portfolio_id !== portfolioId) throw invalid(`${id} is in another portfolio.`)
    return /** @type {number} */ (epic.id)
  }

  /**
   * @private
   * @param {'statuses' | 'priorities'} table
   * @param {number} portfolioId
   */
  defaultOption(table, portfolioId) {
    return this.row(`SELECT * FROM ${table} WHERE portfolio_id = ? AND is_default = 1`, portfolioId)
  }

  /**
   * @private
   * @param {number} itemId
   */
  touch(itemId) {
    this.run('UPDATE items SET updated_at = ? WHERE id = ?', this.stamp(), itemId)
  }

  /**
   * @private
   * @param {string} tail WHERE, ORDER BY and LIMIT, written against SUMMARY_SELECT's aliases
   * @param {unknown[]} params
   * @returns {ItemSummary[]}
   */
  summaries(tail, params) {
    return this.rows(`${SUMMARY_SELECT} ${tail}`, ...params).map((row) => ({
      uid: row.id,
      id: formatId(row.p_key, row.number),
      kind: row.kind,
      title: row.title,
      portfolio: { uid: row.p_id, key: row.p_key },
      project: { uid: row.j_id, name: row.j_name, colour: row.j_colour },
      epic: row.e_number === null ? null : { id: formatId(row.p_key, row.e_number), title: row.e_title },
      status: { uid: row.s_id, name: row.s_name, group: row.s_grp, colour: row.s_colour, icon: row.s_icon },
      priority: { uid: row.r_id, name: row.r_name },
      criteria: { done: Number(row.c_done), total: Number(row.c_total) },
      waitingOn:
        row.waiting === null
          ? []
          : String(row.waiting)
              .split(',')
              .map(Number)
              .sort((a, b) => a - b)
              .map((number) => formatId(row.p_key, number)),
      session: row.session_id === null ? null : { id: row.session_id, name: row.session_name, activeAt: row.session_active_at },
      updatedAt: row.updated_at
    }))
  }
}

// -----------------------------------------------------------------------------
// Validation and shaping

/**
 * @param {string} key
 * @param {number} number
 */
export function formatId(key, number) {
  return `${key}-${number}`
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 */
function requiredText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${capitalise(field)} is required.`)
  const text = value.trim()
  if (text.length > max) throw invalid(`${capitalise(field)} is longer than ${max} characters.`)
  return text
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {string | undefined}
 */
function optionalText(value, field, max) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`${capitalise(field)} must be text.`)
  const text = value.trim()
  if (text.length > max) throw invalid(`${capitalise(field)} is longer than ${max} characters.`)
  return text
}

/** @param {unknown} value */
function portfolioKey(value) {
  const key = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!PORTFOLIO_KEY.test(key)) throw invalid('A portfolio key is a letter then up to nine letters or digits, like TC or HELM.')
  return key
}

/**
 * @param {unknown} value
 * @returns {StatusGroup}
 */
function statusGroup(value) {
  if (!STATUS_GROUPS.includes(/** @type {any} */ (value))) throw invalid(`A status group is one of ${STATUS_GROUPS.join(', ')}.`)
  return /** @type {StatusGroup} */ (value)
}

/** @param {unknown} value */
function colourOf(value) {
  if (typeof value !== 'string' || !COLOURS.includes(value)) throw invalid(`A colour is one of ${COLOURS.join(', ')}.`)
  return value
}

/** @param {unknown} value */
function statusIcon(value) {
  if (!STATUS_ICONS.includes(/** @type {any} */ (value))) throw invalid(`A status icon is one of ${STATUS_ICONS.join(', ')}.`)
  return /** @type {string} */ (value)
}

/**
 * @param {unknown} value
 * @returns {RefKind}
 */
function refKind(value) {
  if (!REF_KINDS.includes(/** @type {any} */ (value))) throw invalid(`A reference's kind is one of ${REF_KINDS.join(', ')}.`)
  return /** @type {RefKind} */ (value)
}

/**
 * A reference's target as it is stored: an artifact's claude.ai address, a
 * doc's or url's web address, a file's absolute path, relative to the
 * deepest of `folders` that holds it.
 *
 * @param {RefKind} kind
 * @param {unknown} value
 * @param {readonly string[]} folders
 */
function refTarget(kind, value, folders) {
  const target = requiredText(value, 'target', LIMITS.linkValue)
  if (kind === 'artifact') {
    if (!isArtifactAddress(target)) {
      throw invalid(`${target} is not a claude.ai artifact. An artifact's address is like https://claude.ai/artifact/… or https://claude.ai/code/artifact/….`)
    }
    return target
  }
  if (kind === 'file') {
    const absolute = absoluteFolder(target)
    if (absolute === null) throw invalid(`${target} is not an absolute path. A file reference names the file in full.`)
    return anchorPath(absolute, folders)
  }
  if (!isWebAddress(target)) throw invalid(`${target} is not a web address. A ${kind} reference starts with https:// or http://.`)
  return target
}

/**
 * @param {number[]} ids criterion ids in order
 * @param {unknown} n
 * @param {any} item
 */
function criterionId(ids, n, item) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > ids.length) {
    const id = formatId(item.p_key, item.number)
    throw invalid(ids.length === 0 ? `${id} has no criteria.` : `${id} has criteria 1 to ${ids.length}; ${String(n)} is not one.`)
  }
  return ids[n - 1]
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * @param {{ id: number, name: string }} row
 * @param {Ref} ref
 */
function matchesRef(row, ref) {
  return typeof ref === 'number' ? row.id === ref : typeof ref === 'string' && row.name.toLowerCase() === ref.trim().toLowerCase()
}

/**
 * The projects an epic spans: its home first, then each its tasks are in.
 *
 * @param {string} home
 * @param {ItemSummary[]} tasks
 */
function spansOf(home, tasks) {
  return [...new Set([home, ...tasks.map((task) => task.project.name)])]
}

/** @param {any} row */
function portfolioOf(row) {
  return { uid: row.id, key: row.key, name: row.name, description: row.description, nextNumber: row.next_number }
}

/** @param {string} text */
function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** @returns {never} */
function unreachable() {
  throw new Error('unreachable')
}
