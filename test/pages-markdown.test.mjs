import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { markdownBlocks, markdownInline, plainText } from '../pages/shared/markdown.js'

const text = (/** @type {string} */ value) => ({ type: 'text', text: value })
const code = (/** @type {string} */ value) => ({ type: 'code', text: value })
const br = { type: 'break' }
const p = (/** @type {unknown[]} */ ...children) => ({ type: 'paragraph', children })
const item = (/** @type {unknown[]} */ ...children) => ({ checked: null, children })
const bullets = (/** @type {unknown[]} */ ...items) => ({ type: 'list', ordered: false, start: 1, loose: false, items })

describe('markdownBlocks', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    assert.deepEqual(markdownBlocks('One `a` two.\r\n\r\n  \nThree\n  four'), [p(text('One '), code('a'), text(' two.')), p(text('Three'), br, text('four'))])
    assert.deepEqual(markdownBlocks('  \n\n'), [])
  })

  it('starts a list straight after a paragraph line', () => {
    assert.deepEqual(markdownBlocks('Examples Cole gave:\n- A: dry run only.\n- B: every PR.\n\nThe work is in pr-review.'), [
      p(text('Examples Cole gave:')),
      bullets(item(p(text('A: dry run only.'))), item(p(text('B: every PR.')))),
      p(text('The work is in pr-review.'))
    ])
  })

  it('reads ATX headings and leaves #words alone', () => {
    assert.deepEqual(markdownBlocks("## Decisions (Cole, 2026-10-16; don't reopen them) ##\n#123 is the PR\n###### Six"), [
      { type: 'heading', level: 2, children: [text("Decisions (Cole, 2026-10-16; don't reopen them)")] },
      p(text('#123 is the PR')),
      { type: 'heading', level: 6, children: [text('Six')] }
    ])
  })

  it('nests lists by indent and numbers from the first item', () => {
    assert.deepEqual(markdownBlocks('- Reading DDC\n  - Why: the header\n  - Workaround: a tool\n- Next\n\n3. three\n4. four'), [
      bullets(item(p(text('Reading DDC')), bullets(item(p(text('Why: the header'))), item(p(text('Workaround: a tool'))))), item(p(text('Next')))),
      { type: 'list', ordered: true, start: 3, loose: false, items: [item(p(text('three'))), item(p(text('four')))] }
    ])
  })

  it('makes a list loose when a blank line separates its items', () => {
    const [list] = markdownBlocks('- one\n\n- two')
    assert.equal(list.type === 'list' && list.loose, true)
  })

  it('carries an unindented line on as part of the item above', () => {
    assert.deepEqual(markdownBlocks('- one\ncarried on\n- two'), [bullets(item(p(text('one'), br, text('carried on'))), item(p(text('two'))))])
  })

  it('reads task items', () => {
    assert.deepEqual(markdownBlocks('- [x] done\n- [ ] not yet'), [
      bullets({ checked: true, children: [p(text('done'))] }, { checked: false, children: [p(text('not yet'))] })
    ])
  })

  it('keeps fenced code as written, with its indent and blank lines', () => {
    assert.deepEqual(markdownBlocks('Config:\n\n```ts\ninterface Workspace {\n  name: string // **not bold**\n\n}\n```\n- after'), [
      p(text('Config:')),
      { type: 'code', lang: 'ts', text: 'interface Workspace {\n  name: string // **not bold**\n\n}' },
      bullets(item(p(text('after'))))
    ])
    assert.deepEqual(markdownBlocks('~~~\nnever closed'), [{ type: 'code', lang: '', text: 'never closed' }])
  })

  it('keeps a fence inside a list item', () => {
    assert.deepEqual(markdownBlocks('- run:\n  ```\n  npm test\n  ```\n- done'), [
      bullets(item(p(text('run:')), { type: 'code', lang: '', text: 'npm test' }), item(p(text('done'))))
    ])
  })

  it('reads quotes and rules', () => {
    assert.deepEqual(markdownBlocks('> quoted\nlazy\n\n---\n* * *'), [{ type: 'quote', children: [p(text('quoted'), br, text('lazy'))] }, { type: 'rule' }, { type: 'rule' }])
  })

  it('reads pipe tables with alignment and escaped pipes', () => {
    assert.deepEqual(markdownBlocks('| Level | Action |\n|:--|--:|\n| repo | `a \\| b` |\n| global'), [
      {
        type: 'table',
        align: ['left', 'right'],
        head: [[text('Level')], [text('Action')]],
        rows: [
          [[text('repo')], [code('a | b')]],
          [[text('global')], []]
        ]
      }
    ])
    assert.deepEqual(markdownBlocks('a | b\n---'), [p(text('a | b')), { type: 'rule' }])
  })
})

describe('markdownInline', () => {
  it('reads strong, emphasis and strikethrough', () => {
    assert.deepEqual(markdownInline('The feature is called **review settings**, *not* ~~policy~~.'), [
      text('The feature is called '),
      { type: 'strong', children: [text('review settings')] },
      text(', '),
      { type: 'em', children: [text('not')] },
      text(' '),
      { type: 'del', children: [text('policy')] },
      text('.')
    ])
    assert.deepEqual(markdownInline('***both***'), [{ type: 'em', children: [{ type: 'strong', children: [text('both')] }] }])
    assert.deepEqual(markdownInline('**Why:** it'), [{ type: 'strong', children: [text('Why:')] }, text(' it')])
  })

  it('keeps stars in globs and arithmetic, and underscores everywhere', () => {
    for (const plain of ['patches TOOLS-9-part1-*.patch and TOOLS-9-part2-*.patch', 'src/*.ts and test/*.ts', 'a * b * c', 'min_severity_to_post and _not emphasis_', '~5 min', '**unclosed']) {
      assert.deepEqual(markdownInline(plain), [text(plain)])
    }
  })

  it('reads code spans first, so markup inside them stays', () => {
    assert.deepEqual(markdownInline('`**x**` and ``a ` b`` and `open'), [code('**x**'), text(' and '), code('a ` b'), text(' and `open')])
  })

  it('reads links, autolinks and bare addresses', () => {
    assert.deepEqual(markdownInline('See [the PR](https://github.com/o/r/pull/1 "PR"), <https://a.dev/x> or https://b.dev/y_(z)).'), [
      text('See '),
      { type: 'link', href: 'https://github.com/o/r/pull/1', children: [text('the PR')] },
      text(', '),
      { type: 'link', href: 'https://a.dev/x', children: [text('https://a.dev/x')] },
      text(' or '),
      { type: 'link', href: 'https://b.dev/y_(z)', children: [text('https://b.dev/y_(z)')] },
      text(').')
    ])
    assert.deepEqual(markdownInline('![mockup](https://claude.ai/artifact/1) [x] done'), [
      { type: 'link', href: 'https://claude.ai/artifact/1', children: [text('mockup')] },
      text(' [x] done')
    ])
  })

  it('reads escapes and keeps line breaks', () => {
    assert.deepEqual(markdownInline('\\*not\\* \\a \\"job\\"\nnext  \n  last'), [text('*not* \\a "job"'), br, text('next'), br, text('last')])
  })

  it('keeps the backslashes in Windows paths', () => {
    const paths = 'clones in C:\\Users\\coletaylor\\.harness\\dev\\repos. and \\\\server\\share\\$x'
    assert.deepEqual(markdownInline(paths), [text(paths)])
  })

  it('says a run without its markup', () => {
    assert.equal(plainText('Renders `code`, **bold** and [a link](https://example.com)\nnow'), 'Renders code, bold and a link now')
  })

  it('leaves markup it does not know as text', () => {
    assert.deepEqual(markdownInline('<owner>/<repo> & <b>x</b>'), [text('<owner>/<repo> & <b>x</b>')])
  })
})
