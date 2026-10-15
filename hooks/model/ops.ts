import { stepShortName } from './derive'
import { collectIds, newId, type IdPrefix } from './ids'
import { checkInvariants } from './invariants'
import { normalizeLink } from './parse'
import {
  ITEM_STATUSES,
  MILESTONE_STATUSES,
  type Board,
  type Goal,
  type Item,
  type ItemStatus,
  type Link,
  type Step,
} from './types'

export type Op = { op: string; [k: string]: unknown }
export type OpCtx = { now: string; session: string; actor: 'main' | 'agent' | 'user'; rand?: () => number }
export type BoardEvent = { kind: string; id: string; summary: string }
export type ApplyResult =
  | { ok: true; board: Board; events: BoardEvent[] }
  | { ok: false; index: number; reason: string }

// ---------- 共享小工具（propose.ts 也用） ----------

export class OpError extends Error {}
export const fail = (msg: string): never => {
  throw new OpError(msg)
}
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
export const clip = (s: string, n = 40): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** 读取并校验一个对象的字段；出现未声明的字段直接报错，避免拼错的字段被静默丢弃。 */
export class Args {
  constructor(
    private readonly o: Record<string, unknown>,
    private readonly label: string,
    allowed: readonly string[],
    ignore: readonly string[] = ['op'],
  ) {
    for (const k of Object.keys(o)) {
      if (ignore.includes(k) || allowed.includes(k)) continue
      fail(`${label} 不支持字段 ${k}（可用：${allowed.join('、')}）`)
    }
  }
  private raw(k: string): unknown {
    const v = this.o[k]
    return v === null ? undefined : v
  }
  has(k: string): boolean {
    return this.raw(k) !== undefined
  }
  str(k: string): string {
    const v = this.raw(k)
    if (v === undefined) return fail(`${this.label} 缺少字段 ${k}`)
    if (typeof v !== 'string') return fail(`${this.label}.${k} 必须是字符串`)
    if (v.trim() === '') return fail(`${this.label}.${k} 不能为空`)
    return v
  }
  optStr(k: string): string | undefined {
    const v = this.raw(k)
    if (v === undefined) return undefined
    if (typeof v !== 'string') return fail(`${this.label}.${k} 必须是字符串`)
    return v
  }
  optBool(k: string): boolean | undefined {
    const v = this.raw(k)
    if (v === undefined) return undefined
    if (typeof v !== 'boolean') return fail(`${this.label}.${k} 必须是 true 或 false`)
    return v
  }
  enum<T extends string>(k: string, allowed: readonly T[]): T {
    const v = this.str(k)
    if (!(allowed as readonly string[]).includes(v)) return fail(`${this.label}.${k} 必须是 ${allowed.join(' / ')} 之一，收到 ${v}`)
    return v as T
  }
  optEnum<T extends string>(k: string, allowed: readonly T[]): T | undefined {
    return this.has(k) ? this.enum(k, allowed) : undefined
  }
  optStrArr(k: string): string[] | undefined {
    const v = this.raw(k)
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return fail(`${this.label}.${k} 必须是字符串数组`)
    return v as string[]
  }
  link(k: string): Link {
    const v = this.raw(k)
    if (v === undefined) return fail(`${this.label} 缺少字段 ${k}`)
    return toLink(v, `${this.label}.${k}`)
  }
  optLinks(k: string): Link[] | undefined {
    const v = this.raw(k)
    if (v === undefined) return undefined
    if (!Array.isArray(v)) return fail(`${this.label}.${k} 必须是数组`)
    return v.map((x, n) => toLink(x, `${this.label}.${k}[${n}]`))
  }
}

const LINK_FIELDS = ['type', 'kind', 'target', 'label', 'forReview', 'step']
function toLink(v: unknown, path: string): Link {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(`${path} 必须是对象`)
  new Args(v as Record<string, unknown>, path, LINK_FIELDS)
  try {
    return normalizeLink(v, path)
  } catch (e) {
    return fail((e as Error).message)
  }
}

// ---------- 查找 ----------

export function findGoal(board: Board, id: string): Goal | undefined {
  return board.goals.find(g => g.id === id)
}

function mustGoal(board: Board, id: string): Goal {
  const g = findGoal(board, id)
  if (g) return g
  const archived = board.archive.goals.some(x => x.id === id)
  return fail(archived ? `目标 ${id} 已关闭（在归档区），不能再改动` : `目标 ${id} 不存在`)
}

function mustItem(board: Board, id: string): { goal: Goal; item: Item; index: number } {
  for (const goal of board.goals) {
    const index = goal.items.findIndex(i => i.id === id)
    if (index >= 0) return { goal, item: goal.items[index] as Item, index }
  }
  const archived = board.archive.goals.some(g => g.items.some(i => i.id === id))
  return fail(archived ? `事项 ${id} 属于已关闭的目标（在归档区），不能再改动` : `事项 ${id} 不存在`)
}

function mustStep(board: Board, id: string): { goal: Goal; step: Step } {
  for (const goal of board.goals) {
    const step = goal.steps.find(s => s.id === id)
    if (step) return { goal, step }
  }
  const archived = board.archive.goals.some(g => g.steps.some(s => s.id === id))
  return fail(archived ? `步骤 ${id} 属于已关闭的目标（在归档区），不能再改动` : `步骤 ${id} 不存在`)
}

/** `stepId` must be '' or a step of `goal`; the error lists the goal's steps so the call can be repeated as is. */
function checkStepId(goal: Goal, stepId: string): void {
  if (stepId === '' || goal.steps.some(s => s.id === stepId)) return
  const list = goal.steps.map(s => `${s.id} ${stepShortName(s)} ${clip(s.title)}`).join('；')
  fail(`stepId ${stepId} 不是目标 ${goal.id}「${clip(goal.title)}」的步骤。${list === '' ? '该目标还没有步骤，先用 step.add 建步骤，拿到返回的 id 后再挂事项' : `该目标的步骤：${list}`}`)
}

function mustIn<T extends { id: string }>(list: T[], id: string, what: string): T {
  return list.find(x => x.id === id) ?? fail(`${what} ${id} 不存在`)
}

// ---------- 事项状态副作用 ----------

const REPORTING: readonly ItemStatus[] = ['running', 'doing', 'review']

function setStatus(it: Item, status: ItemStatus, ctx: OpCtx): void {
  const wasDone = it.status === 'done'
  const was = it.status
  it.status = status
  // running / doing stamp the latest report; review stamps only the moment it is handed in.
  if (REPORTING.includes(status) && !(status === 'review' && was === 'review')) {
    it.reportedAt = ctx.now
    it.session = ctx.session
  }
  if (status === 'done') {
    if (!wasDone) {
      it.doneAt = ctx.now
      it.doneBy = ctx.actor === 'user' ? 'user' : 'claude'
    }
  } else {
    it.doneAt = ''
    it.doneBy = ''
  }
}

// ---------- 各 op ----------

type Env = { board: Board; ctx: OpCtx; taken: Set<string>; events: BoardEvent[] }
type Handler = (op: Op, env: Env) => void

const mint = (env: Env, prefix: IdPrefix): string => {
  const id = newId(prefix, env.taken, env.ctx.rand)
  env.taken.add(id)
  return id
}
const emit = (env: Env, kind: string, id: string, summary: string): void => {
  env.events.push({ kind, id, summary })
}

const STEP_PATCH = ['title', 'label', 'note']
const ITEM_PATCH = ['title', 'status', 'owner', 'note', 'waitingFor', 'dependsOn', 'scope', 'acceptance', 'noReviewTargetReason']

/** Every item id on the board's active side. */
function liveItemIds(board: Board): Set<string> {
  const ids = new Set<string>()
  for (const g of board.goals) for (const i of g.items) ids.add(i.id)
  return ids
}

/**
 * Takes the ids in `gone` out of every active item's dependsOn, one event per item touched.
 * Call it after items leave the active side (removed, or archived with their goal).
 */
export function dropDependencies(board: Board, gone: ReadonlyMap<string, string>, ctx: OpCtx): BoardEvent[] {
  const events: BoardEvent[] = []
  if (gone.size === 0) return events
  for (const g of board.goals) {
    for (const i of g.items) {
      const hit = i.dependsOn.filter(d => gone.has(d))
      if (hit.length === 0) continue
      i.dependsOn = i.dependsOn.filter(d => !gone.has(d))
      i.updatedAt = ctx.now
      const names = hit.map(d => clip(gone.get(d) ?? d)).join('、')
      events.push({ kind: 'dependency.unlink', id: i.id, summary: `解除依赖：${clip(i.title)} 不再依赖 ${names}` })
    }
  }
  return events
}

function patchItem(it: Item, a: Args, env: Env): void {
  const ctx = env.ctx
  if (a.has('title')) it.title = a.str('title')
  const owner = a.optStr('owner')
  if (owner !== undefined) it.owner = owner
  const note = a.optStr('note')
  if (note !== undefined) it.note = note
  const waitingFor = a.optStr('waitingFor')
  if (waitingFor !== undefined) it.waitingFor = waitingFor
  const dependsOn = a.optStrArr('dependsOn')
  if (dependsOn !== undefined) {
    const live = liveItemIds(env.board)
    const ghost = dependsOn.find(d => !live.has(d))
    if (ghost !== undefined) fail(`dependsOn 里的 ${ghost} 不是活动区里的事项 id`)
    it.dependsOn = dependsOn
  }
  const scope = a.optStrArr('scope')
  if (scope !== undefined) it.scope = scope
  const acceptance = a.optStr('acceptance')
  if (acceptance !== undefined) it.acceptance = acceptance
  const reason = a.optStr('noReviewTargetReason')
  if (reason !== undefined) it.noReviewTargetReason = reason
  const status = a.optEnum('status', ITEM_STATUSES)
  if (status !== undefined) setStatus(it, status, ctx)
  it.updatedAt = ctx.now
}

const handlers: Record<string, Handler> = {
  'item.add'(op, env) {
    const a = new Args(op, 'item.add', ['goalId', 'stepId', ...ITEM_PATCH, 'links'])
    const goal = mustGoal(env.board, a.str('goalId'))
    const stepId = a.optStr('stepId') ?? ''
    checkStepId(goal, stepId)
    const it: Item = {
      id: mint(env, 'i'),
      title: '',
      stepId,
      status: 'todo',
      owner: '',
      note: '',
      waitingFor: '',
      dependsOn: [],
      scope: [],
      acceptance: '',
      links: a.optLinks('links') ?? [],
      noReviewTargetReason: '',
      reportedAt: '',
      session: '',
      doneBy: '',
      createdAt: env.ctx.now,
      updatedAt: env.ctx.now,
      doneAt: '',
    }
    a.str('title')
    patchItem(it, a, env)
    goal.items.push(it)
    emit(env, 'item.add', it.id, `新增事项：${clip(it.title)}`)
  },
  'item.update'(op, env) {
    const a = new Args(op, 'item.update', ['id', 'stepId', ...ITEM_PATCH])
    const { goal, item } = mustItem(env.board, a.str('id'))
    const stepId = a.optStr('stepId')
    if (stepId !== undefined) checkStepId(goal, stepId)
    patchItem(item, a, env)
    if (stepId !== undefined) item.stepId = stepId
    emit(env, 'item.update', item.id, `更新事项：${clip(item.title)}`)
  },
  'item.move'(op, env) {
    const a = new Args(op, 'item.move', ['id', 'goalId', 'stepId'])
    const { goal, item, index } = mustItem(env.board, a.str('id'))
    const target = mustGoal(env.board, a.str('goalId'))
    const stepId = a.optStr('stepId')
    if (stepId !== undefined) checkStepId(target, stepId)
    if (target !== goal) {
      goal.items.splice(index, 1)
      target.items.push(item)
      item.stepId = stepId ?? ''
      item.updatedAt = env.ctx.now
    } else if (stepId !== undefined) {
      item.stepId = stepId
      item.updatedAt = env.ctx.now
    }
    emit(env, 'item.move', item.id, `移动事项：${clip(item.title)} → ${clip(target.title)}`)
  },
  'item.remove'(op, env) {
    const a = new Args(op, 'item.remove', ['id'])
    const { goal, item, index } = mustItem(env.board, a.str('id'))
    goal.items.splice(index, 1)
    emit(env, 'item.remove', item.id, `删除事项：${clip(item.title)}`)
    env.events.push(...dropDependencies(env.board, new Map([[item.id, item.title]]), env.ctx))
  },
  'step.add'(op, env) {
    const a = new Args(op, 'step.add', ['goalId', ...STEP_PATCH, 'links', 'before'])
    const goal = mustGoal(env.board, a.str('goalId'))
    const st: Step = { id: mint(env, 's'), title: a.str('title'), label: a.optStr('label') ?? '', note: a.optStr('note') ?? '', links: a.optLinks('links') ?? [] }
    const before = a.optStr('before')
    if (before === undefined || before === '') goal.steps.push(st)
    else {
      const at = goal.steps.findIndex(s => s.id === before)
      if (at < 0) fail(`before ${before} 不是目标 ${goal.id} 的步骤`)
      goal.steps.splice(at, 0, st)
    }
    goal.updatedAt = env.ctx.now
    emit(env, 'step.add', st.id, `新增步骤：${clip(st.title)}（目标：${clip(goal.title)}）`)
  },
  'step.update'(op, env) {
    const a = new Args(op, 'step.update', ['id', ...STEP_PATCH])
    const { goal, step } = mustStep(env.board, a.str('id'))
    if (a.has('title')) step.title = a.str('title')
    const label = a.optStr('label')
    if (label !== undefined) step.label = label
    const note = a.optStr('note')
    if (note !== undefined) step.note = note
    goal.updatedAt = env.ctx.now
    emit(env, 'step.update', step.id, `更新步骤：${clip(step.title)}`)
  },
  'step.remove'(op, env) {
    const a = new Args(op, 'step.remove', ['id'])
    const { goal, step } = mustStep(env.board, a.str('id'))
    goal.steps = goal.steps.filter(s => s !== step)
    const moved = goal.items.filter(i => i.stepId === step.id)
    for (const i of moved) {
      i.stepId = ''
      i.updatedAt = env.ctx.now
    }
    goal.updatedAt = env.ctx.now
    emit(env, 'step.remove', step.id, `删除步骤：${clip(step.title)}${moved.length > 0 ? `（其中 ${moved.length} 个事项改为未分步骤）` : ''}`)
  },
  'step.link.add'(op, env) {
    const a = new Args(op, 'step.link.add', ['id', 'link'])
    const { goal, step } = mustStep(env.board, a.str('id'))
    step.links.push(a.link('link'))
    goal.updatedAt = env.ctx.now
    emit(env, 'step.link.add', step.id, `步骤关联新增：${clip(step.title)}`)
  },
  'step.link.remove'(op, env) {
    const a = new Args(op, 'step.link.remove', ['id', 'target'])
    const { goal, step } = mustStep(env.board, a.str('id'))
    const target = a.str('target')
    const before = step.links.length
    step.links = step.links.filter(l => l.target !== target)
    if (step.links.length === before) fail(`步骤 ${step.id} 没有 target 为 ${target} 的关联`)
    goal.updatedAt = env.ctx.now
    emit(env, 'step.link.remove', step.id, `步骤关联移除：${clip(step.title)}`)
  },
  'goal.link.add'(op, env) {
    const a = new Args(op, 'goal.link.add', ['goalId', 'link'])
    const goal = mustGoal(env.board, a.str('goalId'))
    goal.links.push(a.link('link'))
    goal.updatedAt = env.ctx.now
    emit(env, 'goal.link.add', goal.id, `目标关联新增：${clip(goal.title)}`)
  },
  'goal.link.remove'(op, env) {
    const a = new Args(op, 'goal.link.remove', ['goalId', 'target'])
    const goal = mustGoal(env.board, a.str('goalId'))
    const target = a.str('target')
    const before = goal.links.length
    goal.links = goal.links.filter(l => l.target !== target)
    if (goal.links.length === before) fail(`目标 ${goal.id} 没有 target 为 ${target} 的关联`)
    goal.updatedAt = env.ctx.now
    emit(env, 'goal.link.remove', goal.id, `目标关联移除：${clip(goal.title)}`)
  },
  'item.link.add'(op, env) {
    const a = new Args(op, 'item.link.add', ['id', 'link'])
    const { item } = mustItem(env.board, a.str('id'))
    item.links.push(a.link('link'))
    item.updatedAt = env.ctx.now
    emit(env, 'item.link.add', item.id, `事项关联新增：${clip(item.title)}`)
  },
  'item.link.remove'(op, env) {
    const a = new Args(op, 'item.link.remove', ['id', 'target'])
    const { item } = mustItem(env.board, a.str('id'))
    const target = a.str('target')
    const before = item.links.length
    item.links = item.links.filter(l => l.target !== target)
    if (item.links.length === before) fail(`事项 ${item.id} 没有 target 为 ${target} 的关联`)
    item.updatedAt = env.ctx.now
    emit(env, 'item.link.remove', item.id, `事项关联移除：${clip(item.title)}`)
  },
  'decision.add'(op, env) {
    const a = new Args(op, 'decision.add', ['text', 'kind', 'goalId', 'quote', 'supersedes'])
    const text = a.str('text')
    const kind = a.enum('kind', ['user', 'delegated'] as const)
    const goalId = a.optStr('goalId') ?? ''
    if (goalId !== '') mustGoal(env.board, goalId)
    const sup = a.optStr('supersedes')
    if (sup) {
      const old = mustIn(env.board.decisions, sup, '被替代的决策')
      if (old.status === 'superseded') fail(`决策 ${sup} 已被替代过`)
      old.status = 'superseded'
    }
    const d: Board['decisions'][number] = { id: mint(env, 'd'), date: env.ctx.now.slice(0, 10), text, kind, goalId, status: 'active' }
    const quote = a.optStr('quote')
    if (quote) d.quote = quote
    if (sup) d.supersedes = sup
    env.board.decisions.push(d)
    emit(env, 'decision.add', d.id, clip(text, 60))
  },
  'decision.update'(op, env) {
    const a = new Args(op, 'decision.update', ['id', 'text', 'quote', 'goalId', 'status'])
    const d = mustIn(env.board.decisions, a.str('id'), '决策')
    if (a.has('text')) d.text = a.str('text')
    const quote = a.optStr('quote')
    if (quote !== undefined) quote === '' ? delete d.quote : (d.quote = quote)
    const goalId = a.optStr('goalId')
    if (goalId !== undefined) {
      if (goalId !== '') mustGoal(env.board, goalId)
      d.goalId = goalId
    }
    const status = a.optEnum('status', ['active', 'superseded'] as const)
    if (status !== undefined) d.status = status
    emit(env, 'decision.update', d.id, `更新决策：${clip(d.text)}`)
  },
  'rule.add'(op, env) {
    const a = new Args(op, 'rule.add', ['text', 'group', 'fromDecision'])
    const r: Board['rules'][number] = { id: mint(env, 'r'), text: a.str('text'), group: a.optStr('group') ?? '' }
    const from = a.optStr('fromDecision')
    if (from) {
      mustDecisionAnywhere(env.board, from)
      r.fromDecision = from
    }
    env.board.rules.push(r)
    emit(env, 'rule.add', r.id, `新增约定：${clip(r.text)}`)
  },
  'rule.update'(op, env) {
    const a = new Args(op, 'rule.update', ['id', 'text', 'group', 'fromDecision'])
    const r = mustIn(env.board.rules, a.str('id'), '约定')
    if (a.has('text')) r.text = a.str('text')
    const group = a.optStr('group')
    if (group !== undefined) r.group = group
    const from = a.optStr('fromDecision')
    if (from !== undefined) {
      if (from === '') delete r.fromDecision
      else {
        mustDecisionAnywhere(env.board, from)
        r.fromDecision = from
      }
    }
    emit(env, 'rule.update', r.id, `更新约定：${clip(r.text)}`)
  },
  'rule.remove'(op, env) {
    const a = new Args(op, 'rule.remove', ['id'])
    const r = mustIn(env.board.rules, a.str('id'), '约定')
    env.board.rules = env.board.rules.filter(x => x !== r)
    emit(env, 'rule.remove', r.id, `删除约定：${clip(r.text)}`)
  },
  'note.add'(op, env) {
    const a = new Args(op, 'note.add', ['title', 'text', 'group'])
    const n: Board['notes'][number] = { id: mint(env, 'n'), title: a.str('title'), text: a.optStr('text') ?? '', group: a.optStr('group') ?? '' }
    env.board.notes.push(n)
    emit(env, 'note.add', n.id, `新增资料：${clip(n.title)}`)
  },
  'note.update'(op, env) {
    const a = new Args(op, 'note.update', ['id', 'title', 'text', 'group'])
    const n = mustIn(env.board.notes, a.str('id'), '资料')
    if (a.has('title')) n.title = a.str('title')
    const text = a.optStr('text')
    if (text !== undefined) n.text = text
    const group = a.optStr('group')
    if (group !== undefined) n.group = group
    emit(env, 'note.update', n.id, `更新资料：${clip(n.title)}`)
  },
  'note.remove'(op, env) {
    const a = new Args(op, 'note.remove', ['id'])
    const n = mustIn(env.board.notes, a.str('id'), '资料')
    env.board.notes = env.board.notes.filter(x => x !== n)
    emit(env, 'note.remove', n.id, `删除资料：${clip(n.title)}`)
  },
  'milestone.add'(op, env) {
    const a = new Args(op, 'milestone.add', ['title', 'status', 'note'])
    const m: Board['milestones']['items'][number] = {
      id: mint(env, 'm'),
      title: a.str('title'),
      status: a.optEnum('status', MILESTONE_STATUSES) ?? '未开始',
      note: a.optStr('note') ?? '',
      gates: [],
    }
    env.board.milestones.items.push(m)
    emit(env, 'milestone.add', m.id, `新增里程碑：${clip(m.title)}`)
  },
  'milestone.update'(op, env) {
    const a = new Args(op, 'milestone.update', ['id', 'title', 'status', 'note'])
    const m = mustIn(env.board.milestones.items, a.str('id'), '里程碑')
    if (a.has('title')) m.title = a.str('title')
    const status = a.optEnum('status', MILESTONE_STATUSES)
    if (status !== undefined) m.status = status
    const note = a.optStr('note')
    if (note !== undefined) m.note = note
    emit(env, 'milestone.update', m.id, `更新里程碑：${clip(m.title)}`)
  },
  'milestone.remove'(op, env) {
    const a = new Args(op, 'milestone.remove', ['id'])
    const m = mustIn(env.board.milestones.items, a.str('id'), '里程碑')
    env.board.milestones.items = env.board.milestones.items.filter(x => x !== m)
    emit(env, 'milestone.remove', m.id, `删除里程碑：${clip(m.title)}`)
  },
  'milestone.gate'(op, env) {
    const a = new Args(op, 'milestone.gate', ['id', 'name', 'result', 'date', 'points'])
    const m = mustIn(env.board.milestones.items, a.str('id'), '里程碑')
    m.gates.push({ date: a.optStr('date') ?? env.ctx.now.slice(0, 10), name: a.str('name'), result: a.str('result'), points: a.optStr('points') ?? '' })
    emit(env, 'milestone.gate', m.id, `关卡记录：${clip(a.str('name'))}`)
  },
  'milestones.enable'(op, env) {
    const a = new Args(op, 'milestones.enable', ['enabled'])
    env.board.milestones.enabled = a.optBool('enabled') ?? true
    emit(env, 'milestones.enable', 'milestones', env.board.milestones.enabled ? '启用里程碑' : '关闭里程碑')
  },
}

function mustDecisionAnywhere(board: Board, id: string): void {
  if (![...board.decisions, ...board.archive.decisions].some(d => d.id === id)) fail(`决策 ${id} 不存在`)
}

export const OP_NAMES: readonly string[] = Object.keys(handlers)

// ---------- 入口 ----------

/** 校验最终状态；失败时序号指向这一批的最后一条操作。 */
export function finish(board: Board, events: BoardEvent[], lastIndex: number): ApplyResult {
  const bad = checkInvariants(board)
  if (bad) return { ok: false, index: lastIndex, reason: `批量结果不满足规则：${bad}` }
  return { ok: true, board, events }
}

export function applyOps(board: Board, ops: Op[], ctx: OpCtx): ApplyResult {
  if (!Array.isArray(ops)) return { ok: false, index: 0, reason: 'ops 必须是数组' }
  const work = clone(board)
  const env: Env = { board: work, ctx, taken: collectIds(work), events: [] }
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    try {
      if (typeof op !== 'object' || op === null || Array.isArray(op)) fail('操作必须是对象')
      const name = (op as Op).op
      if (typeof name !== 'string' || name === '') fail('操作缺少 op 字段')
      const h = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined
      if (!h) fail(`未知操作：${String(name)}（可用：${OP_NAMES.join('、')}）`)
      ;(h as Handler)(op as Op, env)
    } catch (e) {
      if (e instanceof OpError) return { ok: false, index, reason: e.message }
      throw e
    }
  }
  if (ops.length === 0) return { ok: true, board: work, events: [] }
  const done = finish(work, env.events, ops.length - 1)
  if (done.ok) done.events.push(...reviewHints(board, work))
  return done
}

/** Hints for review entry points, from comparing the board before and after one batch. */
function reviewHints(before: Board, after: Board): BoardEvent[] {
  const old = new Map<string, Item>()
  for (const g of before.goals) for (const i of g.items) old.set(i.id, i)
  const out: BoardEvent[] = []
  for (const g of after.goals) {
    for (const i of g.items) {
      const prev = old.get(i.id)
      const entries = i.links.filter(l => l.forReview)
      if (i.status === 'review' && prev?.status !== 'review' && entries.length === 0) {
        out.push({ kind: 'hint', id: i.id, summary: `事项「${clip(i.title)}」没有验收入口，用户无法从看板打开它` })
      }
      const was = (prev?.links.filter(l => l.forReview) ?? []).filter(w => entries.some(l => l.target === w.target))
      if (was.length > 0 && entries.some(l => !was.some(w => w.target === l.target))) {
        out.push({ kind: 'hint', id: i.id, summary: `事项「${clip(i.title)}」已有入口：${was.map(l => l.target).join('、')}；不再需要的用 item.link.remove 移除` })
      }
    }
  }
  return out
}
