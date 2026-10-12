import type { Board } from './types'

export type IdPrefix = 'g' | 's' | 'i' | 'd' | 'r' | 'n' | 'm' | 'p'

const MAX_TRIES = 1000

/**
 * `<prefix>-<6 位 base36>`. Skips ids in `taken`; does not add the result to it.
 * Throws if no free id turns up (only possible with a broken `rand`).
 */
export function newId(prefix: IdPrefix, taken: Set<string>, rand: () => number = Math.random): string {
  for (let n = 0; n < MAX_TRIES; n++) {
    let s = ''
    for (let k = 0; k < 6; k++) s += Math.floor(rand() * 36).toString(36)
    const id = `${prefix}-${s}`
    if (!taken.has(id)) return id
  }
  throw new Error(`无法生成未占用的 ${prefix}- id`)
}

/** Every id on the board: active zone and archive. */
export function collectIds(board: Board): Set<string> {
  const ids = new Set<string>()
  const goals = [...board.goals, ...board.archive.goals]
  for (const g of goals) {
    ids.add(g.id)
    for (const s of g.steps) ids.add(s.id)
    for (const i of g.items) ids.add(i.id)
  }
  for (const d of [...board.decisions, ...board.archive.decisions]) ids.add(d.id)
  for (const x of board.rules) ids.add(x.id)
  for (const x of board.notes) ids.add(x.id)
  for (const x of board.milestones.items) ids.add(x.id)
  for (const x of board.proposals) ids.add(x.id)
  return ids
}
