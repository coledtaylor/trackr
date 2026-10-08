/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * A portfolio's workflow: its statuses in their groups, its priorities, its
 * projects with their colours and folders, and the portfolio itself (name,
 * key, description). Everything is edited in place; rows are put in order by
 * dragging; a delete asks first, in a dialog. The v2 board's workflow page.
 */

import { TRASH, confirmDanger } from '../shared/dialog.js'
import { ICONS, el, lineIcon, priorityGlyph, redraw, selectFace, statusIcon, swatch, tile, toast } from '../shared/dom.js'
import { PORTFOLIO_KEY, STATUS_GROUPS, moved, priorityMark, replacementStatus, statusOrder, statusesByGroup } from '../shared/logic.js'
import { dragHandle } from '../shared/sortable.js'
import { announceChange, openPortfolio, openProject, rpc, takeFocus } from '../shared/work.js'
import { button, createEditing, editorActions, iconButton, lineField } from './edit.js'

/**
 * @typedef {import('../shared/types.js').PortfolioSettings} PortfolioSettings
 * @typedef {import('../shared/types.js').Status} Status
 * @typedef {import('../shared/types.js').Priority} Priority
 * @typedef {import('../shared/types.js').PlacedProject} PlacedProject
 * @typedef {import('./parts.js').Host} Host
 * @typedef {import('./parts.js').View} View
 * @typedef {import('./edit.js').Editing} Editing
 */

/** The status icon shapes, with what each is called. */
const ICON_NAMES = {
  backlog: 'Backlog',
  planning: 'Planning',
  todo: 'To do',
  doing: 'In progress',
  review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  launch: 'Launched',
  cancelled: 'Cancelled'
}

/** The theme tones a status can take, then the project colours. */
const STATUS_COLOURS = {
  subtle: 'Faint',
  muted: 'Grey',
  accent: 'Accent',
  warn: 'Warning',
  danger: 'Danger',
  success: 'Success',
  blue: 'Blue',
  orange: 'Orange',
  green: 'Green',
  amber: 'Amber',
  pink: 'Pink'
}

const PROJECT_COLOURS = ['blue', 'orange', 'green', 'amber', 'pink']

/** What a new status in each group starts as. */
const GROUP_DEFAULTS = {
  'not-started': { icon: 'todo', colour: 'muted' },
  active: { icon: 'doing', colour: 'accent' },
  done: { icon: 'done', colour: 'success' },
  closed: { icon: 'cancelled', colour: 'subtle' }
}

/**
 * @param {HTMLElement} root
 * @param {number} uid the portfolio
 * @param {Host} host
 * @returns {View}
 */
export function createWorkflowView(root, uid, host) {
  /** @type {PortfolioSettings | null} */
  let data = null
  let first = true
  const editing = createEditing(uid, host, draw)

  function draw() {
    const shown = data
    if (shown === null) return
    root.className = 'view-workflow it wf'
    redraw(root, () => [
      head(shown),
      el('div', { class: 'wf-body' }, [
        statusesCard(shown),
        el('div', { class: 'wf-side' }, [prioritiesCard(shown), projectsCard(shown), portfolioCard(shown)])
      ])
    ])
  }

  /**
   * One write; the other pages are told and this one reads again.
   *
   * @param {string} method
   * @param {...unknown} args
   */
  async function write(method, ...args) {
    return (await editing.call(method, ...args)) !== undefined
  }

  /** After a write a dialog made itself: tell the other pages, read again. */
  function written() {
    announceChange()
    host.reload()
  }

  /**
   * Opens an editor and brings it into view.
   *
   * @param {string} key
   */
  function startEditor(key) {
    editing.start(key, `${key}.name`)
    root.querySelector(`[data-editor="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Opens the project editor another page asked for: the new project's, or
   * one of this portfolio's projects'.
   *
   * @returns {boolean} whether it did
   */
  function takeProjectFocus() {
    const project = takeFocus(uid)
    if (project === 'new') {
      startEditor('project.new')
      return true
    }
    if (project === null || !data?.portfolio.projects.some((candidate) => candidate.uid === project)) return false
    startEditor(`project.${project}`)
    return true
  }

  // -------------------------------------------------------------------------
  // Header

  /** @param {PortfolioSettings} settings */
  function head(settings) {
    const { portfolio } = settings
    return el('header', { class: 'wf-head' }, [
      el('span', { class: 'wf-tile' }, [lineIcon(ICONS.sliders, 19, 1.6)]),
      el('div', { class: 'wf-title' }, [
        el('nav', { class: 'it-crumbs', attrs: { 'aria-label': 'Where this is' } }, [
          el('button', { class: 'crumb', text: portfolio.name, attrs: { type: 'button' }, on: { click: () => void openPortfolio(portfolio) } }),
          el('span', { class: 'crumb-sep', text: '›' }),
          el('span', { text: 'Settings' })
        ]),
        el('h1', { class: 'wf-h1', text: 'Workflow' })
      ])
    ])
  }

  // -------------------------------------------------------------------------
  // Statuses

  /** @param {PortfolioSettings} settings */
  function statusesCard(settings) {
    return el('section', { class: 'it-card wf-card' }, [
      el('h2', { class: 'it-h2', text: 'Statuses' }),
      el('p', {
        class: 'wf-note',
        text: `Every epic and task in ${settings.portfolio.name} uses these. The group is what a status means to Helm and to agents, whatever it is called.`
      }),
      ...statusesByGroup(settings.portfolio.statuses).map((group) => {
        const addKey = `status.new.${group.group}`
        return el('div', { class: 'wf-group' }, [
          el('div', { class: 'wf-group-head' }, [el('span', { class: 'work-cap', text: group.label }), el('span', { class: 'wf-meaning', text: group.meaning })]),
          el('div', { class: 'wf-list' }, [
            ...group.statuses.map((status, index) =>
              editing.isOpen(`status.${status.uid}`) ? statusEditor(settings, status, group.group) : statusRow(settings, status, index, group)
            ),
            editing.isOpen(addKey) ? statusEditor(settings, null, group.group) : addRow('Add a status', () => startEditor(addKey))
          ])
        ])
      })
    ])
  }

  /**
   * @param {PortfolioSettings} settings
   * @param {Status} status
   * @param {number} index inside its group
   * @param {{ group: string, statuses: Status[] }} group
   */
  function statusRow(settings, status, index, group) {
    const count = settings.uses.statuses[status.uid] ?? 0
    return el('div', { class: 'wf-row', attrs: { 'data-sort-row': true } }, [
      dragHandle({
        label: status.name,
        index,
        count: group.statuses.length,
        focusKey: `status.grip.${status.uid}`,
        onMove: (to) => void write('reorderStatuses', settings.portfolio.uid, statusOrder(settings.portfolio.statuses, group.group, index, to))
      }),
      statusIcon(status, 15),
      el('span', { class: 'wf-name work-ellip', text: status.name }),
      status.isDefault ? el('span', { class: 'wf-tag', text: 'new tasks start here' }) : null,
      el('span', { class: 'it-grow' }),
      uses(count),
      iconButton(`Edit ${status.name}`, ICONS.pencil, () => startEditor(`status.${status.uid}`)),
      deleteButton(
        `Delete ${status.name}`,
        status.isDefault ? `${status.name} is where new tasks start. Make another status the default first.` : null,
        () => void deleteStatus(settings, status, count)
      )
    ])
  }

  /**
   * The fields of a status, in place of its row, or at the end of a group for
   * a new one.
   *
   * @param {PortfolioSettings} settings
   * @param {Status | null} status null for a new one
   * @param {keyof GROUP_DEFAULTS} group
   */
  function statusEditor(settings, status, group) {
    const key = status ? `status.${status.uid}` : `status.new.${group}`
    const icon = hidden(`${key}.icon`, status?.icon ?? GROUP_DEFAULTS[group].icon)
    const colour = hidden(`${key}.colour`, status?.colour ?? GROUP_DEFAULTS[group].colour)
    const groupField = editing.field(`${key}.group`, () => {
      const select = el(
        'select',
        { class: 'helm-select it-select wf-group-select', attrs: { 'aria-label': 'Group' } },
        [selectFace(), ...STATUS_GROUPS.map((option) => el('option', { text: option.label, attrs: { value: option.group } }))]
      )
      select.value = status?.group ?? group
      return select
    })
    const isDefault = checkbox(`${key}.default`, status?.isDefault ?? false, status?.isDefault ?? false)
    const close = () => editing.close(key)
    const save = async () => {
      const name = nameField.value.trim()
      if (name === '') {
        toast('A status needs a name.')
        return
      }
      const values = { name, group: groupField.value, icon: icon.value, colour: colour.value }
      if (status === null) {
        if (await write('addStatus', settings.portfolio.uid, { ...values, isDefault: isDefault.checked })) close()
        return
      }
      /** @type {Record<string, unknown>} */
      const patch = changes(status, values)
      if (isDefault.checked && !status.isDefault) patch.isDefault = true
      if (Object.keys(patch).length === 0) close()
      else if (await write('updateStatus', status.uid, patch)) close()
    }
    const nameField = lineField(editing, `${key}.name`, {
      value: status?.name ?? '',
      label: 'Status name',
      placeholder: 'Name, like Awaiting launch',
      onEnter: () => void save(),
      onEscape: close
    })
    return editorBox(key, close, [
      el('div', { class: 'wf-editor-line' }, [
        el('span', { class: 'wf-preview' }, [statusIcon({ icon: icon.value, colour: colour.value }, 15)]),
        nameField,
        groupField
      ]),
      choices(
        'Icon',
        `${key}.icon`,
        icon,
        Object.entries(ICON_NAMES).map(([value, name]) => ({ value, name, node: statusIcon({ icon: value, colour: colour.value }, 15) }))
      ),
      choices(
        'Colour',
        `${key}.colour`,
        colour,
        Object.entries(STATUS_COLOURS).map(([value, name]) => ({ value, name, node: swatch(value, 12) }))
      ),
      el('label', { class: 'wf-check' }, [
        isDefault,
        el('span', { text: 'New tasks start here' }),
        status?.isDefault ? el('span', { class: 'it-hint', text: 'Make another status the default to change it.' }) : null
      ]),
      editorActions(() => void save(), close, 'Enter saves · Esc cancels')
    ])
  }

  /**
   * @param {PortfolioSettings} settings
   * @param {Status} status
   * @param {number} count items in it
   */
  async function deleteStatus(settings, status, count) {
    const others = settings.portfolio.statuses.filter((other) => other.uid !== status.uid)
    const select = /** @type {HTMLSelectElement} */ (
      el(
        'select',
        { class: 'helm-select' },
        [
          selectFace(),
          ...statusesByGroup(others)
            .filter((group) => group.statuses.length > 0)
            .map((group) =>
              el(
                'optgroup',
                { attrs: { label: group.label } },
                group.statuses.map((other) => el('option', { text: other.name, attrs: { value: other.uid } }))
              )
            )
        ]
      )
    )
    select.value = String(replacementStatus(settings.portfolio.statuses, status.uid)?.uid ?? '')
    const ran = await confirmDanger({
      title: `Delete ${status.name}`,
      lines: [
        count === 0
          ? `No epic or task is in ${status.name}.`
          : `${count === 1 ? '1 item is' : `${count} items are`} in ${status.name}. ${count === 1 ? 'It moves' : 'They move'} to the status picked here, and ${count === 1 ? 'keeps its' : 'keep their'} history.`
      ],
      extra: count === 0 ? null : el('label', { class: 'work-dialog-field' }, [el('span', { text: count === 1 ? 'Move it to' : 'Move them to' }), select]),
      confirm: 'Delete status',
      run: () => rpc('deleteStatus', status.uid, count === 0 ? {} : { replaceWith: Number(select.value) })
    })
    if (ran) written()
  }

  // -------------------------------------------------------------------------
  // Priorities

  /** @param {PortfolioSettings} settings */
  function prioritiesCard(settings) {
    const { priorities } = settings.portfolio
    return el('section', { class: 'it-card wf-card' }, [
      el('h2', { class: 'it-h2', text: 'Priorities' }),
      el('p', { class: 'wf-note', text: 'Top to bottom is most to least urgent.' }),
      el('div', { class: 'wf-list' }, [
        ...priorities.map((priority, index) =>
          editing.isOpen(`priority.${priority.uid}`) ? priorityEditor(settings, priority) : priorityRow(settings, priority, index)
        ),
        editing.isOpen('priority.new') ? priorityEditor(settings, null) : addRow('Add a priority', () => startEditor('priority.new'))
      ])
    ])
  }

  /**
   * @param {PortfolioSettings} settings
   * @param {Priority} priority
   * @param {number} index
   */
  function priorityRow(settings, priority, index) {
    const { priorities } = settings.portfolio
    const count = settings.uses.priorities[priority.uid] ?? 0
    return el('div', { class: 'wf-row', attrs: { 'data-sort-row': true } }, [
      dragHandle({
        label: priority.name,
        index,
        count: priorities.length,
        focusKey: `priority.grip.${priority.uid}`,
        onMove: (to) => void write('reorderPriorities', settings.portfolio.uid, moved(priorities, index, to).map((other) => other.uid))
      }),
      el('span', { class: 'wf-glyph' }, [priorityGlyph(priorityMark(priority.rank, priorities.length), priority.name)]),
      el('span', { class: 'wf-name work-ellip', text: priority.name }),
      priority.isDefault ? el('span', { class: 'wf-tag', text: 'default' }) : null,
      el('span', { class: 'it-grow' }),
      uses(count),
      iconButton(`Edit ${priority.name}`, ICONS.pencil, () => startEditor(`priority.${priority.uid}`)),
      deleteButton(
        `Delete ${priority.name}`,
        priority.isDefault ? `${priority.name} is what new tasks get. Make another priority the default first.` : null,
        () => void deletePriority(settings, priority, count)
      )
    ])
  }

  /**
   * @param {PortfolioSettings} settings
   * @param {Priority | null} priority
   */
  function priorityEditor(settings, priority) {
    const key = priority ? `priority.${priority.uid}` : 'priority.new'
    const isDefault = checkbox(`${key}.default`, priority?.isDefault ?? false, priority?.isDefault ?? false)
    const close = () => editing.close(key)
    const save = async () => {
      const name = nameField.value.trim()
      if (name === '') {
        toast('A priority needs a name.')
        return
      }
      if (priority === null) {
        if (await write('addPriority', settings.portfolio.uid, { name, isDefault: isDefault.checked })) close()
        return
      }
      /** @type {Record<string, unknown>} */
      const patch = changes(priority, { name })
      if (isDefault.checked && !priority.isDefault) patch.isDefault = true
      if (Object.keys(patch).length === 0) close()
      else if (await write('updatePriority', priority.uid, patch)) close()
    }
    const nameField = lineField(editing, `${key}.name`, {
      value: priority?.name ?? '',
      label: 'Priority name',
      placeholder: priority ? 'Name' : 'Name. It goes at the bottom; drag it up.',
      onEnter: () => void save(),
      onEscape: close
    })
    return editorBox(key, close, [
      nameField,
      el('label', { class: 'wf-check' }, [
        isDefault,
        el('span', { text: 'New tasks get this one' }),
        priority?.isDefault ? el('span', { class: 'it-hint', text: 'Make another the default to change it.' }) : null
      ]),
      editorActions(() => void save(), close, 'Enter saves · Esc cancels')
    ])
  }

  /**
   * @param {PortfolioSettings} settings
   * @param {Priority} priority
   * @param {number} count
   */
  async function deletePriority(settings, priority, count) {
    const others = settings.portfolio.priorities.filter((other) => other.uid !== priority.uid)
    const select = /** @type {HTMLSelectElement} */ (
      el('select', { class: 'helm-select' }, [selectFace(), ...others.map((other) => el('option', { text: other.name, attrs: { value: other.uid } }))])
    )
    const plain = settings.portfolio.priorities.map((other) => ({ ...other, group: '' }))
    select.value = String(replacementStatus(plain, priority.uid)?.uid ?? '')
    const ran = await confirmDanger({
      title: `Delete ${priority.name}`,
      lines: [
        count === 0
          ? `No epic or task is at ${priority.name}.`
          : `${count === 1 ? '1 item is' : `${count} items are`} at ${priority.name}. ${count === 1 ? 'It moves' : 'They move'} to the priority picked here.`
      ],
      extra: count === 0 ? null : el('label', { class: 'work-dialog-field' }, [el('span', { text: count === 1 ? 'Move it to' : 'Move them to' }), select]),
      confirm: 'Delete priority',
      run: () => rpc('deletePriority', priority.uid, count === 0 ? {} : { replaceWith: Number(select.value) })
    })
    if (ran) written()
  }

  // -------------------------------------------------------------------------
  // Projects

  /** @param {PortfolioSettings} settings */
  function projectsCard(settings) {
    const { projects } = settings.portfolio
    return el('section', { class: 'it-card wf-card' }, [
      el('h2', { class: 'it-h2', text: 'Projects' }),
      el('p', { class: 'wf-note', text: 'A session started in one of these folders lands in that project.' }),
      el('div', { class: 'wf-list' }, [
        ...projects.map((project, index) =>
          editing.isOpen(`project.${project.uid}`) ? projectEditor(settings, project) : projectRow(settings, project, index)
        ),
        projects.length === 0 && !editing.isOpen('project.new') ? el('p', { class: 'wf-empty', text: 'No projects yet. Tasks live in projects, so add one first.' }) : null,
        editing.isOpen('project.new') ? projectEditor(settings, null) : addRow('Add a project', () => startEditor('project.new'))
      ])
    ])
  }

  /**
   * @param {PortfolioSettings} settings
   * @param {PlacedProject} project
   * @param {number} index
   */
  function projectRow(settings, project, index) {
    const { projects } = settings.portfolio
    const count = settings.uses.projects[project.uid] ?? 0
    return el('div', { class: 'wf-row wf-project', attrs: { 'data-sort-row': true } }, [
      dragHandle({
        label: project.name,
        index,
        count: projects.length,
        focusKey: `project.grip.${project.uid}`,
        onMove: (to) => void write('reorderProjects', settings.portfolio.uid, moved(projects, index, to).map((other) => other.uid))
      }),
      tile(project.name.charAt(0).toUpperCase(), 22, project.colour),
      el('button', {
        class: 'wf-name wf-open work-ellip',
        text: project.name,
        title: `Open ${project.name}`,
        attrs: { type: 'button' },
        on: { click: () => void openProject(project) }
      }),
      el('span', {
        class: project.place ? 'wf-place work-mono work-ellip' : 'wf-place wf-place-none work-ellip',
        text: project.place ?? 'no folder',
        title: project.folders.length > 0 ? project.folders.join('\n') : 'Sessions cannot land here until it has a folder.'
      }),
      uses(count),
      iconButton(`Edit ${project.name}`, ICONS.pencil, () => startEditor(`project.${project.uid}`)),
      deleteButton(`Delete ${project.name}`, null, () => void deleteProject(project, count))
    ])
  }

  /**
   * @param {PortfolioSettings} settings
   * @param {PlacedProject | null} project
   */
  function projectEditor(settings, project) {
    const key = project ? `project.${project.uid}` : 'project.new'
    const used = settings.portfolio.projects.map((other) => other.colour)
    const colour = hidden(`${key}.colour`, project?.colour ?? PROJECT_COLOURS.find((name) => !used.includes(name)) ?? PROJECT_COLOURS[0])
    const folders = hidden(`${key}.folders`, JSON.stringify(project?.folders ?? []))
    // The fields outlive this draw, and so do the handlers they were made
    // with: everything reads the fields, never a value taken here.
    const current = () => /** @type {string[]} */ (JSON.parse(folders.value))
    const list = current()
    const close = () => editing.close(key)
    const setFolders = (/** @type {string[]} */ next) => {
      folders.value = JSON.stringify(next)
      draw()
    }
    const addFolder = () => {
      const path = cleanPath(folderField.value)
      if (path === '') return false
      folderField.value = ''
      const now = current()
      if (!now.some((folder) => folder.toLowerCase() === path.toLowerCase())) setFolders([...now, path])
      else draw()
      return true
    }
    const save = async () => {
      const name = nameField.value.trim()
      if (name === '') {
        toast('A project needs a name.')
        return
      }
      const typed = cleanPath(folderField.value)
      const now = current()
      const all = typed === '' || now.some((folder) => folder.toLowerCase() === typed.toLowerCase()) ? now : [...now, typed]
      if (project === null) {
        if (await write('createProject', { portfolio: settings.portfolio.uid, name, colour: colour.value, folders: all })) close()
        return
      }
      /** @type {Record<string, unknown>} */
      const patch = changes(project, { name, colour: colour.value })
      if (JSON.stringify(all) !== JSON.stringify(project.folders)) patch.folders = all
      if (Object.keys(patch).length === 0) close()
      else if (await write('updateProject', project.uid, patch)) close()
    }
    const nameField = lineField(editing, `${key}.name`, {
      value: project?.name ?? '',
      label: 'Project name',
      placeholder: 'Name, like Desktop',
      onEnter: () => void save(),
      onEscape: close,
      onInput: () => {
        const shown = root.querySelector(`[data-editor="${CSS.escape(key)}"] .wf-letter`)
        if (shown) shown.textContent = nameField.value.trim().charAt(0).toUpperCase()
      }
    })
    const folderField = lineField(editing, `${key}.folder`, {
      label: 'Add a folder',
      placeholder: 'C:\\Users\\you\\repos\\app · Enter adds',
      className: 'helm-input it-input work-mono wf-folder-input',
      onEnter: () => {
        if (!addFolder()) void save()
      },
      onEscape: close
    })
    const letter = tile(nameField.value.trim().charAt(0).toUpperCase(), 22, colour.value, 'wf-letter')
    return editorBox(key, close, [
      el('div', { class: 'wf-editor-line' }, [letter, nameField]),
      choices(
        'Colour',
        `${key}.colour`,
        colour,
        PROJECT_COLOURS.map((value) => ({ value, name: STATUS_COLOURS[/** @type {keyof STATUS_COLOURS} */ (value)], node: swatch(value, 12) }))
      ),
      el('div', { class: 'wf-folders' }, [
        el('span', { class: 'wf-choice-label', text: 'Folders' }),
        el('div', { class: 'wf-folder-list' }, [
          ...list.map((folder, index) =>
            el('div', { class: 'wf-folder' }, [
              lineIcon(ICONS.file, 12, 1.8),
              el('span', { class: 'work-mono work-ellip', text: folder, title: folder }),
              iconButton(`Remove ${folder}`, ICONS.close, () => setFolders(list.filter((_, at) => at !== index)))
            ])
          ),
          folderField
        ])
      ]),
      el('p', {
        class: 'it-hint',
        text: 'Paste a folder’s full path. A session started in it, or in a folder inside it, lands in this project; the deepest match wins.'
      }),
      editorActions(() => void save(), close, 'Enter saves · Esc cancels')
    ])
  }

  /**
   * @param {PlacedProject} project
   * @param {number} count items in it
   */
  async function deleteProject(project, count) {
    if (count > 0) {
      await confirmDanger({
        title: `Delete ${project.name}`,
        lines: [`${project.name} still has ${itemCount(count)}. Move ${count === 1 ? 'it' : 'them'} to another project, or delete ${count === 1 ? 'it' : 'them'}, first.`],
        refusal: true,
        confirm: '',
        run: async () => undefined
      })
      return
    }
    const ran = await confirmDanger({
      title: `Delete ${project.name}`,
      lines: [`${project.name} has no epics or tasks. Its folders stop leading sessions to this portfolio.`],
      confirm: 'Delete project',
      run: () => rpc('deleteProject', project.uid)
    })
    if (ran) written()
  }

  // -------------------------------------------------------------------------
  // The portfolio itself

  /** @param {PortfolioSettings} settings */
  function portfolioCard(settings) {
    const { portfolio } = settings
    const name = synced('portfolio.name', portfolio.name, () =>
      el('input', { class: 'helm-input it-input', attrs: { type: 'text', 'aria-label': 'Name', maxlength: 120, autocomplete: 'off' } })
    )
    const key = synced('portfolio.key', portfolio.key, () =>
      el('input', {
        class: 'helm-input it-input work-mono wf-key',
        attrs: { type: 'text', 'aria-label': 'Key', maxlength: 10, autocomplete: 'off', spellcheck: 'false' }
      })
    )
    const description = synced('portfolio.description', portfolio.description, () =>
      el('textarea', { class: 'helm-textarea it-textarea wf-description', attrs: { 'aria-label': 'Description', rows: 2, maxlength: 2000 } })
    )
    const save = /** @type {HTMLButtonElement} */ (button('Save', null, () => void savePortfolio(settings, name, key, description), 'primary'))
    const sample = el('span', { class: 'work-mono' })
    const refresh = () => {
      const typed = key.value.trim().toUpperCase()
      sample.textContent = `${PORTFOLIO_KEY.test(typed) ? typed : portfolio.key}-${portfolio.nextNumber}`
      save.disabled = name.value.trim() === portfolio.name && typed === portfolio.key && description.value.trim() === portfolio.description
    }
    for (const field of [name, key, description]) {
      field.oninput = () => {
        if (field === key) {
          const caret = key.selectionStart
          key.value = key.value.toUpperCase()
          key.setSelectionRange(caret, caret)
        }
        refresh()
      }
      field.onkeydown = (event) => {
        if (event.key === 'Enter' && (field !== description || event.ctrlKey || event.metaKey) && !event.isComposing) {
          event.preventDefault()
          if (!save.disabled) void savePortfolio(settings, name, key, description)
        }
      }
    }
    refresh()
    const projects = portfolio.projects.length
    return el('section', { class: 'it-card wf-card wf-portfolio' }, [
      el('h2', { class: 'it-h2', text: 'Portfolio' }),
      el('div', { class: 'wf-form' }, [
        el('label', { class: 'wf-label', text: 'Name', attrs: { for: 'wf-name' } }),
        withId(name, 'wf-name'),
        el('label', { class: 'wf-label', text: 'Key', attrs: { for: 'wf-key' } }),
        el('div', { class: 'wf-key-line' }, [withId(key, 'wf-key'), el('span', { class: 'it-hint' }, ['starts every ID · next ', sample])]),
        el('label', { class: 'wf-label wf-label-top', text: 'Description', attrs: { for: 'wf-description' } }),
        withId(description, 'wf-description')
      ]),
      el('div', { class: 'it-editor-actions' }, [save, el('span', { class: 'it-hint', text: 'Changing the key renames every ID.' })]),
      el('div', { class: 'wf-danger' }, [
        el('span', {
          class: 'it-hint',
          text: deletesWhat(portfolio.name, projects, settings.items)
        }),
        button('Delete portfolio', TRASH, () => void deletePortfolio(settings), 'danger')
      ])
    ])
  }

  /**
   * @param {PortfolioSettings} settings
   * @param {HTMLInputElement} name
   * @param {HTMLInputElement} key
   * @param {HTMLTextAreaElement} description
   */
  async function savePortfolio(settings, name, key, description) {
    const { portfolio } = settings
    const patch = changes(portfolio, { name: name.value.trim(), key: key.value.trim().toUpperCase(), description: description.value.trim() })
    if (Object.keys(patch).length === 0) return
    if (patch.name === '') {
      toast('A portfolio needs a name.')
      return
    }
    if (patch.key !== undefined && !PORTFOLIO_KEY.test(String(patch.key))) {
      toast('A key is a letter, then up to nine letters or digits, like TC or HELM.')
      return
    }
    const forget = () => {
      for (const field of ['name', 'key', 'description']) editing.close(`portfolio.${field}`)
    }
    if (patch.key === undefined) {
      if (await write('updatePortfolio', portfolio.uid, patch)) forget()
      return
    }
    const n = Math.max(1, portfolio.nextNumber - 1)
    const ran = await confirmDanger({
      title: `Change the key to ${patch.key}`,
      icon: ICONS.pencil,
      lines: [
        `Every ID in ${portfolio.name} changes with it: IDs like ${portfolio.key}-${n} become ${patch.key}-${n}.`,
        'Notes, commits and sessions that name the old IDs will not find them here.'
      ],
      confirm: 'Change the key',
      run: () => rpc('updatePortfolio', portfolio.uid, patch)
    })
    if (ran) {
      forget()
      written()
    }
  }

  /** @param {PortfolioSettings} settings */
  async function deletePortfolio(settings) {
    const { portfolio } = settings
    const projects = portfolio.projects.length
    const ran = await confirmDanger({
      title: `Delete ${portfolio.name}`,
      meta: portfolio.key,
      lines: [
        `${deletesWhat(portfolio.name, projects, settings.items)}${settings.items > 0 ? ' Their criteria, links and logs go too.' : ''}`,
        'It cannot be undone.'
      ],
      typeToConfirm: portfolio.key,
      confirm: 'Delete portfolio',
      run: () => rpc('deletePortfolio', portfolio.uid)
    })
    if (ran) {
      toast(`Deleted ${portfolio.name}`)
      written()
    }
  }

  // -------------------------------------------------------------------------
  // Pieces

  /**
   * A hidden field that holds an editor's choice across draws.
   *
   * @param {string} key
   * @param {string} value
   */
  function hidden(key, value) {
    return editing.field(key, () => {
      const input = el('input', { attrs: { type: 'hidden' } })
      input.value = value
      return input
    })
  }

  /**
   * @param {string} key
   * @param {boolean} checked
   * @param {boolean} locked
   */
  function checkbox(key, checked, locked) {
    const box = editing.field(key, () => {
      const input = el('input', { attrs: { type: 'checkbox' } })
      input.checked = checked
      return input
    })
    box.disabled = locked
    return box
  }

  /**
   * A field kept across draws that follows the data while it is untouched:
   * another page's change shows, a half-typed one is kept.
   *
   * @template {HTMLInputElement | HTMLTextAreaElement} F
   * @param {string} key
   * @param {string} value
   * @param {() => F} create
   * @returns {F}
   */
  function synced(key, value, create) {
    const field = editing.field(key, () => {
      const made = create()
      made.value = value
      made.dataset.base = value
      return made
    })
    if (field.value === field.dataset.base && field.dataset.base !== value) {
      field.value = value
      field.dataset.base = value
    }
    return field
  }

  /**
   * Icon or colour choices: a row of toggles, one pressed.
   *
   * @param {string} label
   * @param {string} key
   * @param {HTMLInputElement} field
   * @param {{ value: string, name: string, node: Node }[]} options
   */
  function choices(label, key, field, options) {
    return el('div', { class: 'wf-choices', attrs: { role: 'group', 'aria-label': label } }, [
      el('span', { class: 'wf-choice-label', text: label }),
      el(
        'div',
        { class: 'wf-choice-set' },
        options.map((option) =>
          el(
            'button',
            {
              class: 'wf-choice',
              title: option.name,
              attrs: { type: 'button', 'aria-label': option.name, 'aria-pressed': field.value === option.value ? 'true' : 'false', 'data-focus': `${key}.${option.value}` },
              on: {
                click: () => {
                  field.value = option.value
                  draw()
                }
              }
            },
            [option.node]
          )
        )
      )
    ])
  }

  /**
   * An editor's box: Escape anywhere in it cancels.
   *
   * @param {string} key
   * @param {() => void} close
   * @param {(Node | null)[]} children
   */
  function editorBox(key, close, children) {
    return el(
      'div',
      {
        class: 'wf-editor',
        attrs: { 'data-editor': key },
        on: {
          keydown: (event) => {
            if (/** @type {KeyboardEvent} */ (event).key === 'Escape') {
              event.preventDefault()
              close()
            }
          }
        }
      },
      children
    )
  }

  return {
    async load(isCurrent) {
      const next = /** @type {PortfolioSettings} */ (await rpc('portfolioSettings', uid))
      if (!isCurrent()) return
      data = next
      host.setPlace({ portfolio: uid })
      helm.surface.setTitle(`${next.portfolio.name} workflow`)
      const opening = first
      first = false
      if (takeProjectFocus()) return
      if (opening && next.portfolio.projects.length === 0) {
        startEditor('project.new')
        return
      }
      draw()
    },
    focus() {
      takeProjectFocus()
    }
  }
}

/**
 * @param {string} label
 * @param {() => void} onClick
 */
function addRow(label, onClick) {
  return el('button', { class: 'wf-add', attrs: { type: 'button' }, on: { click: onClick } }, [lineIcon(ICONS.plus, 12, 1.8), label])
}

/**
 * A row's delete. When it cannot be deleted the button says why instead.
 *
 * @param {string} label
 * @param {string | null} refusal
 * @param {() => void} onDelete
 */
function deleteButton(label, refusal, onDelete) {
  const node = iconButton(refusal ?? label, TRASH, () => (refusal ? toast(refusal) : onDelete()), refusal ? 'wf-refused' : '')
  if (refusal) node.setAttribute('aria-disabled', 'true')
  return node
}

/** @param {number} count */
function uses(count) {
  return count === 0 ? null : el('span', { class: 'wf-uses', text: itemCount(count) })
}

/**
 * "Deleting TideCast deletes its 3 projects and 12 items."
 *
 * @param {string} name
 * @param {number} projects
 * @param {number} items
 */
function deletesWhat(name, projects, items) {
  const parts = [projects === 0 ? null : projects === 1 ? 'its project' : `its ${projects} projects`, items === 0 ? null : `its ${itemCount(items)}`].filter(Boolean)
  return parts.length === 0 ? `Deleting ${name} deletes nothing else: it is empty.` : `Deleting ${name} deletes ${parts.join(' and ')}.`
}

/** @param {number} count */
function itemCount(count) {
  return count === 1 ? '1 item' : `${count} items`
}

/**
 * The fields of `values` that differ from `current`.
 *
 * @param {Record<string, any>} current
 * @param {Record<string, string>} values
 * @returns {Record<string, unknown>}
 */
function changes(current, values) {
  return Object.fromEntries(Object.entries(values).filter(([field, value]) => current[field] !== value))
}

/**
 * A pasted path without the quotes Explorer's "Copy as path" adds.
 *
 * @param {string} text
 */
function cleanPath(text) {
  return text.trim().replace(/^"(.*)"$/, '$1').trim()
}

/**
 * @template {HTMLElement} E
 * @param {E} node
 * @param {string} id
 */
function withId(node, id) {
  node.id = id
  return node
}
