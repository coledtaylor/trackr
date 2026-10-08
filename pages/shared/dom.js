/**
 * DOM helpers the pages share: element building, the status icons and
 * colours of the v2 board, and the one-line item row.
 */

import { markSession } from './sessions.js'

const SVG = 'http://www.w3.org/2000/svg'

/**
 * @typedef {{ class?: string, text?: string, title?: string, style?: Record<string, string>,
 *   attrs?: Record<string, string | number | boolean | null | undefined>,
 *   on?: Record<string, (event: any) => void> }} Props
 */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Props} [props]
 * @param {(Node | string | null | false | undefined)[]} [children]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  if (props.class) node.className = props.class
  if (props.text !== undefined) node.textContent = props.text
  if (props.title) node.title = props.title
  for (const [name, value] of Object.entries(props.style ?? {})) node.style.setProperty(name, value)
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === false || value === null || value === undefined) continue
    node.setAttribute(name, value === true ? '' : String(value))
  }
  for (const [name, listener] of Object.entries(props.on ?? {})) node.addEventListener(name, listener)
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue
    node.append(child)
  }
  return node
}

/**
 * @param {string} tag
 * @param {Record<string, string | number>} attrs
 * @param {SVGElement[]} [children]
 * @returns {SVGElement}
 */
export function svg(tag, attrs, children = []) {
  const node = /** @type {SVGElement} */ (document.createElementNS(SVG, tag))
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  node.append(...children)
  return node
}

/**
 * An icon from path data, drawn in the current colour.
 *
 * @param {string} d
 * @param {number} size
 * @param {number} [stroke]
 */
export function lineIcon(d, size, stroke = 1.8) {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    [svg('path', { d })]
  )
}

export const ICONS = {
  search: 'M11 4a7 7 0 1 1 0 14a7 7 0 1 1 0-14zM20 20l-3.5-3.5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  close: 'M7 7l10 10M17 7L7 17',
  session: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 9l3 3-3 3M12 15h5',
  plus: 'M12 5v14M5 12h14',
  epic: 'M13.5 3L5.5 13.5h6L10.5 21l8-10.5h-6z',
  home: 'M4 11l8-6.5 8 6.5V20h-5v-5H9v5H4z',
  clock: 'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17zM12 7.5V12l3 2',
  waitsOn: 'M19 12H5M11 6l-6 6 6 6',
  pencil: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z',
  copy: 'M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM5 15V5a1 1 0 0 1 1-1h10',
  branch: 'M6 3.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM6 15.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM18 4.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM6 8.2v7.6M18 9.2c0 4.5-5 4.3-11 7.2',
  pr: 'M6 3.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM6 15.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM18 15.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM6 8.2v7.6M18 15.8V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  commit: 'M12 8a4 4 0 1 1 0 8a4 4 0 1 1 0-8zM3 12h5M16 12h5',
  person: 'M12 5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7zM5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 1 1 0 4a2 2 0 1 1 0-4zM10 15a2 2 0 1 1 0 4a2 2 0 1 1 0-4z'
}

const TONES = {
  subtle: 'var(--helm-fg-subtle)',
  muted: 'var(--helm-fg-muted)',
  accent: 'var(--helm-accent)',
  warn: 'var(--helm-warn)',
  danger: 'var(--helm-danger)',
  success: 'var(--helm-success)'
}

/**
 * A colour name from the model as CSS: a theme tone, or a categorical colour
 * that `work.css` defines per theme.
 *
 * @param {string} name
 */
export function colourVar(name) {
  return /** @type {Record<string, string>} */ (TONES)[name] ?? `var(--work-${name}, var(--helm-fg-muted))`
}

const NONE = 'M0 0'
const SURFACE = 'var(--helm-surface)'

/**
 * The v2 board's status shapes. `glyph: 'self'` draws the glyph in the
 * status's colour; otherwise it is cut out of a filled disc.
 *
 * @type {Record<string, { dash: string, filled: boolean, pie: string, glyph: string, glyphSelf?: boolean }>}
 */
const SHAPES = {
  backlog: { dash: '3 2.6', filled: false, pie: NONE, glyph: NONE },
  planning: { dash: '1.2 2.8', filled: false, pie: 'M12 10a2 2 0 1 1 0 4a2 2 0 1 1 0-4z', glyph: NONE },
  todo: { dash: 'none', filled: false, pie: NONE, glyph: NONE },
  doing: { dash: 'none', filled: false, pie: 'M12 12V7.5A4.5 4.5 0 0 1 12 16.5Z', glyph: NONE },
  review: { dash: 'none', filled: false, pie: 'M12 12V7.5A4.5 4.5 0 1 1 7.5 12Z', glyph: NONE },
  blocked: { dash: 'none', filled: false, pie: NONE, glyph: 'M8.5 12h7', glyphSelf: true },
  done: { dash: 'none', filled: true, pie: NONE, glyph: 'M8.3 12.4l2.5 2.5 4.9-5.1' },
  launch: { dash: 'none', filled: true, pie: NONE, glyph: 'M12 15.8V8.6M8.9 11.6L12 8.5l3.1 3.1' },
  cancelled: { dash: 'none', filled: true, pie: NONE, glyph: 'M9.3 9.3l5.4 5.4M14.7 9.3l-5.4 5.4' }
}

/**
 * @param {{ icon: string, colour: string, name?: string }} status
 * @param {number} size
 */
export function statusIcon(status, size) {
  const shape = SHAPES[status.icon] ?? SHAPES.todo
  const colour = colourVar(status.colour)
  const icon = svg('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'work-status-icon', 'aria-hidden': 'true' }, [
    svg('circle', { cx: 12, cy: 12, r: 8.5, fill: shape.filled ? colour : 'none', stroke: colour, 'stroke-width': 2, 'stroke-dasharray': shape.dash }),
    svg('path', { d: shape.pie, fill: colour }),
    svg('path', {
      d: shape.glyph,
      fill: 'none',
      stroke: shape.glyphSelf ? colour : SURFACE,
      'stroke-width': 2.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    })
  ])
  return icon
}

/**
 * A small square in a project's colour.
 *
 * @param {string} colour
 * @param {number} size
 */
export function swatch(colour, size) {
  return el('span', { class: 'work-swatch', style: { width: `${size}px`, height: `${size}px`, background: colourVar(colour) } })
}

/**
 * One item on one line: status icon, ID, title, and the project's colour when
 * the list crosses projects.
 *
 * @param {import('./types.js').ItemSummary} item
 * @param {{ onOpen: () => void, showProject?: boolean, current?: boolean }} options
 */
export function itemRow(item, options) {
  return el(
    'button',
    {
      class: 'work-item-row',
      title: `${item.id} ${item.title} · ${item.status.name} · ${item.project.name}`,
      attrs: { type: 'button', 'aria-current': options.current ? 'true' : null },
      on: { click: options.onOpen }
    },
    [
      statusIcon(item.status, 13),
      el('span', { class: 'work-id', text: item.id }),
      item.kind === 'epic' ? el('span', { class: 'work-kind', text: 'epic' }) : null,
      el('span', { class: 'work-ellip work-grow', text: item.title }),
      options.showProject ? swatch(item.project.colour, 7) : null
    ]
  )
}

/**
 * Replaces a node's children.
 *
 * @param {Element} parent
 * @param {(Node | null | false | undefined)[]} children
 */
export function fill(parent, children) {
  parent.replaceChildren(...children.filter((child) => child !== null && child !== false && child !== undefined))
}

/**
 * A colour mixed toward transparent, as the design tints tiles and bands.
 *
 * @param {string} colour a CSS colour
 * @param {number} percent
 */
export function tint(colour, percent) {
  return `color-mix(in srgb, ${colour} ${percent}%, transparent)`
}

/**
 * A rounded square with a letter or key on it, tinted in a project's colour,
 * or neutral without one.
 *
 * @param {string} text
 * @param {number} size
 * @param {string | null} colour a colour name from the model
 * @param {string} [extraClass]
 */
export function tile(text, size, colour, extraClass = '') {
  const c = colour === null ? null : colourVar(colour)
  return el('span', {
    class: `work-tile ${extraClass}`.trim(),
    text,
    style: {
      width: `${size}px`,
      height: `${size}px`,
      background: c === null ? 'var(--helm-surface-raised)' : tint(c, 16),
      border: `1px solid ${c === null ? 'var(--helm-border-strong)' : tint(c, 45)}`,
      color: c ?? 'var(--helm-fg)'
    }
  })
}

/**
 * The priority mark of the v2 board: a red square with "!" for the most
 * urgent, otherwise one to three bars.
 *
 * @param {{ urgent: boolean, bars: number }} mark from `priorityMark`
 * @param {string} name for the tooltip
 */
export function priorityGlyph(mark, name) {
  const holder = el('span', { class: 'work-priority', title: `${name} priority` })
  if (mark.urgent) {
    holder.append(
      svg('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' }, [
        svg('rect', { x: 1.5, y: 1.5, width: 13, height: 13, rx: 3, fill: 'var(--helm-danger)' }),
        svg('path', { d: 'M8 4.6v4.2M8 11.3v.1', stroke: 'var(--helm-surface)', 'stroke-width': 2, 'stroke-linecap': 'round' })
      ])
    )
  } else if (mark.bars > 0) {
    const on = mark.bars === 3 ? 'var(--helm-fg)' : 'var(--helm-fg-muted)'
    const off = 'var(--helm-border-strong)'
    holder.append(
      svg('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' }, [
        svg('rect', { x: 1.5, y: 9, width: 3, height: 5, rx: 1, fill: on }),
        svg('rect', { x: 6.5, y: 6, width: 3, height: 8, rx: 1, fill: mark.bars >= 2 ? on : off }),
        svg('rect', { x: 11.5, y: 3, width: 3, height: 11, rx: 1, fill: mark.bars >= 3 ? on : off })
      ])
    )
  }
  return holder
}

/**
 * The session on a task, as a chip, muted once the session no longer runs.
 *
 * @param {{ id: string, name: string }} session
 * @param {string} lastActive how long ago it last wrote, for the tooltip
 */
export function sessionChip(session, lastActive) {
  return markSession(
    el('span', { class: 'work-chip work-chip-session' }, [lineIcon(ICONS.session, 10, 2.2), el('span', { class: 'work-ellip', text: session.name })]),
    session,
    lastActive
  )
}

/**
 * The session on a task, as a small square: for cards with no room for a name.
 *
 * @param {{ id: string, name: string }} session
 */
export function sessionTile(session) {
  return markSession(el('span', { class: 'work-session-tile' }, [lineIcon(ICONS.session, 11, 2.2)]), session, '')
}

/**
 * The epic a task is in, as a chip.
 *
 * @param {{ id: string, title: string }} epic
 * @param {boolean} withId
 */
export function epicChip(epic, withId) {
  return el('span', { class: 'work-chip', title: `${epic.id} ${epic.title}` }, [
    svg('svg', { viewBox: '0 0 24 24', width: 10, height: 10, fill: 'none', stroke: 'var(--helm-accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'work-noshrink' }, [svg('path', { d: ICONS.epic })]),
    withId ? el('span', { class: 'work-chip-id', text: epic.id }) : null,
    el('span', { class: 'work-ellip', text: epic.title })
  ])
}

/**
 * "Waits on TC-123", in the warning colour.
 *
 * @param {string[]} ids
 */
export function waitsMark(ids) {
  return el('span', { class: 'work-waits', title: `Waits on ${ids.join(', ')}` }, [lineIcon(ICONS.clock, 11, 2), el('span', { class: 'work-mono', text: ids.join(' ') })])
}

/**
 * A bar in three parts: done in the colour, in progress half strength, not
 * started as a rule. Parts with nothing in them are left out.
 *
 * @param {{ done: number, active: number, open: number }} counts open is not started
 * @param {string} colour a CSS colour
 */
export function segments(counts, colour) {
  const parts = [
    { n: counts.done, bg: colour, title: `${counts.done} done` },
    { n: counts.active, bg: tint(colour, 55), title: `${counts.active} in progress` },
    { n: counts.open, bg: 'var(--helm-border-strong)', title: `${counts.open} not started` }
  ].filter((part) => part.n > 0)
  return el(
    'span',
    { class: 'work-segments' },
    parts.map((part) => el('span', { title: part.title, style: { flex: `${part.n} 1 0`, background: part.bg } }))
  )
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer

/**
 * A short message at the foot of the page, gone after a few seconds. Uses the
 * page's `.work-toast` element, or adds one.
 *
 * @param {string} text
 */
export function toast(text) {
  let node = /** @type {HTMLElement | null} */ (document.querySelector('.work-toast'))
  if (node === null) {
    node = el('div', { class: 'work-toast', attrs: { role: 'status', hidden: true } })
    document.body.append(node)
  }
  const shown = node
  fill(shown, [lineIcon('M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17zM12 11v5M12 8v.1', 13, 2), el('span', { text })])
  shown.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    shown.hidden = true
  }, 3200)
}

/**
 * What a select shows when closed: the chosen option, cut to one line.
 * Helm draws every select as `base-select`, which ignores `overflow` on the
 * select itself, so a long option (an epic's title) would run out of the box;
 * a face of its own can be cut. It goes first in the select.
 */
export function selectFace() {
  return el('button', { class: 'work-select-face', attrs: { type: 'button', tabindex: -1 } }, [document.createElement('selectedcontent')])
}

/**
 * Draws a pane again, keeping what the person was doing: the focused field
 * and its caret, the element marked with the same `data-focus`, and the
 * scroll position.
 *
 * `build` makes the new children. It runs after the focus is noted: a field
 * kept across draws leaves the page, and loses the focus, the moment the new
 * tree takes it.
 *
 * @param {HTMLElement} root
 * @param {() => (Node | null | false)[]} build
 * @param {string | null} [focusKey] a `data-focus` to focus once drawn, over what had it
 */
export function redraw(root, build, focusKey = null) {
  const focused = document.activeElement
  const key = focusKey ?? (focused instanceof HTMLElement ? focused.dataset.focus ?? null : null)
  const selection =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection ?? undefined }
      : null
  const scroller = root.scrollTop
  fill(root, build())
  root.scrollTop = scroller
  const keyed = key === null ? null : /** @type {HTMLElement | null} */ (root.querySelector(`[data-focus="${CSS.escape(key)}"]`))
  if (keyed) {
    keyed.focus({ preventScroll: true })
    return
  }
  if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) {
    focused.focus({ preventScroll: true })
    if (selection && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && focused.type !== 'checkbox') {
      focused.setSelectionRange(selection.start, selection.end, selection.direction)
    }
  }
}
