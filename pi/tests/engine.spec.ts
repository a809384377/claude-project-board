import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseBoard } from '../../hooks/model/parse'
import { NO_FX } from '../../hooks/view/effects'
import { EMPTY_LOCAL } from '../../hooks/view/local'
import { paletteFor } from '../../hooks/view/motion'
import { compileBoard } from '../scripts/gen-board'
import * as G from '../gen/board.js'
import { Box, Button, draw, els, h, resolveColor, rowToAnsi, Text, to256, toLines } from '../ui/engine'
import { cellWidth } from '../ui/width'

const pal = paletteFor('dark') as NonNullable<ReturnType<typeof paletteFor>>
const plain = (lines: string[]): string[] => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))
const text = (n: ReturnType<typeof h>, w: number): string[] => plain(toLines(draw(n, w, pal).grid, true))

describe('engine', () => {
  test('text wraps at spaces and cuts a long word', () => {
    expect(text(h(Text, null, 'aa bb cc'), 5)).toEqual(['aa bb', 'cc   '])
    expect(text(h(Text, null, 'abcdefgh'), 5)).toEqual(['abcde', 'fgh  '])
  })

  test('truncate-end ends a long line with an ellipsis', () => {
    expect(text(h(Text, { wrap: 'truncate-end' }, 'abcdefghij'), 6)).toEqual(['abcde…'])
  })

  test('wide characters take two columns, and rows come out the width asked for', () => {
    expect(cellWidth('看板')).toBe(4)
    for (const l of text(h(Box, { borderStyle: 'round' }, h(Text, null, '看板 · 项目')), 20)) expect(cellWidth(l)).toBe(20)
  })

  test('a row puts its children side by side with a gap and lets grow fill the rest', () => {
    const t = h(Box, { flexDirection: 'row', columnGap: 1 }, h(Text, null, 'ab'), h(Box, { flexGrow: 1 }), h(Text, null, 'cd'))
    expect(text(t, 10)).toEqual(['ab      cd'])
  })

  test('a rounded border and padding', () => {
    expect(text(h(Box, { borderStyle: 'round', paddingX: 1 }, h(Text, null, 'hi')), 8)).toEqual(['╭──────╮', '│ hi   │', '╰──────╯'])
  })

  test('a button is drawn as [ label ] and its rectangle answers presses', () => {
    let n = 0
    const d = draw(h(Box, { flexDirection: 'row', columnGap: 1 }, h(Text, null, 'x'), h(Button, { label: '好', onPress: () => void n++ })), 20, pal)
    expect(plain(toLines(d.grid, true))[0]?.trimEnd()).toBe('x [ 好 ]')
    expect(d.hits).toHaveLength(1)
    expect(d.hits[0]).toMatchObject({ x: 2, y: 0, w: 6, h: 1 })
    d.hits[0]?.press({ surface: 'terminal' })
    expect(n).toBe(1)
  })

  test('colours: theme names and #hex, 256-colour quantizing, no colour codes for the default', () => {
    expect(resolveColor('#ff0000', pal)).toBe(0xff0000)
    expect(resolveColor('success', pal)).toBe(pal.success)
    expect(resolveColor(undefined, pal)).toBeNull()
    expect(to256(0x000000)).toBe(16)
    expect(to256(0xff0000)).toBe(196)
    const d = draw(h(Text, { color: '#00ff00' }, 'g'), 3, pal)
    expect(rowToAnsi(d.grid.rows[0] ?? [], true)).toContain('38;2;0;255;0')
    expect(rowToAnsi(d.grid.rows[0] ?? [], false)).toContain('38;5;46')
  })
})

function fixture() {
  const src = readFileSync(join(import.meta.dir, '..', '..', 'tests', 'fixture-board.ts'), 'utf8')
  const m = src.match(/const board: unknown =\n([\s\S]*?)\nexport|const board: unknown =\n([\s\S]*)$/)
  const json = eval('(' + (m?.[1] ?? m?.[2] ?? '').replace(/\s*export[\s\S]*$/, '') + ')')
  const r = parseBoard(JSON.stringify(json))
  if (!r.ok) throw new Error(r.error)
  return r.board
}

function vm(width: number, over: object = {}) {
  return {
    board: fixture(), error: null, bytes: 0, root: '/p', home: '/h', sessionId: 's', stale: false, expanded: {}, missing: new Set<string>(),
    platform: 'darwin' as const, hasCode: true, canvas: true, width, palette: pal, mascot: true, motion: false, now: 0, calm: true, fx: NO_FX,
    local: EMPTY_LOCAL, hover: false, collect: () => undefined, ...over,
  }
}
const actions = new Proxy({}, { get: () => async () => undefined }) as never

describe('the shared board view, drawn for pi', () => {
  test('the generated view is up to date with hooks/view/board.tsx', () => {
    const cur = readFileSync(join(import.meta.dir, '..', 'gen', 'board.js'), 'utf8')
    expect(cur).toBe(compileBoard())
  })

  for (const [mode, width] of [['pane', 60], ['pane', 40], ['band-full', 90]] as const) {
    test(`${mode} at ${width} columns: every row is exactly ${width} columns wide, and the buttons are found`, () => {
      const d = draw(G.renderBoard(els as never, vm(width) as never, actions, mode) as never, width, pal)
      for (const l of plain(toLines(d.grid, true))) expect(cellWidth(l)).toBe(width)
      expect(d.hits.length).toBeGreaterThan(5)
    })
  }

  test('the pane has the mascot, the chips and the review box', () => {
    const d = draw(G.renderBoard(els as never, vm(60) as never, actions, 'pane') as never, 60, pal)
    const t = plain(toLines(d.grid, true)).join('\n')
    expect(t).toContain('看板 · 记账小程序')
    expect(t).toContain('待你看')
    expect(t).toContain('[ 看过了 ]')
    expect(t).not.toContain('验收通过')
    expect(t).toMatch(/▐▛███▜▙▞/)
    expect(t).toMatch(/◆ 1 +待你/)
  })

  test('without hover every link keeps [ 复制 ] [ × ] on screen and has no VS Code; its name opens it', () => {
    const d = draw(G.renderBoard(els as never, vm(70) as never, actions, 'pane') as never, 70, pal)
    const t = plain(toLines(d.grid, true)).join('\n')
    expect(t).toMatch(/饼图\.html · 饼图预览 +\[ 复制 \] \[ × \]/)
    expect(t).not.toContain('VS Code')
    expect(d.hits.map(h => h.key)).toEqual(expect.arrayContaining(['todo-link:i-p3e2z8:0:open', 'todo-link:i-p3e2z8:0:copy', 'todo-link:i-p3e2z8:0:hide']))
  })

  test('with hover the link buttons wait in a hidden box, so pi (which has none) draws only the names', () => {
    const d = draw(G.renderBoard(els as never, vm(70, { hover: true }) as never, actions, 'pane') as never, 70, pal)
    const t = plain(toLines(d.grid, true)).join('\n')
    expect(t).toContain('饼图.html · 饼图预览')
    expect(t).not.toContain('[ × ]')
    expect(t).toContain('[ 复制命令 ]')
  })

  test('the band is framed in a rounded box', () => {
    const d = draw(G.renderBoard(els as never, vm(80) as never, actions, 'band-full') as never, 80, pal)
    const t = plain(toLines(d.grid, true))
    expect(t[0]?.startsWith('╭')).toBe(true)
    expect(t.at(-1)?.startsWith('╰')).toBe(true)
  })

  test('the folded entry is one line', () => {
    const d = draw(G.renderEntry(els as never, { board: fixture(), stale: false, local: EMPTY_LOCAL }, async () => undefined) as never, 80, pal)
    expect(d.grid.h).toBe(1)
    expect(d.hits).toHaveLength(1)
  })
})
