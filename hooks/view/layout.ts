export type LayoutSetting = 'auto' | 'right' | 'bottom'
export type LayoutKind = 'pane' | 'band-full' | 'band-entry'
export type Viewport = { columns: number; rows: number } | undefined

/** Columns the docked frame takes besides the pane's body (the terminal is conversation + body + this). */
export const DOCK_FRAME_COLUMNS = 1

/**
 * The shape of the whole terminal. A docked pane narrows the conversation, and `viewport.columns`
 * is the conversation's, so the pane's own width is added back; without a docked pane it is the viewport as is.
 */
export function wholeScreen(v: Viewport, dockedBody: number | null): Viewport {
  if (v === undefined || dockedBody === null) return v
  return { ...v, columns: v.columns + dockedBody + DOCK_FRAME_COLUMNS }
}

/** A character cell is about twice as tall as wide, so rows * 2 > columns is a portrait screen. */
export function isPortrait(v: Viewport): boolean {
  return v !== undefined && v.rows * 2 > v.columns
}

/** Whether the setting and the screen shape call for the side pane (as opposed to drawing above the prompt). */
export function wantsPane(v: Viewport, setting: LayoutSetting): boolean {
  if (setting === 'right') return true
  if (setting === 'bottom') return false
  return !isPortrait(v)
}

/**
 * Where the board is drawn. 'pane': the side pane draws it and the band stays empty; 'band-full': the
 * band above the prompt draws the whole board; 'band-entry': one line pointing at /board.
 * A missing viewport counts as landscape. 'right' and 'bottom' fix the result whatever the screen; a
 * caller that sees 'pane' while no pane is on screen should fall back to 'band-entry'.
 */
export function decideLayout(v: Viewport, pane: { isPlaced: boolean }, setting: LayoutSetting): LayoutKind {
  if (setting === 'right') return 'pane'
  if (!wantsPane(v, setting)) return 'band-full'
  return pane.isPlaced ? 'pane' : 'band-entry'
}

/** Reads the layout option; anything outside the picker's values reads as 'auto'. */
export function parseSetting(v: unknown): LayoutSetting {
  return v === 'right' || v === 'bottom' ? v : 'auto'
}
