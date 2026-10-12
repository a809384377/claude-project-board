import { encode, type RasterSpec } from './motion'

/** What the ticker needs from the engine, as plain closures so tests can stand in for the clock and for blit. */
export interface TickerDeps {
  /** Calls `fn` every `ms` milliseconds until cancelled. */
  every(ms: number, fn: () => void): { cancel(): void }
  /** Repaints a mounted Raster; resolves `{ deny }` when nothing of this plugin's is mounted there. */
  blit(requestId: string, key: string, cells: string): Promise<{ deny?: string }>
  /** Milliseconds, the same clock the drawing's frames use. */
  now(): Promise<number>
  /** Draws the whole board again. */
  invalidate(): void
}

/** What the ticker asks the board about its state at a moment. */
export interface TickerView {
  /** Something runs on and on: a running item, something waiting for the user, a board that may be behind. */
  continuous(): boolean
  /** A one-off effect or a stamp is still under way at `now`. */
  oneShot(now: number): boolean
  /** Changes whenever text drawn with Box colours has to move on (ripples, stamps); a change redraws the board. */
  signature(now: number): string
  /** When the session started or the user or the board last did something. */
  lastActive(): number
}

export const FRAME_MS = 100
/** After this long without anything happening the continuous motion drops to {@link CALM_FRAME_MS}. */
export const CALM_AFTER_MS = 180_000
export const CALM_FRAME_MS = 500

type Site = { specs: RasterSpec[]; last: Map<string, string> }

/**
 * One timer for every moving thing on the board. It runs only while the board is on screen, motion is on
 * and something is moving, repaints the canvases that changed with blit, and redraws the board when text-borne
 * effects (ripple, stamp) move on. A refused blit means the canvas is gone: that site is forgotten until it draws again.
 */
export class Ticker {
  private sites = new Map<string, Site>()
  private timer: { cancel(): void } | null = null
  private period = 0
  private enabled = true
  private busy = false
  private lastSig = ''
  /** Frames sent and refused since the last {@link reset}: for tests and the report. */
  readonly stats = { ticks: 0, blits: 0, denied: 0 }

  constructor(
    private readonly deps: TickerDeps,
    private readonly view: TickerView,
  ) {}

  /** Motion on in the settings and not switched off by the system's reduce-motion; turning it off stops the timer. */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.stop()
  }

  /** The board drew `specs` at `requestId`: from now on the timer may repaint them (what they drew is not sent again). Starts the timer when something moves. */
  mounted(requestId: string, specs: readonly RasterSpec[]): void {
    const last = new Map<string, string>()
    for (const spec of specs) if (spec.drawn !== undefined) last.set(spec.key, spec.drawn)
    this.sites.set(requestId, { specs: [...specs], last })
    void this.ensure()
  }

  /** The board no longer draws canvases at `requestId` (a one-line entry, folded away). */
  unmounted(requestId: string): void {
    this.sites.delete(requestId)
    if (this.sites.size === 0) this.stop()
  }

  /** Starts or stops the timer to match the state; call after anything that may have started a movement. */
  async ensure(): Promise<void> {
    const now = await this.deps.now()
    if (!this.wanted(now)) {
      this.stop()
      return
    }
    const period = this.calm(now) ? CALM_FRAME_MS : FRAME_MS
    if (this.timer !== null && this.period === period) return
    this.stop()
    this.period = period
    this.timer = this.deps.every(period, () => void this.tick())
  }

  get running(): boolean {
    return this.timer !== null
  }

  get mountedSites(): string[] {
    return [...this.sites.keys()]
  }

  private calm(now: number): boolean {
    return now - this.view.lastActive() >= CALM_AFTER_MS
  }

  private wanted(now: number): boolean {
    return this.enabled && this.sites.size > 0 && (this.view.continuous() || this.view.oneShot(now))
  }

  private stop(): void {
    this.timer?.cancel()
    this.timer = null
    this.period = 0
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const t = await this.deps.now()
      this.stats.ticks++
      const calm = this.calm(t)
      const sent: Array<Promise<void>> = []
      for (const [requestId, site] of this.sites) {
        for (const spec of site.specs) {
          const cells = encode(spec.at(t, calm))
          if (site.last.get(spec.key) === cells) continue
          site.last.set(spec.key, cells)
          this.stats.blits++
          sent.push(
            this.deps.blit(requestId, spec.key, cells).then(
              r => {
                if (r.deny !== undefined) {
                  this.stats.denied++
                  this.sites.delete(requestId)
                }
              },
              () => {
                this.stats.denied++
                this.sites.delete(requestId)
              },
            ),
          )
        }
      }
      await Promise.all(sent)
      const sig = this.view.signature(t)
      if (sig !== this.lastSig) {
        this.lastSig = sig
        this.deps.invalidate()
      }
      if (!this.wanted(t) || this.sites.size === 0) this.stop()
      else if ((this.calm(t) ? CALM_FRAME_MS : FRAME_MS) !== this.period) await this.ensure()
    } finally {
      this.busy = false
    }
  }
}
