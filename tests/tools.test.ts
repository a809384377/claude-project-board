import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { OP_NAMES } from '../hooks/model/ops'
import { emptyBoard, parseBoard, serializeBoard } from '../hooks/model/parse'
import type { Board } from '../hooks/model/types'

const PROJ = '/proj'
const BOARD = `${PROJ}/ai/board.json`
const TMP = `${PROJ}/ai/.board.json.tmp`
const T = (name: string) => `mcp__project-board__${name}`

type World = {
  files: Map<string, { text: string; mtime: number }>
  toasts: string[]
  registered: Array<{ name: string; description: string; isDeferred?: boolean }>
  stats: number
}

/** What a session would answer beneath the plugin: files in memory, mv done in memory. */
function world(on: On, initial: string | null = serializeBoard(emptyBoard('demo'))): World {
  const w: World = { files: new Map(), toasts: [], registered: [], stats: 0 }
  let tick = 1000
  const put = (p: string, text: string) => w.files.set(p, { text, mtime: ++tick })
  if (initial !== null) put(BOARD, initial)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: PROJ }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', (_$, e) => {
    const f = w.files.get(e.path)
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: f.text }
  })
  on('fs.write', (_$, e) => {
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.stat', (_$, e) => {
    w.stats++
    const f = w.files.get(e.path)
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtime, isLink: false } }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'mv') {
      const f = w.files.get(e.argv[2] as string)
      if (f) {
        w.files.delete(e.argv[2] as string)
        put(e.argv[3] as string, f.text)
      }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => {
    w.registered.push({ name: e.name, description: e.description, ...(e.isDeferred === undefined ? {} : { isDeferred: e.isDeferred as boolean }) })
    return { value: { tool: `mcp__project-board__${e.name}` } }
  })
  return w
}

const boardOf = (w: World): Board => {
  const r = parseBoard(w.files.get(BOARD)?.text ?? '')
  if (!r.ok) throw new Error('board file does not parse: ' + r.error)
  return r.board
}

type Json = Record<string, any>
async function call($: any, name: string, input: Record<string, unknown>, agentId?: string): Promise<Json> {
  const r = await $.tool.call({ tool: T(name), ...input, ...(agentId ? { agentId } : {}) } as never)
  expect(typeof r.result).toBe('string')
  return JSON.parse(r.result as string) as Json
}

const START = { cwd: PROJ, surface: 'terminal' as const, isInteractive: true }

/** A board with one active goal g-car holding item i-a. */
function withGoal(): string {
  const b = emptyBoard('demo')
  const NOW = '2026-10-11T09:00:00+08:00'
  b.goals.push({
    id: 'g-car', title: '车辆', outcome: '三款车', status: 'active', links: [], steps: [], createdAt: NOW, updatedAt: NOW,
    items: [{
      id: 'i-a', title: '车身', stepId: '', status: 'todo', owner: '', note: '', waitingFor: '', dependsOn: [], scope: [], acceptance: '', links: [],
      noReviewTargetReason: '', reportedAt: '', session: '', doneBy: '', createdAt: NOW, updatedAt: NOW, doneAt: '',
    }],
  })
  return serializeBoard(b)
}

describe('registration', () => {
  test('with a board, session.start registers all four tools: three in the prompt, board_init behind tool search; the rules are in board_update', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    expect(w.registered.map(t => t.name)).toEqual(['board_get', 'board_update', 'board_propose', 'board_init'])
    expect(w.registered.map(t => t.isDeferred)).toEqual([false, false, false, true])
    const update = w.registered.find(t => t.name === 'board_update')?.description ?? ''
    expect(update).toContain('review')
    expect(update).toContain('forReview')
    expect(update).toContain('decision.add')
    expect(update).toContain('未声明的字段会报错')
    expect(update).toContain('整个看板')
    expect(update).toContain('~ 开头的路径都可以')
    const propose = w.registered.find(t => t.name === 'board_propose')?.description ?? ''
    expect(propose).toContain('整体替换')
  })

  test('without a board only board_init is registered, behind tool search, with a short description', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    expect(w.registered.map(t => t.name)).toEqual(['board_init'])
    expect(w.registered[0]?.isDeferred).toBe(true)
    expect((w.registered[0]?.description ?? '').length).toBeLessThan(160)
  })

  test('board_init makes the other three appear (registered again mid-session)', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    expect(w.registered.length).toBe(1)
    expect((await call($, 'board_init', { name: 'x' })).ok).toBe(true)
    const names = w.registered.map(t => t.name)
    expect(names).toContain('board_get')
    expect(names).toContain('board_update')
    expect(names).toContain('board_propose')
    expect(w.registered.filter(t => t.name === 'board_update')[0]?.isDeferred).toBe(false)
  })

  test('a board file that appears later (poll finds it) registers the full set', async ($, on) => {
    const w = world(on, null)
    const clock = mock.clock(on)
    await $.session.start(START)
    expect(w.registered.map(t => t.name)).toEqual(['board_init'])
    w.files.set(BOARD, { text: serializeBoard(emptyBoard('late')), mtime: 5000 })
    await clock.advance(3000)
    expect(w.registered.map(t => t.name)).toEqual(['board_init', 'board_get', 'board_update', 'board_propose', 'board_init'])
  })

  test('tools cannot be withdrawn: a deleted board leaves the registered set alone', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on)
    await $.session.start(START)
    const before = w.registered.length
    w.files.delete(BOARD)
    await clock.advance(3000)
    await clock.advance(3000)
    expect(w.registered.length).toBe(before)
  })

  test('every op ops.ts supports is named in the board_update description', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    const update = w.registered.find(t => t.name === 'board_update')?.description ?? ''
    expect(OP_NAMES.length).toBeGreaterThan(20)
    const missing = OP_NAMES.filter(op => !update.includes(op))
    expect(missing).toEqual([])
  })

  test('the board is polled every 3 seconds', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on)
    await $.session.start(START)
    const before = w.stats
    await clock.advance(3000)
    expect(w.stats).toBeGreaterThan(before)
    const mid = w.stats
    await clock.advance(2000)
    expect(w.stats).toBe(mid)
  })
})

describe('board_update', () => {
  test('success returns a JSON string with rev and events, and writes the file', async ($, on) => {
    const w = world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    const raw = await $.tool.call({ tool: T('board_update'), ops: [{ op: 'item.update', id: 'i-a', status: 'doing', note: '开工' }] } as never)
    expect(typeof raw.result).toBe('string')
    const out = JSON.parse(raw.result as string)
    expect(out).toMatchObject({ ok: true, rev: 1, events: [{ kind: 'item.update', id: 'i-a' }] })
    const item = boardOf(w).goals[0]?.items[0]
    expect(item?.status).toBe('doing')
    expect(item?.session).toBe('sess-1')
    expect(boardOf(w).rev).toBe(1)
    expect(w.files.has(TMP)).toBe(false)
  })

  test('failure returns the index and the reason, and the file is unchanged', async ($, on) => {
    const w = world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    const before = w.files.get(BOARD)?.text
    const out = await call($, 'board_update', {
      ops: [{ op: 'item.update', id: 'i-a', note: 'x' }, { op: 'note.add', title: 'ok' }, { op: 'item.update', id: 'i-zzz', note: 'y' }],
    })
    expect(out).toMatchObject({ ok: false, index: 2 })
    expect(out.error).toContain('i-zzz')
    expect(w.files.get(BOARD)?.text).toBe(before)
  })

  test('malformed input: ops missing, not an array, empty, unknown op', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    const before = w.files.get(BOARD)?.text
    expect(await call($, 'board_update', {})).toMatchObject({ ok: false, index: 0 })
    expect(await call($, 'board_update', { ops: 'item.add' })).toMatchObject({ ok: false })
    expect(await call($, 'board_update', { ops: [] })).toMatchObject({ ok: false })
    expect(await call($, 'board_update', { ops: [{ op: 'nope' }] })).toMatchObject({ ok: false, index: 0 })
    expect(w.files.get(BOARD)?.text).toBe(before)
  })

  test('a sub-agent can write items; their status stamps use the agent actor', async ($, on) => {
    const w = world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    const out = await call($, 'board_update', { ops: [{ op: 'item.update', id: 'i-a', status: 'done' }] }, 'agent-1')
    expect(out.ok).toBe(true)
    expect(boardOf(w).goals[0]?.items[0]?.doneBy).toBe('claude')
  })

  test('recording decisions toasts once per call: 已记录 N 条决策：<第一条>', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    await call($, 'board_update', { ops: [{ op: 'decision.add', text: '车辆用低多边形', kind: 'user', quote: '就低多边形' }] })
    expect(w.toasts).toEqual(['已记录 1 条决策：车辆用低多边形'])
    await call($, 'board_update', {
      ops: [{ op: 'decision.add', text: '路灯先不做', kind: 'delegated' }, { op: 'decision.add', text: '第二条', kind: 'delegated' }],
    })
    expect(w.toasts).toEqual(['已记录 1 条决策：车辆用低多边形', '已记录 2 条决策：路灯先不做'])
    await call($, 'board_update', { ops: [{ op: 'note.add', title: '无关' }] })
    expect(w.toasts).toHaveLength(2)
  })

  test('a failed batch with decisions does not toast', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    await call($, 'board_update', { ops: [{ op: 'decision.add', text: 'a', kind: 'user' }, { op: 'item.remove', id: 'nope' }] })
    expect(w.toasts).toEqual([])
  })

  test('without a board the tool refuses and creates nothing', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    const none = await call($, 'board_update', { ops: [{ op: 'note.add', title: 'x' }] })
    expect(none).toMatchObject({ ok: false })
    expect(none.error).toContain('board_init')
    expect(w.files.size).toBe(0)
  })

  test('with a corrupt board the tool refuses and the file keeps its bytes', async ($, on) => {
    const w = world(on, '{ "schema": 1, ')
    mock.clock(on)
    await $.session.start(START)
    const bad = await call($, 'board_update', { ops: [{ op: 'note.add', title: 'x' }] })
    expect(bad.error).toContain('无法解析')
    expect(w.files.get(BOARD)?.text).toBe('{ "schema": 1, ')
    expect(w.files.size).toBe(1)
  })
})

describe('board_propose', () => {
  test('propose, then approve in conversation: the goal exists with confirmedBy conversation', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    const p = await call($, 'board_propose', { action: 'goal.create', payload: { title: '新目标' }, reason: '用户提到' })
    expect(p).toMatchObject({ ok: true, rev: 1, events: [{ kind: 'proposal.add' }] })
    const pid = p.events[0].id as string
    expect(boardOf(w).proposals.map(x => x.id)).toEqual([pid])
    const a = await call($, 'board_propose', { approve: pid, quote: '好，就这个' })
    expect(a.ok).toBe(true)
    const g = boardOf(w).goals[0]
    expect(g).toMatchObject({ title: '新目标', confirmedBy: 'conversation', quote: '好，就这个' })
    expect(boardOf(w).proposals).toEqual([])
    const again = await call($, 'board_propose', { approve: pid })
    expect(again.ok).toBe(false)
    expect(again.error).toContain('不存在')
  })

  test('userConfirmed with a quote executes directly; without a quote it fails', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    const noQuote = await call($, 'board_propose', { action: 'goal.create', payload: { title: 'A' }, userConfirmed: true })
    expect(noQuote.ok).toBe(false)
    expect(boardOf(w).goals).toHaveLength(0)
    const ok = await call($, 'board_propose', { action: 'goal.create', payload: { title: 'A' }, userConfirmed: true, quote: '建一个 A' })
    expect(ok.ok).toBe(true)
    expect(boardOf(w).goals[0]?.title).toBe('A')
  })

  test('a sub-agent may propose but not execute directly or approve', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    const direct = await call($, 'board_propose', { action: 'goal.create', payload: { title: 'A' }, userConfirmed: true, quote: '好' }, 'agent-1')
    expect(direct.ok).toBe(false)
    expect(direct.error).toContain('主会话')
    expect(boardOf(w).goals).toHaveLength(0)
    const prop = await call($, 'board_propose', { action: 'goal.create', payload: { title: 'A' } }, 'agent-1')
    expect(prop.ok).toBe(true)
    const pid = prop.events[0].id as string
    const appr = await call($, 'board_propose', { approve: pid }, 'agent-1')
    expect(appr.ok).toBe(false)
    expect(appr.error).toContain('主会话')
    expect(boardOf(w).proposals).toHaveLength(1)
    expect(boardOf(w).goals).toHaveLength(0)
  })

  test('malformed: no action, unknown action, approve with action', async ($, on) => {
    const w = world(on)
    mock.clock(on)
    await $.session.start(START)
    const before = w.files.get(BOARD)?.text
    expect((await call($, 'board_propose', {})).ok).toBe(false)
    expect((await call($, 'board_propose', { action: 'goal.explode', payload: {} })).ok).toBe(false)
    expect((await call($, 'board_propose', { approve: 'p-x', action: 'goal.create' })).ok).toBe(false)
    expect(w.files.get(BOARD)?.text).toBe(before)
  })

  test('focus.set replaces the whole focus', async ($, on) => {
    const w = world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    await call($, 'board_propose', { action: 'focus.set', payload: { text: 'A', goalId: 'g-car', mandate: '一直推进' }, userConfirmed: true, quote: '好' })
    expect(boardOf(w).focus).toMatchObject({ text: 'A', goalId: 'g-car', mandate: '一直推进' })
    await call($, 'board_propose', { action: 'focus.set', payload: { text: 'B' }, userConfirmed: true, quote: '换' })
    expect(boardOf(w).focus).toMatchObject({ text: 'B', goalId: '', mandate: '' })
  })
})

describe('board_get', () => {
  test('summary, goal, item, decisions, rules, notes, archive, search', async ($, on) => {
    const w = world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    await call($, 'board_update', {
      ops: [
        { op: 'decision.add', text: '车辆用低多边形', kind: 'user', goalId: 'g-car' },
        { op: 'decision.add', text: '项目用中文文案', kind: 'user' },
        { op: 'rule.add', text: '不用外部素材', group: '素材' },
        { op: 'note.add', title: '参考', text: '参考链接', group: '素材' },
      ],
    })
    const sum = await call($, 'board_get', { scope: 'summary' })
    expect(sum).toMatchObject({ ok: true, rev: 1, scope: 'summary' })
    expect(sum.data.goals[0]).toMatchObject({ id: 'g-car', counts: { todo: 1 }, openItems: [{ id: 'i-a', title: '车身' }] })
    expect(sum.data.totals).toMatchObject({ decisions: 2, rules: 1, notes: 1 })
    expect((await call($, 'board_get', { scope: 'goal', id: 'g-car' })).data.goal.items).toHaveLength(1)
    expect((await call($, 'board_get', { scope: 'item', id: 'i-a' })).data).toMatchObject({ goal: { id: 'g-car' }, item: { title: '车身' } })
    expect((await call($, 'board_get', { scope: 'decisions' })).data.total).toBe(2)
    expect((await call($, 'board_get', { scope: 'decisions', goalId: 'g-car' })).data.decisions[0].text).toBe('车辆用低多边形')
    expect((await call($, 'board_get', { scope: 'rules', group: '素材' })).data.total).toBe(1)
    expect((await call($, 'board_get', { scope: 'notes' })).data.notes[0].text).toBe('参考链接')
    expect((await call($, 'board_get', { scope: 'search', keyword: '低多边' })).data.hits).toMatchObject([{ kind: 'decision' }])
    expect((await call($, 'board_get', { scope: 'archive' })).data).toEqual({ goals: [], decisions: [] })
    expect(boardOf(w).rev).toBe(1) // only the one write above; reads never write
  })

  test('archive scope finds closed goals and their decisions by keyword', async ($, on) => {
    world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    await call($, 'board_update', { ops: [{ op: 'decision.add', text: '车辆颜色定红色', kind: 'user', goalId: 'g-car' }] })
    await call($, 'board_propose', { action: 'goal.close', payload: { goalId: 'g-car', reason: '完成' }, userConfirmed: true, quote: '关掉' })
    const hit = await call($, 'board_get', { scope: 'archive', keyword: '车辆' })
    expect(hit.data.goals).toHaveLength(1)
    expect(hit.data.decisions[0].text).toContain('红色')
    expect((await call($, 'board_get', { scope: 'archive', keyword: '红色' })).data.goals).toHaveLength(0)
    expect((await call($, 'board_get', { scope: 'archive', keyword: '不存在的词' })).data).toEqual({ goals: [], decisions: [] })
    expect((await call($, 'board_get', { scope: 'goal', id: 'g-car' })).data.archived).toBe(true)
  })

  test('bad requests: unknown scope, missing id, unknown id, missing scope', async ($, on) => {
    world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    expect((await call($, 'board_get', { scope: 'nope' })).ok).toBe(false)
    expect((await call($, 'board_get', { scope: 'goal' })).error).toContain('id')
    expect((await call($, 'board_get', { scope: 'item', id: 'i-none' })).ok).toBe(false)
    expect((await call($, 'board_get', {})).ok).toBe(false)
    expect((await call($, 'board_get', { scope: 'search' })).error).toContain('keyword')
  })

  test('top-level fields a tool does not declare are ignored; fields inside ops stay strict', async ($, on) => {
    const w = world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    expect((await call($, 'board_get', { scope: 'summary', foo: 1, requestMeta: { x: 1 } })).ok).toBe(true)
    const added = await call($, 'board_update', { ops: [{ op: 'note.add', title: 'x' }], extra: 1, requestMeta: {} })
    expect(added).toMatchObject({ ok: true, rev: 1 })
    const before = w.files.get(BOARD)?.text
    const strict = await call($, 'board_update', { ops: [{ op: 'note.add', title: 'y', colour: 'red' }], requestMeta: {} })
    expect(strict.ok).toBe(false)
    expect(strict.error).toContain('colour')
    expect(w.files.get(BOARD)?.text).toBe(before)
    // a typo in a propose field is no longer an error: the call is read for the fields it declares
    const typo = await call($, 'board_propose', { action: 'goal.create', payload: { title: 'A' }, userConfirmd: true, quote: 'x' })
    expect(typo).toMatchObject({ ok: true })
    expect(boardOf(w).goals.length).toBe(1)
    expect(boardOf(w).proposals.length).toBe(1)
  })

  test('archive and search return at most 50 entries and say how many there were', async ($, on) => {
    const b = emptyBoard('demo')
    const NOW = '2026-10-11T09:00:00+08:00'
    for (let n = 0; n < 120; n++) {
      b.archive.goals.push({ id: `g-old${n}`, title: `旧目标 ${n}`, outcome: '', status: 'active', links: [], steps: [], items: [], createdAt: NOW, updatedAt: NOW, closedAt: NOW, closeReason: '完成' })
      b.archive.decisions.push({ id: `d-old${n}`, date: '2026-09-01', text: `旧决策 ${n}`, kind: 'user', goalId: `g-old${n}`, status: 'active' })
    }
    world(on, serializeBoard(b))
    mock.clock(on)
    await $.session.start(START)
    const arch = await call($, 'board_get', { scope: 'archive' })
    expect(arch.data.goals.length).toBe(50)
    expect(arch.data.decisions.length).toBe(50)
    expect(arch.data.goalsTotal).toBe(120)
    expect(arch.data.note).toContain('共 120 条，已显示前 50 条，请缩小关键词')
    const narrow = await call($, 'board_get', { scope: 'archive', keyword: '旧目标 11' })
    expect(narrow.data.goals.length).toBe(11)
    expect(narrow.data.note).toBeUndefined()
    const found = await call($, 'board_get', { scope: 'search', keyword: '旧' })
    expect(found.data.hits.length).toBe(50)
    expect(found.data.total).toBe(240)
    expect(found.data.note).toBe('共 240 条，已显示前 50 条，请缩小关键词')
    const few = await call($, 'board_get', { scope: 'search', keyword: '旧决策 7' })
    expect(few.data.hits.length).toBeLessThan(50)
    expect(few.data.note).toBeUndefined()
  })

  test('without a board it says how to create one', async ($, on) => {
    world(on, null)
    mock.clock(on)
    await $.session.start(START)
    expect((await call($, 'board_get', { scope: 'summary' })).error).toContain('board_init')
  })

  test('a corrupt board shows the parse error', async ($, on) => {
    world(on, '{\n "schema": 1,\n oops\n}')
    mock.clock(on)
    await $.session.start(START)
    const bad = await call($, 'board_get', { scope: 'summary' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('无法解析')
  })
})

describe('board_init', () => {
  test('creates the board once; a second call is refused', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    const out = await call($, 'board_init', { name: '记账小程序' })
    expect(out).toMatchObject({ ok: true, root: PROJ })
    expect(boardOf(w).project.name).toBe('记账小程序')
    expect((await call($, 'board_get', { scope: 'summary' })).data.project.name).toBe('记账小程序')
    const again = await call($, 'board_init', {})
    expect(again.ok).toBe(false)
    expect(again.error).toContain('已存在')
    expect((await call($, 'board_init', { name: 3 })).ok).toBe(false)
  })
})

describe('steps through the tools', () => {
  test('the tool route: step.add, then items onto it in a second call, then goal.merge approved in conversation', async ($, on) => {
    const w = world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    expect(boardOf(w).rev).toBe(0)
    expect(w.files.get(BOARD)?.text).toContain('"schema": 1')

    const made = await call($, 'board_update', { ops: [{ op: 'step.add', goalId: 'g-car', title: 'A 车身' }] })
    expect(made).toMatchObject({ ok: true, events: [{ kind: 'step.add' }] })
    const sid = made.events[0].id as string
    expect(w.files.get(BOARD)?.text).toContain('"schema": 2')

    // a stepId that does not exist is refused with the list of real ones
    const bad = await call($, 'board_update', { ops: [{ op: 'item.update', id: 'i-a', stepId: 'A' }] })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain(`${sid} A A 车身`)
    expect(boardOf(w).goals[0]?.items[0]?.stepId).toBe('')

    expect((await call($, 'board_update', { ops: [{ op: 'item.update', id: 'i-a', stepId: sid }] })).ok).toBe(true)
    expect(boardOf(w).goals[0]?.items[0]?.stepId).toBe(sid)

    const second = await call($, 'board_propose', { action: 'goal.create', payload: { title: '路灯' }, userConfirmed: true, quote: '加路灯' })
    expect(second.ok).toBe(true)
    const lamp = boardOf(w).goals[1]!.id
    const p = await call($, 'board_propose', { action: 'goal.merge', payload: { title: '整体', goalIds: ['g-car', lamp] }, reason: '同一件事的两个阶段' })
    expect(p.ok).toBe(true)
    const a = await call($, 'board_propose', { approve: p.events[0].id as string, quote: '同意合并' })
    expect(a).toMatchObject({ ok: true, events: [{ kind: 'goal.merge' }] })
    const b = boardOf(w)
    expect(b.goals).toHaveLength(1)
    expect(b.goals[0]).toMatchObject({ title: '整体', quote: '同意合并' })
    expect(b.goals[0]?.steps.map(s => s.title)).toEqual(['A 车身', '路灯'])

    const got = await call($, 'board_get', { scope: 'goal', id: b.goals[0]!.id })
    expect(got.data.goal.steps).toHaveLength(2)
  })

  test('a sub-agent may add steps but cannot approve a merge', async ($, on) => {
    const w = world(on, withGoal())
    mock.clock(on)
    await $.session.start(START)
    expect((await call($, 'board_update', { ops: [{ op: 'step.add', goalId: 'g-car', title: 'S 子 agent 的步骤' }] }, 'agent-1')).ok).toBe(true)
    const other = await call($, 'board_propose', { action: 'goal.create', payload: { title: 'Y' }, userConfirmed: true, quote: 'q' })
    expect(other.ok).toBe(true)
    const goalIds = boardOf(w).goals.map(g => g.id)
    const direct = await call($, 'board_propose', { action: 'goal.merge', payload: { title: 'M', goalIds }, userConfirmed: true, quote: 'q' }, 'agent-1')
    expect(direct.ok).toBe(false)
    expect(boardOf(w).goals).toHaveLength(2)
  })
})
