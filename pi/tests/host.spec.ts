import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyOps } from '../../hooks/model/ops'
import { emptyBoard, serializeBoard } from '../../hooks/model/parse'
import { BoardStore } from '../../hooks/store'
import { nodeHost } from '../host'

let dir = ''
const host = () => nodeHost({ cwd: dir, sessionId: () => 'sess-1', notify: () => undefined, status: () => undefined, registerTool: () => undefined })
const ctx = { now: '2026-10-11T09:00:00+08:00', session: 's', actor: 'main' as const }
const addNote = (title: string) => (b: Parameters<typeof applyOps>[0]) => applyOps(b, [{ op: 'note.add', title }], ctx)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-host-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('nodeHost', () => {
  test('files: write makes missing directories; read, exists, stat, list agree', async () => {
    const h = host()
    const p = join(dir, 'a', 'b', 'f.txt')
    expect(await h.exists(p)).toBe(false)
    expect(await h.stat(p)).toBeNull()
    await h.writeText(p, '你好')
    expect(await h.readText(p)).toBe('你好')
    expect(await h.exists(p)).toBe(true)
    expect((await h.stat(p))?.mtimeMs).toBeGreaterThan(0)
    expect(await h.listDir(join(dir, 'a'))).toEqual([{ name: 'b', kind: 'dir' }])
    await expect(h.listDir(join(dir, 'nope'))).rejects.toThrow()
  })

  test('run: a non-zero exit is a result, a command that cannot start rejects', async () => {
    const h = host()
    expect(await h.run(['sh', '-c', 'echo hi; exit 3'])).toMatchObject({ code: 3, stdout: 'hi\n' })
    await expect(h.run(['definitely-not-a-command-xyz'])).rejects.toThrow()
  })

  test('per-conversation state is kept in memory, empty until written', async () => {
    const h = host()
    expect(await h.getState('snapshot')).toBeNull()
    expect(await h.getState('untold')).toEqual([])
    await h.setState('untold', ['x'])
    await h.setState('stale', true)
    expect(await h.getState('untold')).toEqual(['x'])
    expect(await h.getState('stale')).toBe(true)
  })
})

describe('the store on the real file system', () => {
  test('init creates ai/board.json; a commit goes through temp file and mv and leaves no litter', async () => {
    const store = new BoardStore(host())
    await store.init('demo', '', 'main')
    const r = await store.commit(addNote('a'), 'main')
    expect(r).toMatchObject({ ok: true, rev: 1 })
    expect(await readdir(join(dir, 'ai'))).toEqual(['board.json'])
    expect(JSON.parse(await readFile(join(dir, 'ai', 'board.json'), 'utf8')).notes[0].title).toBe('a')
  })

  test('two hosts on one project take turns: each commit starts from what the other wrote', async () => {
    await mkdir(join(dir, 'ai'))
    await writeFile(join(dir, 'ai', 'board.json'), serializeBoard(emptyBoard('demo')))
    const a = new BoardStore(host())
    const b = new BoardStore(host())
    await a.locate()
    await b.locate()
    for (let i = 0; i < 5; i++) {
      expect(await a.commit(addNote(`a${i}`), 'main')).toMatchObject({ ok: true })
      expect(await b.commit(addNote(`b${i}`), 'agent')).toMatchObject({ ok: true })
    }
    const file = JSON.parse(await readFile(join(dir, 'ai', 'board.json'), 'utf8'))
    expect(file.rev).toBe(10)
    expect(file.notes).toHaveLength(10)
  })

  test('what one host wrote is an external change to the other, and is picked up by poll', async () => {
    await mkdir(join(dir, 'ai'))
    await writeFile(join(dir, 'ai', 'board.json'), serializeBoard(emptyBoard('demo')))
    const a = new BoardStore(host())
    const b = new BoardStore(host())
    await a.locate()
    await b.locate()
    const seen: string[] = []
    b.onChange(c => seen.push(c.source))
    await new Promise(r => setTimeout(r, 20))
    await a.commit(addNote('from a'), 'main')
    expect((await b.poll()).changed).toBe(true)
    expect(seen).toEqual(['external'])
    expect(b.current().board?.notes[0]?.title).toBe('from a')
  })
})
