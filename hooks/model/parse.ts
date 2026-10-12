import {
  ITEM_STATUSES,
  LINK_TYPES,
  MILESTONE_STATUSES,
  PROPOSAL_ACTIONS,
  type Board,
  type Decision,
  type Gate,
  type Goal,
  type Item,
  type Link,
  type Milestone,
  type Note,
  type Proposal,
  type Rule,
  type Step,
} from './types'

export type ParseResult = { ok: true; board: Board } | { ok: false; error: string; line?: number }

/** Highest schema this code reads. */
export const MAX_SCHEMA = 2
/** Said when the file was written by a newer plugin; it replaces the "restore from git" advice. */
export const NEWER_SCHEMA_TEXT = '看板由更新版本的插件写入；请更新插件或重启会话，不要覆盖它或从 git 恢复'

export function emptyBoard(name: string): Board {
  return {
    schema: 1,
    rev: 0,
    project: { name },
    focus: { text: '', goalId: '', mandate: '', updatedAt: '' },
    milestones: { enabled: false, items: [] },
    goals: [],
    decisions: [],
    rules: [],
    notes: [],
    proposals: [],
    archive: { goals: [], decisions: [] },
  }
}

// ---------- JSON 出错位置（引擎的 JSON.parse 报错文字不带统一的行号，自己定位） ----------

class Bad extends Error {
  constructor(readonly pos: number) {
    super('bad json')
  }
}

function locateJsonError(text: string): number | null {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i++
  }
  const lit = (w: string) => {
    if (text.slice(i, i + w.length) !== w) throw new Bad(i)
    i += w.length
  }
  const str = () => {
    i++
    for (;;) {
      if (i >= text.length) throw new Bad(i)
      const c = text.charCodeAt(i)
      if (c === 34) {
        i++
        return
      }
      if (c < 0x20) throw new Bad(i)
      if (c === 92) {
        const e = text[i + 1]
        if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2
        else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 6
        else throw new Bad(i + 1)
      } else i++
    }
  }
  const value = (): void => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') return void i++
      for (;;) {
        ws()
        if (text[i] !== '"') throw new Bad(i)
        str()
        ws()
        if (text[i] !== ':') throw new Bad(i)
        i++
        value()
        ws()
        if (text[i] === ',') i++
        else if (text[i] === '}') return void i++
        else throw new Bad(i)
      }
    } else if (c === '[') {
      i++
      ws()
      if (text[i] === ']') return void i++
      for (;;) {
        value()
        ws()
        if (text[i] === ',') i++
        else if (text[i] === ']') return void i++
        else throw new Bad(i)
      }
    } else if (c === '"') str()
    else if (c === 't') lit('true')
    else if (c === 'f') lit('false')
    else if (c === 'n') lit('null')
    else {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
      if (!m) throw new Bad(i)
      i += m[0].length
    }
  }
  try {
    value()
    ws()
    if (i < text.length) throw new Bad(i)
  } catch (e) {
    if (e instanceof Bad) return e.pos
    throw e
  }
  return null
}

// ---------- 字段读取 ----------

class Fail extends Error {}
type Obj = Record<string, unknown>

const sub = (p: string, k: string | number): string =>
  typeof k === 'number' ? `${p}[${k}]` : p === '' ? k : `${p}.${k}`

function obj(v: unknown, path: string): Obj {
  if (v === undefined) throw new Fail(`缺少字段 ${path}`)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Fail(`${path} 必须是对象`)
  return v as Obj
}

function arr<T>(v: unknown, path: string, each: (x: unknown, p: string) => T): T[] {
  if (v === undefined) throw new Fail(`缺少字段 ${path}`)
  if (!Array.isArray(v)) throw new Fail(`${path} 必须是数组`)
  return v.map((x, n) => each(x, sub(path, n)))
}

function optArr<T>(v: unknown, path: string, each: (x: unknown, p: string) => T): T[] {
  return v === undefined || v === null ? [] : arr(v, path, each)
}

function reqStr(o: Obj, k: string, path: string): string {
  const v = o[k]
  const p = sub(path, k)
  if (v === undefined || v === null) throw new Fail(`缺少字段 ${p}`)
  if (typeof v !== 'string') throw new Fail(`${p} 必须是字符串`)
  if (v === '') throw new Fail(`${p} 不能为空`)
  return v
}

function optStr(o: Obj, k: string, path: string): string {
  const v = o[k]
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new Fail(`${sub(path, k)} 必须是字符串`)
  return v
}

function optStrOrUndef(o: Obj, k: string, path: string): string | undefined {
  const v = optStr(o, k, path)
  return v === '' ? undefined : v
}

function reqEnum<T extends string>(o: Obj, k: string, path: string, allowed: readonly T[]): T {
  const v = reqStr(o, k, path)
  if (!(allowed as readonly string[]).includes(v)) throw new Fail(`${sub(path, k)} 必须是 ${allowed.join(' / ')} 之一，收到 ${v}`)
  return v as T
}

function optEnum<T extends string>(o: Obj, k: string, path: string, allowed: readonly T[], def: T | ''): T | '' {
  const v = o[k]
  if (v === undefined || v === null || v === '') return def
  return reqEnum(o, k, path, allowed)
}

function strList(v: unknown, path: string): string[] {
  return optArr(v, path, (x, p) => {
    if (typeof x !== 'string') throw new Fail(`${p} 必须是字符串`)
    return x
  })
}

// ---------- 各类型 ----------

export function normalizeLink(x: unknown, p: string): Link {
  const o = obj(x, p)
  const link: Link = {
    type: reqEnum(o, 'type', p, LINK_TYPES),
    kind: optStr(o, 'kind', p),
    target: reqStr(o, 'target', p),
    label: optStr(o, 'label', p),
    forReview: o.forReview === undefined || o.forReview === null ? false : bool(o, 'forReview', p),
  }
  if (o.step !== undefined && o.step !== null) {
    if (typeof o.step !== 'number' || !Number.isFinite(o.step)) throw new Fail(`${sub(p, 'step')} 必须是数字`)
    link.step = o.step
  }
  return link
}

function bool(o: Obj, k: string, path: string): boolean {
  if (typeof o[k] !== 'boolean') throw new Fail(`${sub(path, k)} 必须是 true 或 false`)
  return o[k] as boolean
}

function step(x: unknown, p: string): Step {
  const o = obj(x, p)
  return {
    id: reqStr(o, 'id', p),
    title: reqStr(o, 'title', p),
    label: optStr(o, 'label', p),
    note: optStr(o, 'note', p),
    links: optArr(o.links, sub(p, 'links'), normalizeLink),
  }
}

function item(x: unknown, p: string): Item {
  const o = obj(x, p)
  return {
    id: reqStr(o, 'id', p),
    title: reqStr(o, 'title', p),
    stepId: optStr(o, 'stepId', p),
    status: reqEnum(o, 'status', p, ITEM_STATUSES),
    owner: optStr(o, 'owner', p),
    note: optStr(o, 'note', p),
    waitingFor: optStr(o, 'waitingFor', p),
    dependsOn: strList(o.dependsOn, sub(p, 'dependsOn')),
    scope: strList(o.scope, sub(p, 'scope')),
    acceptance: optStr(o, 'acceptance', p),
    links: optArr(o.links, sub(p, 'links'), normalizeLink),
    noReviewTargetReason: optStr(o, 'noReviewTargetReason', p),
    reportedAt: optStr(o, 'reportedAt', p),
    session: optStr(o, 'session', p),
    doneBy: optEnum(o, 'doneBy', p, ['user', 'claude'] as const, ''),
    createdAt: optStr(o, 'createdAt', p),
    updatedAt: optStr(o, 'updatedAt', p),
    doneAt: optStr(o, 'doneAt', p),
  }
}

function goal(x: unknown, p: string, archived: boolean): Goal {
  const o = obj(x, p)
  const g: Goal = {
    id: reqStr(o, 'id', p),
    title: reqStr(o, 'title', p),
    outcome: optStr(o, 'outcome', p),
    status: reqEnum(o, 'status', p, ['active', 'paused'] as const),
    links: optArr(o.links, sub(p, 'links'), normalizeLink),
    steps: optArr(o.steps, sub(p, 'steps'), step),
    items: arr(o.items, sub(p, 'items'), item),
    createdAt: optStr(o, 'createdAt', p),
    updatedAt: optStr(o, 'updatedAt', p),
  }
  const cb = optEnum(o, 'confirmedBy', p, ['conversation', 'sidebar'] as const, '')
  if (cb !== '') g.confirmedBy = cb
  const quote = optStrOrUndef(o, 'quote', p)
  if (quote !== undefined) g.quote = quote
  if (archived) {
    g.closedAt = reqStr(o, 'closedAt', p)
    g.closeReason = reqEnum(o, 'closeReason', p, ['完成', '放弃'] as const)
  }
  return g
}

function decision(x: unknown, p: string): Decision {
  const o = obj(x, p)
  const d: Decision = {
    id: reqStr(o, 'id', p),
    date: optStr(o, 'date', p),
    text: reqStr(o, 'text', p),
    kind: reqEnum(o, 'kind', p, ['user', 'delegated'] as const),
    goalId: optStr(o, 'goalId', p),
    status: reqEnum(o, 'status', p, ['active', 'superseded'] as const),
  }
  const quote = optStrOrUndef(o, 'quote', p)
  if (quote !== undefined) d.quote = quote
  const sup = optStrOrUndef(o, 'supersedes', p)
  if (sup !== undefined) d.supersedes = sup
  return d
}

function rule(x: unknown, p: string): Rule {
  const o = obj(x, p)
  const r: Rule = { id: reqStr(o, 'id', p), text: reqStr(o, 'text', p), group: optStr(o, 'group', p) }
  const f = optStrOrUndef(o, 'fromDecision', p)
  if (f !== undefined) r.fromDecision = f
  return r
}

function note(x: unknown, p: string): Note {
  const o = obj(x, p)
  return { id: reqStr(o, 'id', p), title: reqStr(o, 'title', p), text: optStr(o, 'text', p), group: optStr(o, 'group', p) }
}

function gate(x: unknown, p: string): Gate {
  const o = obj(x, p)
  return { date: optStr(o, 'date', p), name: reqStr(o, 'name', p), result: optStr(o, 'result', p), points: optStr(o, 'points', p) }
}

function milestone(x: unknown, p: string): Milestone {
  const o = obj(x, p)
  return {
    id: reqStr(o, 'id', p),
    title: reqStr(o, 'title', p),
    status: reqEnum(o, 'status', p, MILESTONE_STATUSES),
    note: optStr(o, 'note', p),
    gates: optArr(o.gates, sub(p, 'gates'), gate),
  }
}

function proposal(x: unknown, p: string): Proposal {
  const o = obj(x, p)
  return {
    id: reqStr(o, 'id', p),
    action: reqEnum(o, 'action', p, PROPOSAL_ACTIONS),
    payload: obj(o.payload, sub(p, 'payload')),
    reason: optStr(o, 'reason', p),
    createdAt: optStr(o, 'createdAt', p),
  }
}

// ---------- 对外 ----------

export function parseBoard(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    const pos = locateJsonError(text)
    if (pos === null) return { ok: false, error: 'JSON 格式错误' }
    const line = text.slice(0, pos).split('\n').length
    return { ok: false, error: `JSON 格式错误（第 ${line} 行）`, line }
  }
  try {
    const o = obj(raw, '根')
    if (o.schema === undefined) throw new Fail('缺少字段 schema')
    if (typeof o.schema === 'number' && Number.isInteger(o.schema) && o.schema > MAX_SCHEMA) {
      return { ok: false, error: `${NEWER_SCHEMA_TEXT}（schema ${o.schema}）` }
    }
    if (o.schema !== 1 && o.schema !== 2) throw new Fail(`未知版本：schema ${JSON.stringify(o.schema)}，本 mod 只认识 schema 1 和 2`)
    if (typeof o.rev !== 'number' || !Number.isInteger(o.rev) || o.rev < 0) {
      throw new Fail(o.rev === undefined ? '缺少字段 rev' : 'rev 必须是非负整数')
    }
    const project = obj(o.project, 'project')
    const focus = obj(o.focus, 'focus')
    const ms = obj(o.milestones, 'milestones')
    const archive = obj(o.archive, 'archive')
    const board: Board = {
      schema: o.schema,
      rev: o.rev,
      project: { name: reqStr(project, 'name', 'project') },
      focus: {
        text: optStr(focus, 'text', 'focus'),
        goalId: optStr(focus, 'goalId', 'focus'),
        mandate: optStr(focus, 'mandate', 'focus'),
        updatedAt: optStr(focus, 'updatedAt', 'focus'),
      },
      milestones: {
        enabled: ms.enabled === undefined ? false : bool(ms, 'enabled', 'milestones'),
        items: arr(ms.items, 'milestones.items', milestone),
      },
      goals: arr(o.goals, 'goals', (x, p) => goal(x, p, false)),
      decisions: arr(o.decisions, 'decisions', decision),
      rules: arr(o.rules, 'rules', rule),
      notes: arr(o.notes, 'notes', note),
      proposals: arr(o.proposals, 'proposals', proposal),
      archive: {
        goals: arr(archive.goals, 'archive.goals', (x, p) => goal(x, p, true)),
        decisions: arr(archive.decisions, 'archive.decisions', decision),
      },
    }
    const type = optStrOrUndef(project, 'type', 'project')
    if (type !== undefined) board.project.type = type
    return { ok: true, board }
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.message }
    throw e
  }
}

// ---------- 序列化：固定键顺序 ----------

const sLink = (l: Link): Link => {
  const o: Link = { type: l.type, kind: l.kind, target: l.target, label: l.label, forReview: l.forReview }
  if (l.step !== undefined) o.step = l.step
  return o
}

const sStep = (s: Step): Step => ({ id: s.id, title: s.title, label: s.label, note: s.note, links: s.links.map(sLink) })

/** Steps in use anywhere (or a goal.merge waiting): the file is written as schema 2, otherwise as schema 1 without step fields. */
export function usesSteps(b: Board): boolean {
  return [...b.goals, ...b.archive.goals].some(g => g.steps.length > 0) || b.proposals.some(p => p.action === 'goal.merge')
}

const sItem = (i: Item, withStep: boolean): Item => {
  const o = {
    id: i.id,
    title: i.title,
    ...(withStep ? { stepId: i.stepId } : {}),
    status: i.status,
    owner: i.owner,
    note: i.note,
    waitingFor: i.waitingFor,
    dependsOn: [...i.dependsOn],
    scope: [...i.scope],
    acceptance: i.acceptance,
    links: i.links.map(sLink),
    noReviewTargetReason: i.noReviewTargetReason,
    reportedAt: i.reportedAt,
    session: i.session,
    doneBy: i.doneBy,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    doneAt: i.doneAt,
  }
  return o as Item
}

const sGoal = (g: Goal, withStep: boolean): Goal => {
  const o = { id: g.id, title: g.title, outcome: g.outcome, status: g.status, links: g.links.map(sLink) } as Goal
  if (withStep) o.steps = g.steps.map(sStep)
  o.items = g.items.map(i => sItem(i, withStep))
  if (g.confirmedBy !== undefined) o.confirmedBy = g.confirmedBy
  if (g.quote !== undefined) o.quote = g.quote
  o.createdAt = g.createdAt
  o.updatedAt = g.updatedAt
  if (g.closedAt !== undefined) o.closedAt = g.closedAt
  if (g.closeReason !== undefined) o.closeReason = g.closeReason
  return o
}

const sDecision = (d: Decision): Decision => {
  const o = { id: d.id, date: d.date, text: d.text, kind: d.kind, goalId: d.goalId } as Decision
  if (d.quote !== undefined) o.quote = d.quote
  if (d.supersedes !== undefined) o.supersedes = d.supersedes
  o.status = d.status
  return o
}

const sRule = (r: Rule): Rule => {
  const o: Rule = { id: r.id, text: r.text, group: r.group }
  if (r.fromDecision !== undefined) o.fromDecision = r.fromDecision
  return o
}

export function serializeBoard(b: Board): string {
  const withStep = usesSteps(b)
  const project: Board['project'] = { name: b.project.name }
  if (b.project.type !== undefined) project.type = b.project.type
  const ordered: Board = {
    schema: withStep ? 2 : 1,
    rev: b.rev,
    project,
    focus: { text: b.focus.text, goalId: b.focus.goalId, mandate: b.focus.mandate, updatedAt: b.focus.updatedAt },
    milestones: {
      enabled: b.milestones.enabled,
      items: b.milestones.items.map(m => ({
        id: m.id,
        title: m.title,
        status: m.status,
        note: m.note,
        gates: m.gates.map(g => ({ date: g.date, name: g.name, result: g.result, points: g.points })),
      })),
    },
    goals: b.goals.map(g => sGoal(g, withStep)),
    decisions: b.decisions.map(sDecision),
    rules: b.rules.map(sRule),
    notes: b.notes.map(n => ({ id: n.id, title: n.title, text: n.text, group: n.group })),
    proposals: b.proposals.map(p => ({ id: p.id, action: p.action, payload: p.payload, reason: p.reason, createdAt: p.createdAt })),
    archive: { goals: b.archive.goals.map(g => sGoal(g, withStep)), decisions: b.archive.decisions.map(sDecision) },
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}
