/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * The new task form: title, project, epic, status, priority and description.
 * A toggle makes it an epic instead, which has a home project and goes in an
 * initiative rather than an epic, or an initiative, which goes in neither.
 * The panel shows it in place of its list; a tab shows it in a dialog.
 * Either way Ctrl Enter creates it, and it opens in a tab.
 */

import { openDialog } from './dialog.js'
import { el, fill, selectFace, toast } from './dom.js'
import { carryOption } from './logic.js'
import { announceChange, openItem, rpc } from './work.js'

/**
 * @typedef {import('./types.js').PortfolioSummary} PortfolioSummary
 * @typedef {import('./types.js').Portfolio} Portfolio
 * @typedef {import('./types.js').ItemSummary} ItemSummary
 * @typedef {import('./types.js').Item} Item
 * @typedef {import('./types.js').FindResult} FindResult
 * @typedef {{ portfolio: Portfolio, epics: ItemSummary[], initiatives: ItemSummary[] }} Choices
 * @typedef {'task' | 'epic' | 'initiative'} Kind
 * @typedef {{
 *   next: HTMLElement,
 *   body: Node[],
 *   create: HTMLButtonElement,
 *   title: HTMLInputElement,
 *   kind(): Kind,
 *   submit(): Promise<void>,
 *   destroy(): void
 * }} TaskForm
 */

const LAST_PROJECT = 'trackr.panel.lastProject'

/** The project the last task was created in, if it is remembered. */
export function lastProject() {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_PROJECT) ?? 'null')
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

/**
 * The status, priority, epic and initiative choices of one portfolio.
 *
 * @param {number} portfolioUid
 * @returns {Promise<Choices>}
 */
export async function taskChoices(portfolioUid) {
  const [portfolio, epics, initiatives] = await Promise.all([
    rpc('getPortfolio', portfolioUid),
    rpc('findItems', { portfolio: portfolioUid, kind: 'epic', open: true, limit: 500 }),
    rpc('findItems', { portfolio: portfolioUid, kind: 'initiative', open: true, limit: 500 })
  ])
  return {
    portfolio: /** @type {Portfolio} */ (portfolio),
    epics: /** @type {FindResult} */ (epics).items,
    initiatives: /** @type {FindResult} */ (initiatives).items
  }
}

/** What each kind is called, what its title asks for, and what it goes in. */
const KINDS = /** @type {const} */ ({
  task: { label: 'Task', placeholder: 'What needs doing', parent: 'Epic', none: 'No epic', project: 'Project' },
  epic: { label: 'Epic', placeholder: 'What it delivers', parent: 'Initiative', none: 'No initiative', project: 'Home project' },
  initiative: { label: 'Initiative', placeholder: 'The effort its epics add up to', parent: 'Inside', none: 'Nothing: it holds epics', project: 'Home project' }
})

/**
 * Builds the form. The host lays out `next` (the ID it will get), `body` and
 * `create`, and closes itself in `onCreated`. `hint` is the line under the
 * description; `onKind` lets the host retitle itself for an epic.
 *
 * @param {{ portfolios: PortfolioSummary[], projectUid: number, choices: Choices, hint: string,
 *   onCreated: (item: Item) => void, onKind?: (kind: Kind) => void }} options
 * @returns {TaskForm}
 */
export function taskForm({ portfolios, projectUid, choices, hint, onCreated, onKind }) {
  let current = choices
  let alive = true
  let busy = false
  /** @type {Kind} */
  let kind = 'task'

  const title = /** @type {HTMLInputElement} */ (
    el('input', {
      class: 'helm-input work-form-title',
      attrs: { type: 'text', 'aria-label': 'Title', placeholder: 'What needs doing', maxlength: 300, autocomplete: 'off' }
    })
  )
  const project = /** @type {HTMLSelectElement} */ (
    el(
      'select',
      { class: 'helm-select' },
      [
        selectFace(),
        ...portfolios
          .filter((portfolio) => portfolio.projects.length > 0)
          .map((portfolio) =>
            el(
              'optgroup',
              { attrs: { label: `${portfolio.key} · ${portfolio.name}` } },
              portfolio.projects.map((option) => el('option', { text: option.name, attrs: { value: option.uid } }))
            )
          )
      ]
    )
  )
  project.value = String(projectUid)
  /** The epic a task goes in, or the initiative an epic goes in. */
  const parent = /** @type {HTMLSelectElement} */ (el('select', { class: 'helm-select' }))
  const status = /** @type {HTMLSelectElement} */ (el('select', { class: 'helm-select' }))
  const priority = /** @type {HTMLSelectElement} */ (el('select', { class: 'helm-select' }))
  const description = /** @type {HTMLTextAreaElement} */ (
    el('textarea', {
      class: 'helm-textarea work-form-description',
      attrs: { 'aria-label': 'Description', placeholder: 'Description: context, the fix direction, anything the next session needs', maxlength: 100000 }
    })
  )
  const next = el('span', { class: 'work-id', title: 'The ID it gets, unless something else is created first' })
  const projectLabel = el('span', { text: 'Project' })
  const parentLabel = el('span', { text: 'Epic' })
  const parentField = el('label', { class: 'work-dialog-field' }, [parentLabel, parent])
  const order = /** @type {const} */ (['task', 'epic', 'initiative'])
  const kinds = order.map((value) =>
    el('button', {
      class: 'work-kind',
      text: KINDS[value].label,
      attrs: { type: 'button', 'aria-pressed': value === kind ? 'true' : 'false' },
      on: { click: () => setKind(value) }
    })
  )

  /** @param {Kind} value */
  function setKind(value) {
    if (value === kind) return
    kind = value
    kinds.forEach((button, index) => button.setAttribute('aria-pressed', String(order[index] === kind)))
    const words = KINDS[kind]
    parentLabel.textContent = words.parent
    parent.disabled = kind === 'initiative'
    parentField.title = kind === 'initiative' ? 'An initiative is the top: it holds epics.' : ''
    projectLabel.textContent = words.project
    title.placeholder = words.placeholder
    create.textContent = `Create ${kind}`
    fillParent()
    onKind?.(kind)
    title.focus()
  }

  /** The parent choices for the kind: open epics for a task, open initiatives for an epic. */
  function fillParent() {
    const options = kind === 'task' ? current.epics : kind === 'epic' ? current.initiatives : []
    fill(parent, [
      selectFace(),
      el('option', { text: KINDS[kind].none, attrs: { value: '' } }),
      ...options.map((option) => el('option', { text: `${option.id} ${option.title}`, attrs: { value: option.uid } }))
    ])
    parent.value = ''
  }
  const error = el('p', { class: 'work-dialog-error', attrs: { role: 'alert', hidden: true } })
  const create = /** @type {HTMLButtonElement} */ (
    el('button', { class: 'helm-button', text: 'Create task', attrs: { type: 'button', 'data-variant': 'primary' } })
  )

  /**
   * Fills the parent, status and priority choices, keeping a status or
   * priority of the same name.
   *
   * @param {string | null} statusName
   * @param {string | null} priorityName
   */
  function setChoices(statusName, priorityName) {
    const { portfolio } = current
    next.textContent = `${portfolio.key}-${portfolio.nextNumber}`
    fillParent()
    fill(status, [selectFace(), ...portfolio.statuses.map((option) => el('option', { text: option.name, attrs: { value: option.uid } }))])
    fill(priority, [selectFace(), ...portfolio.priorities.map((option) => el('option', { text: option.name, attrs: { value: option.uid } }))])
    status.value = String(carryOption(portfolio.statuses, statusName))
    priority.value = String(carryOption(portfolio.priorities, priorityName))
  }

  /** @param {string | null} message */
  function showError(message) {
    error.textContent = message ?? ''
    error.hidden = message === null
  }

  async function projectChanged() {
    const projectUidNow = Number(project.value)
    const chosen = portfolios.flatMap((portfolio) => portfolio.projects).find((option) => option.uid === projectUidNow)
    if (!chosen || chosen.portfolio.uid === current.portfolio.uid) return
    const statusName = status.selectedOptions[0]?.textContent ?? null
    const priorityName = priority.selectedOptions[0]?.textContent ?? null
    try {
      const loaded = await taskChoices(chosen.portfolio.uid)
      if (!alive || Number(project.value) !== projectUidNow) return
      current = loaded
      setChoices(statusName, priorityName)
      showError(null)
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  async function submit() {
    if (busy || !alive) return
    const text = title.value.trim()
    if (text === '') {
      title.setAttribute('aria-invalid', 'true')
      showError(`${kind === 'task' ? 'A task' : `An ${kind}`} needs a title.`)
      title.focus()
      return
    }
    busy = true
    create.disabled = true
    try {
      const item = /** @type {Item} */ (
        await rpc('createItem', {
          kind,
          project: Number(project.value),
          epic: kind === 'task' && parent.value !== '' ? Number(parent.value) : null,
          initiative: kind === 'epic' && parent.value !== '' ? Number(parent.value) : null,
          title: text,
          description: description.value,
          status: Number(status.value),
          priority: Number(priority.value)
        })
      )
      if (!alive) return
      try {
        localStorage.setItem(LAST_PROJECT, JSON.stringify(item.project.uid))
      } catch {
        // A preference only.
      }
      onCreated(item)
      const under = item.epic ?? (item.kind === 'epic' ? item.initiative : null)
      toast(`Created ${item.id} in ${item.project.name}${under ? `, under ${under.id}` : ''}`)
      void openItem(item)
      announceChange()
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      busy = false
      create.disabled = false
    }
  }

  setChoices(null, null)
  project.addEventListener('change', () => void projectChanged())
  title.addEventListener('input', () => {
    title.removeAttribute('aria-invalid')
    showError(null)
  })
  create.addEventListener('click', () => void submit())

  return {
    next,
    title,
    create,
    submit,
    kind: () => kind,
    body: [
      el('div', { class: 'work-kinds', attrs: { role: 'group', 'aria-label': 'Kind' } }, kinds),
      title,
      el('div', { class: 'work-form-grid' }, [
        el('label', { class: 'work-dialog-field' }, [projectLabel, project]),
        parentField,
        field('Status', status),
        field('Priority', priority)
      ]),
      description,
      el('p', { class: 'work-form-hint', text: hint }),
      error
    ],
    destroy() {
      alive = false
    }
  }
}

let dialogOpen = false

/**
 * The form in a dialog, for a tab. The project starts as `projectUid`, else
 * the last one a task was created in when it is in this portfolio, else the
 * portfolio's first.
 *
 * @param {number} portfolioUid
 * @param {number | null} projectUid
 */
export async function openTaskDialog(portfolioUid, projectUid) {
  if (dialogOpen) return
  dialogOpen = true
  try {
    const portfolios = /** @type {PortfolioSummary[]} */ (await rpc('listPortfolios'))
    const projects = portfolios.flatMap((portfolio) => portfolio.projects)
    const mine = projects.filter((project) => project.portfolio.uid === portfolioUid)
    const last = lastProject()
    const start =
      mine.find((project) => project.uid === projectUid) ??
      mine.find((project) => project.uid === last) ??
      mine[0] ??
      projects[0]
    if (start === undefined) {
      toast('Add a project first: Workflow has the projects.')
      dialogOpen = false
      return
    }
    const choices = await taskChoices(start.portfolio.uid)
    /** @type {import('./dialog.js').DialogHandle | null} */
    let dialog = null
    const form = taskForm({
      portfolios,
      projectUid: start.uid,
      choices,
      hint: 'Acceptance criteria, links and dependencies go on it once it exists.',
      onCreated: () => dialog?.close(),
      onKind: (kind) => {
        const heading = dialog?.node.querySelector('.work-dialog-title')
        if (heading) heading.textContent = `New ${kind}`
      }
    })
    const cancel = el('button', { class: 'helm-button', text: 'Cancel', attrs: { type: 'button' } })
    dialog = openDialog({
      label: 'New task',
      meta: form.next,
      width: 520,
      body: form.body,
      foot: [el('span', { class: 'work-dialog-hint', text: 'Ctrl Enter creates' }), el('span', { class: 'work-grow' }), cancel, form.create],
      onClose: () => {
        form.destroy()
        dialogOpen = false
      }
    })
    const opened = dialog
    cancel.addEventListener('click', () => opened.close())
    opened.node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        void form.submit()
      }
    })
    form.title.focus()
  } catch (failure) {
    dialogOpen = false
    toast(failure instanceof Error ? failure.message : String(failure))
  }
}

/**
 * @param {string} label
 * @param {HTMLElement} control
 */
function field(label, control) {
  return el('label', { class: 'work-dialog-field' }, [el('span', { text: label }), control])
}
