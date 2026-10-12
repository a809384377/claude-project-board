export type BoardLayout = 'auto' | 'right' | 'bottom'

declare module 'claude-code' {
  interface PluginState {
    'project-board': {
      /** System-prompt section of this conversation; null until the first compose and after /clear. */
      snapshot: string | null
      /** Changes Claude has not been told about, one line each. */
      untold: string[]
      /** The last main-session turn changed files or spawned agents without updating the board. */
      stale: boolean
      /** Bookkeeping nudge attached to the user's next message; empty when none. */
      reminder: string
      /** Open/closed choices in the board view, by goal id, step id, item id, or a key such as `done:<id>`, `other:<goal id>`, `links:<id>`, `fold:paused`. */
      expanded: Record<string, boolean>
      /** The board above the prompt is folded down to its one-line entry. */
      bandHidden: boolean
    }
  }
}
