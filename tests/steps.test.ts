import { describe, expect, test } from 'claude-code/testing'
import { goalShortName, goalState, progressOf, stepShortName, stepState } from '../hooks/model/derive'
import { describeChanges } from '../hooks/model/diff'
import { collectIds } from '../hooks/model/ids'
import { checkInvariants } from '../hooks/model/invariants'
import { applyOps, type Op, type OpCtx } from '../hooks/model/ops'
import { emptyBoard, parseBoard, serializeBoard } from '../hooks/model/parse'
import { approve, executeDirect, propose } from '../hooks/model/propose'
import { query } from '../hooks/model/query'
import { buildSnapshot, RULES_TEXT, SNAPSHOT_LIMIT } from '../hooks/model/summary'
import type { Board, Goal, Item } from '../hooks/model/types'
import { toolSpecs } from '../hooks/tools'

const NOW = '2026-10-12T09:00:00+08:00'
let seed = 7
const rand = () => {
  seed = (seed * 48271) % 2147483647
  return seed / 2147483647
}
const ctx = (over: Partial<OpCtx> = {}): OpCtx => ({ now: NOW, session: 's1', actor: 'main', rand, ...over })

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error('expected ok, got ' + JSON.stringify(r))
  return r as Extract<T, { ok: true }>
}
const apply = (b: Board, ops: Op[]): Board => must(applyOps(b, ops, ctx())).board
const failure = (b: Board, ops: Op[]): string => {
  const r = applyOps(b, ops, ctx())
  if (r.ok) throw new Error('expected a failure')
  return r.reason
}
/** Close a goal the way the user does: propose, then press 同意. */
function closeGoal(b: Board, goalId: string): Board {
  const p = must(propose(b, 'goal.close', { goalId, reason: '完成' }, '', ctx())).board
  return must(approve(p, p.proposals.at(-1)!.id, ctx(), 'sidebar')).board
}
const goalOf = (b: Board, id: string): Goal => b.goals.find(g => g.id === id) as Goal
const itemOf = (b: Board, id: string): Item => b.goals.flatMap(g => g.items).find(i => i.id === id) as Item

const item = (id: string, title: string, over: Partial<Item> = {}): Item => ({
  id, title, stepId: '', status: 'todo', owner: '', note: '', waitingFor: '', dependsOn: [], scope: [], acceptance: '', links: [],
  noReviewTargetReason: '', reportedAt: '', session: '', doneBy: '', createdAt: NOW, updatedAt: NOW, doneAt: '', ...over,
})
const mkGoal = (id: string, title: string, items: Item[] = [], over: Partial<Goal> = {}): Goal => ({
  id, title, outcome: '', status: 'active', links: [], steps: [], items, createdAt: NOW, updatedAt: NOW, ...over,
})
const doc = (target: string, label = '') => ({ type: 'path' as const, kind: '设计', target, label, forReview: false })

/** Two plain goals and a paused one, each with items; decisions, focus and a pending proposal point at them. */
function staged(): Board {
  const b = emptyBoard('canvas')
  b.goals.push(
    mkGoal('g-t', 'T 测试版', [item('i-t1', '测试一', { status: 'done' })], { outcome: 'T 的成果', links: [doc('ROADMAP.md', '路线')], confirmedBy: 'conversation', quote: '先做 T' }),
    mkGoal('g-a', 'A 运行时', [item('i-a1', 'A1', { status: 'running' }), item('i-a2', 'A2')], { outcome: 'A 的成果', links: [doc('设计方案.md', 'A 方案')] }),
    mkGoal('g-b', 'B 填 Key', [item('i-b1', 'B1')], { status: 'paused', links: [doc('设计方案.md', 'B 也看这份')] }),
  )
  b.decisions.push({ id: 'd-1', date: '2026-10-12', text: 'A 用 bun', kind: 'user', goalId: 'g-a', status: 'active' }, { id: 'd-0', date: '2026-10-12', text: '全局', kind: 'user', goalId: '', status: 'active' })
  b.focus = { text: 'G 落地', goalId: 'g-a', mandate: '', updatedAt: NOW }
  return b
}

/** A board with one stepped goal g-s: steps s-x (done), s-y (review + running), s-z (idle), plus loose items. */
function stepped(): Board {
  let b = emptyBoard('demo')
  b.goals.push(mkGoal('g-s', 'G 大目标', [], { outcome: '做完 G' }))
  b = apply(b, [
    { op: 'step.add', goalId: 'g-s', title: 'A 先做这个', label: '' },
    { op: 'step.add', goalId: 'g-s', title: 'B 填 Key 就能用' },
    { op: 'step.add', goalId: 'g-s', title: 'C 收尾' },
  ])
  const [sa, sb, sc] = goalOf(b, 'g-s').steps.map(s => s.id) as [string, string, string]
  b = apply(b, [
    { op: 'item.add', goalId: 'g-s', stepId: sa, title: 'A1', status: 'done' },
    { op: 'item.add', goalId: 'g-s', stepId: sb, title: 'B5 收进详情', status: 'review', noReviewTargetReason: '无' },
    { op: 'item.add', goalId: 'g-s', stepId: sb, title: 'B8 出错提示', status: 'running', owner: 'b8b', note: '正在写状态处理' },
    { op: 'item.add', goalId: 'g-s', stepId: sc, title: 'C1' },
    { op: 'item.add', goalId: 'g-s', title: '零散的事' },
  ])
  return b
}

describe('schema 1 and 2 on disk', () => {
  test('a board without steps is written as schema 1 with no step fields, and reads back unchanged', () => {
    const b = staged()
    const text = serializeBoard(b)
    expect(text.split('\n')[1]).toBe('  "schema": 1,')
    expect(text).not.toContain('"steps"')
    expect(text).not.toContain('"stepId"')
    const back = parseBoard(text)
    expect(back.ok && serializeBoard(back.board)).toBe(text)
  })

  test('schema 1 text is read with steps [] and stepId empty', () => {
    const o = JSON.parse(serializeBoard(staged())) as { goals: Array<Record<string, unknown>> }
    const r = parseBoard(JSON.stringify({ ...o, schema: 1 }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.board.goals[0]?.steps).toEqual([])
      expect(r.board.goals[0]?.items[0]?.stepId).toBe('')
    }
  })

  test('a board with a step is written as schema 2 with steps and stepId on every goal and item', () => {
    const text = serializeBoard(stepped())
    expect(text.split('\n')[1]).toBe('  "schema": 2,')
    const o = JSON.parse(text) as { goals: Array<{ steps: unknown[]; items: Array<Record<string, unknown>> }> }
    expect(o.goals[0]?.steps.length).toBe(3)
    expect(o.goals[0]?.items.every(i => typeof i.stepId === 'string')).toBe(true)
    expect(Object.keys(o.goals[0]?.steps[0] as object)).toEqual(['id', 'title', 'label', 'note', 'links'])
    const back = parseBoard(text)
    expect(back.ok && serializeBoard(back.board)).toBe(text)
  })

  test('steps only in the archive still make schema 2', () => {
    const b = staged()
    b.archive.goals.push(mkGoal('g-old', '旧', [], { closedAt: NOW, closeReason: '完成', steps: [{ id: 's-old', title: '旧步骤', label: '', note: '', links: [] }] }))
    expect(serializeBoard(b).split('\n')[1]).toBe('  "schema": 2,')
  })

  test('a pending goal.merge alone makes schema 2; once it is gone and no step is left, schema 1 again', () => {
    const b = must(propose(staged(), 'goal.merge', { title: 'G', goalIds: ['g-t', 'g-a'] }, '', ctx())).board
    expect(serializeBoard(b).split('\n')[1]).toBe('  "schema": 2,')
    const rejected = { ...b, proposals: [] }
    expect(serializeBoard(rejected).split('\n')[1]).toBe('  "schema": 1,')
  })

  test('removing the last step takes the board back to schema 1', () => {
    let b = stepped()
    for (const s of goalOf(b, 'g-s').steps) b = apply(b, [{ op: 'step.remove', id: s.id }])
    expect(serializeBoard(b).split('\n')[1]).toBe('  "schema": 1,')
    expect(serializeBoard(b)).not.toContain('stepId')
  })

  test('a file newer than schema 2 is refused with the update-the-plugin advice', () => {
    const r = parseBoard(JSON.stringify({ schema: 3 }))
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toContain('不要覆盖它或从 git 恢复')
    expect((r as { error: string }).error).not.toContain('未知版本')
  })
})

describe('step ops', () => {
  test('step.add appends, or inserts before a step of the same goal; ids carry the s- prefix', () => {
    let b = stepped()
    const [sa, , sc] = goalOf(b, 'g-s').steps.map(s => s.id) as [string, string, string]
    const r = must(applyOps(b, [{ op: 'step.add', goalId: 'g-s', title: 'D 后面', note: 'n', links: [doc('x.md')] }, { op: 'step.add', goalId: 'g-s', title: '插在 C 前', before: sc }], ctx()))
    b = r.board
    const titles = goalOf(b, 'g-s').steps.map(s => s.title)
    expect(titles).toEqual(['A 先做这个', 'B 填 Key 就能用', '插在 C 前', 'C 收尾', 'D 后面'])
    expect(goalOf(b, 'g-s').steps[4]).toMatchObject({ note: 'n', label: '' })
    expect(goalOf(b, 'g-s').steps[4]?.links.length).toBe(1)
    expect(r.events[0]).toMatchObject({ kind: 'step.add' })
    expect(r.events[0]?.id).toMatch(/^s-[0-9a-z]{6}$/)
    expect(sa).toMatch(/^s-/)
    expect(failure(b, [{ op: 'step.add', goalId: 'g-s', title: 'x', before: 'g-s' }])).toContain('不是目标 g-s 的步骤')
  })

  test('step.update changes only what is passed; step.link.add/remove work like item links', () => {
    let b = stepped()
    const sb = goalOf(b, 'g-s').steps[1]!.id
    b = apply(b, [{ op: 'step.update', id: sb, label: '填Key' }, { op: 'step.link.add', id: sb, link: doc('界面设计.md', '界面') }])
    expect(goalOf(b, 'g-s').steps[1]).toMatchObject({ title: 'B 填 Key 就能用', label: '填Key' })
    expect(goalOf(b, 'g-s').steps[1]?.links.map(l => l.target)).toEqual(['界面设计.md'])
    b = apply(b, [{ op: 'step.link.remove', id: sb, target: '界面设计.md' }])
    expect(goalOf(b, 'g-s').steps[1]?.links).toEqual([])
    expect(failure(b, [{ op: 'step.link.remove', id: sb, target: 'nope' }])).toContain('没有 target')
    expect(failure(b, [{ op: 'step.update', id: 's-nope', title: 'x' }])).toContain('不存在')
    expect(failure(b, [{ op: 'step.update', id: sb, colour: 'red' }])).toContain('不支持字段 colour')
  })

  test('step.remove frees its items instead of deleting them and says how many', () => {
    const b0 = stepped()
    const sb = goalOf(b0, 'g-s').steps[1]!.id
    const r = must(applyOps(b0, [{ op: 'step.remove', id: sb }], ctx()))
    expect(r.board.goals[0]?.steps.map(s => s.id)).not.toContain(sb)
    expect(r.board.goals[0]?.items.length).toBe(b0.goals[0]?.items.length)
    expect(r.board.goals[0]?.items.filter(i => i.stepId === sb)).toEqual([])
    expect(itemOf(r.board, itemOf(b0, r.board.goals[0]!.items[1]!.id).id).stepId).toBe('')
    expect(r.events[0]?.summary).toContain('其中 2 个事项改为未分步骤')
  })

  test('steps of a closed goal cannot be touched', () => {
    let b = stepped()
    const sa = goalOf(b, 'g-s').steps[0]!.id
    b = closeGoal(b, 'g-s')
    expect(b.archive.goals[0]?.steps.length).toBe(3)
    expect(failure(b, [{ op: 'step.update', id: sa, title: 'x' }])).toContain('已关闭')
    expect(failure(b, [{ op: 'step.add', goalId: 'g-s', title: 'x' }])).toContain('已关闭')
  })
})

describe('stepId on items', () => {
  test('item.add / item.update take a step of the same goal; "" moves the item out', () => {
    let b = stepped()
    const sc = goalOf(b, 'g-s').steps[2]!.id
    b = apply(b, [{ op: 'item.add', goalId: 'g-s', title: 'C2', stepId: sc }])
    expect(itemOf(b, goalOf(b, 'g-s').items.at(-1)!.id).stepId).toBe(sc)
    const loose = goalOf(b, 'g-s').items.find(i => i.title === '零散的事')!
    b = apply(b, [{ op: 'item.update', id: loose.id, stepId: sc }])
    expect(itemOf(b, loose.id).stepId).toBe(sc)
    b = apply(b, [{ op: 'item.update', id: loose.id, stepId: '' }])
    expect(itemOf(b, loose.id).stepId).toBe('')
  })

  test('a step of another goal is refused and the error lists the goal\'s own steps as "id 短名 标题"', () => {
    let b = stepped()
    b.goals.push(mkGoal('g-other', '别的', [item('i-o', 'O')]))
    b = apply(b, [{ op: 'step.add', goalId: 'g-other', title: 'Z 别处的步骤' }])
    const foreign = goalOf(b, 'g-other').steps[0]!.id
    const why = failure(b, [{ op: 'item.update', id: goalOf(b, 'g-s').items[0]!.id, stepId: foreign }])
    expect(why).toContain(`stepId ${foreign} 不是目标 g-s`)
    const own = goalOf(b, 'g-s').steps
    expect(why).toContain(`${own[1]!.id} B B 填 Key 就能用`)
    expect(why).toContain(`${own[0]!.id} A A 先做这个`)
    expect(failure(b, [{ op: 'item.add', goalId: 'g-s', title: 'x', stepId: foreign }])).toContain('不是目标 g-s')
    expect(failure(b, [{ op: 'item.add', goalId: 'g-s', title: 'x', stepId: 'C' }])).toContain('不是目标 g-s')
    // a goal without steps says how to get one
    b.goals.push(mkGoal('g-plain', 'Plain'))
    expect(failure(b, [{ op: 'item.add', goalId: 'g-plain', title: 'x', stepId: 's-1' }])).toContain('先用 step.add')
  })

  test('item.move: another goal resets stepId unless a step of the destination is given; same goal with stepId acts as update', () => {
    let b = stepped()
    b.goals.push(mkGoal('g-other', '别的'))
    b = apply(b, [{ op: 'step.add', goalId: 'g-other', title: 'Z 目的步骤' }])
    const zs = goalOf(b, 'g-other').steps[0]!.id
    const inB = goalOf(b, 'g-s').items.find(i => i.title === 'B8 出错提示')!
    const inC = goalOf(b, 'g-s').items.find(i => i.title === 'C1')!
    let m = apply(b, [{ op: 'item.move', id: inB.id, goalId: 'g-other' }])
    expect(itemOf(m, inB.id).stepId).toBe('')
    m = apply(b, [{ op: 'item.move', id: inB.id, goalId: 'g-other', stepId: zs }])
    expect(itemOf(m, inB.id).stepId).toBe(zs)
    expect(failure(b, [{ op: 'item.move', id: inB.id, goalId: 'g-other', stepId: inB.stepId }])).toContain('不是目标 g-other')
    const sb = goalOf(b, 'g-s').steps[1]!.id
    m = apply(b, [{ op: 'item.move', id: inC.id, goalId: 'g-s', stepId: sb }])
    expect(itemOf(m, inC.id).stepId).toBe(sb)
    m = apply(b, [{ op: 'item.move', id: inB.id, goalId: 'g-s' }])
    expect(itemOf(m, inB.id).stepId).toBe(inB.stepId)
  })
})

describe('invariants', () => {
  test('step ids share the global id check, archive included', () => {
    const b = stepped()
    b.goals[0]!.steps[0]!.id = b.goals[0]!.items[0]!.id
    expect(checkInvariants(b)).toContain('id 重复')
    const c = stepped()
    c.archive.goals.push(mkGoal('g-old', '旧', [], { closedAt: NOW, closeReason: '完成', steps: [{ ...c.goals[0]!.steps[0]! }] }))
    expect(checkInvariants(c)).toContain('id 重复')
  })

  test('an item\'s stepId must be a step of its own goal', () => {
    const b = stepped()
    b.goals.push(mkGoal('g-x', 'X', [item('i-x', 'x', { stepId: b.goals[0]!.steps[0]!.id })]))
    expect(checkInvariants(b)).toContain('stepId')
    expect(checkInvariants(stepped())).toBeNull()
  })

  test('collectIds includes step ids', () => {
    const b = stepped()
    expect(collectIds(b).has(b.goals[0]!.steps[0]!.id)).toBe(true)
  })
})

describe('goal.merge', () => {
  test('goals without steps become one step each; items, links and notes follow', () => {
    const b = staged()
    const r = must(executeDirect(b, 'goal.merge', { title: 'G-export AI 落地', goalIds: ['g-t', 'g-a', 'g-b'], outcome: '整体做完' }, '合并吧', ctx()))
    const m = r.board
    expect(m.goals.map(g => g.title)).toEqual(['G-export AI 落地'])
    const g = m.goals[0]!
    expect(g).toMatchObject({ status: 'active', outcome: '整体做完', confirmedBy: 'conversation', quote: '合并吧' })
    expect(g.steps.map(s => s.title)).toEqual(['T 测试版', 'A 运行时', 'B 填 Key'])
    expect(g.steps[0]).toMatchObject({ note: 'T 的成果\n用户原话：先做 T' })
    expect(g.steps[0]?.links.map(l => l.target)).toEqual(['ROADMAP.md'])
    expect(g.steps[2]?.links.map(l => l.label)).toEqual(['B 也看这份'])
    expect(g.links).toEqual([])
    expect(g.items.map(i => [i.id, i.stepId === g.steps[0]!.id ? 'T' : i.stepId === g.steps[1]!.id ? 'A' : 'B'])).toEqual([['i-t1', 'T'], ['i-a1', 'A'], ['i-a2', 'A'], ['i-b1', 'B']])
    expect(m.archive.goals).toEqual([])
    expect(checkInvariants(m)).toBeNull()
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ kind: 'goal.merge', id: g.id })
    expect(r.events[0]?.summary).toContain('合并 3 个目标为：G-export AI 落地')
    for (const s of g.steps) expect(r.events[0]?.summary).toContain(s.id)
  })

  test('decisions and focus pointing at an old goal follow to the new one; project-level decisions stay', () => {
    const r = must(executeDirect(staged(), 'goal.merge', { title: 'G', goalIds: ['g-t', 'g-a'] }, 'ok', ctx()))
    const id = r.board.goals.find(g => g.title === 'G')!.id
    expect(r.board.decisions.find(d => d.id === 'd-1')?.goalId).toBe(id)
    expect(r.board.decisions.find(d => d.id === 'd-0')?.goalId).toBe('')
    expect(r.board.focus.goalId).toBe(id)
    expect(r.board.focus.updatedAt).toBe(NOW)
  })

  test('the new goal takes the place of the first goal in goalIds order', () => {
    const b = staged()
    b.goals.push(mkGoal('g-c', 'C 后面'))
    const r = must(executeDirect(b, 'goal.merge', { title: 'G', goalIds: ['g-a', 'g-t'] }, 'ok', ctx()))
    expect(r.board.goals.map(g => g.title)).toEqual(['G', 'B 填 Key', 'C 后面'])
    expect(r.board.goals[0]?.steps.map(s => s.title)).toEqual(['A 运行时', 'T 测试版'])
    const r2 = must(executeDirect(b, 'goal.merge', { title: 'G', goalIds: ['g-t', 'g-b'] }, 'ok', ctx()))
    expect(r2.board.goals.map(g => g.title)).toEqual(['G', 'A 运行时', 'C 后面'])
  })

  test('a goal that already has steps keeps them; its outcome and quote go into its first step note, links join by target, loose items stay loose', () => {
    let b = stepped()
    b = apply(b, [{ op: 'goal.link.add', goalId: 'g-s', link: doc('设计方案.md', '总方案') }])
    b.goals.push(mkGoal('g-n', 'N 新的', [item('i-n', 'N1')], { outcome: 'N 成果', quote: '做 N', links: [doc('设计方案.md', '重复的'), doc('n.md', 'N 文档')] }))
    b = apply(b, [{ op: 'step.add', goalId: 'g-n', title: 'N-1 唯一', note: '已有说明' }])
    b = apply(b, [{ op: 'item.update', id: 'i-n', stepId: goalOf(b, 'g-n').steps[0]!.id }])
    const looseId = goalOf(b, 'g-s').items.find(i => i.title === '零散的事')!.id
    const keep = goalOf(b, 'g-s').steps.map(s => s.id)
    const r = must(executeDirect(b, 'goal.merge', { title: 'M', goalIds: ['g-s', 'g-n'] }, 'ok', ctx()))
    const g = r.board.goals[0]!
    expect(g.steps.slice(0, 3).map(s => s.id)).toEqual(keep)
    expect(g.steps).toHaveLength(4)
    expect(g.steps[0]?.note).toBe('旧目标「G 大目标」：做完 G')
    expect(g.steps[3]).toMatchObject({ title: 'N-1 唯一', note: '已有说明\n旧目标「N 新的」：N 成果\n用户原话：做 N' })
    expect(g.links.map(l => l.target)).toEqual(['设计方案.md', 'n.md'])
    expect(g.links[0]?.label).toBe('总方案')
    expect(itemOf(r.board, looseId).stepId).toBe('')
    expect(itemOf(r.board, 'i-n').stepId).toBe(g.steps[3]!.id)
    expect(checkInvariants(r.board)).toBeNull()
  })

  test('a paused goal is merged in and the result is active', () => {
    const r = must(executeDirect(staged(), 'goal.merge', { title: 'G', goalIds: ['g-a', 'g-b'] }, 'ok', ctx()))
    expect(r.board.goals.find(g => g.title === 'G')?.status).toBe('active')
  })

  test('proposals that refer to an old goal by goalId or goalIds are deleted', () => {
    let b = staged()
    b.goals.push(mkGoal('g-c', 'C'), mkGoal('g-d', 'D'))
    for (const [a, p] of [['goal.close', { goalId: 'g-t', reason: '完成' }], ['goal.merge', { title: 'X', goalIds: ['g-a', 'g-c'] }], ['goal.pause', { goalId: 'g-d' }], ['goal.merge', { title: 'Y', goalIds: ['g-c', 'g-d'] }]] as const) {
      b = must(propose(b, a, p, '', ctx())).board
    }
    expect(b.proposals).toHaveLength(4)
    const r = must(executeDirect(b, 'goal.merge', { title: 'G', goalIds: ['g-t', 'g-a'] }, 'ok', ctx()))
    expect(r.board.proposals.map(p => [p.action, (p.payload.goalId ?? (p.payload.goalIds as string[]).join('+')) as string])).toEqual([['goal.pause', 'g-d'], ['goal.merge', 'g-c+g-d']])
  })

  test('approve runs the proposal once: the card\'s own proposal is gone, the user\'s sidebar click is recorded', () => {
    const b = must(propose(staged(), 'goal.merge', { title: 'G', goalIds: ['g-t', 'g-a'] }, '一个目标的几个阶段', ctx())).board
    const pid = b.proposals[0]!.id
    const r = must(approve(b, pid, ctx({ actor: 'user' }), 'sidebar'))
    expect(r.board.proposals).toEqual([])
    expect(r.board.goals[0]).toMatchObject({ title: 'G', confirmedBy: 'sidebar' })
    expect(r.board.goals[0]?.quote).toBeUndefined()
  })

  test('bad payloads are refused when proposed, not when approved', () => {
    const ask = (payload: unknown) => propose(staged(), 'goal.merge', payload, '', ctx())
    const why = (payload: unknown): string => {
      const r = ask(payload)
      return r.ok ? '' : r.reason
    }
    expect(why({ title: 'G', goalIds: ['g-t'] })).toContain('至少要合并 2 个目标')
    expect(why({ title: 'G', goalIds: ['g-t', 'g-t'] })).toContain('不能重复')
    expect(why({ title: 'G', goalIds: ['g-t', 'g-zzz'] })).toContain('g-zzz 不存在')
    expect(why({ title: '', goalIds: ['g-t', 'g-a'] })).toContain('title 不能为空')
    expect(why({ title: 'G' })).toContain('缺少字段 goalIds')
    expect(why({ title: 'G', goalIds: ['g-t', 'g-a'], extra: 1 })).toContain('不支持字段 extra')
    const closed = closeGoal(staged(), 'g-t')
    const r = propose(closed, 'goal.merge', { title: 'G', goalIds: ['g-t', 'g-a'] }, '', ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('已关闭')
  })

  test('goal.close also clears proposals that name the goal in goalIds', () => {
    let b = staged()
    b = must(propose(b, 'goal.merge', { title: 'X', goalIds: ['g-t', 'g-a'] }, '', ctx())).board
    b = must(propose(b, 'goal.close', { goalId: 'g-t', reason: '放弃' }, '', ctx())).board
    expect(b.proposals).toHaveLength(2)
    const closeId = b.proposals.find(p => p.action === 'goal.close')!.id
    const r = must(approve(b, closeId, ctx(), 'sidebar'))
    expect(r.board.proposals).toEqual([])
  })

  test('closing a stepped goal moves its steps to the archive intact', () => {
    let b = stepped()
    b = closeGoal(b, 'g-s')
    expect(b.archive.goals[0]?.steps.map(s => s.title)).toEqual(['A 先做这个', 'B 填 Key 就能用', 'C 收尾'])
    expect(b.archive.goals[0]?.items.find(i => i.title === 'C1')?.stepId).toBe(b.archive.goals[0]?.steps[2]?.id)
  })
})

describe('queries', () => {
  test('summary lists steps per goal with done/total, running and review counts', () => {
    const b = stepped()
    const goals = (query(b, 'summary') as { goals: Array<{ steps: Array<Record<string, unknown>>; openItems: Array<{ stepId: string }> }> }).goals
    expect(goals[0]?.steps.map(s => [s.title, s.done, s.total, s.running, s.review])).toEqual([
      ['A 先做这个', 1, 1, 0, 0],
      ['B 填 Key 就能用', 0, 2, 1, 1],
      ['C 收尾', 0, 1, 0, 0],
    ])
    expect(goals[0]?.openItems.every(i => typeof i.stepId === 'string')).toBe(true)
  })

  test('goal returns steps with their links; item returns the step title', () => {
    let b = stepped()
    const sb = goalOf(b, 'g-s').steps[1]!
    b = apply(b, [{ op: 'step.link.add', id: sb.id, link: doc('界面设计.md') }])
    const g = (query(b, 'goal', { id: 'g-s' }) as { goal: Goal }).goal
    expect(g.steps[1]?.links.length).toBe(1)
    const it = goalOf(b, 'g-s').items.find(i => i.title.startsWith('B5'))!
    const q = query(b, 'item', { id: it.id }) as { step: { id: string; title: string } | null; item: Item }
    expect(q.step).toEqual({ id: sb.id, title: 'B 填 Key 就能用' })
    expect(q.item.stepId).toBe(sb.id)
    const free = goalOf(b, 'g-s').items.find(i => i.title === '零散的事')!
    expect((query(b, 'item', { id: free.id }) as { step: unknown }).step).toBeNull()
  })

  test('after a merge, search finds the step by the old goal name or its outcome text', () => {
    const r = must(executeDirect(staged(), 'goal.merge', { title: 'G', goalIds: ['g-t', 'g-a'] }, 'ok', ctx()))
    const hit = (kw: string) => (query(r.board, 'search', { keyword: kw }) as { hits: Array<{ kind: string; text: string }> }).hits.filter(h => h.kind === 'step')
    expect(hit('运行时').map(h => h.text)).toEqual(['A 运行时'])
    expect(hit('T 的成果').map(h => h.text)).toEqual(['T 测试版'])
  })

  test('archive search sees step titles', () => {
    let b = stepped()
    b = closeGoal(b, 'g-s')
    const found = query(b, 'archive', { keyword: '收尾' }) as { goals: Array<{ id: string; steps: unknown[] }> }
    expect(found.goals.map(g => g.id)).toEqual(['g-s'])
    expect(found.goals[0]?.steps).toHaveLength(3)
  })
})

describe('describeChanges', () => {
  test('a merge reads as one line: no per-item "移到目标", no new-goal / removed-goal lines, focus not re-announced', () => {
    const before = staged()
    const after = must(executeDirect(before, 'goal.merge', { title: 'G-export AI 落地', goalIds: ['g-t', 'g-a', 'g-b'] }, 'ok', ctx())).board
    expect(describeChanges(before, after, '用户')).toEqual(['用户：合并 3 个目标为：G-export AI 落地'])
  })

  test('two goals closed and one created are not mistaken for a merge', () => {
    const before = staged()
    const after = JSON.parse(JSON.stringify(before)) as Board
    after.goals = after.goals.filter(g => g.id !== 'g-t')
    after.goals.push(mkGoal('g-new', '全新'))
    const lines = describeChanges(before, after, '外部')
    expect(lines.some(l => l.includes('合并'))).toBe(false)
    expect(lines).toContain('外部：目标「T 测试版」已从看板移除')
  })

  test('steps: added and removed are named; renames, notes, short names and moving items between steps are not', () => {
    const b0 = stepped()
    const sa = goalOf(b0, 'g-s').steps[0]!
    const b5 = goalOf(b0, 'g-s').items.find(i => i.title.startsWith('B5'))!
    const b1 = apply(b0, [
      { op: 'step.add', goalId: 'g-s', title: 'D 新的' },
      { op: 'step.update', id: sa.id, title: 'A 改名了', label: '短', note: '新说明' },
      { op: 'item.update', id: b5.id, stepId: sa.id },
      { op: 'step.remove', id: goalOf(b0, 'g-s').steps[2]!.id },
    ])
    expect(describeChanges(b0, b1, '主会话')).toEqual(['主会话：新增步骤「D 新的」（目标：G 大目标）', '主会话：步骤「C 收尾」已删除'])
    const b2 = apply(b1, [{ op: 'item.update', id: b5.id, stepId: '' }])
    expect(describeChanges(b1, b2, 'x')).toEqual([])
  })

  test('a step carried to another goal by id says nothing: it is neither a delete nor an add', () => {
    const before = stepped()
    before.goals.push(mkGoal('g-o', '别的'))
    const after = JSON.parse(JSON.stringify(before)) as Board
    const s = after.goals[0]!.steps.splice(0, 1)[0]!
    after.goals[0]!.items = after.goals[0]!.items.map(i => (i.stepId === s.id ? { ...i, stepId: '' } : i))
    after.goals[1]!.steps.push(s)
    const lines = describeChanges(before, after, '外部')
    expect(lines.some(l => l.includes('已删除') || l.includes('新增步骤') || l.includes('步骤「A 先做这个」'))).toBe(false)
  })
})

describe('derived names and states', () => {
  test('step short names: label, leading code, part before a separator, first four characters', () => {
    const n = (title: string, label = '') => stepShortName({ title, label })
    expect(n('B 填 Key 就能用')).toBe('B')
    expect(n('B8b 出错提示与重试')).toBe('B8b')
    expect(n('A：运行时')).toBe('A')
    expect(n('随便写', '自定义')).toBe('自定义')
    expect(n('设计：预览稿与规则')).toBe('设计')
    expect(n('收尾工作与验收清单')).toBe('收尾工作')
    expect(n('这一段的名字特别特别长、后面还有')).toBe('这一段的')
    expect(n('abcdefg hi')).toBe('abcd')
  })

  test('goal short names stop at the first separator and are cut to 8 characters', () => {
    expect(goalShortName('G-export AI 落地')).toBe('G-export')
    expect(goalShortName('车辆：三款车（含贴图）')).toBe('车辆')
    expect(goalShortName('一个非常非常长的目标名字没有分隔')).toBe('一个非常非常长的')
    expect(goalShortName('：怪标题')).toBe('：怪标题')
  })

  test('step state: none → idle; all done → done; review beats running beats under way; dropped is ignored', () => {
    const it = (s: Item['status']) => item('i', 't', { status: s })
    expect(stepState([])).toBe('idle')
    expect(stepState([it('dropped')])).toBe('idle')
    expect(stepState([it('done'), it('dropped')])).toBe('done')
    expect(stepState([it('done'), it('todo')])).toBe('active')
    expect(stepState([it('doing')])).toBe('active')
    expect(stepState([it('todo'), it('queued')])).toBe('idle')
    expect(stepState([it('running'), it('doing')])).toBe('running')
    expect(stepState([it('running'), it('review'), it('done')])).toBe('review')
    expect(progressOf([it('done'), it('dropped'), it('running')])).toEqual({ done: 1, total: 2, running: 1, review: 0 })
  })

  test('goal state: paused; done only when every step is done and nothing open is loose; else never "done"', () => {
    const b = stepped()
    expect(goalState(goalOf(b, 'g-s'))).toBe('review')
    const g: Goal = JSON.parse(JSON.stringify(goalOf(b, 'g-s')))
    for (const i of g.items) i.status = 'done'
    expect(goalState(g)).toBe('done')
    g.items.find(i => i.stepId === '')!.status = 'todo'
    expect(goalState(g)).toBe('active')
    g.items.find(i => i.stepId === '')!.status = 'done'
    g.steps.push({ id: 's-empty', title: '空的', label: '', note: '', links: [] })
    expect(goalState(g)).toBe('active')
    g.status = 'paused'
    expect(goalState(g)).toBe('paused')
    expect(goalState(mkGoal('g-e', 'empty'))).toBe('idle')
  })
})

describe('snapshot with steps', () => {
  test('a stepped goal shows its step bar and one block per step with open items; steps without open items appear only in the bar', () => {
    const board = stepped()
    const text = buildSnapshot(board)
    const g = goalOf(board, 'g-s')
    expect(text).toContain('- g-s G 大目标：做完 G\n  步骤：✓A ◆B 0/2 ○C 未分步骤 1')
    expect(text).toContain(`  [B] ${g.steps[1]!.id} B 填 Key 就能用`)
    expect(text).not.toContain(`[A] ${g.steps[0]!.id}`)
    expect(text).toMatch(/\n {4}- i-\w+ ◆待验收 B5 收进详情\n/)
    expect(text).toMatch(/\n {4}- i-\w+ ●在跑 B8 出错提示 @b8b — 正在写状态处理\n/)
    expect(text).toContain('  [未分步骤]\n    - ')
    // review step first, then idle ones
    expect(text.indexOf('[B]')).toBeLessThan(text.indexOf('[C]'))
  })

  test('step blocks are ordered review, running, under way, rest — and not by position', () => {
    let b = emptyBoard('o')
    b.goals.push(mkGoal('g-o', 'O'))
    b = apply(b, ['P1 idle', 'P2 active', 'P3 running', 'P4 review'].map(title => ({ op: 'step.add', goalId: 'g-o', title })))
    const ids = goalOf(b, 'g-o').steps.map(s => s.id)
    b = apply(b, [
      { op: 'item.add', goalId: 'g-o', stepId: ids[0], title: 'x0' },
      { op: 'item.add', goalId: 'g-o', stepId: ids[1], title: 'x1', status: 'doing' },
      { op: 'item.add', goalId: 'g-o', stepId: ids[2], title: 'x2', status: 'running' },
      { op: 'item.add', goalId: 'g-o', stepId: ids[3], title: 'x3', status: 'review', noReviewTargetReason: 'n' },
    ])
    const t = buildSnapshot(b)
    const at = (s: string) => t.indexOf(`[${s}]`)
    expect(at('P4')).toBeLessThan(at('P3'))
    expect(at('P3')).toBeLessThan(at('P2'))
    expect(at('P2')).toBeLessThan(at('P1'))
  })

  /** One goal with `steps` steps of `per` open items, each with a long note, plus `others` plain goals. */
  function big(steps: number, per: number, others = 0): Board {
    let b = emptyBoard('big')
    b.goals.push(mkGoal('g-big', 'G 大目标', [], { outcome: '总体成果'.repeat(20) }))
    b = apply(b, Array.from({ length: steps }, (_, n) => ({ op: 'step.add', goalId: 'g-big', title: `S${n} 第${n}步` })))
    const ids = goalOf(b, 'g-big').steps.map(s => s.id)
    b = apply(
      b,
      ids.flatMap((id, n) => Array.from({ length: per }, (_, k) => ({ op: 'item.add', goalId: 'g-big', stepId: id, title: `S${n}-${k} 事项`, status: 'doing', note: '备注文字很长'.repeat(5) }))),
    )
    for (let k = 0; k < others; k++) b.goals.push(mkGoal(`g-o${k}`, `其他${k}`, [item(`i-o${k}`, `其他事项${k}`, { status: 'doing' })]))
    return b
  }

  test('a big stepped goal degrades step by step: early steps keep notes, later ones titles, then counts; heads and the bar stay', () => {
    const t = buildSnapshot(big(15, 8))
    expect(t.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(t).toContain('总体成果')
    expect(t).toMatch(/步骤：.*S14/)
    expect(t).toContain('S0-0 事项 — 备注文字很长')
    const notes = t.split('备注文字很长').length - 1
    expect(notes).toBeGreaterThan(0)
    expect(notes).toBeLessThan(15 * 8 * 5)
    // somewhere a step is cut to its item titles
    expect(t).toMatch(/\n {4}- i-\w+ ◐在做 S\d+-\d+ 事项\n/)
  })

  test('the head of every stepped goal survives even when an earlier goal\'s steps would eat the room', () => {
    let b = big(40, 8)
    const second = mkGoal('g-two', 'H 第二个目标', [], { outcome: '二号成果' })
    b.goals.push(second)
    b = apply(b, [{ op: 'step.add', goalId: 'g-two', title: 'X 唯一的步骤' }])
    b = apply(b, [{ op: 'item.add', goalId: 'g-two', stepId: goalOf(b, 'g-two').steps[0]!.id, title: '二号事项', status: 'doing' }])
    const t = buildSnapshot(b)
    expect(t.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(t).toMatch(/- g-two H 第二个目标(：二号成果)?\n {2}步骤：◐X 0\/1/)
    expect(t).toContain('总体成果')
  })

  test('what is left out is said, in goals and steps', () => {
    const t = buildSnapshot(big(30, 10, 10))
    expect(t.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(t).toMatch(/另有 .*(个目标|个步骤).*用 board_get summary 查看/)
  })

  test('goals without steps print exactly as before', () => {
    const b = staged()
    const t = buildSnapshot(b)
    expect(t).toContain('- g-a A 运行时：A 的成果\n  - i-a1 ●在跑 A1\n  - i-a2 ○待办 A2')
    expect(t).toContain('- g-b B 填 Key（暂停）')
    expect(t).not.toContain('步骤：')
  })

  test('paused goal with steps stays a one-line entry', () => {
    const b = stepped()
    b.goals[0]!.status = 'paused'
    expect(buildSnapshot(b)).toContain('- g-s G 大目标（暂停）')
  })

  test('rules text and tool descriptions know steps, goal.merge and the stepId rule', () => {
    const spec = (n: string) => toolSpecs.find(t => t.name === n)!
    const update = spec('board_update').description
    for (const w of ['step.add', 'step.update', 'step.remove', 'step.link.add', 'stepId', '分两次调用', '与看板步骤无关', '用 step.add 拆成步骤']) expect(update).toContain(w)
    expect(update).not.toContain('步骤进度只写')
    const propose = spec('board_propose').description
    expect(propose).toContain('goal.merge {title, goalIds[], outcome?}')
    expect(propose).toContain('goalIds 含该目标即算引用')
    expect(JSON.stringify(spec('board_propose').inputSchema)).toContain('goal.merge')
    expect(spec('board_get').description).toContain('步骤')
  })
})
