import { describe, expect, test } from 'claude-code/testing'
import { batteryFill, chipCells, MASCOT_POSE_MS, statusGreen, chipDigits, chipWidth, confettiCells, contrastFg, DEF, encode, hashOf, mascotCells, mascotMode, mascotPixels, mix, paletteFor, progressCells, quadCells, snap16, spinCells, tint, titleBg, type Cell, type MascotMode } from '../hooks/view/motion'

const MODES: MascotMode[] = ['cheer', 'wave', 'huh', 'work', 'sleep']
const glyphs = (cells: readonly Cell[]): string => cells.map(c => String.fromCodePoint(c[0])).join('')
/** The mascot as three lines of text. */
const art = (cells: readonly Cell[]): string[] => [0, 1, 2].map(r => glyphs(cells.slice(r * 9, r * 9 + 9)))

describe('encode', () => {
  test('one cell is three little-endian words in standard padded base64', () => {
    expect(encode([[0x2588, 0xff8800, DEF]])).toBe('iCUAAACI/wAAAAAB')
    expect(encode([])).toBe('')
  })
  test('two cells need padding', () => {
    expect(encode([[32, 0, 0], [32, 0, 0]])).toHaveLength(32)
  })
})

describe('palettes', () => {
  test('the four themes the engine ships with have one; auto, the ANSI themes and strangers do not', () => {
    for (const t of ['dark', 'light', 'dark-daltonized', 'light-daltonized']) expect(paletteFor(t)?.name).toBe(t)
    for (const t of ['auto', 'dark-ansi', 'light-ansi', 'nope', '', undefined]) expect(paletteFor(t)).toBeNull()
  })
  test('values come from the table of the design', () => {
    expect(paletteFor('dark')).toMatchObject({ claude: 0xd77757, warning: 0xffc107, success: 0x4eba65, suggestion: 0xb1b9f9, subtle: 0x505050, inactive: 0x999999, base: 0x000000 })
    expect(paletteFor('light')).toMatchObject({ warning: 0x966c1e, success: 0x2c7a39, base: 0xffffff })
    expect(paletteFor('dark-daltonized')).toMatchObject({ claude: 0xff9933, success: 0x3399ff })
    expect(paletteFor('light-daltonized')).toMatchObject({ warning: 0xff9900, success: 0x006699 })
  })
  test('a colour a Raster reproduces exactly is one the 16-step grid already holds', () => {
    expect(snap16(0xd77757)).toBe(0xdd7755)
    expect(snap16(snap16(0x123456))).toBe(snap16(0x123456))
    expect(snap16(0xffffff)).toBe(0xffffff)
  })
  test('the title area and tints stay on the grid; dark themes tint towards black, light ones towards white', () => {
    for (const t of ['dark', 'light', 'dark-daltonized', 'light-daltonized']) {
      const p = paletteFor(t)!
      expect(titleBg(p)).toBe(snap16(titleBg(p)))
      expect(tint(p, 'warning', 0.35)).toBe(snap16(tint(p, 'warning', 0.35)))
    }
    expect(titleBg(paletteFor('dark'))).toBeLessThan(0x330000)
    expect(titleBg(paletteFor('light'))).toBeGreaterThan(0xee0000)
    expect(titleBg(null)).toBe(DEF)
  })
  test('ink is dark on a light colour and white on a dark one', () => {
    expect(contrastFg(0xffc107)).toBe(0x111111)
    expect(contrastFg(0x222222)).toBe(0xffffff)
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080)
  })
})

describe('chips', () => {
  const dark = paletteFor('dark')
  test('a chip is space, glyph, space, digits, space: 5 to 7 cells', () => {
    expect(glyphs(chipCells('review', 2, dark))).toBe(' ◆ 2 ')
    expect(glyphs(chipCells('done', 46, dark))).toBe(' ✓ 46 ')
    expect(glyphs(chipCells('todo', 123, dark))).toBe(' ○ 123 ')
    expect(chipWidth(chipDigits(123).length)).toBe(7)
    expect(chipDigits(5000)).toBe('999')
  })
  test('only waiting-for-you and running light up, in the one green; at zero, and for to-do and done, they are the same grey', () => {
    const green = statusGreen(dark)
    expect(green).toBe(0x4eba65)
    for (const k of ['review', 'running'] as const) {
      const on = chipCells(k, 2, dark)
      expect(on.map(c => c[2])).toEqual(Array(on.length).fill(green))
      expect(on[1]![1]).toBe(contrastFg(green))
      const off = chipCells(k, 0, dark)
      expect(off[0]![2]).toBe(tint(dark!, 'inactive', 0.25))
      expect(off[1]![1]).toBe(dark!.inactive)
    }
    for (const k of ['todo', 'done'] as const) {
      for (const n of [0, 7]) expect(chipCells(k, n, dark)[0]).toEqual(chipCells('review', 0, dark)[0])
    }
    expect(glyphs(chipCells('running', 4, dark))).toBe(' ● 4 ')
    expect(glyphs(chipCells('running', 0, dark))).toBe(' · 0 ')
  })
  test('the green is fixed per brightness and ignores the theme\'s own success colour', () => {
    expect(statusGreen(paletteFor('dark-daltonized'))).toBe(0x4eba65)
    expect(chipCells('review', 1, paletteFor('dark-daltonized'))[0]![2]).toBe(0x4eba65)
    expect(statusGreen(paletteFor('light'))).toBe(0x2c7a39)
    expect(statusGreen(paletteFor('light-daltonized'))).toBe(0x2c7a39)
    expect(chipCells('running', 1, paletteFor('light-daltonized'))[0]![2]).toBe(0x2c7a39)
  })
  test('without a palette nothing is painted', () => {
    for (const c of chipCells('review', 2, null)) expect([c[1], c[2]]).toEqual([DEF, DEF])
  })
})

describe('bar and spinner', () => {
  test('battery cells: one cell per item up to the width, shares of the total beyond it; the last cell is empty until all is done', () => {
    expect(batteryFill(19, 20, 12)).toEqual({ n: 12, filled: 11 })
    expect(batteryFill(1, 4, 12)).toEqual({ n: 4, filled: 1 })
    expect(batteryFill(6, 7, 12)).toEqual({ n: 7, filled: 6 })
    expect(batteryFill(0, 1, 12)).toEqual({ n: 1, filled: 0 })
    expect(batteryFill(20, 20, 12)).toEqual({ n: 12, filled: 12 })
    expect(batteryFill(0, 0, 12)).toEqual({ n: 0, filled: 0 })
    expect(batteryFill(1, 100, 8)).toEqual({ n: 8, filled: 1 })
    expect(batteryFill(99, 100, 8)).toEqual({ n: 8, filled: 7 })
  })
  test('the bar is always as wide as its canvas, so the count beside it keeps its place', () => {
    const d = paletteFor('dark')
    expect(glyphs(progressCells(19, 20, 12, undefined, d))).toBe('▰▰▰▰▰▰▰▰▰▰▰▱')
    expect(glyphs(progressCells(1, 4, 12, undefined, d))).toBe('▰▱▱▱        ')
    expect(glyphs(progressCells(20, 20, 12, undefined, d))).toBe('▰▰▰▰▰▰▰▰▰▰▰▰')
    expect(glyphs(progressCells(0, 0, 12, undefined, d))).toBe(' '.repeat(12))
    for (const n of [1, 4, 12, 20]) expect(progressCells(0, n, 12, undefined, d)).toHaveLength(12)
  })
  test('battery colours are neutral: near-text ink for lit cells, the inactive grey for empty ones, terminal default without a theme', () => {
    const d = paletteFor('dark')!
    const l = paletteFor('light')!
    const c = progressCells(1, 2, 2, undefined, d)
    expect(c[0]![1]).toBe(0xcccccc)
    expect(c[1]![1]).toBe(d.inactive)
    expect(progressCells(1, 2, 2, undefined, l)[0]![1]).toBe(0x333333)
    for (const x of progressCells(1, 2, 2, undefined, null)) expect([x[1], x[2]]).toEqual([DEF, DEF])
  })
  test('a still spinner is a dot; an old report is fainter than a fresh one; a fresh one is the status green', () => {
    const p = paletteFor('dark')
    expect(glyphs(spinCells(true, p))).toBe('●')
    expect(spinCells(true, p)[0]![1]).toBe(0x4eba65)
    expect(spinCells(false, p)[0]![1]).not.toBe(spinCells(true, p)[0]![1])
  })
})

describe('mascot', () => {
  test('state priority: cheer, then wave, then scratch, then work, then sleep', () => {
    const on = { cheering: true, waiting: true, stale: true, running: 3 }
    expect(mascotMode(on)).toBe('cheer')
    expect(mascotMode({ ...on, cheering: false })).toBe('wave')
    expect(mascotMode({ ...on, cheering: false, waiting: false })).toBe('huh')
    expect(mascotMode({ ...on, cheering: false, waiting: false, stale: false })).toBe('work')
    expect(mascotMode({ cheering: false, waiting: false, stale: false, running: 0 })).toBe('sleep')
  })
  test('asleep it is Claude Code\'s mark with the arms hanging and a z in the corner; waving lifts the right arm', () => {
    expect(art(mascotCells('sleep', 0, null).cells)).toEqual([' ▐▛███▜▌z', '▗▟█████▙▖', '  ▘▘ ▝▝  '])
    expect(art(mascotCells('wave', 0, null).cells)[0]).toBe(' ▐▛███▜▙▞')
  })
  test('no designed pose, still or moving, asks a cell for more than two colours', () => {
    for (const p of [null, paletteFor('dark'), paletteFor('light-daltonized')]) {
      for (const mode of MODES) {
        for (let t = 0; t < 7000; t += 50) for (const running of [0, 1, 2, 5]) {
          const { px, over } = mascotPixels(mode, running, p, { t, animated: true })
          expect(quadCells(px, over, titleBg(p)).dropped).toBe(0)
        }
        const still = mascotPixels(mode, 2, p)
        expect(quadCells(still.px, still.over, titleBg(p)).dropped).toBe(0)
      }
    }
  })
  test("pi's figure: the same holds for the π, and it is a different picture from the crab", () => {
    for (const p of [null, paletteFor('dark'), paletteFor('light')]) {
      for (const mode of MODES) {
        for (let t = 0; t < 7000; t += 50) for (const running of [0, 1, 2, 5]) {
          const { px, over } = mascotPixels(mode, running, p, { t, animated: true }, 'pi')
          expect(quadCells(px, over, titleBg(p)).dropped).toBe(0)
        }
        const a = art(mascotCells(mode, 2, null, {}, 'pi').cells)
        expect(a).toHaveLength(3)
        expect(a).not.toEqual(art(mascotCells(mode, 2, null).cells))
      }
    }
    // The bar overhangs the head, and the π stands on two legs (the right one with a foot).
    expect(art(mascotCells('wave', 0, null, {}, 'pi').cells)).toEqual([' ▄▄▄▄▄▄▄▗', '▗▟▙███▟▙▘', '  █   █▖ '])
  })
  test('a block that does hold three colours keeps the two most frequent and counts the rest as lost', () => {
    const px = Array.from({ length: 6 }, () => Array<number | null>(18).fill(null))
    px[0]![0] = 0x111111
    px[0]![1] = 0x111111
    px[1]![0] = 0x222222
    px[1]![1] = 0x333333
    const r = quadCells(px, [], 0x000000)
    expect(r.dropped).toBe(1)
    expect(String.fromCodePoint(r.cells[0]![0])).toBe('▀')
  })
  test('every cell of every pose paints fg and bg, never more', () => {
    for (const mode of MODES) {
      const { cells } = mascotCells(mode, 2, paletteFor('dark'), { t: 1234, animated: true })
      expect(cells).toHaveLength(27)
      for (const c of cells) expect(c).toHaveLength(3)
    }
  })
})

// ---------- moving frames ----------

const same = (a: readonly Cell[], b: readonly Cell[]): boolean => encode(a) === encode(b)
const bgs = (cells: readonly Cell[]): number[] => cells.map(c => c[2])

describe('chips in motion', () => {
  const p = paletteFor('dark')
  const live = (t: number, extra = {}) => ({ t, animated: true, ...extra })
  test('chips are still: every colour and glyph is the same at every moment, with motion on', () => {
    for (const k of ['review', 'running', 'todo', 'done'] as const) {
      for (const n of [0, 3]) {
        for (const pal of [p, null]) {
          for (const t of [0, 100, 1200, 2400, 99999]) expect(same(chipCells(k, n, pal, live(t)), chipCells(k, n, pal))).toBe(true)
          expect(same(chipCells(k, n, pal, live(0, { calm: true })), chipCells(k, n, pal, live(1200)))).toBe(true)
        }
      }
    }
  })
})

describe('bar and spinner in motion', () => {
  test('the lit cells rise one by one with an ease-out over 0.9 s and a ✦ flashes on the last lit cell for 0.65 s after', () => {
    const anim = { from: 0.25, start: 0 }
    const d = paletteFor('dark')
    const fill = (t: number): number => glyphs(progressCells(6, 8, 8, anim, d, { t, animated: true })).replace(/[ ✦▱]/g, '').length
    expect(fill(0)).toBe(2)
    expect(fill(300)).toBeGreaterThan(2)
    expect(fill(1600)).toBe(6)
    expect(fill(300) - fill(0)).toBeGreaterThan(fill(899) - fill(600))
    expect(glyphs(progressCells(6, 8, 8, anim, d, { t: 1000, animated: true }))).toBe('▰▰▰▰▰✦▱▱')
    expect(glyphs(progressCells(6, 8, 8, anim, d, { t: 1600, animated: true }))).toBe('▰▰▰▰▰▰▱▱')
    expect(glyphs(progressCells(6, 8, 8, anim, d))).toBe('▰▰▰▰▰▰▱▱')
  })
  test('this session\'s spinner turns ten frames a second, an old report\'s two, fainter', () => {
    const p = paletteFor('dark')
    const g = (fresh: boolean, t: number): string => String.fromCodePoint(spinCells(fresh, p, { t, animated: true })[0]![0])
    expect([0, 100, 200].map(t => g(true, t))).toEqual(['⠋', '⠙', '⠹'])
    expect([0, 100, 400, 500, 1000].map(t => g(false, t))).toEqual(['⠋', '⠋', '⠋', '⠙', '⠹'])
  })
})

describe('mascot in motion', () => {
  const frames = (mode: MascotMode, running: number, ts: number[]): string[] => ts.map(t => art(mascotCells(mode, running, null, { t, animated: true }).cells).join('/'))
  test('asleep it never moves, never blinks', () => {
    const f = frames('sleep', 0, [0, 140, 3400, 3450, 9999])
    expect(new Set(f).size).toBe(1)
  })
  test('working swings the arms and throws as many sparks as there are running items, two at most', () => {
    expect(new Set(frames('work', 1, [0, MASCOT_POSE_MS])).size).toBe(2)
    // a pose holds: no change within one pose time
    expect(new Set(frames('work', 1, [0, 200, 400, 600])).size).toBe(1)
    const sparks = (n: number, t: number): number => mascotPixels('work', n, null, { t, animated: true }).px.flat().filter(c => c !== null && c !== 0xd77757).length
    expect(sparks(0, 500)).toBe(0)
    const best = (n: number): number => Math.max(...[1, 2, 3, 4].map(k => sparks(n, k * MASCOT_POSE_MS)))
    expect(best(1)).toBe(1)
    expect(best(2)).toBe(2)
    expect(best(9)).toBe(2)
  })
  test('waving swings the right arm; scratching blinks a ?; every moving pose blinks every 3.4 s for 0.14 s', () => {
    expect(new Set(frames('wave', 0, [0, MASCOT_POSE_MS])).size).toBe(2)
    const q = frames('huh', 0, [0, MASCOT_POSE_MS]).map(f => f.includes('?'))
    expect(q).toEqual([true, false])
    for (const m of ['wave', 'work', 'huh', 'cheer'] as const) {
      const [open, shut] = frames(m, 1, [1000, 3450])
      void open
      void shut
      const eyes = (t: number): number[] => mascotPixels(m, 1, null, { t, animated: true }).px[1]!.slice(4, 6) as number[]
      expect(eyes(3400)).not.toEqual(eyes(2000))
    }
  })
  test('cheering raises both arms, hops and sparkles', () => {
    expect(new Set(frames('cheer', 0, [0, 350, 700, 1050])).size).toBeGreaterThan(2)
  })
  test('still poses are fixed: no time, no change', () => {
    for (const m of ['cheer', 'wave', 'huh', 'work', 'sleep'] as const) {
      expect(art(mascotCells(m, 2, null, { t: 5000 }).cells)).toEqual(art(mascotCells(m, 2, null).cells))
    }
  })
})

describe('confetti', () => {
  test('is the same for the same seed and time, differs over time, stays inside the strip', () => {
    const seed = hashOf('g-can') + 5000
    const a = confettiCells(seed, 40, 1, 300, null)
    expect(encode(confettiCells(seed, 40, 1, 300, null).cells)).toBe(encode(a.cells))
    expect(encode(confettiCells(seed, 40, 1, 700, null).cells)).not.toBe(encode(a.cells))
    expect(a.cells).toHaveLength(40)
    const painted = (e: number): number => confettiCells(seed, 40, 1, e, null).cells.filter(c => c[0] !== 32).length
    expect(painted(300) + painted(500) + painted(900)).toBeGreaterThan(10)
  })
  test('a cell never holds more than the two colours the terminal gives it', () => {
    for (let e = 0; e < 1500; e += 100) for (const rows of [1, 2]) {
      const r = confettiCells(hashOf('x'), 30, rows, e, paletteFor('dark'))
      for (const c of r.cells) expect(c).toHaveLength(3)
    }
  })
})
