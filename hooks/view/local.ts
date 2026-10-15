import type { Host } from '../host'
import type { Item, Link } from '../model/types'

/**
 * What this machine's user has dismissed on the board. Lives outside ai/board.json, so the AI never hears about it.
 * `seen[itemId]` is the reviewPrint the user looked at; `hidden[ownerId]` lists link targets hidden under that goal, step or item.
 */
export type LocalView = { seen: Record<string, string>; hidden: Record<string, string[]> }

export const EMPTY_LOCAL: LocalView = { seen: {}, hidden: {} }

const FNV_PRIME = 16777619

/** `n` hex digits (at most 16) of two independent 32-bit FNV-1a runs over the text; pure TS, no node modules. */
function digest(text: string, n: number): string {
  let a = 2166136261
  let b = 0x9747b28c
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    a = Math.imul(a ^ c, FNV_PRIME)
    b = Math.imul(b ^ c, FNV_PRIME)
    b ^= b >>> 15
  }
  const hex = (v: number): string => (v >>> 0).toString(16).padStart(8, '0')
  return (hex(a) + hex(b)).slice(0, n)
}

/** One file per project root, shared by every host (Claude Code, pi) that opens the same project. */
export function localPath(home: string, root: string): string {
  return `${home.replace(/\/+$/, '')}/.cache/project-board/view/${digest(root, 16)}.json`
}

const reviewTargets = (it: Item): string[] => it.links.filter(l => l.forReview).map(l => l.target)

/** Identifies one hand-in: when the AI reported it and which files it asked the user to look at. */
export function reviewPrint(it: Item): string {
  return `${it.reportedAt}|${digest([...reviewTargets(it)].sort().join('\n'), 12)}`
}

const hiddenOf = (lv: LocalView, ownerId: string): readonly string[] => lv.hidden[ownerId] ?? []

/** In review, not looked at in its current form, and with at least one entry still shown (or no entries at all). */
export function isWaiting(lv: LocalView, it: Item): boolean {
  if (it.status !== 'review') return false
  if (lv.seen[it.id] === reviewPrint(it)) return false
  const targets = reviewTargets(it)
  if (targets.length === 0) return true
  const hidden = hiddenOf(lv, it.id)
  return targets.some(t => !hidden.includes(t))
}

export function visibleLinks(lv: LocalView, ownerId: string, links: readonly Link[]): Link[] {
  const hidden = hiddenOf(lv, ownerId)
  return links.filter(l => !hidden.includes(l.target))
}

export function hiddenLinks(lv: LocalView, ownerId: string, links: readonly Link[]): Link[] {
  const hidden = hiddenOf(lv, ownerId)
  return links.filter(l => hidden.includes(l.target))
}

export function markSeen(lv: LocalView, it: Item): LocalView {
  return { ...lv, seen: { ...lv.seen, [it.id]: reviewPrint(it) } }
}

export function hideLink(lv: LocalView, ownerId: string, target: string): LocalView {
  const cur = hiddenOf(lv, ownerId)
  if (cur.includes(target)) return lv
  return { ...lv, hidden: { ...lv.hidden, [ownerId]: [...cur, target] } }
}

export function unhideLink(lv: LocalView, ownerId: string, target: string): LocalView {
  const cur = hiddenOf(lv, ownerId)
  if (!cur.includes(target)) return lv
  const { [ownerId]: _gone, ...rest } = lv.hidden
  const left = cur.filter(t => t !== target)
  return { ...lv, hidden: left.length === 0 ? rest : { ...rest, [ownerId]: left } }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Throws when the text is not a view-state document; entries of the wrong shape are dropped. */
function parseLocal(text: string): LocalView {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) throw new Error('not an object')
  const seen: Record<string, string> = {}
  const hidden: Record<string, string[]> = {}
  if (isRecord(raw.seen)) for (const [k, v] of Object.entries(raw.seen)) if (typeof v === 'string') seen[k] = v
  if (isRecord(raw.hidden)) {
    for (const [k, v] of Object.entries(raw.hidden)) {
      if (!Array.isArray(v)) continue
      const targets = v.filter((t): t is string => typeof t === 'string')
      if (targets.length > 0) hidden[k] = targets
    }
  }
  return { seen, hidden }
}

const isMissing = (err: unknown): boolean => /ENOENT|no such file/i.test(err instanceof Error ? err.message : String(err))

/**
 * The view state of one or more project files. Reads are cached in memory; every update re-reads the file first,
 * because Claude Code and pi may be writing the same one. A file that cannot be read or written leaves the in-memory
 * state in charge for the rest of the session, with one toast.
 */
export class LocalStore {
  private readonly cache = new Map<string, LocalView>()
  private readonly loading = new Map<string, Promise<void>>()
  /** Paths whose last write failed: the memory holds changes the file lacks, so it stays the base until a write lands. */
  private readonly unsaved = new Set<string>()
  private tail: Promise<void> = Promise.resolve()
  private warned = false

  constructor(private readonly host: Pick<Host, 'readText' | 'writeText' | 'toast'>) {}

  load(path: string): Promise<void> {
    let p = this.loading.get(path)
    if (p === undefined) {
      p = this.read(path).then(v => {
        if (!this.cache.has(path)) this.cache.set(path, v ?? EMPTY_LOCAL)
      })
      this.loading.set(path, p)
    }
    return p
  }

  get(path: string): LocalView {
    return this.cache.get(path) ?? EMPTY_LOCAL
  }

  update(path: string, fn: (v: LocalView) => LocalView): Promise<void> {
    const run = this.tail.then(async () => {
      const fresh = this.unsaved.has(path) ? null : await this.read(path)
      const next = fn(fresh ?? this.get(path))
      this.cache.set(path, next)
      try {
        await this.host.writeText(path, JSON.stringify(next, null, 2) + '\n')
        this.unsaved.delete(path)
      } catch {
        this.unsaved.add(path)
        this.warn('看板的本机视图状态写不进去，本次会话内的「看过了」和隐藏仍然有效')
      }
    })
    this.tail = run.catch(() => undefined)
    return run
  }

  /** The file's state; EMPTY_LOCAL when it does not exist; null when it cannot be read or parsed (after the toast). */
  private async read(path: string): Promise<LocalView | null> {
    let text: string
    try {
      text = await this.host.readText(path)
    } catch (err) {
      if (isMissing(err)) return EMPTY_LOCAL
      this.warn('看板的本机视图状态读不出来，已按空处理')
      return null
    }
    try {
      return parseLocal(text)
    } catch {
      this.warn('看板的本机视图状态文件已损坏，已按空处理')
      return null
    }
  }

  private warn(text: string): void {
    if (this.warned) return
    this.warned = true
    this.host.toast(text)
  }
}
