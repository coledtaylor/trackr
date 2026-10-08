/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * A project: its tasks as a list grouped by status, each group in
 * its own box, or as a board with a column per status. Filters by epic,
 * priority and whether a session is on it, and a quick add under each
 * not-started group (and at the top of a board column). The v2 board's
 * project page.
 *
 * What the person is doing survives a reload: the mode, filters, folded
 * groups, and text typed into a quick add, with its focus.
 */

import {
  ICONS,
  colourVar,
  el,
  epicChip,
  fill,
  lineIcon,
  priorityGlyph,
  segments,
  sessionChip,
  sessionTile,
  statusIcon,
  tile,
  waitsMark
} from '../shared/dom.js'
import { age, boardColumns, listOrder, priorityMark } from '../shared/logic.js'
import { announceChange, openItem, openPortfolio, openWorkflow, rpc } from '../shared/work.js'

/**
 * @typedef {import('../shared/types.js').ProjectOverview} ProjectOverview
 * @typedef {import('../shared/types.js').ItemSummary} ItemSummary
 * @typedef {import('../shared/types.js').Status} Status
 * @typedef {import('../shared/types.js').Item} Item
 * @typedef {import('./parts.js').Host} Host
 * @typedef {import('./parts.js').View} View
 * @typedef {'list' | 'board'} Mode
 */

const FINISHED = new Set(['done', 'closed'])

/**
 * @param {HTMLElement} root
 * @param {number} uid
 * @param {Host} host
 * @returns {View}
 */
export function createProjectView(root, uid, host) {
  const storageKey = `work.project.${uid}`
  const saved = readSaved(storageKey)

  const state = {
    /** @type {ProjectOverview | null} */
    data: null,
    /** @type {Mode} */
    mode: saved.mode,
    /** Status uid to open (true) or folded (false), where the person chose. */
    folded: /** @type {Record<string, boolean>} */ (saved.open),
    /** 'any', 'none' or an epic ID */
    epic: 'any',
    /** 'any' or a priority uid */
    priority: 'any',
    sessionOnly: false,
    /** The board column showing its quick add, by status uid. */
    boardAdding: /** @type {number | null} */ (null),
    /** Items made here since the tab opened, drawn highlighted once. */
    fresh: /** @type {Set<number>} */ (new Set())
  }

  /** @type {Map<number, HTMLInputElement>} Quick add fields by status uid, kept across draws so typing survives a reload. */
  const quickAdds = new Map()
  /** @type {Map<number, HTMLElement>} */
  const quickErrors = new Map()

  const head = el('header', { class: 'pj-head' })
  const filters = el('div', { class: 'pj-filters' })
  const content = el('div', { class: 'pj-content' })

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ mode: state.mode, open: state.folded }))
    } catch {
      // A preference only.
    }
  }

  // -------------------------------------------------------------------------
  // Drawing

  function draw() {
    const data = state.data
    if (!data) return
    if (root.firstChild !== head) {
      root.className = 'view-project'
      fill(root, [head, filters, content])
    }
    const focused = document.activeElement
    const selection =
      focused instanceof HTMLInputElement ? { start: focused.selectionStart, end: focused.selectionEnd } : null
    fill(head, headParts(data))
    fill(filters, filterParts(data))
    fill(content, state.mode === 'list' ? listParts(data) : boardParts(data))
    content.className = state.mode === 'list' ? 'pj-content pj-list' : 'pj-content pj-board'
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) {
      focused.focus()
      if (focused instanceof HTMLInputElement && selection) focused.setSelectionRange(selection.start, selection.end)
    }
  }

  /** @param {ProjectOverview} data */
  function headParts(data) {
    const { project, portfolio } = data
    const { open, active, done } = project.counts
    return [
      tile(project.name.charAt(0).toUpperCase(), 34, project.colour, 'pj-tile'),
      el('div', { class: 'pj-title' }, [
        el('span', { class: 'pj-crumbs' }, [
          el('button', {
            class: 'crumb',
            text: portfolio.name,
            attrs: { type: 'button' },
            on: { click: () => void openPortfolio({ uid: portfolio.uid, key: portfolio.key, name: portfolio.name }) }
          }),
          project.place ? el('span', { class: 'crumb-sep', text: '›' }) : null,
          project.place ? el('span', { class: 'work-mono pj-place work-ellip', text: project.place, title: project.folders.join('\n') }) : null
        ]),
        el('h1', { text: project.name })
      ]),
      el('div', { class: 'pj-progress' }, [
        segments({ done, active, open: open - active }, colourVar(project.colour)),
        el('span', { text: `${open} open · ${active} in progress · ${done} done` })
      ]),
      el('div', { class: 'pj-modes', attrs: { role: 'group', 'aria-label': 'View' } }, [
        modeButton('list', 'List'),
        modeButton('board', 'Board')
      ]),
      el(
        'button',
        {
          class: 'helm-icon-button pj-settings',
          title: 'Name, colour and folders',
          attrs: { type: 'button', 'aria-label': `Edit ${project.name}: name, colour and folders` },
          on: { click: () => void openWorkflow(portfolio, project.uid) }
        },
        [lineIcon(ICONS.sliders, 14, 1.7)]
      ),
      el(
        'button',
        { class: 'helm-button', attrs: { type: 'button', 'data-variant': 'primary' }, on: { click: () => startTask() } },
        [lineIcon(ICONS.plus, 13, 1.8), 'Task']
      )
    ]
  }

  /**
   * @param {Mode} mode
   * @param {string} label
   */
  function modeButton(mode, label) {
    return el('button', {
      class: 'pj-mode',
      text: label,
      attrs: { type: 'button', 'aria-pressed': state.mode === mode ? 'true' : 'false' },
      on: {
        click: () => {
          if (state.mode === mode) return
          state.mode = mode
          save()
          draw()
        }
      }
    })
  }

  /** @param {ProjectOverview} data */
  function filterParts(data) {
    const epics = new Map()
    for (const item of data.items) if (item.epic) epics.set(item.epic.id, item.epic)
    const epicOptions = [...epics.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id))
    if (state.epic !== 'any' && state.epic !== 'none' && !epics.has(state.epic)) state.epic = 'any'
    if (state.priority !== 'any' && !data.portfolio.priorities.some((priority) => String(priority.uid) === state.priority)) state.priority = 'any'

    const epicSelect = filterSelect(
      'Epic',
      [
        ['any', 'Epic: any'],
        ['none', 'Epic: none'],
        ...epicOptions.map((epic) => /** @type {[string, string]} */ ([epic.id, `Epic: ${epic.id} ${epic.title}`]))
      ],
      state.epic,
      (value) => {
        state.epic = value
        draw()
      },
      el('span', { class: 'work-noshrink', style: { display: 'flex', color: 'var(--helm-accent)' } }, [lineIcon(ICONS.epic, 11, 2)])
    )
    const prioritySelect = filterSelect(
      'Priority',
      [['any', 'Priority: any'], ...data.portfolio.priorities.map((priority) => /** @type {[string, string]} */ ([String(priority.uid), `Priority: ${priority.name}`]))],
      state.priority,
      (value) => {
        state.priority = value
        draw()
      },
      priorityGlyph({ urgent: false, bars: 3 }, 'Priority')
    )
    const sessionToggle = el(
      'button',
      {
        class: 'pj-chip',
        attrs: { type: 'button', 'aria-pressed': state.sessionOnly ? 'true' : 'false' },
        on: {
          click: () => {
            state.sessionOnly = !state.sessionOnly
            draw()
          }
        }
      },
      [lineIcon(ICONS.session, 11, 2), 'Has a session']
    )
    const filtered = visibleItems(data)
    const all = tasksOf(data).length
    const how = state.mode === 'list' ? 'grouped by status' : 'a column per status'
    const note = filtered.length === all ? how.charAt(0).toUpperCase() + how.slice(1) : `${filtered.length} of ${all} shown, ${how}`
    return [epicSelect, prioritySelect, sessionToggle, el('span', { class: 'work-grow' }), el('span', { class: 'pj-note', text: note })]
  }

  /**
   * A filter drawn as a chip: the native select carries the keyboard and the
   * choice, the chip around it is the look.
   *
   * @param {string} label
   * @param {[string, string][]} options value, text
   * @param {string} value
   * @param {(value: string) => void} onChange
   * @param {Node} icon
   */
  function filterSelect(label, options, value, onChange, icon) {
    const select = el(
      'select',
      { attrs: { 'aria-label': label }, on: { change: () => onChange(select.value) } },
      options.map(([optionValue, text]) => el('option', { text, attrs: { value: optionValue } }))
    )
    select.value = value
    return el('label', { class: value === 'any' ? 'pj-chip pj-select' : 'pj-chip pj-select is-set' }, [icon, select, lineIcon(ICONS.chevronDown, 10, 2)])
  }

  /**
   * The tasks the filters let through. Epics are left out: they are shown
   * across projects on the portfolio page and as each task's epic chip.
   *
   * @param {ProjectOverview} data
   */
  function visibleItems(data) {
    return tasksOf(data).filter((item) => {
      if (state.epic === 'none' && item.epic !== null) return false
      if (state.epic !== 'any' && state.epic !== 'none' && item.epic?.id !== state.epic) return false
      if (state.priority !== 'any' && String(item.priority.uid) !== state.priority) return false
      if (state.sessionOnly && item.session === null) return false
      return true
    })
  }

  // -------------------------------------------------------------------------
  // List

  /** @param {ProjectOverview} data */
  function listParts(data) {
    const items = visibleItems(data)
    const groups = listOrder(data.portfolio.statuses)
      .map((status) => ({ status, rows: items.filter((item) => item.status.uid === status.uid) }))
      .filter(({ status, rows }) => rows.length > 0 || status.isDefault)
    return groups.map(({ status, rows }) => listGroup(data, status, rows))
  }

  /** @param {Status} status */
  function isOpen(status) {
    const chosen = state.folded[String(status.uid)]
    return chosen === undefined ? !FINISHED.has(status.group) : chosen
  }

  /**
   * @param {Status} status
   * @param {boolean} open
   */
  function setOpen(status, open) {
    state.folded[String(status.uid)] = open
    save()
  }

  /**
   * @param {ProjectOverview} data
   * @param {Status} status
   * @param {ItemSummary[]} rows
   */
  function listGroup(data, status, rows) {
    const open = isOpen(status)
    const canAdd = status.group === 'not-started'
    return el('section', { class: 'pj-group', attrs: { 'aria-label': status.name } }, [
      el('div', { class: 'pj-group-head' }, [
        el(
          'button',
          {
            class: 'pj-icon-button',
            attrs: { type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-label': `${open ? 'Hide' : 'Show'} ${status.name}` },
            on: {
              click: () => {
                setOpen(status, !open)
                draw()
              }
            }
          },
          [lineIcon(open ? ICONS.chevronDown : ICONS.chevronRight, 12, 2)]
        ),
        statusIcon(status, 14),
        el('span', { class: 'pj-group-name', text: status.name }),
        el('span', { class: 'counts', text: String(rows.length) }),
        el('span', { class: 'work-grow' }),
        canAdd
          ? el(
              'button',
              {
                class: 'pj-icon-button',
                attrs: { type: 'button', 'aria-label': `Add a task to ${status.name}`, title: `Add a task to ${status.name}` },
                on: { click: () => focusQuickAdd(status) }
              },
              [lineIcon(ICONS.plus, 12, 2)]
            )
          : null
      ]),
      ...(open ? rows.map((item) => listRow(data, item)) : []),
      open && canAdd ? quickAddRow(status, 'pj-quick') : null
    ])
  }

  /**
   * @param {ProjectOverview} data
   * @param {ItemSummary} item
   */
  function listRow(data, item) {
    const priority = data.portfolio.priorities.find((candidate) => candidate.uid === item.priority.uid)
    const mark = priorityMark(priority?.rank ?? 1, data.portfolio.priorities.length)
    return el(
      'button',
      {
        class: state.fresh.has(item.uid) ? 'pj-row is-new' : 'pj-row',
        attrs: { type: 'button' },
        title: `${item.id} ${item.title}`,
        on: { click: () => void openItem(item) }
      },
      [
        statusIcon(item.status, 14),
        el('span', { class: 'work-id pj-row-id', text: item.id }),
        el('span', { class: 'pj-row-title' }, [
          item.kind === 'epic' ? el('span', { class: 'work-kind', text: 'epic' }) : null,
          el('span', { class: 'work-ellip', text: item.title }),
          item.session ? sessionChip(item.session, item.session.activeAt ? age(item.session.activeAt) : '') : null,
          item.waitingOn.length > 0 ? waitsMark(item.waitingOn) : null
        ]),
        el('span', { class: 'pj-row-epic' }, [item.epic ? epicChip(item.epic, true) : null]),
        priorityGlyph(mark, item.priority.name),
        el('span', { class: 'pj-row-age', text: age(item.updatedAt), title: `Updated ${new Date(item.updatedAt).toLocaleString()}` })
      ]
    )
  }

  // -------------------------------------------------------------------------
  // Board

  /** @param {ProjectOverview} data */
  function boardParts(data) {
    const items = visibleItems(data)
    const used = new Set(tasksOf(data).map((item) => item.status.uid))
    const columns = boardColumns(data.portfolio.statuses, used)
    return [
      el(
        'div',
        { class: 'pj-columns' },
        columns.map((status) => {
          const cards = items.filter((item) => item.status.uid === status.uid)
          const adding = state.boardAdding === status.uid
          return el('section', { class: 'pj-column', attrs: { 'aria-label': status.name } }, [
            el('div', { class: 'pj-column-head' }, [
              statusIcon(status, 14),
              el('span', { class: 'pj-group-name work-ellip', text: status.name }),
              el('span', { class: 'counts', text: String(cards.length) }),
              el('span', { class: 'work-grow' }),
              el(
                'button',
                {
                  class: 'pj-icon-button',
                  attrs: { type: 'button', 'aria-label': `Add a task to ${status.name}`, title: `Add a task to ${status.name}`, 'aria-pressed': adding ? 'true' : 'false' },
                  on: {
                    click: () => {
                      state.boardAdding = adding ? null : status.uid
                      draw()
                      if (!adding) quickInput(status).focus()
                    }
                  }
                },
                [lineIcon(ICONS.plus, 12, 2)]
              )
            ]),
            adding ? quickAddRow(status, 'pj-card-add') : null,
            ...cards.map((item) => boardCard(data, item))
          ])
        })
      )
    ]
  }

  /**
   * @param {ProjectOverview} data
   * @param {ItemSummary} item
   */
  function boardCard(data, item) {
    const priority = data.portfolio.priorities.find((candidate) => candidate.uid === item.priority.uid)
    const mark = priorityMark(priority?.rank ?? 1, data.portfolio.priorities.length)
    const hasFoot = item.epic !== null || item.waitingOn.length > 0 || item.session !== null
    return el(
      'button',
      { class: state.fresh.has(item.uid) ? 'pj-card is-new' : 'pj-card', attrs: { type: 'button' }, on: { click: () => void openItem(item) } },
      [
        el('span', { class: 'pj-card-top' }, [
          el('span', { class: 'work-id', text: item.id }),
          item.kind === 'epic' ? el('span', { class: 'work-kind', text: 'epic' }) : null,
          el('span', { class: 'work-grow' }),
          priorityGlyph(mark, item.priority.name)
        ]),
        el('span', { class: 'pj-card-title', text: item.title }),
        hasFoot
          ? el('span', { class: 'pj-card-foot' }, [
              item.epic ? epicChip(item.epic, false) : null,
              item.waitingOn.length > 0 ? waitsMark(item.waitingOn) : null,
              el('span', { class: 'work-grow' }),
              item.session ? sessionTile(item.session) : null
            ])
          : null
      ]
    )
  }

  // -------------------------------------------------------------------------
  // Quick add

  /** @param {Status} status */
  function quickInput(status) {
    let input = quickAdds.get(status.uid)
    if (!input) {
      input = el('input', {
        class: 'pj-quick-input',
        attrs: { type: 'text', maxlength: 300, autocomplete: 'off', spellcheck: 'true' }
      })
      const field = input
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          void quickAdd(status, field)
        } else if (event.key === 'Escape') {
          field.value = ''
          showQuickError(status, null)
          if (state.boardAdding === status.uid) {
            state.boardAdding = null
            draw()
          }
        }
      })
      field.addEventListener('input', () => showQuickError(status, null))
      quickAdds.set(status.uid, field)
    }
    input.setAttribute('aria-label', `Add a task to ${status.name}`)
    return input
  }

  /**
   * @param {Status} status
   * @param {string} className
   */
  function quickAddRow(status, className) {
    let error = quickErrors.get(status.uid)
    if (!error) {
      error = el('span', { class: 'pj-quick-error', attrs: { role: 'alert', hidden: true } })
      quickErrors.set(status.uid, error)
    }
    const input = quickInput(status)
    // A board column has no room for the long form.
    input.placeholder = className === 'pj-card-add' ? 'Title · Enter saves' : `Add a task to ${status.name} · Enter saves`
    return el('label', { class: className }, [lineIcon(ICONS.plus, 14, 1.7), input, error])
  }

  /**
   * @param {Status} status
   * @param {string | null} message
   */
  function showQuickError(status, message) {
    const error = quickErrors.get(status.uid)
    if (!error) return
    error.textContent = message ?? ''
    error.hidden = message === null
  }

  /**
   * @param {Status} status
   * @param {HTMLInputElement} field
   */
  async function quickAdd(status, field) {
    const title = field.value.trim()
    if (title === '' || field.readOnly) return
    field.readOnly = true
    try {
      const item = /** @type {Item} */ (await rpc('createItem', { kind: 'task', project: uid, title, status: status.uid }))
      field.value = ''
      showQuickError(status, null)
      state.fresh.add(item.uid)
      announceChange()
      host.reload()
    } catch (error) {
      showQuickError(status, error instanceof Error ? error.message : String(error))
    } finally {
      field.readOnly = false
    }
  }

  /** The header's Task button: the default status's quick add, in the list. */
  function startTask() {
    const data = state.data
    if (!data) return
    const status = data.portfolio.statuses.find((candidate) => candidate.isDefault) ?? data.portfolio.statuses.find((candidate) => candidate.group === 'not-started')
    if (!status) return
    focusQuickAdd(status)
  }

  /** @param {Status} status */
  function focusQuickAdd(status) {
    if (state.mode !== 'list') {
      state.mode = 'list'
      save()
    }
    if (!isOpen(status)) setOpen(status, true)
    draw()
    const input = quickInput(status)
    input.focus()
    input.scrollIntoView({ block: 'nearest' })
  }

  return {
    async load(isCurrent) {
      const data = /** @type {ProjectOverview} */ (await rpc('projectOverview', uid))
      if (!isCurrent()) return
      state.data = data
      host.setPlace({ portfolio: data.portfolio.uid, project: data.project.uid })
      helm.surface.setTitle(data.project.name)
      draw()
    }
  }
}

/** @param {ProjectOverview} data */
function tasksOf(data) {
  return data.items.filter((item) => item.kind === 'task')
}

/** @param {string} id */
function idNumber(id) {
  return Number(id.slice(id.lastIndexOf('-') + 1))
}

/**
 * @param {string} key
 * @returns {{ mode: Mode, open: Record<string, boolean> }}
 */
function readSaved(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}')
    return {
      mode: raw.mode === 'board' ? 'board' : 'list',
      open: raw.open && typeof raw.open === 'object' ? raw.open : {}
    }
  } catch {
    return { mode: 'list', open: {} }
  }
}
