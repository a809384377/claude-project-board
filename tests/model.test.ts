import { describe, expect, test } from 'claude-code/testing'
import { collectIds, newId } from '../hooks/model/ids'
import { checkInvariants } from '../hooks/model/invariants'
import { applyOps, type Op, type OpCtx } from '../hooks/model/ops'
import { emptyBoard, parseBoard, serializeBoard } from '../hooks/model/parse'
import { approve, executeDirect, propose, reject } from '../hooks/model/propose'
import type { Board } from '../hooks/model/types'

const NOW = '2026-10-11T09:00:00+08:00'
let seed = 1
/** Deterministic, never repeats within a test file. */
const rand = () => {
  seed = (seed * 48271) % 2147483647
  return seed / 2147483647
}
const ctx = (over: Partial<OpCtx> = {}): OpCtx => ({ now: NOW, session: 's1', actor: 'main', rand, ...over })

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error('expected ok, got ' + JSON.stringify(r))
  return r as Extract<T, { ok: true }>
}
function apply(b: Board, ops: Op[], c: OpCtx = ctx()): Board {
  return must(applyOps(b, ops, c)).board
}
const snap = (b: Board) => JSON.stringify(b)

/** A board with goal g-car (active) holding i-a and i-b, goal g-pause (paused), no archive. */
function base(): Board {
  const b = emptyBoard('demo')
  const item = (id: string, title: string) => ({
    id, title, stepId: '', status: 'todo' as const, owner: '', note: '', waitingFor: '', dependsOn: [], scope: [], acceptance: '',
    links: [], noReviewTargetReason: '', reportedAt: '', session: '', doneBy: '' as const, createdAt: NOW, updatedAt: NOW, doneAt: '',
  })
  b.goals.push(
    { id: 'g-car', title: '车辆', outcome: '三款车', status: 'active', links: [], steps: [], items: [item('i-a', '车身'), item('i-b', '轮子')], createdAt: NOW, updatedAt: NOW },
    { id: 'g-pause', title: '路灯', outcome: '', status: 'paused', links: [], steps: [], items: [], createdAt: NOW, updatedAt: NOW },
  )
  return b
}
const fileLink = { type: 'path', kind: '报告', target: 'ai/r.md', label: '看报告', forReview: true }

describe('ops: normal path of every op', () => {
  test('item.add / update / move / remove', () => {
    let b = base()
    const r = must(applyOps(b, [{ op: 'item.add', goalId: 'g-car', title: '车灯', owner: 'main', dependsOn: ['i-a'], scope: ['x/'], acceptance: '亮', links: [fileLink] }], ctx()))
    b = r.board
    const added = b.goals[0]!.items[2]!
    expect(added.id).toMatch(/^i-[0-9a-z]{6}$/)
    expect(added).toMatchObject({ title: '车灯', status: 'todo', owner: 'main', dependsOn: ['i-a'], scope: ['x/'], createdAt: NOW })
    expect(r.events[0]).toMatchObject({ kind: 'item.add', id: added.id })

    b = apply(b, [{ op: 'item.update', id: 'i-a', title: '车身 v2', note: 'n', waitingFor: 'w', owner: 'build' }])
    expect(b.goals[0]!.items[0]).toMatchObject({ title: '车身 v2', note: 'n', waitingFor: 'w', owner: 'build' })

    b = apply(b, [{ op: 'item.move', id: 'i-b', goalId: 'g-pause' }])
    expect(b.goals[0]!.items.map(i => i.id)).not.toContain('i-b')
    expect(b.goals[1]!.items.map(i => i.id)).toEqual(['i-b'])

    b = apply(b, [{ op: 'item.remove', id: added.id }])
    expect(b.goals[0]!.items.map(i => i.id)).toEqual(['i-a'])
  })

  test('goal.link / item.link add and remove', () => {
    let b = apply(base(), [
      { op: 'goal.link.add', goalId: 'g-car', link: { type: 'url', target: 'https://x.test/a' } },
      { op: 'item.link.add', id: 'i-a', link: fileLink },
    ])
    expect(b.goals[0]!.links).toHaveLength(1)
    expect(b.goals[0]!.links[0]).toMatchObject({ type: 'url', kind: '', label: '', forReview: false })
    expect(b.goals[0]!.items[0]!.links[0]!.target).toBe('ai/r.md')
    b = apply(b, [
      { op: 'goal.link.remove', goalId: 'g-car', target: 'https://x.test/a' },
      { op: 'item.link.remove', id: 'i-a', target: 'ai/r.md' },
    ])
    expect(b.goals[0]!.links).toHaveLength(0)
    expect(b.goals[0]!.items[0]!.links).toHaveLength(0)
  })

  test('decision.add / update, supersedes', () => {
    let b = apply(base(), [{ op: 'decision.add', text: '车全部自建', kind: 'user', goalId: 'g-car', quote: '车全部自建' }])
    const d1 = b.decisions[0]!
    expect(d1).toMatchObject({ date: '2026-10-11', kind: 'user', goalId: 'g-car', quote: '车全部自建', status: 'active' })
    const r = must(applyOps(b, [{ op: 'decision.add', text: '改口：可下载免登录模型', kind: 'user', supersedes: d1.id }], ctx()))
    b = r.board
    expect(r.events[0]).toMatchObject({ kind: 'decision.add', summary: '改口：可下载免登录模型' })
    expect(b.decisions[0]!.status).toBe('superseded')
    expect(b.decisions[1]).toMatchObject({ supersedes: d1.id, goalId: '', status: 'active' })
    b = apply(b, [{ op: 'decision.update', id: d1.id, text: '车全部自建（旧）' }])
    expect(b.decisions[0]!.text).toBe('车全部自建（旧）')
  })

  test('rule / note add, update, remove', () => {
    let b = apply(base(), [
      { op: 'rule.add', text: '管线只用 rebuild.sh', group: '管线' },
      { op: 'note.add', title: '环境', text: 'Blender 5.2.2', group: '环境' },
    ])
    const rid = b.rules[0]!.id
    const nid = b.notes[0]!.id
    expect(b.rules[0]).toMatchObject({ text: '管线只用 rebuild.sh', group: '管线' })
    b = apply(b, [
      { op: 'rule.update', id: rid, text: '管线只用 build.sh' },
      { op: 'note.update', id: nid, text: 'Blender 5.3' },
    ])
    expect(b.rules[0]!.text).toBe('管线只用 build.sh')
    expect(b.notes[0]!.text).toBe('Blender 5.3')
    b = apply(b, [{ op: 'rule.remove', id: rid }, { op: 'note.remove', id: nid }])
    expect(b.rules).toHaveLength(0)
    expect(b.notes).toHaveLength(0)
  })

  test('milestone add / update / gate / remove, milestones.enable', () => {
    let b = apply(base(), [{ op: 'milestones.enable' }, { op: 'milestone.add', title: '4 资产制作' }])
    expect(b.milestones.enabled).toBe(true)
    const mid = b.milestones.items[0]!.id
    expect(b.milestones.items[0]).toMatchObject({ status: '未开始', gates: [] })
    b = apply(b, [
      { op: 'milestone.update', id: mid, status: '进行中', note: 'go' },
      { op: 'milestone.gate', id: mid, name: 'G4 样板段', result: '通过', points: 'ok' },
    ])
    expect(b.milestones.items[0]).toMatchObject({ status: '进行中', note: 'go' })
    expect(b.milestones.items[0]!.gates[0]).toEqual({ date: '2026-10-11', name: 'G4 样板段', result: '通过', points: 'ok' })
    b = apply(b, [{ op: 'milestone.remove', id: mid }, { op: 'milestones.enable', enabled: false }])
    expect(b.milestones.items).toHaveLength(0)
    expect(b.milestones.enabled).toBe(false)
  })

  test('status side effects: reportedAt/session, done, leaving done', () => {
    let b = apply(base(), [{ op: 'item.update', id: 'i-a', status: 'running' }], ctx({ now: '2026-10-11T10:00:00+08:00', session: 'sess-9' }))
    expect(b.goals[0]!.items[0]).toMatchObject({ status: 'running', reportedAt: '2026-10-11T10:00:00+08:00', session: 'sess-9' })
    b = apply(b, [{ op: 'item.update', id: 'i-a', status: 'done' }], ctx({ actor: 'user' }))
    expect(b.goals[0]!.items[0]).toMatchObject({ status: 'done', doneBy: 'user', doneAt: NOW })
    b = apply(b, [{ op: 'item.update', id: 'i-a', status: 'todo' }])
    expect(b.goals[0]!.items[0]).toMatchObject({ doneBy: '', doneAt: '' })
    b = apply(b, [{ op: 'item.update', id: 'i-b', status: 'done' }], ctx({ actor: 'agent' }))
    expect(b.goals[0]!.items[1]!.doneBy).toBe('claude')
  })
})

describe('ops: batches are all-or-nothing', () => {
  test('third op fails -> index 2, input untouched', () => {
    const b = base()
    const before = snap(b)
    const r = applyOps(b, [
      { op: 'item.add', goalId: 'g-car', title: 'x' },
      { op: 'rule.add', text: 'r' },
      { op: 'item.update', id: 'i-nope', title: 'y' },
      { op: 'note.add', title: 'n' },
    ], ctx())
    expect(r).toMatchObject({ ok: false, index: 2 })
    expect((r as { reason: string }).reason).toContain('i-nope')
    expect(snap(b)).toBe(before)
  })

  test('success does not mutate the input either', () => {
    const b = base()
    const before = snap(b)
    must(applyOps(b, [{ op: 'item.add', goalId: 'g-car', title: 'x' }], ctx()))
    expect(snap(b)).toBe(before)
  })
})

describe('ops: invariants on the final state', () => {
  test('review without entry succeeds and carries a hint naming the item', () => {
    const r = must(applyOps(base(), [{ op: 'item.update', id: 'i-a', status: 'review' }], ctx()))
    expect(r.board.goals[0]!.items[0]!.status).toBe('review')
    const hints = r.events.filter(e => e.kind === 'hint')
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatchObject({ id: 'i-a' })
    expect(hints[0]!.summary).toContain('没有验收入口，用户无法从看板打开它')
  })

  test('review with an entry, in either order inside the batch, carries no hint', () => {
    const r1 = must(applyOps(base(), [
      { op: 'item.update', id: 'i-a', status: 'review' },
      { op: 'item.link.add', id: 'i-a', link: fileLink },
    ], ctx()))
    expect(r1.events.filter(e => e.kind === 'hint')).toEqual([])
    const r2 = must(applyOps(base(), [
      { op: 'item.link.add', id: 'i-a', link: fileLink },
      { op: 'item.update', id: 'i-a', status: 'review' },
    ], ctx()))
    expect(r2.events.filter(e => e.kind === 'hint')).toEqual([])
  })

  test('a link that is not forReview does not count as an entry', () => {
    const r = must(applyOps(base(), [
      { op: 'item.link.add', id: 'i-a', link: { type: 'ref', target: 'abc123', forReview: false } },
      { op: 'item.update', id: 'i-a', status: 'review' },
    ], ctx()))
    expect(r.events.filter(e => e.kind === 'hint')).toHaveLength(1)
  })

  test('an item that was already in review is not hinted again by an unrelated edit', () => {
    const inReview = apply(base(), [{ op: 'item.update', id: 'i-a', status: 'review' }])
    const r = must(applyOps(inReview, [{ op: 'item.update', id: 'i-a', note: 'x' }], ctx()))
    expect(r.events.filter(e => e.kind === 'hint')).toEqual([])
  })

  test('removing the last entry of a review item is allowed and hints', () => {
    const inReview = apply(base(), [
      { op: 'item.link.add', id: 'i-a', link: fileLink },
      { op: 'item.update', id: 'i-a', status: 'review' },
    ])
    const r = must(applyOps(inReview, [{ op: 'item.link.remove', id: 'i-a', target: 'ai/r.md' }], ctx()))
    expect(r.board.goals[0]!.items[0]!.links).toEqual([])
  })

  test('adding a forReview entry to an item that has one hints with the old entries; the first entry does not', () => {
    const first = must(applyOps(base(), [{ op: 'item.link.add', id: 'i-a', link: fileLink }], ctx()))
    expect(first.events.filter(e => e.kind === 'hint')).toEqual([])
    const second = must(applyOps(first.board, [
      { op: 'item.link.add', id: 'i-a', link: { ...fileLink, target: 'ai/r2.md' } },
    ], ctx()))
    const hints = second.events.filter(e => e.kind === 'hint')
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatchObject({ id: 'i-a' })
    expect(hints[0]!.summary).toContain('已有入口：ai/r.md')
    expect(hints[0]!.summary).toContain('item.link.remove')
  })

  test('swapping an entry in one batch hints; a plain (non-review) link added beside an entry does not', () => {
    const b = apply(base(), [{ op: 'item.link.add', id: 'i-a', link: fileLink }])
    const swap = must(applyOps(b, [
      { op: 'item.link.add', id: 'i-a', link: { ...fileLink, target: 'ai/r2.md' } },
      { op: 'item.link.remove', id: 'i-a', target: 'ai/r.md' },
    ], ctx()))
    expect(swap.events.filter(e => e.kind === 'hint')).toHaveLength(1)
    const plain = must(applyOps(b, [{ op: 'item.link.add', id: 'i-a', link: { type: 'ref', target: 'abc123', forReview: false } }], ctx()))
    expect(plain.events.filter(e => e.kind === 'hint')).toEqual([])
  })

  test('dependsOn must point to an existing active item', () => {
    expect(applyOps(base(), [{ op: 'item.update', id: 'i-b', dependsOn: ['i-ghost'] }], ctx()).ok).toBe(false)
    const b = apply(base(), [{ op: 'item.update', id: 'i-b', dependsOn: ['i-a'] }])
    expect(b.goals[0]!.items[1]!.dependsOn).toEqual(['i-a'])
  })

  test('removing a depended-on item drops the dependency and says so in events', () => {
    const b = apply(base(), [{ op: 'item.update', id: 'i-b', dependsOn: ['i-a'] }])
    const r = must(applyOps(b, [{ op: 'item.remove', id: 'i-a' }], ctx()))
    expect(r.board.goals[0]!.items.map(i => i.id)).toEqual(['i-b'])
    expect(r.board.goals[0]!.items[0]!.dependsOn).toEqual([])
    expect(r.events.map(e => e.kind)).toEqual(['item.remove', 'dependency.unlink'])
    expect(r.events[1]).toMatchObject({ id: 'i-b', summary: '解除依赖：轮子 不再依赖 车身' })
  })

  test('a dangling dependsOn already in the file does not block unrelated writes', () => {
    const b = base()
    b.goals[0]!.items[1]!.dependsOn = ['i-gone']
    expect(applyOps(b, [{ op: 'note.add', title: 'x' }], ctx()).ok).toBe(true)
    expect(checkInvariants(b)).toBeNull()
  })

  test('item.move: paused target ok, unknown target fails', () => {
    must(applyOps(base(), [{ op: 'item.move', id: 'i-a', goalId: 'g-pause' }], ctx()))
    const r = applyOps(base(), [{ op: 'item.move', id: 'i-a', goalId: 'g-ghost' }], ctx())
    expect(r).toMatchObject({ ok: false, index: 0 })
  })

  test('item.move into a closed goal fails with a clear reason', () => {
    const closed = must(executeDirect(base(), 'goal.close', { goalId: 'g-pause', reason: '放弃' }, '不做了', ctx())).board
    const r = applyOps(closed, [{ op: 'item.move', id: 'i-a', goalId: 'g-pause' }], ctx())
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('已关闭')
  })

  test('checkInvariants flags duplicate ids across active and archive', () => {
    const b = base()
    b.archive.decisions.push({ id: 'i-a', date: '', text: 't', kind: 'user', goalId: '', status: 'active' })
    expect(checkInvariants(b)).toContain('i-a')
    expect(checkInvariants(base())).toBeNull()
  })
})

describe('ids', () => {
  test('format and collision skipping', () => {
    const seq = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    let n = 0
    const r = () => seq[n++ % seq.length]!
    const taken = new Set(['i-000000'])
    expect(newId('i', taken, r)).toBe('i-iiiiii')
    expect(newId('g', new Set(), () => 0.999)).toBe('g-zzzzzz')
  })

  test('ids in the archive count as taken (via item.add)', () => {
    const b = base()
    b.archive.goals.push({ id: 'g-old', title: 'old', outcome: '', status: 'active', links: [], steps: [], items: [], createdAt: '', updatedAt: '', closedAt: NOW, closeReason: '完成' })
    b.archive.decisions.push({ id: 'd-old', date: '', text: 't', kind: 'user', goalId: '', status: 'active' })
    expect(collectIds(b).has('g-old')).toBe(true)
    expect(collectIds(b).has('d-old')).toBe(true)
    // first six draws spell "d-000000" which is taken by the archive; the seventh..twelfth give a free id
    b.archive.decisions[0]!.id = 'i-000000'
    const seq = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    let n = 0
    const out = apply(b, [{ op: 'item.add', goalId: 'g-car', title: 'x' }], ctx({ rand: () => seq[n++ % seq.length]! }))
    expect(out.goals[0]!.items[2]!.id).toBe('i-iiiiii')
  })

  test('two adds in one batch never share an id even with a constant rand', () => {
    const seq = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]
    let n = 0
    const out = apply(base(), [
      { op: 'item.add', goalId: 'g-car', title: 'x' },
      { op: 'item.add', goalId: 'g-car', title: 'y' },
    ], ctx({ rand: () => seq[n++ % seq.length]! }))
    const ids = out.goals[0]!.items.map(i => i.id)
    expect(new Set(ids).size).toBe(4)
  })
})

describe('proposals', () => {
  test('goal.close: archive, focus cleared, related proposals dropped, decisions follow', () => {
    let b = apply(base(), [
      { op: 'item.update', id: 'i-a', status: 'running' },
      { op: 'decision.add', text: '车的决策', kind: 'user', goalId: 'g-car' },
      { op: 'decision.add', text: '项目级决策', kind: 'user' },
    ])
    b = must(executeDirect(b, 'focus.set', { text: '先做车', goalId: 'g-car', mandate: '一路推进' }, '先做车', ctx())).board
    b = must(propose(b, 'goal.pause', { goalId: 'g-car' }, '暂停', ctx())).board
    b = must(propose(b, 'goal.pause', { goalId: 'g-pause' }, '无关', ctx())).board
    expect(b.proposals).toHaveLength(2)
    expect(b.focus.goalId).toBe('g-car')

    const closed = must(executeDirect(b, 'goal.close', { goalId: 'g-car', reason: '完成' }, '车做完了', ctx({ now: '2026-10-12T00:00:00+08:00' }))).board
    expect(closed.goals.map(g => g.id)).toEqual(['g-pause'])
    expect(closed.archive.goals[0]).toMatchObject({ id: 'g-car', closeReason: '完成', closedAt: '2026-10-12T00:00:00+08:00' })
    expect(closed.archive.goals[0]!.items.map(i => i.id)).toEqual(['i-a', 'i-b'])
    expect(closed.archive.decisions.map(d => d.text)).toEqual(['车的决策'])
    expect(closed.decisions.map(d => d.text)).toEqual(['项目级决策'])
    expect(closed.focus.goalId).toBe('')
    expect(closed.focus.text).toBe('先做车')
    expect(closed.proposals).toHaveLength(1)
    expect(closed.proposals[0]!.payload.goalId).toBe('g-pause')
  })

  test('closing a goal whose items others depend on drops those dependencies', () => {
    const b = apply(base(), [{ op: 'item.add', goalId: 'g-pause', title: 'dep', dependsOn: ['i-a', 'i-b'] }])
    const r = must(executeDirect(b, 'goal.close', { goalId: 'g-car', reason: '完成' }, 'ok', ctx()))
    expect(r.board.goals[0]!.items[0]!.dependsOn).toEqual([])
    expect(r.board.archive.goals[0]!.items.map(i => i.id)).toEqual(['i-a', 'i-b'])
    expect(r.events.map(e => e.kind)).toEqual(['goal.close', 'dependency.unlink'])
    expect(r.events[1]!.summary).toBe('解除依赖：dep 不再依赖 车身、轮子')
  })

  test('approve twice: second fails with 不存在', () => {
    const p = must(propose(base(), 'goal.create', { title: '新目标', outcome: '做完' }, '用户提到', ctx()))
    const pid = p.board.proposals[0]!.id
    const first = must(approve(p.board, pid, ctx({ actor: 'user' }), 'sidebar'))
    expect(first.board.proposals).toHaveLength(0)
    const g = first.board.goals[2]!
    expect(g).toMatchObject({ title: '新目标', status: 'active', confirmedBy: 'sidebar' })
    expect(g.quote).toBeUndefined()
    const second = approve(first.board, pid, ctx({ actor: 'user' }), 'sidebar')
    expect(second.ok).toBe(false)
    expect((second as { reason: string }).reason).toContain('不存在')
    expect(first.board.goals).toHaveLength(3)
  })

  test('conversation confirmation records quote on the new goal', () => {
    const r = must(executeDirect(base(), 'goal.create', { title: '新', outcome: 'o' }, '就做这个', ctx()))
    expect(r.board.goals[2]).toMatchObject({ confirmedBy: 'conversation', quote: '就做这个' })
  })

  test('executeDirect and approve refuse sub-agents; propose is allowed', () => {
    const agent = ctx({ actor: 'agent' })
    const d = executeDirect(base(), 'goal.pause', { goalId: 'g-car' }, '嗯', agent)
    expect(d).toMatchObject({ ok: false })
    expect((d as { reason: string }).reason).toContain('主会话')
    const p = must(propose(base(), 'goal.pause', { goalId: 'g-car' }, '想暂停', agent))
    const a = approve(p.board, p.board.proposals[0]!.id, agent, 'conversation')
    expect(a.ok).toBe(false)
  })

  test('executeDirect needs a quote', () => {
    expect(executeDirect(base(), 'goal.pause', { goalId: 'g-car' }, '  ', ctx()).ok).toBe(false)
  })

  test('re-validates on current state: pausing a paused goal, closing a closed goal', () => {
    expect(executeDirect(base(), 'goal.pause', { goalId: 'g-pause' }, 'x', ctx()).ok).toBe(false)
    expect(executeDirect(base(), 'goal.resume', { goalId: 'g-car' }, 'x', ctx()).ok).toBe(false)
    const once = must(executeDirect(base(), 'goal.close', { goalId: 'g-pause', reason: '放弃' }, 'x', ctx())).board
    expect(executeDirect(once, 'goal.close', { goalId: 'g-pause', reason: '放弃' }, 'x', ctx()).ok).toBe(false)
  })

  test('a stale proposal stays in place when its execution fails', () => {
    const p = must(propose(base(), 'goal.close', { goalId: 'g-pause', reason: '放弃' }, 'r', ctx())).board
    const pid = p.proposals[0]!.id
    // goal disappears behind the proposal's back
    const gone = { ...p, goals: p.goals.filter(g => g.id !== 'g-pause') }
    const r = approve(gone, pid, ctx(), 'sidebar')
    expect(r.ok).toBe(false)
    expect(gone.proposals).toHaveLength(1)
  })

  test('goal.update, pause, resume, focus.set and reject', () => {
    let b = must(executeDirect(base(), 'goal.update', { goalId: 'g-car', title: '车辆 v2' }, 'q', ctx())).board
    expect(b.goals[0]!.title).toBe('车辆 v2')
    b = must(executeDirect(b, 'goal.pause', { goalId: 'g-car' }, 'q', ctx())).board
    expect(b.goals[0]!.status).toBe('paused')
    b = must(executeDirect(b, 'goal.resume', { goalId: 'g-car' }, 'q', ctx())).board
    expect(b.goals[0]!.status).toBe('active')
    b = must(executeDirect(b, 'focus.set', { text: 'T', goalId: 'g-car', mandate: 'M' }, 'q', ctx())).board
    expect(b.focus).toEqual({ text: 'T', goalId: 'g-car', mandate: 'M', updatedAt: NOW })
    b = must(executeDirect(b, 'focus.set', { text: 'T2' }, 'q', ctx())).board
    expect(b.focus).toMatchObject({ text: 'T2', goalId: '', mandate: '' })
    b = must(propose(b, 'goal.pause', { goalId: 'g-car' }, 'r', ctx())).board
    const after = must(reject(b, b.proposals[0]!.id))
    expect(after.board.proposals).toHaveLength(0)
    expect(reject(after.board, 'p-none').ok).toBe(false)
  })

  test('malformed proposals are refused at proposal time', () => {
    expect(propose(base(), 'goal.explode', {}, 'r', ctx()).ok).toBe(false)
    expect(propose(base(), 'goal.close', { goalId: 'g-ghost', reason: '完成' }, 'r', ctx()).ok).toBe(false)
    expect(propose(base(), 'goal.close', { goalId: 'g-car', reason: '随便' }, 'r', ctx()).ok).toBe(false)
    expect(propose(base(), 'goal.create', { title: 't', colour: 'red' }, 'r', ctx()).ok).toBe(false)
    expect(propose(base(), 'goal.update', { goalId: 'g-car' }, 'r', ctx()).ok).toBe(false)
    expect(propose(base(), 'focus.set', { text: 't', goalId: 'g-ghost' }, 'r', ctx()).ok).toBe(false)
  })
})

describe('malformed ops (Claude input)', () => {
  const bad = (ops: Op[]) => applyOps(base(), ops, ctx())

  test('unknown op', () => {
    const r = bad([{ op: 'item.explode' }])
    expect(r).toMatchObject({ ok: false, index: 0 })
    expect((r as { reason: string }).reason).toContain('未知操作')
  })

  test('missing op, non-object op', () => {
    expect(bad([{} as Op])).toMatchObject({ ok: false, index: 0 })
    expect(bad(['item.add' as unknown as Op])).toMatchObject({ ok: false, index: 0 })
    expect(applyOps(base(), 'nope' as unknown as Op[], ctx()).ok).toBe(false)
  })

  test('missing required field names the field', () => {
    const r = bad([{ op: 'item.add', goalId: 'g-car' }])
    expect(r).toMatchObject({ ok: false, index: 0 })
    expect((r as { reason: string }).reason).toContain('title')
  })

  test('wrong types and bad enum values', () => {
    expect(bad([{ op: 'item.update', id: 'i-a', title: 5 }]).ok).toBe(false)
    expect(bad([{ op: 'item.update', id: 'i-a', dependsOn: 'i-b' }]).ok).toBe(false)
    expect(bad([{ op: 'item.update', id: 'i-a', status: 'finished' }]).ok).toBe(false)
    expect(bad([{ op: 'decision.add', text: 't', kind: 'robot' }]).ok).toBe(false)
    expect(bad([{ op: 'item.link.add', id: 'i-a', link: { type: 'fax', target: 'x' } }]).ok).toBe(false)
    expect(bad([{ op: 'item.link.add', id: 'i-a', link: { type: 'path' } }]).ok).toBe(false)
    expect(bad([{ op: 'milestones.enable', enabled: 'yes' }]).ok).toBe(false)
  })

  test('unknown fields are rejected rather than silently dropped', () => {
    const r = bad([{ op: 'item.update', id: 'i-a', ownr: 'x' }])
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('ownr')
  })

  test('unknown ids', () => {
    expect(bad([{ op: 'item.remove', id: 'i-ghost' }]).ok).toBe(false)
    expect(bad([{ op: 'rule.update', id: 'r-ghost', text: 'x' }]).ok).toBe(false)
    expect(bad([{ op: 'decision.add', text: 't', kind: 'user', goalId: 'g-ghost' }]).ok).toBe(false)
    expect(bad([{ op: 'decision.add', text: 't', kind: 'user', supersedes: 'd-ghost' }]).ok).toBe(false)
    expect(bad([{ op: 'goal.link.remove', goalId: 'g-car', target: 'nothing' }]).ok).toBe(false)
  })

  test('does not trip over inherited property names', () => {
    expect(bad([{ op: 'constructor' }]).ok).toBe(false)
    expect(bad([{ op: 'toString' }]).ok).toBe(false)
  })
})

describe('parseBoard / serializeBoard', () => {
  test('round trip keeps data and ends with newline, 2-space indent', () => {
    let b = apply(base(), [
      { op: 'item.link.add', id: 'i-a', link: { ...fileLink, step: 2 } },
      { op: 'decision.add', text: 'd', kind: 'delegated' },
      { op: 'rule.add', text: 'r' },
      { op: 'milestone.add', title: 'm' },
    ])
    b.project.type = 'miniapp'
    const text = serializeBoard(b)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.split('\n')[1]).toBe('  "schema": 1,')
    const back = parseBoard(text)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(serializeBoard(back.board)).toBe(text)
      expect(back.board).toEqual(b)
    }
  })

  test('serialized key order is fixed regardless of construction order', () => {
    const text = serializeBoard(base())
    const keys = (JSON.parse(text) as Record<string, unknown>)
    expect(Object.keys(keys)).toEqual(['schema', 'rev', 'project', 'focus', 'milestones', 'goals', 'decisions', 'rules', 'notes', 'proposals', 'archive'])
    const item = (JSON.parse(text) as { goals: { items: object[] }[] }).goals[0]!.items[0]!
    expect(Object.keys(item).slice(0, 4)).toEqual(['id', 'title', 'status', 'owner'])
  })

  test('invalid JSON returns the line', () => {
    const r = parseBoard('{\n  "schema": 1,\n  "rev": ,\n  "x": 1\n}')
    expect(r).toMatchObject({ ok: false, line: 3 })
    expect(parseBoard('{"schema": 1,\n"a": [1, 2\n').ok).toBe(false)
    expect(parseBoard('').ok).toBe(false)
    expect(parseBoard('{"a": "x\ny"}')).toMatchObject({ ok: false, line: 1 })
  })

  test('schema 3 -> newer-plugin text; schema 0 -> 未知版本; missing schema; non-object', () => {
    const r = parseBoard(JSON.stringify({ schema: 3, whatever: true }))
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('看板由更新版本的插件写入；请更新插件或重启会话，不要覆盖它或从 git 恢复')
    expect((parseBoard(JSON.stringify({ schema: 0, rev: 0 })) as { error: string }).error).toContain('未知版本')
    expect((parseBoard('{"rev":1}') as { error: string }).error).toContain('schema')
    expect(parseBoard('[]').ok).toBe(false)
  })

  test('missing required fields report the path', () => {
    const good = JSON.parse(serializeBoard(base())) as Record<string, any>
    const miss = (mut: (o: Record<string, any>) => void) => {
      const o = JSON.parse(JSON.stringify(good)) as Record<string, any>
      mut(o)
      const r = parseBoard(JSON.stringify(o))
      expect(r.ok).toBe(false)
      return (r as { error: string }).error
    }
    expect(miss(o => delete o.goals)).toContain('goals')
    expect(miss(o => delete o.goals[0].items[1].title)).toContain('goals[0].items[1].title')
    expect(miss(o => (o.goals[0].items[0].status = 'weird'))).toContain('goals[0].items[0].status')
    expect(miss(o => delete o.archive.decisions)).toContain('archive.decisions')
    expect(miss(o => delete o.project.name)).toContain('project.name')
    expect(miss(o => (o.rev = 'x'))).toContain('rev')
    expect(miss(o => (o.goals[0].items[0].links = [{ type: 'path' }]))).toContain('goals[0].items[0].links[0].target')
  })

  test('optional fields are filled with defaults', () => {
    const o = JSON.parse(serializeBoard(base())) as Record<string, any>
    o.goals[0].items[0] = { id: 'i-a', title: '车身', status: 'todo' }
    delete o.goals[0].links
    const r = parseBoard(JSON.stringify(o))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.board.goals[0]!.items[0]).toMatchObject({ owner: '', dependsOn: [], scope: [], links: [], doneBy: '' })
      expect(r.board.goals[0]!.links).toEqual([])
    }
  })

  test('emptyBoard passes its own parse and invariants', () => {
    const e = emptyBoard('x')
    const r = parseBoard(serializeBoard(e))
    expect(r.ok && checkInvariants(r.board)).toBeNull()
  })
})
