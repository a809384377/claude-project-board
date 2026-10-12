import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { applyOps } from '../hooks/model/ops'
import { emptyBoard, parseBoard, serializeBoard } from '../hooks/model/parse'
import type { Board, Goal, Item, Link, Step } from '../hooks/model/types'
import { entryText } from '../hooks/view/board'
import { partitionGoals } from '../hooks/view/derive'
import { decideLayout, isPortrait, parseSetting } from '../hooks/view/layout'
import { hex, paletteFor, titleBg } from '../hooks/view/motion'

declare const console: { log(...args: unknown[]): void }

const PROJ = '/proj'
const BOARD = `${PROJ}/ai/board.json`
const NOW = '2026-10-11T09:00:00+08:00'
const START = { cwd: PROJ, surface: 'terminal' as const, isInteractive: true }
const SURFACES = ['terminal', 'desktop'] as const
const REPORT = `${PROJ}/ai/scratch/cars/施工报告.md`

const PANE_PROPS = { title: '看板', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 70, scroll: { offset: 0, bodyRows: 13 }, view: {} }
const LANDSCAPE = { columns: 160, rows: 50, isFullscreen: true }
const PORTRAIT = { columns: 60, rows: 80, isFullscreen: true }

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
const link = (over: Partial<Link>): Link => ({ type: 'path', kind: '报告', target: 'ai/scratch/cars/施工报告.md', label: '', forReview: false, ...over })

/** A focus goal, a goal with motion (running here, running elsewhere, waiting for review), an idle goal and a paused one. */
function fixture(): Board {
  const b = emptyBoard('记账小程序')
  b.milestones = { enabled: true, items: [{ id: 'm-1', title: '4 资产制作', status: '进行中', note: '', gates: [] }] }
  b.goals.push(
    goal('g-idle', '画面细节欠账', [item('i-t1'), item('i-t2')]),
    goal('g-car', '车辆与车流', [
      item('i-run', { title: 'A 路第二段', status: 'running', owner: 'build-cars', session: 'sess-1', reportedAt: NOW }),
      item('i-old', { title: 'C 路车流', status: 'running', owner: 'build-traffic', session: 'sess-old', reportedAt: '2026-10-10T21:30:00+08:00' }),
      item('i-rev', {
        title: 'A 路第一段', status: 'review', owner: 'build-cars',
        links: [link({ label: '第 7 节', forReview: true }), link({ type: 'url', kind: '链接', target: 'http://localhost:5173/', forReview: true }), link({ type: 'command', kind: '命令', target: 'bun run dev' })],
      }),
      item('i-q', { title: 'B 路', status: 'queued', waitingFor: '行人一路先提交' }),
      item('i-d1', { title: '车身生成器', status: 'done', doneBy: 'user' }),
      item('i-d2', { title: '车牌贴图', status: 'done', doneBy: 'claude' }),
      item('i-x', { title: '旧方案', status: 'dropped' }),
    ]),
    goal('g-ped', '行人与居民', [item('i-p1', { title: '居民坐姿' }), item('i-p2', { title: '行人投影' })]),
    goal('g-pause', '总装', [item('i-a1')], { status: 'paused' }),
  )
  b.focus = { text: '全场验收前收齐三路施工', goalId: 'g-ped', mandate: '一直推进到请用户看全场', updatedAt: NOW }
  b.proposals.push({ id: 'p-1', action: 'goal.create', payload: { title: '路灯', outcome: '' }, reason: '用户说要加路灯', createdAt: NOW })
  return b
}

// ---------- the world beneath the plugin ----------

type World = {
  files: Map<string, { text: string; mtime: number }>
  runs: string[][]
  copies: Array<{ text: string; surface: string | undefined }>
  toasts: string[]
  opens: string[]
  closes: string[]
  submitted: Array<readonly string[] | undefined>
  panes: Array<{ id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }>
  openFails: boolean
  home: string | undefined
  copyOk: boolean
  state: Record<string, unknown>
  /** Writes fail while this is set. */
  writeFails: boolean
  /** Writes wait for this promise when set. */
  gate: Promise<void> | null
  /** The theme the settings list reports. */
  theme: string | undefined
  /** Every canvas repaint the plugin asked for. */
  blits: Array<{ requestId: string; key: string; cells: string }>
  /** Repaints are refused while this is set. */
  denyBlit: boolean
  /** Every fs.exists answered, in order, with anything else a test chooses to note. */
  log: string[]
}
const placedPane = (isPlaced: boolean) => [{ id: 'board', title: '看板', isShown: true, isFocused: false, isPlaced }]

function world(on: On, initial: Board | null, opts: { placed?: boolean; existing?: string[]; root?: string; theme?: string; reduceMotion?: boolean } = {}): World {
  const w: World = { files: new Map(), runs: [], copies: [], toasts: [], opens: [], closes: [], submitted: [], panes: placedPane(opts.placed ?? true), openFails: false, home: '/home/me', copyOk: true, state: {}, writeFails: false, gate: null, theme: opts.theme, blits: [], denyBlit: false, log: [] }
  on('config.list', () => ({ value: [...(w.theme === undefined ? [] : [{ key: 'theme', value: w.theme }]), { key: 'reduceMotion', value: opts.reduceMotion === true || w.state.rm === true }] as never }))
  on('config.set', (_$, e) => ({ value: e.value }) as never)
  on('ui.blit', (_$, e) => {
    const a = e as unknown as { requestId: string; key: string; cells: string }
    w.blits.push({ requestId: a.requestId, key: a.key, cells: a.cells })
    return { value: w.denyBlit ? { deny: 'no Raster of its own is mounted' } : {} }
  })
  let tick = 1000
  const put = (p: string, text: string) => w.files.set(p, { text, mtime: ++tick })
  if (initial !== null) put(BOARD, serializeBoard(initial))
  for (const p of opts.existing ?? [REPORT]) put(p, 'x')
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: opts.root ?? PROJ }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? w.home : undefined }))
  on('fs.read', (_$, e) => {
    const f = w.files.get(e.path)
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: f.text }
  })
  on('fs.write', async (_$, e) => {
    if (w.gate !== null) await w.gate
    if (w.writeFails) throw new Error('disk full')
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => {
    w.log.push('exists')
    return { value: w.files.has(e.path) }
  })
  on('fs.stat', (_$, e) => {
    const f = w.files.get(e.path)
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtime, isLink: false } }
  })
  const done = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  on('process.run', (_$, e) => {
    const [cmd] = e.argv
    if (cmd === 'mv') {
      const f = w.files.get(e.argv[2] as string)
      if (f) {
        w.files.delete(e.argv[2] as string)
        put(e.argv[3] as string, f.text)
      }
      return { value: done }
    }
    if (cmd === 'uname') return { value: { ...done, stdout: 'Darwin\n' } }
    w.runs.push([...e.argv])
    return { value: w.openFails ? { ...done, exitCode: 1, stderr: 'LSOpenURLsWithRole() failed' } : done }
  })
  on('ui.copy', (_$, e) => {
    w.copies.push({ text: e.text, surface: e.surface })
    return { value: w.copyOk ? { isCopied: true as const } : { isCopied: false as const, reason: 'refused' as const } }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: w.panes }))
  on('ui.open', (_$, e) => {
    w.opens.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    w.closes.push(e.id)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">ENGINE_DEFAULT</Text>
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__project-board__${e.name}` } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('state.set', (_$, e, next) => {
    const s = e as unknown as { key: string; value: unknown }
    w.state[s.key] = s.value
    return next(e)
  })
  on('prompt.submit', (_$, e) => {
    w.submitted.push(e.context)
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  return w
}

const boardOf = (w: World): Board => {
  const r = parseBoard(w.files.get(BOARD)?.text ?? '')
  if (!r.ok) throw new Error(r.error)
  return r.board
}

// ---------- drawing a tree as terminal text ----------

type Node = string | { type: string; props: Record<string, unknown>; children?: Node[] }
const cellWidth = (c: string): number => (c.charCodeAt(0) >= 0x2e80 ? 2 : 1)
/** Cuts or wraps one line to `width` cells the way the terminal lays out a Text. */
function fit(line: string, width: number, mode: 'cut' | 'wrap'): string[] {
  const out: string[] = []
  let cur = ''
  let w = 0
  for (const ch of [...line]) {
    if (w + cellWidth(ch) > width) {
      if (mode === 'cut') return [`${cur.slice(0, -1)}…`]
      out.push(cur)
      cur = ''
      w = 0
    }
    cur += ch
    w += cellWidth(ch)
  }
  return [...out, cur]
}
function inline(n: Node): string {
  if (typeof n === 'string') return n
  const kids = (n.children ?? []).map(inline).join('')
  const pr = n.props ?? {}
  if (n.type === 'Button') return pr.plain === true ? kids : `[ ${String(pr.label)} ]`
  return kids
}
function rows(n: Node, width: number): string[] {
  if (typeof n === 'string') return [n]
  if (n.type !== 'Box') {
    const text = inline(n)
    if (n.type !== 'Text') return [text]
    return fit(text, width, String((n.props ?? {}).wrap ?? 'wrap').startsWith('truncate') ? 'cut' : 'wrap')
  }
  const p = n.props ?? {}
  const inner = width - Number(p.paddingLeft ?? 0) - (p.borderStyle !== undefined ? 4 : 0)
  const kids = n.children ?? []
  const column = p.flexDirection === 'column'
  let out = column ? kids.flatMap(k => rows(k, inner)) : [kids.flatMap(k => rows(k, inner)).join(' ')]
  const pad = ' '.repeat(Number(p.paddingLeft ?? 0))
  out = out.map(l => pad + l)
  if (p.borderStyle !== undefined) {
    const w = Math.max(0, ...out.map(l => [...l].reduce((a, c) => a + cellWidth(c), 0)))
    out = [`┌${'─'.repeat(w + 1)}┐`, ...out.map(l => `│ ${l}`), `└${'─'.repeat(w + 1)}┘`]
  }
  return Number(p.marginTop ?? 0) > 0 ? ['', ...out] : out
}
const screen = (n: unknown, width: number): string => rows(n as Node, width).join('\n')

// ---------- helpers ----------

type Ui = Awaited<ReturnType<ReturnType<typeof mountPane>>>
const mountPane = ($: any, surface: (typeof SURFACES)[number], viewport = LANDSCAPE, props: object = PANE_PROPS) => () =>
  $.ui.mount({ plugin: 'project-board', surface, component: 'Pane', requestId: 'board', props, viewport })
const mountBand = ($: any, surface: (typeof SURFACES)[number], viewport = PORTRAIT, props: object = BAND_PROPS) =>
  $.ui.mount({ plugin: 'project-board', surface, component: 'AbovePrompt', props, viewport })
const pane = ($: any, surface: (typeof SURFACES)[number], viewport = LANDSCAPE): Promise<Ui> => mountPane($, surface, viewport)()
const texts = async (ui: any, re: RegExp): Promise<string[]> => (await ui.findAll({ type: 'Text', text: re })).map((t: { text: string }) => t.text)
const keys = async (ui: any, prefix: string): Promise<string[]> =>
  (await ui.findAll({ type: 'Button' })).map((b: { key: string }) => b.key).filter((k: string) => k.startsWith(prefix))
/** Two edits and no board write in a main-session turn leaves the board stale. */
async function makeStale($: any): Promise<void> {
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'b.ts' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
}
const submit = ($: any) => $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as never) as Promise<{ context?: readonly string[] }>

// ---------- layout decision ----------

describe('decideLayout', () => {
  const land = { columns: 160, rows: 50 }
  const tall = { columns: 60, rows: 80 }
  test('landscape: the pane when it is on screen, the one-line entry when it is not', () => {
    expect(decideLayout(land, { isPlaced: true }, 'auto')).toBe('pane')
    expect(decideLayout(land, { isPlaced: false }, 'auto')).toBe('band-entry')
  })
  test('portrait: the full board above the prompt, whether or not a pane is up', () => {
    expect(decideLayout(tall, { isPlaced: false }, 'auto')).toBe('band-full')
    expect(decideLayout(tall, { isPlaced: true }, 'auto')).toBe('band-full')
  })
  test('rows * 2 > columns is the portrait line', () => {
    expect(isPortrait({ columns: 100, rows: 50 })).toBe(false)
    expect(isPortrait({ columns: 100, rows: 51 })).toBe(true)
  })
  test('right and bottom force their result', () => {
    expect(decideLayout(tall, { isPlaced: true }, 'right')).toBe('pane')
    expect(decideLayout(tall, { isPlaced: false }, 'right')).toBe('pane')
    expect(decideLayout(land, { isPlaced: true }, 'bottom')).toBe('band-full')
    expect(decideLayout(land, { isPlaced: false }, 'bottom')).toBe('band-full')
  })
  test('a missing viewport counts as landscape', () => {
    expect(decideLayout(undefined, { isPlaced: true }, 'auto')).toBe('pane')
    expect(decideLayout(undefined, { isPlaced: false }, 'auto')).toBe('band-entry')
  })
  test('the setting reads auto for anything outside the picker', () => {
    expect(parseSetting('right')).toBe('right')
    expect(parseSetting('sideways')).toBe('auto')
    expect(parseSetting(undefined)).toBe('auto')
  })
})

// ---------- the pane ----------

for (const surface of SURFACES) {
  describe(`pane content (${surface})`, () => {
    test('the focus goal comes first, then goals in motion, idle ones fold, paused ones wait in their own fold', async ($, on) => {
      world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await keys(ui, 'goal:')).toEqual(['goal:g-ped', 'goal:g-car', 'goal:g-idle'])
      expect((await ui.find({ key: 'fold:paused' }))?.text).toBe('▸ ⏸ 暂停 1 个目标 · 总装')
      // focus goal and the goal in motion are open; the idle and paused ones are folded
      expect(await ui.find({ key: 'item:i-p1' })).toBeDefined()
      expect(await ui.find({ key: 'item:i-run' })).toBeDefined()
      expect(await ui.find({ key: 'item:i-t1' })).toBeUndefined()
      expect(await ui.find({ key: 'item:i-a1' })).toBeUndefined()
      expect((await ui.find({ key: 'goal:g-ped' }))?.text).toContain('★')
      expect(await texts(ui, /^★ 全场验收前收齐三路施工/)).toHaveLength(1)
      expect(await texts(ui, /^授权：一直推进到请用户看全场/)).toHaveLength(1)
      expect(await texts(ui, /阶段：4 资产制作/)).toHaveLength(1)
      // the other goals offer 设为关注, the focus goal and the paused one do not
      expect(await keys(ui, 'focus:')).toEqual(['focus:g-car', 'focus:g-idle'])
    })

    test('done and dropped items fold into one count line that opens on demand', async ($, on) => {
      world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect((await ui.find({ key: 'done:g-car' }))?.text).toContain('✓ 已完成 2 项 · 搁置 1 项')
      expect(await ui.find({ type: 'Text', text: /车身生成器/ })).toBeUndefined()
      await ui.press({ key: 'done:g-car' })
      expect(await texts(ui, /车身生成器（你验收）/)).toHaveLength(1)
      expect(await texts(ui, /车牌贴图（Claude 验收）/)).toHaveLength(1)
      const user = await ui.find({ type: 'Text', text: /车身生成器/ })
      const claude = await ui.find({ type: 'Text', text: /车牌贴图/ })
      // Who accepted an item no longer shows in colour: both are plain grey
      expect([user?.props.color, claude?.props.color]).toEqual([undefined, undefined])
      expect([user?.props.dimColor, claude?.props.dimColor]).toEqual([true, true])
    })

    test('a running item from another session reads unverified; this session\'s does not', async ($, on) => {
      world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      const lines = await texts(ui, /./)
      expect(lines.filter(t => t.includes('上次报告在跑'))).toEqual(['上次报告在跑 · 10-10 21:30 · 未核实'])
      if (surface === 'terminal') {
        // the terminal draws a spinner canvas: two frames a second and faded for the old report, ten for this session's
        expect(await ui.find({ type: 'Raster', key: 'spin:i-old' })).toBeDefined()
        expect(await ui.find({ type: 'Raster', key: 'spin:i-run' })).toBeDefined()
        expect(await ui.find({ type: 'Raster', key: 'spin:i-old' })).not.toEqual(await ui.find({ type: 'Raster', key: 'spin:i-run' }))
      } else {
        const old = (await ui.find({ key: 'item:i-old' }))?.children as Array<{ props: Record<string, unknown> }>
        const mine = (await ui.find({ key: 'item:i-run' }))?.children as Array<{ props: Record<string, unknown> }>
        expect(old[0]?.props.dimColor).toBe(true)
        expect(mine[0]?.props.dimColor).toBe(false)
      }
    })

    test('waiting-for text shows under the item; a proposal shows as a card', async ($, on) => {
      world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await texts(ui, /^等：行人一路先提交/)).toHaveLength(1)
      expect(await texts(ui, /^待你确认$/)).toHaveLength(1)
      expect(await texts(ui, /新建目标：路灯/)).toHaveLength(1)
      expect(await texts(ui, /理由：用户说要加路灯/)).toHaveLength(1)
      expect(await ui.find({ key: 'yes:p-1' })).toBeDefined()
      expect(await ui.find({ key: 'no:p-1' })).toBeDefined()
    })

    test('title row: the stale mark follows the end-of-turn check', async ($, on) => {
      world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await texts(ui, /看板可能落后/)).toHaveLength(0)
      await makeStale($)
      expect(await texts(ui, /⚠ 看板可能落后/)).toHaveLength(1)
    })

    test('a goal title toggles open and closed; the choice is kept in $.state', async ($, on) => {
      const w = world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await ui.find({ key: 'item:i-run' })).toBeDefined()
      await ui.press({ key: 'goal:g-car' })
      expect(await ui.find({ key: 'item:i-run' })).toBeUndefined()
      expect(w.state.expanded).toEqual({ 'g-car': false })
      await ui.press({ key: 'goal:g-idle' })
      expect(await ui.find({ key: 'item:i-t1' })).toBeDefined()
      await ui.press({ key: 'goal:g-car' })
      expect(await ui.find({ key: 'item:i-run' })).toBeDefined()
    })

    test('an item opens to show its details and review links', async ($, on) => {
      const b = fixture()
      ;(b.goals[1]?.items[3] as Item).acceptance = '三款车都能在场景里看到'
      ;(b.goals[1]?.items[3] as Item).scope = ['src/cars/a.ts', 'src/cars/b.ts']
      world(on, b)
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await texts(ui, /验收标准/)).toHaveLength(0)
      await ui.press({ key: 'item:i-q' })
      expect(await texts(ui, /^验收标准：三款车都能在场景里看到/)).toHaveLength(1)
      expect(await texts(ui, /^负责文件：src\/cars\/a.ts、src\/cars\/b.ts/)).toHaveLength(1)
    })
  })
}

// ---------- buttons that change the board ----------

for (const surface of SURFACES) {
  describe(`board buttons (${surface})`, () => {
    test('验收通过 exists on review items only; pressing it marks done by the user and tells Claude next turn', async ($, on) => {
      const w = world(on, fixture())
      const clock = mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await keys(ui, 'approve:')).toEqual(['approve:i-rev'])
      await ui.press({ key: 'approve:i-rev' })
      const it = boardOf(w).goals.find(g => g.id === 'g-car')?.items.find(i => i.id === 'i-rev')
      expect(it).toMatchObject({ status: 'done', doneBy: 'user' })
      expect(boardOf(w).rev).toBe(1)
      // the stamp stands where the button was, then the row goes into the folded line
      expect(await keys(ui, 'approve:')).toEqual([])
      expect((await texts(ui, /▓▓▓▓|✓ 通过/)).length).toBeGreaterThan(0)
      expect((await ui.find({ key: 'done:g-car' }))?.text).toContain('已完成 2 项')
      await clock.advance(700)
      expect(await texts(ui, /▓▓▓▓|✓ 通过/)).toHaveLength(0)
      expect((await ui.find({ key: 'done:g-car' }))?.text).toContain('已完成 3 项')
      // the user's change rides on the next user message
      const sent = await submit($)
      expect(sent.context?.join('\n')).toContain('A 路第一段')
      expect(sent.context?.join('\n')).toContain('用户')
      expect((await submit($)).context).toBeUndefined()
    })

    test('验收通过 on an item that is no longer in review does nothing and says so', async ($, on) => {
      const w = world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      // someone else moves it to doing before the press lands
      const parsed = parseBoard(w.files.get(BOARD)?.text ?? '{}')
      if (!parsed.ok) throw new Error(parsed.error)
      const raw = parsed.board
      ;(raw.goals[1]?.items[2] as Item).status = 'doing'
      raw.rev += 1
      w.files.set(BOARD, { text: serializeBoard(raw), mtime: 99999 })
      await ui.press({ key: 'approve:i-rev' })
      expect(boardOf(w).goals[1]?.items[2]?.status).toBe('doing')
      expect(w.toasts.join('\n')).toContain('已不在待验收状态')
    })

    test('同意 executes the proposal once even when pressed twice at the same time', async ($, on) => {
      const w = world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      const results = await Promise.allSettled([ui.press({ key: 'yes:p-1' }), ui.press({ key: 'yes:p-1' })])
      expect(results.length).toBe(2)
      const b = boardOf(w)
      expect(b.goals.filter(g => g.title === '路灯')).toHaveLength(1)
      expect(b.goals.find(g => g.title === '路灯')).toMatchObject({ confirmedBy: 'sidebar' })
      expect(b.proposals).toEqual([])
      expect(b.rev).toBe(1)
      expect(w.toasts.join('\n')).toContain('不存在或已处理')
      expect(await texts(ui, /^待你确认$/)).toHaveLength(0)
    })

    test('不要 drops the proposal and creates nothing', async ($, on) => {
      const w = world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      await ui.press({ key: 'no:p-1' })
      expect(boardOf(w).proposals).toEqual([])
      expect(boardOf(w).goals.some(g => g.title === '路灯')).toBe(false)
    })

    test('设为关注 acts at once, keeps the standing mandate, and is told to Claude', async ($, on) => {
      const w = world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      await ui.press({ key: 'focus:g-car' })
      const f = boardOf(w).focus
      expect(f.goalId).toBe('g-car')
      expect(f.text).toBe('车辆与车流')
      expect(f.mandate).toBe('一直推进到请用户看全场')
      // the car goal now leads the list, and its own focus button is gone
      expect(await keys(ui, 'goal:')).toEqual(['goal:g-car', 'goal:g-idle', 'goal:g-ped'])
      expect(await ui.find({ key: 'focus:g-car' })).toBeUndefined()
      expect((await submit($)).context?.join('\n')).toContain('关注')
    })
  })
}

// ---------- links on review items ----------

for (const surface of SURFACES) {
  describe(`acceptance buttons (${surface})`, () => {
    test('a report gets 打开 / VS Code / 复制路径; a url 打开 / 复制; a command 复制命令', async ($, on) => {
      world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await keys(ui, 'link:i-rev:')).toEqual([
        'link:i-rev:0:open', 'link:i-rev:0:vscode', 'link:i-rev:0:copy',
        'link:i-rev:1:open', 'link:i-rev:1:copy',
        'link:i-rev:2:copy',
      ])
      expect((await ui.find({ key: 'link:i-rev:2:copy' }))?.props.label).toBe('复制命令')
    })

    test('the buttons pass absolute paths to open, unchanged, without a shell', async ($, on) => {
      const w = world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      await ui.press({ key: 'link:i-rev:0:open' })
      await ui.press({ key: 'link:i-rev:0:vscode' })
      await ui.press({ key: 'link:i-rev:1:open' })
      expect(w.runs).toEqual([
        ['open', REPORT],
        ['open', '-a', 'Visual Studio Code', REPORT],
        ['open', 'http://localhost:5173/'],
      ])
    })

    test('copy sends the text and the surface that was pressed', async ($, on) => {
      const w = world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      await ui.press({ key: 'link:i-rev:0:copy' })
      await ui.press({ key: 'link:i-rev:2:copy' })
      expect(w.copies).toEqual([
        { text: REPORT, surface },
        { text: 'bun run dev', surface },
      ])
      expect(w.runs).toEqual([])
    })

    test('a failing open falls back to copying; if that fails too the toast shows the full path', async ($, on) => {
      const w = world(on, fixture())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      w.openFails = true
      await ui.press({ key: 'link:i-rev:0:open' })
      expect(w.copies).toEqual([{ text: REPORT, surface }])
      expect(w.toasts.at(-1)).toContain('已把路径复制到剪贴板')
      w.copyOk = false
      await ui.press({ key: 'link:i-rev:0:open' })
      expect(w.toasts.at(-1)).toContain(`完整内容：${REPORT}`)
    })

    test('a missing file shows dim buttons and a toast instead of running open', async ($, on) => {
      const w = world(on, fixture(), { existing: [] })
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      // the review entry shows in the "待你处理" block and under its item
      expect(await texts(ui, /文件不存在/)).toHaveLength(2)
      expect((await ui.find({ key: 'todo-link:i-rev:0:open' }))?.props.dimColor).toBe(true)
      expect((await ui.find({ key: 'link:i-rev:0:open' }))?.props.dimColor).toBe(true)
      expect((await ui.find({ key: 'link:i-rev:0:copy' }))?.props.dimColor).toBe(false)
      await ui.press({ key: 'link:i-rev:0:open' })
      expect(w.runs).toEqual([])
      expect(w.toasts.at(-1)).toBe(`文件不存在：${REPORT}`)
    })
  })
}

// ---------- paths with Chinese characters and spaces, end to end ----------

test('a root with spaces and Chinese characters reaches open as one argument', async ($, on) => {
  const root = '/home/me/Desktop/project/记账 小程序'
  const b = fixture()
  const w = world(on, null, { existing: [`${root}/ai/scratch/cars/施工报告.md`], root })
  w.files.set(`${root}/ai/board.json`, { text: serializeBoard(b), mtime: 5 })
  mock.clock(on)
  await $.session.start({ ...START, cwd: root })
  const ui = await pane($, 'terminal')
  await ui.press({ key: 'link:i-rev:0:open' })
  await ui.press({ key: 'link:i-rev:0:vscode' })
  expect(w.runs).toEqual([
    ['open', `${root}/ai/scratch/cars/施工报告.md`],
    ['open', '-a', 'Visual Studio Code', `${root}/ai/scratch/cars/施工报告.md`],
  ])
})

// ---------- above the prompt ----------

for (const surface of SURFACES) {
  describe(`above the prompt (${surface})`, () => {
    test('landscape with the pane on screen draws nothing of its own', async ($, on) => {
      world(on, fixture(), { placed: true })
      mock.clock(on)
      await $.session.start(START)
      const band = await mountBand($, surface, LANDSCAPE)
      expect(await band.find({ type: 'Text', text: 'ENGINE_DEFAULT' })).toBeDefined()
      expect(await band.find({ key: 'goal:g-car' })).toBeUndefined()
    })

    test('landscape without the pane on screen shows the one-line entry', async ($, on) => {
      world(on, fixture(), { placed: false })
      mock.clock(on)
      await $.session.start(START)
      const band = await mountBand($, surface, LANDSCAPE)
      const line = await band.find({ type: 'Text', text: /^看板/ })
      expect(line?.text).toBe('看板 · 在跑 2 · 待验收 1 · 待确认 1 · /board 打开')
      expect(await band.find({ key: 'goal:g-car' })).toBeUndefined()
    })

    test('the entry follows the board: nothing in motion, stale mark', async ($, on) => {
      world(on, emptyBoard('空'), { placed: false })
      mock.clock(on)
      await $.session.start(START)
      const band = await mountBand($, surface, LANDSCAPE)
      expect((await band.find({ type: 'Text', text: /^看板/ }))?.text).toBe('看板 · 暂无进行中事项 · /board 打开')
      await makeStale($)
      expect((await band.find({ type: 'Text', text: /^看板/ }))?.text).toBe('看板 ⚠ · 暂无进行中事项 · /board 打开')
    })

    test('portrait: while the pane is still up the band draws nothing; the pane closes itself, then the band draws the narrow view', async ($, on) => {
      const w = world(on, fixture(), { placed: true })
      const clock = mock.clock(on)
      await $.session.start(START)
      const stillUp = await mountBand($, surface, PORTRAIT)
      expect(await stillUp.find({ key: 'goal:g-car' })).toBeUndefined()
      // the pane, if the engine still draws it, hands over and is closed outside the drawing
      const ui = await pane($, surface, PORTRAIT)
      expect(await ui.find({ type: 'Text', text: /输入框上方/ })).toBeDefined()
      expect(w.closes).toEqual([])
      await clock.advance(10)
      expect(w.closes).toEqual(['board'])
      w.panes = placedPane(false)
      const band = await mountBand($, surface, PORTRAIT)
      expect(await band.find({ key: 'goal:g-car' })).toBeDefined()
      // only the focus goal is open in the narrow view
      expect(await band.find({ key: 'item:i-p1' })).toBeDefined()
      expect(await band.find({ key: 'item:i-run' })).toBeUndefined()
      expect(await band.find({ key: 'approve:i-rev' })).toBeUndefined()
    })

    test('a button works from the band too', async ($, on) => {
      const w = world(on, fixture(), { placed: false })
      mock.clock(on)
      await $.session.start(START)
      const band = await mountBand($, surface, PORTRAIT)
      await band.press({ key: 'yes:p-1' })
      expect(boardOf(w).goals.some(g => g.title === '路灯')).toBe(true)
      await band.press({ key: 'focus:g-car' })
      expect(boardOf(w).focus.goalId).toBe('g-car')
    })

    test('a survey on screen gets the place', async ($, on) => {
      world(on, fixture(), { placed: false })
      mock.clock(on)
      await $.session.start(START)
      const band = await mountBand($, surface, PORTRAIT, { ...BAND_PROPS, hasSurvey: true })
      expect(await band.find({ type: 'Text', text: 'ENGINE_DEFAULT' })).toBeDefined()
      expect(await band.find({ key: 'goal:g-car' })).toBeUndefined()
    })

    test('a project without a board draws nothing', async ($, on) => {
      world(on, null, { placed: false })
      mock.clock(on)
      await $.session.start(START)
      const band = await mountBand($, surface, LANDSCAPE)
      expect(await band.find({ type: 'Text', text: 'ENGINE_DEFAULT' })).toBeDefined()
    })
  })
}

// ---------- a docked pane narrows the conversation ----------

// A 160x50 terminal with the pane docked: the conversation has 88 columns, the pane body 71, the frame 1.
const DOCKED = { columns: 88, rows: 50, isFullscreen: true }
const DOCK_PROPS = { ...PANE_PROPS, bodyColumns: 71 }

describe('several surfaces draw one session', () => {
  test('a terminal pane and a desktop pane drawn alternately never make each other redraw without end', async ($, on) => {
    const w = world(on, fixture(), { placed: true })
    let invalidations = 0
    on('ui.invalidate', (_$, e, next) => {
      invalidations++
      return next(e)
    })
    const clock = mock.clock(on)
    await $.session.start(START)
    await pane2($, 'terminal', DOCKED, DOCK_PROPS)
    await pane2($, 'desktop', { columns: 90, rows: 40, isFullscreen: true }, { ...PANE_PROPS, bodyColumns: 0 })
    for (let n = 0; n < 4; n++) await clock.advance(10)
    expect(invalidations).toBeLessThan(10)
    expect(w.closes).toEqual([])
  })

  test('the last drawing above the prompt may come from another surface; /board still folds what the terminal shows', async ($, on) => {
    const w = world(on, fixture(), { placed: false })
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    await mountBand($, 'terminal', PORTRAIT)
    await mountBand($, 'desktop', LANDSCAPE)
    const r = await ($ as any).command.run({ command: 'board', args: '' })
    expect(r.text).toBe('已收起看板')
    expect(w.closes).toEqual([])
  })
})

describe('docked pane: the viewport is the conversation, the screen shape is the whole terminal', () => {
  for (const surface of ['terminal'] as const) {
    test('a landscape terminal keeps the pane drawing the board; it never closes itself', async ($, on) => {
      const w = world(on, fixture(), { placed: true })
      const clock = mock.clock(on)
      await $.session.start(START)
      const ui = await pane2($, surface, DOCKED, DOCK_PROPS)
      expect(await ui.find({ key: 'goal:g-car' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /输入框上方/ })).toBeUndefined()
      await clock.advance(10)
      expect(w.closes).toEqual([])
    })

    test('the band above the prompt draws nothing while the docked pane is on a landscape terminal', async ($, on) => {
      const w = world(on, fixture(), { placed: true })
      const clock = mock.clock(on)
      await $.session.start(START)
      await pane2($, surface, DOCKED, DOCK_PROPS)
      const band = await mountBand($, surface, DOCKED)
      expect(await band.find({ type: 'Text', text: 'ENGINE_DEFAULT' })).toBeDefined()
      expect(await band.find({ key: 'goal:g-car' })).toBeUndefined()
      await clock.advance(10)
      expect(w.closes).toEqual([])
    })

    test('drawing the pane and the band again and again never closes or opens anything', async ($, on) => {
      const w = world(on, fixture(), { placed: true })
      const clock = mock.clock(on)
      await $.session.start(START)
      await clock.advance(10)
      w.opens.length = 0
      for (let n = 0; n < 5; n++) {
        const ui = await pane2($, surface, DOCKED, DOCK_PROPS)
        const band = await mountBand($, surface, DOCKED)
        expect(await ui.find({ key: 'goal:g-car' })).toBeDefined()
        expect(await band.find({ key: 'goal:g-car' })).toBeUndefined()
        await clock.advance(10)
        await ui.unmount()
        await band.unmount()
      }
      expect(w.closes).toEqual([])
      expect(w.opens).toEqual([])
    })

    test('a portrait terminal (docked 70+1 beside 51 columns: 122x80) closes the pane and the band takes over', async ($, on) => {
      const w = world(on, fixture(), { placed: true })
      const clock = mock.clock(on)
      await $.session.start(START)
      const tall = { columns: 50, rows: 80, isFullscreen: true }
      const ui = await pane2($, surface, tall, { ...PANE_PROPS, bodyColumns: 71 })
      expect(await ui.find({ type: 'Text', text: /输入框上方/ })).toBeDefined()
      await clock.advance(10)
      expect(w.closes).toEqual(['board'])
      w.panes = placedPane(false)
      const band = await mountBand($, surface, { columns: 122, rows: 80, isFullscreen: true })
      expect(await band.find({ key: 'goal:g-car' })).toBeDefined()
    })

    test('after the pane closed for a portrait terminal, a landscape one brings it back, once', async ($, on) => {
      const w = world(on, fixture(), { placed: true })
      const clock = mock.clock(on)
      await $.session.start(START)
      await clock.advance(10)
      w.opens.length = 0
      const tallPane = await pane2($, surface, { columns: 50, rows: 80, isFullscreen: true }, DOCK_PROPS)
      await clock.advance(10)
      expect(w.closes).toEqual(['board'])
      await tallPane.unmount()
      w.panes = []
      await mountBand($, surface, { columns: 122, rows: 80, isFullscreen: true })
      await clock.advance(10)
      expect(w.opens).toEqual([])
      await mountBand($, surface, { columns: 160, rows: 50, isFullscreen: true })
      await mountBand($, surface, { columns: 160, rows: 50, isFullscreen: true })
      await clock.advance(10)
      expect(w.opens).toEqual(['board'])
    })

    test('an inline pane on a landscape terminal (not fullscreen) draws the board by itself, the band adds no second copy', async ($, on) => {
      const w = world(on, fixture(), { placed: true })
      const clock = mock.clock(on)
      await $.session.start(START)
      const vp = { columns: 100, rows: 40, isFullscreen: false }
      const ui = await pane2($, surface, vp, { ...PANE_PROPS, placement: 'inline' as const, bodyColumns: 96 })
      expect(await ui.find({ key: 'goal:g-car' })).toBeDefined()
      const band = await mountBand($, surface, vp)
      expect(await band.find({ key: 'goal:g-car' })).toBeUndefined()
      expect(await band.find({ type: 'Text', text: 'ENGINE_DEFAULT' })).toBeDefined()
      await clock.advance(10)
      expect(w.closes).toEqual([])
    })

    test('an inline pane on a portrait terminal (60x80) closes itself and the narrow view takes over', async ($, on) => {
      const w = world(on, fixture(), { placed: true })
      const clock = mock.clock(on)
      await $.session.start(START)
      const vp = { columns: 60, rows: 80, isFullscreen: false }
      const ui = await pane2($, surface, vp, { ...PANE_PROPS, placement: 'inline' as const, bodyColumns: 56 })
      expect(await ui.find({ type: 'Text', text: /输入框上方/ })).toBeDefined()
      await clock.advance(10)
      expect(w.closes).toEqual(['board'])
      w.panes = placedPane(false)
      const band = await mountBand($, surface, vp)
      expect(await band.find({ key: 'goal:g-car' })).toBeDefined()
      expect(await band.find({ key: 'item:i-run' })).toBeUndefined()
    })
  }
})

const pane2 = ($: any, surface: (typeof SURFACES)[number], viewport: object, props: object): Promise<Ui> => mountPane($, surface, viewport as typeof LANDSCAPE, props)()

// ---------- links under a goal, the "待你处理" block, ~ paths ----------

describe('goal links, the to-do block and ~ paths', () => {
  const DESIGN = '/home/me/Desktop/设计/方案 一.md'
  const gl = (n: number): Link[] => Array.from({ length: n }, (_, i) => link({ kind: '设计方案', target: `ai/docs/方案${i}.md` }))

  test('a ~ path is expanded to the home directory for the check, the buttons and the copy', async ($, on) => {
    const b = fixture()
    b.goals[1]!.items[2]!.links = [link({ target: '~/Desktop/设计/方案 一.md', forReview: true })]
    const w = world(on, b, { existing: [DESIGN] })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await texts(ui, /文件不存在/)).toHaveLength(0)
    await ui.press({ key: 'link:i-rev:0:open' })
    expect(w.runs).toEqual([['open', DESIGN]])
    await ui.press({ key: 'link:i-rev:0:vscode' })
    expect(w.runs.at(-1)).toEqual(['open', '-a', 'Visual Studio Code', DESIGN])
    await ui.press({ key: 'link:i-rev:0:copy' })
    expect(w.copies.at(-1)?.text).toBe(DESIGN)
  })

  test('a ~ path whose file is missing says so with the expanded path', async ($, on) => {
    const b = fixture()
    b.goals[1]!.items[2]!.links = [link({ target: '~/Desktop/设计/方案 一.md', forReview: true })]
    const w = world(on, b, { existing: [] })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await texts(ui, /文件不存在/)).toHaveLength(2)
    await ui.press({ key: 'link:i-rev:0:open' })
    expect(w.toasts.at(-1)).toBe(`文件不存在：${DESIGN}`)
  })

  test('a goal with up to 3 links lists them under its title, with the same buttons as an item', async ($, on) => {
    const b = fixture()
    b.goals[1]!.links = gl(1)
    const w = world(on, b, { existing: [`${PROJ}/ai/docs/方案0.md`] })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await texts(ui, /^资料$/)).toHaveLength(1)
    expect(await keys(ui, 'link:g-car:0:')).toEqual(['link:g-car:0:open', 'link:g-car:0:vscode', 'link:g-car:0:copy'])
    await ui.press({ key: 'link:g-car:0:open' })
    expect(w.runs).toEqual([['open', `${PROJ}/ai/docs/方案0.md`]])
  })

  test('more than 3 links fold into one line; a press lists them', async ($, on) => {
    const b = fixture()
    b.goals[1]!.links = gl(4)
    world(on, b, { existing: [] })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await texts(ui, /资料 4 条/)).toHaveLength(1)
    expect(await keys(ui, 'link:g-car:')).toEqual([])
    await ui.press({ key: 'links:g-car' })
    expect(await keys(ui, 'link:g-car:')).toHaveLength(4 * 3)
    // 4 goal links, plus the review report in the to-do block and under its item
    expect(await texts(ui, /文件不存在/)).toHaveLength(4 + 2)
  })

  test('a collapsed goal shows no links; a goal without links shows no 资料 line', async ($, on) => {
    const b = fixture()
    b.goals[0]!.links = gl(1)
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await keys(ui, 'link:g-idle:')).toEqual([])
    expect(await texts(ui, /^资料$/)).toHaveLength(0)
  })

  test('待你处理 lists every review item with its approve button and its review entries, in the pane and in the narrow view', async ($, on) => {
    const w = world(on, fixture())
    mock.clock(on)
    await $.session.start(START)
    for (const show of [() => pane($, 'terminal'), () => ((w.panes = placedPane(false)), mountBand($, 'terminal', PORTRAIT))]) {
      const ui = await show()
      expect(await texts(ui, /^待你处理$/)).toHaveLength(1)
      expect(await keys(ui, 'todo-approve:')).toEqual(['todo-approve:i-rev'])
      // only the entries marked for review, not the command
      expect(await keys(ui, 'todo-link:i-rev:')).toEqual(['todo-link:i-rev:0:open', 'todo-link:i-rev:0:vscode', 'todo-link:i-rev:0:copy', 'todo-link:i-rev:1:open', 'todo-link:i-rev:1:copy'])
      await ui.unmount()
    }
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'todo-approve:i-rev' })
    expect(boardOf(w).goals.flatMap(g => g.items).find(i => i.id === 'i-rev')?.status).toBe('done')
    expect(boardOf(w).goals.flatMap(g => g.items).find(i => i.id === 'i-rev')?.doneBy).toBe('user')
  })

  test('待你处理 sits above the cards and the goals', async ($, on) => {
    const b = fixture()
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    const ks = ((await ui.findAll({ type: 'Button' })) as Array<{ key: string }>).map(x => x.key)
    const at = (k: string): number => ks.indexOf(k)
    expect(at('todo-approve:i-rev')).toBeLessThan(at('yes:p-1'))
    expect(at('yes:p-1')).toBeLessThan(at('goal:g-ped'))
  })

  test('without a review item there is no 待你处理 block', async ($, on) => {
    const c = fixture()
    c.goals[1]!.items.find(i => i.id === 'i-rev')!.status = 'done'
    world(on, c)
    mock.clock(on)
    await $.session.start(START)
    const ui2 = await pane($, 'terminal')
    expect(await texts(ui2, /^待你处理$/)).toHaveLength(0)
  })

  test('a review item with no review entry shows why', async ($, on) => {
    const b = fixture()
    const rev = b.goals[1]!.items.find(i => i.id === 'i-rev')!
    rev.links = []
    rev.noReviewTargetReason = '只是调了参数，没有可看的东西'
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect((await texts(ui, /无验收入口/)).length).toBeGreaterThan(0)
  })
})

// ---------- the layout setting ----------

describe('layout setting', () => {
  test('bottom draws the board above the prompt on a wide screen and never opens the pane', { options: { layout: 'bottom' } }, async ($, on) => {
    const w = world(on, fixture(), { placed: true })
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    expect(w.opens).toEqual([])
    const band = await mountBand($, 'terminal', LANDSCAPE)
    expect(await band.find({ key: 'goal:g-car' })).toBeDefined()
  })

  test('right keeps the pane on a portrait screen; when it is not on screen the entry line appears', { options: { layout: 'right' } }, async ($, on) => {
    const w = world(on, fixture(), { placed: true })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal', PORTRAIT)
    expect(await ui.find({ key: 'goal:g-car' })).toBeDefined()
    await clock.advance(10)
    expect(w.closes).toEqual([])
    const band = await mountBand($, 'terminal', PORTRAIT)
    expect(await band.find({ type: 'Text', text: 'ENGINE_DEFAULT' })).toBeDefined()
    w.panes = placedPane(false)
    const band2 = await mountBand($, 'terminal', PORTRAIT)
    expect((await band2.find({ type: 'Text', text: /^看板/ }))?.text).toContain('/board 打开')
  })
})

// ---------- opening the pane ----------

describe('opening the pane', () => {
  test('session.start opens the pane after the drawing, only when there is a board', async ($, on) => {
    const w = world(on, fixture())
    const clock = mock.clock(on)
    await $.session.start(START)
    expect(w.opens).toEqual([])
    await clock.advance(10)
    expect(w.opens).toEqual(['board'])
  })

  test('no board, no pane', async ($, on) => {
    const w = world(on, null)
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    expect(w.opens).toEqual([])
  })

  test('back to a wide screen after a portrait stretch, the pane opens again', async ($, on) => {
    const w = world(on, fixture(), { placed: true })
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    w.opens.length = 0
    // a tall screen: the engine draws the pane once, it closes itself, the engine drops the drawing
    const tallPane = await pane($, 'terminal', PORTRAIT)
    await clock.advance(10)
    expect(w.closes).toEqual(['board'])
    await tallPane.unmount()
    w.panes = []
    const tallBand = await mountBand($, 'terminal', PORTRAIT)
    await clock.advance(10)
    expect(w.opens).toEqual([])
    // the screen is wide again (same screen, new width): the band asks for the pane back, once
    await tallBand.unmount()
    await mountBand($, 'terminal', LANDSCAPE)
    await clock.advance(10)
    expect(w.opens).toEqual(['board'])
  })

  test('a pane the user closed by hand is not reopened', async ($, on) => {
    const w = world(on, fixture(), { placed: false })
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(10)
    w.opens.length = 0
    w.panes = []
    await mountBand($, 'terminal', LANDSCAPE)
    await mountBand($, 'terminal', LANDSCAPE)
    await clock.advance(10)
    expect(w.opens).toEqual([])
  })
})

// ---------- narrow, short and huge ----------

describe('sizes', () => {
  const sizes = [
    { columns: 80, rows: 24 },
    { columns: 60, rows: 20 },
    { columns: 60, rows: 80 },
  ]
  for (const surface of SURFACES) {
    for (const size of sizes) {
      test(`${size.columns}x${size.rows} draws without throwing (${surface})`, async ($, on) => {
        world(on, fixture(), { placed: false })
        mock.clock(on)
        await $.session.start(START)
        const vp = { ...size, isFullscreen: true }
        const band = await mountBand($, surface, vp)
        expect(await band.drawn()).toBeDefined()
        const ui = await pane($, surface, vp)
        expect(await ui.drawn()).toBeDefined()
        await ui.unmount()
        const inline = await $.ui.mount({ plugin: 'project-board', surface, component: 'Pane', requestId: 'board', props: { ...PANE_PROPS, placement: 'inline' as const, bodyColumns: size.columns - 4 }, viewport: { ...vp, isFullscreen: false } })
        expect(await inline.drawn()).toBeDefined()
      })
    }
  }

  test('a corrupt file shows its error and nothing else', async ($, on) => {
    const w = world(on, null, { placed: true })
    w.files.set(BOARD, { text: '{ "schema": 1, ', mtime: 3 })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect((await texts(ui, /无法解析/)).length).toBeGreaterThan(0)
    w.panes = placedPane(false)
    const band = await mountBand($, 'terminal', LANDSCAPE)
    expect((await band.find({ type: 'Text', text: /^看板/ }))?.text).toBe('看板 · 文件无法读取 · /board 查看')
  })

  test('an archive over 2 MiB is flagged in the title row', async ($, on) => {
    const b = fixture()
    b.archive.decisions.push({ id: 'd-big', date: '2026-01-01', text: '旧'.repeat(750_000), kind: 'user', goalId: '', status: 'active' })
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await texts(ui, /^归档已很大$/)).toHaveLength(1)
  })

  test('a very large board is cut to a drawable size', async ($, on) => {
    const b = emptyBoard('大')
    const long = '很长的备注。'.repeat(400)
    for (let g = 0; g < 70; g++) {
      b.goals.push(goal(`g-${g}`, `目标 ${g} ${'题'.repeat(300)}`, Array.from({ length: 10 }, (_, i) => item(`i-${g}-${i}`, { title: `事项 ${g}-${i}`, status: 'running', note: long, acceptance: long }))))
    }
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.length).toBeLessThan(150_000)
    expect((await texts(ui, /另有 \d+ 项未显示/)).length).toBeGreaterThan(0)
    expect((await texts(ui, /另有 30 个目标未显示/)).length).toBe(1)
    const band = await mountBand($, 'desktop', PORTRAIT)
    expect(JSON.stringify(await band.drawn()).length).toBeLessThan(150_000)
  })
})

// ---------- pure view helpers ----------

describe('view helpers', () => {
  test('the list puts the focus first and paused goals in their own fold, keeping the board order otherwise', () => {
    const p = partitionGoals(fixture())
    expect(p.active.map(g => g.id)).toEqual(['g-ped', 'g-car', 'g-idle'])
    expect(p.paused.map(g => g.id)).toEqual(['g-pause'])
  })
  test('entryText counts running, review and proposals; zero parts are left out', () => {
    const vm = { board: fixture(), stale: false } as never
    expect(entryText(vm)).toBe('看板 · 在跑 2 · 待验收 1 · 待确认 1 · /board 打开')
  })
  test('dependencies show only what is still unfinished, two names and a count', async ($, on) => {
    const b = fixture()
    b.goals[1]?.items.push(item('i-dep', { title: '全部停下', status: 'queued', dependsOn: ['i-run', 'i-old', 'i-rev', 'i-d1'] }))
    b.goals[1]?.items.push(item('i-dep2', { title: '收口', status: 'queued', dependsOn: ['i-d1', 'i-run'] }))
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await texts(ui, /^依赖：A 路第二段 \/ C 路车流 等 3 项$/)).toHaveLength(1)
    expect(await texts(ui, /^依赖：A 路第二段$/)).toHaveLength(1)
  })
  test('with several milestones in progress the latest leads and the rest are counted', async ($, on) => {
    const b = fixture()
    b.milestones.items.unshift({ id: 'm-0', title: '1 概念设计', status: '进行中', note: '', gates: [] })
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await texts(ui, /^· 阶段：4 资产制作（另有 1 个进行中）$/)).toHaveLength(1)
  })
  test('applyOps still treats the button\'s done as the user\'s (doneBy)', () => {
    const r = applyOps(fixture(), [{ op: 'item.update', id: 'i-rev', status: 'done' }], { now: NOW, session: 's', actor: 'user' })
    expect(r.ok && r.board.goals[1]?.items[2]?.doneBy).toBe('user')
  })
})

// ---------- text screenshots (printed so they can be pasted into the report) ----------

describe('screenshots', () => {
  test('print three screens', async ($, on) => {
    const w = world(on, fixture(), { placed: true })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    console.log(`\n=== SIDEBAR (160x50, terminal) ===\n${screen(await ui.drawn(), 56)}\n=== END ===`)
    const band = await mountBand($, 'terminal', PORTRAIT)
    console.log(`\n=== ABOVE PROMPT, PORTRAIT (60x80, terminal) ===\n${screen(await band.drawn(), 55)}\n=== END ===`)
    w.panes = placedPane(false)
    const entry = await mountBand($, 'terminal', LANDSCAPE)
    console.log(`\n=== ENTRY LINE (160x50, pane not on screen) ===\n${screen(await entry.drawn(), 150)}\n=== END ===`)
  })
})

// ---------- steps and the new layout ----------

const step = (id: string, title: string, over: Partial<Step> = {}): Step => ({ id, title, label: '', note: '', links: [], ...over })

/** One goal with five steps (T done, A under way, B waiting and running, C running, D not started) and a loose item. */
function steppedBoard(focus = true): Board {
  const b = emptyBoard('expense_app')
  b.goals.push(
    goal('g-can', 'G-export AI 落地：运行时到 MCP', [
      item('i-t1', { stepId: 's-T', status: 'done', doneBy: 'user' }),
      item('i-a1', { stepId: 's-A', status: 'done', doneBy: 'user' }),
      item('i-a2', { stepId: 's-A', status: 'todo', title: 'A2 既有问题' }),
      item('i-b1', { stepId: 's-B', status: 'review', title: 'B5 不常用按钮收进「详情」', links: [link({ forReview: true })] }),
      item('i-b2', { stepId: 's-B', status: 'running', title: 'B8b 出错提示与重试', owner: 'b8b', session: 'sess-1' }),
      item('i-b3', { stepId: 's-B', status: 'done', doneBy: 'user' }),
      item('i-c1', { stepId: 's-C', status: 'running', title: 'C1 会话列表', session: 'sess-1' }),
      item('i-d1', { stepId: 's-D', status: 'todo' }),
      item('i-x', { stepId: '', status: 'todo', title: '临时杂事' }),
    ], {
      steps: [step('s-T', 'T 测试版 demo.app 独立打包'), step('s-A', 'A 运行时：在应用里跑起来'), step('s-B', 'B 填 Key 就能用'), step('s-C', 'C 会话区功能（三家）'), step('s-D', 'D MCP 与 Skill')],
    }),
    goal('g-flat', '知识库整理', [item('k1')]),
  )
  if (focus) b.focus = { text: 'G-export 收尾', goalId: 'g-can', mandate: '主会话编排', updatedAt: NOW }
  return b
}

for (const surface of SURFACES) {
  describe(`step bar and step blocks (${surface})`, () => {
    test('the bar lists every step with its icon, short name and count, then 其他 for loose open items', async ($, on) => {
      world(on, steppedBoard())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await keys(ui, 'step:')).toEqual(['step:s-T', 'step:s-A', 'step:s-B', 'step:s-C', 'step:s-D', 'step:other:g-can'])
      const label = async (k: string): Promise<string | undefined> => (await ui.find({ key: k }))?.text
      expect(await label('step:s-T')).toBe('✓ T')
      expect(await label('step:s-A')).toBe('◐ A 1/2')
      expect(await label('step:s-B')).toBe('◆ B 1/3')
      expect(await label('step:s-D')).toBe('○ D')
      expect(await label('step:other:g-can')).toBe('○ 其他')
      // an open step shows a dot (its items turn below); a shut one with something running turns a spinner on the terminal
      expect(await label('step:s-C')).toBe('● C 0/1')
      expect(await ui.find({ type: 'Raster', key: 'sspin:s-C' })).toBeUndefined()
      await ui.press({ key: 'step:s-C' })
      if (surface === 'terminal') {
        expect(await label('step:s-C')).toBe(' C 0/1')
        expect(await ui.find({ type: 'Raster', key: 'sspin:s-C' })).toBeDefined()
      } else expect(await label('step:s-C')).toBe('● C 0/1')
    })

    test('a shut goal with something running turns a spinner by its title; an open one does not', async ($, on) => {
      world(on, steppedBoard())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await ui.find({ type: 'Raster', key: 'gspin:g-can' })).toBeUndefined()
      await ui.press({ key: 'goal:g-can' })
      if (surface === 'terminal') expect(await ui.find({ type: 'Raster', key: 'gspin:g-can' })).toBeDefined()
      else expect(await ui.find({ type: 'Text', text: '●' })).toBeDefined()
    })

    test('steps with review, running or doing items open by themselves; the others stay shut', async ($, on) => {
      world(on, steppedBoard())
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await keys(ui, 'sh:')).toEqual(['sh:s-B', 'sh:s-C'])
      expect((await ui.find({ key: 'sh:s-B' }))?.text).toBe('▾ B 填 Key 就能用 1/3')
      expect(await ui.find({ key: 'item:i-b1' })).toBeDefined()
      expect(await ui.find({ key: 'item:i-a2' })).toBeUndefined()
    })

    test('with nothing in motion the first step that still has work opens', async ($, on) => {
      const b = steppedBoard()
      for (const i of b.goals[0]!.items) if (i.status === 'review' || i.status === 'running') i.status = 'todo'
      world(on, b)
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await keys(ui, 'sh:')).toEqual(['sh:s-A'])
    })

    test('a press on a step opens it and its goal; a second press closes only the step', async ($, on) => {
      const w = world(on, steppedBoard(false), { placed: false })
      mock.clock(on)
      await $.session.start(START)
      const band = await mountBand($, surface, PORTRAIT)
      // no focus: the goal is shut in the narrow view, only the bar shows
      expect(await keys(band, 'sh:')).toEqual([])
      expect(await keys(band, 'step:')).toHaveLength(6)
      await band.press({ key: 'step:s-A' })
      expect(w.state.expanded).toEqual({ 's-A': true, 'g-can': true })
      expect(await keys(band, 'sh:')).toContain('sh:s-A')
      expect(await band.find({ key: 'item:i-a2' })).toBeDefined()
      await band.press({ key: 'step:s-A' })
      expect(w.state.expanded).toEqual({ 's-A': false, 'g-can': true })
      expect(await keys(band, 'sh:')).not.toContain('sh:s-A')
      // the step header closes its step too
      await band.press({ key: 'step:s-D' })
      await band.press({ key: 'sh:s-D' })
      expect((w.state.expanded as Record<string, boolean>)['s-D']).toBe(false)
    })

    test('loose open items sit under 其他, which opens like a step; their done fold has its own key', async ($, on) => {
      const b = steppedBoard()
      b.goals[0]!.items.push(item('i-xd', { stepId: '', status: 'done', doneBy: 'claude' }))
      world(on, b)
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await ui.find({ key: 'item:i-x' })).toBeUndefined()
      await ui.press({ key: 'step:other:g-can' })
      expect(await ui.find({ key: 'item:i-x' })).toBeDefined()
      expect((await ui.find({ key: 'done:g-can' }))?.text).toBe('▸ ✓ 已完成 1 项')
    })

    test('待你处理 names the goal and the step: 目标短名 › 步骤短名; an item outside any step names the goal only', async ($, on) => {
      const b = steppedBoard()
      b.goals[1]!.items.push(item('i-f', { title: '收尾', status: 'review' }))
      world(on, b)
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await texts(ui, /^· G-export › B$/)).toHaveLength(1)
      expect(await texts(ui, /^· 知识库整理$/)).toHaveLength(1)
    })

    test('step links are listed under the step header, with the same buttons as an item', async ($, on) => {
      const b = steppedBoard()
      b.goals[0]!.steps[2]!.links = [link({ kind: '设计', target: 'ai/scratch/cars/施工报告.md' })]
      world(on, b)
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, surface)
      expect(await keys(ui, 'link:s-B:')).toEqual(['link:s-B:0:open', 'link:s-B:0:vscode', 'link:s-B:0:copy'])
    })
  })
}

describe('a goal.merge proposal card', () => {
  test('names the goals, the new goal, and any paused goal that comes back', async ($, on) => {
    const b = steppedBoard()
    b.goals[1]!.status = 'paused'
    b.proposals.push({ id: 'p-m', action: 'goal.merge', payload: { title: 'G-export 整体', goalIds: ['g-can', 'g-flat'] }, reason: '同一件事的两个阶段', createdAt: NOW })
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    const line = await texts(ui, /合并为/)
    expect(line).toEqual(['把「G-export…」「知识库整理」2个目标合并为「G-export 整体」的步骤（含暂停的「知识库整理」，合并后一并恢复）'])
    expect(await ui.find({ key: 'yes:p-m' })).toBeDefined()
  })
})

describe('layout of the title area, the status block and the goal heads', () => {
  const rasterCols = async (ui: Ui, key: string): Promise<number | undefined> => ((await ui.find({ type: 'Raster', key })) as { props: { columns: number } } | undefined)?.props.columns

  test('landscape terminal: mascot, four chips, a 12-cell bar, the mandate line, no outer border', async ($, on) => {
    world(on, steppedBoard())
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await rasterCols(ui, 'mascot')).toBe(9)
    expect(await ui.find({ type: 'Raster', key: 'chip:review' })).toBeDefined()
    expect(await ui.find({ type: 'Raster', key: 'chip:done' })).toBeDefined()
    expect(await rasterCols(ui, 'bar:g-can')).toBe(12)
    expect(await texts(ui, /^授权：主会话编排/)).toHaveLength(1)
    expect(await texts(ui, /^看板$/)).toHaveLength(1)
    expect(JSON.stringify(await ui.drawn())).not.toContain('"borderColor":"claude"')
  })

  test('portrait terminal: the same parts, an 8-cell bar, no mandate line, a rounded frame around the board', async ($, on) => {
    world(on, steppedBoard(), { placed: false })
    mock.clock(on)
    await $.session.start(START)
    const band = await mountBand($, 'terminal', PORTRAIT)
    expect(await rasterCols(band, 'mascot')).toBe(9)
    expect(await rasterCols(band, 'bar:g-can')).toBe(8)
    expect(await texts(band, /^授权/)).toHaveLength(0)
    expect(JSON.stringify(await band.drawn())).toContain('"borderStyle":"round","borderColor":"claude"')
  })

  test('a surface without canvases gets text: no Raster anywhere, chips as inverse text, a bar of characters', async ($, on) => {
    const w = world(on, steppedBoard())
    mock.clock(on)
    await $.session.start(START)
    for (const show of [() => pane($, 'desktop'), () => ((w.panes = placedPane(false)), mountBand($, 'desktop', PORTRAIT))]) {
      const ui = await show()
      expect(await ui.findAll({ type: 'Raster' })).toEqual([])
      expect(JSON.stringify(await ui.drawn())).not.toContain('"Raster"')
      const chip = await texts(ui, /^ ◆ 1 $/)
      expect(chip).toHaveLength(1)
      expect((await ui.find({ type: 'Text', text: /^ ◆ 1 $/ }))?.props).toMatchObject({ inverse: true, color: 'success' })
      expect((await ui.find({ type: 'Text', text: /^ ✓ 3 $/ }))?.props.color).toBe('inactive')
      expect((await texts(ui, /^[▰▱ ]+$/)).length).toBeGreaterThan(0)
      await ui.unmount()
    }
  })

  test('the mascot setting off leaves out the canvas and nothing else', { options: { mascot: 'off' } }, async ($, on) => {
    world(on, steppedBoard())
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await ui.find({ type: 'Raster', key: 'mascot' })).toBeUndefined()
    expect(await ui.find({ type: 'Raster', key: 'chip:review' })).toBeDefined()
  })

  test('设为关注: always beside an open goal, revealed by hover on a shut one (terminal), always shown elsewhere', async ($, on) => {
    world(on, steppedBoard())
    mock.clock(on)
    await $.session.start(START)
    const termPane = await pane($, 'terminal')
    const term = JSON.stringify(await termPane.drawn())
    await termPane.unmount()
    // the shut goal's button sits in an absolute, hidden box that hover reveals; the focus goal has none
    expect(term).toContain('"position":"absolute"')
    expect(term).toContain('"hover":{"display":"flex"}')
    expect(term).toContain('"key":"gh:g-flat"')
    expect((term.match(/focus:/g) ?? []).length).toBeGreaterThan(0)
    const textPane = await pane($, 'desktop')
    const text = JSON.stringify(await textPane.drawn())
    await textPane.unmount()
    expect(text).not.toContain('"position":"absolute"')
    expect(text).toContain('focus:g-flat')
    // an open goal that is not the focus keeps the button in its head
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'goal:g-flat' })
    const open = JSON.stringify(await ui.drawn())
    expect(open).not.toContain('gh:g-flat')
    expect(open).toContain('focus:g-flat')
  })

  test('the focus goal, a paused goal and a finished goal have no 设为关注', async ($, on) => {
    const b = steppedBoard()
    b.goals.push(goal('g-pz', '暂停的', [item('p1')], { status: 'paused' }), goal('g-fin', '做完的', [item('f1', { status: 'done', doneBy: 'user' })]))
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'fold:paused' })
    await ui.press({ key: 'fold:done' })
    expect(await keys(ui, 'focus:')).toEqual(['focus:g-flat'])
  })

  test('paused and finished goals wait in two fold lines that open on a press, dimmed and without a step bar', async ($, on) => {
    const b = steppedBoard()
    b.goals.push(goal('g-pz', '暂停的', [item('p1', { stepId: 's-z' })], { status: 'paused', steps: [step('s-z', 'Z 步')] }), goal('g-fin', '做完的', [item('f1', { status: 'done', doneBy: 'user' })]))
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect((await ui.find({ key: 'fold:paused' }))?.text).toBe('▸ ⏸ 暂停 1 个目标 · 暂停的')
    expect((await ui.find({ key: 'fold:done' }))?.text).toBe('▸ ✓ 已完成 1 个目标 · 做完的')
    expect(await ui.find({ key: 'goal:g-pz' })).toBeUndefined()
    await ui.press({ key: 'fold:paused' })
    await ui.press({ key: 'fold:done' })
    expect((await ui.find({ key: 'fold:paused' }))?.text).toBe('▾ ⏸ 暂停 1 个目标')
    expect(await ui.find({ key: 'goal:g-pz' })).toBeDefined()
    expect(await ui.find({ key: 'goal:g-fin' })).toBeDefined()
    expect(await ui.find({ key: 'step:s-z' })).toBeUndefined()
  })
})

/** The u32 words of a Raster's base64 `cells`. */
function decodeCells(b64: string): number[] {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < b64.length; i += 4) {
    const q = [...b64.slice(i, i + 4)].map(ch => (ch === '=' ? 0 : A.indexOf(ch)))
    const n = (q[0]! << 18) | (q[1]! << 12) | (q[2]! << 6) | q[3]!
    const pad = (b64[i + 2] === '=' ? 2 : 0) + (b64[i + 3] === '=' ? 1 : 0)
    bytes.push((n >> 16) & 255, ...(pad >= 2 ? [] : [(n >> 8) & 255]), ...(pad >= 1 ? [] : [n & 255]))
  }
  const out: number[] = []
  for (let i = 0; i + 3 < bytes.length; i += 4) out.push((bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0)
  return out
}

describe('theme lookup for the canvas colours', () => {
  const titleBgOf = async (ui: Ui): Promise<string | undefined> => {
    const m = /"flexDirection":"row","backgroundColor":"(#[0-9a-f]{6})"/.exec(JSON.stringify(await ui.drawn()))
    return m?.[1]
  }
  const chipCell = async (ui: Ui, kind: string, n: number): Promise<[number, number, number]> => {
    const r = (await ui.find({ type: 'Raster', key: `chip:${kind}` })) as { props: { cells: string } }
    const w = decodeCells(r.props.cells)
    return [w[3 * n]!, w[3 * n + 1]!, w[3 * n + 2]!]
  }

  for (const theme of ['dark', 'light', 'dark-daltonized', 'light-daltonized']) {
    test(`${theme}: the title area and the chips take colours from the table`, async ($, on) => {
      world(on, steppedBoard(), { theme })
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, 'terminal')
      const p = paletteFor(theme)!
      expect(await titleBgOf(ui)).toBe(hex(titleBg(p)))
      // the chip's own cells and the title area sit on colours a Raster reproduces exactly
      expect((await chipCell(ui, 'review', 1))[2]).not.toBe(0x01000000)
      expect(titleBg(p)).toBe(titleBg(p) & 0xffffff)
    })
  }

  for (const theme of ['auto', 'dark-ansi', 'light-ansi', 'something-new', undefined]) {
    test(`${String(theme)}: no backgrounds on the canvas and none under the title area`, async ($, on) => {
      world(on, steppedBoard(), theme === undefined ? {} : { theme })
      mock.clock(on)
      await $.session.start(START)
      const ui = await pane($, 'terminal')
      expect(await titleBgOf(ui)).toBeUndefined()
      for (const n of [0, 1, 2]) expect((await chipCell(ui, 'review', n))[2]).toBe(0x01000000)
    })
  }

  test('a theme change is picked up and the board drawn again', async ($, on) => {
    const w = world(on, steppedBoard(), { theme: 'dark' })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await titleBgOf(ui)).toBe(hex(titleBg(paletteFor('dark'))))
    w.theme = 'light'
    await $.config.set({ key: 'theme', value: 'light' } as never)
    await ui.unmount()
    const again = await pane($, 'terminal')
    expect(await titleBgOf(again)).toBe(hex(titleBg(paletteFor('light'))))
  })
})

describe('pressing 验收通过 answers at once', () => {
  test('the stamp stands in for the button before the file is written; the row leaves the live list afterwards', async ($, on) => {
    const w = world(on, fixture())
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    let release = (): void => undefined
    w.gate = new Promise<void>(r => (release = r))
    const pressed = ui.press({ key: 'approve:i-rev' })
    await clock.settle()
    // the write is still held
    expect(boardOf(w).goals[1]!.items[2]!.status).toBe('review')
    expect(await ui.find({ key: 'approve:i-rev' })).toBeUndefined()
    expect(await ui.find({ key: 'todo-approve:i-rev' })).toBeUndefined()
    expect((await texts(ui, /▓▓▓▓/)).length).toBe(2)
    w.gate = null
    release()
    await pressed
    expect(boardOf(w).goals[1]!.items[2]!.status).toBe('done')
    // written, but the row stays where it was while the stamp finishes
    expect(await ui.find({ key: 'item:i-rev' })).toBeDefined()
    expect((await texts(ui, /▓▓▓▓|✓ 通过/)).length).toBeGreaterThan(0)
    await clock.advance(700)
    expect(await texts(ui, /▓▓▓▓|✓ 通过/)).toHaveLength(0)
    expect(await ui.find({ key: 'item:i-rev' })).toBeUndefined()
  })

  test('a refused write puts the button back and says why', async ($, on) => {
    const w = world(on, fixture())
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    w.writeFails = true
    await ui.press({ key: 'approve:i-rev' })
    await clock.advance(10)
    expect(w.toasts.join('\n')).toContain('没有执行')
    expect(await ui.find({ key: 'approve:i-rev' })).toBeDefined()
    expect(await texts(ui, /▓▓▓▓|✓ 通过/)).toHaveLength(0)
    expect(boardOf(w).goals[1]!.items[2]!.status).toBe('review')
  })

  test('pressing the todo-block button works the same way, and a second press while stamped does nothing', async ($, on) => {
    const w = world(on, fixture())
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    await Promise.allSettled([ui.press({ key: 'todo-approve:i-rev' }), ui.press({ key: 'todo-approve:i-rev' })])
    await clock.advance(700)
    expect(boardOf(w).rev).toBe(1)
    expect(boardOf(w).goals[1]!.items[2]).toMatchObject({ status: 'done', doneBy: 'user' })
  })
})

// ---------- motion through the engine ----------

/** A board where nothing runs, waits or is behind: nothing is allowed to move. */
const quietBoard = (): Board => boardWith(goal('g-q', '静的目标', [item('q1'), item('q2', { status: 'done', doneBy: 'user' })]))
const boardWith = (...goals: Goal[]): Board => ({ ...emptyBoard('静'), goals })
const keysOf = (w: World, requestId: string): string[] => [...new Set(w.blits.filter(b => b.requestId === requestId).map(b => b.key))].sort()

describe('the timer through the engine', () => {
  test('a board with something running repaints its canvases at ten frames a second', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await pane($, 'terminal')
    await clock.advance(1000)
    const keys = keysOf(w, 'board')
    expect(keys).toContain('mascot')
    // The status block is still: only the mascot and the spinners are repainted
    expect(keys.filter(k => k.startsWith('chip:'))).toEqual([])
    expect(keys.filter(k => k.startsWith('bar:'))).toEqual([])
    expect(keys).toContain('spin:i-run')
    expect(w.blits.filter(b => b.key === 'spin:i-run').length).toBeGreaterThanOrEqual(8)
    expect(w.blits.filter(b => b.key === 'spin:i-run').length).toBeLessThanOrEqual(11)
  })

  test('a board where nothing moves starts no timer and draws nothing more', async ($, on) => {
    const w = world(on, quietBoard(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await ui.find({ type: 'Raster', key: 'mascot' })).toBeDefined()
    await clock.advance(3000)
    expect(w.blits).toEqual([])
  })

  test('motion off in the settings: the canvases are drawn once and never repainted', { options: { motion: 'off' } }, async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await pane($, 'terminal')
    await clock.advance(2000)
    expect(w.blits).toEqual([])
  })

  test('the system\'s reduce-motion does the same', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark', reduceMotion: true })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    await clock.advance(2000)
    expect(w.blits).toEqual([])
    // the pose and colours are still there: a still frame of the right state
    expect(await ui.find({ type: 'Raster', key: 'chip:review' })).toBeDefined()
  })

  test('turning reduce-motion on mid-way stops the timer; turning it off starts it again', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await pane($, 'terminal')
    await clock.advance(500)
    const before = w.blits.length
    expect(before).toBeGreaterThan(0)
    w.state.rm = true
    await $.config.set({ key: 'reduceMotion', value: true } as never)
    await clock.advance(1000)
    const stopped = w.blits.length
    await clock.advance(1000)
    expect(w.blits.length).toBe(stopped)
    w.state.rm = false
    await $.config.set({ key: 'reduceMotion', value: false } as never)
    await (await pane($, 'terminal').catch(() => null))?.unmount()
    await clock.advance(1000)
    expect(w.blits.length).toBeGreaterThan(stopped)
  })

  test('a refused repaint stops the timer until the board is drawn again', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    await clock.advance(300)
    w.denyBlit = true
    await clock.advance(300)
    const n = w.blits.length
    await clock.advance(2000)
    expect(w.blits.length).toBe(n)
    w.denyBlit = false
    await ui.unmount()
    await pane($, 'terminal')
    await clock.advance(500)
    expect(w.blits.length).toBeGreaterThan(n)
  })

  test('the narrow view above the prompt repaints under its own request id', async ($, on) => {
    const w = world(on, fixture(), { placed: false, theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await mountBand($, 'terminal', PORTRAIT)
    await clock.advance(500)
    expect(keysOf(w, 'board')).toEqual([])
    expect(w.blits.length).toBeGreaterThan(0)
    expect(w.blits[0]!.requestId).not.toBe('board')
  })

  test('folding the board down to its one-line entry stops the repainting', async ($, on) => {
    const w = world(on, fixture(), { placed: false, theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const band = await mountBand($, 'terminal', PORTRAIT)
    await clock.advance(300)
    const n = w.blits.length
    expect(n).toBeGreaterThan(0)
    const r = await ($ as any).command.run({ command: 'board', args: '' })
    expect(r.text).toBe('已收起看板')
    // the engine draws the band again after the fold: it is the one-line entry now
    expect(await band.find({ key: 'open-board' })).toBeDefined()
    await clock.advance(2000)
    expect(w.blits.length).toBe(n)
  })

  test('the surfaces without canvases never repaint anything', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await pane($, 'desktop')
    await clock.advance(2000)
    expect(w.blits).toEqual([])
  })
})

describe('one-off effects through the engine', () => {
  const rowColours = async (ui: Ui): Promise<number> => (JSON.stringify(await ui.drawn()).match(/"backgroundColor":"#[0-9a-f]{6}"/g) ?? []).length

  test('a change from outside lights the changed row, which fades out over two seconds', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    const base = await rowColours(ui)
    const raw = boardOf(w)
    raw.goals[1]!.items.find(i => i.id === 'i-q')!.note = '新说明'
    raw.rev += 1
    w.files.set(BOARD, { text: serializeBoard(raw), mtime: 88888 })
    await clock.advance(3050)
    expect(await rowColours(ui)).toBeGreaterThan(base)
    await clock.advance(2300)
    expect(await rowColours(ui)).toBe(base)
  })

  test('the first load of a board, and a file that turns readable again, light nothing', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    const base = await rowColours(ui)
    w.files.set(BOARD, { text: '{ broken', mtime: 777 })
    await clock.advance(3100)
    w.files.set(BOARD, { text: serializeBoard(fixture()), mtime: 778 })
    await clock.advance(3100)
    expect(await rowColours(ui)).toBe(base)
  })

  test('the stamp goes ▓▓▓▓ then a light ✓ 通过 then a green one, and the row leaves after 0.7 s', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'approve:i-rev' })
    expect((await texts(ui, /▓▓▓▓/)).length).toBeGreaterThan(0)
    await clock.advance(200)
    const light = await ui.find({ type: 'Text', text: /✓ 通过/ })
    expect(light?.props.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
    await clock.advance(200)
    const green = await ui.find({ type: 'Text', text: /✓ 通过/ })
    expect(green?.props.backgroundColor).toBe('#4eba65')
    await clock.advance(400)
    expect(await texts(ui, /✓ 通过/)).toHaveLength(0)
    expect(boardOf(w).goals[1]!.items[2]!.status).toBe('done')
  })

  test('finishing the last open item of a step throws confetti over its goal for 1.5 s, and the mascot cheers for 2.6 s', async ($, on) => {
    const b = boardWith(
      goal('g-x', 'X 目标', [item('x1', { stepId: 's-1', status: 'done', doneBy: 'user' }), item('x2', { stepId: 's-1', status: 'review' }), item('x3', { stepId: 's-2' })]),
    )
    b.goals[0]!.steps = [step('s-1', 'S1 第一步'), step('s-2', 'S2 第二步')]
    const w = world(on, b, { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    expect(await ui.find({ type: 'Raster', key: 'confetti:g-x' })).toBeUndefined()
    const mascot0 = (await ui.find({ type: 'Raster', key: 'mascot' })) as { props: { cells: string } }
    await ui.press({ key: 'approve:x2' })
    await clock.advance(50)
    expect(await ui.find({ type: 'Raster', key: 'confetti:g-x' })).toBeDefined()
    expect(((await ui.find({ type: 'Raster', key: 'mascot' })) as { props: { cells: string } }).props.cells).not.toBe(mascot0.props.cells)
    await clock.advance(1600)
    expect(await ui.find({ type: 'Raster', key: 'confetti:g-x' })).toBeUndefined()
    void w
  })

  test('with motion off none of it is drawn: no ripple colours, no confetti, the final stamp at once', { options: { motion: 'off' } }, async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    const base = await rowColours(ui)
    const raw = boardOf(w)
    raw.goals[1]!.items.find(i => i.id === 'i-q')!.note = '新说明'
    raw.rev += 1
    w.files.set(BOARD, { text: serializeBoard(raw), mtime: 88888 })
    await clock.advance(3050)
    expect(await rowColours(ui)).toBe(base)
    await ui.press({ key: 'approve:i-rev' })
    expect((await texts(ui, /✓ 通过/)).length).toBeGreaterThan(0)
    expect(await texts(ui, /▓▓▓▓/)).toHaveLength(0)
  })
})


describe('the calm pace through the engine', () => {
  test('a session nobody touched drops to two frames a second three minutes after it started', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await pane($, 'terminal')
    await clock.advance(1000)
    let from = w.blits.length
    await clock.advance(2000)
    expect(w.blits.slice(from).filter(b => b.key === 'spin:i-run').length).toBeGreaterThanOrEqual(15)
    await clock.advance(200_000)
    from = w.blits.length
    await clock.advance(2000)
    const calm = w.blits.slice(from).filter(b => b.key === 'spin:i-run').length
    expect(calm).toBeGreaterThanOrEqual(3)
    expect(calm).toBeLessThanOrEqual(5)
  })

  test('a session started again (hot reload) counts its three minutes from the new start', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(200_000)
    await $.session.start(START)
    await pane($, 'terminal')
    await clock.advance(1000)
    const from = w.blits.length
    await clock.advance(2000)
    expect(w.blits.slice(from).filter(b => b.key === 'spin:i-run').length).toBeGreaterThanOrEqual(15)
  })
})

describe('the confetti of a finished goal', () => {
  const lastItemBoard = (): Board =>
    boardWith(
      goal('g-last', '最后一项的目标', [item('L1', { status: 'done', doneBy: 'user' }), item('L2', { status: 'review', links: [link({ forReview: true })] })]),
      goal('g-other', '别的目标', [item('o1', { status: 'running', session: 'sess-1' })]),
    )

  test('the goal stays in the list until the confetti is over, then moves into the finished fold', async ($, on) => {
    world(on, lastItemBoard(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(1000)
    const ui = await pane($, 'terminal')
    expect(await ui.find({ key: 'goal:g-last' })).toBeDefined()
    await ui.press({ key: 'approve:L2' })
    for (const at of [50, 350, 750]) {
      await clock.advance(at === 50 ? 50 : 300 + (at === 750 ? 100 : 0))
      expect(await ui.find({ type: 'Raster', key: 'confetti:g-last' })).toBeDefined()
      expect(await ui.find({ key: 'goal:g-last' })).toBeDefined()
      expect(await ui.find({ key: 'fold:done' })).toBeUndefined()
    }
    await clock.advance(1000)
    expect(await ui.find({ type: 'Raster', key: 'confetti:g-last' })).toBeUndefined()
    expect(await ui.find({ key: 'goal:g-last' })).toBeUndefined()
    expect((await ui.find({ key: 'fold:done' }))?.text).toContain('已完成 1 个目标')
  })

  test('with motion off there is no confetti to wait for: the goal goes into the fold at once', { options: { motion: 'off' } }, async ($, on) => {
    world(on, lastItemBoard(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await clock.advance(1000)
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'approve:L2' })
    await clock.advance(50)
    expect(await ui.find({ key: 'goal:g-last' })).toBeUndefined()
    expect(await ui.find({ key: 'fold:done' })).toBeDefined()
  })
})

describe('what a board change costs the drawing', () => {
  const touchNote = (w: World, id: string, note: string): void => {
    const raw = boardOf(w)
    raw.goals.flatMap(g => g.items).find(i => i.id === id)!.note = note
    raw.rev += 1
    w.files.set(BOARD, { text: serializeBoard(raw), mtime: 90000 + raw.rev })
  }

  test('a change from outside draws the board once, not twice', async ($, on) => {
    const w = world(on, quietBoard(), { theme: 'dark' })
    let invalidations = 0
    on('ui.invalidate', (_$, e, next) => {
      invalidations++
      return next(e)
    })
    const clock = mock.clock(on)
    await $.session.start(START)
    await pane($, 'terminal')
    await clock.advance(10)
    touchNote(w, 'q1', '新说明')
    await clock.advance(2950)
    const before = invalidations
    await clock.advance(60)
    expect(invalidations - before).toBe(1)
  })

  test('the files a board links to are checked before the board is asked to be drawn again, not during the drawing', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const log = w.log
    on('ui.invalidate', (_$, e, next) => {
      log.push('invalidate')
      return next(e)
    })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    await clock.advance(10)
    touchNote(w, 'i-q', '新说明')
    log.length = 0
    await clock.advance(3050)
    expect(log).toContain('exists')
    expect(log.indexOf('exists')).toBeLessThan(log.indexOf('invalidate'))
    // and what the check found is on screen: a missing file is marked
    w.files.delete(REPORT)
    touchNote(w, 'i-q', '再改一次')
    await clock.advance(3050)
    expect((await texts(ui, /文件不存在/)).length).toBeGreaterThan(0)
  })
})

describe('the step bar spinner', () => {
  const cellsOf = async (ui: Ui, key: string): Promise<string> => ((await ui.find({ type: 'Raster', key })) as { props: { cells: string } }).props.cells

  test('a step whose running items were reported by another session turns in the dimmed, slow look', async ($, on) => {
    const b = boardWith(
      goal('g-a', '本会话', [item('a1', { stepId: 's-a', status: 'running', session: 'sess-1' })], { steps: [step('s-a', 'A 第一步')] }),
      goal('g-b', '别的会话', [item('b1', { stepId: 's-b', status: 'running', session: 'sess-old' })], { steps: [step('s-b', 'A 第一步')] }),
    )
    world(on, b, { theme: 'dark' })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'step:s-a' })
    await ui.press({ key: 'step:s-b' })
    expect(await cellsOf(ui, 'sspin:s-a')).not.toBe(await cellsOf(ui, 'sspin:s-b'))
  })

  test('an open step repaints nothing in the bar: its items turn below; shut, the bar turns', async ($, on) => {
    const w = world(on, steppedBoard(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    await clock.advance(1000)
    expect(w.blits.filter(b => b.key === 'spin:i-c1').length).toBeGreaterThanOrEqual(8)
    expect(w.blits.filter(b => b.key === 'sspin:s-C')).toEqual([])
    await ui.press({ key: 'step:s-C' })
    w.blits.length = 0
    await clock.advance(1000)
    expect(w.blits.filter(b => b.key === 'sspin:s-C').length).toBeGreaterThanOrEqual(8)
    expect(w.blits.filter(b => b.key === 'spin:i-c1')).toEqual([])
  })
})

describe('redrawing the board', () => {
  test('a redraw does not make the timer send the canvases again', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark' })
    const clock = mock.clock(on)
    await $.session.start(START)
    await pane($, 'terminal')
    await clock.advance(500)
    w.blits.length = 0
    await clock.advance(1000)
    const plain = w.blits.length
    w.blits.length = 0
    for (let n = 0; n < 10; n++) {
      await $.config.set({ key: 'theme', value: 'dark' } as never)
      await clock.advance(100)
    }
    expect(plain).toBeGreaterThan(0)
    expect(w.blits.length).toBeLessThanOrEqual(plain + 3)
  })
})

// ---------- one status colour ----------

describe('status colours: green when something is happening for you, grey otherwise', () => {
  const GREEN = '#4eba65'
  const propsOf = async (ui: Ui, re: RegExp): Promise<Array<Record<string, unknown>>> =>
    (await ui.findAll({ type: 'Text', text: re })).map((t: { props: Record<string, unknown> }) => t.props)
  const cellsOf = async (ui: Ui, key: string): Promise<{ b64: string; words: number[] }> => {
    const r = (await ui.find({ type: 'Raster', key })) as { props: { cells: string } }
    return { b64: r.props.cells, words: decodeCells(r.props.cells) }
  }
  const bgAt = (words: number[], i: number): number => words[3 * i + 2]!

  test('the four chips: waiting and running are green while they have a count, to-do and done are always the same grey, and none of them moves', async ($, on) => {
    const w = world(on, fixture(), { theme: 'dark-daltonized' })
    const clock = mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    const before = Object.fromEntries(await Promise.all(['review', 'running', 'todo', 'done'].map(async k => [k, await cellsOf(ui, `chip:${k}`)] as const)))
    expect(bgAt(before.review!.words, 1)).toBe(0x4eba65)
    expect(bgAt(before.running!.words, 1)).toBe(0x4eba65)
    const grey = bgAt(before.todo!.words, 1)
    expect(grey).not.toBe(0x4eba65)
    expect(bgAt(before.done!.words, 1)).toBe(grey)
    await clock.advance(5000)
    for (const k of ['review', 'running', 'todo', 'done']) expect((await cellsOf(ui, `chip:${k}`)).b64).toBe(before[k]!.b64)
    expect(w.blits.filter(b => b.key.startsWith('chip:'))).toEqual([])
  })

  test('with nothing waiting and nothing running every chip is grey', async ($, on) => {
    const b = fixture()
    for (const g of b.goals) for (const i of g.items) if (i.status === 'running' || i.status === 'review') i.status = 'todo'
    world(on, b, { theme: 'dark' })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'terminal')
    const greys = await Promise.all(['review', 'running', 'todo', 'done'].map(async k => bgAt((await cellsOf(ui, `chip:${k}`)).words, 1)))
    expect(new Set(greys).size).toBe(1)
    expect(greys[0]).not.toBe(0x4eba65)
  })

  test('the thin mark before a goal: green with something waiting or running, grey otherwise', async ($, on) => {
    world(on, fixture(), { theme: 'dark-daltonized' })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'desktop')
    // Order on screen: the focus goal, then the goal with something running or waiting, then the idle one
    expect((await propsOf(ui, /^▎$/)).map(p => p.color)).toEqual(['inactive', GREEN, 'inactive'])
  })

  test('step bar: waiting and running steps are green, finished, under way and not started are grey', async ($, on) => {
    world(on, steppedBoard(), { theme: 'dark' })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'desktop')
    const tok = async (re: RegExp): Promise<Record<string, unknown>> => (await propsOf(ui, re))[0]!
    expect((await tok(/^◆ B/)).color).toBe(GREEN)
    expect((await tok(/^● C/)).color).toBe(GREEN)
    for (const re of [/^✓ T/, /^◐ A/, /^○ D/]) {
      const p = await tok(re)
      expect(p.color).toBeUndefined()
      expect(p.dimColor).toBe(true)
    }
  })

  test('item icons: waiting and running are green (an old report dimmed), everything else grey; the to-do box heading and its mark are green', async ($, on) => {
    world(on, fixture(), { theme: 'light' })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'desktop')
    const GREEN_LIGHT = '#2c7a39'
    const all = await propsOf(ui, /^◆$/)
    expect(all.length).toBeGreaterThan(0)
    for (const p of all) expect(p.color).toBe(GREEN_LIGHT)
    const run = await propsOf(ui, /^●$/)
    expect(run.map(p => [p.color, p.dimColor === true])).toEqual(expect.arrayContaining([[GREEN_LIGHT, false], [GREEN_LIGHT, true]]))
    expect((await propsOf(ui, /^待你处理$/))[0]!.color).toBe(GREEN_LIGHT)
    expect((await propsOf(ui, /^待你确认$/))[0]!.color).toBe(GREEN_LIGHT)
    for (const p of await propsOf(ui, /^[○⏸◐]$/)) expect(p.dimColor).toBe(true)
  })

  test('without the theme\'s colours the text falls back to the theme key success; the pixel chips are not painted', async ($, on) => {
    world(on, fixture(), { theme: 'auto' })
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'desktop')
    expect((await propsOf(ui, /^◆$/))[0]!.color).toBe('success')
    const t = await pane($, 'terminal')
    expect(bgAt((await cellsOf(t, 'chip:review')).words, 1)).toBe(0x01000000)
  })

  test('battery cells next to a goal: one cell per item, the last cell stays empty until all are done', async ($, on) => {
    const b = boardWith(goal('g-b', 'B 目标', [item('b1', { status: 'done', doneBy: 'user' }), item('b2'), item('b3'), item('b4')]))
    world(on, b)
    mock.clock(on)
    await $.session.start(START)
    const ui = await pane($, 'desktop')
    expect(await texts(ui, /^[▰▱ ]+$/)).toEqual(['▰▱▱▱        '])
    expect(await texts(ui, /^1\/4$/)).toHaveLength(1)
  })
})
