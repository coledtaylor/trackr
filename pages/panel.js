/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * The sidebar panel: what is in progress across every portfolio, the
 * portfolios with their projects, find by title or ID, and the forms for a new
 * task and a new portfolio.
 *
 * It reads again when it comes on screen, when the header's Refresh is
 * pressed, and when another page of the plugin (a tab, or the background page
 * after a session's write) says the data changed. Tabs tell it what they show,
 * so the row for what is on screen is marked.
 */

import { ICONS, el, fill, itemRow, lineIcon, statusIcon, swatch, toast } from './shared/dom.js'
import { PORTFOLIO_KEY, defaultProject, exactIdFirst, openCount, suggestKey, timeLabel } from './shared/logic.js'
import { lastProject, taskChoices, taskForm } from './shared/new-task.js'
import { announceChange, listen, openItem, openPortfolio, openProject, openWorkflow, post, rpc } from './shared/work.js'

/**
 * @typedef {import('./shared/types.js').PortfolioSummary} PortfolioSummary
 * @typedef {import('./shared/types.js').Portfolio} Portfolio
 * @typedef {import('./shared/types.js').Project} Project
 * @typedef {import('./shared/types.js').ItemSummary} ItemSummary
 * @typedef {import('./shared/types.js').FindResult} FindResult
 * @typedef {import('./shared/logic.js').Viewing} Viewing
 */

const DOING_LIMIT = 200
const FIND_LIMIT = 50
const FIND_DELAY_MS = 150

const browse = /** @type {HTMLElement} */ (document.getElementById('browse'))
const list = /** @type {HTMLElement} */ (document.getElementById('list'))
const find = /** @type {HTMLInputElement} */ (document.getElementById('find'))
const newSection = /** @type {HTMLElement} */ (document.getElementById('new'))

const state = {
  /** @type {PortfolioSummary[] | null} */
  portfolios: null,
  /** @type {FindResult | null} */
  doing: null,
  /** @type {string | null} */
  error: null,
  query: '',
  /** @type {FindResult | null} */
  results: null,
  /** @type {string | null} */
  findError: null,
  /** Portfolio uids the user folded. */
  collapsed: new Set(stored('collapsed', /** @type {number[]} */ ([]))),
  /** What each of the plugin's tabs on screen shows, by tab. */
  viewing: /** @type {Map<string, Viewing & { at: number }>} */ (new Map())
}

// ---------------------------------------------------------------------------
// Reading

let loadSeq = 0

async function refresh() {
  const seq = ++loadSeq
  try {
    const [portfolios, doing] = await Promise.all([
      rpc('listPortfolios'),
      rpc('findItems', { groups: ['active'], kind: 'task', limit: DOING_LIMIT })
    ])
    if (seq !== loadSeq) return
    state.portfolios = /** @type {PortfolioSummary[]} */ (portfolios)
    state.doing = /** @type {FindResult} */ (doing)
    state.error = null
  } catch (error) {
    if (seq !== loadSeq) return
    state.error = messageOf(error)
  }
  if (state.query !== '') await search()
  render()
}

let findSeq = 0
/** @type {ReturnType<typeof setTimeout> | undefined} */
let findTimer

async function search() {
  const seq = ++findSeq
  const text = state.query
  if (text === '') {
    state.results = null
    state.findError = null
    return
  }
  try {
    const found = /** @type {FindResult} */ (await rpc('findItems', { text, limit: FIND_LIMIT }))
    if (seq !== findSeq) return
    state.results = { items: exactIdFirst(found.items, text), total: found.total }
    state.findError = null
  } catch (error) {
    if (seq !== findSeq) return
    state.results = null
    state.findError = messageOf(error)
  }
}

// ---------------------------------------------------------------------------
// Drawing

function render() {
  if (state.portfolios === null || state.doing === null) {
    fill(list, state.error === null ? [] : [failed(state.error)])
    return
  }
  if (state.query !== '') {
    fill(list, findResults())
    return
  }
  fill(list, [...doingNow(state.doing), ...portfolioTree(state.portfolios)])
}

/** @param {string} message */
function failed(message) {
  return el('div', { class: 'state', attrs: { role: 'alert' } }, [
    el('p', { class: 'state-title', text: 'The Trackr service did not answer' }),
    el('p', { class: 'state-text', text: message }),
    el('button', { class: 'helm-button', text: 'Try again', attrs: { type: 'button' }, on: { click: () => void refresh() } })
  ])
}

function findResults() {
  if (state.findError !== null) return [el('p', { class: 'quiet', attrs: { role: 'alert' }, text: state.findError })]
  if (state.results === null) return []
  const { items, total } = state.results
  if (items.length === 0) return [el('p', { class: 'quiet', text: `Nothing matches “${state.query}”.` })]
  const counted = total > items.length ? `first ${items.length} of ${total}` : String(total)
  return [
    el('div', { class: 'cap-row' }, [el('span', { class: 'work-cap', text: 'Found' }), el('span', { class: 'work-grow' }), el('span', { class: 'cap-note', text: counted })]),
    ...items.map((item) => itemRow(item, { showProject: true, current: isViewing('item', item.uid), onOpen: () => void openItem(item) }))
  ]
}

/** @param {FindResult} doing */
function doingNow(doing) {
  const head = el('div', { class: 'cap-row' }, [
    el('span', { class: 'work-cap', text: 'Doing now' }),
    el('span', { class: 'work-grow' }),
    el('span', { class: 'cap-note', text: 'all portfolios' })
  ])
  if (doing.items.length === 0) return [head, el('p', { class: 'quiet', text: 'Nothing in progress.' })]
  const cards = doing.items.map(doingCard)
  const more = doing.total > doing.items.length ? el('p', { class: 'quiet', text: `${doing.total - doing.items.length} more in progress.` }) : null
  return [head, ...cards, more]
}

/** @param {ItemSummary} item */
function doingCard(item) {
  const session = item.session
  const activeAt = session?.activeAt ? timeLabel(session.activeAt) : ''
  return el(
    'button',
    {
      class: 'dn',
      title: `${item.id} ${item.title}\n${item.status.name} · ${item.portfolio.key} ${item.project.name}${session ? `\n${session.name}${activeAt ? `, last active ${activeAt}` : ''}` : ''}`,
      attrs: { type: 'button', 'aria-current': isViewing('item', item.uid) ? 'true' : null },
      on: { click: () => void openItem(item) }
    },
    [
      el('span', { class: 'dn-line' }, [
        statusIcon(item.status, 13),
        el('span', { class: 'work-id', text: item.id }),
        el('span', { class: 'work-ellip work-grow', text: item.title })
      ]),
      el('span', { class: 'dn-meta' }, [
        swatch(item.project.colour, 7),
        el('span', { text: item.project.name }),
        session ? el('span', { text: '·' }) : null,
        session ? el('span', { class: 'work-ellip dn-session', text: session.name }) : null
      ])
    ]
  )
}

/** @param {PortfolioSummary[]} portfolios */
function portfolioTree(portfolios) {
  const head = el('div', { class: 'cap-row later' }, [
    el('span', { class: 'work-cap', text: 'Portfolios' }),
    el('span', { class: 'work-grow' }),
    el('button', { class: 'cap-add', title: 'New portfolio', attrs: { type: 'button', 'aria-label': 'New portfolio' }, on: { click: () => openNewPortfolio() } }, [
      lineIcon(ICONS.plus, 12, 1.8)
    ])
  ])
  if (portfolios.length === 0) {
    return [
      head,
      el('div', { class: 'empty' }, [
        el('p', { class: 'quiet', text: 'No portfolios yet. A portfolio holds projects, and its key starts every ID, like TC-123.' }),
        el('button', { class: 'helm-button', attrs: { type: 'button', 'data-variant': 'primary' }, on: { click: () => openNewPortfolio() } }, [
          lineIcon(ICONS.plus, 12, 1.8),
          'New portfolio'
        ])
      ])
    ]
  }
  const keyWidth = Math.min(4, Math.max(...portfolios.map((portfolio) => portfolio.key.length)))
  return [head, ...portfolios.flatMap((portfolio) => portfolioRows(portfolio, keyWidth))]
}

/**
 * @param {PortfolioSummary} portfolio
 * @param {number} keyWidth the longest key in the tree, in letters, up to 4
 */
function portfolioRows(portfolio, keyWidth) {
  const open = !state.collapsed.has(portfolio.uid)
  const count = openCount(portfolio)
  const row = el('div', { class: 'prow', attrs: { 'aria-current': isViewing('portfolio', portfolio.uid) ? 'true' : null } }, [
    el(
      'button',
      {
        class: 'prow-main',
        title: `${portfolio.name} (${portfolio.key})`,
        attrs: { type: 'button' },
        on: {
          click: () => {
            setCollapsed(portfolio.uid, false)
            void openPortfolio(portfolio)
          }
        }
      },
      [
        el('span', { class: 'work-tile', text: portfolio.key.slice(0, 4), attrs: { 'data-width': keyWidth } }),
        el('span', { class: 'work-ellip work-grow prow-name', text: portfolio.name }),
        el('span', { class: 'count', title: plural(count, 'open task'), text: String(count) })
      ]
    ),
    el(
      'button',
      {
        class: 'prow-add',
        title: `New project in ${portfolio.name}`,
        attrs: { type: 'button', 'aria-label': `New project in ${portfolio.name}` },
        on: { click: () => void openWorkflow(portfolio, 'new') }
      },
      [lineIcon(ICONS.plus, 12, 1.8)]
    ),
    el(
      'button',
      {
        class: 'chev',
        attrs: { type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-label': `${open ? 'Fold' : 'Unfold'} ${portfolio.name}` },
        on: { click: () => setCollapsed(portfolio.uid, open) }
      },
      [lineIcon(open ? ICONS.chevronDown : ICONS.chevronRight, 12, 2)]
    )
  ])
  if (!open) return [row]
  const projects = el(
    'div',
    { class: 'projects' },
    portfolio.projects.length === 0
      ? [
          el('button', { class: 'jrow jrow-add', attrs: { type: 'button' }, on: { click: () => void openWorkflow(portfolio, 'new') } }, [
            lineIcon(ICONS.plus, 10, 2),
            el('span', { class: 'work-ellip work-grow', text: 'Add a project' })
          ])
        ]
      : portfolio.projects.map(projectRow)
  )
  return [row, projects]
}

/** @param {Project} project */
function projectRow(project) {
  return el(
    'button',
    {
      class: 'jrow',
      title: project.folders.length > 0 ? `${project.name}\n${project.folders.join('\n')}` : project.name,
      attrs: { type: 'button', 'aria-current': isViewing('project', project.uid) ? 'true' : null },
      on: { click: () => void openProject(project) }
    },
    [
      swatch(project.colour, 8),
      el('span', { class: 'work-ellip work-grow', text: project.name }),
      el('span', { class: 'count', title: plural(project.counts.open, 'open task'), text: String(project.counts.open) })
    ]
  )
}

/**
 * @param {number} uid
 * @param {boolean} collapsed
 */
function setCollapsed(uid, collapsed) {
  if (collapsed) state.collapsed.add(uid)
  else state.collapsed.delete(uid)
  store('collapsed', [...state.collapsed])
  render()
}

// ---------------------------------------------------------------------------
// What the tabs show

/**
 * @param {Viewing['kind']} kind
 * @param {number} uid
 */
function isViewing(kind, uid) {
  for (const view of state.viewing.values()) if (view.kind === kind && view.uid === uid) return true
  return false
}

/** Tabs on screen, the most recently shown first. */
function viewingNow() {
  return [...state.viewing.values()].sort((a, b) => b.at - a.at)
}

// ---------------------------------------------------------------------------
// Find

find.addEventListener('input', () => {
  state.query = find.value.trim()
  clearTimeout(findTimer)
  if (state.query === '') {
    findSeq += 1
    state.results = null
    state.findError = null
    render()
    return
  }
  findTimer = setTimeout(async () => {
    await search()
    render()
  }, FIND_DELAY_MS)
})

find.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && find.value !== '') {
    event.preventDefault()
    find.value = ''
    find.dispatchEvent(new Event('input'))
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const first = state.results?.items[0]
    if (first && state.query !== '') void openItem(first)
  } else if (event.key === 'ArrowDown') {
    const first = list.querySelector('button')
    if (first) {
      event.preventDefault()
      first.focus()
    }
  }
})

// Up and down move between the rows of the list.
list.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const buttons = /** @type {HTMLButtonElement[]} */ ([...list.querySelectorAll('button')])
  const index = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement))
  if (index === -1) return
  event.preventDefault()
  if (event.key === 'ArrowUp' && index === 0) find.focus()
  else buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))].focus()
})

// ---------------------------------------------------------------------------
// Forms: a new task, a new portfolio. Either takes the list's place.

/** @type {{ kind: 'task' | 'portfolio', submit(): void, destroy(): void, focus(): void } | null} */
let form = null
let formSeq = 0

async function openTask() {
  if (form?.kind === 'task') {
    form.focus()
    return
  }
  const seq = ++formSeq
  if (state.portfolios === null) await refresh()
  const portfolios = state.portfolios
  if (portfolios === null || seq !== formSeq) return
  const projects = portfolios.flatMap((portfolio) => portfolio.projects)
  if (projects.length === 0) {
    if (portfolios.length === 0) {
      toast('Add a portfolio first.')
      void openNewPortfolio()
    } else {
      toast('Add a project first: + on a portfolio’s row makes one.')
    }
    return
  }
  const projectUid = /** @type {number} */ (defaultProject(projects, viewingNow(), lastProject()))
  let choices
  try {
    choices = await taskChoices(projects.find((project) => project.uid === projectUid)?.portfolio.uid ?? projects[0].portfolio.uid)
  } catch (error) {
    toast(messageOf(error))
    return
  }
  if (seq !== formSeq) return
  closeForm(false)
  const made = taskForm({
    portfolios,
    projectUid,
    choices,
    hint: 'Ctrl Enter creates it. Acceptance criteria, links and dependencies go on it once it exists.',
    onCreated: () => {
      closeForm()
      void refresh()
    },
    onKind: (kind) => {
      const heading = newSection.querySelector('.new-head-title')
      if (heading) heading.textContent = kind === 'epic' ? 'New epic' : 'New task'
    }
  })
  showForm('New task', made.next, made.body, made.create)
  form = { kind: 'task', submit: () => void made.submit(), destroy: made.destroy, focus: () => made.title.focus() }
  made.title.focus()
}

function openNewPortfolio() {
  if (form?.kind === 'portfolio') {
    form.focus()
    return
  }
  formSeq += 1
  closeForm(false)
  let alive = true
  let busy = false
  let keyTouched = false
  const name = /** @type {HTMLInputElement} */ (
    el('input', {
      class: 'helm-input work-form-title',
      attrs: { type: 'text', 'aria-label': 'Name', placeholder: 'Name, like TideCast', maxlength: 120, autocomplete: 'off' }
    })
  )
  const key = /** @type {HTMLInputElement} */ (
    el('input', {
      class: 'helm-input work-mono key-field',
      attrs: { type: 'text', 'aria-label': 'Key', placeholder: 'TC', maxlength: 10, autocomplete: 'off', spellcheck: 'false' }
    })
  )
  const description = /** @type {HTMLTextAreaElement} */ (
    el('textarea', {
      class: 'helm-textarea portfolio-description',
      attrs: { 'aria-label': 'Description', placeholder: 'What it covers, in a line', maxlength: 2000 }
    })
  )
  const example = el('span', { class: 'work-mono' })
  const error = el('p', { class: 'work-dialog-error', attrs: { role: 'alert', hidden: true } })
  const create = /** @type {HTMLButtonElement} */ (
    el('button', { class: 'helm-button', text: 'Create portfolio', attrs: { type: 'button', 'data-variant': 'primary' } })
  )

  const showExample = () => {
    const shown = key.value.trim().toUpperCase()
    example.textContent = PORTFOLIO_KEY.test(shown) ? `${shown}-1` : 'TC-1'
  }
  /** @param {string | null} message */
  const showError = (message) => {
    error.textContent = message ?? ''
    error.hidden = message === null
  }

  name.addEventListener('input', () => {
    if (!keyTouched) key.value = suggestKey(name.value)
    showExample()
    showError(null)
  })
  key.addEventListener('input', () => {
    keyTouched = key.value !== ''
    const caret = key.selectionStart
    key.value = key.value.toUpperCase()
    key.setSelectionRange(caret, caret)
    showExample()
    showError(null)
  })

  async function submit() {
    if (busy || !alive) return
    const keyText = key.value.trim().toUpperCase()
    if (name.value.trim() === '') {
      showError('A portfolio needs a name.')
      name.focus()
      return
    }
    if (!PORTFOLIO_KEY.test(keyText)) {
      showError('A key is a letter, then up to nine letters or digits, like TC or HELM.')
      key.focus()
      return
    }
    busy = true
    create.disabled = true
    try {
      const portfolio = /** @type {Portfolio} */ (
        await rpc('createPortfolio', { key: keyText, name: name.value, description: description.value })
      )
      if (!alive) return
      closeForm()
      toast(`Created ${portfolio.name}. Its workflow is open: add its projects there.`)
      void openWorkflow(portfolio)
      announceChange()
      void refresh()
    } catch (failure) {
      showError(messageOf(failure))
    } finally {
      busy = false
      create.disabled = false
    }
  }

  create.addEventListener('click', () => void submit())
  for (const input of [name, key]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        event.preventDefault()
        void submit()
      }
    })
  }
  showExample()
  showForm('New portfolio', null, [
    name,
    el('label', { class: 'work-dialog-field' }, [el('span', { text: 'Key' }), key]),
    el('p', { class: 'work-form-hint' }, ['The key starts every ID in it, like ', example, '. It can change later; the IDs change with it.']),
    el('label', { class: 'work-dialog-field' }, [el('span', { text: 'Description' }), description]),
    el('p', {
      class: 'work-form-hint',
      text: 'It starts with the usual statuses and priorities. Its Workflow page, which opens next, adds projects and changes the rest.'
    }),
    error
  ], create)
  form = {
    kind: 'portfolio',
    submit: () => void submit(),
    destroy: () => {
      alive = false
    },
    focus: () => name.focus()
  }
  name.focus()
}

/**
 * Puts a form in the list's place.
 *
 * @param {string} title
 * @param {Node | null} meta
 * @param {Node[]} body
 * @param {HTMLButtonElement} create
 */
function showForm(title, meta, body, create) {
  const cancel = el('button', { class: 'helm-button', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => closeForm() } })
  const close = el('button', { class: 'helm-icon-button', attrs: { type: 'button', 'aria-label': 'Close', title: 'Close' }, on: { click: () => closeForm() } }, [
    lineIcon(ICONS.close, 13, 2)
  ])
  fill(newSection, [
    el('div', { class: 'new-head' }, [el('span', { class: 'new-head-title', text: title }), meta, el('span', { class: 'work-grow' }), close]),
    el('div', { class: 'new-body' }, body),
    el('div', { class: 'new-foot' }, [cancel, create])
  ])
  newSection.setAttribute('aria-label', title)
  browse.hidden = true
  newSection.hidden = false
}

/** @param {KeyboardEvent} event */
function onFormKey(event) {
  if (!form) return
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    form.submit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeForm()
  }
}

/** @param {boolean} [refocus] whether the find field takes the focus back */
function closeForm(refocus = true) {
  if (!form) return
  form.destroy()
  form = null
  newSection.hidden = true
  newSection.replaceChildren()
  browse.hidden = false
  if (refocus) find.focus()
}

newSection.addEventListener('keydown', onFormKey)

// ---------------------------------------------------------------------------
// Small things

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {number} n
 * @param {string} noun
 */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
function stored(key, fallback) {
  try {
    const raw = localStorage.getItem(`trackr.panel.${key}`)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function store(key, value) {
  try {
    localStorage.setItem(`trackr.panel.${key}`, JSON.stringify(value))
  } catch {
    // A preference only; the panel works without it.
  }
}

// ---------------------------------------------------------------------------
// Wiring

listen((message) => {
  if (message.type === 'changed') {
    void refresh()
  } else if (message.type === 'view') {
    if (message.visible) {
      state.viewing.set(message.tab, {
        kind: message.kind,
        uid: message.uid,
        portfolio: message.portfolio,
        project: message.project,
        at: message.at
      })
    } else {
      state.viewing.delete(message.tab)
    }
    render()
  }
})

helm.on('action', ({ id }) => {
  if (id === 'new') void openTask()
  else if (id === 'refresh') void refresh()
})

helm.on('visibility', (visible) => {
  if (visible) void refresh()
})

post({ type: 'who' })
void refresh()
