import type { Goal, Item, Step } from './types'

/** Pure derivations shared by the prompt snapshot, queries and the view. */

export const isOpen = (i: Item): boolean => i.status !== 'done' && i.status !== 'dropped'

/** Items that count towards progress: everything but dropped. */
export const counted = (items: readonly Item[]): Item[] => items.filter(i => i.status !== 'dropped')

export type Progress = { done: number; total: number; running: number; review: number }

export function progressOf(items: readonly Item[]): Progress {
  const live = counted(items)
  return {
    done: live.filter(i => i.status === 'done').length,
    total: live.length,
    running: live.filter(i => i.status === 'running').length,
    review: live.filter(i => i.status === 'review').length,
  }
}

/** idle = not started; active = under way; done = finished. */
export type StepState = 'idle' | 'active' | 'running' | 'review' | 'done'

export function stepState(items: readonly Item[]): StepState {
  const live = counted(items)
  if (live.length === 0) return 'idle'
  const open = live.filter(isOpen)
  if (open.length === 0) return 'done'
  if (open.some(i => i.status === 'review')) return 'review'
  if (open.some(i => i.status === 'running')) return 'running'
  if (live.some(i => i.status === 'done' || i.status === 'doing')) return 'active'
  return 'idle'
}

/** The icon of a step by state, as the bar and the prompt snapshot draw it. */
export const STEP_ICON: Record<StepState, string> = { done: '✓', review: '◆', running: '●', active: '◐', idle: '○' }

/** How many items sit in each status, in the order the statuses first appear. */
export function statusCounts(items: readonly Item[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of items) out[i.status] = (out[i.status] ?? 0) + 1
  return out
}

export const itemsOfStep = (g: Goal, stepId: string): Item[] => g.items.filter(i => i.stepId === stepId)

export type GoalState = StepState | 'paused'

/** Colour state of a goal: paused; done when every step is done and nothing open is left outside steps; else by all its items ('done' never shows through). */
export function goalState(g: Goal): GoalState {
  if (g.status === 'paused') return 'paused'
  const live = counted(g.items)
  const finished =
    live.some(i => i.status === 'done') &&
    !live.some(isOpen) &&
    g.steps.every(s => stepState(itemsOfStep(g, s.id)) === 'done')
  if (finished) return 'done'
  const s = stepState(g.items)
  return s === 'done' ? 'active' : s
}

/** Characters, not UTF-16 units, so a surrogate pair is never cut. */
const chars = (s: string): string[] => Array.from(s)
const head = (s: string, n: number): string => chars(s).slice(0, n).join('')

/** Step short name: its label; else the leading code of the title; else the part before the first separator (6 characters at most); else the first 4 characters. */
export function stepShortName(s: Pick<Step, 'label' | 'title'>): string {
  if (s.label.trim() !== '') return s.label.trim()
  const title = s.title.trim()
  const code = /^[A-Za-z0-9]{1,4}(?=[\s:：.、])/.exec(title)
  if (code) return code[0]
  const first = title.split(/[：:、 ]/)[0] ?? ''
  if (first !== '' && first !== title && chars(first).length <= 6) return first
  return head(title, 4)
}

/** Goal short name: the part before the first of 「：:、（( 」, cut to 8 characters. */
export function goalShortName(title: string): string {
  const t = title.trim()
  const first = t.split(/[：:、（( ]/)[0] ?? ''
  return head(first === '' ? t : first, 8)
}
