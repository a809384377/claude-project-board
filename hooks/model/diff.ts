import type { Board, Goal, Item, Step } from './types'

const clip = (s: string, n = 24): string => (s.length > n ? `${s.slice(0, n)}…` : s)

const STATUS_ZH: Record<string, string> = {
  todo: '待办',
  queued: '排队',
  doing: '在做',
  running: '在跑',
  review: '待验收',
  done: '完成',
  dropped: '搁置',
}
const zh = (s: string): string => STATUS_ZH[s] ?? s

type Located = { item: Item; goal: Goal }

function itemsOf(goals: Goal[]): Map<string, Located> {
  const m = new Map<string, Located>()
  for (const goal of goals) for (const item of goal.items) m.set(item.id, { item, goal })
  return m
}

function byId<T extends { id: string }>(list: readonly T[]): Map<string, T> {
  return new Map(list.map(x => [x.id, x]))
}

type Placed = { step: Step; goal: Goal }

function stepsOf(goals: Goal[]): Map<string, Placed> {
  const m = new Map<string, Placed>()
  for (const goal of goals) for (const step of goal.steps) m.set(step.id, { step, goal })
  return m
}

/**
 * Goals that vanished from the active zone (not archived) into one new goal: every item and step they held is
 * there, or, when they were empty, the new goal has a step with their title. Two or more per new goal read as a merge.
 */
function findMerges(before: Board, after: Board, archivedNow: ReadonlySet<string>): Map<string, Goal[]> {
  const bg = byId(before.goals)
  const fresh = after.goals.filter(g => !bg.has(g.id))
  const gone = before.goals.filter(g => !after.goals.some(x => x.id === g.id) && !archivedNow.has(g.id))
  const out = new Map<string, Goal[]>()
  for (const target of fresh) {
    const items = new Set(target.items.map(i => i.id))
    const steps = new Set(target.steps.map(s => s.id))
    const taken = gone.filter(old =>
      old.items.length + old.steps.length > 0
        ? old.items.every(i => items.has(i.id)) && old.steps.every(s => steps.has(s.id))
        : target.steps.some(s => s.title === old.title),
    )
    if (taken.length >= 2) out.set(target.id, taken)
  }
  return out
}

/**
 * One Chinese line per difference between two versions of the board, each led by who did it.
 * `actor` is the label shown to Claude, e.g. 用户 / 子 agent / 外部。
 */
export function describeChanges(before: Board, after: Board, actor: string): string[] {
  const out: string[] = []
  const say = (text: string): void => void out.push(`${actor}：${text}`)

  // 关注
  const bf = before.focus
  const af = after.focus
  const bArch = byId(before.archive.goals)
  const aArch = byId(after.archive.goals)
  const newlyArchived = new Set<string>([...aArch.keys()].filter(id => !bArch.has(id)))
  const merges = findMerges(before, after, newlyArchived)
  const absorbed = new Map<string, string>() // old goal id -> merged goal id
  for (const [target, olds] of merges) for (const o of olds) absorbed.set(o.id, target)
  const focusFollowed = [...merges].some(([target, olds]) => bf.goalId !== af.goalId && af.goalId === target && olds.some(o => o.id === bf.goalId))
  if (bf.text !== af.text || (bf.goalId !== af.goalId && !focusFollowed) || bf.mandate !== af.mandate) {
    const goal = after.goals.find(g => g.id === af.goalId)
    say(`关注改为「${clip(af.text, 40)}」${goal ? `（目标：${clip(goal.title)}）` : ''}${af.mandate ? `，授权范围：${clip(af.mandate, 40)}` : ''}`)
  }

  // 目标
  const bg = byId(before.goals)
  const ag = byId(after.goals)
  for (const id of newlyArchived) say(`目标「${clip(aArch.get(id)?.title ?? '')}」已关闭（${aArch.get(id)?.closeReason ?? '已归档'}）`)
  for (const [target, olds] of merges) say(`合并 ${olds.length} 个目标为：${clip(ag.get(target)?.title ?? '')}`)
  for (const [id, g] of ag) {
    const old = bg.get(id)
    if (!old) {
      if (!merges.has(id)) say(`新增目标「${clip(g.title)}」`)
    } else {
      if (old.title !== g.title) say(`目标「${clip(old.title)}」改名为「${clip(g.title)}」`)
      if (old.outcome !== g.outcome) say(`目标「${clip(g.title)}」的成果改为「${clip(g.outcome, 40)}」`)
      if (old.status !== g.status) say(`目标「${clip(g.title)}」${g.status === 'paused' ? '已暂停' : '已恢复'}`)
      const gain = g.links.filter(l => !old.links.some(o => o.target === l.target)).length
      const lose = old.links.filter(o => !g.links.some(l => l.target === o.target)).length
      if (gain > 0 || lose > 0) say(`目标「${clip(g.title)}」的关联 +${gain} -${lose}`)
    }
  }
  for (const [id, g] of bg) {
    if (!ag.has(id) && !newlyArchived.has(id) && !absorbed.has(id)) say(`目标「${clip(g.title)}」已从看板移除`)
  }

  // 事项
  const bi = itemsOf(before.goals)
  const ai = itemsOf(after.goals)
  for (const [id, now] of ai) {
    const old = bi.get(id)
    const name = `事项「${clip(now.item.title)}」`
    if (!old) {
      say(`新增${name}（${zh(now.item.status)}，目标：${clip(now.goal.title)}）`)
      continue
    }
    const o = old.item
    const n = now.item
    if (o.title !== n.title) say(`事项「${clip(o.title)}」改名为「${clip(n.title)}」`)
    if (o.status !== n.status) say(`${name}：${zh(o.status)} → ${zh(n.status)}${n.status === 'done' && n.doneBy ? `（${n.doneBy === 'user' ? '用户验收' : 'Claude 验收'}）` : ''}`)
    if (old.goal.id !== now.goal.id && absorbed.get(old.goal.id) !== now.goal.id) say(`${name}移到目标「${clip(now.goal.title)}」`)
    if (o.stepId !== n.stepId && !(absorbed.get(old.goal.id) === now.goal.id)) {
      const st = now.goal.steps.find(x => x.id === n.stepId)
      say(st ? `${name}移到步骤「${clip(st.title)}」` : `${name}移出步骤「${clip(old.goal.steps.find(x => x.id === o.stepId)?.title ?? '')}」`)
    }
    if (o.owner !== n.owner) say(`${name}的负责人：${o.owner || '无'} → ${n.owner || '无'}`)
    if (o.note !== n.note) say(`${name}的备注改为「${clip(n.note, 40)}」`)
    if (o.waitingFor !== n.waitingFor) say(`${name}的等待事项改为「${clip(n.waitingFor, 40)}」`)
    if (o.acceptance !== n.acceptance) say(`${name}的验收标准有修改`)
    const gain = n.links.filter(l => !o.links.some(x => x.target === l.target)).length
    const lose = o.links.filter(x => !n.links.some(l => l.target === x.target)).length
    if (gain > 0 || lose > 0) say(`${name}的关联 +${gain} -${lose}`)
  }
  for (const [id, old] of bi) {
    if (!ai.has(id) && !newlyArchived.has(old.goal.id)) say(`事项「${clip(old.item.title)}」已删除`)
  }

  // 步骤（按 id 全局比较：搬到别的目标的步骤不算删一个加一个）
  const bs = stepsOf(before.goals)
  const as = stepsOf(after.goals)
  for (const [id, now] of as) {
    const old = bs.get(id)
    const n = now.step
    const name = `步骤「${clip(n.title)}」`
    if (!old) {
      if (!merges.has(now.goal.id)) say(`新增${name}（目标：${clip(now.goal.title)}）`)
      continue
    }
    const o = old.step
    if (o.title !== n.title) say(`步骤「${clip(o.title)}」改名为「${clip(n.title)}」`)
    if (o.label !== n.label) say(`${name}的短名改为「${clip(n.label)}」`)
    if (o.note !== n.note && !merges.has(now.goal.id)) say(`${name}的说明改为「${clip(n.note, 40)}」`)
    if (old.goal.id !== now.goal.id && absorbed.get(old.goal.id) !== now.goal.id) say(`${name}移到目标「${clip(now.goal.title)}」`)
    const gain = n.links.filter(l => !o.links.some(x => x.target === l.target)).length
    const lose = o.links.filter(x => !n.links.some(l => l.target === x.target)).length
    if (gain > 0 || lose > 0) say(`${name}的关联 +${gain} -${lose}`)
  }
  for (const [id, old] of bs) {
    if (!as.has(id) && !newlyArchived.has(old.goal.id) && !absorbed.has(old.goal.id)) say(`步骤「${clip(old.step.title)}」已删除`)
  }

  // 决策
  const bd = byId(before.decisions)
  for (const d of after.decisions) {
    const old = bd.get(d.id)
    if (!old) say(`记录决策「${clip(d.text, 40)}」（${d.kind === 'user' ? '用户定' : 'Claude 代做'}）`)
    else if (old.status !== d.status) say(`决策「${clip(d.text, 40)}」${d.status === 'superseded' ? '已被替代' : '恢复生效'}`)
    else if (old.text !== d.text) say(`决策改为「${clip(d.text, 40)}」`)
  }

  // 约定、资料
  const br = byId(before.rules)
  for (const r of after.rules) {
    const old = br.get(r.id)
    if (!old) say(`新增约定「${clip(r.text, 40)}」`)
    else if (old.text !== r.text || old.group !== r.group) say(`约定改为「${clip(r.text, 40)}」`)
  }
  const ar = byId(after.rules)
  for (const r of before.rules) if (!ar.has(r.id)) say(`删除约定「${clip(r.text, 40)}」`)

  const bn = byId(before.notes)
  for (const n of after.notes) {
    const old = bn.get(n.id)
    if (!old) say(`新增资料「${clip(n.title)}」`)
    else if (old.title !== n.title || old.text !== n.text || old.group !== n.group) say(`资料「${clip(n.title)}」有修改`)
  }
  const an = byId(after.notes)
  for (const n of before.notes) if (!an.has(n.id)) say(`删除资料「${clip(n.title)}」`)

  // 里程碑
  if (before.milestones.enabled !== after.milestones.enabled) say(`里程碑${after.milestones.enabled ? '已启用' : '已停用'}`)
  const bm = byId(before.milestones.items)
  for (const m of after.milestones.items) {
    const old = bm.get(m.id)
    if (!old) say(`新增里程碑「${clip(m.title)}」`)
    else {
      if (old.status !== m.status) say(`里程碑「${clip(m.title)}」：${old.status} → ${m.status}`)
      if (m.gates.length > old.gates.length) {
        const g = m.gates[m.gates.length - 1]
        if (g) say(`里程碑「${clip(m.title)}」新增关卡「${clip(g.name)}」：${g.result}`)
      }
    }
  }
  const am = byId(after.milestones.items)
  for (const m of before.milestones.items) if (!am.has(m.id)) say(`删除里程碑「${clip(m.title)}」`)

  // 待确认提议
  const bp = byId(before.proposals)
  for (const p of after.proposals) if (!bp.has(p.id)) say(`提出待确认的提议 ${p.action}${p.reason ? `：${clip(p.reason, 40)}` : ''}`)
  const ap = byId(after.proposals)
  for (const p of before.proposals) if (!ap.has(p.id)) say(`待确认的提议 ${p.action} 已处理（${p.id}）`)

  return out
}
