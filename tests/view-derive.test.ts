import { describe, expect, test } from 'claude-code/testing'
import { emptyBoard } from '../hooks/model/parse'
import type { Board, Goal, Item, Link, Step } from '../hooks/model/types'
import { boardCounts, defaultOpenUnits, goalLinksInline, goalOpen, LINKS_INLINE, listedItems, openItems, partitionGoals, reviewItems, shownLinks, unitOpen, unitsOf } from '../hooks/view/derive'
import { EMPTY_LOCAL, hideLink, markSeen } from '../hooks/view/local'

const NOW = '2026-10-12T09:00:00+08:00'
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, title: `事项 ${id}`, stepId: '', status: 'todo', owner: '', note: '', waitingFor: '', dependsOn: [], scope: [], acceptance: '', links: [],
  noReviewTargetReason: '', reportedAt: '', session: '', doneBy: '', createdAt: NOW, updatedAt: NOW, doneAt: '', ...over,
})
const step = (id: string, over: Partial<Step> = {}): Step => ({ id, title: `步骤 ${id}`, label: '', note: '', links: [], ...over })
const goal = (id: string, items: Item[], over: Partial<Goal> = {}): Goal => ({ id, title: `目标 ${id}`, outcome: '', status: 'active', links: [], steps: [], items, createdAt: NOW, updatedAt: NOW, ...over })
const link = (target: string): Link => ({ type: 'path', kind: '设计', target, label: '', forReview: false })
const boardOf = (goals: Goal[], focusId = ''): Board => ({ ...emptyBoard('p'), goals, focus: { text: '', goalId: focusId, mandate: '', updatedAt: '' } })

describe('boardCounts', () => {
  test('waiting for you counts paused goals; running and to-do do not; done counts everything', () => {
    const b = boardOf([
      goal('a', [item('1', { status: 'review' }), item('2', { status: 'running' }), item('3', { status: 'todo' }), item('4', { status: 'queued' }), item('5', { status: 'doing' }), item('6', { status: 'done' }), item('7', { status: 'dropped' })]),
      goal('p', [item('8', { status: 'review' }), item('9', { status: 'running' }), item('10', { status: 'todo' }), item('11', { status: 'done' })], { status: 'paused' }),
    ])
    expect(boardCounts(b, EMPTY_LOCAL)).toEqual({ review: 2, running: 1, todo: 3, done: 2 })
  })
  test('waiting for you leaves out what this user has looked at or hidden every entry of', () => {
    const rev = item('1', { status: 'review', reportedAt: NOW })
    const hid = item('2', { status: 'review', links: [{ ...link('x.md'), forReview: true }] })
    const b = boardOf([goal('a', [rev, hid, item('3', { status: 'review' })])])
    const lv = hideLink(markSeen(EMPTY_LOCAL, rev), '2', 'x.md')
    expect(boardCounts(b, lv)).toEqual({ review: 1, running: 0, todo: 0, done: 0 })
    expect(reviewItems(b, lv).map(r => r.item.id)).toEqual(['3'])
  })
})

describe('partitionGoals', () => {
  test('the focus first, then review or running, then under way, then not started; ties keep the file order', () => {
    const b = boardOf(
      [
        goal('idle', [item('1')]),
        goal('under', [item('2', { status: 'done' }), item('3')]),
        goal('run', [item('4', { status: 'running' })]),
        goal('idle2', [item('5')]),
        goal('rev', [item('6', { status: 'review' })]),
        goal('foc', [item('7')]),
      ],
      'foc',
    )
    expect(partitionGoals(b).active.map(g => g.id)).toEqual(['foc', 'run', 'rev', 'under', 'idle', 'idle2'])
  })
  test('paused goals and finished goals leave the list for their folds', () => {
    const b = boardOf([goal('a', [item('1')]), goal('p', [item('2')], { status: 'paused' }), goal('f', [item('3', { status: 'done' })]), goal('e', [])])
    const p = partitionGoals(b)
    expect(p.active.map(g => g.id)).toEqual(['a', 'e'])
    expect(p.paused.map(g => g.id)).toEqual(['p'])
    expect(p.finished.map(g => g.id)).toEqual(['f'])
  })
  test('a finished goal that is held stays in the list, ranked with the goals under way; unheld it goes to the fold', () => {
    const b = boardOf([goal('a', [item('1')]), goal('f', [item('3', { status: 'done' })]), goal('e', [])])
    expect(partitionGoals(b, new Set(['f'])).active.map(g => g.id)).toEqual(['f', 'a', 'e'])
    expect(partitionGoals(b, new Set(['f'])).finished).toEqual([])
    expect(partitionGoals(b, new Set(['a'])).active.map(g => g.id)).toEqual(['a', 'e'])
    expect(partitionGoals(b).finished.map(g => g.id)).toEqual(['f'])
  })
})

describe('which goals and steps open by themselves', () => {
  const g = goal(
    'g',
    [item('a1', { stepId: 's1', status: 'done' }), item('a2', { stepId: 's1' }), item('b1', { stepId: 's2', status: 'doing' }), item('c1', { stepId: 's3', status: 'queued' }), item('x', { stepId: '' })],
    { steps: [step('s1'), step('s2'), step('s3')] },
  )
  test('steps with review, running or doing items open; failing that, the first with anything unfinished', () => {
    expect([...defaultOpenUnits(g)]).toEqual(['s2'])
    const quiet = goal('q', [item('a1', { stepId: 's1', status: 'done' }), item('b1', { stepId: 's2' }), item('c1', { stepId: 's3' })], { steps: [step('s1'), step('s2'), step('s3')] })
    expect([...defaultOpenUnits(quiet)]).toEqual(['s2'])
    expect([...defaultOpenUnits(goal('d', [item('a', { status: 'done', stepId: 's1' })], { steps: [step('s1')] }))]).toEqual([])
  })
  test('loose open items add 其他 at the end; loose done items alone do not', () => {
    expect(unitsOf(g).map(u => u.id)).toEqual(['s1', 's2', 's3', 'other:g'])
    expect(unitsOf(goal('h', [item('a', { status: 'done' })], { steps: [step('s1')] })).map(u => u.id)).toEqual(['s1'])
  })
  test('what the user chose beats the default, both ways', () => {
    const u = unitsOf(g)
    expect(unitOpen(g, u[0]!, {})).toBe(false)
    expect(unitOpen(g, u[0]!, { s1: true })).toBe(true)
    expect(unitOpen(g, u[1]!, { s2: false })).toBe(false)
  })
  test('goals: the focus is open; in the narrow view only the focus; otherwise review or running; paused never by itself', () => {
    const run = goal('r', [item('1', { status: 'running' })])
    const idle = goal('i', [item('2')])
    const paused = goal('p', [item('3', { status: 'review' })], { status: 'paused' })
    const b = boardOf([run, idle, paused], 'i')
    expect(goalOpen(b, run, {}, 'pane')).toBe(true)
    expect(goalOpen(b, run, {}, 'band-full')).toBe(false)
    expect(goalOpen(b, idle, {}, 'band-full')).toBe(true)
    expect(goalOpen(b, paused, {}, 'pane')).toBe(false)
    expect(goalOpen(b, run, { r: false }, 'pane')).toBe(false)
  })
})

describe('what is on screen', () => {
  const g = goal(
    'g',
    [item('a1', { stepId: 's1', status: 'review', links: [link('a.md')] }), item('b1', { stepId: 's2', status: 'todo', links: [link('b.md')] }), item('d', { stepId: 's1', status: 'done' })],
    { steps: [step('s1', { links: [link('s1.md')] }), step('s2', { links: [link('s2.md')] })], links: [link('g.md')] },
  )
  const b = boardOf([g], 'g')
  test('rows are the live items of open steps in an open goal', () => {
    expect(listedItems(b, {}, 'pane').map(i => i.id)).toEqual(['a1'])
    expect(listedItems(b, { s2: true }, 'pane').map(i => i.id)).toEqual(['a1', 'b1'])
    expect(listedItems(b, { g: false }, 'pane')).toEqual([])
  })
  const t = (links: readonly Link[]): string[] => links.map(l => l.target).sort()
  test('details open only when asked, review items too; links to check are those on screen', () => {
    expect(openItems(b, {}, 'pane').map(i => i.id)).toEqual([])
    expect(openItems(b, { a1: true }, 'pane').map(i => i.id)).toEqual(['a1'])
    expect(t(shownLinks(b, {}, 'pane', EMPTY_LOCAL))).toEqual(['g.md', 's1.md'])
    expect(t(shownLinks(b, { s2: true }, 'pane', EMPTY_LOCAL))).toContain('s2.md')
    expect(t(shownLinks(b, { g: false }, 'pane', EMPTY_LOCAL))).toEqual([])
  })
  test('hidden links are not checked; the focus goal lists up to three links, any other goal folds them', () => {
    expect(t(shownLinks(b, { a1: true }, 'pane', hideLink(hideLink(EMPTY_LOCAL, 'g', 'g.md'), 'a1', 'a.md')))).toEqual(['s1.md'])
    expect(t(shownLinks(b, { a1: true }, 'pane', hideLink(EMPTY_LOCAL, 'a1', 'g.md')))).toEqual(['a.md', 'g.md', 's1.md'])
    expect(goalLinksInline(b, g)).toBe(LINKS_INLINE)
    const other = boardOf([g])
    expect(goalLinksInline(other, g)).toBe(0)
    expect(t(shownLinks(other, { g: true }, 'pane', EMPTY_LOCAL))).toEqual(['s1.md'])
    expect(t(shownLinks(other, { g: true, 'links:g': true }, 'pane', EMPTY_LOCAL))).toEqual(['g.md', 's1.md'])
  })
  test('review rows carry the step', () => {
    expect(reviewItems(b, EMPTY_LOCAL).map(r => [r.item.id, r.step?.id])).toEqual([['a1', 's1']])
  })
})
