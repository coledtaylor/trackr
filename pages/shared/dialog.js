/**
 * A dialog inside the page, over whatever the page shows: the confirmation a
 * delete asks for, and the new task form in a tab. Helm has no dialog for
 * plugins, so this is the page's own: a modal `<dialog>`, which takes the
 * focus, keeps it inside, and closes on Escape.
 */

import { ICONS, el, lineIcon } from './dom.js'

/**
 * @typedef {{ close(): void, node: HTMLDialogElement, setBusy(busy: boolean): void }} DialogHandle
 * @typedef {{
 *   label: string,
 *   icon?: string,
 *   tone?: 'danger' | null,
 *   meta?: string | Node,
 *   body: (Node | string | null | false)[],
 *   foot: (Node | string | null | false)[],
 *   width?: number,
 *   onClose?: () => void
 * }} DialogOptions
 */

/**
 * Opens a dialog. It is taken out of the page when it closes, by any way.
 *
 * @param {DialogOptions} options
 * @returns {DialogHandle}
 */
export function openDialog(options) {
  const close = el('button', { class: 'helm-icon-button', title: 'Close', attrs: { type: 'button', 'aria-label': 'Close' } }, [lineIcon(ICONS.close, 13, 2)])
  const dialog = el(
    'dialog',
    {
      class: 'work-dialog',
      style: { width: `min(${options.width ?? 460}px, calc(100% - 32px))` },
      attrs: { 'aria-label': options.label }
    },
    [
      el('div', { class: 'work-dialog-head' }, [
        el('span', { class: options.tone === 'danger' ? 'work-dialog-tile work-dialog-tile-danger' : 'work-dialog-tile' }, [lineIcon(options.icon ?? ICONS.plus, 12, 2)]),
        el('span', { class: 'work-dialog-title work-ellip', text: options.label }),
        options.meta ? el('span', { class: 'work-dialog-meta work-mono' }, [options.meta]) : null,
        el('span', { class: 'work-grow' }),
        close
      ]),
      el('div', { class: 'work-dialog-body' }, options.body),
      el('div', { class: 'work-dialog-foot' }, options.foot)
    ]
  )
  const dialogElement = /** @type {HTMLDialogElement} */ (dialog)
  let busy = false
  // Escape is the browser's cancel; a write in flight keeps it open.
  dialogElement.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault()
  })
  dialogElement.addEventListener('close', () => {
    dialogElement.remove()
    options.onClose?.()
  })
  // A press on the backdrop is a press on the dialog element itself.
  dialogElement.addEventListener('mousedown', (event) => {
    if (event.target === dialogElement && !busy) dialogElement.close()
  })
  close.addEventListener('click', () => {
    if (!busy) dialogElement.close()
  })
  document.body.append(dialogElement)
  dialogElement.showModal()
  return {
    node: dialogElement,
    close() {
      if (dialogElement.open) dialogElement.close()
    },
    setBusy(value) {
      busy = value
      for (const button of dialogElement.querySelectorAll('.work-dialog-foot button')) /** @type {HTMLButtonElement} */ (button).disabled = value
    }
  }
}

/** A bin: the icon of a delete. */
export const TRASH = 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'

/**
 * @typedef {{
 *   title: string,
 *   meta?: string,
 *   lines: (Node | string)[],
 *   extra?: Node | null,
 *   confirm: string,
 *   typeToConfirm?: string,
 *   icon?: string,
 *   refusal?: boolean,
 *   run: () => Promise<unknown>
 * }} ConfirmOptions
 */

/**
 * Asks before something that cannot be undone. `run` is the write: while it
 * runs the dialog stays open, and if it fails the reason shows in the dialog.
 * With `typeToConfirm`, the confirm button waits until that text is typed.
 * With `refusal`, the lines say why it cannot be done and the only button
 * closes the dialog.
 *
 * @param {ConfirmOptions} options
 * @returns {Promise<boolean>} whether it ran
 */
export function confirmDanger(options) {
  return new Promise((resolve) => {
    let done = false
    const error = el('p', { class: 'work-dialog-error', attrs: { role: 'alert', hidden: true } })
    const confirm = /** @type {HTMLButtonElement} */ (
      el('button', { class: 'helm-button', text: options.confirm, attrs: { type: 'button', 'data-variant': 'danger' } })
    )
    const cancel = el('button', { class: 'helm-button', text: options.refusal ? 'Close' : 'Cancel', attrs: { type: 'button', 'data-variant': options.refusal ? null : 'ghost' } })
    /** @type {HTMLInputElement | null} */
    let typed = null
    if (options.typeToConfirm !== undefined) {
      const expected = options.typeToConfirm
      typed = /** @type {HTMLInputElement} */ (
        el('input', {
          class: 'helm-input work-dialog-typed',
          attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${expected} to confirm`, placeholder: expected }
        })
      )
      const input = typed
      const check = () => {
        confirm.disabled = input.value.trim() !== expected
      }
      input.addEventListener('input', check)
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !confirm.disabled) {
          event.preventDefault()
          void go()
        }
      })
      check()
    }
    const dialog = openDialog({
      label: options.title,
      icon: options.icon ?? TRASH,
      tone: 'danger',
      meta: options.meta,
      body: [
        ...options.lines.map((line) => (typeof line === 'string' ? el('p', { class: 'work-dialog-text', text: line }) : line)),
        options.extra ?? null,
        typed
          ? el('label', { class: 'work-dialog-field' }, [
              el('span', {}, ['Type ', el('span', { class: 'work-mono', text: options.typeToConfirm ?? '' }), ' to confirm']),
              typed
            ])
          : null,
        error
      ],
      foot: options.refusal ? [el('span', { class: 'work-grow' }), cancel] : [el('span', { class: 'work-grow' }), cancel, confirm],
      onClose: () => resolve(done)
    })
    const typedDisabled = () => typed !== null && typed.value.trim() !== options.typeToConfirm
    async function go() {
      dialog.setBusy(true)
      error.hidden = true
      try {
        await options.run()
        done = true
        dialog.setBusy(false)
        dialog.close()
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : String(failure)
        error.hidden = false
        dialog.setBusy(false)
        confirm.disabled = typedDisabled()
      }
    }
    confirm.addEventListener('click', () => void go())
    cancel.addEventListener('click', () => dialog.close())
    ;(typed ?? cancel).focus()
  })
}
