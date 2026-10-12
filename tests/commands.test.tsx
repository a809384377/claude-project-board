import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { PAGE_CHARS, PAGE_LINES, runCommand, splitPage, type CommandCtx } from '../hooks/commands'
import { emptyBoard, parseBoard, serializeBoard } from '../hooks/model/parse'
import type { Board, Decision, Goal } from '../hooks/model/types'

const PROJ = '/home/me/Desktop/project/记账 小程序'
const BOARD = `${PROJ}/ai/board.json`
const START = { cwd: PROJ, surface: 'terminal' as const, isInteractive: true }

// ---------- builders ----------

function decision(id: string, over: Partial<Decision> = {}): Decision {
  return { id, date: '2026-10-10', text: `决策 ${id}`, kind: 'user', goalId: '', status: 'active', ...over }
}
function goal(id: string, title: string, over: Partial<Goal> = {}): Goal {
  return { id, title, outcome: '', status: 'active', links: [], steps: [], items: [], createdAt: '', updatedAt: '', ...over }
}
function boardWith(over: Partial<Board> = {}): Board {
  return { ...emptyBoard('demo'), ...over }
}

const ctxOf = (over: Partial<CommandCtx> = {}): CommandCtx => ({
  error: null,
  root: PROJ,
  init: async () => 'init-called',
  toggle: async () => 'toggle-called',
  ...over,
})
const run = (args: string, board: Board | null, over: Partial<CommandCtx> = {}) => runCommand(args, board, ctxOf(over)).then(r => r.text)
const linesOf = (t: string): number => t.split('\n').length

/** 200 decisions: 120 on 车辆, 80 project-level; ids d-000 … d-199, dates ascending. */
function bigBoard(): Board {
  const decisions: Decision[] = []
  for (let i = 0; i < 200; i++) {
    decisions.push(
      decision(`d-${String(i).padStart(3, '0')}`, {
        date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
        text: `第 ${i} 条决策，${'说明'.repeat(i % 40)}`,
        goalId: i < 120 ? 'g-car' : '',
      }),
    )
  }
  return boardWith({ goals: [goal('g-car', '车辆'), goal('g-ped', '行人')], decisions })
}

// ---------- the listings ----------

describe('splitPage', () => {
  test('a trailing number is the page, the rest is the filter', () => {
    expect(splitPage('车辆 2')).toEqual({ filter: '车辆', page: 2 })
    expect(splitPage('3')).toEqual({ filter: '', page: 3 })
    expect(splitPage('车辆')).toEqual({ filter: '车辆', page: 1 })
    expect(splitPage('车辆2')).toEqual({ filter: '车辆2', page: 1 })
    expect(splitPage('')).toEqual({ filter: '', page: 1 })
    expect(splitPage('车辆 0').page).toBe(1)
  })
})

describe('/board 约定 and 资料', () => {
  test('rules are listed under their group, in the order the groups first appear', async () => {
    const b = boardWith({
      rules: [
        { id: 'r-1', text: '管线只用 rebuild.sh', group: '管线' },
        { id: 'r-2', text: '车全部自建', group: '素材' },
        { id: 'r-3', text: '改完跑完整闸门', group: '管线' },
        { id: 'r-4', text: '没有分组的一条', group: '' },
      ],
    })
    const t = await run('约定', b)
    expect(t.split('\n')).toEqual([
      '约定 · 共 4 条',
      '【管线】',
      '- 管线只用 rebuild.sh（r-1）',
      '- 改完跑完整闸门（r-3）',
      '【素材】',
      '- 车全部自建（r-2）',
      '【未分组】',
      '- 没有分组的一条（r-4）',
    ])
  })

  test('notes show title and text on one line, grouped', async () => {
    const b = boardWith({ notes: [{ id: 'n-1', title: '环境', text: 'Blender 5.2.2\n第二行', group: '环境' }, { id: 'n-2', title: '规模', text: '', group: '环境' }] })
    const t = await run('资料', b)
    expect(t).toContain('【环境】')
    expect(t).toContain('- 环境：Blender 5.2.2 第二行（n-1）')
    expect(t).toContain('- 规模（n-2）')
  })

  test('nothing to list says so', async () => {
    expect(await run('约定', boardWith())).toBe('约定：还没有约定。')
    expect(await run('资料', boardWith())).toBe('资料：还没有资料。')
    expect(await run('决策', boardWith())).toBe('决策：没有生效中的决策。')
    expect(await run('决策 车辆', boardWith({ goals: [{ id: 'g-car', title: '车辆', outcome: '', status: 'active', links: [], steps: [], items: [], createdAt: '', updatedAt: '' }] }))).toBe('决策 · 车辆：没有生效中的决策。')
    expect(await run('约定', boardWith())).not.toContain('没有条')
  })
})

describe('/board 决策', () => {
  test('lists active decisions newest first, with the goal, who decided and the quote', async () => {
    const b = boardWith({
      goals: [goal('g-car', '车辆')],
      decisions: [
        decision('d-1', { date: '2026-10-08', text: '旧的', goalId: 'g-car' }),
        decision('d-2', { date: '2026-10-10', text: '新的', quote: '车全部自建', goalId: 'g-car' }),
        decision('d-3', { date: '2026-10-09', text: '项目级', kind: 'delegated' }),
        decision('d-4', { text: '已被替代', status: 'superseded' }),
      ],
    })
    const rows = (await run('决策', b)).split('\n')
    expect(rows[0]).toBe('决策 · 共 3 条')
    expect(rows[1]).toBe('d-2 · 2026-10-10 · 用户定 · [车辆] 新的（原话：车全部自建）')
    expect(rows[2]).toBe('d-3 · 2026-10-09 · Claude 代做 · [项目] 项目级')
    expect(rows[3]).toContain('d-1')
    expect(rows.join('\n')).not.toContain('已被替代')
  })

  test('a goal name filters; a part of the name is enough; an unknown name lists the goals', async () => {
    const b = bigBoard()
    const car = await run('决策 车辆', b)
    expect(car.split('\n')[0]).toMatch(/^决策 · 车辆 · 共 120 条/)
    expect(car).not.toContain('[行人]')
    expect((await run('决策 车', b)).split('\n')[0]).toMatch(/^决策 · 车辆 · 共 120 条/)
    const none = await run('决策 飞机', b)
    expect(none).toContain('没有名为「飞机」的进行中目标')
    expect(none).toContain('车辆、行人')
    expect(none).toContain('/board 归档 飞机')
  })

  test('a name matching two goals asks for a longer one', async () => {
    const b = boardWith({ goals: [goal('g-1', '车辆一期'), goal('g-2', '车辆二期')] })
    const t = await run('决策 车辆', b)
    expect(t).toContain('多个目标')
    expect(t).toContain('车辆一期、车辆二期')
  })

  test('200 decisions: every page holds at most 40 lines and 3,000 characters, ends with the next page command, and the pages together hold all of them', async () => {
    const b = bigBoard()
    const seen = new Set<string>()
    let page = 1
    let total = 0
    for (;;) {
      const t = await run(page === 1 ? '决策' : `决策 ${page}`, b)
      expect(linesOf(t)).toBeLessThanOrEqual(PAGE_LINES)
      expect(t.length).toBeLessThanOrEqual(PAGE_CHARS)
      const rows = t.split('\n')
      if (page === 1) total = Number(/共 \d+ 条 · 第 1\/(\d+) 页/.exec(rows[0] ?? '')?.[1])
      for (const r of rows) if (/^d-\d{3} /.test(r)) seen.add(r.slice(0, 5))
      const last = rows[rows.length - 1] ?? ''
      if (page < total) expect(last).toBe(`下一页：/board 决策 ${page + 1}`)
      else {
        expect(last).not.toContain('下一页')
        break
      }
      page++
    }
    expect(total).toBeGreaterThan(5)
    expect(page).toBe(total)
    expect(seen.size).toBe(200)
  })

  test('short lines are cut by the 40-line limit, header and footer included', async () => {
    const b = boardWith({ rules: Array.from({ length: 100 }, (_, i) => ({ id: `r-${i}`, text: `约${i}`, group: '' })) })
    const first = await run('约定', b)
    expect(linesOf(first)).toBe(PAGE_LINES)
    expect(first.split('\n')[0]).toBe('约定 · 共 100 条 · 第 1/3 页')
    expect(first.split('\n').pop()).toBe('下一页：/board 约定 2')
    expect(linesOf(await run('约定 3', b))).toBeLessThanOrEqual(PAGE_LINES)
  })

  test('a goal filter keeps its name in the next page command; a page past the end is told so', async () => {
    const b = bigBoard()
    const t = await run('决策 车辆', b)
    expect(t.split('\n').pop()).toBe('下一页：/board 决策 车辆 2')
    expect((await run('决策 车辆 2', b)).split('\n')[0]).toMatch(/第 2\/\d+ 页/)
    const past = await run('决策 车辆 99', b)
    expect(past).toMatch(/只有 \d+ 页（共 120 条）/)
    expect(linesOf(past)).toBe(1)
  })

  test('a 2,000-character decision is cut to one short line', async () => {
    const b = boardWith({ decisions: [decision('d-1', { text: '长'.repeat(2000), quote: '原'.repeat(2000) })] })
    const t = await run('决策', b)
    expect(linesOf(t)).toBe(2)
    expect(t.length).toBeLessThan(500)
    expect(t).toContain('…')
  })
})

describe('/board 归档', () => {
  const archived = (): Board =>
    boardWith({
      archive: {
        goals: [
          goal('g-old', '旧车辆', { closeReason: '完成', closedAt: '2026-10-01T09:00:00+08:00', outcome: '车做完', items: [{ id: 'i-1', title: '底盘' } as never] }),
          goal('g-x', '放弃的路', { closeReason: '放弃', closedAt: '2026-10-02T09:00:00+08:00' }),
        ],
        decisions: [decision('d-9', { goalId: 'g-old', text: '车身用生成器' })],
      },
    })

  test('lists closed goals and their decisions; a keyword narrows', async () => {
    const all = await run('归档', archived())
    expect(all).toContain('g-old · 目标 · 完成 · 2026-10-01 · 旧车辆 — 车做完（1 项事项）')
    expect(all).toContain('g-x · 目标 · 放弃')
    expect(all).toContain('d-9 · 2026-10-10 · 用户定 · [旧车辆] 车身用生成器')
    const kw = await run('归档 车身', archived())
    expect(kw.split('\n')[0]).toBe('归档 · 车身 · 共 1 条')
    expect(kw).not.toContain('g-x')
  })

  test('nothing found says so', async () => {
    expect(await run('归档 不存在', archived())).toBe('归档 · 不存在：没有匹配的归档内容。')
    expect(await run('归档', boardWith())).toBe('归档：还没有归档内容。')
  })
})

describe('/board with no board, bad files, init and unknown words', () => {
  test('without a board the listings and the toggle point at /board init', async () => {
    for (const a of ['决策', '约定', '资料', '归档', '']) {
      expect(await run(a, null, { root: null })).toContain('/board init')
    }
  })

  test('a board file that cannot be used shows why, for every listing', async () => {
    const t = await run('决策', null, { error: 'ai/board.json 无法解析：第 3 行' })
    expect(t).toBe('ai/board.json 无法解析：第 3 行')
  })

  test('init on a project that has a board says so and creates nothing', async () => {
    let called = 0
    const t = await run('init', boardWith(), { init: async () => (called++, 'x') })
    expect(t).toContain('看板已存在')
    expect(t).toContain(`${PROJ}/ai/board.json`)
    expect(called).toBe(0)
    const broken = await run('init miniapp', null, { error: '无法解析', init: async () => (called++, 'x') })
    expect(broken).toContain('看板已存在')
    expect(called).toBe(0)
  })

  test('init passes the type along (everything after init, trimmed) and shows what it returns', async () => {
    const seen: string[] = []
    const init = async (t: string) => (seen.push(t), '已创建')
    expect(await run('init', null, { root: null, init })).toBe('已创建')
    await run('init miniapp', null, { root: null, init })
    await run('  init   miniapp  ', null, { root: null, init })
    expect(seen).toEqual(['', 'miniapp', 'miniapp'])
  })

  test('a failing init is reported, not thrown', async () => {
    const t = await run('init', null, { root: null, init: async () => Promise.reject(new Error('磁盘满')) })
    expect(t).toBe('创建看板失败：磁盘满')
  })

  test('a bare /board toggles; an unknown word prints the usage', async () => {
    expect(await run('', boardWith())).toBe('toggle-called')
    const usage = await run('帮助', boardWith())
    for (const w of ['决策', '约定', '资料', '归档', 'init']) expect(usage).toContain(w)
  })
})

// ---------- through the engine ----------

type World = {
  files: Map<string, { text: string; mtime: number }>
  registered: string[]
  commands: string[]
  opens: string[]
  closes: string[]
  panes: Array<{ id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }>
  placeOk: boolean
}

function world(on: On, initial: Board | null): World {
  const w: World = { files: new Map(), registered: [], commands: [], opens: [], closes: [], panes: [], placeOk: true }
  let tick = 1000
  const put = (p: string, text: string) => w.files.set(p, { text, mtime: ++tick })
  if (initial !== null) put(BOARD, serializeBoard(initial))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
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
  on('ui.panes', () => ({ value: w.panes }))
  on('ui.open', (_$, e) => {
    w.opens.push(e.id)
    if (!w.placeOk) return { value: { isPlaced: false as const, reason: 'narrow' as never } }
    w.panes = [{ id: e.id, title: '看板', isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    w.closes.push(e.id)
    w.panes = w.panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">ENGINE_DEFAULT</Text>
  })
  on('tool.register', (_$, e) => {
    w.registered.push(e.name)
    return { value: { tool: `mcp__project-board__${e.name}` } }
  })
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  return w
}

const boardOf = (w: World): Board => {
  const r = parseBoard(w.files.get(BOARD)?.text ?? '')
  if (!r.ok) throw new Error(r.error)
  return r.board
}
const slash = ($: any, args: string): Promise<{ text?: string }> => $.command.run({ command: 'board', args })

describe('/board through the engine', () => {
  const sample = (): Board =>
    boardWith({
      goals: [goal('g-car', '车辆')],
      decisions: [decision('d-1', { goalId: 'g-car', text: '车全部自建' })],
      rules: [{ id: 'r-1', text: '管线只用 rebuild.sh', group: '管线' }],
    })

  test('the command is registered at session start, board or not', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    expect(w.commands).toEqual(['board'])
  })

  test('/board 约定 and /board 决策 车辆 answer with text and no model turn', async ($, on) => {
    world(on, sample())
    mock.clock(on)
    await $.session.start(START)
    const r = await slash($, '约定')
    expect(r.text).toContain('管线只用 rebuild.sh')
    const d = await slash($, '决策 车辆')
    expect(d.text).toContain('[车辆] 车全部自建')
  })

  test('without a board the answer points at /board init', async ($, on) => {
    world(on, null)
    mock.clock(on)
    await $.session.start(START)
    expect((await slash($, '约定')).text).toContain('/board init')
  })

  test('/board init miniapp creates ai/board.json with the type and the directory name, and the full tool set appears', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    expect(w.registered).toEqual(['board_init'])
    const r = await slash($, 'init miniapp')
    expect(r.text).toContain('已创建 ai/board.json')
    expect(r.text).toContain('miniapp')
    const b = boardOf(w)
    expect(b.project).toEqual({ name: '记账 小程序', type: 'miniapp' })
    expect(w.registered).toEqual(['board_init', 'board_get', 'board_update', 'board_propose', 'board_init'])
    // the board is now live: listings work without a restart
    expect((await slash($, '约定')).text).toBe('约定：还没有约定。')
    expect((await slash($, 'init')).text).toContain('看板已存在')
  })

  test('/board init without a type leaves project.type out', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    await slash($, 'init')
    expect(boardOf(w).project).toEqual({ name: '记账 小程序' })
    expect(w.files.get(BOARD)?.text).not.toContain('"type"')
  })

  test('board_init takes name and type, and the full tool set appears', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    const out = JSON.parse(((await $.tool.call({ tool: 'mcp__project-board__board_init', name: '记账小程序', type: 'miniapp' } as never)) as { result: string }).result)
    expect(out.ok).toBe(true)
    expect(boardOf(w).project).toEqual({ name: '记账小程序', type: 'miniapp' })
    expect(w.registered).toEqual(['board_init', 'board_get', 'board_update', 'board_propose', 'board_init'])
  })

  test('board_init refuses a type that is not a string', async ($, on) => {
    const w = world(on, null)
    mock.clock(on)
    await $.session.start(START)
    const out = JSON.parse(((await $.tool.call({ tool: 'mcp__project-board__board_init', type: 3 } as never)) as { result: string }).result)
    expect(out.ok).toBe(false)
    expect(w.files.has(BOARD)).toBe(false)
  })

  const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 70, scroll: { offset: 0, bodyRows: 13 }, view: {} }
  const PANE_PROPS = { title: '看板', isFocused: false, bodyColumns: 71, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
  const drawBand = ($: any, viewport: object) =>
    $.ui.mount({ plugin: 'project-board', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS, viewport })

  test('landscape: a bare /board opens the side pane, the next one folds it; the words are fixed', async ($, on) => {
    const w = world(on, sample())
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    w.opens.length = 0
    w.panes = []
    await drawBand($, { columns: 160, rows: 50, isFullscreen: true })
    expect((await slash($, '')).text).toBe('已打开看板（右侧）')
    expect(w.opens).toEqual(['board'])
    expect((await slash($, '')).text).toBe('已收起看板')
    expect(w.closes).toContain('board')
    expect((await slash($, '')).text).toBe('已打开看板（右侧）')
  })

  test('when the pane cannot be placed the answer says the terminal is too narrow', async ($, on) => {
    const w = world(on, sample())
    w.placeOk = false
    mock.clock(on)
    await $.session.start(START)
    w.panes = []
    await drawBand($, { columns: 100, rows: 30, isFullscreen: true })
    expect((await slash($, '')).text).toContain('终端太窄')
  })

  test('portrait: a bare /board folds and unfolds the board above the prompt; the pane is never opened', async ($, on) => {
    const w = world(on, sample())
    mock.clock(on)
    await $.session.start(START)
    const tall = { columns: 60, rows: 80, isFullscreen: true }
    const full = await drawBand($, tall)
    expect(await full.find({ key: 'goal:g-car' })).toBeDefined()
    w.opens.length = 0
    w.panes = []
    expect((await slash($, '')).text).toBe('已收起看板')
    const folded = await drawBand($, tall)
    expect(await folded.find({ key: 'goal:g-car' })).toBeUndefined()
    expect(await folded.findAll({ type: 'Text', text: /\/board 打开/ })).not.toHaveLength(0)
    expect((await slash($, '')).text).toBe('已打开看板（输入框上方）')
    expect(await (await drawBand($, tall)).find({ key: 'goal:g-car' })).toBeDefined()
    expect(w.opens).toEqual([])
  })

  test('a docked pane on a landscape terminal is visible: the next /board folds it, the one after opens it', async ($, on) => {
    const w = world(on, sample())
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    // 160x50 with the pane up: the conversation has 88 columns
    const vp = { columns: 88, rows: 50, isFullscreen: true }
    const pane = await $.ui.mount({ plugin: 'project-board', surface: 'terminal', component: 'Pane', requestId: 'board', props: PANE_PROPS, viewport: vp })
    const band0 = await drawBand($, vp)
    expect(w.panes.some(p => p.isPlaced)).toBe(true)
    expect((await slash($, '')).text).toBe('已收起看板')
    expect(w.panes).toEqual([])
    // the engine drops the pane and widens the conversation
    await pane.unmount()
    await band0.unmount()
    await drawBand($, { columns: 160, rows: 50, isFullscreen: true })
    expect((await slash($, '')).text).toBe('已打开看板（右侧）')
  })

  test('the pane inline above the prompt (not fullscreen): open says above the prompt, the next one folds it', async ($, on) => {
    const w = world(on, sample())
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    w.panes = []
    await drawBand($, { columns: 100, rows: 40, isFullscreen: false })
    expect((await slash($, '')).text).toBe('已打开看板（输入框上方）')
    expect((await slash($, '')).text).toBe('已收起看板')
  })

  test('folding takes the narrow view above the prompt with it, even when the window turned portrait while the pane sat above the prompt', async ($, on) => {
    const w = world(on, sample())
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    w.panes = []
    await drawBand($, { columns: 100, rows: 40, isFullscreen: false })
    w.panes = [{ id: 'board', title: '看板', isShown: true, isFocused: false, isPlaced: true }]
    await drawBand($, { columns: 60, rows: 80, isFullscreen: false })
    expect((await slash($, '')).text).toBe('已收起看板')
    expect(w.panes).toEqual([])
    const after = await drawBand($, { columns: 60, rows: 80, isFullscreen: false })
    expect(await after.find({ key: 'goal:g-car' })).toBeUndefined()
    expect(await after.findAll({ type: 'Text', text: /\/board 打开/ })).not.toHaveLength(0)
  })

  test('the one-line entry is a button that opens the board like /board', async ($, on) => {
    const w = world(on, sample())
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    w.panes = []
    w.opens.length = 0
    const band = await drawBand($, { columns: 160, rows: 50, isFullscreen: true })
    expect(await band.find({ key: 'open-board' })).toBeDefined()
    await band.press({ key: 'open-board' })
    expect(w.opens).toEqual(['board'])
  })
})
