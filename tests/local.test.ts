import { describe, expect, test } from 'claude-code/testing'
import type { Item, Link } from '../hooks/model/types'
import { EMPTY_LOCAL, hiddenLinks, hideLink, isWaiting, LocalStore, localPath, markSeen, reviewPrint, unhideLink, visibleLinks, type LocalView } from '../hooks/view/local'

const NOW = '2026-10-12T09:00:00+08:00'
const link = (target: string, forReview = true): Link => ({ type: 'path', kind: '报告', target, label: '', forReview })
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, title: `事项 ${id}`, stepId: '', status: 'review', owner: '', note: '', waitingFor: '', dependsOn: [], scope: [], acceptance: '', links: [],
  noReviewTargetReason: '', reportedAt: NOW, session: '', doneBy: '', createdAt: NOW, updatedAt: NOW, doneAt: '', ...over,
})

describe('reviewPrint', () => {
  test('is reportedAt plus a short hash of the sorted forReview targets', () => {
    const a = item('a', { links: [link('x.md'), link('y.md')] })
    const b = item('a', { links: [link('y.md'), link('x.md')] })
    expect(reviewPrint(a)).toBe(reviewPrint(b))
    expect(reviewPrint(a)).toMatch(/^2026-10-12T09:00:00\+08:00\|[0-9a-f]{12}$/)
  })

  test('links that are not forReview do not count', () => {
    expect(reviewPrint(item('a', { links: [link('x.md'), link('n.md', false)] }))).toBe(reviewPrint(item('a', { links: [link('x.md')] })))
  })

  test('a different target set gives a different print', () => {
    expect(reviewPrint(item('a', { links: [link('x.md')] }))).not.toBe(reviewPrint(item('a', { links: [link('x.md'), link('z.md')] })))
  })
})

describe('localPath', () => {
  test('is under the home cache folder, 16 hex digits per project root', () => {
    const p = localPath('/Users/me/', '/work/proj')
    expect(p).toMatch(/^\/Users\/me\/\.cache\/project-board\/view\/[0-9a-f]{16}\.json$/)
    expect(localPath('/Users/me', '/work/proj')).toBe(p)
    expect(localPath('/Users/me', '/work/other')).not.toBe(p)
  })
})

describe('isWaiting', () => {
  const it1 = item('a', { links: [link('x.md')] })

  test('an item in review that nobody looked at is waiting; other statuses are not', () => {
    expect(isWaiting(EMPTY_LOCAL, it1)).toBe(true)
    expect(isWaiting(EMPTY_LOCAL, item('a', { status: 'done', links: [link('x.md')] }))).toBe(false)
    expect(isWaiting(EMPTY_LOCAL, item('a', { status: 'running' }))).toBe(false)
  })

  test('a matching seen print means looked at; a different one means waiting again', () => {
    expect(isWaiting(markSeen(EMPTY_LOCAL, it1), it1)).toBe(false)
    expect(isWaiting({ seen: { a: 'old|print' }, hidden: {} }, it1)).toBe(true)
  })

  test('a new reportedAt brings the item back', () => {
    const seen = markSeen(EMPTY_LOCAL, it1)
    expect(isWaiting(seen, { ...it1, reportedAt: '2026-10-12T11:00:00+08:00' })).toBe(true)
  })

  test('a changed set of entries brings the item back', () => {
    const seen = markSeen(EMPTY_LOCAL, it1)
    expect(isWaiting(seen, { ...it1, links: [link('x.md'), link('new.md')] })).toBe(true)
    expect(isWaiting(seen, { ...it1, links: [] })).toBe(true)
  })

  test('a review item with no entries at all is waiting, and can be marked seen', () => {
    const bare = item('b')
    expect(isWaiting(EMPTY_LOCAL, bare)).toBe(true)
    expect(isWaiting(markSeen(EMPTY_LOCAL, bare), bare)).toBe(false)
  })

  test('hiding every entry counts as seen', () => {
    const two = item('a', { links: [link('x.md'), link('y.md')] })
    const one = hideLink(EMPTY_LOCAL, 'a', 'x.md')
    expect(isWaiting(one, two)).toBe(true)
    expect(isWaiting(hideLink(one, 'a', 'y.md'), two)).toBe(false)
  })

  test('an entry the AI adds after everything was hidden brings the item back', () => {
    const all = hideLink(hideLink(EMPTY_LOCAL, 'a', 'x.md'), 'a', 'y.md')
    expect(isWaiting(all, item('a', { links: [link('x.md'), link('y.md'), link('fresh.md')] }))).toBe(true)
  })

  test('forReview=false links do not take part in the all-hidden check', () => {
    const lv = hideLink(EMPTY_LOCAL, 'a', 'x.md')
    expect(isWaiting(lv, item('a', { links: [link('x.md'), link('n.md', false)] }))).toBe(false)
  })

  test('entries hidden under another owner do not count', () => {
    expect(isWaiting(hideLink(EMPTY_LOCAL, 'goal-1', 'x.md'), it1)).toBe(true)
  })
})

describe('hiding links', () => {
  const links = [link('x.md'), link('y.md')]

  test('hiding applies only to the owner that was clicked', () => {
    const lv = hideLink(EMPTY_LOCAL, 'item-1', 'x.md')
    expect(visibleLinks(lv, 'item-1', links).map(l => l.target)).toEqual(['y.md'])
    expect(hiddenLinks(lv, 'item-1', links).map(l => l.target)).toEqual(['x.md'])
    expect(visibleLinks(lv, 'goal-1', links).map(l => l.target)).toEqual(['x.md', 'y.md'])
    expect(hiddenLinks(lv, 'goal-1', links)).toEqual([])
  })

  test('the same file on a goal and an item is hidden only where it was hidden', () => {
    const lv = hideLink(EMPTY_LOCAL, 'goal-1', 'x.md')
    const onItem = item('item-1', { links: [link('x.md')] })
    expect(visibleLinks(lv, 'goal-1', [link('x.md')])).toEqual([])
    expect(visibleLinks(lv, onItem.id, onItem.links)).toHaveLength(1)
    expect(isWaiting(lv, onItem)).toBe(true)
  })

  test('hiding twice keeps one entry; unhide restores it and drops empty owners', () => {
    const lv = hideLink(hideLink(EMPTY_LOCAL, 'o', 'x.md'), 'o', 'x.md')
    expect(lv.hidden).toEqual({ o: ['x.md'] })
    expect(unhideLink(lv, 'o', 'x.md')).toEqual(EMPTY_LOCAL)
    expect(unhideLink(hideLink(lv, 'o', 'y.md'), 'o', 'x.md').hidden).toEqual({ o: ['y.md'] })
  })

  test('operations do not change the view they were given', () => {
    const lv: LocalView = { seen: {}, hidden: { o: ['x.md'] } }
    hideLink(lv, 'o', 'y.md')
    unhideLink(lv, 'o', 'x.md')
    markSeen(lv, item('a'))
    expect(lv).toEqual({ seen: {}, hidden: { o: ['x.md'] } })
  })
})

type Disk = { files: Map<string, string>; toasts: string[]; failRead: boolean; failWrite: boolean; reads: number; writes: number }
function disk(): Disk {
  return { files: new Map(), toasts: [], failRead: false, failWrite: false, reads: 0, writes: 0 }
}
function hostOn(d: Disk) {
  return {
    readText: async (p: string): Promise<string> => {
      d.reads++
      if (d.failRead) throw new Error(`$.fs.read(${p}) failed: EACCES`)
      const t = d.files.get(p)
      if (t === undefined) throw new Error(`$.fs.read(${p}) failed: ENOENT`)
      return t
    },
    writeText: async (p: string, t: string): Promise<void> => {
      d.writes++
      if (d.failWrite) throw new Error('EACCES')
      d.files.set(p, t)
    },
    toast: (t: string): void => void d.toasts.push(t),
  }
}
const P = '/home/me/.cache/project-board/view/0123456789abcdef.json'
const onDisk = (d: Disk): LocalView => JSON.parse(d.files.get(P) ?? '{}') as LocalView

describe('LocalStore', () => {
  test('a missing file is an empty state and says nothing', async () => {
    const d = disk()
    const s = new LocalStore(hostOn(d))
    expect(s.get(P)).toEqual(EMPTY_LOCAL)
    await s.load(P)
    expect(s.get(P)).toEqual(EMPTY_LOCAL)
    expect(d.toasts).toEqual([])
  })

  test('load reads a path once', async () => {
    const d = disk()
    d.files.set(P, JSON.stringify({ seen: { a: 'p' }, hidden: { o: ['x.md'] } }))
    const s = new LocalStore(hostOn(d))
    await Promise.all([s.load(P), s.load(P)])
    await s.load(P)
    expect(d.reads).toBe(1)
    expect(s.get(P)).toEqual({ seen: { a: 'p' }, hidden: { o: ['x.md'] } })
  })

  test('update writes the new state to the file', async () => {
    const d = disk()
    const s = new LocalStore(hostOn(d))
    await s.load(P)
    await s.update(P, v => hideLink(v, 'o', 'x.md'))
    expect(onDisk(d)).toEqual({ seen: {}, hidden: { o: ['x.md'] } })
    expect(s.get(P).hidden).toEqual({ o: ['x.md'] })
  })

  test('two hosts on one file keep each other\'s records', async () => {
    const d = disk()
    const claude = new LocalStore(hostOn(d))
    const pi = new LocalStore(hostOn(d))
    await claude.load(P)
    await pi.load(P)
    await claude.update(P, v => markSeen(v, item('a')))
    await pi.update(P, v => hideLink(v, 'o', 'x.md'))
    await claude.update(P, v => hideLink(v, 'o', 'y.md'))
    const final = onDisk(d)
    expect(Object.keys(final.seen)).toEqual(['a'])
    expect(final.hidden).toEqual({ o: ['x.md', 'y.md'] })
    expect(claude.get(P)).toEqual(final)
  })

  test('update applies fn to the file as it is now, not to what was loaded', async () => {
    const d = disk()
    const s = new LocalStore(hostOn(d))
    await s.load(P)
    d.files.set(P, JSON.stringify({ seen: { other: 'p' }, hidden: {} }))
    let saw: LocalView | null = null
    await s.update(P, v => ((saw = v), v))
    expect(saw).toEqual({ seen: { other: 'p' }, hidden: {} })
  })

  test('overlapping updates in one host both land', async () => {
    const d = disk()
    const s = new LocalStore(hostOn(d))
    await s.load(P)
    await Promise.all([s.update(P, v => hideLink(v, 'o', 'x.md')), s.update(P, v => hideLink(v, 'o', 'y.md'))])
    expect(onDisk(d).hidden).toEqual({ o: ['x.md', 'y.md'] })
  })

  test('a corrupt file reads as empty with one toast, and the board keeps working', async () => {
    const d = disk()
    d.files.set(P, '{not json')
    const s = new LocalStore(hostOn(d))
    await s.load(P)
    expect(s.get(P)).toEqual(EMPTY_LOCAL)
    expect(d.toasts).toHaveLength(1)
    await s.update(P, v => markSeen(v, item('a')))
    await s.update(P, v => hideLink(v, 'o', 'x.md'))
    expect(d.toasts).toHaveLength(1)
    expect(s.get(P).hidden).toEqual({ o: ['x.md'] })
    expect(onDisk(d).seen).toHaveProperty('a')
  })

  test('a JSON file of the wrong shape counts as corrupt; stray entries are dropped', async () => {
    const d = disk()
    d.files.set(P, '[1,2]')
    const a = new LocalStore(hostOn(d))
    await a.load(P)
    expect(d.toasts).toHaveLength(1)
    d.files.set(P, JSON.stringify({ seen: { a: 'p', b: 7 }, hidden: { o: ['x', 3], p: 'x' } }))
    const b = new LocalStore(hostOn(d))
    await b.load(P)
    expect(b.get(P)).toEqual({ seen: { a: 'p' }, hidden: { o: ['x'] } })
  })

  test('a file that cannot be read keeps the session state in memory, with one toast', async () => {
    const d = disk()
    d.failRead = true
    const s = new LocalStore(hostOn(d))
    await s.load(P)
    expect(d.toasts).toHaveLength(1)
    await s.update(P, v => hideLink(v, 'o', 'x.md'))
    await s.update(P, v => hideLink(v, 'o', 'y.md'))
    expect(s.get(P).hidden).toEqual({ o: ['x.md', 'y.md'] })
    expect(d.toasts).toHaveLength(1)
  })

  test('a file that cannot be written keeps the session state in memory, with one toast', async () => {
    const d = disk()
    d.failWrite = true
    const s = new LocalStore(hostOn(d))
    await s.load(P)
    await s.update(P, v => markSeen(v, item('a')))
    await s.update(P, v => hideLink(v, 'o', 'x.md'))
    expect(d.toasts).toHaveLength(1)
    expect(s.get(P).seen).toHaveProperty('a')
    expect(s.get(P).hidden).toEqual({ o: ['x.md'] })
    expect(isWaiting(s.get(P), item('a'))).toBe(false)
  })

  test('update before load still works', async () => {
    const d = disk()
    const s = new LocalStore(hostOn(d))
    await s.update(P, v => hideLink(v, 'o', 'x.md'))
    await s.load(P)
    expect(s.get(P).hidden).toEqual({ o: ['x.md'] })
  })
})
