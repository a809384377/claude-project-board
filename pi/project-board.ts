import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { runCommand } from '../hooks/commands'
import type { Host, ToolRegistration } from '../hooks/host'
import { sprintNotice } from '../hooks/sprints'
import { BoardStore } from '../hooks/store'
import { Sync, type ToolNames } from '../hooks/sync'
import { handleTool, specsFor } from '../hooks/tools'
import { isoLocal } from '../hooks/time'
import { nodeHost } from './host'
import { toolDefinition } from './tools'
import { Dock, dockReady } from './ui/dock'
import { BandView, PaneView } from './ui/surfaces'
import { BoardUi } from './ui/state'
import { parseSetting, wantsPane, type LayoutSetting } from '../hooks/view/layout'

/**
 * project-board for pi: the same ai/board.json, tools, prompt snapshot and /board command as the Claude Code
 * plugin, over the same core (../hooks). Load with `pi -e ./pi/index.ts`, or install this repository as a pi package.
 *
 * The board is drawn with the same view as the Claude Code plugin (hooks/view/board.tsx, compiled for pi into
 * pi/gen/board.js and drawn by pi/ui/engine.ts): docked at the right of a landscape fullscreen terminal, above the
 * prompt otherwise.
 *
 * Environment: PI_PROJECT_BOARD_WIDGET = full (default) | compact (start folded) | off;
 *              PI_PROJECT_BOARD_LAYOUT = auto (default) | right | bottom; PI_PROJECT_BOARD_MOTION = off stops the animation.
 */

const SECTION_KEY = 'project_board'
const WIDGET_KEY = 'project-board'
const POLL_MS = 3000
const NOTICE_TYPE = 'project-board-notice'
const COMMAND_TYPE = 'project-board'

/** pi's own tool names, as the bookkeeping check counts them. */
const PI_TOOLS: ToolNames = { edit: new Set(['edit', 'write']), agent: new Set(['subagent']) }

const SUBCOMMANDS = [
  { value: '决策', description: '生效中的决策' },
  { value: '约定', description: '项目约定' },
  { value: '资料', description: '项目资料' },
  { value: '归档', description: '已关闭的目标与决策' },
  { value: 'init', description: '创建看板' },
]

type Mode = 'full' | 'compact' | 'off'
const widgetMode = (): Mode => {
  const v = (process.env.PI_PROJECT_BOARD_WIDGET ?? '').trim().toLowerCase()
  return v === 'compact' || v === 'off' ? v : 'full'
}

const layoutSetting = (): LayoutSetting => parseSetting((process.env.PI_PROJECT_BOARD_LAYOUT ?? '').trim().toLowerCase())
const truecolor = (): boolean => /truecolor|24bit/i.test(process.env.COLORTERM ?? '')
/** The pane is docked from this many terminal columns; narrower terminals draw the board above the prompt. */
const DOCK_FROM_COLUMNS = 100

type Tui = { requestRender(force?: boolean): void; terminal: { columns: number; rows: number } }
type Themed = { appearance?: string }

/** Everything one pi session keeps for the board; made at session_start, dropped at session_shutdown. */
class Runtime {
  readonly store: BoardStore
  readonly sync: Sync
  readonly host: Host
  readonly actor: 'main' | 'agent'
  readonly ui: BoardUi
  private toolsMode: 'none' | 'init' | 'full' = 'none'
  private toolsTail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private mounted = false
  private tui: Tui | null = null
  private dock: Dock | null = null
  private dockFailed = false
  private dockTimer: ReturnType<typeof setTimeout> | null = null
  private down = false

  constructor(
    readonly ctx: ExtensionContext,
    private readonly pi: ExtensionAPI,
    private readonly shared: { collapsed: boolean },
    readonly child: boolean,
  ) {
    // A pi sub-agent is a process of its own that loads this extension too: its board writes are a sub-agent's, never the main session's.
    this.actor = child ? 'agent' : 'main'
    this.host = nodeHost({
      cwd: ctx.cwd,
      sessionId: () => ctx.sessionManager.getSessionId(),
      notify: text => this.safe(() => ctx.ui.notify(text, 'info')),
      status: text => this.safe(() => ctx.ui.setStatus(WIDGET_KEY, text)),
      registerTool: spec => this.registerTool(spec),
    })
    this.store = new BoardStore(this.host)
    this.sync = new Sync(this.host, this.store, PI_TOOLS)
    this.ui = new BoardUi({
      host: this.host,
      store: this.store,
      requestRender: () => this.safe(() => this.tui?.requestRender()),
      motion: (process.env.PI_PROJECT_BOARD_MOTION ?? '').trim().toLowerCase() !== 'off',
      mascot: true,
    })
  }

  /** The UI belongs to a session that may be gone: a call on it must never break the board. */
  private safe(fn: () => void): void {
    try {
      fn()
    } catch {
      // the session was replaced
    }
  }

  private registerTool(spec: ToolRegistration): void {
    this.pi.registerTool(toolDefinition(spec, (name, input) => this.call(name, input)))
  }

  /** One tool call from the model. */
  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const result = await handleTool(name, input, {
      store: this.store,
      actor: this.actor,
      session: await this.host.sessionId(),
      now: isoLocal(await this.host.now()),
      toast: t => this.host.toast(t),
    })
    if (name === 'board_init') await this.syncTools().catch(() => undefined)
    await this.sync.flush()
    return result
  }

  /**
   * Makes the registered tools match the project: only board_init (found through tool search) until a board
   * exists, then all four. Tools cannot be withdrawn, so once the full set is registered it stays.
   */
  syncTools(): Promise<void> {
    const run = this.toolsTail.then(async () => {
      if (this.toolsMode === 'full') return
      const hasBoard = this.store.current().root !== null
      const want = hasBoard ? 'full' : 'init'
      if (this.toolsMode === want) return
      for (const spec of specsFor(hasBoard)) await this.host.registerTool(spec)
      this.toolsMode = want
    })
    this.toolsTail = run.catch(() => undefined)
    return run
  }

  async start(): Promise<void> {
    await this.store.locate().catch(() => null)
    await this.syncTools().catch(() => undefined)
    await dockReady()
    this.store.onChange(c => {
      void this.syncTools().catch(() => undefined)
      this.ui.onChange(c)
      void this.refresh()
    })
    this.timer = setInterval(() => void this.store.poll(), POLL_MS)
    this.timer.unref?.()
    await this.refresh()
  }

  /** The widget shows the board as it is now; made on the first draw after a board exists. */
  async refresh(): Promise<void> {
    if (this.down) return
    this.ui.stale = await this.host.getState('stale').catch(() => false)
    this.mount()
    this.safe(() => this.tui?.requestRender())
  }

  private mount(): void {
    const { ctx } = this
    if (this.mounted || this.child || ctx.mode !== 'tui' || !ctx.hasUI || widgetMode() === 'off') return
    const cur = this.store.current()
    if (cur.root === null && cur.error === null) return
    this.mounted = true
    this.safe(() =>
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          const t = tui as unknown as Tui
          this.tui = t
          const rows = (): number => t.terminal.rows
          const sink = { truecolor: truecolor(), rows }
          const pane = new PaneView(this.ui, sink, () => this.setFolded(true))
          const band = new BandView(this.ui, { ...sink, cap: () => (this.viewport(t) ? Math.min(26, Math.floor(rows() * 0.45)) : rows() - 12) }, () => this.setFolded(false))
          const dock = new Dock(t, pane)
          this.dock = dock
          return {
            render: (width: number): string[] => {
              this.ui.appearance = (theme as unknown as Themed).appearance === 'light' ? 'light' : 'dark'
              const mode = this.surface(t, dock)
              this.settle(mode, t, dock)
              if (mode === 'pane') return []
              return band.render(width, mode === 'folded')
            },
            handleMouse: e => band.handleMouse(e),
            invalidate: () => undefined,
            dispose: () => {
              dock.detach()
              if (this.tui === t) this.tui = null
              if (this.dock === dock) this.dock = null
            },
          }
        },
        { placement: 'aboveEditor' },
      ),
    )
  }

  private viewport(t: Tui): boolean {
    return this.dock?.possible() === true && t.terminal.columns > 0
  }

  /** Where the board is drawn now: docked 'pane', 'band' above the prompt, or the 'folded' one-line entry. */
  private surface(t: Tui, dock: Dock): 'pane' | 'band' | 'folded' {
    if (this.shared.collapsed) return 'folded'
    const { columns, rows } = t.terminal
    const wide = columns >= DOCK_FROM_COLUMNS && dock.possible() && !this.dockFailed
    return wide && wantsPane({ columns, rows }, layoutSetting()) ? 'pane' : 'band'
  }

  /** Brings the layout in line with `mode`, after this frame: pi must not be re-laid-out from inside a render. */
  private settle(mode: 'pane' | 'band' | 'folded', t: Tui, dock: Dock): void {
    const want = mode === 'pane' ? Math.min(76, Math.max(48, Math.round(t.terminal.columns * 0.42))) : 0
    if (want === 0 ? !dock.attached : dock.attached && dock.width === want) return
    if (this.dockTimer !== null) return
    this.dockTimer = setTimeout(() => {
      this.dockTimer = null
      if (this.down) return
      if (want === 0) dock.detach()
      else if (!dock.attach(want)) {
        this.dockFailed = true
        this.safe(() => t.requestRender())
      }
    }, 0)
    this.dockTimer.unref?.()
  }

  private setFolded(v: boolean): void {
    this.shared.collapsed = v
    this.safe(() => this.tui?.requestRender())
  }

  /** /board with no argument: fold the board to its one-line entry, or open it again. */
  toggle(): string {
    this.setFolded(!this.shared.collapsed)
    return this.shared.collapsed ? '已收起看板' : '已打开看板'
  }

  dispose(): void {
    this.down = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.dockTimer !== null) clearTimeout(this.dockTimer)
    this.dock?.detach()
    this.ui.dispose()
    if (this.mounted) this.safe(() => this.ctx.ui.setWidget(WIDGET_KEY, undefined))
    this.mounted = false
    this.tui = null
  }
}

export default function projectBoard(pi: ExtensionAPI): void {
  const child = process.env.PI_SUBAGENT_CHILD === '1'
  const shared = { collapsed: widgetMode() === 'compact' }
  let rt: Runtime | null = null

  pi.on('session_start', async (_event, ctx) => {
    rt?.dispose()
    const next = new Runtime(ctx, pi, shared, child)
    rt = next
    await next.start()
  })

  pi.on('session_shutdown', () => {
    rt?.dispose()
    rt = null
  })

  // The board snapshot rides in the system prompt (the same text every turn); what changed behind the AI's back, and
  // the bookkeeping nudge, ride on the user's next message.
  pi.on('before_agent_start', async (event) => {
    const r = rt
    if (r === null || r.child) return
    await r.store.poll().catch(() => undefined)
    const text = await r.sync.snapshot().catch(() => null)
    if (text === null) delete event.systemPromptOptions.sections[SECTION_KEY]
    else event.systemPromptOptions.sections[SECTION_KEY] = text
    if (event.messageType !== 'user') return
    const owed = await r.sync.takeForSubmit().catch(() => [])
    if (owed.length === 0) return
    return { message: { customType: NOTICE_TYPE, content: owed.join('\n\n'), display: false } }
  })

  pi.on('agent_start', () => {
    rt?.sync.turn.reset()
  })

  pi.on('tool_call', (event) => {
    rt?.sync.turn.count(event.toolName, false)
  })

  pi.on('agent_end', async () => {
    const r = rt
    if (r === null || r.child) return
    await r.sync.turnComplete().catch(() => undefined)
    await r.refresh()
  })

  pi.registerCommand('board', {
    description: '项目看板：打开 / 收起，决策、约定、资料、归档，init 创建',
    getArgumentCompletions: prefix => {
      if (prefix.includes(' ')) return null
      const hits = SUBCOMMANDS.filter(c => c.value.startsWith(prefix))
      return hits.length === 0 ? null : hits.map(c => ({ value: c.value, label: c.value, description: c.description }))
    },
    handler: async (args, ctx) => {
      const r = rt
      if (r === null) {
        ctx.ui.notify('看板尚未初始化，稍后再试', 'warning')
        return
      }
      let cur = r.store.current()
      if (cur.board === null && cur.error === null) {
        await r.store.locate().catch(() => null)
        cur = r.store.current()
      }
      const { text } = await runCommand(args, cur.board, {
        error: cur.error,
        root: cur.root,
        init: async type => {
          const found = await r.store.init('', type, 'user')
          await r.syncTools()
          await r.refresh()
          const made = r.store.current().board
          return `已创建 ai/board.json（项目：${made?.project.name ?? ''}${type.trim() === '' ? '' : `，类型：${type.trim()}`}）。${sprintNotice(found)}看板工具已可用。`
        },
        toggle: async () => r.toggle(),
      })
      // Listings go into the conversation, where the AI sees them on its next turn; the rest is a notice.
      const t = args.trim()
      if (t === '' || t.startsWith('init')) ctx.ui.notify(text, 'info')
      else await pi.sendMessage({ customType: COMMAND_TYPE, content: text, display: true })
    },
  })
}
