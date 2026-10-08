import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { age, boardColumns, carryOption, defaultProject, epicGroups, exactIdFirst, linkText, listOrder, moved, openCount, paragraphs, priorityMark, replacementStatus, statusOrder, suggestKey, timeLabel, trend } from '../pages/shared/logic.js'

describe('timeLabel', () => {
  const now = new Date(2026, 9, 7, 16, 30)

  it('is the clock alone today', () => {
    assert.equal(timeLabel(new Date(2026, 9, 7, 9, 5).toISOString(), now), '09:05')
  })

  it('adds the day this year, and the year before that', () => {
    assert.equal(timeLabel(new Date(2026, 9, 6, 14, 12).toISOString(), now), 'Oct 6 14:12')
    assert.equal(timeLabel(new Date(2025, 0, 2, 8, 0).toISOString(), now), 'Jan 2 2025 08:00')
  })

  it('is empty for nothing or nonsense', () => {
    assert.equal(timeLabel(null, now), '')
    assert.equal(timeLabel('not a time', now), '')
  })
})

describe('exactIdFirst', () => {
  const items = [{ id: 'TC-3' }, { id: 'TC-12' }, { id: 'TC-120' }]

  it('moves the item the text names to the top', () => {
    assert.deepEqual(exactIdFirst(items, ' tc-120 ').map((item) => item.id), ['TC-120', 'TC-3', 'TC-12'])
  })

  it('reads a leading zero as the same number', () => {
    assert.deepEqual(exactIdFirst(items, 'TC-012').map((item) => item.id), ['TC-12', 'TC-3', 'TC-120'])
  })

  it('keeps the order for text that is not an ID, or names nothing listed', () => {
    assert.equal(exactIdFirst(items, 'break'), items)
    assert.equal(exactIdFirst(items, 'TC-9'), items)
  })
})

describe('openCount', () => {
  it('sums the open tasks of every project', () => {
    const counts = (/** @type {number} */ open) => ({ counts: { open } })
    assert.equal(openCount({ projects: [counts(3), counts(0), counts(4)] }), 7)
    assert.equal(openCount({ projects: [] }), 0)
  })
})

describe('defaultProject', () => {
  const projects = [
    { uid: 1, portfolio: { uid: 10 } },
    { uid: 2, portfolio: { uid: 10 } },
    { uid: 3, portfolio: { uid: 20 } }
  ]

  it('takes the project on screen first', () => {
    assert.equal(defaultProject(projects, [{ kind: 'project', uid: 3 }], 2), 3)
  })

  it('takes the project of an item on screen', () => {
    assert.equal(defaultProject(projects, [{ kind: 'item', uid: 99, project: 2, portfolio: 10 }], null), 2)
  })

  it('takes the first project of a portfolio on screen', () => {
    assert.equal(defaultProject(projects, [{ kind: 'portfolio', uid: 20 }], 1), 3)
  })

  it('follows the most recent view', () => {
    const viewing = [
      { kind: /** @type {const} */ ('item'), uid: 5, project: 2 },
      { kind: /** @type {const} */ ('project'), uid: 3 }
    ]
    assert.equal(defaultProject(projects, viewing, null), 2)
  })

  it('falls back to the last used, then the first', () => {
    assert.equal(defaultProject(projects, [], 2), 2)
    assert.equal(defaultProject(projects, [{ kind: 'project', uid: 42 }], 42), 1)
    assert.equal(defaultProject([], [], 1), null)
  })
})

describe('carryOption', () => {
  const options = [
    { uid: 1, name: 'Backlog', isDefault: true },
    { uid: 2, name: 'In progress', isDefault: false }
  ]

  it('keeps an option of the same name, whatever its case', () => {
    assert.equal(carryOption(options, 'in Progress'), 2)
  })

  it('falls back to the default, then the first', () => {
    assert.equal(carryOption(options, 'Awaiting launch'), 1)
    assert.equal(carryOption(options, null), 1)
    assert.equal(carryOption([{ uid: 7, name: 'Open', isDefault: false }], null), 7)
    assert.equal(carryOption([], null), null)
  })
})

describe('age', () => {
  const now = new Date('2026-10-14T12:00:00Z')
  const ago = (/** @type {number} */ ms) => new Date(now.getTime() - ms).toISOString()
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('reads as a list column does', () => {
    assert.deepEqual(
      [ago(20_000), ago(5 * MIN), ago(2 * HOUR), ago(3 * DAY), ago(15 * DAY), ago(70 * DAY), ago(800 * DAY)].map((iso) => age(iso, now)),
      ['now', '5m', '2h', '3d', '2w', '2mo', '2y']
    )
    assert.equal(age('nonsense', now), '')
  })
})

describe('priorityMark', () => {
  it('draws the default four as urgent, three bars, two, one', () => {
    assert.deepEqual([1, 2, 3, 4].map((rank) => priorityMark(rank, 4)), [
      { urgent: true, bars: 0 },
      { urgent: false, bars: 3 },
      { urgent: false, bars: 2 },
      { urgent: false, bars: 1 }
    ])
  })

  it('spreads other counts over one to three bars, and draws nothing for one priority', () => {
    assert.deepEqual([2, 3].map((rank) => priorityMark(rank, 3).bars), [3, 2])
    assert.deepEqual([2, 3, 4, 5, 6].map((rank) => priorityMark(rank, 6).bars), [3, 2, 2, 1, 1])
    assert.deepEqual(priorityMark(1, 1), { urgent: false, bars: 0 })
  })
})

describe('listOrder', () => {
  const s = (/** @type {string} */ name, /** @type {any} */ group) => ({ name, group })
  it('puts work under way first, then the not-started status nearest to started, then finished', () => {
    const statuses = [s('Backlog', 'not-started'), s('Planning', 'not-started'), s('To do', 'not-started'), s('In progress', 'active'), s('In review', 'active'), s('Blocked', 'active'), s('Done', 'done'), s('Awaiting launch', 'done'), s('Cancelled', 'closed')]
    assert.deepEqual(listOrder(statuses).map((status) => status.name), ['In progress', 'In review', 'Blocked', 'To do', 'Planning', 'Backlog', 'Done', 'Awaiting launch', 'Cancelled'])
  })
})

describe('boardColumns', () => {
  const statuses = [
    { uid: 1, name: 'Backlog', group: 'not-started', isDefault: true },
    { uid: 2, name: 'Planning', group: 'not-started', isDefault: false },
    { uid: 3, name: 'To do', group: 'not-started', isDefault: false },
    { uid: 4, name: 'In progress', group: 'active', isDefault: false },
    { uid: 5, name: 'In review', group: 'active', isDefault: false },
    { uid: 6, name: 'Done', group: 'done', isDefault: false },
    { uid: 7, name: 'Cancelled', group: 'closed', isDefault: false }
  ]
  it('always has somewhere to park, start, work and finish', () => {
    assert.deepEqual(boardColumns(statuses, new Set()).map((status) => status.name), ['Backlog', 'To do', 'In progress', 'Done'])
  })
  it('adds every status something is in, in workflow order', () => {
    assert.deepEqual(boardColumns(statuses, new Set([5, 7])).map((status) => status.name), ['Backlog', 'To do', 'In progress', 'In review', 'Done', 'Cancelled'])
  })
})

describe('trend', () => {
  it('says how the open count moved over the series', () => {
    assert.equal(trend([38, 37, 32]), 'down 6 in 3 days')
    assert.equal(trend([2, 5]), 'up 3 in 2 days')
    assert.equal(trend([4, 4]), 'no change in 2 days')
    assert.equal(trend([4]), '')
  })
})

describe('paragraphs', () => {
  it('splits on blank lines and marks code spans', () => {
    assert.deepEqual(paragraphs('One `a` two.\r\n\r\n  \nThree\nfour'), [
      [
        { code: false, text: 'One ' },
        { code: true, text: 'a' },
        { code: false, text: ' two.' }
      ],
      [{ code: false, text: 'Three\nfour' }]
    ])
    assert.deepEqual(paragraphs('  \n\n'), [])
    assert.deepEqual(paragraphs('a ` b'), [[{ code: false, text: 'a ` b' }]])
  })
})

describe('epicGroups', () => {
  const projects = [{ uid: 1 }, { uid: 2 }, { uid: 3 }]
  const task = (/** @type {number} */ project, /** @type {string} */ group) => ({ project: { uid: project }, status: { group } })
  it('puts home first, skips empty projects, and does not count cancelled tasks', () => {
    const groups = epicGroups([task(1, 'done'), task(3, 'active'), task(3, 'closed'), task(3, 'not-started')], projects, 3)
    assert.deepEqual(
      groups.map((group) => [group.project.uid, group.home, group.tasks.length, group.done, group.active, group.total]),
      [
        [3, true, 3, 0, 1, 2],
        [1, false, 1, 1, 0, 1]
      ]
    )
  })
})

describe('linkText', () => {
  it('shows a label over the kind and value, else the value over the kind', () => {
    assert.deepEqual(linkText({ kind: 'pr', value: '#412', label: 'Soft-delete views' }), { text: 'Soft-delete views', meta: 'Pull request · #412', mono: false })
    assert.deepEqual(linkText({ kind: 'branch', value: 'feat/x', label: '' }), { text: 'feat/x', meta: 'Branch', mono: true })
    assert.deepEqual(linkText({ kind: 'url', value: 'https://x', label: '' }), { text: 'https://x', meta: 'Link', mono: false })
  })
})

describe('suggestKey', () => {
  it('takes the capitals of a joined name, the initials of words, or the start of one word', () => {
    assert.equal(suggestKey('TideCast'), 'TC')
    assert.equal(suggestKey('Plugin SDK'), 'PS')
    assert.equal(suggestKey('Helm'), 'HELM')
    assert.equal(suggestKey('warband'), 'WARB')
    assert.equal(suggestKey('Ma'), 'MA')
  })

  it('starts with a letter and keeps to four', () => {
    assert.equal(suggestKey('2026 House build'), 'HB')
    assert.equal(suggestKey('One Two Three Four Five'), 'OTTF')
    assert.equal(suggestKey('  '), '')
    assert.equal(suggestKey('42'), '')
  })
})

describe('statusOrder', () => {
  const statuses = [
    { uid: 1, group: 'not-started' },
    { uid: 2, group: 'not-started' },
    { uid: 3, group: 'active' },
    { uid: 9, group: 'not-started' },
    { uid: 4, group: 'done' }
  ]

  it('moves one inside its group and lays the groups end to end', () => {
    assert.deepEqual(statusOrder(statuses, 'not-started', 2, 0), [9, 1, 2, 3, 4])
    assert.deepEqual(statusOrder(statuses, 'active', 0, 0), [1, 2, 9, 3, 4])
  })

  it('ignores a move outside the group', () => {
    assert.deepEqual(statusOrder(statuses, 'not-started', 0, 7), [1, 2, 9, 3, 4])
  })
})

describe('moved', () => {
  it('moves down and up without touching the original', () => {
    const list = ['a', 'b', 'c', 'd']
    assert.deepEqual(moved(list, 0, 2), ['b', 'c', 'a', 'd'])
    assert.deepEqual(moved(list, 3, 1), ['a', 'd', 'b', 'c'])
    assert.deepEqual(list, ['a', 'b', 'c', 'd'])
  })
})

describe('replacementStatus', () => {
  const statuses = [
    { uid: 1, group: 'not-started', isDefault: true },
    { uid: 2, group: 'not-started', isDefault: false },
    { uid: 3, group: 'active', isDefault: false },
    { uid: 4, group: 'done', isDefault: false },
    { uid: 5, group: 'done', isDefault: false }
  ]

  it('is the next in the group, then the one before', () => {
    assert.equal(replacementStatus(statuses, 4)?.uid, 5)
    assert.equal(replacementStatus(statuses, 5)?.uid, 4)
  })

  it('falls back to the default when the group has no other', () => {
    assert.equal(replacementStatus(statuses, 3)?.uid, 1)
  })
})
