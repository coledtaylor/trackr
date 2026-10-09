/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * A portfolio: a card per project, four stat cards, the epics counted across
 * projects, the tasks in progress and waiting on another task, and its
 * references. The v2 board's portfolio page. Its header opens the workflow
 * and a new task.
 *
 * Drawing again keeps a reference being added or changed, with its focus.
 */

import { ICONS, colourVar, el, lineIcon, redraw, segments, sessionChip, statusIcon, svg, swatch, tile, tint } from '../shared/dom.js'
import { age, trend } from '../shared/logic.js'
import { openTaskDialog } from '../shared/new-task.js'
import { openItem, openProject, openWorkflow, rpc } from '../shared/work.js'
import { createEditing } from './edit.js'
import { referencesCard } from './references.js'

/**
 * @typedef {import('../shared/types.js').PortfolioOverview} PortfolioOverview
 * @typedef {import('../shared/types.js').PlacedProject} PlacedProject
 * @typedef {import('../shared/types.js').EpicOverview} EpicOverview
 * @typedef {import('../shared/types.js').ItemSummary} ItemSummary
 * @typedef {import('../shared/types.js').Blocker} Blocker
 * @typedef {import('../shared/types.js').Status} Status
 * @typedef {import('./parts.js').Host} Host
 * @typedef {import('./parts.js').View} View
 * @typedef {import('./edit.js').Editing} Editing
 */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_PIPS = 12
const MAX_SESSION_TILES = 4

/**
 * @param {HTMLElement} root
 * @param {number} uid
 * @param {Host} host
 * @returns {View}
 */
export function createPortfolioView(root, uid, host) {
  /** @type {PortfolioOverview | null} */
  let overview = null
  const editing = createEditing(null, { reload: () => host.reload() }, draw)

  function draw() {
    if (overview === null) return
    const shown = overview
    root.className = 'view-portfolio'
    redraw(root, () => [head(shown), body(shown, editing)])
  }

  return {
    async load(isCurrent) {
      const next = /** @type {PortfolioOverview} */ (await rpc('portfolioOverview', uid))
      if (!isCurrent()) return
      overview = next
      host.setPlace({ portfolio: next.portfolio.uid })
      helm.surface.setTitle(next.portfolio.name)
      draw()
    }
  }
}

// ---------------------------------------------------------------------------
// Header: name, then a card per project

/** @param {PortfolioOverview} overview */
function head(overview) {
  const { portfolio } = overview
  const next = `${portfolio.key}-${portfolio.nextNumber}`
  return el('header', { class: 'pf-head' }, [
    el('div', { class: 'pf-title' }, [
      tile(portfolio.key.slice(0, 4), 42, null, 'pf-key'),
      el('div', { class: 'pf-name' }, [
        el('div', { class: 'pf-name-line' }, [el('h1', { text: portfolio.name }), el('span', { class: 'pf-tag work-mono', text: portfolio.key })]),
        el('p', { class: 'pf-sub' }, [
          portfolio.description ? `${portfolio.description} · ` : '',
          'next ID ',
          el('span', { class: 'work-mono', text: next })
        ])
      ]),
      el('div', { class: 'pf-actions' }, [
        el('button', { class: 'helm-button pf-action', attrs: { type: 'button' }, on: { click: () => void openWorkflow(portfolio) } }, [
          lineIcon(ICONS.sliders, 13, 1.7),
          'Workflow'
        ]),
        el(
          'button',
          {
            class: 'helm-button pf-action',
            attrs: { type: 'button', 'data-variant': 'primary', disabled: portfolio.projects.length === 0 },
            title: portfolio.projects.length === 0 ? 'Add a project first' : 'New task',
            on: { click: () => void openTaskDialog(portfolio.uid, null) }
          },
          [lineIcon(ICONS.plus, 13, 1.8), 'New']
        )
      ])
    ]),
    portfolio.projects.length === 0
      ? el('div', { class: 'pf-none' }, [
          el('p', { class: 'quiet', text: 'No projects yet. Tasks live in projects, and a project’s folders tell sessions where they are.' }),
          el('button', { class: 'helm-button pf-action', attrs: { type: 'button' }, on: { click: () => void openWorkflow(portfolio, 'new') } }, [
            lineIcon(ICONS.plus, 13, 1.8),
            'Add a project'
          ])
        ])
      : el('div', { class: 'pf-cards' }, [...portfolio.projects.map(projectCard), addProjectCard(portfolio)])
  ])
}

/**
 * The last card: a new project, made in the workflow's project editor.
 *
 * @param {{ uid: number, name: string }} portfolio
 */
function addProjectCard(portfolio) {
  return el('button', { class: 'pf-card pf-card-add', attrs: { type: 'button' }, on: { click: () => void openWorkflow(portfolio, 'new') } }, [
    lineIcon(ICONS.plus, 13, 1.8),
    'Add a project'
  ])
}

/** @param {PlacedProject} project */
function projectCard(project) {
  const { open, active, done } = project.counts
  return el('button', { class: 'pf-card', attrs: { type: 'button' }, on: { click: () => void openProject(project) } }, [
    el('span', { class: 'pf-card-name' }, [tile(project.name.charAt(0).toUpperCase(), 22, project.colour), el('span', { class: 'work-ellip', text: project.name })]),
    el('span', { class: 'pf-card-count' }, [
      el('span', { class: 'pf-big', text: String(open) }),
      el('span', { class: 'pf-unit', text: 'open' }),
      el('span', { class: 'work-grow' }),
      active > 0 ? el('span', { class: 'pf-doing', text: `${active} in progress` }) : null
    ]),
    segments({ done, active, open: open - active }, colourVar(project.colour)),
    el('span', { class: 'pf-place work-mono work-ellip', text: project.place ?? 'no folder' })
  ])
}

// ---------------------------------------------------------------------------
// Body

/**
 * @param {PortfolioOverview} overview
 * @param {Editing} editing
 */
function body(overview, editing) {
  return el('div', { class: 'pf-body' }, [
    stats(overview),
    epics(overview),
    lists(overview),
    referencesCard(editing, { level: 'portfolio', uid: overview.portfolio.uid, refs: overview.refs, missing: overview.missing })
  ])
}

/** @param {PortfolioOverview} overview */
function stats(overview) {
  const { open, active, waiting, done } = overview.stats
  return el('div', { class: 'pf-stats' }, [
    stat('Open', String(open.count), '', sparkline(open.series), trend(open.series)),
    stat(
      'In progress',
      String(active.count),
      'accent',
      sessionTiles(active.sessions),
      `${active.withSession} with a session on ${active.withSession === 1 ? 'it' : 'them'}`
    ),
    stat(
      'Waiting on another task',
      String(waiting.count),
      'warn',
      el('span', { class: 'pf-stat-icon' }, [lineIcon(ICONS.clock, 22, 1.7)]),
      `${waiting.crossProject} on a task in another project`
    ),
    stat('Done this week', String(done.count), 'success', weekBars(done.days), 'Mon to Sun')
  ])
}

/**
 * @param {string} label
 * @param {string} value
 * @param {string} tone '', 'accent', 'warn' or 'success'
 * @param {Node} figure
 * @param {string} note
 */
function stat(label, value, tone, figure, note) {
  return el('div', { class: 'pf-stat' }, [
    el('span', { class: 'work-cap', text: label }),
    el('div', { class: 'pf-stat-row' }, [el('span', { class: tone ? `pf-stat-value tone-${tone}` : 'pf-stat-value', text: value }), figure]),
    el('span', { class: 'pf-stat-note', text: note })
  ])
}

/** @param {number[]} series */
function sparkline(series) {
  const width = 120
  const height = 28
  const max = Math.max(...series)
  const min = Math.min(...series)
  const x = (/** @type {number} */ i) => round(4 + (i * (width - 8)) / Math.max(1, series.length - 1))
  const y = (/** @type {number} */ v) => round(max === min ? height / 2 : 4 + ((max - v) / (max - min)) * (height - 8))
  const points = series.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const last = series.length - 1
  return svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': `Open tasks over the last ${series.length} days` }, [
    svg('polyline', { points, fill: 'none', stroke: 'var(--helm-accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    svg('circle', { cx: x(last), cy: y(series[last]), r: 3, fill: 'var(--helm-accent)', stroke: 'var(--helm-surface-raised)', 'stroke-width': 2 })
  ])
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 10) / 10
}

/** @param {string[]} sessions */
function sessionTiles(sessions) {
  const shown = sessions.slice(0, MAX_SESSION_TILES)
  const more = sessions.length - shown.length
  return el('span', { class: 'pf-sessions' }, [
    ...shown.map((name) => el('span', { class: 'pf-session', title: name }, [lineIcon(ICONS.session, 12, 2)])),
    more > 0 ? el('span', { class: 'pf-session pf-session-more', text: `+${more}`, title: sessions.slice(MAX_SESSION_TILES).join(', ') }) : null
  ])
}

/** @param {number[]} days Monday first */
function weekBars(days) {
  const max = Math.max(1, ...days)
  return el(
    'span',
    { class: 'pf-week' },
    days.map((n, i) =>
      el('span', {
        title: `${DAYS[i]}: ${n} done`,
        style: { height: `${n === 0 ? 2 : Math.max(5, Math.round((n / max) * 28))}px`, background: n === 0 ? 'var(--helm-border-strong)' : 'var(--helm-success)' }
      })
    )
  )
}

// ---------------------------------------------------------------------------
// Epics across projects

/** @param {PortfolioOverview} overview */
function epics(overview) {
  const projects = overview.portfolio.projects
  const legend = el('span', { class: 'pf-legend' }, [
    el('span', {}, [pip('done', 'var(--helm-fg-muted)'), 'done']),
    el('span', {}, [pip('active', 'var(--helm-fg-muted)'), 'in progress']),
    el('span', {}, [pip('open', 'var(--helm-fg-subtle)'), 'open']),
    el('span', {}, [lineIcon(ICONS.home, 11, 2), 'home project'])
  ])
  const headRow = el('div', { class: 'pf-matrix-row pf-matrix-head' }, [
    el('span', { class: 'work-cap', text: 'Epic' }),
    ...projects.map((project) =>
      el('span', { class: 'pf-col', title: project.name }, [swatch(project.colour, 8), el('span', { class: 'work-ellip', text: project.name })])
    ),
    el('span', { class: 'work-cap pf-total', text: 'Done' })
  ])
  const table =
    overview.epics.length === 0
      ? el('p', { class: 'quiet pf-none', text: 'No epics yet. An epic groups tasks that ship together, in any of the projects.' })
      : el(
          'div',
          { class: 'pf-matrix', style: { '--projects': String(projects.length) } },
          [headRow, ...overview.epics.map((epic) => epicRow(epic, projects))]
        )
  return el('section', { class: 'pf-epics' }, [
    el('div', { class: 'pf-epics-head' }, [el('h2', { text: 'Epics across projects' }), overview.epics.length > 0 ? legend : null]),
    table
  ])
}

/**
 * @param {EpicOverview} epic
 * @param {PlacedProject[]} projects
 */
function epicRow(epic, projects) {
  const finished = epic.status.group === 'done' || epic.status.group === 'closed'
  const pct = epic.total === 0 ? 0 : Math.round((epic.done / epic.total) * 100)
  const spans = epic.cells.length
  const spanText = epic.total === 0 ? 'no tasks yet' : spans === 1 ? '1 project' : `${spans} projects`
  return el(
    'button',
    {
      class: finished ? 'pf-matrix-row pf-epic is-finished' : 'pf-matrix-row pf-epic',
      title: `${epic.id} ${epic.title} · ${epic.status.name} · ${epic.done} of ${epic.total} done`,
      attrs: { type: 'button' },
      on: { click: () => void openItem(epic) }
    },
    [
      el('span', { class: 'pf-epic-main' }, [
        el('span', { class: 'pf-epic-line' }, [
          statusIcon(epic.status, 14),
          el('span', { class: 'work-id pf-epic-id', text: epic.id }),
          el('span', { class: 'work-ellip', text: epic.title })
        ]),
        el('span', { class: 'pf-epic-progress' }, [
          el('span', { class: 'pf-bar' }, [
            el('span', { style: { width: `${pct}%`, background: epic.status.group === 'done' ? 'var(--helm-success)' : 'var(--helm-accent)' } })
          ]),
          el('span', { text: spanText })
        ])
      ]),
      ...projects.map((project) => epicCell(epic, project)),
      el('span', { class: 'pf-total work-mono', text: `${epic.done}/${epic.total}` })
    ]
  )
}

/**
 * One project's share of an epic: a pip per task. In a narrow pane the cells
 * wrap under the title, so each carries its project's name, shown only then.
 *
 * @param {EpicOverview} epic
 * @param {PlacedProject} project
 */
function epicCell(epic, project) {
  const cell = epic.cells.find((candidate) => candidate.project === project.uid)
  const home = epic.project.uid === project.uid
  if (!cell && !home) return el('span', { class: 'pf-cell is-empty' }, [el('span', { class: 'pf-dot', text: '·' })])
  const colour = colourVar(project.colour)
  /** @type {Node[]} */
  const pips = []
  const kinds = /** @type {('done' | 'active' | 'open')[]} */ ([
    ...Array(cell?.done ?? 0).fill('done'),
    ...Array(cell?.active ?? 0).fill('active'),
    ...Array(cell?.open ?? 0).fill('open')
  ])
  for (const kind of kinds.slice(0, MAX_PIPS)) pips.push(pip(kind, colour, `${project.name}: ${kind === 'open' ? 'open' : kind === 'active' ? 'in progress' : 'done'}`))
  if (kinds.length > MAX_PIPS) pips.push(el('span', { class: 'pf-more', text: `+${kinds.length - MAX_PIPS}` }))
  return el('span', { class: home ? 'pf-cell is-home' : 'pf-cell', style: home ? { background: tint(colour, 7) } : {} }, [
    el('span', { class: 'pf-cell-label' }, [swatch(project.colour, 7), el('span', { text: project.name })]),
    home ? el('span', { class: 'pf-home', title: 'Home project' }, [lineIcon(ICONS.home, 11, 2)]) : null,
    el('span', { class: 'pf-pips' }, pips)
  ])
}

/**
 * @param {'done' | 'active' | 'open'} kind
 * @param {string} colour
 * @param {string} [title]
 */
function pip(kind, colour, title) {
  const background = kind === 'done' ? colour : kind === 'active' ? `linear-gradient(90deg, ${colour} 50%, transparent 50%)` : 'transparent'
  return el('span', { class: 'pf-pip', title, style: { background, 'border-color': kind === 'open' ? tint(colour, 60) : colour } })
}

// ---------------------------------------------------------------------------
// In progress, and waiting

/** @param {PortfolioOverview} overview */
function lists(overview) {
  const statuses = overview.portfolio.statuses
  const activeStatus = statuses.find((status) => status.group === 'active') ?? { icon: 'doing', colour: 'accent' }
  return el('div', { class: 'pf-lists' }, [
    box(statusIcon(activeStatus, 14), 'In progress', overview.active.length, overview.active.length === 0 ? 'Nothing in progress.' : null, overview.active.map(activeRow)),
    box(
      el('span', { class: 'tone-warn work-noshrink', style: { display: 'flex' } }, [lineIcon(ICONS.clock, 14, 2)]),
      'Waiting on another task',
      overview.waiting.length,
      overview.waiting.length === 0 ? 'Nothing is waiting on another task.' : null,
      overview.waiting.map(({ item, waitsOn }) => waitingRow(item, waitsOn))
    )
  ])
}

/**
 * @param {Node} icon
 * @param {string} title
 * @param {number} count
 * @param {string | null} empty
 * @param {Node[]} rows
 */
function box(icon, title, count, empty, rows) {
  return el('div', { class: 'pf-box' }, [
    el('div', { class: 'pf-box-head' }, [icon, el('h2', { text: title }), el('span', { class: 'counts', text: String(count) })]),
    empty ? el('p', { class: 'quiet pf-box-empty', text: empty }) : null,
    ...rows
  ])
}

/** @param {ItemSummary} item */
function activeRow(item) {
  return el('button', { class: 'pf-row', attrs: { type: 'button' }, on: { click: () => void openItem(item) } }, [
    el('span', { class: 'pf-row-main' }, [
      el('span', { class: 'pf-row-line' }, [el('span', { class: 'work-id', text: item.id }), el('span', { class: 'work-ellip', text: item.title })]),
      el('span', { class: 'pf-row-meta' }, [swatch(item.project.colour, 7), el('span', { text: item.project.name }), el('span', { text: '·' }), el('span', { text: item.status.name })])
    ]),
    item.session ? sessionChip(item.session, item.session.activeAt ? age(item.session.activeAt) : '') : null
  ])
}

/**
 * @param {ItemSummary} item
 * @param {Blocker[]} waitsOn
 */
function waitingRow(item, waitsOn) {
  const first = waitsOn[0]
  return el('button', { class: 'pf-row pf-row-stack', attrs: { type: 'button' }, on: { click: () => void openItem(item) } }, [
    el('span', { class: 'pf-row-line' }, [el('span', { class: 'work-id', text: item.id }), el('span', { class: 'work-ellip', text: item.title })]),
    el('span', { class: 'pf-row-meta' }, [
      swatch(item.project.colour, 7),
      el('span', { text: item.project.name }),
      el('span', { class: 'tone-warn pf-waits-arrow' }, [lineIcon(ICONS.waitsOn, 11, 2)]),
      el('span', { class: 'tone-warn', text: 'waits on' }),
      first ? swatch(first.project.colour, 7) : null,
      first ? el('span', { class: 'work-mono pf-blocker', text: first.id, title: `${first.id} ${first.title}` }) : null,
      first && first.project.uid !== item.project.uid ? el('span', { text: `in ${first.project.name}` }) : null,
      waitsOn.length > 1 ? el('span', { text: `and ${waitsOn.length - 1} more`, title: waitsOn.slice(1).map((blocker) => blocker.id).join(', ') }) : null
    ])
  ])
}
