import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Host, SyncState } from './host'
import { runCommand } from './commands'
import { BoardStore } from './store'
import { isUserSubmission, Sync } from './sync'
import { sprintNotice } from './sprints'
import { isoLocal } from './time'
import { handleTool, specsFor, TOOL_NAMES } from './tools'
import { decideLayout, parseSetting, wantsPane, wholeScreen, type LayoutKind, type LayoutSetting, type Viewport } from './view/layout'
import { detectEnv, resolveTarget, type Platform } from './view/links'
import { makeActions, renderBoard, renderEntry, renderNotice, shownLinks, type Actions, type Mode, type StoreActions, type ViewModel } from './view/board'
import { deriveEffects, isAlive, NO_FX, textSignature, type Effects } from './view/effects'
import { boardCounts } from './view/derive'
import { EMPTY_LOCAL, hideLink, LocalStore, localPath, markSeen, unhideLink, type LocalView } from './view/local'
import { paletteFor, type Palette, type RasterSpec } from './view/motion'
import { CALM_AFTER_MS, Ticker, type TickerDeps, type TickerView } from './view/ticker'

const PLUGIN = 'project-board'
const POLL_MS = 3000
const SECTION_ID = `${PLUGIN}:board`
const PANE_ID = 'board'
/** A pane the person opens is docked beside a fullscreen transcript from this many terminal columns, else inline. */
const DOCK_FROM_COLUMNS = 110
const landsDocked = (p: { isFullscreen: boolean; columns: number }): boolean => p.isFullscreen && p.columns >= DOCK_FROM_COLUMNS

const expandedAtom = atom({ plugin: 'project-board', key: 'expanded' } as const, {})
const staleAtom = atom({ plugin: 'project-board', key: 'stale' } as const, false)
/** The user folded the board above the prompt (portrait screens) down to its one-line entry. */
const bandHiddenAtom = atom({ plugin: 'project-board', key: 'bandHidden' } as const, false)

/**
 * Shows the board where the screen shape calls for it: the side pane, or the band above the prompt.
 * Resolves to what to tell the user.
 */
async function openBoard($: EngineInterface, wantsSide: boolean, isDocked: boolean): Promise<string> {
  const sh = shellOf($)
  await update($, bandHiddenAtom, () => false)
  if (wantsSide) {
    const r = await sh.openPane()
    sh.invalidate()
    if (!r.isPlaced) return '终端太窄，侧边栏放不下；拉宽后会自动出现'
    return isDocked ? '已打开看板（右侧）' : '已打开看板（输入框上方）'
  }
  sh.invalidate()
  return '已打开看板（输入框上方）'
}

/** Takes the board off the screen: closes the side pane and/or folds the band above the prompt. */
async function closeBoard($: EngineInterface, isPaneUp: boolean): Promise<string> {
  const sh = shellOf($)
  if (isPaneUp) await sh.closePane()
  await update($, bandHiddenAtom, () => true)
  sh.invalidate()
  return '已收起看板'
}

/** The engine calls the board view needs, each spelled $.noun.method(...) where validate reads it. */
function shellOf($: EngineInterface) {
  return {
    panes: () => $.ui.panes(),
    openPane: () => $.ui.open({ id: PANE_ID, title: '看板' }),
    closePane: () => $.ui.close({ id: PANE_ID }),
    invalidate: () => $.ui.invalidate('ui.render'),
    later: (fn: () => void) => {
      $.clock.after(0, fn)
    },
  }
}
type Shell = ReturnType<typeof shellOf>

/** What the drawing keeps between frames, apart from the board itself. */
interface ViewState {
  mascotOn: boolean
  /** The `motion` setting of the plugin. */
  motionOn: boolean
  /** Claude Code's own reduce-motion setting. */
  reduceMotion: boolean
  /** The theme's colours; null for `auto`, the ANSI themes and names this code does not know. */
  palette: Palette | null
  /** What the user looked at or hid on this machine (shared with pi through one file per project). */
  local: LocalStore | null
  /** Facts about the machine and session that the drawing reuses: asked once per session. */
  ambient: { platform: Platform; hasCode: boolean; home: string; sessionId: string } | null
  /** Which linked files are missing in each layout, for the board, the open/closed choices and the local view it was computed for. */
  missingCache: { board: unknown; key: string; local: LocalView; missing: Record<Mode, ReadonlySet<string>> } | null
  /** The check that fills `ambient` and `missingCache`, while it runs. */
  warming: Promise<void> | null
  /** One-off effects per project root (the store holds one root; the map keeps a replaced one apart). */
  fx: Map<string, Effects>
  root: string
  /** When the session started, or the user or the board last did something. */
  lastActive: number
  /** Something runs on and on in what was drawn last. */
  continuous: boolean
  ticker: Ticker | null
}
const newViewState = (mascotOn: boolean, motionOn: boolean): ViewState => ({
  mascotOn, motionOn, reduceMotion: false, palette: null, local: null, ambient: null, missingCache: null, fx: new Map(), root: '', lastActive: 0, continuous: false, ticker: null, warming: null,
})

/** Motion shows when the plugin's setting allows it and the system does not ask for less. */
const animated = (v: ViewState): boolean => v.motionOn && !v.reduceMotion

/** Reads the theme and the reduce-motion switch from the engine's settings list. */
async function refreshTheme($: EngineInterface, v: ViewState): Promise<void> {
  const rows = await $.config.list().catch(() => [])
  const theme = rows.find(r => r.key === 'theme')?.value
  v.palette = paletteFor(typeof theme === 'string' ? theme : undefined)
  v.reduceMotion = rows.find(r => r.key === 'reduceMotion')?.value === true
  v.ticker?.setEnabled(animated(v))
}

/** The engine calls the ticker makes, each spelled $.noun.method(...) where validate reads it. */
function tickerDepsOf($: EngineInterface): TickerDeps {
  return {
    every: (ms, fn) => $.clock.every(ms, fn),
    blit: (requestId, key, cells) => $.ui.blit({ requestId, key, cells }),
    now: () => $.clock.now(),
    invalidate: () => void $.ui.invalidate('ui.render'),
  }
}

function tickerViewOf(v: ViewState): TickerView {
  const fxNow = (): Effects => v.fx.get(v.root) ?? NO_FX
  return {
    continuous: () => v.continuous,
    oneShot: now => isAlive(fxNow(), now),
    signature: now => textSignature(fxNow(), now),
    lastActive: () => v.lastActive,
  }
}

/** The ticker of this scope; made on first use, so a reloaded module gets its own and starts again when it draws. */
function tickerOf($: EngineInterface, v: ViewState): Ticker {
  if (v.ticker === null) {
    v.ticker = new Ticker(tickerDepsOf($), tickerViewOf(v))
    v.ticker.setEnabled(animated(v))
  }
  return v.ticker
}

/** A drawing mounted these canvases at `requestId`: the ticker may repaint them. No canvas means nothing to repaint there. */
function placeOnTicker($: EngineInterface, v: ViewState, requestId: string, specs: readonly RasterSpec[]): void {
  const t = tickerOf($, v)
  if (specs.length === 0) t.unmounted(requestId)
  else t.mounted(requestId, specs)
}

/** Something happened (a press, a message, a board change): leave the calm pace and make sure the ticker runs. */
async function touch($: EngineInterface, v: ViewState): Promise<void> {
  v.lastActive = await $.clock.now()
  void tickerOf($, v).ensure()
}

/** The local view file of the project on screen; null before the board or the home directory is known. */
function localPathOf(s: BoardStore, v: ViewState): string | null {
  const root = s.current().root
  const home = v.ambient?.home ?? ''
  return root === null || home === '' ? null : localPath(home, root)
}

const localOf = (s: BoardStore, v: ViewState): LocalView => {
  const path = localPathOf(s, v)
  return path === null || v.local === null ? EMPTY_LOCAL : v.local.get(path)
}

/**
 * Asks the machine what the drawing reuses: the platform and session once, the local view file once, and which
 * linked files are missing for the board, the open/closed choices and the local view as they are now. The drawing never checks files itself: it waits
 * here only when this has not run for what it is about to draw.
 */
function warm($: EngineInterface, h: Host, s: BoardStore, v: ViewState, expanded: Record<string, boolean>): Promise<void> {
  v.warming ??= (async () => {
    if (v.ambient === null) {
      const env = await detectEnv(h)
      v.ambient = { ...env, home: (await $.env.get('HOME').catch(() => undefined)) ?? '', sessionId: await h.sessionId() }
    }
    const path = localPathOf(s, v)
    if (path !== null) await v.local?.load(path)
    const cur = s.current()
    const key = JSON.stringify(expanded)
    const local = localOf(s, v)
    if (v.missingCache !== null && v.missingCache.board === cur.board && v.missingCache.key === key && v.missingCache.local === local) return
    const home = v.ambient.home
    const root = cur.root ?? ''
    const known = new Map<string, boolean>()
    const missingIn = async (mode: Mode): Promise<ReadonlySet<string>> => {
      const missing = new Set<string>()
      if (cur.board === null) return missing
      for (const l of shownLinks(cur.board, expanded, mode, local)) {
        if (l.type !== 'path') continue
        const abs = resolveTarget(l.target, root, home)
        let there = known.get(abs)
        if (there === undefined) {
          there = await h.exists(abs).catch(() => true)
          known.set(abs, there)
        }
        if (!there) missing.add(abs)
      }
      return missing
    }
    v.missingCache = { board: cur.board, key, local, missing: { pane: await missingIn('pane'), 'band-full': await missingIn('band-full') } }
  })().finally(() => {
    v.warming = null
  })
  return v.warming
}

/** What the drawing needs: the board as the store holds it, the user's open/closed choices, whether files exist. */
async function viewOf($: EngineInterface, h: Host, s: BoardStore, mode: Mode, width: number, canvas: boolean, v: ViewState, specs: RasterSpec[]): Promise<ViewModel> {
  const cur = s.current()
  const expanded = await read($, expandedAtom)
  const stale = await read($, staleAtom)
  const key = JSON.stringify(expanded)
  const fresh = (): boolean =>
    v.ambient !== null && v.missingCache !== null && v.missingCache.board === cur.board && v.missingCache.key === key && v.missingCache.local === localOf(s, v)
  // A check that was already running may have been for an older choice of open/closed: ask once more.
  for (let n = 0; n < 2 && !fresh(); n++) await warm($, h, s, v, expanded)
  const amb = v.ambient as NonNullable<ViewState['ambient']>
  const root = cur.root ?? ''
  v.root = root
  const now = await h.now()
  const local = localOf(s, v)
  const counts = cur.board === null ? null : boardCounts(cur.board, local)
  v.continuous = counts !== null && (counts.running > 0 || counts.review > 0 || (cur.board?.proposals.length ?? 0) > 0 || stale)
  return {
    board: cur.board, error: cur.error, bytes: cur.bytes, root, home: amb.home, sessionId: amb.sessionId, stale, expanded,
    missing: v.missingCache?.missing[mode] ?? new Set(), platform: amb.platform, hasCode: amb.hasCode,
    canvas, width, palette: v.palette, mascot: v.mascotOn, local, hover: canvas,
    motion: canvas && animated(v), now, calm: now - v.lastActive >= CALM_AFTER_MS, fx: v.fx.get(root) ?? NO_FX,
    collect: spec => void specs.push(spec),
  }
}

function actionsOf($: EngineInterface, s: BoardStore, base: StoreActions, v: ViewState): Actions {
  /** Changes the local view file and draws again; the board file and Claude never hear of it. */
  const local = async (fn: (lv: LocalView) => LocalView): Promise<void> => {
    void touch($, v)
    const path = localPathOf(s, v)
    if (path === null || v.local === null) return
    await v.local.update(path, fn)
    $.ui.invalidate('ui.render')
  }
  return {
    ...base,
    toggle: async (key, open) => {
      void touch($, v)
      await update($, expandedAtom, m => ({ ...m, [key]: open }))
    },
    toggleMany: async entries => {
      void touch($, v)
      await update($, expandedAtom, m => ({ ...m, ...entries }))
    },
    approveProposal: id => (void touch($, v), base.approveProposal(id)),
    rejectProposal: id => (void touch($, v), base.rejectProposal(id)),
    focusGoal: id => (void touch($, v), base.focusGoal(id)),
    markSeen: id =>
      local(lv => {
        const it = s.current().board?.goals.flatMap(g => g.items).find(i => i.id === id)
        return it === undefined ? lv : markSeen(lv, it)
      }),
    hideLink: (ownerId, target) => local(lv => hideLink(lv, ownerId, target)),
    unhideLink: (ownerId, target) => local(lv => unhideLink(lv, ownerId, target)),
  }
}

/** Every engine call the board logic needs, each spelled $.noun.method(...) where validate reads it. */
function hostOf($: EngineInterface): Host {
  return {
    readText: path => $.fs.read(path),
    writeText: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    listDir: path => $.fs.list(path),
    stat: path =>
      $.fs.stat(path).then(
        s => ({ mtimeMs: s.mtimeMs }),
        () => null,
      ),
    run: argv =>
      $.process.run(argv).then(r => ({ code: r.exitCode, stdout: r.stdout, stderr: r.stderr })),
    root: () => $.session.root(),
    sessionId: () => $.session.id(),
    toast: text => $.ui.toast(text),
    status: text => $.ui.status(text),
    copy: (text, surface) =>
      $.ui.copy(surface === undefined ? { text } : { text, surface: surface as 'terminal' }).then(r => r.isCopied),
    now: () => $.clock.now(),
    getState: async <K extends keyof SyncState>(key: K): Promise<SyncState[K]> => {
      switch (key) {
        case 'snapshot':
          return ((await $.state.get({ plugin: 'project-board', key: 'snapshot' } as const)).value ?? null) as SyncState[K]
        case 'untold':
          return ((await $.state.get({ plugin: 'project-board', key: 'untold' } as const)).value ?? []) as SyncState[K]
        case 'stale':
          return ((await $.state.get({ plugin: 'project-board', key: 'stale' } as const)).value ?? false) as SyncState[K]
        default:
          return ((await $.state.get({ plugin: 'project-board', key: 'reminder' } as const)).value ?? '') as SyncState[K]
      }
    },
    setState: async <K extends keyof SyncState>(key: K, value: SyncState[K]): Promise<void> => {
      switch (key) {
        case 'snapshot':
          await $.state.set({ plugin: 'project-board', key: 'snapshot' } as const, value as string | null)
          return
        case 'untold':
          await $.state.set({ plugin: 'project-board', key: 'untold' } as const, value as string[])
          return
        case 'stale':
          await $.state.set({ plugin: 'project-board', key: 'stale' } as const, value as boolean)
          return
        default:
          await $.state.set({ plugin: 'project-board', key: 'reminder' } as const, value as string)
      }
    },
    registerTool: async spec => {
      await $.tool.register(spec)
    },
  }
}

/** ISO 8601 with the local UTC offset, e.g. 2026-10-11T09:00:00+08:00. */
export const register: Register = (on, options) => {
  const setting: LayoutSetting = parseSetting(options.layout)
  let host: Host | null = null
  let store: BoardStore | null = null
  let sync: Sync | null = null
  let shell: Shell | null = null
  let storeActions: StoreActions | null = null
  /** The pane was closed because the screen turned portrait; open it again when the screen is wide again. */
  let closedForShape = false
  let paneAsked = false
  /** A close is already scheduled for the pane that is drawing; a lingering drawing must not schedule another. */
  let closing = false
  /** The terminal as the last drawing above the prompt saw it with no pane up; /board decides pane or band from it. */
  let lastScreen: Viewport = undefined
  let lastFullscreen = false
  let toolsMode: 'none' | 'init' | 'full' = 'none'
  let toolsTail: Promise<unknown> = Promise.resolve()
  const view = newViewState(options.mascot !== 'off', options.motion !== 'off')

  /**
   * Makes the registered tools match the project: only board_init until a board exists, then all four.
   * The engine has no way to withdraw a tool, so once the full set is registered it stays.
   * Call again after anything that may have created the board.
   */
  const syncTools = (): Promise<void> => {
    const run = toolsTail.then(async () => {
      const h = host
      const s = store
      if (h === null || s === null || toolsMode === 'full') return
      const hasBoard = s.current().root !== null
      const want = hasBoard ? 'full' : 'init'
      if (toolsMode === want) return
      for (const spec of specsFor(hasBoard)) await h.registerTool(spec)
      toolsMode = want
    })
    toolsTail = run.catch(() => undefined)
    return run
  }

  /** Opens the side pane once per session, as soon as there is a board. Drawing code never calls this. */
  const askPane = (): void => {
    const sh = shell
    if (sh === null || paneAsked || setting === 'bottom' || store?.current().root == null) return
    paneAsked = true
    sh.later(() => void sh.openPane().then(() => sh.invalidate()).catch(() => undefined))
  }

  const panePlaced = async (sh: Shell): Promise<boolean> => (await sh.panes().catch(() => [])).some(p => p.id === PANE_ID && p.isPlaced)

  on('session.start', async ($, e, next) => {
    host = hostOf($)
    const h = host
    const board = new BoardStore(host)
    store = board
    sync = new Sync(host, board)
    shell = shellOf($)
    storeActions = makeActions(h, board, async () => isoLocal(await h.now()))
    view.local = new LocalStore(h)
    paneAsked = false
    closedForShape = false
    closing = false
    toolsMode = 'none'
    view.lastActive = await $.clock.now()
    view.ambient = null
    view.missingCache = null
    view.warming = null
    view.ticker?.setEnabled(false)
    view.ticker = null
    tickerOf($, view)
    await refreshTheme($, view)
    await board.locate().catch(() => null)
    await warm($, h, board, view, await read($, expandedAtom)).catch(() => undefined)
    await syncTools()
    askPane()
    board.onChange(c => {
      void syncTools().catch(() => undefined)
      askPane()
      // The one-off effects of this change start now, the file checks for the new board are done, and then the board is drawn once.
      void (async () => {
        try {
          const t = await h.now()
          view.lastActive = t
          if (animated(view)) {
            const root = board.current().root ?? ''
            view.fx.set(root, deriveEffects(view.fx.get(root) ?? NO_FX, { source: c.source, before: c.before, after: c.after }, t))
          }
          await warm($, h, board, view, await read($, expandedAtom))
        } finally {
          try {
            shell?.invalidate()
          } catch {
            // nothing is drawn yet
          }
        }
        void tickerOf($, view).ensure()
      })().catch(() => undefined)
    })
    $.clock.every(POLL_MS, () => void board.poll())
    await $.command.register({
      name: 'board',
      description: '项目看板：打开 / 关闭，决策、约定、资料、归档，init 创建',
      argumentHint: '[决策|约定|资料|归档|init] …',
    })
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    const h = host
    const s = store
    const sh = shell
    if (h === null || s === null || sh === null) return { text: '看板尚未初始化，稍后再试' }
    let cur = s.current()
    if (cur.board === null && cur.error === null) {
      await s.locate().catch(() => null)
      cur = s.current()
    }
    const r = await runCommand(e.args, cur.board, {
      error: cur.error,
      root: cur.root,
      init: async type => {
        const found = await s.init('', type, 'user')
        await syncTools()
        const made = s.current().board
        const sprints = sprintNotice(found)
        return `已创建 ai/board.json（项目：${made?.project.name ?? ''}${type.trim() === '' ? '' : `，类型：${type.trim()}`}）。${sprints}完整的看板工具从 Claude 的下一轮起可用。`
      },
      toggle: async () => {
        const placed = await panePlaced(sh)
        const hidden = await read($, bandHiddenAtom)
        const bandShown = decideLayout(lastScreen, { isPlaced: placed }, setting) === 'band-full' && !hidden
        if (placed || bandShown) return closeBoard($, placed)
        return openBoard($, wantsPane(lastScreen, setting), landsDocked({ isFullscreen: lastFullscreen, columns: lastScreen?.columns ?? 0 }))
      },
    })
    if (!r.userOnly) return { text: r.text }
    // A listing is for the person: a notice row the model never reads, and no command output.
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: r.text }] } })
    return {}
  })

  // The same system-prompt text every turn: built once per conversation, kept in $.state.
  on('prompt.compose', async (_$, e, next) => {
    const base = await next(e)
    const text = sync === null ? null : await sync.snapshot().catch(() => null)
    if (text === null) return base
    return { sections: [...base.sections.filter(s => s.id !== SECTION_ID), { id: SECTION_ID, text, scope: 'session' as const }] }
  })

  on('session.end', async (_$, e, next) => {
    if (e.reason === 'clear' && sync !== null) await sync.reset()
    return next(e)
  })

  // What changed behind Claude's back, and the bookkeeping nudge, ride on the user's next message.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') sync?.notified(e.text, e.turnId !== undefined)
    if (isUserSubmission(e)) void touch($, view)
    if (sync === null || !isUserSubmission(e)) return next(e)
    const owed = await sync.takeForSubmit().catch(() => [])
    return next(owed.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...owed] })
  })

  on('turn.start', async (_$, e, next) => {
    sync?.turn.reset()
    return next(e)
  })

  on('turn.complete', async (_$, e, next) => {
    if (e.agentId !== undefined) sync?.agentFinished(e.agentId)
    else if (sync !== null) await sync.turnComplete()
    return next(e)
  })

  // Counts the main session's own work; sub-agents (agentId set) are not the main turn's.
  on('tool.call', async (_$, e, next) => {
    if (e.agentId === undefined) sync?.turn.count(e.tool, false)
    return next(e)
  })

  for (const name of TOOL_NAMES) {
    on('tool.call', { tool: `mcp__${PLUGIN}__${name}` }, async (_$, e) => {
      const h = host
      const s = store
      if (h === null || s === null) return { result: JSON.stringify({ ok: false, error: '看板尚未初始化' }) }
      const { tool: _tool, tool_use_id: _id, agentId, ...input } = e as unknown as Record<string, unknown> & { agentId?: string }
      const result = await handleTool(name, input, {
        store: s,
        actor: agentId === undefined ? 'main' : 'agent',
        session: await h.sessionId(),
        now: isoLocal(await h.now()),
        toast: t => h.toast(t),
      })
      if (name === 'board_init') await syncTools().catch(() => undefined)
      await sync?.flush()
      return { result }
    })
  }

  // The theme sets the canvas colours: read it again when it changes.
  on('config.set', async ($, e, next) => {
    const r = await next(e)
    if (e.key === 'theme' || e.key === 'reduceMotion') {
      await refreshTheme($, view)
      shell?.invalidate()
    }
    return r
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const sh = shell
    if (sh === null) return next(e)
    const els = $.ui.resolve(e)
    const { placement, bodyColumns } = e.props
    // Docked, the viewport is the conversation's: add the pane back to get the terminal the shape is read from.
    // A portrait terminal draws the board above the prompt: a docked pane closes itself, after the drawing.
    // An inline pane closes the same way: the narrow view above the prompt replaces it.
    const docked = placement === 'dock' && e.surface === 'terminal'
    if (decideLayout(wholeScreen(e.viewport, docked ? bodyColumns : null), { isPlaced: true }, setting) !== 'pane') {
      if (!closing) {
        closing = true
        closedForShape = true
        sh.later(() => void sh.closePane().then(() => sh.invalidate()).catch(() => undefined))
      }
      view.ticker?.unmounted(PANE_ID)
      return renderNotice(els, '看板显示在输入框上方')
    }
    closing = false
    if (host === null || store === null || storeActions === null) return next(e)
    const specs: RasterSpec[] = []
    const tree = renderBoard(els, await viewOf($, host, store, 'pane', bodyColumns, e.surface === 'terminal', view, specs), actionsOf($, store, storeActions, view), 'pane')
    placeOnTicker($, view, PANE_ID, specs)
    return tree
  })

  // Always asked, so it decides for the whole screen: full board, one-line entry, or nothing.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const sh = shell
    if (e.props.hasSurvey || sh === null || store === null || store.current().root === null) {
      view.ticker?.unmounted(e.requestId)
      return next(e)
    }
    const placed = await panePlaced(sh)
    // A pane that is on screen draws the board itself, docked or above the prompt, and closes itself on a portrait terminal.
    if (setting !== 'bottom' && placed) {
      view.ticker?.unmounted(e.requestId)
      return next(e)
    }
    const screen = e.viewport
    // /board reads the terminal's shape, whatever surface drew last.
    if (e.surface === 'terminal') {
      lastScreen = screen
      lastFullscreen = e.viewport?.isFullscreen === true
    }
    let kind: LayoutKind = decideLayout(screen, { isPlaced: placed }, setting)
    if (kind === 'pane' && !placed) kind = 'band-entry'
    if (closedForShape && wantsPane(screen, setting)) {
      closedForShape = false
      closing = false
      sh.later(() => void sh.openPane().then(() => sh.invalidate()).catch(() => undefined))
    }
    if (kind === 'pane') {
      view.ticker?.unmounted(e.requestId)
      return next(e)
    }
    const els = $.ui.resolve(e)
    if (host === null || storeActions === null) return next(e)
    const specs: RasterSpec[] = []
    const vm = await viewOf($, host, store, 'band-full', e.props.bodyColumns, e.surface === 'terminal', view, specs)
    const actions = actionsOf($, store, storeActions, view)
    const h = host
    const onOpen = async (): Promise<void> => h.toast(await openBoard($, wantsPane(screen, setting), landsDocked({ isFullscreen: e.viewport?.isFullscreen === true, columns: screen?.columns ?? 0 })))
    if (kind !== 'band-full' || (await read($, bandHiddenAtom))) {
      view.ticker?.unmounted(e.requestId)
      return renderEntry(els, vm, onOpen)
    }
    const tree = renderBoard(els, vm, actions, 'band-full')
    placeOnTicker($, view, e.requestId, specs)
    return tree
  })
}
