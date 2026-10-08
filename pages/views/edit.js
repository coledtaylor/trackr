/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * What the epic and task views share: the writes, editors that keep what was
 * typed when the page draws again, and the pieces both views draw (the title,
 * the description, the properties card, the links).
 *
 * Every write is the person's. `editItem` logs it as "You", the way a
 * session's update is logged with the session's name.
 *
 * A session can write while the person is typing; the page then reads and
 * draws again. An open editor's fields are kept by key and put back, so the
 * text, the focus and the caret survive.
 */

import { TRASH, confirmDanger } from '../shared/dialog.js'
import { ICONS, el, lineIcon, priorityGlyph, selectFace, statusIcon, swatch, toast } from '../shared/dom.js'
import { LINK_KINDS, age, codeSpans, linkText, paragraphs, priorityMark, timeLabel } from '../shared/logic.js'
import { announceChange, rpc } from '../shared/work.js'

/** Who the person is in the log. */
export const YOU = 'You'

/**
 * @typedef {import('../shared/types.js').ItemOverview} ItemOverview
 * @typedef {import('../shared/types.js').Item} Item
 * @typedef {import('../shared/types.js').ItemSummary} ItemSummary
 * @typedef {import('../shared/types.js').Link} Link
 * @typedef {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} Field
 * @typedef {ReturnType<typeof createEditing>} Editing
 */

/**
 * @param {number} uid the item on screen
 * @param {{ reload(): void, deleted?(item: Item): void }} host
 * @param {() => void} redraw draws the view again from what it has
 */
export function createEditing(uid, host, redraw) {
  /** @type {Set<string>} */
  const open = new Set()
  /** @type {Map<string, Field>} */
  const fields = new Map()

  /**
   * One write, then the other pages are told and this one reads again.
   *
   * @param {string} method
   * @param {unknown[]} args
   * @returns {Promise<unknown>} the result, or undefined when it was refused (the reason is shown)
   */
  async function write(method, args) {
    let result
    try {
      result = await rpc(method, ...args)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error))
      return undefined
    }
    announceChange()
    host.reload()
    return result ?? true
  }

  return {
    /**
     * Changes this item. Resolves true when it landed.
     *
     * @param {Record<string, unknown>} patch as the service's `editItem` takes it
     */
    async edit(patch) {
      return (await write('editItem', [uid, patch, YOU])) !== undefined
    },

    /**
     * Changes another item, as the person.
     *
     * @param {number} other
     * @param {Record<string, unknown>} patch
     */
    async editOther(other, patch) {
      return (await write('editItem', [other, patch, YOU])) !== undefined
    },

    /**
     * Any other store method the pages may call. Resolves with its result,
     * or undefined when it was refused.
     *
     * @param {string} method
     * @param {...unknown} args
     */
    call(method, ...args) {
      return write(method, args)
    },

    /** @param {string} key */
    isOpen(key) {
      return open.has(key)
    },

    /**
     * Opens an editor and puts the caret in it.
     *
     * @param {string} key
     * @param {string} [focus] the field to focus; the editor's own key by default
     */
    start(key, focus = key) {
      open.add(key)
      redraw()
      const field = fields.get(focus)
      if (field) {
        field.focus()
        if (!(field instanceof HTMLSelectElement)) field.setSelectionRange(field.value.length, field.value.length)
      }
    },

    /**
     * Closes an editor and forgets its fields: its own key and `key.*`.
     *
     * @param {string} key
     */
    close(key) {
      open.delete(key)
      for (const name of [...fields.keys()]) if (name === key || name.startsWith(`${key}.`)) fields.delete(name)
      redraw()
    },

    /**
     * The field kept under `key`, made by `create` the first time.
     *
     * @template {Field} F
     * @param {string} key
     * @param {() => F} create
     * @returns {F}
     */
    field(key, create) {
      let field = fields.get(key)
      if (field === undefined) {
        field = create()
        fields.set(key, field)
      }
      return /** @type {F} */ (field)
    },

    /**
     * Deletes the item on screen, once the person confirms it in a dialog
     * that says what goes with it.
     *
     * @param {Item} item
     */
    async remove(item) {
      const ran = await confirmDanger({
        title: `Delete ${item.id}`,
        lines: deleteLines(item),
        confirm: item.kind === 'epic' ? 'Delete epic' : 'Delete task',
        run: () => rpc('deleteItem', uid)
      })
      if (!ran) return
      host.deleted?.(item)
      announceChange()
      host.reload()
    },

    /**
     * @param {string} text
     * @param {string} what said in the toast: "Copied TC-123"
     */
    async copy(text, what) {
      try {
        await navigator.clipboard.writeText(text)
        toast(`Copied ${what}`)
      } catch (error) {
        toast(`Could not copy: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * What a delete takes with it, and who it leaves.
 *
 * @param {Item} item
 */
function deleteLines(item) {
  /** @type {(Node | string)[]} */
  const lines = [
    el('p', { class: 'work-dialog-text' }, [el('strong', { text: item.title })]),
    item.kind === 'epic'
      ? (item.tasks?.length ?? 0) === 0
        ? `${item.title} has no tasks.`
        : `Its ${item.tasks?.length === 1 ? 'task stays' : `${item.tasks?.length} tasks stay`}, without an epic.`
      : 'Its criteria, links, where it stands and its log go with it.'
  ]
  if (item.blocks.length > 0) {
    const ids = item.blocks.map((other) => other.id)
    lines.push(`${ids.join(', ')} ${ids.length === 1 ? 'waits' : 'wait'} on it, and will stop waiting.`)
  }
  if (item.session) lines.push(`${item.session.name} is on it. The session keeps running; its next update to ${item.id} will fail.`)
  lines.push('It cannot be undone. To keep it on record, set it to Cancelled instead.')
  return lines
}

// ---------------------------------------------------------------------------
// Small pieces

/**
 * A 24px icon button.
 *
 * @param {string} label
 * @param {string} icon path data
 * @param {(event: MouseEvent) => void} onClick
 * @param {string} [extraClass]
 */
export function iconButton(label, icon, onClick, extraClass = '') {
  return el(
    'button',
    { class: `helm-icon-button it-icon-button ${extraClass}`.trim(), title: label, attrs: { type: 'button', 'aria-label': label }, on: { click: onClick } },
    [lineIcon(icon, 13, 1.8)]
  )
}

/**
 * A button with an icon and words.
 *
 * @param {string} text
 * @param {string | null} icon
 * @param {() => void} onClick
 * @param {'primary' | 'ghost' | 'danger' | null} [variant]
 */
export function button(text, icon, onClick, variant = null) {
  return el('button', { class: 'helm-button it-button', attrs: { type: 'button', 'data-variant': variant }, on: { click: onClick } }, [
    icon ? lineIcon(icon, 12, 1.8) : null,
    text
  ])
}

/**
 * Plain text as paragraphs with `code` spans.
 *
 * @param {string} text
 * @param {string} className
 */
export function richText(text, className) {
  return el(
    'div',
    { class: className },
    paragraphs(text).map((parts) => el('p', {}, codeNodes(parts)))
  )
}

/**
 * One run of text with `code` spans, in an element of its own.
 *
 * @param {'span' | 'div'} tag
 * @param {string} text
 * @param {string} className
 */
export function inlineText(tag, text, className) {
  return el(tag, { class: className }, codeNodes(codeSpans(text)))
}

/** @param {{ code: boolean, text: string }[]} parts */
function codeNodes(parts) {
  return parts.map((part) => (part.code ? el('code', { class: 'it-code', text: part.text }) : part.text))
}

/**
 * A section heading with things after it.
 *
 * @param {string} title
 * @param {(Node | string | null | false)[]} [after]
 */
export function sectionHead(title, after = []) {
  return el('div', { class: 'it-sec-head' }, [el('h2', { class: 'it-h2', text: title }), ...after])
}

/**
 * A pill in the header. A button when it does something.
 *
 * @param {(Node | string | null)[]} children
 * @param {{ onClick?: () => void, title?: string, extraClass?: string }} [options]
 */
export function chip(children, options = {}) {
  const props = { class: `it-chip ${options.extraClass ?? ''}`.trim(), title: options.title }
  return options.onClick
    ? el('button', { ...props, attrs: { type: 'button' }, on: { click: options.onClick } }, children)
    : el('span', props, children)
}

/** @param {ItemOverview} data */
export function statusChip(data) {
  const status = data.item.status
  return chip([statusIcon(status, 13), status.name], { title: 'Status' })
}

/** @param {ItemOverview} data */
export function priorityChip(data) {
  const priorities = data.portfolio.priorities
  const rank = priorities.find((priority) => priority.uid === data.item.priority.uid)?.rank ?? priorities.length
  return chip([priorityGlyph(priorityMark(rank, priorities.length), data.item.priority.name), data.item.priority.name], { title: 'Priority' })
}

/**
 * The foot of the column: "Created Sep 28 by saved views s3 · updated 2h
 * ago", and Delete.
 *
 * @param {Editing} editing
 * @param {Item} item
 */
export function stamp(editing, item) {
  const ago = age(item.updatedAt)
  const created = `Created ${timeLabel(item.createdAt)}${item.createdBy ? ` by ${item.createdBy}` : ''}`
  return el('div', { class: 'it-foot' }, [
    el('p', { class: 'it-stamp', text: `${created} · updated ${ago === 'now' ? 'just now' : `${ago} ago`}` }),
    el(
      'button',
      { class: 'helm-button it-delete', title: `Delete ${item.id}`, attrs: { type: 'button', 'data-variant': 'danger' }, on: { click: () => void editing.remove(item) } },
      [lineIcon(TRASH, 12, 1.8), 'Delete']
    )
  ])
}

// ---------------------------------------------------------------------------
// Editors

/**
 * Save and Cancel, with the keys that do the same.
 *
 * @param {() => void} onSave
 * @param {() => void} onCancel
 * @param {string} hint
 */
export function editorActions(onSave, onCancel, hint) {
  return el('div', { class: 'it-editor-actions' }, [
    button('Save', null, onSave, 'primary'),
    button('Cancel', null, onCancel, 'ghost'),
    el('span', { class: 'it-hint', text: hint })
  ])
}

/**
 * A text area kept across draws. Ctrl Enter saves and Escape cancels.
 *
 * @param {Editing} editing
 * @param {string} key
 * @param {{ value: string, label: string, placeholder?: string, rows?: number, onSave: () => void, onCancel: () => void }} options
 */
export function textArea(editing, key, options) {
  return editing.field(key, () => {
    const area = el('textarea', {
      class: 'helm-textarea it-textarea',
      attrs: { 'aria-label': options.label, placeholder: options.placeholder ?? '', rows: options.rows ?? 4 }
    })
    area.value = options.value
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        options.onSave()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        options.onCancel()
      }
    })
    return area
  })
}

/**
 * A one-line field kept across draws: Enter runs `onEnter`, Escape `onEscape`.
 *
 * @param {Editing} editing
 * @param {string} key
 * @param {{ value?: string, label: string, placeholder?: string, className?: string, onEnter: () => void, onEscape?: () => void, onInput?: () => void }} options
 */
export function lineField(editing, key, options) {
  return editing.field(key, () => {
    const input = el('input', {
      class: options.className ?? 'helm-input it-input',
      attrs: { type: 'text', 'aria-label': options.label, placeholder: options.placeholder ?? '', autocomplete: 'off', spellcheck: 'false' }
    })
    input.value = options.value ?? ''
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        options.onEnter()
      } else if (event.key === 'Escape' && options.onEscape) {
        event.preventDefault()
        options.onEscape()
      }
    })
    if (options.onInput) input.addEventListener('input', options.onInput)
    return input
  })
}

/**
 * The title, renamed in place: pressing it opens a field the same size.
 * Enter saves, Escape cancels; leaving it unchanged closes it.
 *
 * @param {Editing} editing
 * @param {Item} item
 */
export function titleBlock(editing, item) {
  if (!editing.isOpen('title')) {
    return el('h1', { class: 'it-title' }, [
      el('button', { class: 'it-title-text', text: item.title, title: 'Rename', attrs: { type: 'button' }, on: { click: () => editing.start('title') } })
    ])
  }
  const area = editing.field('title', () => {
    const node = el('textarea', { class: 'it-title-input', attrs: { 'aria-label': 'Title', rows: 1, maxlength: 300, spellcheck: 'true' } })
    node.value = item.title
    const save = async () => {
      const title = node.value.replace(/\s+/g, ' ').trim()
      if (title === '') {
        toast('A title cannot be empty.')
        return
      }
      if (title === item.title) {
        editing.close('title')
        return
      }
      if (await editing.edit({ title })) editing.close('title')
    }
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        void save()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        editing.close('title')
      }
    })
    node.addEventListener('blur', () => {
      if (node.isConnected && node.value.trim() === item.title) editing.close('title')
    })
    return node
  })
  return el('div', { class: 'it-title-edit' }, [area, el('span', { class: 'it-hint', text: 'Enter saves · Esc cancels' })])
}

/**
 * The description, with a pencil that turns it into a text area.
 *
 * @param {Editing} editing
 * @param {Item} item
 */
export function descriptionSection(editing, item) {
  const editingNow = editing.isOpen('description')
  const head = sectionHead('Description', [
    el('span', { class: 'it-grow' }),
    editingNow ? null : iconButton('Edit the description', ICONS.pencil, () => editing.start('description'))
  ])
  if (editingNow) {
    const save = async () => {
      const area = /** @type {HTMLTextAreaElement} */ (editing.field('description', () => el('textarea')))
      if (area.value === item.description) {
        editing.close('description')
        return
      }
      if (await editing.edit({ description: area.value })) editing.close('description')
    }
    const cancel = () => editing.close('description')
    return el('section', { class: 'it-section' }, [
      head,
      textArea(editing, 'description', { value: item.description, label: 'Description', rows: 8, onSave: () => void save(), onCancel: cancel }),
      editorActions(() => void save(), cancel, 'Ctrl Enter saves · Esc cancels')
    ])
  }
  return el('section', { class: 'it-section' }, [
    head,
    item.description.trim()
      ? richText(item.description, 'it-prose')
      : el('button', { class: 'it-empty-add', text: 'Add a description', attrs: { type: 'button' }, on: { click: () => editing.start('description') } })
  ])
}

/**
 * A select in the properties card. Changing it writes at once.
 *
 * @param {string} label
 * @param {[string, string][]} options value and words
 * @param {string} value
 * @param {(value: string) => void} onChange
 */
export function propertySelect(label, options, value, onChange) {
  const select = el(
    'select',
    { class: 'helm-select it-select', attrs: { 'aria-label': label }, on: { change: () => onChange(select.value) } },
    [selectFace(), ...options.map(([key, text]) => el('option', { text, attrs: { value: key, selected: key === value } }))]
  )
  select.value = value
  return select
}

/**
 * The card of fields edited by picking: status, priority, project, and for a
 * task its epic.
 *
 * @param {Editing} editing
 * @param {ItemOverview} data
 */
export function propertiesCard(editing, data) {
  const { item, portfolio, projects } = data
  const isTask = item.kind === 'task'
  /** @type {[string, Node][]} */
  const rows = [
    [
      'Status',
      propertySelect(
        'Status',
        portfolio.statuses.map((status) => [String(status.uid), status.name]),
        String(item.status.uid),
        (value) => void editing.edit({ status: Number(value) })
      )
    ],
    [
      'Priority',
      propertySelect(
        'Priority',
        portfolio.priorities.map((priority) => [String(priority.uid), priority.name]),
        String(item.priority.uid),
        (value) => void editing.edit({ priority: Number(value) })
      )
    ],
    [
      isTask ? 'Project' : 'Home',
      propertySelect(
        isTask ? 'Project' : 'Home project',
        projects.map((project) => [String(project.uid), project.name]),
        String(item.project.uid),
        (value) => void editing.edit({ project: Number(value) })
      )
    ]
  ]
  if (isTask) {
    const epicId = item.epic?.id ?? ''
    rows.push([
      'Epic',
      propertySelect(
        'Epic',
        [['', 'None'], ...data.epics.map((epic) => /** @type {[string, string]} */ ([epic.id, `${epic.id} ${epic.title}`]))],
        epicId,
        (value) => void editing.edit({ epic: value === '' ? null : value })
      )
    ])
  }
  return el(
    'div',
    { class: 'it-card it-props' },
    rows.flatMap(([label, control]) => [el('span', { class: 'it-prop-label', text: label }), control])
  )
}

/** @type {Record<string, string>} */
const LINK_ICONS = { branch: ICONS.branch, pr: ICONS.pr, commit: ICONS.commit, file: ICONS.file, artifact: ICONS.external, url: ICONS.external }

/**
 * The links, each copied when pressed (a plugin cannot open them), and a
 * form to add one.
 *
 * @param {Editing} editing
 * @param {Item} item
 */
export function linksCard(editing, item) {
  const rows = item.links.map((link) => linkRow(editing, link))
  const adding = editing.isOpen('link')
  return el('div', { class: 'it-card it-links' }, [
    el('h2', { class: 'it-h2 it-card-title', text: 'Links' }),
    ...rows,
    rows.length === 0 && !adding ? el('p', { class: 'it-none', text: 'No links yet.' }) : null,
    adding ? linkForm(editing) : el('button', { class: 'it-add-row', attrs: { type: 'button' }, on: { click: () => editing.start('link', 'link.value') } }, [lineIcon(ICONS.plus, 12, 1.8), 'Add a link'])
  ])
}

/**
 * @param {Editing} editing
 * @param {Link} link
 */
function linkRow(editing, link) {
  const text = linkText(link)
  return el('div', { class: 'it-link' }, [
    el(
      'button',
      { class: 'it-link-main', title: `${link.value}\nPress to copy`, attrs: { type: 'button' }, on: { click: () => void editing.copy(link.value, link.value) } },
      [
        el('span', { class: 'it-link-icon' }, [lineIcon(LINK_ICONS[link.kind] ?? ICONS.external, 12, 2)]),
        el('span', { class: 'it-link-text' }, [
          el('span', { class: text.mono ? 'work-ellip it-mono' : 'work-ellip', text: text.text }),
          el('span', { class: 'work-ellip it-link-meta', text: text.meta })
        ])
      ]
    ),
    iconButton('Remove this link', ICONS.close, () => void editing.edit({ links: { remove: [link.uid] } }), 'it-remove')
  ])
}

/** @param {Editing} editing */
function linkForm(editing) {
  const save = async () => {
    const kind = /** @type {HTMLSelectElement} */ (editing.field('link.kind', () => el('select'))).value
    const value = editing.field('link.value', () => el('input')).value.trim()
    const label = editing.field('link.label', () => el('input')).value.trim()
    if (value === '') {
      toast('Write the branch, PR, file or address.')
      return
    }
    if (await editing.edit({ links: { add: [{ kind, value, label }] } })) editing.close('link')
  }
  const cancel = () => editing.close('link')
  const kind = editing.field('link.kind', () => {
    const select = el(
      'select',
      { class: 'helm-select it-select', attrs: { 'aria-label': 'Kind' } },
      LINK_KINDS.map(([key, text]) => el('option', { text, attrs: { value: key } }))
    )
    return select
  })
  return el('div', { class: 'it-link-form' }, [
    kind,
    lineField(editing, 'link.value', { label: 'Value', placeholder: 'feat/saved-views, #412, a path or address', onEnter: () => void save(), onEscape: cancel }),
    lineField(editing, 'link.label', { label: 'Label', placeholder: 'Label, if it needs one', onEnter: () => void save(), onEscape: cancel }),
    editorActions(() => void save(), cancel, 'Enter adds')
  ])
}

/**
 * A row for another item: its status, ID and title, and its project's colour
 * when it is not this item's (the name is in the tooltip: the column is too
 * narrow for both). Pressing it opens it.
 *
 * @param {ItemSummary} other
 * @param {number} project this item's project
 * @param {() => void} onOpen
 */
export function otherItem(other, project, onOpen) {
  return el('button', { class: 'it-other', title: `${other.id} ${other.title} · ${other.status.name} · ${other.project.name}`, attrs: { type: 'button' }, on: { click: onOpen } }, [
    statusIcon(other.status, 13),
    el('span', { class: 'it-mono it-other-id', text: other.id }),
    el('span', { class: 'work-ellip it-other-title', text: other.title }),
    other.project.uid === project
      ? null
      : el('span', { class: 'it-other-project', title: other.project.name }, [swatch(other.project.colour, 7)])
  ])
}
