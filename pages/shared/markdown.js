/**
 * Markdown as the pages draw it: descriptions and handoffs as blocks,
 * criteria and log lines as one run of text. The result is a tree of plain
 * objects, so node:test can check it; the views draw it with `el`, never as
 * HTML, so markup in the text stays text.
 *
 * Blocks: ATX headings, paragraphs, bullet, ordered and task lists nested by
 * indent, fenced code, quotes, rules and pipe tables. Inline: code, strong,
 * emphasis, strikethrough, links, `<address>` and bare http(s) addresses.
 * A single line break stays a line break, as in a GitHub comment.
 *
 * Where agents' text and CommonMark disagree, the text wins. `*` and `~~`
 * open only at the start, after a space or after an opening bracket or
 * quote, so `part-*.patch` keeps its star. `_` is never emphasis, so
 * snake_case stays as written. A backslash escapes only markup characters
 * (and `"`), so `C:\Users\me\.config` and `\\server\share` keep theirs.
 * There are no indented code blocks, setext headings or reference links.
 *
 * A description can be 100,000 characters, and the page reads it on every
 * draw, so every step is linear in the text: no regular expression can
 * backtrack across a line, nesting stops at a fixed depth, and a link's
 * address is looked for over a bounded stretch.
 */

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'code', text: string }
 *   | { type: 'strong' | 'em' | 'del', children: Inline[] }
 *   | { type: 'link', href: string, children: Inline[] }
 *   | { type: 'break' }} Inline
 * @typedef {'left' | 'center' | 'right' | null} Align
 * @typedef {{ checked: boolean | null, children: Block[] }} ListItem
 * @typedef {{ type: 'paragraph', children: Inline[] }
 *   | { type: 'heading', level: number, children: Inline[] }
 *   | { type: 'code', lang: string, text: string }
 *   | { type: 'quote', children: Block[] }
 *   | { type: 'list', ordered: boolean, start: number, loose: boolean, items: ListItem[] }
 *   | { type: 'rule' }
 *   | { type: 'table', align: Align[], head: Inline[][], rows: Inline[][][] }} Block
 * @typedef {{ kind: string, ordered: boolean, start: number, contentIndent: number, content: string }} Marker
 */

/** How deep quotes and lists nest; deeper markers are read as text. */
const MAX_BLOCK_DEPTH = 16
/** How many `*` and `~~` runs can wait for their closer at once, which bounds how deep emphasis nests. */
const MAX_OPENERS = 64
/** The longest link address looked for, the longest Helm opens. */
const MAX_ADDRESS = 2048

const BLANK = /^[ \t]*$/
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const MARKER = /^( *)([-*+]|(\d{1,9})([.)]))( +|$)(.*)$/
const TASK = /^\[([ xX])\](?:[ \t]+|$)(.*)$/
const DIVIDER_CHARS = /^[|:\- \t]+$/
const DIVIDER_CELL = /^:?-+:?$/

/**
 * @param {string} text
 * @returns {Block[]}
 */
export function markdownBlocks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(expandTabs)
  return parseBlocks(lines, 0).blocks
}

/**
 * One run of text: no blocks, every line break kept.
 *
 * @param {string} text
 * @returns {Inline[]}
 */
export function markdownInline(text) {
  return parseInline(text.replace(/\r\n?/g, '\n').trim(), true)
}

/**
 * What a run of Markdown says without its markup: an accessible name.
 *
 * @param {string} text
 */
export function plainText(text) {
  return inlineText(markdownInline(text))
}

/**
 * @param {Inline[]} nodes
 * @returns {string}
 */
function inlineText(nodes) {
  return nodes.map((node) => (node.type === 'text' || node.type === 'code' ? node.text : node.type === 'break' ? ' ' : inlineText(node.children))).join('')
}

/** @param {string} line */
function expandTabs(line) {
  let column = 0
  let tabbed = false
  let i = 0
  for (; line[i] === ' ' || line[i] === '\t'; i++) {
    tabbed ||= line[i] === '\t'
    column = line[i] === '\t' ? column + 4 - (column % 4) : column + 1
  }
  return tabbed ? ' '.repeat(column) + line.slice(i) : line
}

/** @param {string} line */
function indentOf(line) {
  return line.length - line.trimStart().length
}

// ---------------------------------------------------------------------------
// Blocks

/**
 * @param {string[]} lines
 * @param {number} depth how many quotes and list items hold these lines
 * @returns {{ blocks: Block[], spaced: boolean }} spaced: a blank line sits between two blocks
 */
function parseBlocks(lines, depth) {
  /** @type {Block[]} */
  const blocks = []
  const nests = depth < MAX_BLOCK_DEPTH
  let spaced = false
  let blankBefore = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (BLANK.test(line)) {
      blankBefore = true
      i++
      continue
    }
    if (blankBefore && blocks.length > 0) spaced = true
    blankBefore = false

    const fence = openingFence(line)
    if (fence) {
      i = parseFence(lines, i, fence, blocks)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(headingText(heading[2] ?? ''), true) })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }
    if (nests && QUOTE.test(line)) {
      i = parseQuote(lines, i, depth, blocks)
      continue
    }
    const marker = nests ? listMarker(line) : null
    if (marker) {
      i = parseList(lines, i, marker, depth, blocks)
      continue
    }
    if (tableStarts(lines, i)) {
      i = parseTable(lines, i, blocks)
      continue
    }
    i = parseParagraph(lines, i, blocks)
  }
  return { blocks, spaced }
}

/**
 * A heading's text without its closing #s, which need a space before them.
 *
 * @param {string} raw
 */
function headingText(raw) {
  const text = raw.trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end === text.length) return text
  return end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t' ? text.slice(0, end).trim() : text
}

/**
 * A fence that opens a code block. A backtick fence cannot have a backtick
 * after it: that is inline code.
 *
 * @param {string} line
 */
function openingFence(line) {
  const fence = FENCE.exec(line)
  return fence && !(fence[2][0] === '`' && fence[3].includes('`')) ? fence : null
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {RegExpExecArray} fence
 * @param {Block[]} blocks
 */
function parseFence(lines, start, fence, blocks) {
  const indent = fence[1].length
  const mark = fence[2]
  /** @type {string[]} */
  const body = []
  let i = start + 1
  while (i < lines.length && !closesFence(lines[i], mark)) {
    const line = lines[i]
    body.push(line.slice(Math.min(indent, indentOf(line))))
    i++
  }
  blocks.push({ type: 'code', lang: fence[3].trim().split(/\s+/)[0] ?? '', text: body.join('\n') })
  return i + 1
}

/**
 * @param {string} line
 * @param {string} mark the opening fence's backticks or tildes
 */
function closesFence(line, mark) {
  const fence = FENCE.exec(line)
  return fence !== null && fence[2][0] === mark[0] && fence[2].length >= mark.length && BLANK.test(fence[3])
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {number} depth
 * @param {Block[]} blocks
 */
function parseQuote(lines, start, depth, blocks) {
  /** @type {string[]} */
  const body = []
  let i = start
  while (i < lines.length) {
    const quoted = QUOTE.exec(lines[i])
    if (quoted) body.push(quoted[1])
    else if (!BLANK.test(lines[i]) && !BLANK.test(body[body.length - 1] ?? '') && !startsBlock(lines[i])) body.push(lines[i])
    else break
    i++
  }
  blocks.push({ type: 'quote', children: parseBlocks(body, depth + 1).blocks })
  return i
}

/**
 * @param {string} line
 * @returns {Marker | null}
 */
function listMarker(line) {
  const match = MARKER.exec(line)
  if (!match) return null
  const indent = match[1].length
  const gap = match[5].length
  const ordered = match[3] !== undefined
  return {
    kind: ordered ? match[4] : match[2],
    ordered,
    start: ordered ? Number(match[3]) : 1,
    contentIndent: indent + match[2].length + (gap === 0 || gap > 4 ? 1 : gap),
    content: match[6]
  }
}

/**
 * Whether a line ends the paragraph above it.
 *
 * @param {string} line
 */
function startsBlock(line) {
  if (openingFence(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true
  const marker = listMarker(line)
  return marker !== null && marker.content.trim() !== '' && (!marker.ordered || marker.start === 1)
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {Marker} first
 * @param {number} depth
 * @param {Block[]} blocks
 */
function parseList(lines, start, first, depth, blocks) {
  /** @type {ListItem[]} */
  const items = []
  let loose = false
  let i = start
  /** @type {Marker | null} */
  let marker = first
  while (marker !== null) {
    const body = [marker.content]
    let fenced = openingFence(marker.content) !== null
    i++
    while (i < lines.length) {
      const line = lines[i]
      if (BLANK.test(line)) {
        body.push('')
      } else if (indentOf(line) >= marker.contentIndent) {
        const inner = line.slice(marker.contentIndent)
        if (FENCE.test(inner)) fenced = !fenced
        body.push(inner)
      } else if (!fenced && body[body.length - 1] !== '' && !startsBlock(line) && listMarker(line) === null) {
        body.push(line.trim())
      } else {
        break
      }
      i++
    }
    let trailingBlank = false
    while (body.length > 1 && body[body.length - 1] === '') {
      body.pop()
      trailingBlank = true
    }
    const task = TASK.exec(body[0])
    if (task) body[0] = task[2]
    const parsed = parseBlocks(body, depth + 1)
    items.push({ checked: task ? task[1] !== ' ' : null, children: parsed.blocks })
    if (parsed.spaced) loose = true

    const next = i < lines.length ? listMarker(lines[i]) : null
    marker = next !== null && next.kind === first.kind ? next : null
    if (marker !== null && trailingBlank) loose = true
    if (marker === null && trailingBlank) i = backToBlank(lines, i)
  }
  blocks.push({ type: 'list', ordered: first.ordered, start: first.start, loose, items })
  return i
}

/**
 * The blank lines a list ended on belong to what follows, so a block after
 * the list counts them.
 *
 * @param {string[]} lines
 * @param {number} i
 */
function backToBlank(lines, i) {
  let at = i
  while (at > 0 && BLANK.test(lines[at - 1])) at--
  return at
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {Block[]} blocks
 */
function parseParagraph(lines, start, blocks) {
  /** @type {string[]} */
  const body = [lines[start].trim()]
  let i = start + 1
  while (i < lines.length && !BLANK.test(lines[i]) && !startsBlock(lines[i]) && !tableStarts(lines, i)) {
    body.push(lines[i].trim())
    i++
  }
  blocks.push({ type: 'paragraph', children: parseInline(body.join('\n'), true) })
  return i
}

// ---------------------------------------------------------------------------
// Tables

/**
 * A header row with a divider row under it that has as many cells.
 *
 * @param {string[]} lines
 * @param {number} i
 */
function tableStarts(lines, i) {
  const header = lines[i]
  const divider = lines[i + 1]
  if (divider === undefined || !header.includes('|')) return false
  const cells = dividerCells(divider)
  if (cells === null || (!divider.includes('|') && !header.trim().startsWith('|'))) return false
  return tableCells(header).length === cells.length
}

/**
 * A divider row's cells, like `:--` and `--:`, or null when the line is not one.
 *
 * @param {string} line
 */
function dividerCells(line) {
  if (!line.includes('-') || !DIVIDER_CHARS.test(line)) return null
  const cells = tableCells(line)
  return cells.every((cell) => DIVIDER_CELL.test(cell)) ? cells : null
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {Block[]} blocks
 */
function parseTable(lines, start, blocks) {
  const head = tableCells(lines[start])
  /** @type {Align[]} */
  const align = (dividerCells(lines[start + 1]) ?? []).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null
  })
  /** @type {Inline[][][]} */
  const rows = []
  let i = start + 2
  while (i < lines.length && !BLANK.test(lines[i]) && lines[i].includes('|') && !startsBlock(lines[i])) {
    const cells = tableCells(lines[i])
    rows.push(head.map((_, column) => parseInline(cells[column] ?? '', true)))
    i++
  }
  blocks.push({ type: 'table', align, head: head.map((cell) => parseInline(cell, true)), rows })
  return i
}

/**
 * A row's cells, split on pipes that are not escaped. `\|` is a pipe in a cell.
 *
 * @param {string} line
 */
function tableCells(line) {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

// ---------------------------------------------------------------------------
// Inline

const ESCAPABLE = /[`*_~[\]!<>#+\-|"]/
const SPACE = /\s/
const PUNCTUATION = /[\p{P}\p{S}]/u
const OPENS_BEFORE = new Set(['(', '[', '{', '"', "'", '“', '‘', '«', '*', '~', '_'])
const URL_BEFORE = new Set(['(', '*', '~', '_', '"', "'"])
const URL_TRAILING = new Set(['?', '!', '.', ',', ':', ';', '*', '_', '~', "'", '"'])
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y
const BARE_URL = /https?:\/\/[^\s<]+/iy
const URL_HOST = /^https?:\/\/[^/?#\s]*[A-Za-z0-9]/i
const BACKSLASH = 0x5c
const OPEN_PAREN = 0x28
const CLOSE_PAREN = 0x29

/**
 * @typedef {{ type: 'text', text: string }} TextNode
 * @typedef {{ char: string, count: number, length: number, canClose: boolean, node: TextNode, index: number }} Opener
 */

/**
 * The code spans of one run of text. A search for a closing run of some
 * length that found none from one place finds none from any later place, so
 * it is remembered.
 */
class CodeSpans {
  /** @param {string} source */
  constructor(source) {
    this.source = source
    /** @type {Map<number, number>} for each run length, the earliest place no closer follows */
    this.none = new Map()
  }

  /**
   * Where the backtick run that closes one of `length` backticks starts, or -1.
   *
   * @param {number} from
   * @param {number} length
   */
  closer(from, length) {
    if ((this.none.get(length) ?? Infinity) <= from) return -1
    const { source } = this
    let i = source.indexOf('`', from)
    while (i !== -1) {
      const run = runLength(source, i, '`')
      if (run === length) return i
      i = source.indexOf('`', i + run)
    }
    this.none.set(length, from)
    return -1
  }
}

/**
 * @param {string} source
 * @param {boolean} links false inside a link's text: links do not nest
 * @returns {Inline[]}
 */
function parseInline(source, links) {
  const spans = new CodeSpans(source)
  const brackets = links && source.includes('[') ? bracketPairs(source, spans) : null
  /** @type {Inline[]} */
  const nodes = []
  /** @type {Opener[]} */
  const openers = []
  /** @type {Map<string, number>} where the search for each kind of closer's opener stops */
  const floors = new Map()
  let buffer = ''
  const flush = () => {
    if (buffer !== '') nodes.push({ type: 'text', text: buffer })
    buffer = ''
  }

  let i = 0
  while (i < source.length) {
    const char = source[i]
    if (char === '\\' && i + 1 < source.length) {
      const next = source[i + 1]
      if (next === '\n') {
        flush()
        nodes.push({ type: 'break' })
        i = skipIndent(source, i + 2)
      } else {
        buffer += ESCAPABLE.test(next) ? next : char + next
        i += 2
      }
      continue
    }
    if (char === '\n') {
      buffer = buffer.trimEnd()
      flush()
      nodes.push({ type: 'break' })
      i = skipIndent(source, i + 1)
      continue
    }
    if (char === '`') {
      const run = runLength(source, i, '`')
      const close = spans.closer(i + run, run)
      if (close === -1) {
        buffer += '`'.repeat(run)
      } else {
        flush()
        nodes.push({ type: 'code', text: codeText(source.slice(i + run, close)) })
      }
      i = close === -1 ? i + run : close + run
      continue
    }
    if (brackets && (char === '[' || (char === '!' && source[i + 1] === '['))) {
      const link = parseLink(source, char === '!' ? i + 1 : i, brackets)
      if (link) {
        flush()
        nodes.push(link.node)
        i = link.end
        continue
      }
    }
    if (links && char === '<') {
      AUTOLINK.lastIndex = i
      const auto = AUTOLINK.exec(source)
      if (auto) {
        flush()
        nodes.push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1] }] })
        i += auto[0].length
        continue
      }
    }
    if (links && (char === 'h' || char === 'H') && urlMayStart(source, i)) {
      BARE_URL.lastIndex = i
      const match = BARE_URL.exec(source)
      if (match) {
        const url = bareUrl(match[0])
        if (url === null) {
          buffer += match[0]
          i += match[0].length
        } else {
          flush()
          nodes.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] })
          i += url.length
        }
        continue
      }
    }
    if (char === '*' || char === '~') {
      const run = runLength(source, i, char)
      if (char === '*' || run === 2) {
        flush()
        delimiterRun(source, i, char, run, nodes, openers, floors)
      } else {
        buffer += char.repeat(run)
      }
      i += run
      continue
    }
    buffer += char
    i++
  }
  flush()
  return tidy(nodes)
}

/**
 * A run of `*` or `~~`: closes what it can, then what is left may open.
 *
 * @param {string} source
 * @param {number} at
 * @param {string} char
 * @param {number} length
 * @param {Inline[]} nodes
 * @param {Opener[]} openers
 * @param {Map<string, number>} floors
 */
function delimiterRun(source, at, char, length, nodes, openers, floors) {
  const before = at > 0 ? source[at - 1] : ' '
  const after = at + length < source.length ? source[at + length] : ' '
  const canOpen = !SPACE.test(after) && (SPACE.test(before) || OPENS_BEFORE.has(before))
  const canClose = !SPACE.test(before) && (!PUNCTUATION.test(before) || SPACE.test(after) || PUNCTUATION.test(after))
  let left = length

  if (canClose) {
    const key = `${char}${canOpen ? 1 : 0}${length % 3}`
    while (left > 0) {
      const floor = floors.get(key) ?? 0
      let found = -1
      for (let k = openers.length - 1; k >= floor; k--) {
        const opener = openers[k]
        if (opener.char !== char) continue
        const oddMatch = (opener.canClose || canOpen) && (opener.length + length) % 3 === 0 && !(opener.length % 3 === 0 && length % 3 === 0)
        if (char === '*' && oddMatch) continue
        found = k
        break
      }
      if (found === -1) {
        floors.set(key, openers.length)
        break
      }
      const opener = openers[found]
      const used = char === '~' ? 2 : opener.count >= 2 && left >= 2 ? 2 : 1
      const children = nodes.splice(opener.index + 1)
      nodes.push({ type: char === '~' ? 'del' : used === 2 ? 'strong' : 'em', children })
      opener.count -= used
      opener.node.text = char.repeat(opener.count)
      left -= used
      openers.length = opener.count > 0 ? found + 1 : found
      for (const [name, floor] of floors) if (floor > openers.length) floors.set(name, openers.length)
    }
  }

  if (left === 0) return
  /** @type {TextNode} */
  const node = { type: 'text', text: char.repeat(left) }
  nodes.push(node)
  if (canOpen && openers.length < MAX_OPENERS) openers.push({ char, count: left, length, canClose, node, index: nodes.length - 1 })
}

/**
 * Text nodes side by side made one, empty ones dropped.
 *
 * @param {Inline[]} nodes
 * @returns {Inline[]}
 */
function tidy(nodes) {
  /** @type {Inline[]} */
  const out = []
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.text === '') continue
      const last = out[out.length - 1]
      if (last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + node.text }
      else out.push({ type: 'text', text: node.text })
    } else if (node.type === 'strong' || node.type === 'em' || node.type === 'del' || node.type === 'link') {
      out.push({ ...node, children: tidy(node.children) })
    } else {
      out.push(node)
    }
  }
  return out
}

/**
 * @param {string} source
 * @param {number} at
 */
function skipIndent(source, at) {
  let i = at
  while (source[i] === ' ' || source[i] === '\t') i++
  return i
}

/**
 * @param {string} source
 * @param {number} at
 * @param {string} char
 */
function runLength(source, at, char) {
  let i = at
  while (source[i] === char) i++
  return i - at
}

/**
 * A code span's text: line breaks are spaces, and one space each side comes
 * off when both are there and it is not all spaces.
 *
 * @param {string} raw between the backticks
 */
function codeText(raw) {
  const text = raw.replace(/\n/g, ' ')
  return text.length > 2 && text[0] === ' ' && text[text.length - 1] === ' ' && text.trim() !== '' ? text.slice(1, -1) : text
}

/**
 * Each `[` and the `]` that closes it, in one pass that skips escapes and
 * code spans as the inline pass does.
 *
 * @param {string} source
 * @param {CodeSpans} spans
 * @returns {Map<number, number>}
 */
function bracketPairs(source, spans) {
  /** @type {Map<number, number>} */
  const pairs = new Map()
  /** @type {number[]} */
  const open = []
  let i = 0
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '`') {
      const run = runLength(source, i, '`')
      const close = spans.closer(i + run, run)
      i = close === -1 ? i + run : close + run
      continue
    }
    if (char === '[') open.push(i)
    else if (char === ']' && open.length > 0) pairs.set(/** @type {number} */ (open.pop()), i)
    i++
  }
  return pairs
}

/**
 * `[text](address "title")` at `at`, or null. An image's text is drawn as a
 * link to it.
 *
 * @param {string} source
 * @param {number} at the `[`
 * @param {Map<number, number>} brackets
 * @returns {{ node: Inline, end: number } | null}
 */
function parseLink(source, at, brackets) {
  const close = brackets.get(at)
  if (close === undefined || source[close + 1] !== '(') return null
  const limit = Math.min(source.length, close + 2 + MAX_ADDRESS)
  let i = skipSpace(source, close + 2)
  let href = ''
  if (source[i] === '<') {
    const end = indexBefore(source, '>', i + 1, limit)
    if (end === -1 || source.slice(i + 1, end).includes('\n')) return null
    href = source.slice(i + 1, end)
    i = end + 1
  } else {
    let depth = 0
    const begin = i
    for (let code = source.charCodeAt(i); i < limit && code > 32; code = source.charCodeAt(++i)) {
      if (code === BACKSLASH && i + 1 < source.length) i++
      else if (code === OPEN_PAREN) depth++
      else if (code === CLOSE_PAREN) {
        if (depth === 0) break
        depth--
      }
    }
    if (i === limit && limit < source.length) return null
    href = source.slice(begin, i).replace(/\\([!-/:-@[-`{-~])/g, '$1')
  }
  i = skipSpace(source, i)
  const quote = source[i]
  if (quote === '"' || quote === "'" || quote === '(') {
    const end = indexBefore(source, quote === '(' ? ')' : quote, i + 1, Math.min(source.length, i + 1 + MAX_ADDRESS))
    if (end === -1) return null
    i = skipSpace(source, end + 1)
  }
  if (source[i] !== ')') return null
  const children = parseInline(source.slice(at + 1, close), false)
  return { node: { type: 'link', href, children: children.length > 0 ? children : [{ type: 'text', text: href }] }, end: i + 1 }
}

/**
 * @param {string} source
 * @param {string} char
 * @param {number} from
 * @param {number} limit
 */
function indexBefore(source, char, from, limit) {
  const at = source.indexOf(char, from)
  return at === -1 || at >= limit ? -1 : at
}

/**
 * @param {string} source
 * @param {number} at
 */
function skipSpace(source, at) {
  let i = at
  while (i < source.length && SPACE.test(source[i])) i++
  return i
}

/**
 * @param {string} source
 * @param {number} at
 */
function urlMayStart(source, at) {
  const before = at > 0 ? source[at - 1] : ' '
  return SPACE.test(before) || URL_BEFORE.has(before)
}

/**
 * A bare address without the punctuation that ends the sentence round it,
 * and without a `)` it does not open. Null when it has no host.
 *
 * @param {string} run everything up to the next space or `<`
 * @returns {string | null}
 */
function bareUrl(run) {
  let end = run.length
  let unopened = count(run, ')') - count(run, '(')
  for (;;) {
    const last = run[end - 1]
    if (URL_TRAILING.has(last)) end--
    else if (last === ')' && unopened > 0) {
      end--
      unopened--
    } else break
  }
  const url = run.slice(0, end)
  return URL_HOST.test(url) ? url : null
}

/**
 * @param {string} text
 * @param {string} char
 */
function count(text, char) {
  let n = 0
  for (let i = text.indexOf(char); i !== -1; i = text.indexOf(char, i + 1)) n++
  return n
}
