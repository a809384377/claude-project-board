import type { Board } from './types'

/** Returns the first violated rule as a message, or null when the board is consistent. */
export function checkInvariants(board: Board): string | null {
  // id 唯一（活动区与归档区合计）
  const seen = new Set<string>()
  const dup = (id: string): boolean => {
    if (seen.has(id)) return true
    seen.add(id)
    return false
  }
  const allGoals = [...board.goals, ...board.archive.goals]
  for (const g of allGoals) {
    if (dup(g.id)) return `id 重复：${g.id}`
    for (const s of g.steps) if (dup(s.id)) return `id 重复：${s.id}`
    for (const i of g.items) {
      if (dup(i.id)) return `id 重复：${i.id}`
      if (i.stepId !== '' && !g.steps.some(s => s.id === i.stepId)) return `事项 ${i.id}「${i.title}」的 stepId ${i.stepId} 不是目标 ${g.id} 的步骤`
    }
  }
  const others = [
    ...board.decisions,
    ...board.archive.decisions,
    ...board.rules,
    ...board.notes,
    ...board.milestones.items,
    ...board.proposals,
  ]
  for (const x of others) if (dup(x.id)) return `id 重复：${x.id}`

  const fg = board.focus.goalId
  if (fg !== '' && !board.goals.some(g => g.id === fg)) return `当前关注指向的目标 ${fg} 不在活动区`
  return null
}
