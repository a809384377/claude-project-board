import { DEF, type Palette } from '../../hooks/view/motion'
import { cellWidth } from './width'

/**
 * A small terminal renderer for the element set the board view draws with (Box, Text, Button, Raster): the
 * layout props of Ink's flexbox that board.tsx uses, text wrapping the way a terminal wraps it (at spaces, long words
 * cut), styled cells, and the screen rectangles of the buttons. It lets pi show exactly the tree the Claude Code plugin shows.
 */

// ---------- elements ----------

type Props = Record<string, any>
export type Node = { kind: 'box' | 'text' | 'button' | 'raster'; props: Props; kids: Array<Node | string> }

function norm(children: unknown): Array<Node | string> {
  if (children === null || children === undefined || children === false || children === true) return []
  if (Array.isArray(children)) return children.flatMap(norm)
  if (typeof children === 'number') return [String(children)]
  return [children as Node | string]
}
const make = (kind: Node['kind']) => (p: Props): Node => ({ kind, props: p, kids: norm(p.children) })

export const Box = make('box')
export const Text = make('text')
export const Button = make('button')
export const Raster = make('raster')
export const els = { Box, Text, Button, Raster }

/** The JSX factory of the compiled board view: a tag is one of the constructors above. */
export function h(tag: (p: Props) => Node, props: Props | null, ...children: unknown[]): Node {
  const p: Props = { ...(props ?? {}) }
  if (children.length > 0) p.children = children
  return tag(p)
}
export const Fragment = (p: Props): Node => Box({ flexDirection: 'column', children: p.children })

// ---------- styles and colours ----------

type Style = { color?: string; backgroundColor?: string; bold?: boolean; dim?: boolean; inverse?: boolean }
type Ch = { ch: string; cw: number; st: Style }

const ERROR = { dark: 0xff6b80, light: 0xab2b3f }

/** A colour name of the board view (a theme key or #rrggbb) as 0xRRGGBB; null for none. */
export function resolveColor(name: string | undefined, pal: Palette): number | null {
  if (name === undefined || name === '') return null
  if (name.startsWith('#')) return Number.parseInt(name.slice(1), 16)
  const dark = pal.base < 0x808080
  switch (name) {
    case 'success':
    case 'warning':
    case 'claude':
    case 'suggestion':
    case 'subtle':
    case 'inactive':
      return pal[name]
    case 'error':
      return dark ? ERROR.dark : ERROR.light
    case 'inverseText':
      return pal.base
    default:
      return null
  }
}

// ---------- the cell grid ----------

export type Cell = { ch: string; fg: number | null; bg: number | null; bold: boolean; dim: boolean; inverse: boolean }
const blank = (): Cell => ({ ch: ' ', fg: null, bg: null, bold: false, dim: false, inverse: false })

export class Grid {
  readonly rows: Cell[][]
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.rows = Array.from({ length: h }, () => Array.from({ length: w }, blank))
  }
  at(x: number, y: number): Cell | undefined {
    return this.rows[y]?.[x]
  }
}

/** A button's place on the screen, one rectangle per line it covers. */
export type Hit = { x: number; y: number; w: number; h: number; key: string; press: (p: { surface: string }) => unknown }

type Paint = { pal: Palette; hits: Hit[] }
type Laid = { w: number; h: number; paint(g: Grid, x: number, y: number, p: Paint, stretch?: number): void }

// ---------- text ----------

const NONE: Style = {}

function inline(n: Node | string, base: Style): Ch[] {
  if (typeof n === 'string') return Array.from(n, ch => ({ ch, cw: cellWidth(ch), st: base }))
  const st: Style = { ...base }
  const p = n.props
  if (p.color !== undefined) st.color = p.color
  if (p.backgroundColor !== undefined) st.backgroundColor = p.backgroundColor
  if (p.bold === true) st.bold = true
  if (p.dimColor === true) st.dim = true
  if (p.inverse === true) st.inverse = true
  return n.kids.flatMap(k => inline(k, st))
}

function buttonChars(n: Node): Ch[] {
  const p = n.props
  const base: Style = { ...(p.dimColor === true ? { dim: true } : {}) }
  if (p.plain === true) return n.kids.flatMap(k => inline(k, base))
  const label = typeof p.label === 'string' ? p.label : n.kids.map(k => (typeof k === 'string' ? k : textOf(k))).join('')
  const st: Style = { ...base, bold: true, ...(p.variant === 'primary' ? { color: 'suggestion' } : {}) }
  return inline(`[ ${label} ]`, st)
}

function textOf(n: Node): string {
  return n.kids.map(k => (typeof k === 'string' ? k : textOf(k))).join('')
}

function charsOf(n: Node): Ch[] {
  return n.kind === 'button' ? buttonChars(n) : inline(n, NONE)
}

/** The wrap mode of a text or a button holding texts: a truncating one wins. */
function wrapMode(n: Node): 'wrap' | 'truncate' {
  const own = n.props.wrap
  if (typeof own === 'string') return own.startsWith('truncate') ? 'truncate' : 'wrap'
  for (const k of n.kids) if (typeof k !== 'string' && typeof k.props.wrap === 'string' && k.props.wrap.startsWith('truncate')) return 'truncate'
  return 'wrap'
}

const widthOf = (l: readonly Ch[]): number => l.reduce((a, c) => a + c.cw, 0)

function logicalLines(chs: Ch[]): Ch[][] {
  const out: Ch[][] = [[]]
  for (const c of chs) {
    if (c.ch === '\n') out.push([])
    else (out[out.length - 1] as Ch[]).push(c)
  }
  return out
}

function truncated(line: Ch[], width: number): Ch[] {
  if (widthOf(line) <= width) return line
  const out: Ch[] = []
  let used = 0
  for (const c of line) {
    if (used + c.cw > width - 1) break
    out.push(c)
    used += c.cw
  }
  const last = line[Math.min(out.length, line.length - 1)] as Ch
  out.push({ ch: '…', cw: 1, st: last.st })
  return out
}

/** One paragraph cut into lines: at spaces; a word longer than the line is cut where the line ends. */
function wrapped(line: Ch[], width: number): Ch[][] {
  if (widthOf(line) <= width) return [line]
  const tokens: Ch[][] = []
  for (const c of line) {
    const last = tokens[tokens.length - 1]
    const space = c.ch === ' '
    if (last !== undefined && (last[0] as Ch).ch === ' ' === space) last.push(c)
    else tokens.push([c])
  }
  const out: Ch[][] = []
  let cur: Ch[] = []
  let curW = 0
  const trimEnd = (l: Ch[]): Ch[] => {
    let n = l.length
    while (n > 0 && (l[n - 1] as Ch).ch === ' ') n--
    return l.slice(0, n)
  }
  for (const tok of tokens) {
    const tw = widthOf(tok)
    const space = (tok[0] as Ch).ch === ' '
    if (curW + tw <= width) {
      cur.push(...tok)
      curW += tw
    } else if (space) {
      out.push(trimEnd(cur))
      cur = []
      curW = 0
    } else if (tw <= width) {
      out.push(trimEnd(cur))
      cur = [...tok]
      curW = tw
    } else {
      if (cur.length > 0) out.push(trimEnd(cur))
      cur = []
      curW = 0
      for (const c of tok) {
        if (curW + c.cw > width && cur.length > 0) {
          out.push(cur)
          cur = []
          curW = 0
        }
        cur.push(c)
        curW += c.cw
      }
    }
  }
  if (cur.length > 0) out.push(trimEnd(cur))
  return out.length === 0 ? [[]] : out
}

function layoutText(n: Node, W: number): Laid {
  const width = Math.max(1, W)
  const mode = wrapMode(n)
  const lines = logicalLines(charsOf(n)).flatMap(l => (mode === 'truncate' ? [truncated(l, width)] : wrapped(l, width)))
  const w = lines.reduce((a, l) => Math.max(a, widthOf(l)), 0)
  const isButton = n.kind === 'button'
  return {
    w,
    h: lines.length,
    paint(g, x, y, p) {
      lines.forEach((l, row) => {
        let cx = x
        for (const c of l) {
          const cell = g.at(cx, y + row)
          if (cell !== undefined) {
            cell.ch = c.ch
            cell.fg = resolveColor(c.st.color, p.pal) ?? null
            const bg = resolveColor(c.st.backgroundColor, p.pal)
            if (bg !== null) cell.bg = bg
            cell.bold = c.st.bold === true
            cell.dim = c.st.dim === true
            cell.inverse = c.st.inverse === true
            if (c.cw === 2) {
              const next = g.at(cx + 1, y + row)
              if (next !== undefined) {
                next.ch = ''
                if (bg !== null) next.bg = bg
              }
            }
          }
          cx += c.cw
        }
        if (isButton && typeof n.props.onPress === 'function') p.hits.push({ x, y: y + row, w: widthOf(l), h: 1, key: String(n.props.key ?? n.props.label ?? ''), press: n.props.onPress })
      })
    },
  }
}

// ---------- boxes ----------

const num = (...v: unknown[]): number => {
  for (const x of v) if (typeof x === 'number') return x
  return 0
}

type Edges = { l: number; r: number; t: number; b: number }
const padding = (p: Props): Edges => ({ l: num(p.paddingLeft, p.paddingX, p.padding), r: num(p.paddingRight, p.paddingX, p.padding), t: num(p.paddingTop, p.paddingY, p.padding), b: num(p.paddingBottom, p.paddingY, p.padding) })
const margin = (p: Props): Edges => ({ l: num(p.marginLeft, p.marginX, p.margin), r: num(p.marginRight, p.marginX, p.margin), t: num(p.marginTop, p.marginY, p.margin), b: num(p.marginBottom, p.marginY, p.margin) })

const hidden = (n: Node): boolean => n.kind === 'box' && n.props.display === 'none'
const absolute = (n: Node): boolean => n.kind === 'box' && n.props.position === 'absolute'
const flowKids = (n: Node): Node[] => n.kids.filter((k): k is Node => typeof k !== 'string' && !hidden(k) && !absolute(k))

const naturalMemo = new WeakMap<Node, number>()

/** The width a node takes when nothing limits it. */
function natural(n: Node): number {
  const known = naturalMemo.get(n)
  if (known !== undefined) return known
  let w: number
  if (n.kind === 'raster') w = num(n.props.columns)
  else if (n.kind === 'text' || n.kind === 'button') w = logicalLines(charsOf(n)).reduce((a, l) => Math.max(a, widthOf(l)), 0)
  else if (hidden(n)) w = 0
  else {
    const p = n.props
    const pad = padding(p)
    const m = margin(p)
    const b = p.borderStyle ? 2 : 0
    const kids = flowKids(n)
    const gap = num(p.columnGap, p.gap)
    const inner = p.flexDirection === 'row' ? kids.reduce((a, k) => a + natural(k), 0) + gap * Math.max(0, kids.length - 1) : kids.reduce((a, k) => Math.max(a, natural(k)), 0)
    w = inner + pad.l + pad.r + b + m.l + m.r
  }
  naturalMemo.set(n, w)
  return w
}

const shrinkOf = (n: Node): number => (n.kind === 'raster' ? 0 : typeof n.props.flexShrink === 'number' ? n.props.flexShrink : 1)
const growOf = (n: Node): number => (typeof n.props.flexGrow === 'number' ? n.props.flexGrow : 0)

function layout(n: Node, W: number): Laid {
  if (n.kind === 'raster') return layoutRaster(n)
  if (n.kind === 'text' || n.kind === 'button') return layoutText(n, W)
  return layoutBox(n, W)
}

/** Widths for a row's children: shrunk in proportion to their size when too wide, grown by flexGrow when there is room. */
function distribute(kids: Node[], avail: number, gap: number): number[] {
  const base = kids.map(natural)
  const total = base.reduce((a, b) => a + b, 0) + gap * Math.max(0, kids.length - 1)
  const out = [...base]
  if (total > avail) {
    let deficit = total - avail
    const weight = kids.map((k, i) => ((base[i] as number) > 3 ? shrinkOf(k) * (base[i] as number) : 0))
    const sum = weight.reduce((a, b) => a + b, 0)
    if (sum > 0) {
      const cuts = weight.map(wt => Math.floor((deficit * wt) / sum))
      let left = deficit - cuts.reduce((a, b) => a + b, 0)
      for (let i = 0; left > 0 && i < kids.length; i++) if ((weight[i] as number) > 0) (cuts[i] = (cuts[i] as number) + 1), left--
      deficit = 0
      cuts.forEach((c, i) => (out[i] = Math.max(1, (base[i] as number) - c)))
    }
  } else if (total < avail) {
    const grow = kids.map(growOf)
    const sum = grow.reduce((a, b) => a + b, 0)
    if (sum > 0) {
      const room = avail - total
      let given = 0
      grow.forEach((gr, i) => {
        const add = Math.floor((room * gr) / sum)
        out[i] = (out[i] as number) + add
        given += add
      })
      const first = grow.findIndex(gr => gr > 0)
      if (first >= 0) out[first] = (out[first] as number) + (room - given)
    }
  }
  return out
}

function layoutBox(n: Node, W: number): Laid {
  const p = n.props
  const pad = padding(p)
  const m = margin(p)
  const border = p.borderStyle ? 1 : 0
  const gapX = num(p.columnGap, p.gap)
  const gapY = num(p.rowGap, p.gap)
  const innerW = Math.max(1, W - m.l - m.r - 2 * border - pad.l - pad.r)
  const kids = flowKids(n)
  const row = p.flexDirection === 'row'
  type Placed = { laid: Laid; dx: number; dy: number; stretch: boolean }
  const placed: Placed[] = []
  let contentH = 0

  if (!row) {
    let y = 0
    kids.forEach((k, i) => {
      if (i > 0) y += gapY
      const laid = layout(k, innerW)
      placed.push({ laid, dx: 0, dy: y, stretch: false })
      y += laid.h
    })
    contentH = y
  } else if (p.flexWrap === 'wrap') {
    let x = 0
    let y = 0
    let lineH = 0
    kids.forEach(k => {
      const w = Math.min(natural(k), innerW)
      if (x > 0 && x + w > innerW) {
        y += lineH + gapY
        x = 0
        lineH = 0
      }
      const laid = layout(k, w)
      placed.push({ laid, dx: x, dy: y, stretch: false })
      x += w + gapX
      lineH = Math.max(lineH, laid.h)
    })
    contentH = kids.length === 0 ? 0 : y + lineH
  } else {
    const widths = distribute(kids, innerW, gapX)
    let x = 0
    let h = 0
    const laids = kids.map((k, i) => layout(k, widths[i] as number))
    laids.forEach((laid, i) => {
      placed.push({ laid, dx: x, dy: 0, stretch: true })
      x += (widths[i] as number) + gapX
      h = Math.max(h, laid.h)
    })
    contentH = h
  }

  const fixedH = typeof p.height === 'number' ? p.height : undefined
  const bodyH = fixedH ?? contentH
  const h = bodyH + pad.t + pad.b + 2 * border + m.t + m.b
  const boxW = Math.max(1, W - m.l - m.r)
  const bgName = typeof p.backgroundColor === 'string' ? p.backgroundColor : undefined
  const absKids = n.kids.filter((k): k is Node => typeof k !== 'string' && absolute(k) && !hidden(k))

  return {
    w: W,
    h,
    paint(g, x, y, pt, stretch) {
      const ox = x + m.l
      const oy = y + m.t
      const boxH = (stretch ?? h) - m.t - m.b
      const bg = resolveColor(bgName, pt.pal)
      if (bg !== null) for (let r = 0; r < boxH; r++) for (let c = 0; c < boxW; c++) { const cell = g.at(ox + c, oy + r); if (cell !== undefined) cell.bg = bg }
      if (border === 1) {
        const fg = resolveColor(typeof p.borderColor === 'string' ? p.borderColor : undefined, pt.pal)
        const set = (cx: number, cy: number, ch: string): void => {
          const cell = g.at(cx, cy)
          if (cell !== undefined) {
            cell.ch = ch
            cell.fg = fg
            cell.dim = fg === null
          }
        }
        for (let c = 1; c < boxW - 1; c++) { set(ox + c, oy, '─'); set(ox + c, oy + boxH - 1, '─') }
        for (let r = 1; r < boxH - 1; r++) { set(ox, oy + r, '│'); set(ox + boxW - 1, oy + r, '│') }
        set(ox, oy, '╭'); set(ox + boxW - 1, oy, '╮'); set(ox, oy + boxH - 1, '╰'); set(ox + boxW - 1, oy + boxH - 1, '╯')
      }
      const cx = ox + border + pad.l
      const cy = oy + border + pad.t
      const rowH = Math.max(0, boxH - 2 * border - pad.t - pad.b)
      placed.forEach(pl => pl.laid.paint(g, cx + pl.dx, cy + pl.dy, pt, pl.stretch ? Math.max(pl.laid.h, rowH === 0 ? pl.laid.h : Math.min(rowH, contentH)) : undefined))
      for (const a of absKids) {
        const al = layout(a, natural(a))
        const ax = typeof a.props.right === 'number' ? ox + boxW - al.w - a.props.right : ox + num(a.props.left)
        al.paint(g, ax, oy + num(a.props.top), pt)
      }
    },
  }
}

// ---------- canvases ----------

/** The cells of a Raster prop: base64 of little-endian u32 triplets (code point, foreground, background). */
export function decodeCells(b64: string): Array<[number, number, number]> {
  const bytes = Buffer.from(b64, 'base64')
  const out: Array<[number, number, number]> = []
  for (let i = 0; i + 11 < bytes.length; i += 12) out.push([bytes.readUInt32LE(i), bytes.readUInt32LE(i + 4), bytes.readUInt32LE(i + 8)])
  return out
}

function layoutRaster(n: Node): Laid {
  const cols = num(n.props.columns)
  const rows = num(n.props.rows)
  const cells = typeof n.props.cells === 'string' ? decodeCells(n.props.cells) : []
  return {
    w: cols,
    h: rows,
    paint(g, x, y) {
      cells.forEach(([cp, fg, bg], i) => {
        const cell = g.at(x + (i % cols), y + Math.floor(i / cols))
        if (cell === undefined) return
        cell.ch = cp === 0 ? ' ' : String.fromCodePoint(cp)
        cell.fg = fg === DEF ? null : fg
        if (bg !== DEF) cell.bg = bg
        cell.bold = false
        cell.dim = false
        cell.inverse = false
      })
    },
  }
}

// ---------- drawing ----------

export type Drawn = { grid: Grid; hits: Hit[] }

/** Lays the tree out in `width` columns and paints it. */
export function draw(root: Node, width: number, pal: Palette): Drawn {
  const laid = layout(root, width)
  const grid = new Grid(width, laid.h)
  const hits: Hit[] = []
  laid.paint(grid, 0, 0, { pal, hits })
  return { grid, hits }
}

// ---------- ANSI ----------

const sameStyle = (a: Cell, b: Cell): boolean => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.inverse === b.inverse

/** 0xRRGGBB as the nearest xterm-256 colour index. */
export function to256(c: number): number {
  const r = (c >> 16) & 255
  const g = (c >> 8) & 255
  const b = c & 255
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : 232 + Math.round(((r - 8) / 247) * 23)
  const q = (v: number): number => Math.round((v / 255) * 5)
  return 16 + 36 * q(r) + 6 * q(g) + q(b)
}

export function sgr(c: Cell, truecolor: boolean): string {
  const parts = ['0']
  if (c.bold) parts.push('1')
  if (c.dim) parts.push('2')
  if (c.inverse) parts.push('7')
  const col = (v: number, base: number): string => (truecolor ? `${base};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}` : `${base};5;${to256(v)}`)
  if (c.fg !== null) parts.push(col(c.fg, 38))
  if (c.bg !== null) parts.push(col(c.bg, 48))
  return `\x1b[${parts.join(';')}m`
}

/** One grid row as a string of exactly the grid's width in columns. */
export function rowToAnsi(row: readonly Cell[], truecolor: boolean): string {
  let out = ''
  let prev: Cell | null = null
  for (const c of row) {
    if (c.ch === '') continue
    if (prev === null || !sameStyle(prev, c)) out += sgr(c, truecolor)
    out += c.ch
    prev = c
  }
  return `${out}\x1b[0m`
}

export const toLines = (g: Grid, truecolor: boolean): string[] => g.rows.map(r => rowToAnsi(r, truecolor))
