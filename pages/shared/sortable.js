/**
 * Rows put in order by dragging their handle, or by Up and Down on a focused
 * handle. The rows are the children of one list marked `data-sort-row`; the
 * handle moves its own row on screen at once, then `onMove` writes the order
 * and the page draws again.
 */

import { el, svg } from './dom.js'

const GRIP = [
  [9, 6],
  [15, 6],
  [9, 12],
  [15, 12],
  [9, 18],
  [15, 18]
]

/**
 * @param {{ label: string, index: number, count: number, focusKey: string, onMove: (to: number) => void }} options
 */
export function dragHandle({ label, index, count, focusKey, onMove }) {
  const handle = el(
    'button',
    {
      class: 'work-grip',
      title: `Drag to move ${label}, or press Up and Down`,
      attrs: { type: 'button', 'aria-label': `Move ${label}: ${index + 1} of ${count}. Press Up or Down.`, 'data-focus': focusKey, disabled: count < 2 }
    },
    [
      svg(
        'svg',
        { viewBox: '0 0 24 24', width: 12, height: 12, fill: 'currentColor', 'aria-hidden': 'true' },
        GRIP.map(([cx, cy]) => svg('circle', { cx, cy, r: 1.5 }))
      )
    ]
  )

  handle.addEventListener('keydown', (event) => {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null
    if (to === null) return
    event.preventDefault()
    if (to < 0 || to >= count) return
    const row = handle.closest('[data-sort-row]')
    const list = row?.parentElement
    if (row && list) {
      const rows = rowsOf(list)
      list.insertBefore(row, to > index ? rows[to].nextSibling : rows[to])
      handle.focus()
    }
    onMove(to)
  })

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || count < 2) return
    const row = /** @type {HTMLElement | null} */ (handle.closest('[data-sort-row]'))
    const list = row?.parentElement
    if (!row || !list) return
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)
    handle.focus({ preventScroll: true })
    const rows = rowsOf(list)
    const tops = rows.map((candidate) => candidate.getBoundingClientRect())
    const height = tops[index].height
    const startY = event.clientY
    let target = index
    row.classList.add('work-dragging')

    /** @param {PointerEvent} move */
    const onPointerMove = (move) => {
      const dy = Math.max(tops[0].top - tops[index].top, Math.min(tops[count - 1].bottom - tops[index].bottom, move.clientY - startY))
      row.style.transform = `translateY(${dy}px)`
      const middle = tops[index].top + height / 2 + dy
      target = index
      for (let other = 0; other < count; other++) {
        const centre = tops[other].top + tops[other].height / 2
        // Reaching a row's centre crosses it: the drag stops at the list's ends,
        // where the middle can only meet the end row's centre.
        if (other < index && middle <= centre) target = Math.min(target, other)
        if (other > index && middle >= centre) target = Math.max(target, other)
      }
      rows.forEach((other, at) => {
        if (at === index) return
        const shift = at >= target && at < index ? height : at <= target && at > index ? -height : 0
        other.style.transform = shift === 0 ? '' : `translateY(${shift}px)`
      })
    }
    const finish = (/** @type {boolean} */ commit) => {
      handle.removeEventListener('pointermove', onPointerMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onCancel)
      row.classList.remove('work-dragging')
      for (const other of rows) other.style.transform = ''
      if (!commit || target === index) return
      list.insertBefore(row, target > index ? rows[target].nextSibling : rows[target])
      onMove(target)
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    handle.addEventListener('pointermove', onPointerMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onCancel)
  })

  return handle
}

/** @param {Element} list */
function rowsOf(list) {
  return /** @type {HTMLElement[]} */ ([...list.children].filter((child) => child.hasAttribute('data-sort-row')))
}
