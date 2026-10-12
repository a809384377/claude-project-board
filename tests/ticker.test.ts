import { describe, expect, test } from 'claude-code/testing'
import { CALM_AFTER_MS, CALM_FRAME_MS, FRAME_MS, Ticker, type TickerDeps, type TickerView } from '../hooks/view/ticker'
import { encode, type RasterSpec } from '../hooks/view/motion'

/** A clock, timer and blit the test drives by hand. */
function rig(over: Partial<TickerView> = {}) {
  const state = {
    now: 1_000_000,
    timers: [] as Array<{ ms: number; fn: () => void; cancelled: boolean }>,
    blits: [] as Array<{ requestId: string; key: string; cells: string }>,
    invalidations: 0,
    deny: new Set<string>(),
    slow: null as Promise<void> | null,
    continuous: true,
    oneShot: false,
    signature: '',
    lastActive: 1_000_000,
  }
  const deps: TickerDeps = {
    every: (ms, fn) => {
      const t = { ms, fn, cancelled: false }
      state.timers.push(t)
      return { cancel: () => void (t.cancelled = true) }
    },
    blit: async (requestId, key, cells) => {
      state.blits.push({ requestId, key, cells })
      if (state.slow !== null) await state.slow
      return state.deny.has(requestId) ? { deny: 'no Raster of its own is mounted' } : {}
    },
    now: async () => state.now,
    invalidate: () => void state.invalidations++,
  }
  const view: TickerView = {
    continuous: () => state.continuous,
    oneShot: () => state.oneShot,
    signature: () => state.signature,
    lastActive: () => state.lastActive,
    ...over,
  }
  const ticker = new Ticker(deps, view)
  const live = () => state.timers.filter(t => !t.cancelled)
  /** Runs the live timer once and lets promises settle. */
  const tick = async (advance = FRAME_MS): Promise<void> => {
    state.now += advance
    live()[0]?.fn()
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return { ticker, state, live, tick }
}
/** A canvas whose cells change with time. */
const moving = (key: string): RasterSpec => ({ key, columns: 1, rows: 1, at: t => [[32 + (Math.floor(t / 100) % 5), 0, 0]] })
const still = (key: string): RasterSpec => ({ key, columns: 1, rows: 1, at: () => [[32, 0, 0]] })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('when the timer runs', () => {
  test('not before a canvas is mounted, and not while nothing moves', async () => {
    const r = rig()
    await r.ticker.ensure()
    expect(r.live()).toHaveLength(0)
    r.state.continuous = false
    r.ticker.mounted('board', [moving('a')])
    await settle()
    expect(r.live()).toHaveLength(0)
  })
  test('starts at ten frames a second once a canvas is mounted and something runs on', async () => {
    const r = rig()
    r.ticker.mounted('board', [moving('a')])
    await settle()
    expect(r.live()).toHaveLength(1)
    expect(r.live()[0]!.ms).toBe(100)
    expect(FRAME_MS).toBe(100)
  })
  test('a one-off effect alone starts it, and it stops when the effect is over', async () => {
    const r = rig()
    r.state.continuous = false
    r.state.oneShot = true
    r.ticker.mounted('board', [moving('a')])
    await settle()
    expect(r.live()).toHaveLength(1)
    await r.tick()
    expect(r.live()).toHaveLength(1)
    r.state.oneShot = false
    await r.tick()
    expect(r.live()).toHaveLength(0)
  })
  test('stops when the last thing stops moving; ensure() starts it again', async () => {
    const r = rig()
    r.ticker.mounted('board', [moving('a')])
    await settle()
    r.state.continuous = false
    await r.tick()
    expect(r.live()).toHaveLength(0)
    r.state.continuous = true
    await r.ticker.ensure()
    expect(r.live()).toHaveLength(1)
  })
  test('motion switched off (the setting, or the system\'s reduce-motion) never starts it, and stops a running one', async () => {
    const r = rig()
    r.ticker.setEnabled(false)
    r.ticker.mounted('board', [moving('a')])
    await settle()
    expect(r.live()).toHaveLength(0)
    expect(r.state.blits).toHaveLength(0)
    r.ticker.setEnabled(true)
    await r.ticker.ensure()
    expect(r.live()).toHaveLength(1)
    r.ticker.setEnabled(false)
    expect(r.live()).toHaveLength(0)
  })
  test('a canvas that is no longer on screen stops it', async () => {
    const r = rig()
    r.ticker.mounted('board', [moving('a')])
    r.ticker.mounted('above-prompt', [moving('b')])
    await settle()
    r.ticker.unmounted('board')
    expect(r.live()).toHaveLength(1)
    r.ticker.unmounted('above-prompt')
    expect(r.live()).toHaveLength(0)
  })
  test('a refused blit means the canvas is gone: that site is forgotten and the timer stops until it draws again', async () => {
    const r = rig()
    r.ticker.mounted('board', [moving('a')])
    await settle()
    r.state.deny.add('board')
    await r.tick()
    expect(r.ticker.mountedSites).toEqual([])
    expect(r.live()).toHaveLength(0)
    expect(r.ticker.stats.denied).toBe(1)
    r.state.deny.clear()
    r.ticker.mounted('board', [moving('a')])
    await settle()
    expect(r.live()).toHaveLength(1)
  })
  test('a refusal at one site does not drop the other', async () => {
    const r = rig()
    r.ticker.mounted('board', [moving('a')])
    r.ticker.mounted('above-prompt', [moving('b')])
    await settle()
    r.state.deny.add('board')
    await r.tick()
    expect(r.ticker.mountedSites).toEqual(['above-prompt'])
    expect(r.live()).toHaveLength(1)
  })
})

describe('the pace', () => {
  test('three minutes without anything happening drops it to two frames a second; any activity brings ten back', async () => {
    const r = rig()
    r.state.lastActive = r.state.now
    r.ticker.mounted('board', [moving('a')])
    await settle()
    expect(r.live()[0]!.ms).toBe(FRAME_MS)
    await r.tick(CALM_AFTER_MS - FRAME_MS * 2)
    expect(r.live()[0]!.ms).toBe(FRAME_MS)
    await r.tick(FRAME_MS * 2)
    expect(r.live()).toHaveLength(1)
    expect(r.live()[0]!.ms).toBe(CALM_FRAME_MS)
    expect(CALM_FRAME_MS).toBe(500)
    r.state.lastActive = r.state.now
    await r.tick(500)
    expect(r.live()).toHaveLength(1)
    expect(r.live()[0]!.ms).toBe(FRAME_MS)
  })
  test('a session nobody touched since it started is calm after three minutes too', async () => {
    const r = rig()
    r.ticker.mounted('board', [moving('a')])
    await settle()
    expect(r.live()[0]!.ms).toBe(FRAME_MS)
    await r.tick(CALM_AFTER_MS)
    expect(r.live()[0]!.ms).toBe(CALM_FRAME_MS)
  })
  test('the canvases are asked for calm frames once calm', async () => {
    const seen: boolean[] = []
    const r = rig()
    r.state.lastActive = r.state.now - CALM_AFTER_MS - 1
    r.ticker.mounted('board', [{ key: 'a', columns: 1, rows: 1, at: (_t, calm) => (seen.push(calm), [[32, 0, 0]]) }])
    await settle()
    await r.tick(500)
    expect(seen.at(-1)).toBe(true)
  })
})

describe('what is sent', () => {
  test('only canvases whose cells changed since the last frame are blitted', async () => {
    const r = rig()
    r.ticker.mounted('board', [moving('a'), still('b')])
    await settle()
    await r.tick()
    expect(r.state.blits.map(b => b.key).sort()).toEqual(['a', 'b'])
    r.state.blits.length = 0
    await r.tick(100)
    expect(r.state.blits.map(b => b.key)).toEqual(['a'])
    r.state.blits.length = 0
    await r.tick(5)
    expect(r.state.blits).toEqual([])
  })
  test('each site gets its own request id, and a new drawing resends everything once', async () => {
    const r = rig()
    r.ticker.mounted('board', [still('a')])
    r.ticker.mounted('above-prompt', [still('a')])
    await settle()
    await r.tick()
    expect(r.state.blits.map(b => b.requestId).sort()).toEqual(['above-prompt', 'board'])
    r.state.blits.length = 0
    r.ticker.mounted('board', [still('a')])
    await settle()
    await r.tick()
    expect(r.state.blits.map(b => b.requestId)).toEqual(['board'])
  })
  test('what a drawing put on screen is not sent again; only what has moved on since', async () => {
    const r = rig()
    const at = (t: number): Array<[number, number, number]> => [[32 + (Math.floor(t / 100) % 5), 0, 0]]
    const cellsAt = (t: number): string => encode(at(t))
    const same: RasterSpec = { key: 'same', columns: 1, rows: 1, at: () => [[32, 0, 0]], drawn: encode([[32, 0, 0]]) }
    const later: RasterSpec = { key: 'later', columns: 1, rows: 1, at, drawn: cellsAt(0) }
    r.ticker.mounted('board', [same, later])
    await settle()
    await r.tick()
    expect(r.state.blits.map(b => b.key)).toEqual(['later'])
  })
  test('the cells go out base64-encoded as the Raster takes them', async () => {
    const r = rig()
    r.ticker.mounted('board', [{ key: 'a', columns: 1, rows: 1, at: () => [[0x2588, 0xff8800, 0x01000000]] }])
    await settle()
    await r.tick()
    expect(r.state.blits[0]!.cells).toBe('iCUAAACI/wAAAAAB')
  })
  test('a tick that finds the previous one still waiting for blit does nothing', async () => {
    const r = rig()
    let release = (): void => undefined
    r.state.slow = new Promise<void>(res => (release = res))
    r.ticker.mounted('board', [moving('a')])
    await settle()
    await r.tick()
    expect(r.ticker.stats.ticks).toBe(1)
    await r.tick(100)
    await r.tick(100)
    expect(r.ticker.stats.ticks).toBe(1)
    release()
    await settle()
    await r.tick(100)
    expect(r.ticker.stats.ticks).toBe(2)
  })
})

describe('redrawing the text-borne effects', () => {
  test('the board is drawn again whenever the signature moves, once per change', async () => {
    const r = rig()
    r.ticker.mounted('board', [still('a')])
    await settle()
    await r.tick()
    expect(r.state.invalidations).toBe(0)
    r.state.signature = 'r:10'
    await r.tick()
    expect(r.state.invalidations).toBe(1)
    await r.tick()
    expect(r.state.invalidations).toBe(1)
    r.state.signature = 'r:9'
    await r.tick()
    expect(r.state.invalidations).toBe(2)
  })
  test('the redraw that clears the last effect comes before the timer stops', async () => {
    const r = rig()
    r.state.continuous = false
    r.state.oneShot = true
    r.ticker.mounted('board', [still('a')])
    await settle()
    r.state.signature = 'r:1'
    await r.tick()
    r.state.signature = 'r:0'
    r.state.oneShot = false
    await r.tick()
    expect(r.state.invalidations).toBe(2)
    expect(r.live()).toHaveLength(0)
  })
})
