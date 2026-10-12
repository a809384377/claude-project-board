import { collectIds, newId } from './ids'
import { Args, clip, clone, dropDependencies, fail, finish, findGoal, OpError, type ApplyResult, type BoardEvent, type OpCtx } from './ops'
import { PROPOSAL_ACTIONS, type Board, type Goal, type Link, type Proposal, type ProposalAction, type Step } from './types'

export type Confirmed = 'conversation' | 'sidebar'

const MAIN_ONLY = '目标与关注的变更由主会话处理'

function guard<T>(fn: () => T): T | { ok: false; index: number; reason: string } {
  try {
    return fn()
  } catch (e) {
    if (e instanceof OpError) return { ok: false, index: 0, reason: e.message }
    throw e
  }
}

const must = (board: Board, id: string): Goal => {
  const g = findGoal(board, id)
  if (g) return g
  return fail(board.archive.goals.some(x => x.id === id) ? `目标 ${id} 已关闭` : `目标 ${id} 不存在`)
}

/** A proposal refers to a goal when its payload names it in `goalId` or `goalIds`. */
export function refersTo(p: Proposal, goalId: string): boolean {
  const ids = p.payload.goalIds
  return p.payload.goalId === goalId || (Array.isArray(ids) && ids.includes(goalId))
}

/** 校验并规范化提议的参数，只留下认识的字段。 */
function normalizePayload(board: Board, action: ProposalAction, payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return fail('payload 必须是对象')
  const o = payload as Record<string, unknown>
  switch (action) {
    case 'goal.create': {
      const a = new Args(o, action, ['title', 'outcome', 'links'], [])
      const out: Record<string, unknown> = { title: a.str('title'), outcome: a.optStr('outcome') ?? '' }
      const links = a.optLinks('links')
      if (links) out.links = links
      return out
    }
    case 'goal.update': {
      const a = new Args(o, action, ['goalId', 'title', 'outcome'], [])
      const out: Record<string, unknown> = { goalId: must(board, a.str('goalId')).id }
      if (a.has('title')) out.title = a.str('title')
      const outcome = a.optStr('outcome')
      if (outcome !== undefined) out.outcome = outcome
      if (!('title' in out) && !('outcome' in out)) fail('goal.update 至少要改 title 或 outcome')
      return out
    }
    case 'goal.close': {
      const a = new Args(o, action, ['goalId', 'reason'], [])
      return { goalId: must(board, a.str('goalId')).id, reason: a.enum('reason', ['完成', '放弃'] as const) }
    }
    case 'goal.merge': {
      const a = new Args(o, action, ['title', 'goalIds', 'outcome'], [])
      const title = a.str('title')
      const goalIds = a.optStrArr('goalIds')
      if (goalIds === undefined) return fail('goal.merge 缺少字段 goalIds')
      if (goalIds.length < 2) fail('goal.merge 至少要合并 2 个目标')
      if (new Set(goalIds).size !== goalIds.length) fail('goal.merge 的 goalIds 不能重复')
      for (const id of goalIds) must(board, id)
      return { title, goalIds, outcome: a.optStr('outcome') ?? '' }
    }
    case 'goal.pause':
    case 'goal.resume': {
      const a = new Args(o, action, ['goalId'], [])
      return { goalId: must(board, a.str('goalId')).id }
    }
    case 'focus.set': {
      const a = new Args(o, action, ['text', 'goalId', 'mandate'], [])
      const goalId = a.optStr('goalId') ?? ''
      if (goalId !== '') must(board, goalId)
      return { text: a.str('text'), goalId, mandate: a.optStr('mandate') ?? '' }
    }
  }
}

function checkAction(action: unknown): ProposalAction {
  if (typeof action !== 'string' || !(PROPOSAL_ACTIONS as readonly string[]).includes(action)) {
    return fail(`未知提议类型：${String(action)}（可用：${PROPOSAL_ACTIONS.join('、')}）`)
  }
  return action as ProposalAction
}

const withQuote = (q: string | undefined): string => (q ? `用户原话：${q}` : '')

/**
 * Turns several active goals into the steps of one new goal (see the design, section 3.2). The new goal
 * takes the place of the first old one; the old goals do not go to the archive, everything they held is in the new goal.
 */
function mergeGoals(
  board: Board,
  p: { title: string; goalIds: string[]; outcome: string },
  ctx: OpCtx,
  confirmedBy: Confirmed,
  quote: string,
): BoardEvent[] {
  const olds = p.goalIds.map(id => must(board, id))
  const taken = collectIds(board)
  const g: Goal = {
    id: newId('g', taken, ctx.rand),
    title: p.title,
    outcome: p.outcome,
    status: 'active',
    links: [],
    steps: [],
    items: [],
    confirmedBy,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }
  taken.add(g.id)
  if (confirmedBy === 'conversation' && quote) g.quote = quote
  const made: string[] = []
  for (const old of olds) {
    if (old.steps.length === 0) {
      const st: Step = {
        id: newId('s', taken, ctx.rand),
        title: old.title,
        label: '',
        note: [old.outcome, withQuote(old.quote)].filter(x => x !== '').join('\n'),
        links: clone(old.links),
      }
      taken.add(st.id)
      made.push(st.id)
      g.steps.push(st)
      for (const i of old.items) i.stepId = st.id
    } else {
      const first = old.steps[0] as Step
      first.note = [first.note, `旧目标「${old.title}」${old.outcome !== '' ? `：${old.outcome}` : ''}`, withQuote(old.quote)].filter(x => x !== '').join('\n')
      g.steps.push(...old.steps)
      for (const l of old.links) if (!g.links.some(x => x.target === l.target)) g.links.push(l)
    }
    g.items.push(...old.items)
  }
  const at = board.goals.slice(0, board.goals.indexOf(olds[0] as Goal)).filter(x => !olds.includes(x)).length
  board.goals = board.goals.filter(x => !olds.includes(x))
  board.goals.splice(at, 0, g)
  for (const d of board.decisions) if (p.goalIds.includes(d.goalId)) d.goalId = g.id
  if (p.goalIds.includes(board.focus.goalId)) {
    board.focus.goalId = g.id
    board.focus.updatedAt = ctx.now
  }
  board.proposals = board.proposals.filter(x => !p.goalIds.some(id => refersTo(x, id)))
  return [{ kind: 'goal.merge', id: g.id, summary: `合并 ${olds.length} 个目标为：${clip(g.title)}${made.length > 0 ? `（新步骤：${made.join('、')}）` : ''}` }]
}

/** 按当前状态执行一项目标 / 关注变更，原地修改 board。 */
function execute(
  board: Board,
  action: ProposalAction,
  payload: Record<string, unknown>,
  ctx: OpCtx,
  confirmedBy: Confirmed,
  quote: string,
): BoardEvent[] {
  const p = normalizePayload(board, action, payload) as Record<string, string | Link[] | undefined> & { goalId?: string }
  switch (action) {
    case 'goal.create': {
      const g: Goal = {
        id: newId('g', collectIds(board), ctx.rand),
        title: p.title as string,
        outcome: p.outcome as string,
        status: 'active',
        links: (p.links as Link[] | undefined) ?? [],
        steps: [],
        items: [],
        confirmedBy,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      }
      if (confirmedBy === 'conversation' && quote) g.quote = quote
      board.goals.push(g)
      return [{ kind: action, id: g.id, summary: `新建目标：${clip(g.title)}` }]
    }
    case 'goal.update': {
      const g = must(board, p.goalId as string)
      if (typeof p.title === 'string') g.title = p.title
      if (typeof p.outcome === 'string') g.outcome = p.outcome
      g.updatedAt = ctx.now
      return [{ kind: action, id: g.id, summary: `修改目标：${clip(g.title)}` }]
    }
    case 'goal.merge':
      return mergeGoals(board, p as unknown as { title: string; goalIds: string[]; outcome: string }, ctx, confirmedBy, quote)
    case 'goal.pause':
    case 'goal.resume': {
      const g = must(board, p.goalId as string)
      const want = action === 'goal.pause' ? 'paused' : 'active'
      if (g.status === want) fail(`目标 ${g.id} 已经是${want === 'paused' ? '暂停' : '进行中'}状态`)
      g.status = want
      g.updatedAt = ctx.now
      return [{ kind: action, id: g.id, summary: `${want === 'paused' ? '暂停' : '恢复'}目标：${clip(g.title)}` }]
    }
    case 'goal.close': {
      const g = must(board, p.goalId as string)
      board.goals = board.goals.filter(x => x !== g)
      g.closedAt = ctx.now
      g.closeReason = p.reason as '完成' | '放弃'
      g.updatedAt = ctx.now
      board.archive.goals.push(g)
      const moved = board.decisions.filter(d => d.goalId === g.id)
      board.decisions = board.decisions.filter(d => d.goalId !== g.id)
      board.archive.decisions.push(...moved)
      if (board.focus.goalId === g.id) {
        board.focus.goalId = ''
        board.focus.updatedAt = ctx.now
      }
      board.proposals = board.proposals.filter(x => !refersTo(x, g.id))
      const gone = new Map(g.items.map(i => [i.id, i.title] as const))
      return [
        { kind: action, id: g.id, summary: `关闭目标（${g.closeReason}）：${clip(g.title)}` },
        ...dropDependencies(board, gone, ctx),
      ]
    }
    case 'focus.set': {
      board.focus = { text: p.text as string, goalId: p.goalId as string, mandate: p.mandate as string, updatedAt: ctx.now }
      return [{ kind: action, id: 'focus', summary: `设置关注：${clip(p.text as string)}` }]
    }
  }
}

/** 登记一条待确认提议；参数按当前状态预校验。 */
export function propose(board: Board, action: string, payload: unknown, reason: string, ctx: OpCtx): ApplyResult {
  return guard(() => {
    const act = checkAction(action)
    const work = clone(board)
    const norm = normalizePayload(work, act, payload)
    const p: Proposal = { id: newId('p', collectIds(work), ctx.rand), action: act, payload: norm, reason: reason ?? '', createdAt: ctx.now }
    work.proposals.push(p)
    return finish(work, [{ kind: 'proposal.add', id: p.id, summary: `提议：${act}` }], 0)
  })
}

/** 执行已有提议（卡片「同意」或对话里确认），执行后提议被删除；失败时提议保留。 */
export function approve(board: Board, proposalId: string, ctx: OpCtx, confirmedBy: Confirmed, quote = ''): ApplyResult {
  return guard(() => {
    if (ctx.actor === 'agent') fail(MAIN_ONLY)
    const work = clone(board)
    const p = work.proposals.find(x => x.id === proposalId)
    if (!p) return fail(`提议 ${proposalId} 不存在或已处理`)
    work.proposals = work.proposals.filter(x => x !== p)
    const evs = execute(work, p.action, p.payload, ctx, confirmedBy, quote)
    return finish(work, evs, 0)
  })
}

/** 删除提议（卡片「不要」）。 */
export function reject(board: Board, proposalId: string): ApplyResult {
  return guard(() => {
    if (!board.proposals.some(x => x.id === proposalId)) return fail(`提议 ${proposalId} 不存在或已处理`)
    const work = clone(board)
    work.proposals = work.proposals.filter(x => x.id !== proposalId)
    return finish(work, [{ kind: 'proposal.reject', id: proposalId, summary: '拒绝提议' }], 0)
  })
}

/** 用户在对话里已明确同意：带原话直接执行，不经提议。 */
export function executeDirect(board: Board, action: string, payload: unknown, quote: string, ctx: OpCtx): ApplyResult {
  return guard(() => {
    if (ctx.actor === 'agent') fail(MAIN_ONLY)
    const act = checkAction(action)
    if (typeof quote !== 'string' || quote.trim() === '') fail('直接执行需要附上用户原话（quote）')
    const work = clone(board)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) fail('payload 必须是对象')
    const evs = execute(work, act, payload as Record<string, unknown>, ctx, 'conversation', quote)
    return finish(work, evs, 0)
  })
}
