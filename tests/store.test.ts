import { describe, expect, test } from 'claude-code/testing'
import type { Host } from '../hooks/host'
import { applyOps, type Op } from '../hooks/model/ops'
import { emptyBoard, parseBoard, serializeBoard } from '../hooks/model/parse'
import { approve, propose } from '../hooks/model/propose'
import type { Board } from '../hooks/model/types'
import { BoardStore, NOT_ENABLED, type Change } from '../hooks/store'

const NOW = '2026-10-11T09:00:00+08:00'
const ctx = { now: NOW, session: 's1', actor: 'main' as const }
const note = (title: string): Op[] => [{ op: 'note.add', title }]
const addNote = (title: string) => (b: Board) => applyOps(b, note(title), ctx)

/** In-memory file system with a clock that ticks on every write and move. */
class Disk {
  files = new Map<string, { text: string; mtime: number }>()
  tick = 1000
  put(path: string, text: string): void {
    this.files.set(path, { text, mtime: ++this.tick })
  }
  text(path: string): string | undefined {
    return this.files.get(path)?.text
  }
}

type HostHooks = {
  beforeWrite?: (path: string) => void
  mvFails?: boolean
  delay?: boolean
  /** `run` rejects, as where process calls are not available. */
  noProcess?: boolean
  /** readText of these paths throws this message although the file exists. */
  unreadable?: { [path: string]: string }
}
type Spy = { writes: string[]; runs: string[][]; stats: number }
function fakeHost(disk: Disk, root: string, hooks: HostHooks = {}): Host & { spy: Spy } {
  const spy: Spy = { writes: [], runs: [], stats: 0 }
  const settle = async (): Promise<void> => {
    if (hooks.delay) for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return {
    spy,
    async readText(p) {
      await settle()
      const f = disk.files.get(p)
      if (!f) throw new Error(`ENOENT: ${p}`)
      const why = hooks.unreadable?.[p]
      if (why !== undefined) throw new Error(why)
      return f.text
    },
    async writeText(p, s) {
      await settle()
      spy.writes.push(p)
      hooks.beforeWrite?.(p)
      disk.put(p, s)
    },
    async exists(p) {
      return disk.files.has(p)
    },
    async listDir(p) {
      const prefix = p.endsWith('/') ? p : `${p}/`
      const names = new Map<string, 'file' | 'dir'>()
      for (const f of disk.files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        const i = rest.indexOf('/')
        names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
      }
      if (names.size === 0) throw new Error(`ENOENT: ${p}`)
      return [...names].map(([name, kind]) => ({ name, kind }))
    },
    async stat(p) {
      spy.stats++
      const f = disk.files.get(p)
      return f ? { mtimeMs: f.mtime } : null
    },
    async run(argv) {
      spy.runs.push([...argv])
      if (hooks.noProcess) throw new Error('process.run is not available here')
      if (argv[0] === 'rm') disk.files.delete(argv[2] as string)
      if (argv[0] === 'mv') {
        if (hooks.mvFails) return { code: 1, stdout: '', stderr: 'mv: permission denied' }
        const f = disk.files.get(argv[2] as string)
        if (!f) return { code: 1, stdout: '', stderr: 'no such file' }
        disk.files.delete(argv[2] as string)
        disk.put(argv[3] as string, f.text)
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    async root() {
      return root
    },
    async sessionId() {
      return 's1'
    },
    toast() {},
    status() {},
    async copy() {
      return true
    },
    async now() {
      return 0
    },
    async getState() {
      throw new Error('not used in store tests')
    },
    async setState() {
      throw new Error('not used in store tests')
    },
    async registerTool() {},
  }
}

const BOARD = '/proj/ai/board.json'
const TMP = '/proj/ai/.board.json.s1.tmp'
const mvRuns = (host: { spy: Spy }): string[][] => host.spy.runs.filter(a => a[0] === 'mv' && !(a[1] === '-f' && String(a[2]).endsWith('.probe')))
function seeded(extra: HostHooks = {}, root = '/proj') {
  const disk = new Disk()
  disk.put(BOARD, serializeBoard(emptyBoard('demo')))
  const host = fakeHost(disk, root, extra)
  return { disk, host, store: new BoardStore(host) }
}
function boardOf(disk: Disk): Board {
  const r = parseBoard(disk.text(BOARD) as string)
  if (!r.ok) throw new Error('file does not parse: ' + r.error)
  return r.board
}

describe('locate', () => {
  test('finds the project root from a subdirectory', async () => {
    const { store } = seeded({}, '/proj/sub/deeper')
    expect(await store.locate()).toBe('/proj')
    expect(store.current().root).toBe('/proj')
    expect(store.current().board?.project.name).toBe('demo')
  })

  test('returns null when no ancestor holds ai/board.json', async () => {
    const { store } = seeded({}, '/elsewhere/x')
    expect(await store.locate()).toBeNull()
    expect(store.current()).toEqual({ board: null, error: null, root: null, bytes: 0 })
  })

  test('the nearest board wins over one further up', async () => {
    const { disk, store } = seeded({}, '/proj/inner')
    disk.put('/proj/inner/ai/board.json', serializeBoard(emptyBoard('inner')))
    expect(await store.locate()).toBe('/proj/inner')
    expect(store.current().board?.project.name).toBe('inner')
  })
})

describe('commit', () => {
  test('writes rev + 1 through a temp file and mv, never straight to board.json', async () => {
    const { disk, host, store } = seeded()
    await store.locate()
    const r = await store.commit(addNote('a'), 'main')
    expect(r).toMatchObject({ ok: true, rev: 1 })
    expect(host.spy.writes).toEqual([TMP])
    expect(mvRuns(host)).toEqual([['mv', '-f', TMP, BOARD]])
    expect(boardOf(disk).rev).toBe(1)
    expect(boardOf(disk).notes.map(n => n.title)).toEqual(['a'])
    expect(disk.text(TMP)).toBeUndefined()
    expect(store.current().board?.rev).toBe(1)
  })

  test('a corrupt file is never overwritten', async () => {
    const { disk, store } = seeded()
    await store.locate()
    const broken = '{\n  "schema": 1,\n  "rev": 3,,\n}\n'
    disk.put(BOARD, broken)
    const r = await store.commit(addNote('a'), 'main')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('无法解析')
    expect(disk.text(BOARD)).toBe(broken)
    expect(disk.text(TMP)).toBeUndefined()
    expect(store.current().board).toBeNull()
    expect(store.current().error).toContain('第 3 行')
    // the line is named once, in the position of the refusal
    if (!r.ok) {
      expect(r.reason).toContain('位置：JSON 格式错误（第 3 行）')
      expect(r.reason.split('第 3 行').length - 1).toBe(1)
      expect(r.reason).toContain('不要覆盖它；请告诉用户，由用户决定如何恢复（例如从 git 恢复）')
    }
  })

  test('a schema newer than this code is refused, with advice that does not point at git', async () => {
    const { disk, store } = seeded()
    await store.locate()
    const future = JSON.stringify({ ...emptyBoard('x'), schema: 3 }, null, 2) + '\n'
    disk.put(BOARD, future)
    const r = await store.commit(addNote('a'), 'main')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('看板由更新版本的插件写入；请更新插件或重启会话，不要覆盖它或从 git 恢复')
      expect(r.reason).not.toContain('例如从 git 恢复')
    }
    expect(store.current().error).toContain('更新版本的插件')
    expect(disk.text(BOARD)).toBe(future)
  })

  test('a deleted file turns the store back to not enabled', async () => {
    const { disk, store } = seeded()
    await store.locate()
    disk.files.delete(BOARD)
    const polled = await store.poll()
    expect(polled.changed).toBe(true)
    expect(store.current()).toMatchObject({ board: null, root: null, error: null })
    const r = await store.commit(addNote('a'), 'main')
    expect(r).toEqual({ ok: false, index: 0, reason: NOT_ENABLED })
    expect(disk.text(BOARD)).toBeUndefined()
  })

  test('deleting the file between polls is also caught by commit', async () => {
    const { disk, store } = seeded()
    await store.locate()
    disk.files.delete(BOARD)
    const r = await store.commit(addNote('a'), 'main')
    expect(r.ok).toBe(false)
    expect(store.current().root).toBeNull()
    expect(disk.files.size).toBe(0)
  })

  test('a failing operation leaves the file and the temp path untouched', async () => {
    const { disk, host, store } = seeded()
    await store.locate()
    const before = disk.text(BOARD)
    const r = await store.commit(b => applyOps(b, [...note('ok'), { op: 'item.update', id: 'nope' }], ctx), 'main')
    expect(r).toMatchObject({ ok: false, index: 1 })
    expect(disk.text(BOARD)).toBe(before)
    expect(host.spy.writes).toEqual([])
  })

  test('a failing mv falls back to writing the board file in place, and leaves no temp file', async () => {
    const { disk, store } = seeded({ mvFails: true })
    await store.locate()
    const r = await store.commit(addNote('a'), 'main')
    expect(r).toMatchObject({ ok: true, rev: 1 })
    expect(boardOf(disk).notes.map(n => n.title)).toEqual(['a'])
    expect(disk.text(TMP)).toBeUndefined()
  })

  test('where process calls are not available the board file is written in place, never through a temp file', async () => {
    const { disk, host, store } = seeded({ noProcess: true })
    await store.locate()
    expect(await store.commit(addNote('a'), 'main')).toMatchObject({ ok: true, rev: 1 })
    expect(await store.commit(addNote('b'), 'agent')).toMatchObject({ ok: true, rev: 2 })
    expect(host.spy.writes).toEqual([BOARD, BOARD])
    expect(boardOf(disk).notes.map(n => n.title)).toEqual(['a', 'b'])
    // mv was probed once, not once per write
    expect(host.spy.runs.length).toBe(1)
  })

  test('the temp file carries the session id, so two sessions never share one', async () => {
    const { host, store } = seeded()
    await store.locate()
    await store.commit(addNote('a'), 'main')
    expect(host.spy.writes).toEqual(['/proj/ai/.board.json.s1.tmp'])
  })

  test('a file that cannot be read is an error state, not a deleted board', async () => {
    const { disk, store } = seeded({ unreadable: { [BOARD]: '文件超过 4 MiB' } })
    expect(await store.locate()).toBe('/proj')
    expect(store.current().board).toBeNull()
    expect(store.current().error).toContain('无法读取')
    expect(store.current().error).toContain('4 MiB')
    expect(store.current().root).toBe('/proj')
    const before = disk.text(BOARD)
    const r = await store.commit(addNote('a'), 'main')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('无法读取')
      expect(r.reason).not.toContain('board_init')
    }
    expect(disk.text(BOARD)).toBe(before)
  })

  test('a board that turns unreadable keeps its root, tells listeners once, and comes back when readable', async () => {
    const hooks: HostHooks = {}
    const { disk, store } = seeded(hooks)
    const seen: Change[] = []
    store.onChange(c => seen.push(c))
    await store.locate()
    hooks.unreadable = { [BOARD]: 'EACCES' }
    disk.put(BOARD, disk.text(BOARD) as string)
    await store.poll()
    await store.poll()
    expect(store.current()).toMatchObject({ board: null, root: '/proj' })
    expect(store.current().error).toContain('EACCES')
    expect(seen.length).toBe(1)
    expect(seen[0]).toMatchObject({ source: 'external', after: null })
    hooks.unreadable = {}
    const back = await store.poll()
    expect(back.changed).toBe(true)
    expect(store.current().board?.project.name).toBe('demo')
  })

  test('commit on an unreadable file is not mistaken for a deleted one', async () => {
    const hooks: HostHooks = {}
    const { store } = seeded(hooks)
    await store.locate()
    hooks.unreadable = { [BOARD]: 'EACCES' }
    const r = await store.commit(addNote('a'), 'main')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('EACCES')
    expect(store.current().root).toBe('/proj')
  })

  test('two concurrent commits run one after the other: rev is consecutive, both changes land', async () => {
    const { disk, store } = seeded({ delay: true })
    await store.locate()
    const [a, b] = await Promise.all([store.commit(addNote('first'), 'main'), store.commit(addNote('second'), 'agent')])
    expect(a).toMatchObject({ ok: true, rev: 1 })
    expect(b).toMatchObject({ ok: true, rev: 2 })
    expect(boardOf(disk).notes.map(n => n.title).sort()).toEqual(['first', 'second'])
    expect(boardOf(disk).rev).toBe(2)
  })

  test('file rewritten between our read and our write: the later write wins (design 4.6, accepted risk)', async () => {
    let external: (() => void) | null = null
    const { disk, store } = seeded({
      beforeWrite: p => {
        if (p === TMP && external) {
          external()
          external = null
        }
      },
    })
    await store.locate()
    external = () => {
      const b = boardOf(disk)
      disk.put(BOARD, serializeBoard({ ...b, rev: b.rev + 1, notes: [{ id: 'n-ext000', title: 'ext', text: '', group: '' }] }))
    }
    const r = await store.commit(addNote('ours'), 'main')
    expect(r).toMatchObject({ ok: true })
    const titles = boardOf(disk).notes.map(n => n.title)
    expect(titles).toEqual(['ours'])
    expect(titles).not.toContain('ext')
  })

  test('result carries the board as it was before the write', async () => {
    const { store } = seeded()
    await store.locate()
    const r = await store.commit(addNote('a'), 'user')
    if (!r.ok) throw new Error('expected ok')
    expect(r.before.notes).toHaveLength(0)
    expect(r.board.notes).toHaveLength(1)
  })
})

describe('poll and onChange', () => {
  test('our own write is not reported as an external change', async () => {
    const { store } = seeded()
    await store.locate()
    const seen: Change[] = []
    store.onChange(c => seen.push(c))
    await store.commit(addNote('a'), 'main')
    expect(await store.poll()).toEqual({ changed: false })
    expect(seen.map(c => c.source)).toEqual(['main'])
  })

  test('an external rewrite is reported with before and after', async () => {
    const { disk, store } = seeded()
    await store.locate()
    const seen: Change[] = []
    store.onChange(c => seen.push(c))
    const b = boardOf(disk)
    disk.put(BOARD, serializeBoard({ ...b, rev: 7, project: { name: 'renamed' } }))
    const r = await store.poll()
    expect(r.changed).toBe(true)
    expect(r.before?.rev).toBe(0)
    expect(r.after?.rev).toBe(7)
    expect(store.current().board?.project.name).toBe('renamed')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.source).toBe('external')
    expect(await store.poll()).toEqual({ changed: false })
  })

  test('touching the file without changing its text is not a change', async () => {
    const { disk, store } = seeded()
    await store.locate()
    disk.put(BOARD, disk.text(BOARD) as string)
    expect(await store.poll()).toEqual({ changed: false })
  })

  test('an external change that happens right before a commit is still reported', async () => {
    const { disk, store } = seeded()
    await store.locate()
    const seen: Change[] = []
    store.onChange(c => seen.push(c))
    const b = boardOf(disk)
    disk.put(BOARD, serializeBoard({ ...b, rev: 4, notes: [{ id: 'n-ext000', title: 'ext', text: '', group: '' }] }))
    const r = await store.commit(addNote('ours'), 'main')
    expect(r).toMatchObject({ ok: true, rev: 5 })
    expect(boardOf(disk).notes.map(n => n.title)).toEqual(['ext', 'ours'])
    expect(seen.map(c => c.source)).toEqual(['external', 'main'])
    expect(seen[0]?.after?.rev).toBe(4)
    expect(await store.poll()).toEqual({ changed: false })
  })

  test('an external edit that breaks the file shows the error and drops the board', async () => {
    const { disk, store } = seeded()
    await store.locate()
    disk.put(BOARD, '{ not json')
    const r = await store.poll()
    expect(r.changed).toBe(true)
    expect(r.after).toBeUndefined()
    expect(store.current().board).toBeNull()
    expect(store.current().error).toContain('无法解析')
    expect(store.current().root).toBe('/proj')
  })

  test('a board that appears later is picked up by poll', async () => {
    const disk = new Disk()
    const store = new BoardStore(fakeHost(disk, '/proj'))
    expect(await store.locate()).toBeNull()
    expect(await store.poll()).toEqual({ changed: false })
    disk.put(BOARD, serializeBoard(emptyBoard('late')))
    const r = await store.poll()
    expect(r.changed).toBe(true)
    expect(store.current().board?.project.name).toBe('late')
  })
})

describe('init and size', () => {
  test('init creates the board once', async () => {
    const disk = new Disk()
    const host = fakeHost(disk, '/proj')
    const store = new BoardStore(host)
    await store.locate()
    await store.init('记账小程序')
    expect(boardOf(disk).project.name).toBe('记账小程序')
    expect(mvRuns(host)).toEqual([['mv', '-f', TMP, BOARD]])
    expect(store.current().root).toBe('/proj')
    await expect(store.init('again')).rejects.toThrow('看板已存在')
  })

  test('init refuses inside a project that already has a board further up', async () => {
    const { store } = seeded({}, '/proj/sub')
    await expect(store.init('x')).rejects.toThrow('看板已存在')
  })

  test('init without a name uses the directory name', async () => {
    const disk = new Disk()
    const store = new BoardStore(fakeHost(disk, '/work/my-app/'))
    await store.init('  ')
    expect((parseBoard(disk.text('/work/my-app/ai/board.json') as string) as { board: Board }).board.project.name).toBe('my-app')
  })

  test('bytes counts UTF-8 bytes of the file', async () => {
    const { disk, store } = seeded()
    await store.locate()
    expect(store.current().bytes).toBe((disk.text(BOARD) as string).length)
    await store.commit(addNote('中文标题'), 'main')
    const text = disk.text(BOARD) as string
    expect(store.current().bytes).toBeGreaterThan(text.length)
    expect(store.current().bytes).toBe(new TextEncoder().encode(text).length)
  })
})

describe('steps and the store', () => {
  test('commit writes schema 2 once a step exists and schema 1 again after the last one is gone', async () => {
    const { disk, store } = seeded()
    await store.locate()
    const withGoal = (b: Board): Board => ({ ...b, goals: [{ id: 'g-1', title: 'G', outcome: '', status: 'active', links: [], steps: [], items: [], createdAt: NOW, updatedAt: NOW }] })
    await store.commit(b => ({ ok: true, board: withGoal(b), events: [] }), 'main')
    expect(disk.text(BOARD)).toContain('"schema": 1')
    const added = await store.commit(b => applyOps(b, [{ op: 'step.add', goalId: 'g-1', title: 'A' }], ctx), 'main')
    if (!added.ok) throw new Error('expected ok')
    expect(disk.text(BOARD)).toContain('"schema": 2')
    expect(disk.text(BOARD)).toContain('"steps": [')
    const id = added.events[0]?.id as string
    await store.commit(b => applyOps(b, [{ op: 'step.remove', id }], ctx), 'main')
    expect(disk.text(BOARD)).toContain('"schema": 1')
    expect(disk.text(BOARD)).not.toContain('"steps"')
  })

  test('onChange hands over the previous board, the new board and the source for a merge', async () => {
    const { store } = seeded()
    await store.locate()
    const mkGoal = (id: string): Board['goals'][number] => ({ id, title: id, outcome: '', status: 'active', links: [], steps: [], items: [], createdAt: NOW, updatedAt: NOW })
    await store.commit(b => ({ ok: true, board: { ...b, goals: [mkGoal('g-1'), mkGoal('g-2')] }, events: [] }), 'main')
    const seen: Change[] = []
    store.onChange(c => seen.push(c))
    const prop = await store.commit(b => propose(b, 'goal.merge', { title: 'M', goalIds: ['g-1', 'g-2'] }, '', ctx), 'main')
    if (!prop.ok) throw new Error('expected ok')
    const done = await store.commit(b => approve(b, prop.events[0]?.id as string, { ...ctx, actor: 'user' }, 'sidebar'), 'user')
    expect(done.ok).toBe(true)
    const last = seen.at(-1)!
    expect(last.source).toBe('user')
    expect(last.before?.goals.map(g => g.id)).toEqual(['g-1', 'g-2'])
    expect(last.after?.goals.map(g => g.title)).toEqual(['M'])
    expect(last.events[0]?.kind).toBe('goal.merge')
  })

  test('a file with steps is read back after a restart of the store', async () => {
    const { disk, store } = seeded()
    await store.locate()
    await store.commit(b => ({ ok: true, board: { ...b, goals: [{ id: 'g-1', title: 'G', outcome: '', status: 'active', links: [], steps: [], items: [], createdAt: NOW, updatedAt: NOW }] }, events: [] }), 'main')
    await store.commit(b => applyOps(b, [{ op: 'step.add', goalId: 'g-1', title: 'A' }], ctx), 'main')
    const fresh = new BoardStore(fakeHost(disk, '/proj'))
    await fresh.locate()
    expect(fresh.current().board?.goals[0]?.steps.map(s => s.title)).toEqual(['A'])
  })
})
