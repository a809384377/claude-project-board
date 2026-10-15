import type { Elements, RenderElement } from 'claude-code'

import type { Host } from '../host'
import { goalShortName, goalState, STEP_ICON, stepShortName } from '../model/derive'
import type { ApplyResult, OpCtx } from '../model/ops'
import { NEWER_SCHEMA_TEXT } from '../model/parse'
import { approve, propose, reject } from '../model/propose'
import type { Board, Goal, Item, ItemStatus, Link, Step } from '../model/types'
import type { BoardStore } from '../store'
import {
  ATTENTION_LIMIT,
  boardCounts,
  fractionOf,
  goalLinksInline,
  itemOpen,
  LINKS_INLINE,
  linksOpen,
  looseItems,
  calmGoal,
  goalOpen,
  partitionGoals,
  reviewItems,
  SHOW_ORDER,
  showsCount,
  lit,
  unitOpen,
  unitsOf,
  unitState,
  type Counts,
  type Mode,
  type Unit,
} from './derive'
import { rippleStep, type Effects } from './effects'
import { hiddenLinks, isWaiting, type LocalView } from './local'
import { clip, describeProposal, entryText, STATUS_ICON } from './text'
export { describeProposal, entryText } from './text'
import { linkActions, pressLink, resolveTarget, type LinkAction, type Platform } from './links'
import {
  CHIP_LABEL,
  CONFETTI_MS,
  confettiCells,
  hashOf,
  mix,
  progressCells,
  batteryFill,
  CELL_EMPTY,
  CELL_FULL,
  chipCells,
  chipLit,
  statusGreen,
  chipDigits,
  chipWidth,
  DEF,
  encode,
  hex,
  MASCOT_COLS,
  MASCOT_ROWS,
  mascotCells,
  type MascotKind,
  mascotMode,
  spinCells,
  tint,
  titleBg,
  type Cell,
  type ChipKind,
  type FrameOpts,
  type Palette,
  type RasterSpec,
} from './motion'

export { ATTENTION_LIMIT, LINKS_INLINE, openItems, shownLinks, type Mode } from './derive'

/** Raster only exists on the terminal surface; elsewhere the text version is drawn. */
export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & { Raster?: Elements['terminal']['Raster'] }

export interface ViewModel {
  board: Board | null
  /** Why the file cannot be read; null when it can (or there is no file). */
  error: string | null
  bytes: number
  root: string
  /** The user's home directory; '' when unknown. */
  home: string
  sessionId: string
  /** The last main-session turn left the board behind. */
  stale: boolean
  /** Open/closed choices the user made, by goal id, step id, item id or a key like `done:<id>` / `fold:paused`. */
  expanded: Record<string, boolean>
  /** Absolute paths known not to exist. */
  missing: ReadonlySet<string>
  platform: Platform
  hasCode: boolean
  /** The surface can draw pixel canvases (the terminal); elsewhere the text version is drawn. */
  canvas: boolean
  /** Columns the drawing has to fit. */
  width: number
  /** The theme's colours; null when the theme's name does not give them away. */
  palette: Palette | null
  /** The mascot is switched on. */
  mascot: boolean
  /** Which figure it is; Claude Code's crab when absent. */
  mascotKind?: MascotKind
  /** Frames move with `now`; false draws the still frame of everything. */
  motion: boolean
  /** The time this drawing is for, in milliseconds; 0 for the still frame. */
  now: number
  /** Nothing has happened for a while: breathing holds still. */
  calm: boolean
  /** One-off effects under way. */
  fx: Effects
  /** What this machine's user looked at or hid; never part of the board file. */
  local: LocalView
  /** The surface reveals boxes under the pointer (the terminal); elsewhere every button is drawn all the time. */
  hover: boolean
  /** Called with every Raster the drawing mounts, so a timer can repaint it. */
  collect: (spec: RasterSpec) => void
}

/** What the buttons do. Every method settles after the press is handled; none throws. */
export interface Actions {
  toggle(key: string, open: boolean): Promise<void>
  /** Several open/closed choices at once. */
  toggleMany(entries: Record<string, boolean>): Promise<void>
  /** The user looked at this hand-in of a review item. Kept on this machine only, like the two below. */
  markSeen(itemId: string): Promise<void>
  /** Hides one link under its goal, step or item. */
  hideLink(ownerId: string, target: string): Promise<void>
  unhideLink(ownerId: string, target: string): Promise<void>
  approveProposal(proposalId: string): Promise<void>
  rejectProposal(proposalId: string): Promise<void>
  focusGoal(goalId: string): Promise<void>
  link(action: LinkAction, surface: string): Promise<void>
}
/** The actions that write the board file; the rest only change what this machine shows. */
export type StoreActions = Omit<Actions, 'toggle' | 'toggleMany' | 'markSeen' | 'hideLink' | 'unhideLink'>

export const ARCHIVE_WARN_BYTES = 2 * 1024 * 1024
const NOTE_LIMIT = 400
/** Rows of detail one drawing may carry: a huge board is cut here so the tree stays small enough to draw. */
export const ITEM_BUDGET = 50
export const GOAL_LIMIT = 40
/** A running item another session reported this long ago reads as possibly stopped. */
export const STALE_RUN_MS = 12 * 3600_000
/** Characters of the waiting-for text in an item row; the whole text is in the details. */
const WAIT_TAG = 12
const BAR_COLS = { pane: 12, 'band-full': 8 } as const

type Budget = { left: number }
type Ctx = { els: Els; vm: ViewModel; actions: Actions; mode: Mode; budget: Budget }

// ---------- pure helpers (also used by register.ts) ----------

const isMine = (it: Item, vm: ViewModel): boolean => it.session === vm.sessionId && it.session !== ''

/** The status green as a Text colour: the fixed green when the theme's colours are known, else the theme's own `success`. */
const greenText = (vm: Pick<ViewModel, 'palette'>): string => (vm.palette === null ? 'success' : hex(statusGreen(vm.palette)))

function iconColor(it: Item, vm: ViewModel): { color?: string; dim?: boolean } {
  switch (it.status) {
    case 'running':
      return isMine(it, vm) ? { color: greenText(vm) } : { color: greenText(vm), dim: true }
    case 'review':
      return { color: greenText(vm) }
    default:
      return { dim: true }
  }
}

/** "07-10 21:30" out of an ISO timestamp; the raw text when it is not one. */
function shortTime(iso: string): string {
  const m = /^\d{4}-(\d\d-\d\d)T(\d\d:\d\d)/.exec(iso)
  return m ? `${m[1]} ${m[2]}` : iso
}

/** Milliseconds from an ISO timestamp to `now`; null without a usable time (no timestamp, or the still frame's 0). */
function ageOf(iso: string, now: number): number | null {
  const t = Date.parse(iso)
  return iso === '' || now === 0 || Number.isNaN(t) ? null : now - t
}

/** "2 小时前"; '' without a usable time or for a time ahead of `now`. */
function relTime(iso: string, now: number): string {
  const age = ageOf(iso, now)
  if (age === null || age < 0) return ''
  const min = Math.floor(age / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}

function mileText(b: Board): string {
  if (!b.milestones.enabled) return ''
  const now = b.milestones.items.filter(m => m.status === '进行中')
  const last = now[now.length - 1]
  if (last === undefined) return ''
  return `阶段：${clip(last.title, 60)}${now.length > 1 ? `（另有 ${now.length - 1} 个进行中）` : ''}`
}

// ---------- drawing ----------

/** The one-line entry; pressing it does what /board does when the board is not on screen. */
export function renderEntry(els: Els, vm: Pick<ViewModel, 'board' | 'stale' | 'local'>, onOpen: () => Promise<void>): RenderElement {
  const { Text, Button } = els
  return (
    <Button key="open-board" plain onPress={onOpen}>
      <Text wrap="truncate-end" color={vm.stale ? 'warning' : undefined}>{entryText(vm)}</Text>
    </Button>
  )
}

export function renderNotice(els: Els, text: string): RenderElement {
  const { Text } = els
  return <Text dimColor>{text}</Text>
}

export function renderBoard(els: Els, vm: ViewModel, actions: Actions, mode: Mode): RenderElement {
  const { Box, Text } = els
  const b = vm.board
  if (b === null) {
    return (
      <Box flexDirection="column">
        <Text color="error">{vm.error ?? '当前项目没有看板'}</Text>
        {vm.error !== null && !vm.error.includes(NEWER_SCHEMA_TEXT) && <Text dimColor>未改动任何内容；修复文件后会自动恢复</Text>}
      </Box>
    )
  }
  const c: Ctx = { els, vm, actions, mode, budget: { left: ITEM_BUDGET } }
  const parts = partitionGoals(b, new Set(b.goals.filter(g => confettiStart(vm, g.id) !== undefined).map(g => g.id)), vm.local)
  const total = b.goals.length
  const body = (
    <Box flexDirection="column">
      {titleArea(c, b)}
      {mode === 'pane' && b.focus.mandate !== '' && <Text dimColor>{`授权：${clip(b.focus.mandate, 200)}`}</Text>}
      {reviewItems(b, vm.local).length > 0 && attention(c, b)}
      {b.proposals.length > 0 && cards(c, b)}
      {total === 0 && <Text dimColor>还没有目标</Text>}
      {parts.active.slice(0, GOAL_LIMIT).map(g => goalBlock(c, g, false))}
      {parts.active.length > GOAL_LIMIT && <Text dimColor>{`… 另有 ${parts.active.length - GOAL_LIMIT} 个目标未显示`}</Text>}
      {parts.paused.length > 0 && foldOf(c, 'paused', '⏸ 暂停', parts.paused)}
      {parts.finished.length > 0 && foldOf(c, 'done', '✓ 已完成', parts.finished)}
    </Box>
  )
  if (mode === 'pane') return body
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
      {body}
    </Box>
  )
}

/** When the confetti over this goal started, while it is still falling; undefined otherwise (or with motion off). */
function confettiStart(vm: ViewModel, id: string): number | undefined {
  const start = vm.fx.confetti[id]
  return start !== undefined && vm.motion && vm.now - start < CONFETTI_MS ? start : undefined
}

/** A Raster the timer can repaint; null where the surface has none. */
function canvas(c: Ctx, key: string, columns: number, rows: number, at: (o: FrameOpts) => Cell[]): RenderElement | null {
  const R = c.els.Raster
  if (!c.vm.canvas || R === undefined) return null
  const frame = (t: number, calm: boolean): Cell[] => at({ t, animated: c.vm.motion, calm })
  const cells = encode(frame(c.vm.now, c.vm.calm))
  c.vm.collect({ key, columns, rows, at: frame, drawn: cells })
  return <R key={key} columns={columns} rows={rows} cells={cells} />
}

/** The row colour of a ripple at this moment: the hue pulled towards the background in ten steps; undefined once over or when motion is off. */
function rippleBg(c: Ctx, id: string, accent: 'green' | 'inactive'): string | undefined {
  const start = c.vm.fx.ripples[id]
  if (start === undefined || !c.vm.motion) return undefined
  const step = rippleStep(start, c.vm.now)
  if (step === 0) return undefined
  const p = c.vm.palette
  // Without the theme's colours there is nothing to blend: a plain grey for the first half, then nothing.
  if (p === null) return step >= 6 ? 'subtle' : undefined
  return hex(mix(p.base, accent === 'green' ? statusGreen(p) : p.inactive, (0.4 * step) / 10))
}

const itemRipple = (s: ItemStatus): 'green' | 'inactive' => (s === 'running' || s === 'review' ? 'green' : 'inactive')

const CHIP_KINDS: ChipKind[] = ['review', 'running', 'todo', 'done']
const CHIP_GLYPH: Record<ChipKind, string> = { review: '◆', running: '●', todo: '○', done: '✓' }

function chip(c: Ctx, kind: ChipKind, counts: Counts): RenderElement {
  const { Text } = c.els
  const n = counts[kind]
  const el = canvas(c, `chip:${kind}`, chipWidth(chipDigits(n).length), 1, o => chipCells(kind, n, c.vm.palette, o))
  if (el !== null) return el
  return (
    <Text color={chipLit(kind, n) ? greenText(c.vm) : 'inactive'} inverse bold>
      {` ${CHIP_GLYPH[kind]} ${chipDigits(n)} `}
    </Text>
  )
}

function titleArea(c: Ctx, b: Board): RenderElement {
  const { Box, Text } = c.els
  const { vm } = c
  const counts = boardCounts(b, vm.local)
  const bg = titleBg(vm.palette)
  const mile = mileText(b)
  const mascot =
    vm.mascot &&
    canvas(c, 'mascot', MASCOT_COLS, MASCOT_ROWS, o => {
      const mode = mascotMode({ cheering: (o.t ?? 0) < vm.fx.cheerUntil, waiting: counts.review + b.proposals.length > 0, stale: vm.stale, running: counts.running })
      return mascotCells(mode, counts.running, vm.palette, o, vm.mascotKind ?? 'claude').cells
    })
  return (
    <Box flexDirection="row" {...(bg === DEF ? {} : { backgroundColor: hex(bg) })}>
      {mascot}
      <Box flexDirection="column" flexGrow={1} paddingLeft={mascot ? 1 : 0}>
        <Box flexDirection="row" columnGap={1}>
          <Text bold>看板</Text>
          <Text wrap="truncate-end">{`· ${clip(b.project.name, 60)}`}</Text>
          {mile !== '' && <Text dimColor wrap="truncate-end">{`· ${mile}`}</Text>}
          {vm.stale && <Text color="warning">⚠ 看板可能落后</Text>}
          {vm.bytes > ARCHIVE_WARN_BYTES && <Text color="warning">归档已很大</Text>}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={c.mode === 'pane' ? 2 : 1}>
          {CHIP_KINDS.map(k => (
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              {chip(c, k, counts)}
              <Text dimColor>{CHIP_LABEL[k]}</Text>
            </Box>
          ))}
        </Box>
        {b.focus.text !== '' && <Text wrap="truncate-end">{`★ ${clip(b.focus.text, 200)}`}</Text>}
      </Box>
    </Box>
  )
}

function cards(c: Ctx, b: Board): RenderElement {
  const { Box, Text, Button } = c.els
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color={greenText(c.vm)} bold>
        待你确认
      </Text>
      {b.proposals.map(p => (
        <Box flexDirection="column">
          <Text>{describeProposal(b, p)}</Text>
          {p.reason !== '' && <Text dimColor>{`理由：${clip(p.reason, 200)}`}</Text>}
          <Box flexDirection="row" columnGap={1}>
            <Button key={`yes:${p.id}`} label="同意" variant="primary" onPress={() => c.actions.approveProposal(p.id)} />
            <Button key={`no:${p.id}`} label="不要" onPress={() => c.actions.rejectProposal(p.id)} />
          </Box>
        </Box>
      ))}
      <Text dimColor>也可以在对话里直接说</Text>
    </Box>
  )
}

/** "目标短名 › 步骤短名", or the goal's alone for an item outside any step. */
const whereOf = (goal: Goal, step: Step | undefined): string => `${goalShortName(goal.title)}${step === undefined ? '' : ` › ${stepShortName(step)}`}`

/** Every review item the user has not looked at yet, in one place, whatever goal it sits in or how the view is cut. Only reminds and opens: the verdict is given in the conversation. */
function attention(c: Ctx, b: Board): RenderElement {
  const { Box, Text, Button } = c.els
  const all = reviewItems(b, c.vm.local)
  const shown = all.slice(0, ATTENTION_LIMIT)
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color={greenText(c.vm)} bold>
        待你看
      </Text>
      {shown.map(({ goal, step, item }) => {
        const when = relTime(item.reportedAt, c.vm.now)
        const hidden = new Set(hiddenLinks(c.vm.local, item.id, item.links))
        const entries = item.links.map((l, n) => ({ l, n })).filter(({ l }) => l.forReview && !hidden.has(l))
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text color={greenText(c.vm)}>{STATUS_ICON.review}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">{clip(item.title, 120)}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">{`· ${whereOf(goal, step)}`}</Text>
              {when !== '' && <Text dimColor>{when}</Text>}
              <Button key={`seen:${item.id}`} label="看过了" onPress={() => c.actions.markSeen(item.id)} />
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {entries.length === 0 && item.noReviewTargetReason !== '' && <Text dimColor>{`无验收入口：${clip(item.noReviewTargetReason, 200)}`}</Text>}
              {entries.map(({ l, n }) => linkRow(c, `todo-link:${item.id}:${n}`, l, '', item.id))}
            </Box>
          </Box>
        )
      })}
      {all.length > shown.length && <Text dimColor>{`… 另有 ${all.length - shown.length} 项待你看，见下方目标`}</Text>}
    </Box>
  )
}

/**
 * The links of a goal, a step or an item: those shown, listed or folded into "资料 N 条" when there are more than
 * `inline`, then the ones this user hid, folded into "已隐藏 N 条". `title` heads the list when it is not folded.
 */
function linksBlock(c: Ctx, ownerId: string, links: readonly Link[], o: { inline: number; title: string; markReview: boolean }): RenderElement {
  const { inline, title } = o
  const { Box, Text, Button } = c.els
  const rows = links.map((l, n) => ({ l, n }))
  const hidden = new Set(hiddenLinks(c.vm.local, ownerId, links))
  const vis = rows.filter(r => !hidden.has(r.l))
  const visLinks = vis.map(r => r.l)
  const open = linksOpen(visLinks, `links:${ownerId}`, c.vm.expanded, inline)
  const folded = visLinks.length > inline
  return (
    <Box flexDirection="column">
      {vis.length > 0 &&
        (folded ? (
          <Button key={`links:${ownerId}`} plain onPress={() => c.actions.toggle(`links:${ownerId}`, !open)}>
            <Text dimColor>{`${open ? '▾' : '▸'} 资料 ${vis.length} 条`}</Text>
          </Button>
        ) : (
          title !== '' && <Text dimColor>{title}</Text>
        ))}
      {open && vis.length > 0 && (
        <Box flexDirection="column" paddingLeft={folded || title !== '' ? 2 : 0}>
          {vis.map(({ l, n }) => linkRow(c, `link:${ownerId}:${n}`, l, o.markReview && l.forReview ? '验收 ' : '', ownerId))}
        </Box>
      )}
      {hidden.size > 0 && hiddenFold(c, ownerId, rows.filter(r => hidden.has(r.l)))}
    </Box>
  )
}

/** "▸ 已隐藏 N 条": the links this user hid under one owner; opened, each can be brought back. */
function hiddenFold(c: Ctx, ownerId: string, rows: ReadonlyArray<{ l: Link; n: number }>): RenderElement {
  const { Box, Text, Button } = c.els
  const key = `hidden:${ownerId}`
  const open = c.vm.expanded[key] === true
  return (
    <Box flexDirection="column">
      <Button key={key} plain onPress={() => c.actions.toggle(key, !open)}>
        <Text dimColor>{`${open ? '▾' : '▸'} 已隐藏 ${rows.length} 条`}</Text>
      </Button>
      {open &&
        rows.map(({ l, n }) => (
          <Box flexDirection="row" columnGap={1} paddingLeft={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-end">{linkName(l)}</Text>
            </Box>
            <Button key={`restore:${ownerId}:${n}`} label="恢复" onPress={() => c.actions.unhideLink(ownerId, l.target)} />
          </Box>
        ))}
    </Box>
  )
}

/** "▸ ⏸ 暂停 2 个目标 · 名字、名字": the goals that are not in the list; opened, their blocks follow, dimmed. */
function foldOf(c: Ctx, key: 'paused' | 'done', label: string, goals: Goal[]): RenderElement {
  const { Box, Text, Button } = c.els
  const fold = `fold:${key}`
  const open = c.vm.expanded[fold] === true
  return (
    <Box flexDirection="column" marginTop={1}>
      <Button key={fold} plain onPress={() => c.actions.toggle(fold, !open)}>
        <Text dimColor wrap="truncate-end">{`${open ? '▾' : '▸'} ${label} ${goals.length} 个目标${open ? '' : ` · ${goals.map(g => goalShortName(g.title)).join('、')}`}`}</Text>
      </Button>
      {open && goals.slice(0, GOAL_LIMIT).map(g => goalBlock(c, g, true))}
    </Box>
  )
}

function progressBar(c: Ctx, g: Goal): RenderElement {
  const { Text } = c.els
  const cols = BAR_COLS[c.mode]
  const { done, total } = fractionOf(g.items)
  const anim = c.vm.fx.progress[g.id]
  const el = canvas(c, `bar:${g.id}`, cols, 1, o => progressCells(done, total, cols, anim, c.vm.palette, o))
  if (el !== null) return el
  const { n, filled } = batteryFill(done, total, cols)
  return <Text>{`${CELL_FULL.repeat(filled)}${CELL_EMPTY.repeat(n - filled)}${' '.repeat(cols - n)}`}</Text>
}

function goalBlock(c: Ctx, g: Goal, muted: boolean): RenderElement {
  const { Box, Text, Button } = c.els
  const { vm } = c
  const b = vm.board as Board
  const state = goalState(calmGoal(vm.local, g))
  const open = muted ? vm.expanded[g.id] === true : goalOpen(b, g, vm.expanded, c.mode, vm.local)
  const isFocus = g.id === b.focus.goalId
  const { done, total } = fractionOf(g.items)
  const title = `${open ? '▾' : '▸'} ${isFocus ? '★ ' : ''}${clip(g.title, 80)}${g.status === 'paused' ? '（暂停）' : ''}`
  const canFocus = !isFocus && g.status !== 'paused' && state !== 'done'
  const focusBtn = <Button key={`focus:${g.id}`} label="设为关注" onPress={() => c.actions.focusGoal(g.id)} />
  // A closed goal on the terminal shows the button only while the pointer is over its head, without moving anything.
  const hoverOnly = canFocus && !open && vm.canvas
  const stepped = g.steps.length > 0
  // A shut goal with something running turns a spinner by its title; an open one shows its items turning below.
  const runningItems = open || g.status === 'paused' ? [] : g.items.filter(i => i.status === 'running')
  const headSpin =
    runningItems.length === 0
      ? null
      : (spinner(c, `gspin:${g.id}`, runningItems.some(i => isMine(i, vm))) ?? <Text color={greenText(vm)}>●</Text>)
  const headBg = rippleBg(c, g.id, lit(state) ? 'green' : 'inactive')
  // Confetti falls through the blank row above the block: a canvas cell is opaque, so over the head it would hide the title.
  const burst = confettiStart(vm, g.id)
  const strip = Math.max(8, vm.width - (c.mode === 'band-full' ? 4 : 0) - 1)
  const confetti =
    burst !== undefined
      ? canvas(c, `confetti:${g.id}`, strip, 1, o => confettiCells(hashOf(g.id) + burst, strip, 1, (o.t ?? 0) - burst, vm.palette).cells)
      : null
  return (
    <Box flexDirection="column">
      <Box height={1}>{confetti}</Box>
      <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1} {...(headBg === undefined ? {} : { backgroundColor: headBg })} {...(hoverOnly ? { key: `gh:${g.id}` } : {})}>
            <Text color={lit(state) ? greenText(vm) : 'inactive'}>▎</Text>
            {headSpin}
            <Box flexGrow={1} flexShrink={1}>
              <Button key={`goal:${g.id}`} plain onPress={() => c.actions.toggle(g.id, !open)}>
                <Text bold dimColor={muted} wrap="truncate-end">{title}</Text>
              </Button>
            </Box>
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              {progressBar(c, g)}
              <Text dimColor>{total === 0 ? '未开始' : `${done}/${total}`}</Text>
            </Box>
            {canFocus && !hoverOnly && focusBtn}
            {hoverOnly && (
              <Box position="absolute" right={0} top={0} display="none" hover={{ display: 'flex' }}>
                {focusBtn}
              </Box>
            )}
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {open && g.links.length > 0 && <Box paddingLeft={2}>{linksBlock(c, g.id, g.links, { inline: goalLinksInline(b, g), title: '资料', markReview: false })}</Box>}
            {!muted && stepped && stepStrip(c, g, open)}
            {open && (muted || !stepped) && itemsGroup(c, g.items, `done:${g.id}`)}
            {open && !muted && stepped && unitsOf(g).filter(u => unitOpen(g, u, vm.expanded) && (u.items.length > 0 || (u.step?.links.length ?? 0) > 0)).map(u => stepBlock(c, g, u))}
          </Box>
      </Box>
    </Box>
  )
}

function spinner(c: Ctx, key: string, fresh: boolean): RenderElement | null {
  return canvas(c, key, 1, 1, o => spinCells(fresh, c.vm.palette, o))
}

/** The step bar: `✓ T › ◐ A 22/23 › ◆ B 12/17`; wraps when the pane is narrow. */
function stepStrip(c: Ctx, g: Goal, goalIsOpen: boolean): RenderElement {
  const { Box, Text, Button } = c.els
  const { vm } = c
  const toks = unitsOf(g).map(u => {
    const st = unitState(u, vm.local)
    const on = goalIsOpen && unitOpen(g, u, vm.expanded)
    const { done, total } = fractionOf(u.items)
    const name = u.step === null ? '其他' : stepShortName(u.step)
    const count = showsCount(st) && total > 0 ? ` ${done}/${total}` : ''
    // An open step shows its running items turning below; the bar then keeps a still dot.
    const mine = u.items.some(i => i.status === 'running' && isMine(i, vm))
    const spin = st === 'running' && !on ? spinner(c, `sspin:${u.id}`, mine) : null
    const icon = spin === null ? `${STEP_ICON[st]} ` : ' '
    const tokBg = rippleBg(c, u.id, lit(st) ? 'green' : 'inactive')
    return (
      <Box flexDirection="row" {...(tokBg === undefined ? {} : { backgroundColor: tokBg })}>
        {spin}
        <Button key={`step:${u.id}`} plain onPress={() => (on ? c.actions.toggle(u.id, false) : c.actions.toggleMany({ [u.id]: true, [g.id]: true }))}>
          <Text {...(lit(st) ? { color: greenText(vm) } : { dimColor: true })} {...(on ? { backgroundColor: 'subtle' } : {})}>{`${icon}${name}${count}`}</Text>
        </Button>
      </Box>
    )
  })
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {toks.flatMap((t, n) => (n === 0 ? [t] : [<Text dimColor>›</Text>, t]))}
    </Box>
  )
}

function stepBlock(c: Ctx, g: Goal, u: Unit): RenderElement {
  const { Box, Text, Button } = c.els
  const { done, total } = fractionOf(u.items)
  const step = u.step
  return (
    <Box flexDirection="column">
      <Button key={`sh:${u.id}`} plain onPress={() => c.actions.toggle(u.id, false)}>
        <Text bold wrap="truncate-end">{`▾ ${step === null ? '其他' : clip(step.title, 80)}`}</Text>
        {step !== null && <Text dimColor>{` ${done}/${total}`}</Text>}
      </Button>
      {step !== null && step.links.length > 0 && <Box paddingLeft={2}>{linksBlock(c, step.id, step.links, { inline: LINKS_INLINE, title: '资料', markReview: false })}</Box>}
      {itemsGroup(c, step === null ? looseItems(g) : u.items, step === null ? `done:${g.id}` : `done:${u.id}`)}
    </Box>
  )
}

/** Live items of one group in the order of SHOW_ORDER, then the folded count line for done and dropped ones. */
function itemsGroup(c: Ctx, items: readonly Item[], foldKey: string): RenderElement {
  const { Box, Text, Button } = c.els
  const { vm } = c
  const live = items.filter(i => i.status !== 'done' && i.status !== 'dropped')
  const all = live.map((i, n) => ({ i, n })).sort((x, y) => SHOW_ORDER.indexOf(x.i.status) - SHOW_ORDER.indexOf(y.i.status) || x.n - y.n).map(x => x.i)
  const ordered = all.slice(0, c.budget.left)
  c.budget.left -= ordered.length
  const done = items.filter(i => i.status === 'done')
  const dropped = items.filter(i => i.status === 'dropped')
  const foldOpen = vm.expanded[foldKey] === true
  const foldText = [done.length > 0 ? `✓ 已完成 ${done.length} 项` : '', dropped.length > 0 ? `搁置 ${dropped.length} 项` : ''].filter(Boolean).join(' · ')
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {ordered.map(it => itemRow(c, it))}
      {all.length > ordered.length && <Text dimColor>{`… 另有 ${all.length - ordered.length} 项未显示`}</Text>}
      {foldText !== '' && (
        <Button key={foldKey} plain onPress={() => c.actions.toggle(foldKey, !foldOpen)}>
          <Text dimColor>{`${foldOpen ? '▾' : '▸'} ${foldText}`}</Text>
        </Button>
      )}
      {foldOpen &&
        [...done, ...dropped].map(it => (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {`${STATUS_ICON[it.status]} ${clip(it.title, 120)}`}
            </Text>
          </Box>
        ))}
    </Box>
  )
}

/** The short marks at the end of an item row: owner, what it waits for, and for another session's running item when it last reported. */
function rowTags(vm: ViewModel, it: Item): string[] {
  const out: string[] = []
  if (it.owner !== '') out.push(`@${it.owner}`)
  if (it.waitingFor !== '') out.push(`等：${clip(it.waitingFor, WAIT_TAG)}`)
  if (it.status === 'running' && !isMine(it, vm)) {
    const age = ageOf(it.reportedAt, vm.now)
    out.push(age !== null && age > STALE_RUN_MS ? '可能已停' : `别的会话${it.reportedAt !== '' ? ` · ${shortTime(it.reportedAt)}` : ''}`)
  }
  return out
}

/** What the item still waits on: unfinished dependencies, two titles and a count. */
function dependsText(b: Board, it: Item): string {
  const byId = new Map<string, Item>()
  for (const g of b.goals) for (const i of g.items) byId.set(i.id, i)
  const pending = it.dependsOn.filter(id => {
    const d = byId.get(id)
    return d === undefined || (d.status !== 'done' && d.status !== 'dropped')
  })
  const names = pending.map(id => clip(byId.get(id)?.title ?? id, 30))
  return names.length <= 2 ? names.join(' / ') : `${names.slice(0, 2).join(' / ')} 等 ${names.length} 项`
}

function itemRow(c: Ctx, it: Item): RenderElement {
  const { Box, Text, Button } = c.els
  const { vm } = c
  const open = itemOpen(it, vm.expanded)
  // A review item this user has looked at stays in review until the AI moves it; it only steps back.
  const seen = it.status === 'review' && !isWaiting(vm.local, it)
  const ic = seen ? { dim: true } : iconColor(it, vm)
  const spin = it.status === 'running' ? spinner(c, `spin:${it.id}`, isMine(it, vm)) : null
  const tags = [...rowTags(vm, it), ...(seen ? ['已看'] : [])]
  const rowBg = rippleBg(c, it.id, itemRipple(it.status))
  return (
    <Box flexDirection="column" {...(rowBg === undefined ? {} : { backgroundColor: rowBg })}>
      <Box flexDirection="row" columnGap={1}>
        <Box flexDirection="row" flexGrow={1} flexShrink={1}>
          {spin}
          <Button key={`item:${it.id}`} plain onPress={() => c.actions.toggle(it.id, !open)}>
            {spin === null && <Text color={ic.color} dimColor={ic.dim === true}>{seen ? '◇' : STATUS_ICON[it.status]}</Text>}
            <Text dimColor={seen} wrap="truncate-end">{` ${clip(it.title, 120)}`}</Text>
          </Button>
        </Box>
        {tags.map(t => (
          <Text dimColor>{t}</Text>
        ))}
      </Box>
      {open && details(c, it)}
    </Box>
  )
}

function linkName(l: Link): string {
  const base = l.type === 'path' ? (l.target.replace(/\/+$/, '').split('/').pop() ?? l.target) : l.target
  return `${l.kind} ${clip(base, 40)}${l.label !== '' ? ` · ${clip(l.label, 40)}` : ''}`
}

/**
 * One link. A file or a url opens from its name; a command or a ref has its copy button instead. The other buttons
 * and [×] (hide on this machine) show under the pointer on a surface with hover, and stay on screen elsewhere, without
 * VS Code. `key` names the buttons, so two rows for one link need two keys.
 */
function linkRow(c: Ctx, key: string, l: Link, prefix: string, ownerId: string): RenderElement {
  const { Box, Text, Button } = c.els
  const { vm } = c
  const acts = linkActions(l, vm.root, vm.platform, vm.hasCode, vm.home)
  const gone = l.type === 'path' && vm.missing.has(resolveTarget(l.target, vm.root, vm.home))
  const name = `${prefix}${linkName(l)}${gone ? '（文件不存在）' : ''}`
  const opener = acts.find(a => a.kind === 'open')
  const btn = (a: LinkAction): RenderElement => (
    <Button key={`${key}:${a.kind}`} label={vm.hover || a.kind !== 'copy' || l.type === 'command' ? a.label : '复制'} dimColor={gone && a.kind !== 'copy'} onPress={press => c.actions.link(a, press.surface)} />
  )
  // Without something to open, copying is what the link is for: that button never hides.
  const fixed = opener === undefined ? acts.filter(a => a.kind === 'copy') : []
  const extra = acts.filter(a => a !== opener && !fixed.includes(a) && (vm.hover || a.kind !== 'vscode'))
  const hide = <Button key={`${key}:hide`} label="×" onPress={() => c.actions.hideLink(ownerId, l.target)} />
  return (
    <Box flexDirection="row" columnGap={1} {...(vm.hover ? { key: `lh:${key}` } : {})}>
      <Box flexGrow={1} flexShrink={1}>
        {opener === undefined ? (
          <Text dimColor={gone} wrap="truncate-end">{name}</Text>
        ) : (
          <Button key={`${key}:open`} plain dimColor={gone} onPress={press => c.actions.link(opener, press.surface)}>
            <Text dimColor={gone} wrap="truncate-end">{name}</Text>
          </Button>
        )}
      </Box>
      {fixed.map(btn)}
      {vm.hover ? (
        <Box position="absolute" right={0} top={0} display="none" hover={{ display: 'flex' }} columnGap={1}>
          {extra.map(btn)}
          {hide}
        </Box>
      ) : (
        [...extra.map(btn), hide]
      )}
    </Box>
  )
}

/** What an opened item shows: the full text of everything its row leaves out, then its links. */
function details(c: Ctx, it: Item): RenderElement {
  const { Box, Text } = c.els
  const b = c.vm.board as Board
  const lines: string[] = []
  if (it.status === 'running' && !isMine(it, c.vm)) lines.push(`别的会话报告在跑${it.reportedAt !== '' ? ` · ${shortTime(it.reportedAt)}` : ''} · 未核实`)
  if (it.waitingFor !== '') lines.push(`等：${clip(it.waitingFor, 200)}`)
  const deps = dependsText(b, it)
  if (deps !== '') lines.push(`依赖：${deps}`)
  if (it.note !== '') lines.push(clip(it.note, NOTE_LIMIT))
  if (it.acceptance !== '') lines.push(`验收标准：${clip(it.acceptance, NOTE_LIMIT)}`)
  if (it.scope.length > 0) lines.push(`负责文件：${it.scope.slice(0, 6).join('、')}${it.scope.length > 6 ? ` 等 ${it.scope.length} 个` : ''}`)
  if (it.status === 'review' && it.noReviewTargetReason !== '' && !it.links.some(l => l.forReview)) lines.push(`无验收入口：${clip(it.noReviewTargetReason, 200)}`)
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {lines.map(t => (
        <Text dimColor>{t}</Text>
      ))}
      {it.links.length > 0 && linksBlock(c, it.id, it.links, { inline: Number.POSITIVE_INFINITY, title: '', markReview: true })}
    </Box>
  )
}

// ---------- what the buttons do ----------

/**
 * Button actions that write the board. They run as the user: the change goes through the store like
 * any other and lands in the list of changes Claude has not been told about.
 */
export function makeActions(host: Host, store: BoardStore, nowIso: () => Promise<string>): StoreActions {
  /** Whether the change was written; a refusal is toasted. */
  const run = async (fn: (b: Board, ctx: OpCtx) => ApplyResult): Promise<boolean> => {
    try {
      const ctx: OpCtx = { now: await nowIso(), session: await host.sessionId(), actor: 'user' }
      const r = await store.commit(b => fn(b, ctx), 'user')
      if (!r.ok) host.toast(`没有执行：${r.reason}`)
      return r.ok
    } catch (e) {
      host.toast(`没有执行：${(e as Error).message}`)
      return false
    }
  }
  return {
    approveProposal: id => run((b, ctx) => approve(b, id, ctx, 'sidebar')).then(() => undefined),
    rejectProposal: id => run(b => reject(b, id)).then(() => undefined),
    focusGoal: goalId =>
      run((b, ctx) => {
        const g = b.goals.find(x => x.id === goalId)
        if (g === undefined) return { ok: false, index: 0, reason: `目标 ${goalId} 已不在活动区` }
        const made = propose(b, 'focus.set', { text: g.title, goalId, mandate: b.focus.mandate }, '', ctx)
        if (!made.ok) return made
        const pid = made.events[0]?.id
        return pid === undefined ? { ok: false, index: 0, reason: '内部错误：没有生成提议' } : approve(made.board, pid, ctx, 'sidebar')
      }).then(() => undefined),
    link: (a, surface) => pressLink(host, a, surface).catch(e => host.toast(`操作失败：${(e as Error).message}`)),
  }
}
