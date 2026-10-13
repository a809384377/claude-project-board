import type { Host } from './host'
import type { ApplyResult, BoardEvent } from './model/ops'
import { emptyBoard, NEWER_SCHEMA_TEXT, parseBoard, serializeBoard } from './model/parse'
import { propose } from './model/propose'
import type { Board } from './model/types'
import { activeSprints, sprintProposal } from './sprints'
import { isoLocal } from './time'

const BOARD_REL = 'ai/board.json'
const TMP_PREFIX = 'ai/.board.json.'

export type Actor = 'main' | 'agent' | 'user'

export type CommitResult =
  | { ok: true; board: Board; events: BoardEvent[]; rev: number; before: Board }
  | { ok: false; index: number; reason: string }

/** Something changed the in-memory board: one of our commits, or a write we did not make. */
export type Change = {
  source: 'external' | Actor
  before: Board | null
  after: Board | null
  events: BoardEvent[]
}

/** `place` found the board changed under it. */
const CONFLICT = Symbol('conflict')
/** How many times a commit starts over on the new content when another process writes the board during it. */
const COMMIT_ATTEMPTS = 4

export const NOT_ENABLED = '当前项目没有看板（找不到 ai/board.json）。用户要求时可调用 board_init 创建'

function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)
const parentOf = (dir: string): string | null => {
  if (dir === '/' || dir === '' || /^[A-Za-z]:[\\/]?$/.test(dir)) return null
  const i = dir.lastIndexOf('/')
  if (i < 0) return null
  return i === 0 ? '/' : dir.slice(0, i)
}
const join = (dir: string, rel: string): string => (dir.endsWith('/') ? dir + rel : `${dir}/${rel}`)
const baseName = (dir: string): string => dir.slice(dir.lastIndexOf('/') + 1) || dir

/**
 * Holds the one board file of a project. Reads and writes go through a single queue, so two commits
 * never interleave; a commit always starts from the file as it is on disk, not from memory.
 */
export class BoardStore {
  private rootDir: string | null = null
  private board: Board | null = null
  private errorText: string | null = null
  /** The file exists but could not be read (too large, permissions): retried at every poll. */
  private unreadable = false
  /** Whether `mv` can be run: null until probed once. Without it the board file is written in place. */
  private canMove: boolean | null = null
  private size = 0
  /** Text and mtime of the file as this store last saw or wrote it. */
  private lastText: string | null = null
  private lastMtime = 0
  private tail: Promise<unknown> = Promise.resolve()
  private listeners: Array<(c: Change) => void> = []

  constructor(private readonly host: Host) {}

  /** Register a listener for every change of the board: our commits and writes by others. */
  onChange(fn: (c: Change) => void): void {
    this.listeners.push(fn)
  }
  private notify(c: Change): void {
    for (const fn of this.listeners) {
      try {
        fn(c)
      } catch {
        // a listener's failure must not break the store
      }
    }
  }

  current(): { board: Board | null; error: string | null; root: string | null; bytes: number } {
    return { board: this.board, error: this.errorText, root: this.rootDir, bytes: this.size }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return await this.host.exists(path)
    } catch {
      return false
    }
  }

  /** First directory, from the session root upward, that holds ai/board.json. */
  private async findRoot(): Promise<string | null> {
    let dir: string | null = trimSlash(await this.host.root())
    while (dir !== null) {
      if (await this.exists(join(dir, BOARD_REL))) return dir
      dir = parentOf(dir)
    }
    return null
  }

  /** Finds the project root and loads the board. Returns null when there is no board. */
  locate(): Promise<string | null> {
    return this.enqueue(async () => {
      const root = await this.findRoot()
      if (root === null) {
        this.reset()
        return null
      }
      this.rootDir = root
      await this.load(false)
      return root
    })
  }

  private reset(): void {
    this.rootDir = null
    this.board = null
    this.errorText = null
    this.unreadable = false
    this.size = 0
    this.lastText = null
    this.lastMtime = 0
  }

  /** Reads the file and adopts it. Notifies listeners when the text differs from what was last seen. */
  private async load(announce: boolean): Promise<void> {
    const path = join(this.rootDir as string, BOARD_REL)
    const read = await this.readFile(path)
    if (!read.ok) {
      if (read.missing) this.vanish()
      else this.markUnreadable(read.error, announce)
      return
    }
    this.observe(read.text, read.mtime, announce)
  }

  /** Text and mtime of the file, or why there is none: `missing` is true only when the file is not there. */
  private async readFile(path: string): Promise<{ ok: true; text: string; mtime: number } | { ok: false; missing: boolean; error: string }> {
    try {
      const text = await this.host.readText(path)
      const mtime = (await this.host.stat(path))?.mtimeMs ?? 0
      return { ok: true, text, mtime }
    } catch (e) {
      return { ok: false, missing: !(await this.exists(path)), error: (e as Error).message }
    }
  }

  /** The file is there but cannot be read: show why, refuse writes, do not treat it as deleted. */
  private markUnreadable(error: string, announce: boolean): void {
    const before = this.board
    const text = `ai/board.json 无法读取：${error}`
    const changed = before !== null || this.errorText !== text
    this.board = null
    this.errorText = text
    this.unreadable = true
    this.lastText = null
    this.size = 0
    if (announce && changed) this.notify({ source: 'external', before, after: null, events: [] })
  }

  private observe(text: string, mtime: number, announce: boolean): void {
    const before = this.board
    const changed = text !== this.lastText
    const parsed = parseBoard(text)
    this.lastText = text
    this.lastMtime = mtime
    this.size = utf8Bytes(text)
    this.unreadable = false
    if (parsed.ok) {
      this.board = parsed.board
      this.errorText = null
    } else {
      this.board = null
      this.errorText = parsed.error.startsWith(NEWER_SCHEMA_TEXT) ? `ai/board.json：${parsed.error}` : `ai/board.json 无法解析：${parsed.error}`
    }
    if (announce && changed) this.notify({ source: 'external', before, after: this.board, events: [] })
  }

  private vanish(): void {
    const before = this.board
    const had = before !== null || this.errorText !== null
    this.reset()
    if (had) this.notify({ source: 'external', before, after: null, events: [] })
  }

  /** A temp file name of this session, so two sessions never share one. */
  private async tmpPath(root: string): Promise<string> {
    const sid = (await this.host.sessionId().catch(() => '')).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
    return join(root, `${TMP_PREFIX}${sid === '' ? 'local' : sid}.tmp`)
  }

  /**
   * Puts `text` at `path`: into a temp file, then `mv` over the board, so a reader never sees half a file.
   * Where `mv` cannot be run (the engine's process calls are CLI only; Windows has no mv) or fails, the
   * board file is written in place instead. Returns an error text, or null when the file was written.
   * `unchanged`, when given, is asked right before the file is replaced: false means somebody else wrote
   * the board in the meantime, nothing is replaced and CONFLICT comes back.
   */
  private async place(root: string, path: string, text: string, unchanged?: () => Promise<boolean>): Promise<string | typeof CONFLICT | null> {
    const tmp = await this.tmpPath(root)
    if (this.canMove === null) {
      // Starts mv on files that do not exist: it can only exit non-zero, which shows that it ran.
      this.canMove = await this.host.run(['mv', '-f', `${tmp}.probe`, `${tmp}.probe2`]).then(
        () => true,
        () => false,
      )
    }
    if (this.canMove) {
      await this.host.writeText(tmp, text)
      if (unchanged && !(await unchanged())) {
        await this.host.run(['rm', '-f', tmp]).catch(() => undefined)
        return CONFLICT
      }
      const mv = await this.host.run(['mv', '-f', tmp, path]).catch(() => null)
      if (mv !== null && mv.code === 0) return null
      await this.host.run(['rm', '-f', tmp]).catch(() => undefined)
    }
    if (unchanged && !(await unchanged())) return CONFLICT
    await this.host.writeText(path, text)
    return null
  }

  /**
   * Applies `fn` to the latest file content and writes the result with rev + 1.
   * Refuses (file untouched) when there is no board, the file does not parse, or `fn` fails.
   */
  commit(fn: (b: Board) => ApplyResult, actor: Actor): Promise<CommitResult> {
    return this.enqueue(async (): Promise<CommitResult> => {
      const bad = (reason: string): CommitResult => ({ ok: false, index: 0, reason })
      if (this.rootDir === null) {
        const root = await this.findRoot()
        if (root === null) return bad(NOT_ENABLED)
        this.rootDir = root
      }
      const root = this.rootDir
      const path = join(root, BOARD_REL)
      // Another process (a second agent host on the same project) may write the board while this commit
      // works: before the file is replaced it is read once more, and a commit that lost starts over on the new content.
      for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
        const read = await this.readFile(path)
        if (!read.ok) {
          if (read.missing) {
            this.vanish()
            return bad(NOT_ENABLED)
          }
          this.markUnreadable(read.error, true)
          return bad(`看板文件无法读取（${read.error}）。未写入任何内容；请告诉用户，由用户检查文件大小与权限`)
        }
        // The file may have been changed by someone else since we last looked: adopt it first, so
        // listeners learn about it and the write below starts from the real content.
        this.observe(read.text, read.mtime, this.lastText !== null)
        if (this.board === null) {
          if (this.errorText?.includes(NEWER_SCHEMA_TEXT)) return bad(`${this.errorText.replace(/^ai\/board\.json：/, '')}。未写入任何内容`)
          return bad(`看板文件无法解析（位置：${this.errorText?.replace(/^ai\/board\.json 无法解析：/, '')}）。不要覆盖它；请告诉用户，由用户决定如何恢复（例如从 git 恢复）`)
        }

        const before = this.board
        let res: ApplyResult
        try {
          res = fn(before)
        } catch (e) {
          return bad(`操作失败：${(e as Error).message}`)
        }
        if (!res.ok) return res

        const next: Board = { ...res.board, rev: before.rev + 1 }
        const out = serializeBoard(next)
        try {
          const failure = await this.place(root, path, out, () => this.host.readText(path).then(t => t === read.text, () => false))
          if (failure === CONFLICT) continue
          if (failure !== null) return bad(failure)
          const st = await this.host.stat(path)
          this.lastMtime = st?.mtimeMs ?? 0
        } catch (e) {
          return bad(`写入失败：${(e as Error).message}`)
        }
        this.board = next
        this.errorText = null
        this.lastText = out
        this.size = utf8Bytes(out)
        this.notify({ source: actor, before, after: next, events: res.events })
        return { ok: true, board: next, events: res.events, rev: next.rev, before }
      }
      return bad('看板文件正被别处反复改写，这次没有写入任何内容；稍后重试')
    })
  }

  /**
   * Looks at the file once. Writes by this store are skipped (their mtime is remembered); anything
   * else reloads the board and is reported both here and to the onChange listeners.
   */
  poll(): Promise<{ changed: boolean; before?: Board; after?: Board }> {
    return this.enqueue(async () => {
      const none = { changed: false }
      try {
        if (this.rootDir === null) {
          const root = await this.findRoot()
          if (root === null) return none
          this.rootDir = root
          await this.load(false)
          const after = this.board
          this.notify({ source: 'external', before: null, after, events: [] })
          return after ? { changed: true, after } : { changed: true }
        }
        const path = join(this.rootDir, BOARD_REL)
        const st = await this.host.stat(path)
        if (st === null) {
          const before = this.board
          this.vanish()
          return before ? { changed: true, before } : { changed: true }
        }
        if (st.mtimeMs === this.lastMtime && !this.unreadable) return none
        const before = this.board
        const read = await this.readFile(path)
        if (!read.ok) {
          if (read.missing) {
            this.vanish()
            return before ? { changed: true, before } : { changed: true }
          }
          const seen = this.errorText
          this.markUnreadable(read.error, true)
          return this.errorText === seen && before === null ? none : before ? { changed: true, before } : { changed: true }
        }
        const same = read.text === this.lastText
        this.observe(read.text, st.mtimeMs, true)
        if (same) return none
        const out: { changed: boolean; before?: Board; after?: Board } = { changed: true }
        if (before) out.before = before
        if (this.board) out.after = this.board
        return out
      } catch {
        return none
      }
    })
  }

  /**
   * Creates ai/board.json in the session root, with an optional project type (for example "miniapp").
   * Every sprint in progress under ai/sprints/active/ gets a goal.create proposal waiting for the user.
   * Resolves to the number of proposals made. Throws when a board already exists in the project.
   * Listeners hear about the new board.
   */
  init(name: string, type = '', actor: Actor = 'main'): Promise<number> {
    return this.enqueue(async () => {
      const existing = await this.findRoot()
      if (existing !== null) throw new Error(`看板已存在：${join(existing, BOARD_REL)}`)
      const dir = trimSlash(await this.host.root())
      let board = emptyBoard(name.trim() === '' ? baseName(dir) : name.trim())
      if (type.trim() !== '') board.project.type = type.trim()
      const ctx = { now: isoLocal(await this.host.now()), session: await this.host.sessionId().catch(() => ''), actor }
      let made = 0
      for (const sprint of await activeSprints(this.host, dir)) {
        const { payload, reason } = sprintProposal(sprint)
        const r = propose(board, 'goal.create', payload, reason, ctx)
        if (!r.ok) continue
        board = r.board
        made++
      }
      await this.place(dir, join(dir, BOARD_REL), serializeBoard(board))
      this.rootDir = dir
      await this.load(false)
      this.notify({ source: actor, before: null, after: this.board, events: [] })
      return made
    })
  }
}
