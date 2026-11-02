/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * An initiative: connected epics across the portfolio's projects, and the
 * sequence their work is done in. Its sequence runs the width of the page
 * under the header; under it the description, its epics, what done means
 * for the whole of it and where it stands, with its fields, references and
 * links beside them. Everything is edited in place.
 */

import { ICONS, el, lineIcon, selectFace, statusIcon, swatch, toast } from '../shared/dom.js'
import { listed } from '../shared/logic.js'
import { openItem, openPortfolio, openProject, opens } from '../shared/work.js'
import { button, chip, descriptionSection, editorActions, lineField, linksCard, priorityChip, propertiesCard, propertySelect, stamp, statusChip, titleBlock } from './edit.js'
import { referencesCard } from './references.js'
import { sequenceSection, stageBar } from './sequence.js'
import { criteriaSection, trackingSection } from './task.js'

/**
 * @typedef {import('../shared/types.js').ItemOverview} ItemOverview
 * @typedef {import('../shared/types.js').ItemSummary} ItemSummary
 * @typedef {import('../shared/types.js').Plan} Plan
 * @typedef {import('./edit.js').Editing} Editing
 * @typedef {import('./task.js').TaskState} TaskState
 */

/**
 * @param {ItemOverview} data
 * @param {Editing} editing
 * @param {TaskState} state
 * @param {() => void} redraw
 */
export function initiativeParts(data, editing, state, redraw) {
  const { item, plan } = data
  return [
    head(data, editing),
    plan ? sequenceSection(editing, plan) : null,
    el('div', { class: 'it-body' }, [
      el('div', { class: 'it-main' }, [
        descriptionSection(editing, item),
        epicsSection(data, editing),
        criteriaSection(item, editing),
        trackingSection(item, editing, state, redraw)
      ]),
      el('aside', { class: 'it-aside' }, [
        propertiesCard(editing, data),
        referencesCard(editing, { level: 'initiative', uid: item.uid, refs: item.refs, inherited: data.inherited, missing: data.missing }),
        linksCard(editing, item),
        el('span', { class: 'it-grow' }),
        stamp(editing, item)
      ])
    ])
  ]
}

/**
 * @param {ItemOverview} data
 * @param {Editing} editing
 */
function head(data, editing) {
  const { item, portfolio } = data
  const epics = item.epics?.length ?? 0
  const spans = item.spans?.length ?? 0
  return el('header', { class: 'it-head' }, [
    el('span', { class: 'it-epic-tile it-initiative-tile' }, [lineIcon(ICONS.initiative, 20, 1.6)]),
    el('div', { class: 'it-head-main' }, [
      el('nav', { class: 'it-crumbs', attrs: { 'aria-label': 'Where this is' } }, [
        el('button', { class: 'crumb', text: portfolio.name, attrs: { type: 'button' }, on: opens((how) => openPortfolio(portfolio, how)) }),
        el('span', { class: 'crumb-sep', text: '›' }),
        el('span', { text: 'Initiative' }),
        el('span', { class: 'it-mono it-crumb-here', text: item.id })
      ]),
      titleBlock(editing, item),
      el('div', { class: 'it-chips' }, [
        statusChip(data),
        priorityChip(data),
        chip([lineIcon(ICONS.home, 12, 2), swatch(item.project.colour, 8), item.project.name], {
          onOpen: (how) => openProject(item.project, how),
          title: 'Home project: open it'
        }),
        el('span', { class: 'it-span', text: epics === 0 ? 'no epics yet' : `${epics === 1 ? '1 epic' : `${epics} epics`}${spans > 1 ? ` · spans ${spans} projects` : ' · in 1 project'}` })
      ])
    ]),
    button('Copy ID', ICONS.copy, () => void editing.copy(item.id, item.id))
  ])
}

// ---------------------------------------------------------------------------
// Epics

/**
 * Its epics, each with how far along it is and the stages that hold its
 * work, and a way to add one: a new epic, or one in no initiative.
 *
 * @param {ItemOverview} data
 * @param {Editing} editing
 */
function epicsSection(data, editing) {
  const { item, plan } = data
  const epics = plan?.epics ?? []
  const done = epics.filter((epic) => epic.status.group === 'done').length
  return el('section', { class: 'it-section' }, [
    el('div', { class: 'it-sec-head' }, [el('h2', { class: 'it-h2', text: 'Epics' }), epics.length > 0 ? el('span', { class: 'it-sub', text: `${done} of ${epics.length} done` }) : null]),
    el('div', { class: 'it-box' }, [
      ...epics.map((epic) => epicRow(epic, plan)),
      epics.length === 0 ? el('p', { class: 'it-none in-none', text: `No epics in ${item.title} yet.` }) : null,
      addEpic(data, editing)
    ])
  ])
}

/**
 * @param {Plan['epics'][number]} epic
 * @param {Plan | null} plan
 */
function epicRow(epic, plan) {
  const stages = (plan?.stages ?? [])
    .filter((stage) => stage.items.some((entry) => entry.id === epic.id || entry.epic?.id === epic.id))
    .map((stage) => String(stage.n))
  const { progress } = epic
  const finished = progress.total > 0 && progress.done === progress.total
  return el(
    'button',
    { class: 'in-epic', title: `${epic.id} ${epic.title} · ${epic.status.name} · ${epic.project.name}`, attrs: { type: 'button' }, on: opens((how) => openItem(epic, how)) },
    [
      statusIcon(epic.status, 14),
      el('span', { class: 'it-mono it-task-id', text: epic.id }),
      el('span', { class: 'in-epic-title' }, [el('span', { class: 'work-ellip', text: epic.title }), swatch(epic.project.colour, 7)]),
      el('span', { class: 'in-epic-progress' }, [
        stageBar(progress, finished ? 'done' : 'active'),
        el('span', { class: 'in-count', text: progress.total === 0 ? 'no tasks' : `${progress.done}/${progress.total}` })
      ]),
      el('span', { class: stages.length === 0 ? 'in-stages is-none' : 'in-stages', text: stages.length === 0 ? 'no stage' : `${stages.length === 1 ? 'stage' : 'stages'} ${listed(stages)}` })
    ]
  )
}

/**
 * A new epic in any project of the portfolio, or one there is that is in no
 * initiative. The field stays open after each one, for the next.
 *
 * @param {ItemOverview} data
 * @param {Editing} editing
 */
function addEpic(data, editing) {
  const { item, portfolio, projects } = data
  const free = data.epics.filter((epic) => epic.initiative === null)
  const join = free.length === 0
    ? null
    : el(
        'select',
        {
          class: 'helm-select it-select in-join',
          attrs: { 'aria-label': 'Add an epic that is in no initiative' },
          on: {
            change: (/** @type {Event} */ event) => {
              const select = /** @type {HTMLSelectElement} */ (event.currentTarget)
              const chosen = free.find((epic) => epic.id === select.value)
              if (chosen) void editing.editOther(chosen.uid, { initiative: item.uid })
            }
          }
        },
        [selectFace(), el('option', { text: 'Add an existing epic…', attrs: { value: '', selected: true } }), ...free.map((epic) => el('option', { text: `${epic.id} ${epic.title}`, attrs: { value: epic.id } }))]
      )
  if (!editing.isOpen('epic')) {
    return el('div', { class: 'in-add' }, [
      el('button', { class: 'it-add-row in-add-new', attrs: { type: 'button' }, on: { click: () => editing.start('epic', 'epic.title') } }, [lineIcon(ICONS.plus, 12, 1.8), 'New epic']),
      join
    ])
  }
  const close = () => editing.close('epic')
  const project = editing.field('epic.project', () =>
    propertySelect(
      'Home project',
      projects.map((candidate) => [String(candidate.uid), candidate.name]),
      String(item.project.uid),
      () => undefined
    )
  )
  const save = async () => {
    const title = editing.field('epic.title', () => el('input')).value.trim()
    if (title === '') return
    const made = /** @type {ItemSummary | undefined} */ (await editing.call('createItem', { kind: 'epic', project: Number(project.value), initiative: item.uid, title }))
    if (made === undefined) return
    editing.field('epic.title', () => el('input')).value = ''
    toast(`Created ${made.id} in ${made.project.name}`)
  }
  return el('div', { class: 'it-add-task-form in-add-form' }, [
    el('div', { class: 'it-add-task-row' }, [
      lineIcon(ICONS.epic, 14, 1.7),
      lineField(editing, 'epic.title', { label: 'Title of the new epic', placeholder: `New epic in ${item.title} · Enter saves`, className: 'it-bare-input', onEnter: () => void save(), onEscape: close }),
      project
    ]),
    el('div', { class: 'it-add-task-foot' }, [editorActions(() => void save(), close, `Its tasks can be in any ${portfolio.name} project. Esc closes`)])
  ])
}
