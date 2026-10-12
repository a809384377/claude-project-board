import { goalState, isOpen, itemsOfStep, progressOf, stepState, type GoalState, type Progress, type StepState } from '../model/derive'
import type { Board, Goal, Item, ItemStatus, Link, Step } from '../model/types'

/** Pure derivations the board view draws from: order, open/closed rules, counts. */

export type Mode = 'pane' | 'band-full'

/** Items the "Goal" shows in one group: a step, or the items that belong to no step ("其他"). */
export type Unit = { id: string; step: Step | null; items: Item[] }

export const otherId = (goalId: string): string => `other:${goalId}`

/** The steps of a goal in order, then "其他" when open items sit outside every step. */
export function unitsOf(g: Goal): Unit[] {
  const out: Unit[] = g.steps.map(step => ({ id: step.id, step, items: itemsOfStep(g, step.id) }))
  const loose = itemsOfStep(g, '')
  if (loose.some(isOpen)) out.push({ id: otherId(g.id), step: null, items: loose })
  return out
}

/** Items outside any step, whether or not there is a "其他" unit to show them. */
export const looseItems = (g: Goal): Item[] => itemsOfStep(g, '')

const moving = (i: Item): boolean => i.status === 'review' || i.status === 'running' || i.status === 'doing'

/** Units that open by themselves: those with review, running or doing items; failing that, the first with anything unfinished. */
export function defaultOpenUnits(g: Goal): Set<string> {
  const units = unitsOf(g)
  const busy = units.filter(u => u.items.some(moving))
  if (busy.length > 0) return new Set(busy.map(u => u.id))
  const first = units.find(u => u.items.some(isOpen))
  return new Set(first === undefined ? [] : [first.id])
}

export const unitOpen = (g: Goal, u: Unit, expanded: Record<string, boolean>): boolean => expanded[u.id] ?? defaultOpenUnits(g).has(u.id)

export const unitState = (u: Unit): StepState => stepState(u.items)

export type Parts = { active: Goal[]; paused: Goal[]; finished: Goal[] }

/**
 * Goals by where they are drawn: the list (focus first, then something running or waiting, then under way,
 * then not started; ties keep the file's order), the paused fold and the finished fold.
 * A finished goal in `held` (its confetti is still falling) stays in the list, ranked with the goals it just left.
 */
export function partitionGoals(b: Board, held: ReadonlySet<string> = new Set()): Parts {
  const rank = (g: Goal): number => {
    if (g.id === b.focus.goalId) return 0
    const s = goalState(g)
    return s === 'review' || s === 'running' || held.has(g.id) ? 1 : s === 'active' ? 2 : 3
  }
  const out: Parts = { active: [], paused: [], finished: [] }
  const live: Array<{ g: Goal; n: number }> = []
  b.goals.forEach((g, n) => {
    const s = goalState(g)
    if (s === 'paused') out.paused.push(g)
    else if (s === 'done' && !held.has(g.id)) out.finished.push(g)
    else live.push({ g, n })
  })
  out.active = live.sort((x, y) => rank(x.g) - rank(y.g) || x.n - y.n).map(x => x.g)
  return out
}

/** Whether the goal's body is open. Goals inside a fold open only when asked to. */
export function goalOpen(b: Board, g: Goal, expanded: Record<string, boolean>, mode: Mode): boolean {
  const chosen = expanded[g.id]
  if (chosen !== undefined) return chosen
  if (g.id === b.focus.goalId) return true
  if (mode === 'band-full' || g.status === 'paused') return false
  const s = goalState(g)
  return s === 'review' || s === 'running'
}

export const itemOpen = (it: Item, expanded: Record<string, boolean>): boolean => expanded[it.id] ?? it.status === 'review'

/** Items listed as rows: live ones in goals that are open, and in units that are open when the goal has steps. */
export function listedItems(b: Board, expanded: Record<string, boolean>, mode: Mode): Item[] {
  const out: Item[] = []
  const { active, paused, finished } = partitionGoals(b)
  for (const g of active) {
    if (!goalOpen(b, g, expanded, mode)) continue
    if (g.steps.length === 0) out.push(...g.items.filter(isOpen))
    else for (const u of unitsOf(g)) if (unitOpen(g, u, expanded)) out.push(...u.items.filter(isOpen))
  }
  for (const g of [...paused, ...finished]) if (expanded[g.id] === true) out.push(...g.items.filter(isOpen))
  return out
}

/** Items whose details are on screen: what register.ts checks the files of. */
export const openItems = (b: Board, expanded: Record<string, boolean>, mode: Mode): Item[] => listedItems(b, expanded, mode).filter(it => itemOpen(it, expanded))

/** A goal's or a step's attached links are listed when there are at most this many; more fold into "资料 N 条". */
export const GOAL_LINKS_INLINE = 3
/** Review items the "待你处理" block lists. */
export const ATTENTION_LIMIT = 10

export type ReviewRow = { goal: Goal; step: Step | undefined; item: Item }

/** Review items waiting for the user, in every goal, paused ones included; `pinned` ids (just stamped) stay listed. */
export function reviewItems(b: Board, pinned: ReadonlySet<string> = new Set()): ReviewRow[] {
  return b.goals.flatMap(goal =>
    goal.items
      .filter(item => item.status === 'review' || pinned.has(item.id))
      .map(item => ({ goal, step: goal.steps.find(s => s.id === item.stepId), item })),
  )
}

export const linksOpen = (links: readonly Link[], key: string, expanded: Record<string, boolean>): boolean => links.length <= GOAL_LINKS_INLINE || expanded[key] === true

/** Every link that has buttons on screen: what register.ts checks the files of. */
export function shownLinks(b: Board, expanded: Record<string, boolean>, mode: Mode): Link[] {
  const out: Link[] = []
  for (const it of openItems(b, expanded, mode)) out.push(...it.links)
  const { active, paused, finished } = partitionGoals(b)
  for (const g of active) {
    if (!goalOpen(b, g, expanded, mode)) continue
    if (linksOpen(g.links, `links:${g.id}`, expanded)) out.push(...g.links)
    for (const s of g.steps) if (unitOpen(g, { id: s.id, step: s, items: [] }, expanded) && linksOpen(s.links, `links:${s.id}`, expanded)) out.push(...s.links)
  }
  for (const g of [...paused, ...finished]) if (expanded[g.id] === true && linksOpen(g.links, `links:${g.id}`, expanded)) out.push(...g.links)
  for (const { item } of reviewItems(b).slice(0, ATTENTION_LIMIT)) out.push(...item.links.filter(l => l.forReview))
  return out
}

export type Counts = { review: number; running: number; todo: number; done: number }

/** The four numbers of the status block. Waiting for you counts paused goals too; running and to-do do not. */
export function boardCounts(b: Board): Counts {
  const out: Counts = { review: 0, running: 0, todo: 0, done: 0 }
  for (const g of b.goals) {
    for (const it of g.items) {
      if (it.status === 'done') out.done++
      else if (it.status === 'review') out.review++
      else if (g.status === 'paused') continue
      else if (it.status === 'running') out.running++
      else if (it.status === 'todo' || it.status === 'queued' || it.status === 'doing') out.todo++
    }
  }
  return out
}

/** Whether a goal or step is lit: something waits for the user or runs. Everything else is grey. */
export const lit = (s: GoalState): boolean => s === 'review' || s === 'running'

/** "12/17" with the total counting everything but dropped; null when the goal has nothing yet. */
export function fractionOf(items: readonly Item[]): { done: number; total: number; frac: number } {
  const p: Progress = progressOf(items)
  return { done: p.done, total: p.total, frac: p.total === 0 ? 0 : p.done / p.total }
}

/** A step bar entry shows a count while the step is in motion. */
export const showsCount = (s: StepState): boolean => s === 'review' || s === 'running' || s === 'active'

export const SHOW_ORDER: ItemStatus[] = ['review', 'running', 'doing', 'queued', 'todo']
