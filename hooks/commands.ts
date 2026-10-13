import type { Board, Decision, Goal } from './model/types'

/** Command output goes into the conversation, so a page stays small. */
export const PAGE_LINES = 40
export const PAGE_CHARS = 3000
/** One line is cut here; the full text is one board_get away. */
const LINE_CHARS = 300
/** The header and the footer take these out of a page; the body gets the rest. */
const HEADER_FOOTER_LINES = 2
const HEADER_FOOTER_CHARS = 260

export type CommandCtx = {
  /** Why the board file cannot be used (unparseable, unreadable), or null. */
  error: string | null
  /** The project root holding the board, when there is one. */
  root: string | null
  /** Creates the board in the session root; resolves to the sentence to show. */
  init: (type: string) => Promise<string>
  /** Shows or hides the board; resolves to the sentence to show. */
  toggle: () => Promise<string>
}

export type CommandResult = { text: string }

const USAGE = [
  '/board 用法：',
  '/board                       打开或关闭看板（竖屏时展开或收起输入框上方的看板）',
  '/board 决策 [目标名] [页码]  生效中的决策',
  '/board 约定 [页码]           项目约定',
  '/board 资料 [页码]           项目资料',
  '/board 归档 [关键词] [页码]  已关闭的目标与随之归档的决策',
  '/board init [类型]           在当前项目创建看板，类型如 miniapp',
].join('\n')

const NOT_ENABLED = '当前项目没有看板（找不到 ai/board.json）。用 /board init [类型] 创建。'

const clip = (s: string, n = LINE_CHARS): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** A trailing number is the page; what comes before it is the filter. */
export function splitPage(rest: string): { filter: string; page: number } {
  const m = /^(.*?)(?:\s+|^)(\d+)$/.exec(rest.trim())
  if (m === null) return { filter: rest.trim(), page: 1 }
  return { filter: (m[1] ?? '').trim(), page: Math.max(1, Number(m[2])) }
}

/**
 * Cuts lines into pages of at most PAGE_LINES lines and PAGE_CHARS characters counting the header and
 * the footer; every page has at least one line.
 */
export function paginate(lines: string[]): string[][] {
  const maxLines = PAGE_LINES - HEADER_FOOTER_LINES
  const maxChars = PAGE_CHARS - HEADER_FOOTER_CHARS
  const pages: string[][] = []
  let cur: string[] = []
  let chars = 0
  for (const line of lines) {
    const cost = line.length + 1
    if (cur.length > 0 && (cur.length >= maxLines || chars + cost > maxChars)) {
      pages.push(cur)
      cur = []
      chars = 0
    }
    cur.push(line)
    chars += cost
  }
  if (cur.length > 0) pages.push(cur)
  return pages
}

/** One page of a listing: header, the lines of the page, and the command for the next page. */
function listing(title: string, command: string, lines: string[], count: number, unit: string, empty: string, page: number): CommandResult {
  const pages = paginate(lines)
  if (pages.length === 0) return { text: `${title}：${empty}` }
  if (page > pages.length) return { text: `${title}只有 ${pages.length} 页（共 ${count} ${unit}）。看第一页：${command}` }
  const body = pages[page - 1] ?? []
  const head = `${title} · 共 ${count} ${unit}${pages.length > 1 ? ` · 第 ${page}/${pages.length} 页` : ''}`
  const next = page < pages.length ? `\n下一页：${command} ${page + 1}` : ''
  return { text: `${head}\n${body.join('\n')}${next}` }
}

const kindLabel = (d: Decision): string => (d.kind === 'user' ? '用户定' : 'AI 代做')

function decisionLine(d: Decision, goalTitle: string): string {
  const quote = d.quote ? `（原话：${clip(d.quote, 80)}）` : ''
  return clip(`${d.id} · ${d.date} · ${kindLabel(d)} · [${goalTitle}] ${d.text}${quote}`)
}

/** Newest first; decisions of the same date keep the later-recorded one first. */
function newestFirst<T extends { date: string }>(xs: T[]): T[] {
  return xs
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (a.x.date === b.x.date ? b.i - a.i : a.x.date < b.x.date ? 1 : -1))
    .map(o => o.x)
}

function decisions(board: Board, rest: string): CommandResult {
  const { filter, page } = splitPage(rest)
  const titleOf = (id: string): string => board.goals.find(g => g.id === id)?.title ?? '项目'
  let pool = board.decisions.filter(d => d.status === 'active')
  let title = '决策'
  let command = '/board 决策'
  if (filter !== '') {
    const exact = board.goals.filter(g => g.title === filter)
    const hits: Goal[] = exact.length > 0 ? exact : board.goals.filter(g => g.title.includes(filter))
    if (hits.length === 0) {
      const names = board.goals.map(g => g.title).join('、')
      return { text: `没有名为「${filter}」的进行中目标。${names ? `现有目标：${names}。` : ''}已关闭目标的决策用 /board 归档 ${filter} 查。` }
    }
    if (hits.length > 1) return { text: `「${filter}」对应多个目标：${hits.map(g => g.title).join('、')}。请写完整一点。` }
    const goal = hits[0] as Goal
    pool = pool.filter(d => d.goalId === goal.id)
    title = `决策 · ${goal.title}`
    command = `/board 决策 ${goal.title}`
  }
  const lines = newestFirst(pool).map(d => decisionLine(d, titleOf(d.goalId)))
  return listing(title, command, lines, pool.length, '条', '没有生效中的决策。', page)
}

/** Heading lines per group, in order of first appearance. */
function grouped<T extends { group: string }>(xs: T[], line: (x: T) => string): string[] {
  const order: string[] = []
  const by = new Map<string, T[]>()
  for (const x of xs) {
    const g = x.group === '' ? '未分组' : x.group
    if (!by.has(g)) {
      by.set(g, [])
      order.push(g)
    }
    by.get(g)?.push(x)
  }
  const out: string[] = []
  for (const g of order) {
    out.push(`【${g}】`)
    for (const x of by.get(g) ?? []) out.push(line(x))
  }
  return out
}

function rules(board: Board, rest: string): CommandResult {
  const { page } = splitPage(rest)
  const lines = grouped(board.rules, r => clip(`- ${r.text}（${r.id}）`))
  return listing('约定', '/board 约定', lines, board.rules.length, '条', '还没有约定。', page)
}

function notes(board: Board, rest: string): CommandResult {
  const { page } = splitPage(rest)
  const lines = grouped(board.notes, n => clip(`- ${n.title}${n.text ? `：${n.text}` : ''}（${n.id}）`))
  return listing('资料', '/board 资料', lines, board.notes.length, '条', '还没有资料。', page)
}

function archive(board: Board, rest: string): CommandResult {
  const { filter, page } = splitPage(rest)
  const kw = filter.toLowerCase()
  const has = (...xs: string[]): boolean => kw === '' || xs.some(x => x.toLowerCase().includes(kw))
  const goals = board.archive.goals.filter(g => has(g.title, g.outcome, ...g.items.map(i => i.title)))
  const decs = board.archive.decisions.filter(d => has(d.text, d.quote ?? ''))
  const goalTitle = (id: string): string => board.archive.goals.find(g => g.id === id)?.title ?? '项目'
  const lines = [
    ...goals.map(g => clip(`${g.id} · 目标 · ${g.closeReason ?? '已关闭'} · ${(g.closedAt ?? '').slice(0, 10)} · ${g.title}${g.outcome ? ` — ${g.outcome}` : ''}（${g.items.length} 项事项）`)),
    ...newestFirst(decs).map(d => decisionLine(d, goalTitle(d.goalId))),
  ]
  const title = filter === '' ? '归档' : `归档 · ${filter}`
  const command = filter === '' ? '/board 归档' : `/board 归档 ${filter}`
  return listing(title, command, lines, lines.length, '条', filter === '' ? '还没有归档内容。' : '没有匹配的归档内容。', page)
}

/** `/board <args>`. The listings are pure; init and the toggle go through ctx. */
export async function runCommand(args: string, board: Board | null, ctx: CommandCtx): Promise<CommandResult> {
  const trimmed = args.trim()
  const m = /^(\S+)\s*(.*)$/s.exec(trimmed)
  const sub = m?.[1] ?? ''
  const rest = (m?.[2] ?? '').trim()
  const known = ['决策', '约定', '资料', '归档', 'init'].includes(sub)
  if (trimmed !== '' && !known) return { text: USAGE }
  if (sub === 'init') {
    if (board !== null || ctx.error !== null || ctx.root !== null) return { text: `看板已存在：${ctx.root ?? ''}/ai/board.json${ctx.error ? `（${ctx.error}）` : ''}` }
    try {
      return { text: await ctx.init(rest) }
    } catch (e) {
      return { text: `创建看板失败：${(e as Error).message}` }
    }
  }
  if (board === null) return { text: ctx.error ?? NOT_ENABLED }
  if (trimmed === '') return { text: await ctx.toggle() }
  switch (sub) {
    case '决策':
      return decisions(board, rest)
    case '约定':
      return rules(board, rest)
    case '资料':
      return notes(board, rest)
    default:
      return archive(board, rest)
  }
}
