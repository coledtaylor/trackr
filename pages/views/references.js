/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
/**
 * References: what the work follows (design documents, artifacts, files and
 * pages), on the portfolio, project, epic and task pages. A row has its
 * kind's icon, its name and the line that says when to read it. Pressing it
 * opens an address in Helm's Browser tab and a file with the program the
 * computer opens it with (a program is shown in its folder, never run), and
 * copies what neither takes: a plain http address, a file that is gone. A key
 * reference, which everything under its owner sees too,
 * and a file that is no longer there are marked.
 *
 * An epic and a task also show the key references they inherit, under where
 * each comes from, with no edit button: they are changed where they live.
 *
 * An epic's or a task's are written through `editItem`, so its log says
 * "ref +1"; a portfolio's and a project's, which have no log, through the
 * reference methods.
 */

import { TRASH } from '../shared/dialog.js'
import { ICONS, el, lineIcon, toast } from '../shared/dom.js'
import { REF_KINDS, fileOpener, moved, platformOf, refAction, refName, refSources, refTitleIsTarget } from '../shared/logic.js'
import { dragHandle } from '../shared/sortable.js'
import { button, editorActions, iconButton, lineField, openFile, openLink } from './edit.js'

/**
 * @typedef {import('../shared/types.js').Reference} Reference
 * @typedef {import('../shared/types.js').InheritedReference} InheritedReference
 * @typedef {import('../shared/types.js').RefKind} RefKind
 * @typedef {import('./edit.js').Editing} Editing
 * @typedef {'portfolio' | 'project' | 'epic' | 'task'} Level
 * @typedef {{ level: Level, uid: number, refs: Reference[], inherited?: InheritedReference[], missing: number[] }} References
 *   whose they are, its own in order, what it inherits nearest first, and the uids of the files that are gone
 * @typedef {{ kind?: RefKind, target?: string, title?: string, use?: string, key?: boolean }} RefPatch
 * @typedef {{
 *   add(input: RefPatch & { target: string, use: string }): Promise<boolean>,
 *   update(uid: number, patch: RefPatch): Promise<boolean>,
 *   remove(uid: number): Promise<boolean>,
 *   reorder(uids: number[]): Promise<boolean>
 * }} Writer
 */

/** @type {Record<RefKind, string>} */
const KIND_ICONS = { artifact: ICONS.artifact, doc: ICONS.doc, file: ICONS.file, url: ICONS.external }

/** What ticking Key does at each level, said beside the box. */
const KEY_MEANS = {
  portfolio: 'every task in the portfolio sees it',
  project: 'every task in the project sees it',
  epic: 'its tasks see it',
  task: 'one to read first'
}

/**
 * The References card: a heading over the rows. The column beside an epic or
 * a task has it, and so does a portfolio's page.
 *
 * @param {Editing} editing
 * @param {References} data
 */
export function referencesCard(editing, data) {
  return el('div', { class: 'it it-card it-links it-refs' }, [el('h2', { class: 'it-h2 it-card-title', text: 'References' }), ...referenceParts(editing, data)])
}

/**
 * The own references (dragged into order by their handle) and the add row or
 * its form, then the inherited ones under where each comes from.
 *
 * @param {Editing} editing
 * @param {References} data
 * @returns {(Node | null)[]}
 */
export function referenceParts(editing, data) {
  const write = writer(editing, data)
  const missing = new Set(data.missing)
  const own = data.refs
  const sources = refSources(data.inherited ?? [])
  const adding = editing.isOpen('ref')
  // While one is being edited the rest keep still: a handle counts the rows.
  const sorting = own.length > 1 && !own.some((reference) => editing.isOpen(formKey(reference)))
  return [
    own.length > 0
      ? el(
          'div',
          { class: 'it-ref-list' },
          own.map((reference, index) =>
            editing.isOpen(formKey(reference))
              ? referenceForm(editing, data, write, reference)
              : referenceRow(editing, reference, missing.has(reference.uid), null, [
                  sorting ? grip(write, own, index) : null,
                  iconButton('Edit this reference', ICONS.pencil, () => editing.start(formKey(reference), `${formKey(reference)}.target`), 'it-remove')
                ])
          )
        )
      : null,
    own.length === 0 && sources.length === 0 && !adding ? el('p', { class: 'it-none', text: 'No references yet.' }) : null,
    adding
      ? referenceForm(editing, data, write, null)
      : el('button', { class: 'it-add-row', attrs: { type: 'button' }, on: { click: () => editing.start('ref', 'ref.target') } }, [
          lineIcon(ICONS.plus, 12, 1.8),
          'Add a reference'
        ]),
    ...sources.flatMap(({ from, refs }) => [
      el('span', { class: 'work-cap it-cap', text: `From ${from.level} ${from.name}` }),
      ...refs.map((reference) => referenceRow(editing, reference, missing.has(reference.uid), from, []))
    ])
  ]
}

/**
 * The handle that drags an own reference into a new place, shown on hover
 * like the pencil beside it.
 *
 * @param {Writer} write
 * @param {Reference[]} own
 * @param {number} index
 */
function grip(write, own, index) {
  const handle = dragHandle({
    label: own[index].title,
    index,
    count: own.length,
    focusKey: `ref.grip.${own[index].uid}`,
    onMove: (to) => void write.reorder(moved(own, index, to).map((other) => other.uid))
  })
  handle.classList.add('it-remove')
  return handle
}

/** @param {Reference} reference */
function formKey(reference) {
  return `ref${reference.uid}`
}

/**
 * How this page's references are written.
 *
 * @param {Editing} editing
 * @param {References} data
 * @returns {Writer}
 */
function writer(editing, data) {
  const isItem = data.level === 'epic' || data.level === 'task'
  const owner = isItem ? { item: data.uid } : data.level === 'project' ? { project: data.uid } : { portfolio: data.uid }
  /** @param {Promise<unknown>} call */
  const landed = async (call) => (await call) !== undefined
  return {
    add: (input) => (isItem ? editing.edit({ refs: { add: [input] } }) : landed(editing.call('addRef', owner, input))),
    update: (uid, patch) => (isItem ? editing.edit({ refs: { edit: [{ uid, ...patch }] } }) : landed(editing.call('updateRef', owner, uid, patch))),
    remove: (uid) => (isItem ? editing.edit({ refs: { remove: [uid] } }) : landed(editing.call('removeRef', owner, uid))),
    reorder: (uids) => landed(editing.call('reorderRefs', owner, uids))
  }
}

/**
 * One reference. Pressing it opens or copies it; the tooltip has the whole
 * target, what pressing does, and for an inherited one where to change it.
 *
 * @param {Editing} editing
 * @param {Reference} reference
 * @param {boolean} missing a file that is no longer there
 * @param {InheritedReference['from'] | null} from where it comes from, when it is not the owner's own
 * @param {(Node | null)[]} actions buttons shown on hover, after it
 */
function referenceRow(editing, reference, missing, from, actions) {
  const action = refAction(reference, missing)
  const name = refName(reference)
  const reveals = action.via === 'system' && fileOpener(action.target, platformOf(navigator.userAgent)).reveals
  const says = {
    browser: 'Press to open in the Browser tab',
    system: reveals ? 'Press to show it in its folder: it is a program, so it is not run' : 'Press to open it',
    copy: reference.kind === 'file' ? 'Press to copy the path' : 'Press to copy the address'
  }[action.via]
  const press = {
    browser: () => void openLink(action.target),
    system: () => void openFile(action.target),
    copy: () => void editing.copy(action.target, action.target)
  }[action.via]
  const tip = [
    reference.target,
    missing ? 'Not found on this computer.' : null,
    from ? `From ${from.level} ${from.name}: change it there.` : reference.key ? 'Key: everything under it sees it too.' : null,
    says
  ]
  return el('div', { class: 'it-link it-ref', attrs: { 'data-sort-row': from === null } }, [
    el(
      'button',
      {
        class: 'it-link-main',
        title: tip.filter(Boolean).join('\n'),
        attrs: { type: 'button' },
        on: { click: press }
      },
      [
        el('span', { class: missing ? 'it-link-icon is-missing' : 'it-link-icon' }, [lineIcon(KIND_ICONS[reference.kind], 12, 2)]),
        el('span', { class: 'it-link-text' }, [
          el('span', { class: 'it-ref-name' }, [
            el('span', { class: name.mono ? 'work-ellip it-mono' : 'work-ellip', text: name.text }),
            reference.key && from === null ? el('span', { class: 'it-tag is-key', text: 'Key' }) : null,
            missing ? el('span', { class: 'it-tag is-missing', text: 'Missing' }) : null
          ]),
          el('span', { class: 'work-ellip it-link-meta', text: reference.use })
        ])
      ]
    ),
    ...actions
  ])
}

/**
 * A form field with its name over it.
 *
 * @param {string} text
 * @param {HTMLElement} control
 */
function labelled(text, control) {
  return el('label', { class: 'it-ref-field' }, [el('span', { text }), control])
}

/**
 * The form that adds a reference, or changes one in place: its target, the
 * kind (read from the target unless one is picked), its title, when to read
 * it and whether it is key. A changed target reads its kind again, unless
 * the person picked one.
 *
 * @param {Editing} editing
 * @param {References} data
 * @param {Writer} write
 * @param {Reference | null} reference null to add one
 */
function referenceForm(editing, data, write, reference) {
  const key = reference === null ? 'ref' : formKey(reference)
  const shownTitle = reference === null || refTitleIsTarget(reference) ? '' : reference.title
  const cancel = () => editing.close(key)
  const kindSelect = () =>
    editing.field(`${key}.kind`, () => {
      const select = el(
        'select',
        {
          class: 'helm-select it-select',
          attrs: { 'aria-label': 'Kind' },
          on: {
            change: () => {
              select.dataset.picked = 'true'
            }
          }
        },
        [el('option', { text: 'Kind from the target', attrs: { value: '' } }), ...REF_KINDS.map(([kind, text]) => el('option', { text, attrs: { value: kind } }))]
      )
      select.value = reference?.kind ?? ''
      return select
    })
  const keyBox = editing.field(`${key}.key`, () => {
    const box = el('input', { attrs: { type: 'checkbox' } })
    box.checked = reference?.key ?? false
    return box
  })

  const save = async () => {
    const target = editing.field(`${key}.target`, () => el('input')).value.trim()
    const title = editing.field(`${key}.title`, () => el('input')).value.trim()
    const use = editing.field(`${key}.use`, () => el('input')).value.trim()
    const kind = /** @type {RefKind | ''} */ (kindSelect().value)
    if (target === '') {
      toast('Write the address, or the file’s full path.')
      return
    }
    if (use === '') {
      toast('Say when to read it, like “Read when changing sync”.')
      return
    }
    if (reference === null) {
      if (await write.add({ target, title, use, key: keyBox.checked, ...(kind === '' ? {} : { kind }) })) editing.close(key)
      return
    }
    /** @type {RefPatch} */
    const patch = {}
    if (target !== reference.target) patch.target = target
    if (kind !== '' && (kind !== reference.kind || patch.target !== undefined)) patch.kind = kind
    if (title !== shownTitle) patch.title = title
    if (use !== reference.use) patch.use = use
    if (keyBox.checked !== reference.key) patch.key = keyBox.checked
    if (Object.keys(patch).length === 0) {
      editing.close(key)
      return
    }
    if (await write.update(reference.uid, patch)) editing.close(key)
  }
  const onEnter = () => void save()

  return el('div', { class: 'it-link-form it-ref-form' }, [
    labelled(
      'Address or path',
      lineField(editing, `${key}.target`, {
        value: reference?.target,
        label: 'Address or path',
        placeholder: 'https://…, or a file’s full path',
        onEnter,
        onEscape: cancel,
        onInput: () => {
          const select = kindSelect()
          if (select.dataset.picked !== 'true') select.value = ''
        }
      })
    ),
    labelled('Kind', kindSelect()),
    labelled('Title', lineField(editing, `${key}.title`, { value: shownTitle, label: 'Title', placeholder: 'Optional: the address or path shows instead', onEnter, onEscape: cancel })),
    labelled('When to read it', lineField(editing, `${key}.use`, { value: reference?.use, label: 'When to read it', placeholder: 'Read when …', onEnter, onEscape: cancel })),
    el('label', { class: 'it-ref-check' }, [keyBox, el('span', { text: 'Key' }), el('span', { class: 'it-hint', text: KEY_MEANS[data.level] })]),
    reference === null
      ? editorActions(onEnter, cancel, 'Enter adds')
      : el('div', { class: 'it-editor-actions' }, [
          button('Save', null, onEnter, 'primary'),
          button('Cancel', null, cancel, 'ghost'),
          el('span', { class: 'it-grow' }),
          button(
            'Remove',
            TRASH,
            () =>
              void write.remove(reference.uid).then((removed) => {
                if (removed) editing.close(key)
              }),
            'danger'
          )
        ])
  ])
}
