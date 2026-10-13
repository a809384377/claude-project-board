import { homedir } from 'node:os'

import type { Host } from '../../hooks/host'
import type { BoardStore } from '../../hooks/store'
import { isoLocal } from '../../hooks/time'
import { boardCounts } from '../../hooks/view/derive'
import { deriveEffects, isAlive, NO_FX, textSignature, type Change, type Effects } from '../../hooks/view/effects'
import { detectEnv, resolveTarget, type Platform } from '../../hooks/view/links'
import { paletteFor, type RasterSpec } from '../../hooks/view/motion'
import { CALM_AFTER_MS, Ticker } from '../../hooks/view/ticker'
import { makeActions, renderBoard, renderEntry, shownLinks, STAMP_MS, type Actions, type Els, type StoreActions, type ViewModel } from '../gen/board.js'
import { draw, els, type Drawn, type Hit, type Node } from './engine'

type Mode = 'pane' | 'band-full'

export type UiEnv = {
  host: Host
  store: BoardStore
  requestRender: () => void
  motion: boolean
  mascot: boolean
}

/**
 * What the board view needs between frames, the way the Claude Code plugin keeps it in register.ts: the user's
 * open/closed choices, stamps, one-off effects, the checks for linked files, and the timer that moves the canvases.
 * `draw` is synchronous (pi asks for lines); whatever is still being checked arrives with a later render.
 */
export class BoardUi {
  appearance: 'dark' | 'light' = 'dark'
  stale = false
  private expanded: Record<string, boolean> = {}
  private stamps: Readonly<Record<string, number>> = {}
  private fx = new Map<string, Effects>()
  private root = ''
  private lastActive = Date.now()
  private continuous = false
  private ambient: { platform: Platform; hasCode: boolean; home: string; sessionId: string } | null = null
  private missingCache: { board: unknown; key: string; missing: Record<Mode, ReadonlySet<string>> } | null = null
  private warming = false
  private readonly ticker: Ticker
  private readonly storeActions: StoreActions
  private readonly actions: Actions
  private down = false

  constructor(private readonly env: UiEnv) {
    this.storeActions = makeActions(env.host, env.store, async () => isoLocal(await env.host.now()))
    this.actions = this.makeActions()
    this.ticker = new Ticker(
      {
        every: (ms, fn) => {
          const t = setInterval(fn, ms)
          t.unref?.()
          return { cancel: () => clearInterval(t) }
        },
        blit: async () => {
          this.render()
          return {}
        },
        now: async () => Date.now(),
        invalidate: () => this.render(),
      },
      {
        continuous: () => this.continuous,
        oneShot: now => isAlive(this.fx.get(this.root) ?? NO_FX, now) || Object.values(this.stamps).some(at => now - at < STAMP_MS),
        signature: now => textSignature(this.fx.get(this.root) ?? NO_FX, this.stamps, now),
        lastActive: () => this.lastActive,
      },
    )
    this.ticker.setEnabled(env.motion)
  }

  private render(): void {
    if (!this.down) this.env.requestRender()
  }

  private touch(): void {
    this.lastActive = Date.now()
    void this.ticker.ensure()
  }

  /** The board changed (any source): effects start now, the file checks run again, the board is drawn once more. */
  onChange(c: Change): void {
    this.lastActive = Date.now()
    if (this.env.motion) {
      const root = this.env.store.current().root ?? ''
      this.fx.set(root, deriveEffects(this.fx.get(root) ?? NO_FX, c, this.lastActive))
    }
    this.warm()
    this.render()
    void this.ticker.ensure()
  }

  // ---------- what the buttons do ----------

  private makeActions(): Actions {
    const base = this.storeActions
    return {
      ...base,
      toggle: async (key, open) => {
        this.touch()
        this.expanded = { ...this.expanded, [key]: open }
        this.render()
      },
      toggleMany: async entries => {
        this.touch()
        this.expanded = { ...this.expanded, ...entries }
        this.render()
      },
      approveProposal: id => (this.touch(), base.approveProposal(id)),
      rejectProposal: id => (this.touch(), base.rejectProposal(id)),
      focusGoal: id => (this.touch(), base.focusGoal(id)),
      // The stamp goes up before the file is written and stays long enough to be seen.
      approveItem: async id => {
        if (this.stamps[id] !== undefined) return false
        const start = Date.now()
        this.lastActive = start
        this.stamps = { ...this.stamps, [id]: start }
        this.render()
        void this.ticker.ensure()
        const ok = await base.approveItem(id)
        const left = ok ? STAMP_MS - (Date.now() - start) : 0
        const drop = (): void => {
          const { [id]: _gone, ...rest } = this.stamps
          this.stamps = rest
          this.render()
        }
        if (left > 0) setTimeout(drop, left).unref?.()
        else drop()
        return ok
      },
    }
  }

  // ---------- facts about the machine ----------

  private fresh(): boolean {
    const cur = this.env.store.current()
    return this.ambient !== null && this.missingCache !== null && this.missingCache.board === cur.board && this.missingCache.key === JSON.stringify(this.expanded)
  }

  /** Asks the machine what the drawing reuses: platform, session, and which linked files are missing. Draws again when done. */
  private warm(): void {
    if (this.warming || this.down) return
    this.warming = true
    void (async () => {
      const { host, store } = this.env
      try {
        if (this.ambient === null) {
          const e = await detectEnv(host).catch(() => ({ platform: process.platform === 'darwin' ? ('darwin' as const) : ('linux' as const), hasCode: false }))
          this.ambient = { ...e, home: homedir(), sessionId: await host.sessionId() }
        }
        const cur = store.current()
        const expanded = this.expanded
        const key = JSON.stringify(expanded)
        const root = cur.root ?? ''
        const known = new Map<string, boolean>()
        const missingIn = async (mode: Mode): Promise<ReadonlySet<string>> => {
          const missing = new Set<string>()
          if (cur.board === null) return missing
          for (const l of shownLinks(cur.board, expanded, mode)) {
            if (l.type !== 'path') continue
            const abs = resolveTarget(l.target, root, this.ambient?.home ?? '')
            let there = known.get(abs)
            if (there === undefined) {
              there = await host.exists(abs).catch(() => true)
              known.set(abs, there)
            }
            if (!there) missing.add(abs)
          }
          return missing
        }
        this.missingCache = { board: cur.board, key, missing: { pane: await missingIn('pane'), 'band-full': await missingIn('band-full') } }
      } catch {
        // keep what there was; a later draw asks again
      } finally {
        this.warming = false
      }
      this.render()
    })()
  }

  // ---------- drawing ----------

  private vm(width: number, mode: Mode, specs: RasterSpec[]): ViewModel {
    if (!this.fresh()) this.warm()
    const cur = this.env.store.current()
    const amb = this.ambient ?? { platform: (process.platform === 'darwin' ? 'darwin' : 'linux') as Platform, hasCode: false, home: homedir(), sessionId: '' }
    const root = cur.root ?? ''
    this.root = root
    const now = Date.now()
    const counts = cur.board === null ? null : boardCounts(cur.board)
    this.continuous = counts !== null && (counts.running > 0 || counts.review > 0 || (cur.board?.proposals.length ?? 0) > 0 || this.stale)
    return {
      board: cur.board,
      error: cur.error,
      bytes: cur.bytes,
      root,
      home: amb.home,
      sessionId: amb.sessionId,
      stale: this.stale,
      expanded: this.expanded,
      missing: this.missingCache?.missing[mode] ?? new Set(),
      platform: amb.platform,
      hasCode: amb.hasCode,
      canvas: true,
      width,
      palette: paletteFor(this.appearance),
      mascot: this.env.mascot,
      motion: this.env.motion,
      now,
      calm: now - this.lastActive >= CALM_AFTER_MS,
      fx: this.fx.get(root) ?? NO_FX,
      stamps: this.stamps,
      collect: spec => void specs.push(spec),
    }
  }

  /** The whole board in `width` columns, as cells and button rectangles. `site` names where it is mounted (for the timer). */
  board(width: number, mode: Mode, site: string): Drawn {
    const specs: RasterSpec[] = []
    const tree = renderBoard(els as unknown as Els, this.vm(width, mode, specs), this.actions, mode) as unknown as Node
    if (specs.length === 0) this.ticker.unmounted(site)
    else this.ticker.mounted(site, specs)
    return draw(tree, width, paletteFor(this.appearance) as NonNullable<ReturnType<typeof paletteFor>>)
  }

  /** The one-line entry of a folded board. */
  entry(width: number, onOpen: () => void): Drawn {
    this.ticker.unmounted('band')
    this.ticker.unmounted('pane')
    const tree = renderEntry(els as unknown as Els, { board: this.env.store.current().board, stale: this.stale }, async () => onOpen()) as unknown as Node
    return draw(tree, width, paletteFor(this.appearance) as NonNullable<ReturnType<typeof paletteFor>>)
  }

  /** The canvases of `site` are no longer on screen. */
  unmount(site: string): void {
    this.ticker.unmounted(site)
  }

  /** A press at (x, y) of a drawing: runs the button there. */
  press(hits: readonly Hit[], x: number, y: number): boolean {
    const hit = hits.find(h => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h)
    if (hit === undefined) return false
    this.touch()
    void Promise.resolve()
      .then(() => hit.press({ surface: 'terminal' }))
      .catch(() => undefined)
    return true
  }

  dispose(): void {
    this.down = true
    this.ticker.setEnabled(false)
  }
}
