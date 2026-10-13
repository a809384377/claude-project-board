import { Grid, rowToAnsi, type Drawn, type Hit } from './engine'
import type { BoardUi } from './state'

/** pi-tui's mouse event, as far as the board reads it. */
export type MouseEvent = { type: string; button?: string; x: number; y: number; wheelDelta?: number }
export type MouseResult = { handled: true; render: true } | undefined

const HANDLED: MouseResult = { handled: true, render: true }

/** The cells of rows [off, off+n) of a drawing, pasted at (dx, dy) of `into`. */
function paste(into: Grid, from: Grid, dx: number, dy: number, off: number, n: number): void {
  for (let r = 0; r < n; r++) {
    const src = from.rows[off + r]
    const dst = into.rows[dy + r]
    if (src === undefined || dst === undefined) continue
    src.forEach((cell, c) => {
      if (dx + c < into.w) dst[dx + c] = { ...cell }
    })
  }
}

const step = (delta: number): number => Math.sign(delta) * Math.max(3, Math.abs(delta))

export type Sink = { truecolor: boolean; rows: () => number }

/**
 * The docked side pane: the board in an orange rounded frame as tall as the terminal, `[-]` at the top right to fold
 * it, the wheel to scroll what does not fit.
 */
export class PaneView {
  private offset = 0
  private hits: readonly Hit[] = []
  private width = 0
  private maxOffset = 0

  constructor(
    private readonly ui: BoardUi,
    private readonly sink: Sink,
    private readonly onFold: () => void,
  ) {}

  render(width: number): string[] {
    const rows = Math.max(4, this.sink.rows())
    const inner = Math.max(10, width - 2)
    const pal = this.ui.palette()
    const d: Drawn = this.ui.board(inner, 'pane', 'pane')
    const body = rows - 2
    this.width = width
    this.maxOffset = Math.max(0, d.grid.h - body)
    this.offset = Math.min(Math.max(0, this.offset), this.maxOffset)
    this.hits = d.hits
    const g = new Grid(width, rows)
    const fg = pal.claude
    const put = (x: number, y: number, ch: string, bold = false, dim = false): void => {
      const cell = g.at(x, y)
      if (cell === undefined) return
      cell.ch = ch
      cell.fg = fg
      cell.bold = bold
      cell.dim = dim
    }
    for (let x = 1; x < width - 1; x++) {
      put(x, 0, '─')
      put(x, rows - 1, '─')
    }
    for (let y = 1; y < rows - 1; y++) {
      put(0, y, '│')
      put(width - 1, y, '│')
    }
    put(0, 0, '╭')
    put(width - 1, 0, '╮')
    put(0, rows - 1, '╰')
    put(width - 1, rows - 1, '╯')
    '[-]'.split('').forEach((ch, i) => put(width - 5 + i, 0, ch, true))
    put(width - 6, 0, ' ')
    put(width - 2, 0, ' ')
    const hint = this.maxOffset === 0 ? '' : ` ${this.offset > 0 ? '↑' : ' '}${this.offset < this.maxOffset ? '↓' : ' '} 滚轮 `
    Array.from(hint).forEach((ch, i) => put(2 + i, rows - 1, ch))
    paste(g, d.grid, 1, 1, this.offset, body)
    return g.rows.map(r => rowToAnsi(r, this.sink.truecolor))
  }

  invalidate(): void {}

  handleMouse(e: MouseEvent): MouseResult {
    if (e.type === 'wheel') {
      this.offset = Math.min(Math.max(0, this.offset + step(e.wheelDelta ?? 0)), this.maxOffset)
      return HANDLED
    }
    if (e.type !== 'click' || (e.button !== undefined && e.button !== 'left')) return HANDLED
    // The fold button sits in the frame's top row, six columns from the right edge.
    if (e.y === 0) {
      if (e.x >= this.width - 5 && e.x < this.width - 2) this.onFold()
      return HANDLED
    }
    this.ui.press(this.hits, e.x - 1, e.y - 1 + this.offset)
    return HANDLED
  }
}

/** The board above the prompt: the full board capped to a few screens of rows, or the folded one-line entry. */
export class BandView {
  private offset = 0
  private hits: readonly Hit[] = []
  private maxOffset = 0

  constructor(
    private readonly ui: BoardUi,
    private readonly sink: Sink & { cap: () => number },
    private readonly onOpen: () => void,
  ) {}

  /** `folded`: the one-line entry. Otherwise the whole board, cut to the cap with the rest behind the wheel. */
  render(width: number, folded: boolean): string[] {
    const tc = this.sink.truecolor
    if (folded) {
      const d = this.ui.entry(width, this.onOpen)
      this.hits = d.hits
      this.offset = 0
      this.maxOffset = 0
      return d.grid.rows.map(r => rowToAnsi(r, tc))
    }
    const d = this.ui.board(width, 'band-full', 'band')
    const cap = Math.max(6, this.sink.cap())
    if (d.grid.h <= cap) {
      this.offset = 0
      this.maxOffset = 0
      this.hits = d.hits
        return d.grid.rows.map(r => rowToAnsi(r, tc))
    }
    const body = cap - 1
    this.maxOffset = d.grid.h - body
    this.offset = Math.min(Math.max(0, this.offset), this.maxOffset)
    this.hits = d.hits
    const g = new Grid(width, cap)
    paste(g, d.grid, 0, 0, this.offset, body)
    const text = ` ${this.offset > 0 ? '↑' : ' '}${this.offset < this.maxOffset ? '↓' : ' '} 还有 ${d.grid.h - body} 行 · 滚轮查看 `
    Array.from(text).forEach((ch, i) => {
      const cell = g.at(1 + i, cap - 1)
      if (cell !== undefined) {
        cell.ch = ch
        cell.dim = true
      }
    })
    return g.rows.map(r => rowToAnsi(r, tc))
  }

  invalidate(): void {}

  handleMouse(e: MouseEvent): MouseResult {
    if (e.type === 'wheel' && this.maxOffset > 0) {
      this.offset = Math.min(Math.max(0, this.offset + step(e.wheelDelta ?? 0)), this.maxOffset)
      return HANDLED
    }
    if (e.type !== 'click' || (e.button !== undefined && e.button !== 'left')) return undefined
    return this.ui.press(this.hits, e.x, e.y + this.offset) ? HANDLED : undefined
  }
}
