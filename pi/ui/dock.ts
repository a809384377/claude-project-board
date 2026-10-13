/**
 * Docks a component at the right edge of pi's fullscreen layout: the layout root (the transcript, the editor, the
 * footer) is wrapped in an HStack with the component beside it. This leans on pi-tui's layout API and on the
 * layout root, which pi keeps privately; every step is guarded, and a false result means "draw above the prompt instead".
 */

type Component = { render(width: number): string[]; invalidate(): void }
type Tui = { setLayoutRoot(c: unknown): void; requestRender(force?: boolean): void; terminal: { columns: number; rows: number } }
type Lib = { HStack: new (children: unknown[]) => unknown; isViewportTUI: (t: unknown) => boolean; colorToHex?: (c: unknown) => string }

let lib: Lib | null = null
const loading: Promise<void> = import('@earendil-works/pi-tui')
  .then(m => {
    lib = m as unknown as Lib
  })
  .catch(() => undefined)

/** Resolves once it is known whether pi-tui's layout API can be reached. */
export const dockReady = (): Promise<void> => loading

export class Dock {
  private ours: unknown = null
  private orig: unknown = null
  private basis = 0

  private readonly tui: Tui

  constructor(tui: object, private readonly pane: Component) {
    this.tui = tui as Tui
  }

  /** Whether this terminal is one the pane can be docked in. */
  possible(): boolean {
    try {
      return lib !== null && lib.isViewportTUI(this.tui) && (this.tui as unknown as { layoutRoot?: unknown }).layoutRoot !== undefined
    } catch {
      return false
    }
  }

  /** Columns the pane was docked with. */
  get width(): number {
    return this.basis
  }

  get attached(): boolean {
    return this.ours !== null && (this.tui as unknown as { layoutRoot?: unknown }).layoutRoot === this.ours
  }

  /** Docks the pane `basis` columns wide (re-docks when the width changed). False when it cannot be done. */
  attach(basis: number): boolean {
    if (lib === null || !this.possible()) return false
    if (this.attached && this.basis === basis) return true
    try {
      this.detach()
      const root = (this.tui as unknown as { layoutRoot?: unknown }).layoutRoot
      this.orig = root
      this.ours = new lib.HStack([
        { component: root, basis: 0, grow: 1, shrink: 1 },
        { component: this.pane, basis, grow: 0, shrink: 0 },
      ])
      this.basis = basis
      this.tui.setLayoutRoot(this.ours)
      this.tui.requestRender()
      return true
    } catch {
      this.ours = null
      return false
    }
  }

  /** Puts the layout back as pi had it (only when it is still the one this made). */
  detach(): void {
    const ours = this.ours
    this.ours = null
    if (ours === null) return
    try {
      if ((this.tui as unknown as { layoutRoot?: unknown }).layoutRoot === ours) this.tui.setLayoutRoot(this.orig)
      this.tui.requestRender()
    } catch {
      // the terminal was replaced
    }
  }
}

/** pi's own accent colour, from the theme in use, as 0xRRGGBB; null when it cannot be read. */
export function accentOf(theme: unknown): number | null {
  try {
    const color = (theme as { colors?: Record<string, unknown> }).colors?.accent
    const text = color === undefined ? undefined : lib?.colorToHex?.(color)
    const n = text === undefined ? Number.NaN : Number.parseInt(text.replace('#', ''), 16)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
