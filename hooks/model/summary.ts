import { isOpen, progressOf, statusCounts, STEP_ICON, stepShortName, stepState, type StepState } from './derive'
import type { Board, Goal, Item, Rule, Step } from './types'

/** Total characters of the whole section, and of one field before it is cut. */
export const SNAPSHOT_LIMIT = 6000
export const FIELD_LIMIT = 300
const CUT_NOTE = '…（board_get 查看全文）'

export const RULES_TEXT = `# 项目看板（ai/board.json，project-board 维护）
工作规则：
1. 项目状态记在看板，用看板工具（board_get / board_update / board_propose）读写。有进行中的 sprint（ai/sprints/active/）时，sprint 内的执行进度只写该 sprint 的 PLAN.md；看板上用它对应的目标记目标级状态、待验收节点和决策。新开 sprint 时提议建对应目标并挂 PLAN.md，sprint 结束时提议关闭。
2. 推进时随手更新事项；用户在对话里拍板时立即用 decision.add 记录（kind=user，附原话）；你自己替用户做的非关键判断记 kind=delegated；用户改口时新增决策并用 supersedes 指向旧的。长期有效的约束同时用 rule.add 写进约定。
3. 事项进入 review（待验收）必须附验收入口（forReview 关联）。
4. 目标与关注的变化先用 board_propose 提议；用户对一个具体方案明确说了同意（如「同意合并」「就按这个建」）才加 userConfirmed 与原话直接执行。用户只是提出整理、拆分、合并、新建之类的要求不算同意，先提议，等用户回应。
5. 目标是用户确认过的一件完整的事；为达成它的成果（outcome）而做的阶段，用 step.add 拆成步骤（如 A→B→C→D），事项用 stepId 挂到步骤上。步骤由你自己拆分、增删，不需要提议；成果之外的新事情，提议新目标。只有几件事的目标可以不拆步骤。sprint 对应的目标（挂着 PLAN.md 的）不拆步骤、不参与合并，步骤记在 PLAN.md。看板上几个目标其实是同一件事的不同阶段时，用 board_propose goal.merge 提议合并成一个目标。
以下是会话开始时的看板快照；之后的变化会在用户发消息时另行告知，需要最新内容用 board_get。`

const STATUS_ICON: Record<string, string> = {
  todo: '○待办',
  queued: '⏸排队',
  doing: '◐在做',
  running: '●在跑',
  review: '◆待验收',
  done: '✓完成',
  dropped: '搁置',
}

/** One field cut to FIELD_LIMIT characters, flattened to one line. */
export function field(s: string): string {
  const flat = s.replace(/\s*\n\s*/g, ' ').trim()
  return flat.length > FIELD_LIMIT ? flat.slice(0, FIELD_LIMIT) + CUT_NOTE : flat
}

function hardCut(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…'
}

// ---------- 关注 ----------

function focusSection(b: Board): string {
  const f = b.focus
  const lines = [`## 关注（rev ${b.rev}，项目：${field(b.project.name)}）`]
  if (f.text === '') lines.push('当前没有设置关注（用 board_propose focus.set 提议）')
  else {
    const goal = b.goals.find(g => g.id === f.goalId)
    lines.push(`★ ${field(f.text)}${goal ? `（目标 ${goal.id} ${field(goal.title)}）` : ''}`)
    if (f.mandate !== '') lines.push(`授权范围：${field(f.mandate)}`)
  }
  if (b.milestones.enabled && b.milestones.items.length > 0) {
    const cur = b.milestones.items.filter(m => m.status === '进行中').map(m => field(m.title))
    const done = b.milestones.items.filter(m => m.status === '完成').length
    lines.push(`里程碑：${cur.length > 0 ? `进行中「${cur.join('」「')}」` : '无进行中'}，已完成 ${done}/${b.milestones.items.length}`)
  }
  return lines.join('\n')
}

// ---------- 目标与事项 ----------

const itemFull = (i: Item, indent = '  '): string => {
  const bits = [`${indent}- ${i.id} ${STATUS_ICON[i.status] ?? i.status} ${field(i.title)}`]
  if (i.owner !== '') bits.push(`@${i.owner}`)
  if (i.status === 'queued' && i.waitingFor !== '') bits.push(`等：${field(i.waitingFor)}`)
  if (i.note !== '') bits.push(`— ${field(i.note)}`)
  return bits.join(' ')
}
const itemTitle = (i: Item, indent = '  '): string => `${indent}- ${i.id} ${STATUS_ICON[i.status] ?? i.status} ${field(i.title)}`

function countText(g: Goal): string {
  const parts = Object.entries(statusCounts(g.items)).map(([s, n]) => `${STATUS_ICON[s] ?? s} ${n}`)
  return parts.length > 0 ? parts.join(' ') : '无事项'
}

/** Focus goal first, then goals with running/review work, then the rest. */
function orderGoals(b: Board): Goal[] {
  const rank = (g: Goal): number =>
    g.id === b.focus.goalId ? 0 : g.items.some(i => i.status === 'running' || i.status === 'review') ? 1 : 2
  return b.goals.map((g, idx) => ({ g, idx })).sort((x, y) => rank(x.g) - rank(y.g) || x.idx - y.idx).map(x => x.g)
}

// ---------- 约定 ----------

function groupRules(rules: readonly Rule[]): Map<string, Rule[]> {
  const m = new Map<string, Rule[]>()
  for (const r of [...rules].sort((a, b) => a.group.localeCompare(b.group))) {
    const g = r.group === '' ? '未分组' : r.group
    m.set(g, [...(m.get(g) ?? []), r])
  }
  return m
}


// ---------- 按总额度顺序填充 ----------

/**
 * One section filled unit by unit. Each unit lists its variants from richest to poorest; the first one
 * that fits (with room left for the "N more" line when units remain) is used. When none fits, the
 * section ends with `more(n)` for the n units not placed. The head always stays.
 */
function fill(head: string, units: ReadonlyArray<readonly string[]>, more: (n: number) => string, room: number): string {
  const out = [head]
  let used = head.length
  for (let k = 0; k < units.length; k++) {
    const left = units.length - k - 1
    const reserve = left > 0 ? 1 + more(left).length : 0
    const pick = units[k]?.find(v => used + 1 + v.length + reserve <= room)
    if (pick === undefined) {
      out.push(more(units.length - k))
      break
    }
    out.push(pick)
    used += 1 + pick.length
  }
  return out.join('\n')
}

function proposalsSection(b: Board, room: number): string | null {
  if (b.proposals.length === 0) return null
  const head = `## 待确认（${b.proposals.length} 条，等用户在看板上同意或在对话里确认）`
  const units = b.proposals.map(p => [`- ${p.id} ${p.action}${p.reason !== '' ? `：${field(p.reason)}` : ''}`])
  return fill(head, units, n => `另有 ${n} 条，用 board_get summary 查看`, room)
}

function rulesSection(b: Board, room: number): string {
  const head = `## 约定（${b.rules.length} 条）`
  if (b.rules.length === 0) return `${head}\n（暂无）`
  const units: string[][] = []
  for (const [g, list] of groupRules(b.rules)) {
    list.forEach((r, n) => units.push([n === 0 ? `[${g}]\n- ${field(r.text)}` : `- ${field(r.text)}`]))
  }
  return fill(head, units, n => `另有 ${n} 条，用 board_get rules 查看`, room)
}

/** `✓T ✓A ◆B 12/17 ○C`: every step in order, with counts for the ones under way. */
function stepBar(g: Goal): string {
  const bits = g.steps.map(s => {
    const items = g.items.filter(i => i.stepId === s.id)
    const st = stepState(items)
    const { done, total } = progressOf(items)
    return `${STEP_ICON[st]}${stepShortName(s)}${st === 'review' || st === 'running' || st === 'active' ? ` ${done}/${total}` : ''}`
  })
  const loose = g.items.filter(i => i.stepId === '' && isOpen(i)).length
  if (loose > 0) bits.push(`未分步骤 ${loose}`)
  return `  步骤：${bits.join(' ')}`
}

const STEP_RANK: Record<StepState, number> = { review: 0, running: 1, active: 2, idle: 3, done: 4 }

/** One step (or the items outside steps) as a fill unit: with notes, titles only, counts only. */
function stepUnit(head: string, items: Item[]): string[] {
  const open = items.filter(isOpen)
  const counts: Record<string, number> = {}
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1
  const text = Object.entries(counts).map(([st, n]) => `${STATUS_ICON[st] ?? st} ${n}`).join(' ')
  return [
    [head, ...open.map(i => itemFull(i, '    '))].join('\n'),
    [head, ...open.map(i => itemTitle(i, '    '))].join('\n'),
    `${head}：${text}`,
  ]
}

type GoalUnit = { vars: string[]; kind: 'goal' | 'step'; must: boolean }

/** The units of a goal: a single one without steps, otherwise a head that stays plus one unit per step that has open items. */
function goalUnits(g: Goal): GoalUnit[] {
  if (g.status === 'paused') return [{ vars: [`- ${g.id} ${field(g.title)}（暂停）`], kind: 'goal', must: false }]
  const title = `- ${g.id} ${field(g.title)}`
  const open = g.items.filter(isOpen)
  if (g.steps.length === 0) {
    return [
      {
        kind: 'goal',
        must: false,
        vars: [
          [`${title}${g.outcome !== '' ? `：${field(g.outcome)}` : ''}`, ...open.map(i => itemFull(i))].join('\n'),
          [title, ...open.map(i => itemTitle(i))].join('\n'),
          `${title}：${countText(g)}`,
        ],
      },
    ]
  }
  const bar = stepBar(g)
  const headVars = g.outcome !== '' ? [`${title}：${field(g.outcome)}\n${bar}`, `${title}\n${bar}`] : [`${title}\n${bar}`]
  const units: GoalUnit[] = [{ vars: headVars, kind: 'goal', must: true }]
  const parts = g.steps
    .map((s: Step, idx) => ({ s, idx, items: g.items.filter(i => i.stepId === s.id) }))
    .filter(x => x.items.some(isOpen))
    .sort((a, b) => STEP_RANK[stepState(a.items)] - STEP_RANK[stepState(b.items)] || a.idx - b.idx)
  for (const x of parts) units.push({ vars: stepUnit(`  [${stepShortName(x.s)}] ${x.s.id} ${field(x.s.title)}`, x.items), kind: 'step', must: false })
  const loose = g.items.filter(i => i.stepId === '')
  if (loose.some(isOpen)) units.push({ vars: stepUnit('  [未分步骤]', loose), kind: 'step', must: false })
  return units
}

function omittedText(goals: number, steps: number): string {
  const what = [goals > 0 && `${goals} 个目标`, steps > 0 && `${steps} 个步骤`].filter(Boolean).join('、')
  return `另有 ${what}，用 board_get summary 查看`
}

/**
 * Fills the goals section unit by unit, like `fill`, except that a goal head (a goal with steps) is kept
 * while the step units after it give way first: room is held back for the heads still to come.
 * Once a unit does not fit, no further optional unit is placed, so what is left out is always the tail.
 */
function fillGoals(head: string, units: readonly GoalUnit[], room: number): string {
  const out = [head]
  let used = head.length
  let stopped = false
  let lostGoals = 0
  let lostSteps = 0
  const lose = (u: GoalUnit): void => {
    if (u.kind === 'goal') lostGoals++
    else lostSteps++
  }
  for (let k = 0; k < units.length; k++) {
    const u = units[k] as GoalUnit
    if (stopped && !u.must) {
      lose(u)
      continue
    }
    const later = units.slice(k + 1)
    const keep = later.filter(x => x.must).reduce((n, x) => n + 1 + (x.vars[x.vars.length - 1] as string).length, 0)
    const opt = later.filter(x => !x.must)
    const more = opt.length > 0 ? 1 + omittedText(opt.filter(x => x.kind === 'goal').length, opt.filter(x => x.kind === 'step').length).length : 0
    let pick = u.vars.find(v => used + 1 + v.length + keep + more <= room)
    if (pick === undefined && u.must) {
      const last = u.vars[u.vars.length - 1] as string
      if (used + 1 + last.length + keep <= room) pick = last
    }
    if (pick === undefined) {
      stopped = true
      lose(u)
      continue
    }
    out.push(pick)
    used += 1 + pick.length
  }
  if (lostGoals + lostSteps > 0) out.push(omittedText(lostGoals, lostSteps))
  return out.join('\n')
}

function goalsSection(b: Board, room: number): string {
  const head = '## 目标与事项'
  if (b.goals.length === 0) return `${head}\n（暂无目标）`
  return fillGoals(head, orderGoals(b).flatMap(goalUnits), room)
}

function decisionsSection(b: Board, room: number): string {
  const live = new Set(b.goals.filter(g => g.status === 'active').map(g => g.id))
  const list = b.decisions
    .filter(d => d.status === 'active' && (d.goalId === '' || live.has(d.goalId)))
    .map((d, idx) => ({ d, idx }))
    .sort((x, y) => (x.d.date < y.d.date ? 1 : x.d.date > y.d.date ? -1 : y.idx - x.idx))
    .map(x => x.d)
  const head = `## 决策（进行中目标与项目级，生效 ${list.length} 条，最近的在前）`
  if (list.length === 0) return `${head}\n（暂无）`
  const units = list.map(d => [`- ${d.date} ${field(d.text)}${d.kind === 'delegated' ? '（AI 代做）' : ''}`])
  return fill(head, units, n => `另有 ${n} 条，用 board_get decisions 查看`, room)
}

/** What each later list keeps for itself, at most, so an early list cannot push the later ones out. */
const FLOOR = { proposals: 400, rules: 1200, goals: 1200, decisions: 1200 } as const

/**
 * The system-prompt section for a board. SNAPSHOT_LIMIT is one budget filled in order: working rules,
 * focus, proposals, rules, goals and items, decisions. A list takes what it needs and says how many
 * entries it left out; what is left goes to the next section. A list that comes after another is
 * guaranteed FLOOR characters (or all it has, if that is less). The result never exceeds SNAPSHOT_LIMIT.
 */
export function buildSnapshot(b: Board): string {
  const parts: string[] = [RULES_TEXT, focusSection(b)]
  const lists: Array<{ make: (room: number) => string | null; floor: number }> = [
    { make: room => proposalsSection(b, room), floor: FLOOR.proposals },
    { make: room => rulesSection(b, room), floor: FLOOR.rules },
    { make: room => goalsSection(b, room), floor: FLOOR.goals },
    { make: room => decisionsSection(b, room), floor: FLOOR.decisions },
  ]
  const need = lists.map(l => (l.make(Infinity)?.length ?? -2) + 2)
  let used = parts.join('\n\n').length
  for (let k = 0; k < lists.length; k++) {
    if (need[k] === 0) continue
    let later = 0
    for (let j = k + 1; j < lists.length; j++) later += Math.min(need[j] as number, (lists[j] as { floor: number }).floor)
    const text = (lists[k] as { make: (room: number) => string | null }).make(SNAPSHOT_LIMIT - used - 2 - later)
    if (text === null) continue
    parts.push(text)
    used += 2 + text.length
  }
  return hardCut(parts.join('\n\n'), SNAPSHOT_LIMIT)
}
