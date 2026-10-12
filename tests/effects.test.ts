import { describe, expect, test } from 'claude-code/testing'
import { emptyBoard } from '../hooks/model/parse'
import type { Board, Goal, Item, Step } from '../hooks/model/types'
import { CONFETTI_MS } from '../hooks/view/motion'
import { BULK_LIMIT, CHEER_MS, deriveEffects, isAlive, NO_FX, prune, rippleStep, RIPPLE_MS, textSignature, type Change, type Effects } from '../hooks/view/effects'

const NOW = '2026-10-12T09:00:00+08:00'
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, title: `事项 ${id}`, stepId: '', status: 'todo', owner: '', note: '', waitingFor: '', dependsOn: [], scope: [], acceptance: '', links: [],
  noReviewTargetReason: '', reportedAt: '', session: '', doneBy: '', createdAt: NOW, updatedAt: NOW, doneAt: '', ...over,
})
const step = (id: string): Step => ({ id, title: `步骤 ${id}`, label: '', note: '', links: [] })
const goal = (id: string, items: Item[], steps: Step[] = []): Goal => ({ id, title: `目标 ${id}`, outcome: '', status: 'active', links: [], steps, items, createdAt: NOW, updatedAt: NOW })
const boardOf = (...goals: Goal[]): Board => ({ ...emptyBoard('p'), goals })
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const T0 = 100_000
const derive = (before: Board | null, after: Board | null, source: Change['source'] = 'main', prev: Effects = NO_FX, now = T0): Effects => deriveEffects(prev, { source, before, after }, now)
/** `after` is `before` with the item changed. */
function edit(before: Board, id: string, over: Partial<Item>): Board {
  const b = clone(before)
  for (const g of b.goals) g.items = g.items.map(i => (i.id === id ? { ...i, ...over } : i))
  return b
}

const base = (): Board =>
  boardOf(
    goal('g1', [item('a', { stepId: 's1', status: 'running' }), item('b', { stepId: 's1', status: 'review' }), item('c', { stepId: 's2' }), item('d', { stepId: 's2', status: 'done' })], [step('s1'), step('s2')]),
    goal('g2', [item('x')]),
  )

describe('when nothing starts', () => {
  test('without a board on either side (first load, the file turning readable, the file lost) nothing starts', () => {
    expect(derive(null, base())).toEqual(NO_FX)
    expect(derive(base(), null)).toEqual(NO_FX)
    expect(derive(null, null)).toEqual(NO_FX)
  })
  test('a commit that changes nothing visible starts nothing', () => {
    expect(derive(base(), clone(base()))).toEqual(NO_FX)
  })
})

describe('ripples', () => {
  test('the item that changed lights up, and so does the step it sits in; others do not', () => {
    const b = base()
    const fx = derive(b, edit(b, 'c', { note: '新备注' }), 'agent')
    expect(Object.keys(fx.ripples).sort()).toEqual(['c', 's2'])
    expect(fx.ripples.c).toBe(T0)
  })
  test('a new item, a removed item and an item moved to another step light up the steps involved', () => {
    const b = base()
    const added = clone(b)
    added.goals[0]!.items.push(item('n', { stepId: 's1' }))
    expect(Object.keys(derive(b, added).ripples).sort()).toEqual(['n', 's1'])
    const removed = clone(b)
    removed.goals[0]!.items = removed.goals[0]!.items.filter(i => i.id !== 'c')
    expect(Object.keys(derive(b, removed).ripples)).toEqual(['s2'])
    const moved = edit(b, 'c', { stepId: 's1' })
    expect(Object.keys(derive(b, moved).ripples).sort()).toEqual(['c', 's1', 's2'])
  })
  test('a button of the user does not ripple the row it pressed, but the step around it and everything else still do', () => {
    const b = base()
    const after = edit(edit(b, 'b', { status: 'done', doneBy: 'user' }), 'x', { note: '同时被 Claude 改了' })
    const fx = derive(b, after, 'user')
    expect(fx.ripples.b).toBeUndefined()
    expect(fx.ripples.s1).toBe(T0)
    expect(fx.ripples.x).toBe(T0)
    // the same change from Claude lights the row too
    expect(derive(b, edit(b, 'b', { status: 'done', doneBy: 'claude' }), 'agent').ripples.b).toBe(T0)
  })
  test('a user change other than approving a review item still ripples its row', () => {
    const b = base()
    expect(derive(b, edit(b, 'c', { status: 'doing' }), 'user').ripples.c).toBe(T0)
  })
  test('a new goal lights its head; its steps and items do not', () => {
    const b = base()
    const after = clone(b)
    after.goals.push(goal('g3', [item('n1', { stepId: 'sn' })], [step('sn')]))
    const fx = derive(b, after)
    expect(Object.keys(fx.ripples)).toEqual(['g3'])
  })
  test('more than twenty objects changing at once ripple nothing', () => {
    const b = base()
    const after = clone(b)
    for (let i = 0; i < BULK_LIMIT + 1; i++) after.goals[1]!.items.push(item(`bulk${i}`))
    const fx = derive(b, after, 'external')
    expect(fx.ripples).toEqual({})
    // twenty exactly still ripples
    const twenty = clone(b)
    for (let i = 0; i < BULK_LIMIT; i++) twenty.goals[1]!.items.push(item(`t${i}`))
    expect(Object.keys(derive(b, twenty).ripples).length).toBeGreaterThan(0)
  })
  test('ripples last two seconds and are cleared by the next commit that finds them over', () => {
    const b = base()
    const fx = derive(b, edit(b, 'c', { note: 'x' }))
    expect(rippleStep(T0, T0)).toBe(10)
    expect(rippleStep(T0, T0 + 1000)).toBe(5)
    expect(rippleStep(T0, T0 + RIPPLE_MS - 1)).toBe(1)
    expect(rippleStep(T0, T0 + RIPPLE_MS)).toBe(0)
    const later = derive(b, edit(b, 'x', { note: 'y' }), 'main', fx, T0 + RIPPLE_MS + 1)
    expect(Object.keys(later.ripples).sort()).toEqual(['x'])
    expect(Object.keys(derive(b, edit(b, 'x', { note: 'y' }), 'main', fx, T0 + 500).ripples).sort()).toEqual(['c', 's2', 'x'])
  })
})

describe('counts and bars', () => {
  test('a bar animates from its old fraction when done or total changes, and not otherwise', () => {
    const b = base()
    const done = derive(b, edit(b, 'c', { status: 'done' }))
    expect(done.progress.g1).toEqual({ from: 0.25, start: T0 })
    expect(done.progress.g2).toBeUndefined()
    const grown = clone(b)
    grown.goals[1]!.items.push(item('y'))
    expect(derive(b, grown).progress.g2).toEqual({ from: 0, start: T0 })
    expect(derive(b, edit(b, 'a', { note: 'z' })).progress).toEqual({})
  })
})

describe('confetti', () => {
  const stepBoard = (): Board => boardOf(goal('g1', [item('a', { stepId: 's1', status: 'done' }), item('b', { stepId: 's1', status: 'review' }), item('c', { stepId: 's2' })], [step('s1'), step('s2')]))
  test('a step that was there and unfinished and now is finished starts confetti on its goal and a cheer', () => {
    const b = stepBoard()
    const fx = derive(b, edit(b, 'b', { status: 'done' }), 'user')
    expect(fx.confetti).toEqual({ g1: T0 })
    expect(fx.cheerUntil).toBe(T0 + CHEER_MS)
  })
  test('a goal that finishes does too', () => {
    const b = boardOf(goal('g1', [item('a', { status: 'done' }), item('b', { status: 'review' })]))
    expect(derive(b, edit(b, 'b', { status: 'done' })).confetti).toEqual({ g1: T0 })
  })
  test('a step that was already finished and stays finished does not; neither does one that merely changed', () => {
    const b = stepBoard()
    expect(derive(b, edit(b, 'c', { status: 'doing' })).confetti).toEqual({})
    const done = edit(b, 'b', { status: 'done' })
    expect(derive(done, edit(done, 'a', { note: 'n' })).confetti).toEqual({})
  })
  test('steps and goals made in this commit (a merge) do not celebrate, only the new goal\'s head ripples', () => {
    const before = boardOf(goal('ga', [item('a1', { status: 'done' }), item('a2', { status: 'done' })]), goal('gb', [item('b1', { status: 'done' })]))
    const merged = boardOf(goal('gm', [item('a1', { status: 'done', stepId: 'sa' }), item('a2', { status: 'done', stepId: 'sa' }), item('b1', { status: 'done', stepId: 'sb' })], [step('sa'), step('sb')]))
    const fx = derive(before, merged, 'user')
    expect(fx.confetti).toEqual({})
    expect(fx.cheerUntil).toBe(0)
    expect(Object.keys(fx.ripples)).toEqual(['gm'])
  })
  test('a step moved into a merged goal keeps its state: no confetti either', () => {
    const before = boardOf(goal('ga', [item('a1', { stepId: 's1' })], [step('s1')]), goal('gb', [item('b1')]))
    const merged = boardOf(goal('gm', [item('a1', { stepId: 's1' }), item('b1', { stepId: 'sn' })], [step('s1'), step('sn')]))
    expect(derive(before, merged).confetti).toEqual({})
  })
  test('confetti lasts 1.5 s, the cheer 2.6 s', () => {
    const b = stepBoard()
    const fx = derive(b, edit(b, 'b', { status: 'done' }))
    expect(isAlive(fx, T0 + CONFETTI_MS - 1)).toBe(true)
    expect(Object.keys(prune(fx, T0 + CONFETTI_MS).confetti)).toEqual([])
    expect(prune(fx, T0 + CHEER_MS - 1).cheerUntil).toBe(T0 + CHEER_MS)
    expect(isAlive(fx, T0 + CHEER_MS)).toBe(false)
  })
})

describe('what a timer needs to know about text-borne effects', () => {
  test('the signature moves with ripple steps, stamp phases and the end of confetti', () => {
    const b = base()
    const fx = derive(b, edit(b, 'a', { status: 'review' }))
    const at = (dt: number, stamps = {}): string => textSignature(fx, stamps, T0 + dt)
    expect(at(0)).not.toBe(at(250))
    expect(at(0)).toBe(at(100))
    expect(at(0)).not.toBe(at(600))
    expect(at(0, { b: T0 })).not.toBe(at(200, { b: T0 }))
    expect(at(200, { b: T0 })).not.toBe(at(400, { b: T0 }))
    expect(at(400, { b: T0 })).toBe(at(450, { b: T0 }))
    expect(textSignature(NO_FX, {}, T0)).toBe('')
  })
})
