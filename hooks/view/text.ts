import type { Board, ItemStatus, Proposal } from '../model/types'
import { isWaiting, type LocalView } from './local'

/** Plain-text pieces of the board view that need no drawing engine: shared by the Claude Code view and the pi widget. */

export const STATUS_ICON: Record<ItemStatus, string> = { todo: '○', queued: '⏸', doing: '◐', running: '●', review: '◆', done: '✓', dropped: '⊘' }

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Terminal columns of one code point: 0 for marks and joiners, 2 for East Asian wide and emoji, else 1. */
export function cpWidth(c: number): number {
  if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f)) return 0
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
    return 2
  return 1
}

/** Columns of a string. */
export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += cpWidth(ch.codePointAt(0) as number)
  return n
}

/** `s` cut to at most `room` columns, ending in `…` when cut. Text inside a Button is drawn as one run that wraps, so rows cut their own titles. */
export function fitCells(s: string, room: number): string {
  if (cellWidth(s) <= room) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = cpWidth(ch.codePointAt(0) as number)
    if (used + w > room - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

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
