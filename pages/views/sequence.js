/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * A sequence: the stages a piece of work is done in, first to last, as a
 * grid. Stages run across, each with its goal and how far along it is, the
 * one under way marked; the work runs down, an initiative's by epic and an
 * epic's by project. Under it, the open work in no stage and the waits the
 * order puts the wrong way round.
 *
 * Items are dragged between stages, and out to "Not in a stage". On the
 * sequence's own page its stages are added, renamed, given goals, moved and
 * deleted in place. An epic in an initiative shows its own lane of the
 * initiative's sequence, where its work is dragged between stages too.
 */

import { TRASH } from '../shared/dialog.js'
import { ICONS, el, lineIcon, sessionTile, statusIcon, swatch, tile } from '../shared/dom.js'
import { conflictNotes, dropBefore, listed, sequenceLanes } from '../shared/logic.js'
import { openItem, opens } from '../shared/work.js'
import { YOU, button, iconButton, lineField, textArea } from './edit.js'

/**
 * @typedef {import('../shared/types.js').Plan} Plan
 * @typedef {import('../shared/types.js').Stage} Stage
 * @typedef {import('../shared/types.js').PlanEntry} PlanEntry
 * @typedef {import('../shared/types.js').ItemSummary} ItemSummary
 * @typedef {import('../shared/types.js').Tally} Tally
 * @typedef {import('./edit.js').Editing} Editing
 * @typedef {ReturnType<typeof sequenceLanes<PlanEntry, Plan['epics'][number]>>[number]} Lane
 * @typedef {{ plan: Plan, focus: Plan['epics'][number] | null, editable: boolean, notes: Map<string, string[]> }} Shown
 */

const STATE_WORDS = { empty: 'Empty', 'not-started': 'Not started', active: 'Under way', done: 'Done' }

/**
 * The sequence an initiative or an epic shows. `focus` is an epic in the
 * initiative whose sequence this is: only its lane is drawn, and the stages
 * cannot be edited from there.
 *
 * @param {Editing} editing
 * @param {Plan} plan
 * @param {{ focus?: string | null }} [options]
 */
export function sequenceSection(editing, plan, options = {}) {
  const focusId = options.focus ?? null
  const focus = focusId === null ? null : (plan.epics.find((epic) => epic.id === focusId) ?? null)
  /** @type {Shown} */
  const shown = { plan, focus, editable: focusId === null, notes: conflictNotes(plan.conflicts) }
  const lanes = sequenceLanes(plan, focusId)
  const unplaced = focusId === null ? plan.unplaced : plan.unplaced.filter((item) => item.id === focusId || item.epic?.id === focusId)
  const conflicts =
    focusId === null
      ? plan.conflicts
      : plan.conflicts.filter((conflict) => [conflict.item, conflict.waitsOn].some((id) => lanes[0]?.cells.flat().some((entry) => entry.id === id || entry.rest?.tasks.includes(id)) || unplaced.some((item) => item.id === id)))
  return el('section', { class: focusId === null ? 'sq' : 'sq sq-focus' }, [
    head(shown, lanes),
    plan.stages.length === 0 ? emptyState(editing, shown) : grid(editing, shown, lanes),
    // With nothing left out, "Not in a stage" shows only while something is
    // dragged, as the place to take it out of its stage.
    unplaced.length > 0 || conflicts.length > 0 || plan.stages.length > 0
      ? el('div', { class: unplaced.length === 0 && conflicts.length === 0 ? 'sq-trays is-idle' : 'sq-trays' }, [
          unplaced.length > 0 || plan.stages.length > 0 ? unplacedTray(editing, unplaced, shown) : null,
          conflicts.length > 0 ? conflictTray(conflicts, plan) : null
        ])
      : null
  ])
}

// ---------------------------------------------------------------------------
// Head

/**
 * @param {Shown} shown
 * @param {Lane[]} lanes
 */
function head(shown, lanes) {
  const { plan, focus } = shown
  /** @type {(Node | string | null)[]} */
  const facts = []
  if (focus !== null || shown.editable === false) {
    const holding = plan.stages.filter((stage) => lanes[0]?.cells[stage.n - 1].length > 0).map((stage) => String(stage.n))
    facts.push(
      el('span', {}, [
        'Its lane of ',
        el('button', { class: 'sq-owner', title: `Open ${plan.owner.id} ${plan.owner.title}`, attrs: { type: 'button' }, on: opens((how) => openItem(plan.owner, how)) }, [
          el('span', { class: 'sq-mono', text: plan.owner.id })
        ]),
        holding.length === 0 ? '’s stages: none holds its work yet' : `’s ${plan.stages.length} stages: ${listed(holding)} ${holding.length === 1 ? 'holds' : 'hold'} its work`
      ])
    )
  } else if (plan.stages.length > 0) {
    facts.push(el('span', { text: `${plan.stages.length} ${plan.stages.length === 1 ? 'stage' : 'stages'}` }))
    facts.push(el('span', { text: standing(plan) }))
    facts.push(el('span', { text: `${plan.progress.done} of ${plan.progress.total} ${plan.progress.total === 1 ? 'task' : 'tasks'} done` }))
  }
  return el('div', { class: 'sq-head' }, [
    lineIcon(ICONS.stages, 15, 1.8),
    el('h2', { class: 'it-h2', text: 'Sequence' }),
    el('span', { class: 'sq-facts' }, facts.flatMap((fact, index) => (index === 0 ? [fact] : [el('span', { class: 'sq-dot', text: '·' }), fact]))),
    el('span', { class: 'it-grow' }),
    plan.stages.length > 0 && focus === null ? legend(shown.notes.size > 0) : null
  ])
}

/**
 * Where a sequence stands, in a few words.
 *
 * @param {Plan} plan
 */
function standing(plan) {
  const current = plan.stages.find((stage) => stage.n === plan.current)
  if (current) return `stage ${current.n} under way`
  if (plan.stages.every((stage) => stage.state === 'empty')) return 'nothing in a stage yet'
  return 'every stage done'
}

/** @param {boolean} conflicts whether anything is out of order */
function legend(conflicts) {
  return el('span', { class: 'sq-legend' }, [
    el('span', {}, [stageMark('done', 0, 10), 'done']),
    el('span', {}, [stageMark('active', 0, 10), 'under way']),
    el('span', {}, [stageMark('not-started', 0, 10), 'not started']),
    conflicts ? el('span', { class: 'tone-warn' }, [lineIcon(ICONS.alert, 11, 2), 'out of order']) : null
  ])
}

// ---------------------------------------------------------------------------
// The grid

/**
 * @param {Editing} editing
 * @param {Shown} shown
 * @param {Lane[]} lanes
 */
function grid(editing, shown, lanes) {
  const { plan } = shown
  const laneHeads = shown.focus === null && (plan.owner.kind === 'initiative' || lanes.length > 1)
  const adding = shown.editable && editing.isOpen('stage.new')
  const columns = [laneHeads ? 'var(--sq-lane)' : '', `repeat(${plan.stages.length}, minmax(var(--sq-stage), 1fr))`, shown.editable ? (adding ? 'var(--sq-stage)' : 'var(--sq-add)') : '']
  /** @type {(Node | null)[]} */
  const cells = [laneHeads ? el('div', { class: 'sq-corner' }, [el('span', { class: 'work-cap', text: plan.owner.kind === 'initiative' ? 'Epic' : 'Project' })]) : null]
  for (const stage of plan.stages) cells.push(stageHead(editing, shown, stage))
  if (shown.editable) cells.push(adding ? addStageForm(editing, shown) : addStageButton(editing))
  for (const lane of lanes) {
    if (laneHeads) cells.push(laneHead(lane))
    lane.cells.forEach((entries, index) => cells.push(stageCell(editing, shown, plan.stages[index], lane, entries)))
    if (shown.editable) cells.push(el('div', { class: 'sq-cell sq-cell-pad' }))
  }
  if (lanes.length === 0) {
    // Stages with nothing in them yet: one empty row to drop work into.
    if (laneHeads) cells.push(el('div', { class: 'sq-lane-head sq-lane-none' }, [el('span', { class: 'it-hint', text: 'Nothing placed yet' })]))
    for (const stage of plan.stages) cells.push(stageCell(editing, shown, stage, null, []))
    if (shown.editable) cells.push(el('div', { class: 'sq-cell sq-cell-pad' }))
  }
  // The scroll box draws the outer edge, so the last column and row draw none.
  const drawn = /** @type {HTMLElement[]} */ (cells.filter((cell) => cell !== null))
  const width = columns.filter(Boolean).length - 1 + plan.stages.length
  const rows = Math.ceil(drawn.length / width)
  drawn.forEach((cell, index) => {
    if (index % width === width - 1) cell.classList.add('is-last-col')
    if (Math.floor(index / width) === rows - 1) cell.classList.add('is-last-row')
  })
  const body = el('div', { class: 'sq-grid', style: { 'grid-template-columns': columns.filter(Boolean).join(' ') } }, drawn)
  wireDrops(editing, body)
  const key = `${plan.owner.uid} ${shown.focus?.uid ?? ''}`
  const scroll = el('div', { class: 'sq-scroll', on: { scroll: () => scrolled.set(key, scroll.scrollLeft) } }, [body])
  // The page draws the grid anew on every change: once it is in the page,
  // it goes back to where it was scrolled to, or to the new stage's form.
  queueMicrotask(() => {
    if (!scroll.isConnected) return
    scroll.scrollLeft = adding ? scroll.scrollWidth : (scrolled.get(key) ?? 0)
  })
  return scroll
}

/** How far each grid was scrolled sideways, by its owner and focus. */
const scrolled = /** @type {Map<string, number>} */ (new Map())

/**
 * A stage's number in a circle: a check when it is done.
 *
 * @param {import('../shared/types.js').StageState} state
 * @param {number} n
 * @param {number} [size]
 */
function stageMark(state, n, size = 18) {
  return el('span', { class: `sq-mark is-${state}`, style: { width: `${size}px`, height: `${size}px` } }, [
    state === 'done' ? lineIcon('M5 12.5l4.5 4.5L19 7.5', Math.round(size * 0.62), 3) : n > 0 ? String(n) : null
  ])
}

/**
 * @param {Tally} tally
 * @param {import('../shared/types.js').StageState} state
 */
function bar(tally, state) {
  const pct = tally.total === 0 ? 0 : Math.round((tally.done / tally.total) * 100)
  const active = tally.total === 0 ? 0 : Math.round((tally.active / tally.total) * 100)
  return el('span', { class: 'sq-bar' }, [
    el('span', { class: state === 'done' ? 'sq-bar-done is-complete' : 'sq-bar-done', style: { width: `${pct}%` } }),
    active > 0 ? el('span', { class: 'sq-bar-active', style: { width: `${active}%` } }) : null
  ])
}

/**
 * @param {Editing} editing
 * @param {Shown} shown
 * @param {Stage} stage
 */
function stageHead(editing, shown, stage) {
  const current = shown.plan.current === stage.n
  const key = `stage.${stage.uid}`
  const classes = ['sq-stage', `is-${stage.state}`, current ? 'is-current' : ''].filter(Boolean).join(' ')
  if (shown.editable && editing.isOpen(key)) return stageEditor(editing, shown, stage, classes)
  const titleText = el('span', { class: 'sq-stage-name', text: stage.title })
  return el('div', { class: classes, attrs: { 'data-stage': stage.n, 'data-stage-uid': stage.uid } }, [
    el('div', { class: 'sq-stage-line' }, [
      stageMark(stage.state, stage.n),
      shown.editable
        ? el(
            'button',
            {
              class: 'sq-stage-title',
              title: `${stage.title}\nRename, give it a goal, move or delete it`,
              attrs: { type: 'button', 'data-focus': `stage.${stage.uid}.open` },
              on: { click: () => editing.start(key, `${key}.title`) }
            },
            [titleText]
          )
        : el('span', { class: 'sq-stage-title', title: stage.title }, [titleText]),
      current ? el('span', { class: 'sq-now', text: 'Now' }) : null
    ]),
    stage.goal ? el('p', { class: 'sq-goal', title: stage.goal, text: stage.goal }) : el('p', { class: 'sq-goal is-none', text: shown.editable ? 'No goal yet' : '' }),
    el('div', { class: 'sq-stage-progress', title: `${STATE_WORDS[stage.state]}: ${stage.done} of ${stage.total} done${stage.active > 0 ? `, ${stage.active} in progress` : ''}` }, [
      bar(stage, stage.state),
      el('span', { class: 'sq-count', text: stage.state === 'empty' ? 'empty' : `${stage.done}/${stage.total}` })
    ])
  ])
}

/**
 * A stage's title and goal edited where they are, with the moves and the
 * delete beside Save.
 *
 * @param {Editing} editing
 * @param {Shown} shown
 * @param {Stage} stage
 * @param {string} classes
 */
function stageEditor(editing, shown, stage, classes) {
  const key = `stage.${stage.uid}`
  const count = shown.plan.stages.length
  const close = () => editing.close(key)
  const save = async () => {
    const title = editing.field(`${key}.title`, () => el('input')).value.trim()
    const goal = editing.field(`${key}.goal`, () => el('textarea')).value.trim()
    if (title === '') return
    if (title === stage.title && goal === stage.goal) {
      close()
      return
    }
    if ((await editing.call('updateStage', stage.uid, { title, goal }, YOU)) !== undefined) close()
  }
  const move = (/** @type {number} */ to) => void editing.call('moveStage', stage.uid, to, YOU)
  const remove = async () => {
    const held = stage.items.length
    const ran = await editing.confirmCall(
      {
        title: `Delete stage ${stage.n}`,
        lines: [
          el('p', { class: 'work-dialog-text' }, [el('strong', { text: stage.title })]),
          held === 0 ? 'Nothing is in it.' : `${held === 1 ? 'The item in it stays' : `The ${held} items in it stay`}, in no stage.`,
          'The stages after it move up one.'
        ],
        confirm: 'Delete stage'
      },
      'deleteStage',
      stage.uid,
      YOU
    )
    if (ran) close()
  }
  return el('div', { class: `${classes} is-editing`, attrs: { 'data-stage': stage.n, 'data-stage-uid': stage.uid } }, [
    lineField(editing, `${key}.title`, { value: stage.title, label: `Stage ${stage.n} title`, placeholder: 'What this stage is', className: 'helm-input sq-input', onEnter: () => void save(), onEscape: close }),
    textArea(editing, `${key}.goal`, { value: stage.goal, label: `Stage ${stage.n} goal`, placeholder: 'Goal: what is true when it is done', rows: 2, onSave: () => void save(), onCancel: close }),
    el('div', { class: 'sq-stage-tools' }, [
      iconButton('Move it earlier', ICONS.chevronLeft, () => move(stage.n - 1), stage.n === 1 ? 'is-off' : ''),
      iconButton('Move it later', ICONS.chevronRight, () => move(stage.n + 1), stage.n === count ? 'is-off' : ''),
      iconButton('Delete this stage', TRASH, () => void remove(), 'sq-delete'),
      el('span', { class: 'it-grow' }),
      button('Save', null, () => void save(), 'primary'),
      button('Cancel', null, close, 'ghost')
    ])
  ])
}

/** @param {Editing} editing */
function addStageButton(editing) {
  return el(
    'button',
    { class: 'sq-add', title: 'Add a stage', attrs: { type: 'button', 'aria-label': 'Add a stage' }, on: { click: () => editing.start('stage.new', 'stage.new.title') } },
    [lineIcon(ICONS.plus, 14, 1.8)]
  )
}

/**
 * The new stage's title and goal. It stays open after each one, for the
 * next.
 *
 * @param {Editing} editing
 * @param {Shown} shown
 */
function addStageForm(editing, shown) {
  const close = () => editing.close('stage.new')
  const save = async () => {
    const title = editing.field('stage.new.title', () => el('input'))
    const goal = editing.field('stage.new.goal', () => el('textarea'))
    if (title.value.trim() === '') return
    const made = await editing.call('addStage', shown.plan.owner.uid, { title: title.value.trim(), goal: goal.value.trim() }, YOU)
    if (made === undefined) return
    title.value = ''
    goal.value = ''
    title.focus()
  }
  return el('div', { class: 'sq-stage is-editing is-new' }, [
    el('div', { class: 'sq-stage-line' }, [stageMark('empty', shown.plan.stages.length + 1), el('span', { class: 'sq-stage-new', text: 'New stage' })]),
    lineField(editing, 'stage.new.title', { label: 'New stage title', placeholder: 'What this stage is · Enter adds', className: 'helm-input sq-input', onEnter: () => void save(), onEscape: close }),
    textArea(editing, 'stage.new.goal', { value: '', label: 'New stage goal', placeholder: 'Goal: what is true when it is done', rows: 2, onSave: () => void save(), onCancel: close }),
    el('div', { class: 'sq-stage-tools' }, [el('span', { class: 'it-grow' }), button('Add', null, () => void save(), 'primary'), button('Close', null, close, 'ghost')])
  ])
}

/** @param {Lane} lane */
function laneHead(lane) {
  if (lane.epic) {
    const epic = lane.epic
    return el(
      'button',
      { class: 'sq-lane-head', title: `${epic.id} ${epic.title} · ${epic.status.name}\n${epic.progress.done} of ${epic.progress.total} tasks done`, attrs: { type: 'button' }, on: opens((how) => openItem(epic, how)) },
      [
        el('span', { class: 'sq-lane-top' }, [statusIcon(epic.status, 13), el('span', { class: 'sq-mono', text: epic.id }), el('span', { class: 'it-grow' }), swatch(epic.project.colour, 7)]),
        el('span', { class: 'sq-lane-title', text: epic.title }),
        el('span', { class: 'sq-lane-foot' }, [
          bar(epic.progress, epic.progress.total > 0 && epic.progress.done === epic.progress.total ? 'done' : 'active'),
          el('span', { class: 'sq-count', text: epic.progress.total === 0 ? 'no tasks' : `${epic.progress.done}/${epic.progress.total}` })
        ])
      ]
    )
  }
  const project = lane.project
  if (project === null) return el('div', { class: 'sq-lane-head' })
  return el('div', { class: 'sq-lane-head sq-lane-project' }, [
    el('span', { class: 'sq-lane-top' }, [tile(project.name.charAt(0).toUpperCase(), 20, project.colour), el('span', { class: 'sq-lane-title', text: project.name })])
  ])
}

/**
 * @param {Editing} editing
 * @param {Shown} shown
 * @param {Stage} stage
 * @param {Lane | null} lane
 * @param {PlanEntry[]} entries
 */
function stageCell(editing, shown, stage, lane, entries) {
  const current = shown.plan.current === stage.n
  return el(
    'div',
    {
      class: ['sq-cell', current ? 'is-current' : '', stage.state === 'done' ? 'is-done' : ''].filter(Boolean).join(' '),
      attrs: { 'data-stage': stage.n, 'data-stage-uid': stage.uid, 'data-lane': lane?.key ?? '' }
    },
    entries.map((entry) => (entry.kind === 'epic' ? epicBlock(entry, shown) : itemChip(entry, shown, lane?.key ?? '')))
  )
}

/**
 * A task in a stage: its status, ID and title, a mark when the order puts
 * it before something it waits on, and the session on it.
 *
 * @param {PlanEntry | ItemSummary} item
 * @param {Shown} shown
 * @param {string} lane
 * @param {boolean} [compact] one line, for the tray
 */
function itemChip(item, shown, lane, compact = false) {
  const notes = shown.notes.get(item.id) ?? []
  const finished = item.status.group === 'done' || item.status.group === 'closed'
  const title = [`${item.id} ${item.title}`, `${item.status.name}${item.epic && shown.plan.owner.kind === 'initiative' ? ` · epic ${item.epic.id}` : ''}`, ...notes.map((note) => `Out of order: ${note}`), 'Drag it to another stage']
  return el(
    'button',
    {
      class: ['sq-item', compact ? 'is-compact' : '', finished ? 'is-finished' : '', notes.length > 0 ? 'is-conflict' : ''].filter(Boolean).join(' '),
      title: title.join('\n'),
      attrs: { type: 'button', draggable: 'true', 'data-uid': item.uid, 'data-lane': lane },
      on: opens((how) => openItem(item, how))
    },
    [
      el('span', { class: 'sq-item-top' }, [
        statusIcon(item.status, 12),
        el('span', { class: 'sq-mono', text: item.id }),
        compact ? el('span', { class: 'sq-item-title work-ellip', text: item.title }) : el('span', { class: 'it-grow' }),
        notes.length > 0 ? el('span', { class: 'sq-warn-mark' }, [lineIcon(ICONS.alert, 11, 2)]) : null,
        item.session ? sessionTile(item.session) : null
      ]),
      compact ? null : el('span', { class: 'sq-item-title', text: item.title })
    ]
  )
}

/**
 * An epic in a stage: its tasks that are not in a stage of their own, and
 * how many of them are done.
 *
 * @param {PlanEntry} entry
 * @param {Shown} shown
 */
function epicBlock(entry, shown) {
  const rest = entry.rest ?? { done: 0, active: 0, total: 0, tasks: [] }
  const placedAlone = shown.plan.stages.some((stage) => stage.items.some((other) => other.epic?.id === entry.id))
  const lane = shown.plan.owner.kind === 'initiative' ? `epic ${entry.id}` : ''
  const subject = shown.focus !== null ? 'this epic' : entry.id
  const words = rest.tasks.length === 0 ? (placedAlone ? `Every task of ${subject} is in its own stage` : `All of ${subject}, no tasks yet`) : `${placedAlone ? 'The rest of' : 'All of'} ${subject}`
  const state = rest.total > 0 && rest.done === rest.total ? 'done' : 'active'
  return el(
    'button',
    {
      class: 'sq-epic',
      title: `${entry.id} ${entry.title} · ${entry.status.name}\n${words}: ${rest.tasks.length} ${rest.tasks.length === 1 ? 'task' : 'tasks'}, ${rest.done} done${rest.tasks.length > 0 ? `\n${rest.tasks.join(', ')}` : ''}\nDrag it to another stage`,
      attrs: { type: 'button', draggable: 'true', 'data-uid': entry.uid, 'data-lane': lane },
      on: opens((how) => openItem(entry, how))
    },
    [
      el('span', { class: 'sq-epic-top' }, [lineIcon(ICONS.epic, 12, 2), el('span', { class: 'work-ellip', text: words })]),
      rest.tasks.length > 0
        ? el('span', { class: 'sq-epic-foot' }, [bar(rest, state), el('span', { class: 'sq-count', text: `${rest.done}/${rest.total}` })])
        : null
    ]
  )
}

// ---------------------------------------------------------------------------
// Under the grid

/**
 * The open work in no stage. Its chips are dragged into a stage; dropping a
 * placed one here takes it out of its stage.
 *
 * @param {Editing} editing
 * @param {ItemSummary[]} items
 * @param {Shown} shown
 */
function unplacedTray(editing, items, shown) {
  const tray = el('div', { class: items.length === 0 ? 'sq-tray is-idle' : 'sq-tray', attrs: { 'data-out': 'true' } }, [
    el('div', { class: 'sq-tray-head' }, [
      el('h3', { class: 'sq-tray-title', text: 'Not in a stage' }),
      items.length > 0 ? el('span', { class: 'sq-tray-count', text: String(items.length) }) : null,
      el('span', {
        class: 'it-hint',
        text: items.length === 0 ? 'Drop it here to take it out of its stage.' : shown.plan.stages.length === 0 ? 'Add a stage, then drag work into it.' : 'Drag one into a stage.'
      })
    ]),
    el(
      'div',
      { class: 'sq-tray-items' },
      items.map((item) => (item.kind === 'epic' ? itemChip({ ...item }, shown, `epic ${item.id}`, true) : itemChip(item, shown, item.epic ? `epic ${item.epic.id}` : '', true)))
    )
  ])
  wireDrops(editing, tray)
  return tray
}

/**
 * @param {import('../shared/types.js').Conflict[]} conflicts
 * @param {Plan} plan
 */
function conflictTray(conflicts, plan) {
  const ids = new Map([...plan.stages.flatMap((stage) => stage.items), ...plan.epics, ...plan.unplaced].map((item) => [item.id, item]))
  const link = (/** @type {string} */ id) => {
    const item = ids.get(id)
    return item
      ? el('button', { class: 'sq-link sq-mono', text: id, title: `${item.id} ${item.title}`, attrs: { type: 'button' }, on: opens((how) => openItem(item, how)) })
      : el('span', { class: 'sq-mono', text: id })
  }
  return el('div', { class: 'sq-tray sq-tray-warn' }, [
    el('div', { class: 'sq-tray-head' }, [
      el('span', { class: 'tone-warn sq-tray-icon' }, [lineIcon(ICONS.alert, 13, 2)]),
      el('h3', { class: 'sq-tray-title', text: 'Out of order' }),
      el('span', { class: 'sq-tray-count', text: String(conflicts.length) }),
      el('span', { class: 'it-hint', text: 'Each waits on work in a later stage.' })
    ]),
    el(
      'ul',
      { class: 'sq-conflicts' },
      conflicts.map((conflict) =>
        el('li', {}, [link(conflict.item), el('span', { text: ` in stage ${conflict.stage} waits on ` }), link(conflict.waitsOn), el('span', { text: ` in stage ${conflict.waitsOnStage}` })])
      )
    )
  ])
}

/**
 * No stages yet: what a sequence is, and the first stage.
 *
 * @param {Editing} editing
 * @param {Shown} shown
 */
function emptyState(editing, shown) {
  const what = shown.plan.owner.kind === 'initiative' ? 'its epics and their tasks' : 'its tasks'
  if (editing.isOpen('stage.new')) {
    return el('div', { class: 'sq-empty is-adding' }, [addStageForm(editing, shown)])
  }
  return el('div', { class: 'sq-empty' }, [
    el('p', { class: 'sq-empty-text' }, [
      `No stages yet. A sequence lays out the order this work is done in: each stage a step with a goal, holding ${what} done in it. Agents write one with `,
      el('span', { class: 'sq-mono', text: 'update stages' }),
      '.'
    ]),
    button('Add a stage', ICONS.plus, () => editing.start('stage.new', 'stage.new.title'))
  ])
}

// ---------------------------------------------------------------------------
// Drag and drop

/** The item being dragged, from this page: its uid and its lane. */
let dragging = /** @type {{ uid: number, lane: string } | null} */ (null)

/**
 * Drags from the chips in `root` and drops on its stage cells and heads, or
 * on "Not in a stage". While one is over a stage its whole column lights up;
 * over its own lane's cell, a line shows where it goes.
 *
 * @param {Editing} editing
 * @param {HTMLElement} root
 */
function wireDrops(editing, root) {
  const clear = () => {
    for (const node of document.querySelectorAll('.is-drop, .is-drop-before, .is-drop-end, .is-dragging')) node.classList.remove('is-drop', 'is-drop-before', 'is-drop-end', 'is-dragging')
  }
  root.addEventListener('dragstart', (event) => {
    const chip = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest?.('[data-uid]'))
    if (chip === null || event.dataTransfer === null) return
    dragging = { uid: Number(chip.dataset.uid), lane: chip.dataset.lane ?? '' }
    document.documentElement.classList.add('sq-dragging')
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', chip.querySelector('.sq-mono')?.textContent ?? '')
    requestAnimationFrame(() => chip.classList.add('is-dragging'))
  })
  root.addEventListener('dragend', () => {
    dragging = null
    document.documentElement.classList.remove('sq-dragging')
    clear()
  })
  root.addEventListener('dragover', (event) => {
    if (dragging === null) return
    const target = /** @type {HTMLElement} */ (event.target)
    const out = target.closest?.('[data-out]')
    const stage = /** @type {HTMLElement | null} */ (target.closest?.('[data-stage-uid]'))
    if (out === null && stage === null) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    clear()
    document.querySelector(`[data-uid="${dragging.uid}"]`)?.classList.add('is-dragging')
    if (out !== null) {
      out.classList.add('is-drop')
      return
    }
    if (stage === null) return
    for (const node of root.querySelectorAll(`[data-stage-uid="${stage.dataset.stageUid}"]`)) node.classList.add('is-drop')
    if (stage.classList.contains('sq-cell') && stage.dataset.lane === dragging.lane) {
      const before = beforeIn(stage, event.clientY)
      if (before === null) stage.classList.add('is-drop-end')
      else stage.querySelector(`[data-uid="${before}"]`)?.classList.add('is-drop-before')
    }
  })
  root.addEventListener('dragleave', (event) => {
    const related = /** @type {Node | null} */ (event.relatedTarget)
    if (related === null || !root.contains(related)) clear()
  })
  root.addEventListener('drop', (event) => {
    if (dragging === null) return
    const target = /** @type {HTMLElement} */ (event.target)
    const out = target.closest?.('[data-out]')
    const stage = /** @type {HTMLElement | null} */ (target.closest?.('[data-stage-uid]'))
    if (out === null && stage === null) return
    event.preventDefault()
    const moved = dragging
    dragging = null
    document.documentElement.classList.remove('sq-dragging')
    clear()
    if (out !== null) {
      void editing.call('placeItem', moved.uid, null, null, YOU)
      return
    }
    if (stage === null) return
    const before = stage.classList.contains('sq-cell') && stage.dataset.lane === moved.lane ? beforeIn(stage, event.clientY) : null
    void editing.call('placeItem', moved.uid, Number(stage.dataset.stageUid), before, YOU)
  })
}

/**
 * The uid of the chip in a cell that a drop at `y` goes before, or null for
 * last.
 *
 * @param {HTMLElement} cell
 * @param {number} y
 */
function beforeIn(cell, y) {
  const chips = [...cell.querySelectorAll('[data-uid]')].map((chip) => {
    const box = chip.getBoundingClientRect()
    return { uid: Number(/** @type {HTMLElement} */ (chip).dataset.uid), top: box.top, height: box.height }
  })
  return dropBefore(chips, y, dragging?.uid ?? -1)
}

// ---------------------------------------------------------------------------
// The sequence card beside an epic outside an initiative, before it has
// stages: what a sequence is, and the first stage.

/**
 * @param {Editing} editing
 */
export function sequencePrompt(editing) {
  return el('div', { class: 'it-card sq-prompt' }, [
    el('h2', { class: 'it-h2 it-card-title', text: 'Sequence' }),
    el('p', { class: 'it-hint sq-prompt-text', text: 'Lay out the order its tasks are done in: stages, each with a goal.' }),
    el('button', { class: 'it-add-row', attrs: { type: 'button' }, on: { click: () => editing.start('stage.new', 'stage.new.title') } }, [lineIcon(ICONS.plus, 12, 1.8), 'Add a stage'])
  ])
}

/**
 * A stage's colour, for the portfolio's strip of an initiative's stages.
 *
 * @param {import('../shared/types.js').StageState} state
 */
export function stageColour(state) {
  return state === 'done' ? 'var(--helm-success)' : state === 'active' ? 'var(--helm-accent)' : 'var(--helm-border-strong)'
}

export { stageMark, bar as stageBar }
