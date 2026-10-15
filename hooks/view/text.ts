import type { Board, ItemStatus, Proposal } from '../model/types'
import { isWaiting, type LocalView } from './local'

/** Plain-text pieces of the board view that need no drawing engine: shared by the Claude Code view and the pi widget. */

export const STATUS_ICON: Record<ItemStatus, string> = { todo: '○', queued: '⏸', doing: '◐', running: '●', review: '◆', done: '✓', dropped: '⊘' }

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

export function describeProposal(b: Board, p: Proposal): string {
  const goalTitle = (id: unknown): string => b.goals.find(g => g.id === id)?.title ?? String(id)
  const pl = p.payload
  switch (p.action) {
    case 'goal.create':
      return `新建目标：${String(pl.title)}`
    case 'goal.update':
      return `修改目标「${goalTitle(pl.goalId)}」${typeof pl.title === 'string' ? `，标题改为：${pl.title}` : ''}`
    case 'goal.close':
      return `关闭目标「${goalTitle(pl.goalId)}」（${String(pl.reason)}）`
    case 'goal.merge': {
      const ids = Array.isArray(pl.goalIds) ? (pl.goalIds as string[]) : []
      const names = ids.map(id => `「${clip(goalTitle(id), 8)}」`)
      const paused = ids.map(id => b.goals.find(g => g.id === id)).filter(g => g?.status === 'paused').map(g => `「${clip(g?.title ?? '', 8)}」`)
      // No spaces in this sentence: the terminal wraps only at spaces, so one space strands the rest of it on a new line.
      return `把${names.slice(0, 2).join('')}${ids.length > 2 ? '等' : ''}${ids.length}个目标合并为「${String(pl.title)}」的步骤${paused.length > 0 ? `（含暂停的${paused.join('')}，合并后一并恢复）` : ''}`
    }
    case 'goal.pause':
      return `暂停目标「${goalTitle(pl.goalId)}」`
    case 'goal.resume':
      return `恢复目标「${goalTitle(pl.goalId)}」`
    case 'focus.set':
      return `把关注改为：${String(pl.text)}`
  }
}

/** The one line shown when the pane is not on screen. */
export function entryText(vm: { board: Board | null; stale: boolean; local: LocalView }): string {
  const warn = vm.stale ? ' ⚠' : ''
  if (vm.board === null) return `看板${warn} · 文件无法读取 · /board 查看`
  let running = 0
  let review = 0
  for (const g of vm.board.goals) {
    for (const it of g.items) {
      if (it.status === 'running') running++
      else if (isWaiting(vm.local, it)) review++
    }
  }
  const asks = vm.board.proposals.length
  const parts = [`看板${warn}`]
  if (running > 0) parts.push(`在跑 ${running}`)
  if (review > 0) parts.push(`待你看 ${review}`)
  if (asks > 0) parts.push(`待确认 ${asks}`)
  if (parts.length === 1) parts.push('暂无进行中事项')
  parts.push('/board 打开')
  return parts.join(' · ')
}
