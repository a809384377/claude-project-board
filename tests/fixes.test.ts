import { describe, expect, test } from 'claude-code/testing'
import draftJson from './fixture-board'
import { applyOps, type OpCtx } from '../hooks/model/ops'
import { parseBoard } from '../hooks/model/parse'
import { approve, executeDirect, propose } from '../hooks/model/propose'
import { buildSnapshot, SNAPSHOT_LIMIT } from '../hooks/model/summary'
import type { Board } from '../hooks/model/types'

const ctx: OpCtx = { now: '2026-10-11T09:00:00+08:00', session: 's1', actor: 'main' }

/** A fictional board (fixture-board.ts): 5 active goals plus a paused one, cross-goal dependsOn, 29 rules, 25 live decisions. */
function draft(): Board {
  const parsed = parseBoard(JSON.stringify(draftJson))
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.board
}

describe('dependencies and goal close (sample board)', () => {
  test('every active goal of the sample board can be closed, directly and through a card', async () => {
    const b = draft()
    expect(b.goals.length).toBeGreaterThan(3)
    let unlinked = 0
    for (const g of b.goals) {
      const direct = executeDirect(b, 'goal.close', { goalId: g.id, reason: '完成' }, '可以关了', ctx)
      if (!direct.ok) throw new Error(`${g.id} 直接关闭失败：${direct.reason}`)
      expect(direct.board.goals.map(x => x.id)).not.toContain(g.id)
      const moved = new Set(g.items.map(i => i.id))
      for (const x of direct.board.goals) for (const i of x.items) for (const d of i.dependsOn) expect(moved.has(d)).toBe(false)
      unlinked += direct.events.filter(e => e.kind === 'dependency.unlink').length

      const p = propose(b, 'goal.close', { goalId: g.id, reason: '完成' }, '做完了', ctx)
      if (!p.ok) throw new Error(p.reason)
      const viaCard = approve(p.board, p.board.proposals[0]!.id, { ...ctx, actor: 'user' }, 'sidebar')
      if (!viaCard.ok) throw new Error(`${g.id} 卡片同意失败：${viaCard.reason}`)
    }
    // the sample board does carry cross-goal dependencies, so some close must have dropped some
    expect(unlinked).toBeGreaterThan(0)
  })

  test('closing 账单导出 records which dependencies were dropped', async () => {
    const b = draft()
    const r = executeDirect(b, 'goal.close', { goalId: 'g-fnlfi4', reason: '完成' }, '可以关了', ctx)
    if (!r.ok) throw new Error(r.reason)
    const lines = r.events.filter(e => e.kind === 'dependency.unlink').map(e => e.summary)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(l => l.startsWith('解除依赖：') && l.includes(' 不再依赖 '))).toBe(true)
  })

  test('removing a depended-on item from the sample board works too', async () => {
    const b = draft()
    const target = b.goals.flatMap(g => g.items).find(i => b.goals.some(g => g.items.some(x => x.dependsOn.includes(i.id))))
    if (!target) throw new Error('the sample board has no depended-on item')
    const r = applyOps(b, [{ op: 'item.remove', id: target.id }], ctx)
    expect(r.ok).toBe(true)
  })

  test('dependsOn is checked where it is set, and only there', async () => {
    const b = draft()
    const some = b.goals[0]!.items[0]!
    const ghost = applyOps(b, [{ op: 'item.update', id: some.id, dependsOn: ['i-nothere'] }], ctx)
    expect(ghost.ok).toBe(false)
    expect((ghost as { reason: string }).reason).toContain('i-nothere')
    const addGhost = applyOps(b, [{ op: 'item.add', goalId: b.goals[0]!.id, title: 'x', dependsOn: ['i-nothere'] }], ctx)
    expect(addGhost.ok).toBe(false)
    // a dangling id that is already in the file blocks nothing else
    some.dependsOn = ['i-nothere']
    expect(applyOps(b, [{ op: 'note.add', title: '无关写入' }], ctx).ok).toBe(true)
  })
})

describe('snapshot (sample board)', () => {
  test('rules and decisions appear with their text, inside the budget', async () => {
    const b = draft()
    const text = buildSnapshot(b)
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    const rule = b.rules[0]!.text
    expect(text).toContain(rule.slice(0, 20))
    const live = b.decisions.filter(d => d.status === 'active')
    const shown = live.filter(d => text.includes(d.text.slice(0, 20)))
    expect(shown.length).toBeGreaterThan(5)
    // what did not fit is counted, not silently dropped
    expect(text).toMatch(new RegExp(`另有 ${live.length - shown.length} 条，用 board_get decisions 查看|生效 ${live.length} 条`))
    expect(text.indexOf('## 约定')).toBeLessThan(text.indexOf('## 目标与事项'))
    expect(text.indexOf('## 目标与事项')).toBeLessThan(text.indexOf('## 决策'))
  })
})
