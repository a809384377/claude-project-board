import { counted, goalState, stepState } from '../model/derive'
import type { Board, Goal, Item } from '../model/types'
import { fractionOf } from './derive'
import { CONFETTI_MS, PROGRESS_MS, SPARK_MS } from './motion'

/**
 * One-off effects of a project's board: object id -> when it started. The drawing only reads them.
 * A value is never changed after it is made; a newer commit makes a new one.
 */
export type Effects = {
  /** Item, step and goal ids whose row, button or head lights up and fades. */
  ripples: Readonly<Record<string, number>>
  /** Goal id -> the fraction its bar showed before the change, and when. */
  progress: Readonly<Record<string, { from: number; start: number }>>
  /** Goal id -> when its confetti started (a step or the goal finished). */
  confetti: Readonly<Record<string, number>>
  /** The mascot cheers until this time. */
  cheerUntil: number
}

export const NO_FX: Effects = { ripples: {}, progress: {}, confetti: {}, cheerUntil: 0 }

export const RIPPLE_MS = 2000
export const RIPPLE_STEPS = 10
export const CHEER_MS = 2600
/** More changed objects than this in one commit read as a replaced file: no row lights up. */
export const BULK_LIMIT = 20

/** What a commit changed, as far as the drawing cares. */
export type Change = { source: 'external' | 'main' | 'agent' | 'user'; before: Board | null; after: Board | null }

/** Ten steps from full strength down to nothing: 10 at the start, 1 at the end, 0 once over. */
export function rippleStep(start: number, now: number): number {
  const e = now - start
  if (e < 0) return RIPPLE_STEPS
  if (e >= RIPPLE_MS) return 0
  return RIPPLE_STEPS - Math.floor((e / RIPPLE_MS) * RIPPLE_STEPS)
}

const itemsOf = (b: Board): Map<string, Item> => new Map(b.goals.flatMap(g => g.items).map(i => [i.id, i]))
const stepsOf = (b: Board): Map<string, { goal: Goal; json: string }> => new Map(b.goals.flatMap(g => g.steps.map(s => [s.id, { goal: g, json: JSON.stringify(s) }] as const)))

/** Entries that have run their course are dropped. */
export function prune(fx: Effects, now: number): Effects {
  const keep = <V>(o: Readonly<Record<string, V>>, alive: (v: V) => boolean): Record<string, V> => Object.fromEntries(Object.entries(o).filter(([, v]) => alive(v)))
  return {
    ripples: keep(fx.ripples, s => now - s < RIPPLE_MS),
    progress: keep(fx.progress, p => now - p.start < PROGRESS_MS + SPARK_MS),
    confetti: keep(fx.confetti, s => now - s < CONFETTI_MS),
    cheerUntil: fx.cheerUntil > now ? fx.cheerUntil : 0,
  }
}

/** Whether any one-off effect is still running at `now`. */
export function isAlive(fx: Effects, now: number): boolean {
  const p = prune(fx, now)
  return Object.keys(p.ripples).length + Object.keys(p.progress).length + Object.keys(p.confetti).length > 0 || p.cheerUntil > 0
}

/**
 * The effects after a commit: those still running, plus the ones this commit starts (6.3 of the design).
 * Nothing starts without a board on both sides (first load, the file turning readable).
 */
export function deriveEffects(prev: Effects, change: Change, now: number): Effects {
  const old = prune(prev, now)
  const { before, after, source } = change
  if (before === null || after === null) return old

  const bItems = itemsOf(before)
  const aItems = itemsOf(after)
  const bGoals = new Map(before.goals.map(g => [g.id, g]))
  const bSteps = stepsOf(before)
  const aSteps = stepsOf(after)
  const newGoals = after.goals.filter(g => !bGoals.has(g.id))
  const inNewGoal = new Set(newGoals.map(g => g.id))
  const goalOfItem = new Map(after.goals.flatMap(g => g.items.map(i => [i.id, g.id] as const)))

  // Items that are new, changed or gone. Rows in a new goal are covered by that goal's own ripple; the row the
  // user's own button just stamped has its stamp; the step they sit in still lights up.
  const differing = new Set<string>()
  const touchedItems = new Set<string>()
  for (const [id, it] of aItems) {
    const was = bItems.get(id)
    if (was !== undefined && JSON.stringify(was) === JSON.stringify(it)) continue
    differing.add(id)
    if (inNewGoal.has(goalOfItem.get(id) ?? '')) continue
    if (source === 'user' && was?.status === 'review' && it.status === 'done') continue
    touchedItems.add(id)
  }
  for (const id of bItems.keys()) if (!aItems.has(id)) differing.add(id)

  // Steps whose own record changed, or that gained, lost or changed an item.
  const touchedSteps = new Set<string>()
  const mark = (id: string): void => {
    const s = aSteps.get(id)
    if (s !== undefined && !inNewGoal.has(s.goal.id)) touchedSteps.add(id)
  }
  for (const [id, s] of aSteps) if (bSteps.get(id)?.json !== s.json) mark(id)
  for (const id of differing) {
    mark(aItems.get(id)?.stepId ?? '')
    mark(bItems.get(id)?.stepId ?? '')
  }

  const bulk = touchedItems.size + touchedSteps.size + newGoals.length > BULK_LIMIT

  const ripples: Record<string, number> = { ...old.ripples }
  if (!bulk) {
    for (const id of touchedItems) ripples[id] = now
    for (const id of touchedSteps) ripples[id] = now
    for (const g of newGoals) ripples[g.id] = now
  }

  // Bars: done or total changed.
  const progress: Record<string, { from: number; start: number }> = { ...old.progress }
  for (const g of after.goals) {
    const was = bGoals.get(g.id)
    if (was === undefined) continue
    const a = fractionOf(g.items)
    const b = fractionOf(was.items)
    if (a.done !== b.done || a.total !== b.total) progress[g.id] = { from: b.frac, start: now }
  }

  // Confetti: a step or a goal that was there and unfinished and now is finished. New steps and goals (a merge) do not count.
  const confetti: Record<string, number> = { ...old.confetti }
  let cheer = old.cheerUntil
  for (const g of after.goals) {
    const was = bGoals.get(g.id)
    let finished = false
    if (was !== undefined && goalState(was) !== 'done' && goalState(g) === 'done') finished = true
    for (const s of g.steps) {
      const prevStep = bSteps.get(s.id)
      if (prevStep === undefined) continue
      const wasItems = prevStep.goal.items.filter(i => i.stepId === s.id)
      if (stepState(wasItems) !== 'done' && stepState(counted(g.items.filter(i => i.stepId === s.id))) === 'done') finished = true
    }
    if (finished) {
      confetti[g.id] = now
      cheer = now + CHEER_MS
    }
  }
  return { ripples, progress, confetti, cheerUntil: cheer }
}

/**
 * A string that changes whenever something drawn as text (not as canvas) moves on: ripple steps, stamp phases,
 * which confetti is running. A timer redraws the board when it changes.
 */
export function textSignature(fx: Effects, stamps: Readonly<Record<string, number>>, now: number): string {
  const parts: string[] = []
  for (const [id, s] of Object.entries(fx.ripples)) parts.push(`r${id}:${rippleStep(s, now)}`)
  for (const [id, s] of Object.entries(stamps)) parts.push(`s${id}:${now - s < 150 ? 0 : now - s < 320 ? 1 : 2}`)
  for (const [id, s] of Object.entries(fx.confetti)) parts.push(`c${id}:${now - s < CONFETTI_MS ? 1 : 0}`)
  return parts.sort().join('|')
}
