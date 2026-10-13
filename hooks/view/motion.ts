/**
 * Cell frames for the board's pixel canvases (Raster): status chips, progress bars, spinners and the
 * mascot. Every function maps its inputs (and a time) to cells; nothing here reads a clock or the engine.
 */

/** One cell of a Raster: [code point, foreground, background]; colours are 0xRRGGBB or DEF. */
export type Cell = [number, number, number]
/** The terminal's own default colour (bit 24 alone). */
export const DEF = 0x01000000

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** The `cells` prop of a Raster: base64 of little-endian u32 triplets. */
export function encode(cells: readonly Cell[]): string {
  const bytes: number[] = []
  for (const c of cells) for (const w of c) bytes.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63] as string
    out += B64[(n >> 12) & 63] as string
    out += b === undefined ? '=' : (B64[(n >> 6) & 63] as string)
    out += c === undefined ? '=' : (B64[n & 63] as string)
  }
  return out
}

const cp = (s: string): number => s.codePointAt(0) ?? 32

// ---------- colour ----------

export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  let out = 0
  for (const sh of [16, 8, 0]) {
    const x = (a >> sh) & 0xff
    const y = (b >> sh) & 0xff
    out |= Math.round(x + (y - x) * k) << sh
  }
  return out
}

/** A Raster paints each channel in 16 steps; a colour already on a step comes out unchanged, so Box backgrounds can match it exactly. */
export function snap16(c: number): number {
  let out = 0
  for (const sh of [16, 8, 0]) out |= Math.min(255, Math.round(((c >> sh) & 0xff) / 17) * 17) << sh
  return out
}

const luminance = (c: number): number => (0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff)) / 255
/** Dark ink on a light colour, white on a dark one. */
export const contrastFg = (bg: number): number => (luminance(bg) > 0.5 ? 0x111111 : 0xffffff)

export const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`

export type HueKey = 'claude' | 'warning' | 'success' | 'suggestion' | 'subtle' | 'inactive'
/** The colours of one theme that the canvas can know: the engine only says the theme's name. */
export type Palette = { name: string; base: number } & Record<HueKey, number>

const rgb = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b

// Taken from the program's own theme tables (Claude Code 2.1.296): not a public interface, recheck when the version changes.
const PALETTES: Record<string, Omit<Palette, 'name'>> = {
  dark: { base: 0x000000, claude: rgb(215, 119, 87), warning: rgb(255, 193, 7), success: rgb(78, 186, 101), suggestion: rgb(177, 185, 249), subtle: rgb(80, 80, 80), inactive: rgb(153, 153, 153) },
  light: { base: 0xffffff, claude: rgb(215, 119, 87), warning: rgb(150, 108, 30), success: rgb(44, 122, 57), suggestion: rgb(87, 105, 247), subtle: rgb(175, 175, 175), inactive: rgb(102, 102, 102) },
  'dark-daltonized': { base: 0x000000, claude: rgb(255, 153, 51), warning: rgb(255, 204, 0), success: rgb(51, 153, 255), suggestion: rgb(153, 204, 255), subtle: rgb(80, 80, 80), inactive: rgb(153, 153, 153) },
  'light-daltonized': { base: 0xffffff, claude: rgb(255, 153, 51), warning: rgb(255, 153, 0), success: rgb(0, 102, 153), suggestion: rgb(51, 102, 255), subtle: rgb(175, 175, 175), inactive: rgb(102, 102, 102) },
}

/** The palette for a theme name; null for `auto`, the ANSI themes and names this code does not know. */
export function paletteFor(theme: string | undefined): Palette | null {
  const p = theme === undefined ? undefined : PALETTES[theme]
  return p === undefined || theme === undefined ? null : { name: theme, ...p }
}

/** A hue pulled towards the theme's background by `amount` (1 = the hue itself), on a Raster step. */
export const tint = (p: Palette, key: HueKey, amount: number): number => snap16(mix(p.base, p[key], amount))

/** Brand colours for pictures that keep their look on any theme. */
const FALLBACK: Record<HueKey, number> = { claude: 0xd77757, warning: 0xe5b83a, success: 0x5bb974, suggestion: 0x8f9cf5, subtle: 0x565a63, inactive: 0x8b8f97 }
const hue = (p: Palette | null, key: HueKey): number => (p === null ? FALLBACK[key] : p[key])

/** The one status colour: "something is happening for you" (waiting on you, running). A fixed green per brightness, not the theme's `success`, which some themes make blue. */
export const GREEN_ON_DARK = 0x4eba65
export const GREEN_ON_LIGHT = 0x2c7a39
const isDark = (p: Palette): boolean => luminance(p.base) < 0.5
export const statusGreen = (p: Palette | null): number => (p === null ? FALLBACK.success : isDark(p) ? GREEN_ON_DARK : GREEN_ON_LIGHT)

/** Colour of the title area, which the mascot and chips sit on; DEF when the theme is not known. */
export const titleBg = (p: Palette | null): number => (p === null ? DEF : tint(p, 'claude', 0.14))

/** Timing inputs of a frame. Without `animated` every function returns its still pose. */
export type FrameOpts = { t?: number; animated?: boolean; calm?: boolean }

// ---------- status chips ----------

export type ChipKind = 'review' | 'running' | 'todo' | 'done'
export const CHIP_LABEL: Record<ChipKind, string> = { review: '待你', running: '在跑', todo: '待办', done: '完成' }
export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const CHIP_MAX = 999

/** Digits a chip shows: a count past three digits stays at 999. */
export const chipDigits = (n: number): string => String(Math.min(CHIP_MAX, Math.max(0, n)))
/** Cells across of a chip showing `digits` characters: space, glyph, space, digits, space. */
export const chipWidth = (digits: number): number => 4 + digits

export const PROGRESS_MS = 900
export const SPARK_MS = 650
export const CONFETTI_MS = 1500

export type ChipOpts = FrameOpts & { digits?: number }

/** Whether a chip with this count is lit: only "waiting for you" and "running", and only while there is something. */
export const chipLit = (kind: ChipKind, n: number): boolean => n > 0 && (kind === 'review' || kind === 'running')

/** Colours of a chip: green when lit, grey otherwise (to-do and done are always grey). Without a palette nothing is painted. */
function chipPaint(lit: boolean, p: Palette | null): { fg: number; bg: number } {
  if (p === null) return { fg: DEF, bg: DEF }
  if (!lit) return { fg: p.inactive, bg: tint(p, 'inactive', 0.25) }
  const bg = statusGreen(p)
  return { fg: contrastFg(bg), bg }
}

/** One chip: ` ◆ 2 `. Lit in green while it has a count, grey at zero; it never moves. */
export function chipCells(kind: ChipKind, n: number, p: Palette | null, o: ChipOpts = {}): Cell[] {
  const lit = chipLit(kind, n)
  const paint = chipPaint(lit, p)
  const digits = chipDigits(n).padEnd(o.digits ?? 0, ' ')
  const glyph = kind === 'review' ? '◆' : kind === 'running' ? (lit ? '●' : '·') : kind === 'todo' ? '○' : '✓'
  return [' ', glyph, ' ', ...digits, ' '].map((ch): Cell => [cp(ch), paint.fg, paint.bg])
}

// ---------- progress bar ----------

export const CELL_FULL = '▰'
export const CELL_EMPTY = '▱'

/**
 * Battery cells of a goal: with at most `cols` items every item is one cell; with more, the cells stand for shares of the
 * total. The last cell stays empty until everything is done, and any progress lights at least one cell.
 */
export function batteryFill(done: number, total: number, cols: number): { n: number; filled: number } {
  if (total <= 0) return { n: 0, filled: 0 }
  const d = Math.max(0, Math.min(total, done))
  if (total <= cols) return { n: total, filled: d }
  let filled = Math.round((d / total) * cols)
  if (d > 0) filled = Math.max(1, filled)
  if (d < total) filled = Math.min(cols - 1, filled)
  return { n: cols, filled }
}

/** Colour of a lit cell: close to body text. */
const fillInk = (p: Palette | null): number => (p === null ? DEF : isDark(p) ? 0xcccccc : 0x333333)

/** `n` cells drawn in a canvas `cols` wide (the rest blank, so the count beside it keeps its place); `spark` marks one lit cell with ✦. */
export function batteryCells(filled: number, n: number, cols: number, p: Palette | null, spark?: number): Cell[] {
  const out: Cell[] = []
  for (let i = 0; i < cols; i++) {
    if (i >= n) out.push([32, DEF, DEF])
    else if (i < filled) out.push([cp(CELL_FULL), fillInk(p), DEF])
    else out.push([cp(CELL_EMPTY), p === null ? DEF : p.inactive, DEF])
  }
  if (spark !== undefined && spark >= 0 && spark < n) out[spark] = [cp('✦'), p === null ? DEF : isDark(p) ? 0xffffff : 0x000000, DEF]
  return out
}

/** The bar of a goal whose done or total just changed: its cells light one by one towards the new count over 0.9 s (ease-out), then a ✦ flashes on the last lit cell for 0.65 s. */
export function progressCells(done: number, total: number, cols: number, anim: { from: number; start: number } | undefined, p: Palette | null, o: FrameOpts = {}): Cell[] {
  const { n, filled } = batteryFill(done, total, cols)
  const still = (): Cell[] => batteryCells(filled, n, cols, p)
  if (anim === undefined || o.animated !== true) return still()
  const since = (o.t ?? 0) - anim.start
  const from = Math.max(0, Math.min(n, Math.round(anim.from * n)))
  if (since < 0) return batteryCells(from, n, cols, p)
  if (since < PROGRESS_MS) {
    const e = since / PROGRESS_MS
    return batteryCells(Math.round(from + (filled - from) * (1 - Math.pow(1 - e, 3))), n, cols, p)
  }
  if (since < PROGRESS_MS + SPARK_MS && filled > 0) return batteryCells(filled, n, cols, p, filled - 1)
  return still()
}

// ---------- spinner ----------

/** A running item's mark: the braille spinner (10 frames a second for this session's report, 2 for an older one, faded), still a dot when not animated. */
export function spinCells(fresh: boolean, p: Palette | null, o: FrameOpts = {}): Cell[] {
  const t = o.t ?? 0
  const green = statusGreen(p)
  const color = fresh ? green : mix(green, hue(p, 'subtle'), 0.55)
  if (o.animated !== true) return [[cp('●'), color, DEF]]
  return [[cp(SPIN[Math.floor(t / (fresh ? 100 : 500)) % 10] as string), color, DEF]]
}

// ---------- the mascot ----------

export type MascotMode = 'cheer' | 'wave' | 'huh' | 'work' | 'sleep'
/** First that holds: cheering after a finish, waving when something waits for you, scratching when the board may be behind, working, sleeping. */
export function mascotMode(i: { cheering: boolean; waiting: boolean; stale: boolean; running: number }): MascotMode {
  if (i.cheering) return 'cheer'
  if (i.waiting) return 'wave'
  if (i.stale) return 'huh'
  if (i.running > 0) return 'work'
  return 'sleep'
}

// Claude Code's welcome mark, 18 x 6 pixels (9 x 3 cells of quadrant blocks); the eyes are the two holes in the second row.
//   ▐▛███▜▌
//  ▝▜█████▛▘
//    ▘▘ ▝▝
const CLAWD = ['...############...', '...##.######.##...', '.################.', '...############...', '....#.#....#.#....', '..................']
export const MASCOT_COLS = 9
/** How long the mascot holds a pose: it changes a few times a second at most, so it costs few redraws. */
export const MASCOT_POSE_MS = 700
export const MASCOT_ROWS = 3
const W = 18
const H = 6

/** Which figure the mascot is: Claude Code's crab, or pi's π (a bar with two legs). */
export type MascotKind = 'claude' | 'pi'

export type Pixels = Array<Array<number | null>>
export type Overlay = { col: number; row: number; ch: string; fg: number }

const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'

export function mascotPixels(mode: MascotMode, running: number, p: Palette | null, o: FrameOpts = {}, kind: MascotKind = 'claude'): { px: Pixels; over: Overlay[] } {
  if (kind === 'pi') return piPixels(mode, running, p, o)
  const t = o.t ?? 0
  const m = o.animated === true
  const body = hue(p, 'claude')
  const lid = mix(body, 0x000000, 0.35)
  const px: Pixels = CLAWD.map(row => [...row].map(ch => (ch === '#' ? body : null)))
  const set = (x: number, y: number, c: number | null): void => {
    if (x >= 0 && x < W && y >= 0 && y < H) (px[y] as Array<number | null>)[x] = c
  }
  const f2 = m ? Math.floor(t / MASCOT_POSE_MS) % 2 : 0
  const f3 = m ? Math.floor(t / MASCOT_POSE_MS) % 2 : 0
  // The arms live at (1..2, 2) and (15..16, 2); a pose clears them and puts them elsewhere.
  const arms = (left: Array<[number, number]>, right: Array<[number, number]>): void => {
    for (const x of [1, 2, 15, 16]) set(x, 2, null)
    for (const [x, y] of [...left, ...right]) set(x, y, body)
  }
  const over: Overlay[] = []
  const blink = m && mode !== 'sleep' && t % 3400 < 140
  if (mode === 'sleep' || blink) {
    set(5, 1, lid)
    set(12, 1, lid)
  }
  if (mode === 'huh') set(12, 1, lid)
  if (mode === 'work') {
    arms(f2 ? [[1, 3], [2, 3]] : [[1, 2], [2, 2]], f2 ? [[15, 2], [16, 2]] : [[15, 3], [16, 3]])
    const spots: Array<[number, number]> = [[17, 0], [0, 0]]
    for (let i = 0; i < Math.min(running, 2); i++) {
      const k = m ? Math.floor(t / MASCOT_POSE_MS) + i : 1
      const at = spots[i] as [number, number]
      if (k % 3 !== 0) set(at[0], at[1], k % 2 === 1 ? hue(p, 'warning') : mix(body, 0xffffff, 0.4))
    }
  } else if (mode === 'wave') {
    arms([[1, 2], [2, 2]], f3 ? [[15, 1], [16, 0]] : [[15, 1], [16, 1], [17, 0]])
  } else if (mode === 'huh') {
    arms(f2 ? [[2, 1], [1, 0]] : [[2, 1], [2, 0]], [[15, 2], [16, 2]])
    if (!m || Math.floor(t / MASCOT_POSE_MS) % 2 === 0) over.push({ col: 8, row: 0, ch: '?', fg: hue(p, 'suggestion') })
  } else if (mode === 'sleep') {
    arms([[1, 3], [2, 3]], [[15, 3], [16, 3]])
    over.push({ col: 8, row: 0, ch: 'z', fg: hue(p, 'inactive') })
  } else {
    arms([[2, 1], [1, 0]], [[15, 1], [16, 0]])
    if (f2 === 1) for (const x of [4, 6, 11, 13]) set(x, 4, null)
    // One spark to a cell, so no cell holds more than the body-free colour and the sky.
    const pal = [hue(p, 'warning'), hue(p, 'success'), hue(p, 'suggestion'), 0xf0948f]
    const sparks: Array<[number, number]> = [[0, 2], [17, 2], [0, 4], [17, 4], [8, 5]]
    sparks.forEach(([x, y], i) => {
      const k = m ? Math.floor(t / (MASCOT_POSE_MS / 2)) + i : i + 1
      if (k % 3 !== 0) set(x, y, pal[k % 4] as number)
    })
  }
  return { px, over }
}

// pi's mark: the letter π as a character, 18 x 6 pixels. A bar with an overhang is the head (the eyes are holes in it),
// and the two legs are π's two strokes, the right one with the foot curl of the letter.
//   ▗▄▄▄▄▄▄▄▖     row 0-1: hands and sparks above, the overhanging bar
//    ▐▛▘██▘▜▌     rows 2-3: the head under it
//     ██  ▐█▌     rows 4-5: legs
const PI = ['..................', '..##############..', '...##.######.##...', '...############...', '....##......##....', '....##......###...']

function piPixels(mode: MascotMode, running: number, p: Palette | null, o: FrameOpts): { px: Pixels; over: Overlay[] } {
  const t = o.t ?? 0
  const m = o.animated === true
  const body = hue(p, 'claude')
  const lid = mix(body, 0x000000, 0.35)
  const px: Pixels = PI.map(row => [...row].map(ch => (ch === '#' ? body : null)))
  const set = (x: number, y: number, c: number | null): void => {
    if (x >= 0 && x < W && y >= 0 && y < H) (px[y] as Array<number | null>)[x] = c
  }
  const step = m ? Math.floor(t / MASCOT_POSE_MS) : 0
  const f2 = step % 2
  // The arms rest at (1..2, 3) and (15..16, 3), at the head's sides; a pose clears them and puts them elsewhere.
  const arms = (left: Array<[number, number]>, right: Array<[number, number]>): void => {
    for (const x of [1, 2, 15, 16]) set(x, 3, null)
    for (const [x, y] of [...left, ...right]) set(x, y, body)
  }
  const over: Overlay[] = []
  const blink = m && mode !== 'sleep' && t % 3400 < 140
  if (mode === 'sleep' || blink) {
    set(5, 2, lid)
    set(12, 2, lid)
  }
  if (mode === 'huh') set(12, 2, lid)
  if (mode === 'work') {
    arms(f2 ? [[1, 2], [2, 2]] : [[1, 3], [2, 3]], f2 ? [[15, 3], [16, 3]] : [[15, 2], [16, 2]])
    const spots: Array<[number, number]> = [[17, 0], [0, 0]]
    for (let i = 0; i < Math.min(running, 2); i++) {
      const k = m ? step + i : 1
      const at = spots[i] as [number, number]
      if (k % 3 !== 0) set(at[0], at[1], k % 2 === 1 ? hue(p, 'warning') : mix(body, 0xffffff, 0.4))
    }
  } else if (mode === 'wave') {
    arms([[1, 3], [2, 3]], f2 ? [[15, 3], [16, 2], [17, 2]] : [[15, 3], [16, 2], [17, 1]])
  } else if (mode === 'huh') {
    arms(f2 ? [[2, 3], [1, 2]] : [[2, 3], [2, 2]], [[15, 3], [16, 3]])
    if (!m || step % 2 === 0) over.push({ col: 8, row: 0, ch: '?', fg: hue(p, 'suggestion') })
  } else if (mode === 'sleep') {
    over.push({ col: 8, row: 0, ch: 'z', fg: hue(p, 'inactive') })
  } else {
    arms([[2, 3], [1, 2], [0, 1]], [[15, 3], [16, 2], [17, 1]])
    if (f2 === 1) for (const x of [4, 5, 12, 13, 14]) set(x, 5, null)
    const pal = [hue(p, 'warning'), hue(p, 'success'), hue(p, 'suggestion'), 0xf0948f]
    // Two sparks in the free corners, a pair of pixels each: a cell takes one colour besides the sky.
    const sparks: Array<Array<[number, number]>> = [[[0, 4], [1, 5]], [[17, 4], [16, 5]]]
    sparks.forEach((pair, i) => {
      const k = m ? Math.floor(t / (MASCOT_POSE_MS / 2)) + i : i + 1
      if (k % 3 !== 0) for (const [x, y] of pair) set(x, y, pal[k % 4] as number)
    })
  }
  return { px, over }
}

/**
 * Pixels to cells: a cell holds a foreground and a background, so a 2 x 2 block of pixels keeps its two most
 * frequent colours (the sky counts as one). `dropped` counts pixels that had to be given up; designed poses lose none.
 */
export const quadCells = (px: Pixels, over: readonly Overlay[], bg: number): { cells: Cell[]; dropped: number } => quadGrid(px, MASCOT_COLS, MASCOT_ROWS, over, bg)

/** The same for a picture `cols` x `rows` cells (2 pixels to a cell each way). */
export function quadGrid(px: Pixels, cols: number, rows: number, over: readonly Overlay[], bg: number): { cells: Cell[]; dropped: number } {
  const cells: Cell[] = []
  let dropped = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const o = over.find(v => v.col === c && v.row === r)
      if (o !== undefined) {
        cells.push([cp(o.ch), o.fg, bg])
        continue
      }
      const q = [(px[2 * r] as Pixels[number])[2 * c] ?? null, (px[2 * r] as Pixels[number])[2 * c + 1] ?? null, (px[2 * r + 1] as Pixels[number])[2 * c] ?? null, (px[2 * r + 1] as Pixels[number])[2 * c + 1] ?? null]
      const tally = new Map<number | null, number>()
      for (const v of q) tally.set(v, (tally.get(v) ?? 0) + 1)
      const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
      const keep = ranked.slice(0, 2).map(e => e[0])
      dropped += ranked.slice(2).reduce((a, e) => a + e[1], 0)
      const colored = keep.filter((v): v is number => v !== null)
      if (colored.length === 0) {
        cells.push([32, bg, bg])
        continue
      }
      const fg = colored[0] as number
      const back = keep.length === 1 ? bg : keep[0] === null ? bg : keep[1] === null ? bg : (keep[1] as number)
      let mask = 0
      q.forEach((v, i) => {
        if (v === fg) mask |= 1 << i
      })
      cells.push([cp(QUAD[mask] as string), fg, back])
    }
  }
  return { cells, dropped }
}

// ---------- confetti ----------

/** A small deterministic generator, so a burst looks the same on every drawing and in every test. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const hashOf = (s: string): number => {
  let h = 2166136261
  for (const ch of s) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619)
  return h >>> 0
}

/**
 * Confetti falling through a strip `cols` x `rows` cells: coloured pixels drift down and sideways for 1.5 s.
 * `elapsed` is milliseconds since the burst began; the rest of the strip is `bg`.
 */
export function confettiCells(seed: number, cols: number, rows: number, elapsed: number, p: Palette | null, bg: number = DEF): { cells: Cell[]; dropped: number } {
  const w = cols * 2
  const h = rows * 2
  const px: Pixels = Array.from({ length: h }, () => Array<number | null>(w).fill(null))
  const next = rng(seed)
  const pal = [hue(p, 'warning'), hue(p, 'claude'), hue(p, 'success'), hue(p, 'suggestion'), 0xf0948f]
  const e = Math.max(0, elapsed) / 1000
  const n = Math.max(4, Math.floor(cols * 1.2))
  for (let i = 0; i < n; i++) {
    const x0 = next() * w
    const y0 = next() * (h + 2)
    const vy = 3 + next() * 5
    const vx = (next() - 0.5) * 4
    const color = pal[Math.floor(next() * pal.length)] as number
    const y = Math.floor((y0 + vy * e) % (h + 2)) - 2
    const x = Math.floor(x0 + vx * e)
    if (y >= 0 && y < h && x >= 0 && x < w) (px[y] as Array<number | null>)[x] = color
  }
  return quadGrid(px, cols, rows, [], bg)
}

export function mascotCells(mode: MascotMode, running: number, p: Palette | null, o: FrameOpts = {}, kind: MascotKind = 'claude'): { cells: Cell[]; dropped: number } {
  const { px, over } = mascotPixels(mode, running, p, o, kind)
  return quadCells(px, over, titleBg(p))
}

// ---------- what the drawing hands to the timer ----------

/**
 * A mounted Raster and the function that gives its cells at any time: what a timer repaints with `$.ui.blit`.
 * `drawn` is what the drawing put on screen (encoded), so the timer does not send it again.
 */
export type RasterSpec = { key: string; columns: number; rows: number; at(t: number, calm: boolean): Cell[]; drawn?: string }
