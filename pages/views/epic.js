/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * An epic: its progress in each project, its tasks in a box per project, the
 * order they can be done in, and its references and links. The v2 board's epic page; the
 * title, description, fields and links are edited in place, and tasks are
 * added in any project of the portfolio.
 */

import { ICONS, colourVar, el, lineIcon, priorityGlyph, sessionChip, statusIcon, swatch, tile, tint, toast, waitsMark } from '../shared/dom.js'
import { age, epicGroups, priorityMark } from '../shared/logic.js'
import { openItem, openPortfolio, openProject } from '../shared/work.js'
import { button, chip, descriptionSection, editorActions, lineField, linksCard, priorityChip, propertiesCard, propertySelect, stamp, statusChip, titleBlock } from './edit.js'
import { referencesCard } from './references.js'

/**
 * @typedef {import('../shared/types.js').ItemOverview} ItemOverview
 * @typedef {import('../shared/types.js').ItemSummary} ItemSummary
 * @typedef {import('../shared/types.js').PlacedProject} PlacedProject
 * @typedef {import('./edit.js').Editing} Editing
 */

/**
 * @param {ItemOverview} data
 * @param {Editing} editing
 */
export function epicParts(data, editing) {
  const { item, projects } = data
  const tasks = item.tasks ?? []
  const groups = epicGroups(tasks, projects, item.project.uid)
  return [
    head(data, editing, groups.length),
    el('div', { class: 'it-body' }, [
      el('div', { class: 'it-main' }, [
        groups.length > 0 ? progressCard(groups) : null,
        descriptionSection(editing, item),
        ...groups.map((group) => groupBox(data, group)),
        groups.length === 0 ? el('p', { class: 'it-none', text: 'No tasks in this epic yet.' }) : null,
        addTask(data, editing)
      ]),
      el('aside', { class: 'it-aside' }, [
        propertiesCard(editing, data),
        tasks.length > 0 ? orderCard(data) : null,
        referencesCard(editing, { level: 'epic', uid: item.uid, refs: item.refs, inherited: data.inherited, missing: data.missing }),
        linksCard(editing, item),
        el('span', { class: 'it-grow' }),
        stamp(editing, item)
      ])
    ])
  ]
}

// ---------------------------------------------------------------------------
// Header

/**
 * @param {ItemOverview} data
 * @param {Editing} editing
 * @param {number} span how many projects its tasks are in
 */
function head(data, editing, span) {
  const { item, portfolio } = data
  return el('header', { class: 'it-head' }, [
    el('span', { class: 'it-epic-tile' }, [lineIcon(ICONS.epic, 20, 1.6)]),
    el('div', { class: 'it-head-main' }, [
      el('nav', { class: 'it-crumbs', attrs: { 'aria-label': 'Where this is' } }, [
        el('button', { class: 'crumb', text: portfolio.name, attrs: { type: 'button' }, on: { click: () => void openPortfolio(portfolio) } }),
        el('span', { class: 'crumb-sep', text: '›' }),
        el('span', { text: 'Epic' }),
        el('span', { class: 'it-mono it-crumb-here', text: item.id })
      ]),
      titleBlock(editing, item),
      el('div', { class: 'it-chips' }, [
        statusChip(data),
        priorityChip(data),
        chip([lineIcon(ICONS.home, 12, 2), swatch(item.project.colour, 8), item.project.name], {
          onClick: () => void openProject(item.project),
          title: 'Home project: open it'
        }),
        span > 0 ? el('span', { class: 'it-span', text: span === 1 ? 'in 1 project' : `spans ${span} projects` }) : null
      ])
    ]),
    button('Copy ID', ICONS.copy, () => void editing.copy(item.id, item.id))
  ])
}

// ---------------------------------------------------------------------------
// Progress and the tasks by project

/**
 * @typedef {ReturnType<typeof epicGroups<ItemSummary, PlacedProject>>[number]} Group
 */

const FILL_ORDER = ['done', 'active', 'not-started']

/** @param {Group[]} groups */
function progressCard(groups) {
  const done = groups.reduce((sum, group) => sum + group.done, 0)
  const total = groups.reduce((sum, group) => sum + group.total, 0)
  const counted = groups.filter((group) => group.total > 0)
  return el('div', { class: 'it-card it-progress' }, [
    el('div', { class: 'it-progress-head' }, [
      el('h2', { class: 'it-h2', text: 'Progress by project' }),
      el('span', { class: 'it-sub', text: `${done} of ${total} ${total === 1 ? 'task' : 'tasks'} done` }),
      el('span', { class: 'it-grow' }),
      el('span', { class: 'it-progress-pct', text: total === 0 ? '0%' : `${Math.round((done / total) * 100)}%` })
    ]),
    el(
      'div',
      { class: 'it-progress-bar' },
      counted.map((group) => {
        const colour = colourVar(group.project.colour)
        return el(
          'span',
          { class: 'it-progress-group', title: `${group.project.name}: ${group.done} of ${group.total} done`, style: { flex: `${group.total} 1 0` } },
          // Done first, then in progress, then not started: the bar fills from the left.
          group.tasks
            .filter((task) => task.status.group !== 'closed')
            .sort((a, b) => FILL_ORDER.indexOf(a.status.group) - FILL_ORDER.indexOf(b.status.group))
            .map((task) =>
              el('span', {
                title: `${task.id} ${task.status.name}`,
                style: {
                  background: task.status.group === 'done' ? colour : task.status.group === 'active' ? tint(colour, 55) : tint(colour, 18)
                }
              })
            )
        )
      })
    ),
    el(
      'div',
      { class: 'it-progress-legend' },
      counted.map((group) =>
        el('span', { class: 'it-progress-label', style: { flex: `${group.total} 1 0` } }, [
          swatch(group.project.colour, 8),
          el('span', { class: 'work-ellip' }, [group.project.name, ' ', el('span', { class: 'it-mono', text: `${group.done}/${group.total}` })])
        ])
      )
    )
  ])
}

/**
 * @param {ItemOverview} data
 * @param {Group} group
 */
function groupBox(data, group) {
  const colour = colourVar(group.project.colour)
  const priorities = data.portfolio.priorities
  return el('div', { class: 'it-group' }, [
    el('div', { class: 'it-group-head', style: { background: tint(colour, 7) } }, [
      tile(group.project.name.charAt(0).toUpperCase(), 22, group.project.colour),
      el('button', { class: 'it-group-name', text: group.project.name, attrs: { type: 'button' }, on: { click: () => void openProject(group.project) } }),
      group.home ? el('span', { class: 'it-home-tag' }, [lineIcon(ICONS.home, 9, 2.4), 'home']) : null,
      el('span', { class: 'it-sub', text: `${group.done} of ${group.total} done` }),
      el('span', { class: 'it-grow' }),
      group.project.place ? el('span', { class: 'it-mono it-group-place work-ellip', text: group.project.place, title: group.project.folders.join('\n') }) : null
    ]),
    ...group.tasks.map((task) => {
      const rank = priorities.find((priority) => priority.uid === task.priority.uid)?.rank ?? priorities.length
      return el(
        'button',
        { class: 'it-task', title: `${task.id} ${task.title} · ${task.status.name}`, attrs: { type: 'button' }, on: { click: () => void openItem(task) } },
        [
          statusIcon(task.status, 14),
          el('span', { class: 'it-mono it-task-id', text: task.id }),
          el('span', { class: 'it-task-title' }, [
            el('span', { class: 'work-ellip', text: task.title }),
            task.session ? sessionChip(task.session, task.session.activeAt ? age(task.session.activeAt) : '') : null,
            task.waitingOn.length > 0 ? waitsMark(task.waitingOn) : null
          ]),
          priorityGlyph(priorityMark(rank, priorities.length), task.priority.name)
        ]
      )
    })
  ])
}

/**
 * "Add a task", in any project of the portfolio. The field stays open after
 * each one, for the next.
 *
 * @param {ItemOverview} data
 * @param {Editing} editing
 */
function addTask(data, editing) {
  const { item, portfolio, projects } = data
  if (!editing.isOpen('task')) {
    return el('div', { class: 'it-add-task' }, [
      button('Add a task', ICONS.plus, () => editing.start('task', 'task.title')),
      el('span', { class: 'it-hint', text: `in any ${portfolio.name} project. The epic spans whichever projects its tasks are in.` })
    ])
  }
  const close = () => editing.close('task')
  const project = editing.field('task.project', () =>
    propertySelect(
      'Project',
      projects.map((candidate) => [String(candidate.uid), candidate.name]),
      String(item.project.uid),
      () => undefined
    )
  )
  const save = async () => {
    const title = editing.field('task.title', () => el('input')).value.trim()
    if (title === '') return
    const made = /** @type {ItemSummary | undefined} */ (await editing.call('createItem', { kind: 'task', project: Number(project.value), epic: item.uid, title }))
    if (made === undefined) return
    editing.field('task.title', () => el('input')).value = ''
    toast(`Created ${made.id} in ${made.project.name}`)
  }
  return el('div', { class: 'it-add-task-form it-box' }, [
    el('div', { class: 'it-add-task-row' }, [
      lineIcon(ICONS.plus, 14, 1.7),
      lineField(editing, 'task.title', { label: 'Title of the new task', placeholder: 'Title · Enter saves', className: 'it-bare-input', onEnter: () => void save(), onEscape: close }),
      project
    ]),
    el('div', { class: 'it-add-task-foot' }, [editorActions(() => void save(), close, 'Esc closes')])
  ])
}

// ---------------------------------------------------------------------------
// Order

/** @param {ItemOverview} data */
function orderCard(data) {
  const tasks = new Map((data.item.tasks ?? []).map((task) => [task.uid, task]))
  const rows = (data.order ?? []).flatMap((row) => {
    const task = tasks.get(row.uid)
    return task ? [{ task, depth: row.depth }] : []
  })
  const flat = rows.every((row) => row.depth === 0)
  return el('div', { class: 'it-card it-order' }, [
    el('h2', { class: 'it-h2 it-card-title', text: 'Order' }),
    el('p', { class: 'it-hint it-order-note', text: flat ? 'None of these tasks wait on each other.' : 'Each task waits on the one it hangs from.' }),
    ...rows.map(({ task, depth }) =>
      el(
        'button',
        {
          class: 'it-order-row',
          title: `${task.id} ${task.title} (${task.project.name}) · ${task.status.name}`,
          style: { 'padding-left': `${depth === 0 ? 0 : 4 + (depth - 1) * 15}px` },
          attrs: { type: 'button' },
          on: { click: () => void openItem(task) }
        },
        [
          depth > 0 ? el('span', { class: 'it-elbow' }) : null,
          statusIcon(task.status, 13),
          el('span', { class: 'it-mono it-order-id', text: task.id }),
          el('span', { class: 'work-ellip it-order-title', text: task.title }),
          swatch(task.project.colour, 7)
        ]
      )
    )
  ])
}
