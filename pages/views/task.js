/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * A task: chips under the title, the description, acceptance criteria, where
 * it stands with the log under it, and beside them its fields, dependencies,
 * references, links and the button that starts a session on it. The v2 board's task
 * page; everything on it is edited in place.
 */

import { ICONS, el, lineIcon, svg, swatch, toast } from '../shared/dom.js'
import { sessionFolder, sessionPrompt, timeLabel } from '../shared/logic.js'
import { markSession } from '../shared/sessions.js'
import { openItem, openPortfolio, openProject, rpc } from '../shared/work.js'
import {
  YOU,
  button,
  chip,
  descriptionSection,
  editorActions,
  iconButton,
  inlineText,
  lineField,
  linksCard,
  otherItem,
  priorityChip,
  propertiesCard,
  richText,
  sectionHead,
  stamp,
  statusChip,
  textArea,
  titleBlock
} from './edit.js'
import { referencesCard } from './references.js'

/**
 * @typedef {import('../shared/types.js').ItemOverview} ItemOverview
 * @typedef {import('../shared/types.js').Item} Item
 * @typedef {import('../shared/types.js').ItemSummary} ItemSummary
 * @typedef {import('../shared/types.js').FindResult} FindResult
 * @typedef {import('./edit.js').Editing} Editing
 * @typedef {{ found: ItemSummary[] | null, findSeq: number, findTimer: ReturnType<typeof setTimeout> | undefined, logAll: boolean }} TaskState
 */

const LOG_SHOWN = 8
const FIND_LIMIT = 8
const FIND_DELAY_MS = 150

/** @returns {TaskState} */
export function taskState() {
  return { found: null, findSeq: 0, findTimer: undefined, logAll: false }
}

/**
 * @param {ItemOverview} data
 * @param {Editing} editing
 * @param {TaskState} state
 * @param {() => void} redraw
 */
export function taskParts(data, editing, state, redraw) {
  return [
    head(data, editing),
    el('div', { class: 'it-body' }, [
      el('div', { class: 'it-main' }, [descriptionSection(editing, data.item), criteriaSection(data.item, editing), trackingSection(data.item, editing, state, redraw)]),
      el('aside', { class: 'it-aside' }, [
        propertiesCard(editing, data),
        dependenciesCard(data, editing, state, redraw),
        referencesCard(editing, { level: 'task', uid: data.item.uid, refs: data.item.refs, inherited: data.inherited, missing: data.missing }),
        linksCard(editing, data.item),
        promptBlock(data),
        el('span', { class: 'it-grow' }),
        stamp(editing, data.item)
      ])
    ])
  ]
}

// ---------------------------------------------------------------------------
// Header

/**
 * @param {ItemOverview} data
 * @param {Editing} editing
 */
function head(data, editing) {
  const { item, portfolio } = data
  const epic = item.epic ? data.epics.find((candidate) => candidate.id === item.epic?.id) ?? null : null
  const goEpic = epic ? () => void openItem(epic) : null
  const goProject = () => void openProject(item.project)
  return el('header', { class: 'it-head' }, [
    el('div', { class: 'it-head-main' }, [
      el('nav', { class: 'it-crumbs', attrs: { 'aria-label': 'Where this is' } }, [
        crumb(portfolio.name, () => void openPortfolio(portfolio)),
        sep(),
        crumb(item.project.name, goProject),
        item.epic && goEpic ? sep() : null,
        item.epic && goEpic ? crumb(item.epic.id, goEpic, true) : null,
        sep(),
        el('span', { class: 'it-mono it-crumb-here', text: item.id })
      ]),
      titleBlock(editing, item),
      el('div', { class: 'it-chips' }, [
        statusChip(data),
        priorityChip(data),
        chip([swatch(item.project.colour, 8), item.project.name], { onClick: goProject, title: 'Open the project' }),
        item.epic
          ? chip(
              [
                lineIcon(ICONS.epic, 11, 2),
                // One run of text, so the ID and the title share a baseline.
                el('span', { class: 'work-ellip' }, [el('span', { class: 'it-mono it-chip-id', text: item.epic.id }), ' ', item.epic.title])
              ],
              { onClick: goEpic ?? undefined, title: 'Open the epic', extraClass: 'it-chip-epic' }
            )
          : null,
        item.session ? sessionHolder(item, editing) : null
      ])
    ]),
    button('Copy ID', ICONS.copy, () => void editing.copy(item.id, item.id))
  ])
}

/**
 * The session on the task, what it is doing now by Helm's session list, and
 * a way to let it go.
 *
 * @param {Item} item
 * @param {Editing} editing
 */
function sessionHolder(item, editing) {
  const session = /** @type {NonNullable<Item['session']>} */ (item.session)
  const when = session.activeAt ? timeLabel(session.activeAt) : ''
  const holder = el('span', { class: 'it-chip it-chip-session' }, [
    lineIcon(ICONS.session, 11, 2.2),
    el('span', { class: 'work-ellip' }, [session.name, el('span', { attrs: { 'data-session-state': true } })]),
    el(
      'button',
      {
        class: 'it-chip-x',
        title: 'Forget this session',
        attrs: { type: 'button', 'aria-label': 'Forget this session' },
        on: { click: () => void editing.call('release', item.uid) }
      },
      [lineIcon(ICONS.close, 10, 2.2)]
    )
  ])
  return markSession(holder, session, when)
}

/**
 * @param {string} text
 * @param {() => void} onClick
 * @param {boolean} [mono]
 */
function crumb(text, onClick, mono = false) {
  return el('button', { class: mono ? 'crumb it-mono' : 'crumb', text, attrs: { type: 'button' }, on: { click: onClick } })
}

function sep() {
  return el('span', { class: 'crumb-sep', text: '›' })
}

// ---------------------------------------------------------------------------
// Acceptance criteria

/**
 * @param {Item} item
 * @param {Editing} editing
 */
function criteriaSection(item, editing) {
  const list = item.criteriaList
  const done = list.filter((criterion) => criterion.done).length
  const adder = lineField(editing, 'criterion.new', {
    label: 'Add a criterion',
    placeholder: 'Add a criterion · Enter saves',
    className: 'it-bare-input',
    onEnter: () => void addCriterion(item, editing)
  })
  return el('section', { class: 'it-section' }, [
    sectionHead('Acceptance criteria', list.length > 0 ? [ring(done, list.length), el('span', { class: 'it-count', text: `${done} of ${list.length}` })] : []),
    el('div', { class: 'it-box' }, [
      ...list.map((criterion) => criterionRow(item, criterion, editing)),
      el('label', { class: 'it-crit it-crit-add' }, [el('span', { class: 'it-crit-plus' }, [lineIcon(ICONS.plus, 14, 1.7)]), adder])
    ])
  ])
}

/**
 * @param {Item} item
 * @param {Editing} editing
 */
async function addCriterion(item, editing) {
  const field = editing.field('criterion.new', () => el('input'))
  const text = field.value.trim()
  if (text === '') return
  if ((await editing.call('addCriteria', item.uid, [text])) !== undefined) field.value = ''
}

/**
 * @param {Item} item
 * @param {import('../shared/types.js').Criterion} criterion
 * @param {Editing} editing
 */
function criterionRow(item, criterion, editing) {
  const key = `criterion.${criterion.n}`
  const check = el(
    'button',
    {
      class: 'it-check',
      title: criterion.done ? 'Uncheck' : 'Check',
      attrs: { type: 'button', role: 'checkbox', 'aria-checked': criterion.done ? 'true' : 'false', 'aria-label': criterion.text },
      on: { click: () => void editing.call('setCriteriaDone', item.uid, [criterion.n], !criterion.done) }
    },
    [criterion.done ? lineIcon('M5 12.5l4.5 4.5L19 7.5', 11, 3.2) : null]
  )
  if (editing.isOpen(key)) {
    const save = async () => {
      const field = editing.field(key, () => el('input'))
      const text = field.value.trim()
      if (text === '' || text === criterion.text) {
        editing.close(key)
        return
      }
      if ((await editing.call('editCriterion', item.uid, criterion.n, text)) !== undefined) editing.close(key)
    }
    const field = lineField(editing, key, {
      value: criterion.text,
      label: `Criterion ${criterion.n}`,
      className: 'it-bare-input',
      onEnter: () => void save(),
      onEscape: () => editing.close(key)
    })
    return el('div', { class: 'it-crit is-editing' }, [check, field, el('span', { class: 'it-hint', text: 'Enter saves · Esc cancels' })])
  }
  return el('div', { class: criterion.done ? 'it-crit is-done' : 'it-crit' }, [
    check,
    el('button', { class: 'it-crit-text', title: 'Edit', attrs: { type: 'button' }, on: { click: () => editing.start(key) } }, [inlineText('span', criterion.text, '')]),
    iconButton('Remove this criterion', ICONS.close, () => void editing.call('removeCriterion', item.uid, criterion.n), 'it-remove')
  ])
}

/**
 * How many criteria are met, as a ring.
 *
 * @param {number} done
 * @param {number} total
 */
function ring(done, total) {
  const circumference = 2 * Math.PI * 7
  const length = total === 0 ? 0 : (done / total) * circumference
  return svg('svg', { viewBox: '0 0 20 20', width: 16, height: 16, class: 'it-ring', 'aria-hidden': 'true' }, [
    svg('circle', { cx: 10, cy: 10, r: 7, fill: 'none', stroke: 'var(--helm-border-strong)', 'stroke-width': 3 }),
    svg('circle', {
      cx: 10,
      cy: 10,
      r: 7,
      fill: 'none',
      stroke: done === total ? 'var(--helm-success)' : 'var(--helm-accent)',
      'stroke-width': 3,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${length} ${circumference}`
    })
  ])
}

// ---------------------------------------------------------------------------
// Work tracking: where it stands, and the log

const STANDS = /** @type {const} */ ([
  ['done', 'Done'],
  ['left', 'Left'],
  ['next', 'Next']
])

/**
 * @param {Item} item
 * @param {Editing} editing
 * @param {TaskState} state
 * @param {() => void} redraw
 */
function trackingSection(item, editing, state, redraw) {
  const handoff = item.handoff
  const editingNow = editing.isOpen('handoff')
  const save = async () => {
    /** @type {Record<string, string>} */
    const next = {}
    for (const [key] of STANDS) next[key] = editing.field(`handoff.${key}`, () => el('textarea')).value.trim()
    if (handoff && STANDS.every(([key]) => next[key] === handoff[key])) {
      editing.close('handoff')
      return
    }
    if (await editing.edit({ handoff: next })) editing.close('handoff')
  }
  const cancel = () => editing.close('handoff')
  const by = handoff
    ? el('span', { class: 'it-from' }, [
        'from',
        el('span', { class: handoff.by === YOU ? 'it-from-who is-you' : 'it-from-who', text: handoff.by }),
        timeLabel(handoff.at)
      ])
    : null
  return el('section', { class: 'it-section it-tracking' }, [
    sectionHead('Work tracking', [
      el('span', { class: 'it-sub', text: 'what the next session reads first' }),
      el('span', { class: 'it-grow' }),
      by,
      editingNow ? null : iconButton('Edit where it stands', ICONS.pencil, () => editing.start('handoff', 'handoff.done'))
    ]),
    el(
      'div',
      { class: 'it-stands' },
      STANDS.map(([key, label]) =>
        el('div', { class: `it-card it-stand it-stand-${key}` }, [
          el('span', { class: 'it-stand-head' }, [standIcon(key), label]),
          editingNow
            ? textArea(editing, `handoff.${key}`, { value: handoff?.[key] ?? '', label, rows: 4, onSave: () => void save(), onCancel: cancel })
            : handoff?.[key]
              ? richText(handoff[key], 'it-stand-text')
              : el('span', { class: 'it-stand-empty', text: handoff ? 'Nothing.' : 'Not written yet.' })
        ])
      )
    ),
    editingNow ? editorActions(() => void save(), cancel, 'Ctrl Enter saves · Esc cancels') : null,
    logComposer(editing),
    logList(item, state, redraw)
  ])
}

/** @param {'done' | 'left' | 'next'} key */
function standIcon(key) {
  if (key === 'done') {
    return svg('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true' }, [
      svg('circle', { cx: 12, cy: 12, r: 8.5, fill: 'var(--helm-success)', stroke: 'var(--helm-success)', 'stroke-width': 2 }),
      svg('path', { d: 'M8.3 12.4l2.5 2.5 4.9-5.1', fill: 'none', stroke: 'var(--helm-surface-raised)', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    ])
  }
  if (key === 'left') {
    return svg('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true' }, [
      svg('circle', { cx: 12, cy: 12, r: 8.5, fill: 'none', stroke: 'var(--helm-warn)', 'stroke-width': 2, 'stroke-dasharray': '3 2.6' })
    ])
  }
  return svg('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true' }, [
    svg('circle', { cx: 12, cy: 12, r: 8.5, fill: 'none', stroke: 'var(--helm-accent)', 'stroke-width': 2 }),
    svg('path', { d: 'M8.5 12h7M12.5 8.8l3.2 3.2-3.2 3.2', fill: 'none', stroke: 'var(--helm-accent)', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  ])
}

/** @param {Editing} editing */
function logComposer(editing) {
  const post = async () => {
    const field = editing.field('log.note', () => el('input'))
    const note = field.value.trim()
    if (note === '') return
    if (await editing.edit({ note })) field.value = ''
  }
  const field = lineField(editing, 'log.note', { label: 'Add an update', placeholder: 'Add an update', className: 'it-bare-input', onEnter: () => void post() })
  return el('div', { class: 'it-composer' }, [field, button('Post', null, () => void post(), 'primary')])
}

/**
 * The log, newest first.
 *
 * @param {Item} item
 * @param {TaskState} state
 * @param {() => void} redraw
 */
function logList(item, state, redraw) {
  const entries = [...item.log.entries].reverse()
  if (entries.length === 0) return el('p', { class: 'it-none', text: 'Nothing logged yet.' })
  const shown = state.logAll ? entries : entries.slice(0, LOG_SHOWN)
  const hidden = item.log.total - shown.length
  return el('div', { class: 'it-log' }, [
    ...shown.map((entry, index) => {
      const you = entry.by === YOU
      return el('div', { class: index === shown.length - 1 && hidden === 0 ? 'it-log-entry is-last' : 'it-log-entry' }, [
        el('span', { class: you ? 'it-log-tile is-you' : 'it-log-tile' }, [lineIcon(you ? ICONS.person : ICONS.session, 13, 2)]),
        el('div', { class: 'it-log-body' }, [
          el('div', { class: 'it-log-line' }, [
            el('span', { class: you ? 'it-log-who is-you' : 'it-log-who', text: entry.by }),
            el('time', { class: 'it-log-when', text: timeLabel(entry.at), attrs: { datetime: entry.at } }),
            entry.ref ? el('span', { class: 'it-log-ref it-mono', text: entry.ref }) : null
          ]),
          inlineText('div', entry.text, 'it-log-text')
        ])
      ])
    }),
    hidden > 0
      ? state.logAll || entries.length <= LOG_SHOWN
        ? el('p', { class: 'it-none', text: `${hidden} older ${hidden === 1 ? 'entry' : 'entries'} not shown.` })
        : el('button', {
            class: 'it-more',
            text: `Show ${entries.length - shown.length} older`,
            attrs: { type: 'button' },
            on: {
              click: () => {
                state.logAll = true
                redraw()
              }
            }
          })
      : null
  ])
}

// ---------------------------------------------------------------------------
// Dependencies

/**
 * @param {ItemOverview} data
 * @param {Editing} editing
 * @param {TaskState} state
 * @param {() => void} redraw
 */
function dependenciesCard(data, editing, state, redraw) {
  const { item } = data
  const project = item.project.uid
  const remove = (/** @type {() => void} */ onClick, /** @type {string} */ label) => iconButton(label, ICONS.close, onClick, 'it-remove')
  return el('div', { class: 'it-card it-deps' }, [
    el('h2', { class: 'it-h2 it-card-title', text: 'Dependencies' }),
    el('span', { class: 'work-cap it-cap', text: 'Waits on' }),
    ...(item.waitsOn.length === 0
      ? [el('p', { class: 'it-none', text: 'Nothing.' })]
      : item.waitsOn.map((other) =>
          el('div', { class: 'it-dep' }, [
            otherItem(other, project, () => void openItem(other)),
            remove(() => void editing.edit({ waitsOn: { remove: [other.uid] } }), `Stop waiting on ${other.id}`)
          ])
        )),
    el('span', { class: 'work-cap it-cap', text: 'Blocks' }),
    ...(item.blocks.length === 0
      ? [el('p', { class: 'it-none', text: 'Nothing.' })]
      : item.blocks.map((other) =>
          el('div', { class: 'it-dep' }, [
            otherItem(other, project, () => void openItem(other)),
            remove(() => void editing.editOther(other.uid, { waitsOn: { remove: [item.uid] } }), `${other.id} stops waiting on this`)
          ])
        )),
    editing.isOpen('dep') ? dependencyPicker(data, editing, state, redraw) : el(
      'button',
      {
        class: 'it-add-row',
        attrs: { type: 'button' },
        on: {
          click: () => {
            state.found = null
            editing.start('dep')
          }
        }
      },
      [lineIcon(ICONS.plus, 12, 1.8), 'Add a dependency']
    )
  ])
}

/**
 * Finds a task in the portfolio to wait on, by ID or words.
 *
 * @param {ItemOverview} data
 * @param {Editing} editing
 * @param {TaskState} state
 * @param {() => void} redraw
 */
function dependencyPicker(data, editing, state, redraw) {
  const { item } = data
  const taken = new Set([item.uid, ...item.waitsOn.map((other) => other.uid)])
  const choices = (state.found ?? []).filter((other) => !taken.has(other.uid))
  const pick = async (/** @type {ItemSummary} */ other) => {
    if (await editing.edit({ waitsOn: { add: [other.uid] } })) editing.close('dep')
  }
  const close = () => {
    clearTimeout(state.findTimer)
    state.found = null
    editing.close('dep')
  }
  const field = lineField(editing, 'dep', {
    label: 'Find a task to wait on',
    placeholder: 'An ID or words',
    onEnter: () => {
      const first = (state.found ?? []).find((other) => !taken.has(other.uid))
      if (first) void pick(first)
    },
    onEscape: close,
    onInput: () => {
      clearTimeout(state.findTimer)
      state.findTimer = setTimeout(() => void search(data, editing, state, redraw), FIND_DELAY_MS)
    }
  })
  const query = field.value.trim()
  return el('div', { class: 'it-picker' }, [
    el('div', { class: 'it-picker-field' }, [field, iconButton('Close', ICONS.close, close)]),
    query === '' || state.found === null
      ? el('p', { class: 'it-hint', text: 'Enter picks the first · Esc closes' })
      : choices.length === 0
        ? el('p', { class: 'it-none', text: 'Nothing else matches.' })
        : el(
            'div',
            { class: 'it-picker-list' },
            choices.map((other) => otherItem(other, item.project.uid, () => void pick(other)))
          )
  ])
}

/**
 * @param {ItemOverview} data
 * @param {Editing} editing
 * @param {TaskState} state
 * @param {() => void} redraw
 */
async function search(data, editing, state, redraw) {
  const text = editing.field('dep', () => el('input')).value.trim()
  const seq = ++state.findSeq
  if (text === '') {
    state.found = null
    redraw()
    return
  }
  try {
    const result = /** @type {FindResult} */ (await rpc('findItems', { portfolio: data.portfolio.uid, text, limit: FIND_LIMIT }))
    if (seq !== state.findSeq || !editing.isOpen('dep')) return
    state.found = result.items
  } catch (error) {
    if (seq !== state.findSeq) return
    state.found = []
    toast(error instanceof Error ? error.message : String(error))
  }
  redraw()
}

// ---------------------------------------------------------------------------
// Starting a session

/**
 * Starts a session on the task in its project's first folder, with the
 * prompt that has it read the task first. Helm shows what it will run and the
 * user starts it or not. A project with no folder has nowhere to start one.
 *
 * @param {ItemOverview} data
 */
function promptBlock(data) {
  const { item } = data
  const prompt = sessionPrompt(item)
  const project = data.projects.find((candidate) => candidate.uid === item.project.uid)
  const folder = project === undefined ? null : sessionFolder(project)
  return el('div', { class: 'it-prompt' }, [
    el(
      'button',
      {
        class: 'helm-button it-prompt-button',
        attrs: { type: 'button', 'data-variant': 'primary', disabled: folder === null },
        on: { click: () => (folder === null ? undefined : void startSession(folder, item)) }
      },
      [lineIcon(ICONS.session, 13, 1.7), `Start a session on ${item.id}`]
    ),
    el(
      'p',
      { class: 'it-hint it-prompt-hint' },
      folder === null
        ? [`${item.project.name} has no folder to start a session in. Add one on the portfolio's workflow page.`]
        : ['Opens Claude Code in ', el('span', { class: 'it-mono', text: project?.place ?? folder }), ' with ', el('span', { class: 'it-mono it-nowrap', text: prompt }), '. Helm asks first.']
    )
  ])
}

/**
 * Called from the click: Helm takes the request only from one.
 *
 * @param {string} cwd
 * @param {Item} item
 */
async function startSession(cwd, item) {
  try {
    await helm.sessions.start({ cwd, prompt: sessionPrompt(item), name: item.id })
  } catch (error) {
    const busy = /** @type {{ code?: string }} */ (error).code === 'busy'
    toast(busy ? 'Helm is already asking about a session.' : `Could not start a session: ${error instanceof Error ? error.message : String(error)}`)
  }
}

