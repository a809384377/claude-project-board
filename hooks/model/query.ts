import { isOpen, progressOf, statusCounts } from './derive'
import type { Board, Goal, Item } from './types'

export class QueryError extends Error {}
const fail = (msg: string): never => {
  throw new QueryError(msg)
}

export const SCOPES = ['summary', 'goal', 'item', 'decisions', 'rules', 'notes', 'archive', 'search'] as const
export type Scope = (typeof SCOPES)[number]

export type QueryArgs = {
  id?: string
  goalId?: string
  group?: string
  keyword?: string
  includeSuperseded?: boolean
}

/** archive and search return at most this many entries per list. */
export const RESULT_LIMIT = 50

/** The first RESULT_LIMIT entries, and a line saying so when there were more. */
function capped<T>(list: T[]): { total: number; shown: T[]; note?: string } {
  if (list.length <= RESULT_LIMIT) return { total: list.length, shown: list }
  return { total: list.length, shown: list.slice(0, RESULT_LIMIT), note: `共 ${list.length} 条，已显示前 ${RESULT_LIMIT} 条，请缩小关键词` }
}

function hit(text: string, kw: string): boolean {
  return text.toLowerCase().includes(kw.toLowerCase())
}

function needStr(v: unknown, name: string, scope: string): string {
  if (typeof v !== 'string' || v.trim() === '') return fail(`scope=${scope} 需要参数 ${name}`)
  return v
}

function findItem(board: Board, id: string): { goal: Goal; item: Item; archived: boolean } | null {
  for (const g of board.goals) {
    const item = g.items.find(i => i.id === id)
    if (item) return { goal: g, item, archived: false }
  }
  for (const g of board.archive.goals) {
    const item = g.items.find(i => i.id === id)
    if (item) return { goal: g, item, archived: true }
  }
  return null
}

function stepsView(g: Goal): unknown[] {
  return g.steps.map(s => {
    const { done, total, running, review } = progressOf(g.items.filter(i => i.stepId === s.id))
    return { id: s.id, title: s.title, label: s.label, links: s.links, done, total, running, review }
  })
}

function search(board: Board, kw: string): unknown {
  const hits: Array<{ kind: string; id: string; text: string; where?: string }> = []
  const goals = [
    ...board.goals.map(g => ({ g, where: '活动' })),
    ...board.archive.goals.map(g => ({ g, where: '归档' })),
  ]
  for (const { g, where } of goals) {
    if (hit(`${g.title}\n${g.outcome}`, kw)) hits.push({ kind: 'goal', id: g.id, text: g.title, where })
    for (const s of g.steps) if (hit(`${s.title}\n${s.label}\n${s.note}`, kw)) hits.push({ kind: 'step', id: s.id, text: s.title, where: `${where} · 目标 ${g.id}` })
    for (const i of g.items) {
      if (hit(`${i.title}\n${i.note}\n${i.acceptance}\n${i.waitingFor}`, kw)) hits.push({ kind: 'item', id: i.id, text: i.title, where })
    }
  }
  for (const d of board.decisions) if (hit(`${d.text}\n${d.quote ?? ''}`, kw)) hits.push({ kind: 'decision', id: d.id, text: d.text, where: '活动' })
  for (const d of board.archive.decisions) if (hit(`${d.text}\n${d.quote ?? ''}`, kw)) hits.push({ kind: 'decision', id: d.id, text: d.text, where: '归档' })
  for (const r of board.rules) if (hit(`${r.text}\n${r.group}`, kw)) hits.push({ kind: 'rule', id: r.id, text: r.text })
  for (const n of board.notes) if (hit(`${n.title}\n${n.text}\n${n.group}`, kw)) hits.push({ kind: 'note', id: n.id, text: n.title })
  const c = capped(hits)
  return { keyword: kw, total: c.total, hits: c.shown, ...(c.note ? { note: c.note } : {}) }
}

/** board_get 的各 scope。参数缺失或 id 不存在时抛 QueryError。 */
export function query(board: Board, scope: string, args: QueryArgs = {}): unknown {
  switch (scope) {
    case 'summary':
      return {
        project: board.project,
        rev: board.rev,
        focus: board.focus,
        milestones: board.milestones.enabled
          ? board.milestones.items.map(m => ({ id: m.id, title: m.title, status: m.status, gates: m.gates.length }))
          : null,
        goals: board.goals.map(g => ({
          id: g.id,
          title: g.title,
          status: g.status,
          outcome: g.outcome,
          counts: statusCounts(g.items),
          steps: stepsView(g),
          openItems: g.items.filter(isOpen).map(i => ({ id: i.id, title: i.title, status: i.status, owner: i.owner, stepId: i.stepId })),
        })),
        proposals: board.proposals,
        totals: {
          decisions: board.decisions.filter(d => d.status === 'active').length,
          rules: board.rules.length,
          notes: board.notes.length,
          archivedGoals: board.archive.goals.length,
          archivedDecisions: board.archive.decisions.length,
        },
      }
    case 'goal': {
      const id = needStr(args.id, 'id', scope)
      const g = board.goals.find(x => x.id === id) ?? board.archive.goals.find(x => x.id === id)
      if (!g) return fail(`目标 ${id} 不存在`)
      return { archived: !board.goals.includes(g), goal: g }
    }
    case 'item': {
      const id = needStr(args.id, 'id', scope)
      const f = findItem(board, id)
      if (!f) return fail(`事项 ${id} 不存在`)
      const step = f.goal.steps.find(s => s.id === f.item.stepId)
      return { archived: f.archived, goal: { id: f.goal.id, title: f.goal.title }, step: step ? { id: step.id, title: step.title } : null, item: f.item }
    }
    case 'decisions': {
      if (args.goalId !== undefined && args.goalId !== '' && !board.goals.some(g => g.id === args.goalId)) {
        return fail(`目标 ${args.goalId} 不在活动区；已关闭目标的决策用 scope=archive 查`)
      }
      const list = board.decisions.filter(
        d => (args.goalId === undefined || d.goalId === args.goalId) && (args.includeSuperseded === true || d.status === 'active'),
      )
      return { total: list.length, decisions: list }
    }
    case 'rules': {
      const list = board.rules.filter(r => args.group === undefined || r.group === args.group)
      return { total: list.length, rules: list }
    }
    case 'notes': {
      if (args.id !== undefined) {
        const n = board.notes.find(x => x.id === args.id)
        if (!n) return fail(`资料 ${args.id} 不存在`)
        return { note: n }
      }
      const list = board.notes.filter(n => args.group === undefined || n.group === args.group)
      return { total: list.length, notes: list }
    }
    case 'archive': {
      const kw = typeof args.keyword === 'string' && args.keyword.trim() !== '' ? args.keyword : undefined
      const goals = board.archive.goals.filter(
        g => kw === undefined || hit(`${g.title}\n${g.outcome}\n${g.steps.map(s => s.title).join('\n')}\n${g.items.map(i => i.title).join('\n')}`, kw),
      )
      const decisions = board.archive.decisions.filter(d => kw === undefined || hit(`${d.text}\n${d.quote ?? ''}`, kw))
      const cg = capped(goals)
      const cd = capped(decisions)
      return {
        goals: cg.shown.map(g => ({
          id: g.id,
          title: g.title,
          outcome: g.outcome,
          closedAt: g.closedAt ?? '',
          closeReason: g.closeReason ?? '',
          steps: g.steps.map(s => ({ id: s.id, title: s.title })),
          items: g.items.map(i => ({ id: i.id, title: i.title, status: i.status })),
        })),
        decisions: cd.shown,
        ...(cg.note || cd.note ? { goalsTotal: cg.total, decisionsTotal: cd.total, note: [cg.note && `目标：${cg.note}`, cd.note && `决策：${cd.note}`].filter(Boolean).join('；') } : {}),
      }
    }
    case 'search':
      return search(board, needStr(args.keyword, 'keyword', scope))
    default:
      return fail(`未知 scope：${String(scope)}（可用：${SCOPES.join('、')}）`)
  }
}
