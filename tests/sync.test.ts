import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Host, SyncState } from '../hooks/host'
import { describeChanges } from '../hooks/model/diff'
import { applyOps } from '../hooks/model/ops'
import { emptyBoard, parseBoard, serializeBoard } from '../hooks/model/parse'
import { buildSnapshot, RULES_TEXT, SNAPSHOT_LIMIT } from '../hooks/model/summary'
import type { Board, Goal, Item } from '../hooks/model/types'
import { BoardStore } from '../hooks/store'
import { formatUntold, isUserSubmission, reminderText, Sync, TurnCounter } from '../hooks/sync'

const PROJ = '/proj'
const BOARD = `${PROJ}/ai/board.json`
const NOW = '2026-10-11T09:00:00+08:00'
const T = (name: string) => `mcp__project-board__${name}`
const START = { cwd: PROJ, surface: 'terminal' as const, isInteractive: true }
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }
const SECTION = 'project-board:board'

// ---------- builders ----------

function item(id: string, over: Partial<Item> = {}): Item {
  return {
    id, title: `事项 ${id}`, stepId: '', status: 'todo', owner: '', note: '', waitingFor: '', dependsOn: [], scope: [], acceptance: '', links: [],
    noReviewTargetReason: '', reportedAt: '', session: '', doneBy: '', createdAt: NOW, updatedAt: NOW, doneAt: '', ...over,
  }
}
function goal(id: string, title: string, items: Item[] = [], over: Partial<Goal> = {}): Goal {
  return { id, title, outcome: '', status: 'active', links: [], steps: [], items, createdAt: NOW, updatedAt: NOW, ...over }
}
function boardWith(fn: (b: Board) => void): Board {
  const b = emptyBoard('demo')
  fn(b)
  return b
}
const small = (): Board =>
  boardWith(b => {
    b.goals.push(goal('g-car', '车辆', [item('i-a', { status: 'running', owner: 'build-cars', note: '第一款车出来先停' }), item('i-b')], { outcome: '三款车' }))
    b.rules.push({ id: 'r-1', text: '管线只用 rebuild.sh', group: '管线' })
    b.decisions.push({ id: 'd-1', date: '2026-10-10', text: '车全部自建', kind: 'user', goalId: 'g-car', status: 'active' })
    b.focus = { text: '全场验收前收齐三路施工', goalId: 'g-car', mandate: '一直推进到请用户看全场', updatedAt: NOW }
  })

// ---------- kit world (hooks wired through the engine) ----------

type World = { files: Map<string, { text: string; mtime: number }>; tools: string[]; submitted: Array<readonly string[] | undefined>; state: Record<string, unknown> }
let current: World
function world(on: On, initial: Board | null): World {
  const w: World = { files: new Map(), tools: [], submitted: [], state: {} }
  current = w
  let tick = 1000
  const put = (p: string, text: string) => w.files.set(p, { text, mtime: ++tick })
  if (initial !== null) put(BOARD, serializeBoard(initial))
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
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => {
    w.tools.push(e.name)
    return { value: { tool: `mcp__project-board__${e.name}` } }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('prompt.submit', (_$, e) => {
    w.submitted.push(e.context)
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: 'ok' }))
  // Watches what the plugin writes to $.state (the kit's own store stays beneath and answers reads).
  on('state.set', (_$, e, next) => {
    const w2 = e as unknown as { key: string; value: unknown }
    w.state[w2.key] = w2.value
    return next(e)
  })
  return w
}

/** Replaces the file as another process would (mtime moves). */
function externalWrite(w: World, b: Board): void {
  w.files.set(BOARD, { text: serializeBoard(b), mtime: (w.files.get(BOARD)?.mtime ?? 0) + 7 })
}
const fileBoard = (w: World, mut: (b: Board) => void): Board => {
  const parsed = parseBoard(w.files.get(BOARD)?.text ?? '{}')
  if (!parsed.ok) throw new Error(parsed.error)
  const raw = parsed.board
  mut(raw)
  raw.rev += 1
  return raw
}

const submit = ($: any, over: Record<string, unknown> = {}) =>
  $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' }, ...over } as never) as Promise<{ context?: readonly string[] }>
const sectionText = async ($: any): Promise<string | undefined> =>
  (await $.prompt.compose(COMPOSE)).sections.find((s: { id: string }) => s.id === SECTION)?.text
const EMPTY: SyncState = { snapshot: null, untold: [], stale: false, reminder: '' }
const stateOf = async (_$: unknown, key: keyof SyncState): Promise<any> => (key in current.state ? current.state[key] : EMPTY[key])
const turnStart = ($: any, id = 't1') => $.turn.start({ text: 'go', turnId: id } as never)
const turnComplete = ($: any, id = 't1', agentId?: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', ...(agentId ? { agentId } : {}) } as never)
const edit = ($: any, agentId?: string) => $.tool.call({ tool: 'Edit', file_path: 'a.ts', ...(agentId ? { agentId } : {}) } as never)
const spawn = ($: any, agentId?: string) => $.tool.call({ tool: 'Agent', prompt: 'x', ...(agentId ? { agentId } : {}) } as never)
const update = async ($: any, ops: unknown[], agentId?: string) => {
  const r = await $.tool.call({ tool: T('board_update'), ops, ...(agentId ? { agentId } : {}) } as never)
  return JSON.parse(r.result as string) as { ok: boolean; rev?: number; error?: string }
}

// ---------- injection snapshot ----------

describe('injection snapshot', () => {
  test('two composes carry identical text, even when the board changed in between', async ($, on) => {
    const w = world(on, small())
    const clock = mock.clock(on)
    await $.session.start(START)
    const a = await sectionText($)
    expect(a).toContain(RULES_TEXT.split('\n')[0] as string)
    expect(a).toContain('车辆')
    expect((await $.prompt.compose(COMPOSE)).sections.find(s => s.id === SECTION)?.scope).toBe('session')
    externalWrite(w, fileBoard(w, b => void b.goals.push(goal('g-new', '全新目标'))))
    await clock.advance(3000)
    expect(await update($, [{ op: 'item.add', goalId: 'g-car', title: '另一件事' }])).toMatchObject({ ok: true })
    const b = await sectionText($)
    expect(b).toBe(a)
    expect(b).not.toContain('全新目标')
    expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro', SECTION])
  })

  test('session.end clear drops the snapshot; the next compose reflects the board as it is then', async ($, on) => {
    const w = world(on, small())
    const clock = mock.clock(on)
    await $.session.start(START)
    const a = await sectionText($)
    externalWrite(w, fileBoard(w, b => void b.goals.push(goal('g-new', '全新目标'))))
    await clock.advance(3000)
    expect(await sectionText($)).toBe(a)
    await $.session.end({ reason: 'other', sessionId: 's', resume: {} } as never)
    expect(await sectionText($)).toBe(a)
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)
    expect(await stateOf($, 'snapshot')).toBe(null)
    const c = await sectionText($)
    expect(c).not.toBe(a)
    expect(c).toContain('全新目标')
  })

  test('the snapshot is kept in $.state and served from there, even when the board file is gone', async ($, on) => {
    const w = world(on, small())
    mock.clock(on)
    await $.session.start(START)
    const a = await sectionText($)
    expect(await stateOf($, 'snapshot')).toBe(a)
    w.files.delete(BOARD)
    expect(await sectionText($)).toBe(a)
  })

  test('no board: no section; a corrupt board: no section', async ($, on) => {
    world(on, null)
    mock.clock(on)
    await $.session.start(START)
    expect(await sectionText($)).toBe(undefined)
  })

  test('a board created mid-session gets its snapshot at the next compose', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    expect(await sectionText($)).toBe(undefined)
    await $.tool.call({ tool: T('board_init'), name: '新项目' } as never)
    expect(w.files.has(BOARD)).toBe(true)
    expect(await sectionText($)).toContain('新项目')
  })
})

describe('snapshot quotas', () => {
  const big = (): Board =>
    boardWith(b => {
      for (let g = 0; g < 40; g++) {
        const items: Item[] = []
        for (let i = 0; i < 10; i++) items.push(item(`i-${g}-${i}`, { status: i % 3 === 0 ? 'running' : 'todo', owner: 'agent-x', note: '备注'.repeat(20) }))
        b.goals.push(goal(`g-${g}`, `目标${g}`, items, { outcome: '成果'.repeat(30) }))
      }
      for (let d = 0; d < 200; d++) {
        b.decisions.push({ id: `d-${d}`, date: `2026-09-${String(1 + (d % 28)).padStart(2, '0')}`, text: `决策${d}`.padEnd(120, '字'), kind: 'user', goalId: `g-${d % 40}`, status: 'active' })
      }
      for (let r = 0; r < 60; r++) b.rules.push({ id: `r-${r}`, text: '约定'.repeat(30), group: `组${r % 6}` })
      b.notes.push({ id: 'n-1', title: '长备注', text: '甲'.repeat(2000), group: '环境' })
      b.focus = { text: '甲'.repeat(2000), goalId: 'g-3', mandate: '乙'.repeat(2000), updatedAt: NOW }
    })

  test('a large board stays within 6,000 characters; every list says how many entries it left out', () => {
    const text = buildSnapshot(big())
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(text.startsWith(RULES_TEXT)).toBe(true)
    expect(text).toContain('board_get 查看全文')
    expect(text).toMatch(/另有 \d+ 个目标，用 board_get summary 查看/)
    expect(text).toMatch(/另有 \d+ 条，用 board_get decisions 查看/)
    // rules are placed one by one, grouped, before anything is left out
    expect(text).toContain('[组0]\n- 约定约定')
  })

  test('sections fill in order: rules, focus, proposals, board rules, goals, decisions', () => {
    const b = big()
    b.proposals.push({ id: 'p-1', action: 'goal.create', payload: {}, reason: '要开新目标', createdAt: NOW })
    const text = buildSnapshot(b)
    const at = (h: string): number => text.indexOf(h)
    const order = ['# 项目看板', '## 关注', '## 待确认', '## 约定', '## 目标与事项', '## 决策'].map(at)
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
  })

  test('a section that finds the budget used up still leaves its heading and the count', () => {
    const b = big()
    for (let r = 0; r < 400; r++) b.rules.push({ id: `r-more${r}`, text: '约定'.repeat(30), group: '额外' })
    const text = buildSnapshot(b)
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(text).toMatch(/## 约定（460 条）/)
    expect(text).toMatch(/另有 \d+ 条，用 board_get rules 查看/)
  })

  test('a single field of 2,000 characters is cut at 300 and says where to read the rest', () => {
    const text = buildSnapshot(big())
    expect(text).not.toContain('甲'.repeat(301))
    expect(text).toContain('甲'.repeat(300) + '…（board_get 查看全文）')
  })

  test('goals are placed one by one: full lines first, then titles only, then a count of the rest', () => {
    const mk = (goals: number, perGoal: number): string =>
      buildSnapshot(
        boardWith(b => {
          for (let g = 0; g < goals; g++) {
            b.goals.push(goal(`g-${g}`, `目标${g}`, Array.from({ length: perGoal }, (_, i) => item(`i-${g}-${i}`, { status: 'doing', note: '备注文字很长'.repeat(3) }))))
          }
        }),
      )
    const notes = (t: string): number => t.split('备注文字很长').length - 1
    // 3 x 4 and 10 x 6 both fit in full
    expect(notes(mk(3, 4))).toBe(3 * 4 * 3)
    expect(mk(10, 6)).toContain('i-9-5 ◐在做 事项 i-9-5 — 备注文字很长')
    // 25 x 6 does not: the first goals keep their notes, later ones are cut to titles
    const bigger = mk(25, 6)
    expect(bigger.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(bigger).toContain('i-0-5 ◐在做 事项 i-0-5 — 备注文字很长')
    expect(notes(bigger)).toBeGreaterThan(0)
    expect(notes(bigger)).toBeLessThan(25 * 6 * 3)
    expect(bigger).toMatch(/- g-2\d 目标2\d：◐在做 6/)
    // 40 x 10: the tail is a count
    const huge = mk(40, 10)
    expect(huge.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(huge).toContain('- g-0 目标0')
    expect(huge).toMatch(/另有 \d+ 个目标，用 board_get summary 查看/)
    expect(huge).not.toContain('i-39-0')
  })

  test('a goal whose full lines do not fit is cut to its title and item titles', () => {
    const text = buildSnapshot(
      boardWith(b => {
        b.goals.push(goal('g-fat', '大目标', Array.from({ length: 20 }, (_, i) => item(`i-${i}`, { status: 'doing', note: '长备注'.repeat(100) }))))
        b.goals.push(goal('g-next', '后一个', [item('i-next')]))
      }),
    )
    expect(text).not.toContain('长备注')
    expect(text).toContain('i-19 ◐在做 事项 i-19\n')
    expect(text).toContain('- g-next 后一个\n  - i-next')
  })

  test('focus goal and goals with running work come first; paused goals come last as one line', () => {
    const b = boardWith(x => {
      x.goals.push(goal('g-idle', '无动静', [item('i-1')]))
      x.goals.push(goal('g-run', '有人在跑', [item('i-2', { status: 'running' })]))
      x.goals.push(goal('g-focus', '关注目标', [item('i-3')]))
      x.goals.push(goal('g-pause', '暂停的', [item('i-4')], { status: 'paused' }))
      x.focus = { text: 'x', goalId: 'g-focus', mandate: '', updatedAt: NOW }
    })
    const text = buildSnapshot(b)
    expect(text.indexOf('关注目标')).toBeLessThan(text.indexOf('有人在跑'))
    expect(text.indexOf('有人在跑')).toBeLessThan(text.indexOf('无动静'))
    expect(text).toContain('- g-pause 暂停的（暂停）')
    expect(text).not.toContain('i-4')
    expect(text.indexOf('无动静')).toBeLessThan(text.indexOf('暂停的'))
  })

  test('pending proposals are listed; decisions of closed goals are not', () => {
    const b = small()
    b.proposals.push({ id: 'p-1', action: 'goal.create', payload: {}, reason: '要开新目标', createdAt: NOW })
    b.decisions.push({ id: 'd-x', date: '2026-10-11', text: '孤儿决策', kind: 'user', goalId: 'g-gone', status: 'active' })
    const text = buildSnapshot(b)
    expect(text).toContain('p-1 goal.create：要开新目标')
    expect(text).not.toContain('孤儿决策')
  })
})

// ---------- untold changes ----------

describe('untold changes ride on the next user submission', () => {
  test('an external change is attached once, as context, then cleared', async ($, on) => {
    const w = world(on, small())
    const clock = mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    externalWrite(w, fileBoard(w, b => {
      const it = b.goals[0]?.items[1]
      if (it) it.status = 'review'
    }))
    await clock.advance(3000)
    const first = await submit($)
    expect(first.context?.[0]).toContain('外部：事项「事项 i-b」：待办 → 待验收')
    expect((await submit($)).context).toBe(undefined)
    expect(await stateOf($, 'untold')).toEqual([])
  })

  test('origin peer or a turnId in flight: nothing attached, nothing consumed', async ($, on) => {
    const w = world(on, small())
    const clock = mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    externalWrite(w, fileBoard(w, b => void b.rules.push({ id: 'r-9', text: '新约定', group: '' })))
    await clock.advance(3000)
    expect((await submit($, { origin: { kind: 'peer' } })).context).toBe(undefined)
    expect((await submit($, { turnId: 't-running' })).context).toBe(undefined)
    expect((await submit($, { origin: { kind: 'task-notification' } })).context).toBe(undefined)
    expect((await stateOf($, 'untold')).length).toBe(1)
    expect((await submit($, { origin: { kind: 'sdk' } })).context?.[0]).toContain('新增约定「新约定」')
  })

  test('past 1,500 characters only the count is written', async ($, on) => {
    const w = world(on, small())
    const clock = mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    externalWrite(w, fileBoard(w, b => {
      for (let i = 0; i < 60; i++) b.rules.push({ id: `r-x${i}`, text: `约定内容第 ${i} 条，写得稍微长一点以便超过上限`, group: '' })
    }))
    await clock.advance(3000)
    const ctx = (await submit($)).context?.[0] ?? ''
    expect(ctx).toBe('看板有 60 处外部变更，用 board_get 查看')
  })

  test("the main session's own writes are not owed to it", async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    expect(await update($, [{ op: 'item.add', goalId: 'g-car', title: '我自己加的' }])).toMatchObject({ ok: true, rev: 1 })
    expect(await stateOf($, 'untold')).toEqual([])
    expect((await submit($)).context).toBe(undefined)
  })

  test("a sub-agent's write is owed to the main session", async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    expect(await update($, [{ op: 'item.update', id: 'i-b', status: 'doing' }], 'agent-7')).toMatchObject({ ok: true })
    expect((await submit($)).context?.[0]).toContain('子 agent：事项「事项 i-b」：待办 → 在做')
  })

  test('an external change that slips in before our own write is still owed (listener sees both)', async ($, on) => {
    const w = world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    externalWrite(w, fileBoard(w, b => void b.rules.push({ id: 'r-5', text: '外部约定', group: '' })))
    expect(await update($, [{ op: 'item.add', goalId: 'g-car', title: '随后写入' }])).toMatchObject({ ok: true })
    const ctx = (await submit($)).context?.[0] ?? ''
    expect(ctx).toContain('外部：新增约定「外部约定」')
    expect(ctx).not.toContain('随后写入')
  })

  test('the first snapshot already contains what was found just before it, so nothing is owed twice', async ($, on) => {
    const w = world(on, small())
    mock.clock(on)
    await $.session.start(START)
    externalWrite(w, fileBoard(w, b => void b.goals.push(goal('g-early', '早到的目标'))))
    expect(await sectionText($)).toContain('早到的目标')
    expect((await submit($)).context).toBe(undefined)
  })
})

describe('Sync with a user write (store.commit as user)', () => {
  function fakeHost(initial: Board): { host: Host; state: SyncState; store: BoardStore } {
    const files = new Map<string, { text: string; mtime: number }>([[BOARD, { text: serializeBoard(initial), mtime: 1 }]])
    let tick = 1
    const state: SyncState = { snapshot: null, untold: [], stale: false, reminder: '' }
    const host: Host = {
      readText: async p => {
        const f = files.get(p)
        if (!f) throw new Error('ENOENT')
        return f.text
      },
      writeText: async (p, s) => void files.set(p, { text: s, mtime: ++tick }),
      exists: async p => files.has(p),
      listDir: async () => [],
      stat: async p => {
        const f = files.get(p)
        return f ? { mtimeMs: f.mtime } : null
      },
      run: async argv => {
        const f = files.get(argv[2] as string)
        if (f) {
          files.delete(argv[2] as string)
          files.set(argv[3] as string, { text: f.text, mtime: ++tick })
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      root: async () => PROJ,
      sessionId: async () => 's',
      toast: () => {},
      status: () => {},
      copy: async () => true,
      now: async () => 0,
      getState: async k => structuredClone(state[k]),
      setState: async (k, v) => void ((state as unknown as Record<string, unknown>)[k] = structuredClone(v)),
      registerTool: async () => {},
    }
    return { host, state, store: new BoardStore(host) }
  }

  test('a button press is owed to Claude; Claude does not need to be told about its own', async () => {
    const { host, state, store } = fakeHost(small())
    await store.locate()
    const sync = new Sync(host, store)
    await sync.snapshot()
    await store.commit(b => applyOps(b, [{ op: 'item.update', id: 'i-a', status: 'done' }], { now: NOW, session: 's', actor: 'user' }), 'user')
    await sync.flush()
    expect(state.untold.join('\n')).toContain('用户：事项「事项 i-a」：在跑 → 完成')
    const owed = await sync.takeForSubmit()
    expect(owed.length).toBe(1)
    expect(state.untold).toEqual([])
  })
})

// ---------- end-of-turn check ----------

describe('end-of-turn bookkeeping check', () => {
  test('editing files alone never makes the board stale', async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await edit($)
    await edit($)
    await turnComplete($)
    expect(await stateOf($, 'stale')).toBe(false)
    expect((await submit($)).context).toBe(undefined)
  })

  test('main-session agent spawns and no board write: stale, and the next submission carries the nudge', async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await spawn($)
    await spawn($)
    await turnComplete($)
    expect(await stateOf($, 'stale')).toBe(true)
    const ctx = (await submit($)).context ?? []
    expect(ctx).toEqual(['上一轮派了 2 个 agent，看板未更新；如有进展请补记'])
    expect((await submit($)).context).toBe(undefined)
    expect(await stateOf($, 'stale')).toBe(true)
  })

  test("a sub-agent's spawns do not count; its turn.complete does not decide", async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await spawn($, 'agent-1')
    await turnComplete($, 'ta', 'agent-1')
    await turnComplete($)
    expect(await stateOf($, 'stale')).toBe(false)
    await turnStart($, 't2')
    await spawn($)
    await turnComplete($, 't2', 'agent-1')
    expect(await stateOf($, 'stale')).toBe(false)
    await turnComplete($, 't2')
    expect(await stateOf($, 'stale')).toBe(true)
  })

  test('spawning agents and writing the board in the same turn means no nudge; the next write clears an earlier warning', async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await spawn($)
    await update($, [{ op: 'item.update', id: 'i-b', note: '记了' }])
    await turnComplete($)
    expect(await stateOf($, 'stale')).toBe(false)
    expect(await stateOf($, 'reminder')).toBe('')

    await turnStart($, 't2')
    await spawn($)
    await turnComplete($, 't2')
    expect(await stateOf($, 'stale')).toBe(true)
    await update($, [{ op: 'item.update', id: 'i-b', note: '补记' }])
    expect(await stateOf($, 'stale')).toBe(false)
    expect((await submit($)).context).toBe(undefined)
  })

  test("a sub-agent's board write during the turn counts as the turn's bookkeeping", async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await spawn($)
    await update($, [{ op: 'item.update', id: 'i-b', status: 'doing' }], 'agent-1')
    await turnComplete($, 'ta', 'agent-1')
    await turnComplete($)
    expect(await stateOf($, 'stale')).toBe(false)
    expect(await stateOf($, 'reminder')).toBe('')
    // the main session is still told what the agent changed
    expect((await submit($)).context?.[0]).toContain('子 agent')
    // the count starts over with the next turn
    await turnStart($, 't2')
    await spawn($)
    await turnComplete($, 't2')
    expect(await stateOf($, 'stale')).toBe(true)
  })

  test('Bash, Read and Edit do not count as spawning agents', async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
    await edit($)
    await turnComplete($)
    expect(await stateOf($, 'stale')).toBe(false)
  })

  const notify = ($: any, agentId: string, over: Record<string, unknown> = {}) =>
    submit($, { text: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n</task-notification>`, origin: { kind: 'task-notification' }, ...over })

  test("a turn opened by a sub-agent's result that writes nothing owes the nudge", async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await spawn($)
    await update($, [{ op: 'item.update', id: 'i-b', status: 'doing' }])
    await turnComplete($)
    await turnComplete($, 'ta', 'a7f3c2e9')
    expect(await stateOf($, 'stale')).toBe(false)
    // the notification itself carries nothing; the nudge rides on the person's next message
    expect((await notify($, 'a7f3c2e9')).context).toBe(undefined)
    await turnStart($, 't2')
    await turnComplete($, 't2')
    expect(await stateOf($, 'stale')).toBe(true)
    expect((await submit($)).context).toEqual(['上一轮收到 1 个 agent 的结果，看板未更新；如有进展请补记'])
  })

  test("a turn opened by a sub-agent's result that writes the board owes nothing", async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnComplete($, 'ta', 'a7f3c2e9')
    await notify($, 'a7f3c2e9')
    await turnStart($, 't2')
    await update($, [{ op: 'item.update', id: 'i-b', status: 'review' }])
    await turnComplete($, 't2')
    expect(await stateOf($, 'stale')).toBe(false)
    expect((await submit($)).context).toBe(undefined)
  })

  test('a notification that names no finished sub-agent (a background shell) counts nothing', async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnComplete($, 'ta', 'a7f3c2e9')
    await notify($, 'b9shell01')
    await turnStart($, 't2')
    await turnComplete($, 't2')
    expect(await stateOf($, 'stale')).toBe(false)
  })

  test("the person's own turn is unchanged: a finished sub-agent alone owes nothing, and each result counts once", async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnComplete($, 'ta', 'a7f3c2e9')
    await submit($, { text: '看看 a7f3c2e9 的结果' })
    await turnStart($, 't2')
    await turnComplete($, 't2')
    expect(await stateOf($, 'stale')).toBe(false)
    await notify($, 'a7f3c2e9')
    await turnStart($, 't3')
    await turnComplete($, 't3')
    expect(await stateOf($, 'stale')).toBe(true)
    await update($, [{ op: 'item.update', id: 'i-b', note: '记了' }])
    await notify($, 'a7f3c2e9')
    await turnStart($, 't4')
    await turnComplete($, 't4')
    expect(await stateOf($, 'stale')).toBe(false)
  })

  test('a result delivered into a running turn counts for that turn, beside its own spawns', async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await spawn($)
    await turnComplete($, 'ta', 'a7f3c2e9')
    await notify($, 'a7f3c2e9', { turnId: 't1' })
    await turnComplete($)
    expect((await submit($)).context).toEqual(['上一轮派了 1 个 agent、收到 1 个 agent 的结果，看板未更新；如有进展请补记'])
  })

  test('turn.start resets the counts', async ($, on) => {
    world(on, small())
    mock.clock(on)
    await $.session.start(START)
    await sectionText($)
    await turnStart($)
    await spawn($)
    await turnStart($, 't2')
    await turnComplete($, 't2')
    expect(await stateOf($, 'stale')).toBe(false)
  })
})

// ---------- pure pieces ----------

describe('pure pieces', () => {
  test('TurnCounter verdict counts agent spawns and agent results', () => {
    const c = new TurnCounter()
    expect(c.verdict()).toEqual({ stale: false, agents: 0, results: 0 })
    c.count('Write', false)
    c.count('NotebookEdit', false)
    c.count('Bash', false)
    expect(c.verdict()).toEqual({ stale: false, agents: 0, results: 0 })
    c.count('Agent', false)
    expect(c.verdict()).toEqual({ stale: true, agents: 1, results: 0 })
    c.count('', true)
    expect(c.verdict().stale).toBe(false)
    c.reset()
    expect(c.verdict()).toEqual({ stale: false, agents: 0, results: 0 })
    c.received(2, true)
    expect(c.verdict()).toEqual({ stale: true, agents: 0, results: 2 })
    // a result that opens the next turn waits for that turn
    c.received(1, false)
    expect(c.verdict().results).toBe(2)
    c.reset()
    expect(c.verdict()).toEqual({ stale: true, agents: 0, results: 1 })
    c.reset()
    expect(c.verdict().results).toBe(0)
  })

  test('reminderText names what the turn did', () => {
    expect(reminderText({ agents: 2, results: 0 })).toBe('上一轮派了 2 个 agent，看板未更新；如有进展请补记')
    expect(reminderText({ agents: 0, results: 1 })).toBe('上一轮收到 1 个 agent 的结果，看板未更新；如有进展请补记')
    expect(reminderText({ agents: 1, results: 3 })).toBe('上一轮派了 1 个 agent、收到 3 个 agent 的结果，看板未更新；如有进展请补记')
  })

  test('isUserSubmission', () => {
    for (const kind of ['composer', 'sdk', 'bridge']) expect(isUserSubmission({ origin: { kind } })).toBe(true)
    for (const kind of ['peer', 'task-notification', 'scheduled-trigger']) expect(isUserSubmission({ origin: { kind } })).toBe(false)
    expect(isUserSubmission({ turnId: 't', origin: { kind: 'composer' } })).toBe(false)
  })

  test('formatUntold', () => {
    expect(formatUntold([])).toBe('')
    expect(formatUntold(['a', 'b'])).toContain('- a\n- b')
    expect(formatUntold(Array.from({ length: 80 }, (_, i) => `第 ${i} 行较长的变更描述文字，需要写得足够长才能让总长度越过一千五百字的上限`))).toBe('看板有 80 处外部变更，用 board_get 查看')
  })

  test('describeChanges names who, what and the move', () => {
    const before = small()
    const after = structuredClone(before)
    after.goals[0]!.items[0]!.status = 'review'
    after.goals[0]!.items.push(item('i-new', { title: '新事项' }))
    after.decisions.push({ id: 'd-2', date: '2026-10-11', text: '路灯先不做', kind: 'user', goalId: '', status: 'active' })
    after.focus = { ...after.focus, text: '换个关注' }
    const lines = describeChanges(before, after, '用户')
    expect(lines).toContain('用户：事项「事项 i-a」：在跑 → 待验收')
    expect(lines).toContain('用户：新增事项「新事项」（待办，目标：车辆）')
    expect(lines).toContain('用户：记录决策「路灯先不做」（用户定）')
    expect(lines.some(l => l.includes('关注改为「换个关注」'))).toBe(true)
    expect(describeChanges(before, before, '外部')).toEqual([])
  })

  test('describeChanges drops what does not change the AI judgement and keeps what does', () => {
    const before = small()
    const after = structuredClone(before)
    const it = after.goals[0]!.items[0]!
    it.title = '改名了'
    it.note = '备注'
    it.owner = '谁'
    it.waitingFor = '等谁'
    it.acceptance = '标准'
    it.links.push({ type: 'path', target: 'a.md', kind: '', label: '', forReview: true, step: 0 } as never)
    after.goals[0]!.outcome = '新成果'
    after.goals[0]!.links.push({ type: 'path', target: 'g.md', kind: '', label: '', forReview: false, step: 0 } as never)
    after.rules[0]!.text = '约定改了'
    after.notes.push({ id: 'n-1', title: '资料', text: 'x', group: '' } as never)
    after.milestones.enabled = !after.milestones.enabled
    expect(describeChanges(before, after, '外部')).toEqual([])
    after.rules.push({ id: 'r-2', text: '新约定', group: '' } as never)
    after.goals[0]!.status = 'paused'
    after.decisions[0]!.status = 'superseded'
    after.goals[0]!.items.push(item('i-new', { title: '新事项' }))
    const lines = describeChanges(before, after, '外部')
    expect(lines).toContain('外部：新增约定「新约定」')
    expect(lines).toContain('外部：目标「车辆」已暂停')
    expect(lines.some(l => l.includes('新增事项「新事项」'))).toBe(true)
    expect(lines.some(l => l.includes('已被替代'))).toBe(true)
  })

  test('closing a goal is one line, not one per item', () => {
    const before = small()
    const after = structuredClone(before)
    const g = after.goals.shift() as Goal
    after.archive.goals.push({ ...g, closedAt: NOW, closeReason: '完成' })
    after.focus.goalId = ''
    const lines = describeChanges(before, after, '外部')
    expect(lines).toContain('外部：目标「车辆」已关闭（完成）')
    expect(lines.some(l => l.includes('已删除'))).toBe(false)
  })
})
