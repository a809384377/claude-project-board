/** Values the mod keeps in $.state (the contract is in types/index.d.ts). */
export interface SyncState {
  /** The system-prompt section for this conversation; null until the first compose, cleared by /clear. */
  snapshot: string | null
  /** Changes Claude has not been told about yet, one line each. */
  untold: string[]
  /** The last main-session turn changed files or spawned agents without touching the board. */
  stale: boolean
  /** The bookkeeping nudge waiting for the user's next message ('' = none). */
  reminder: string
}

/** A tool as the engine registers it. */
export interface ToolRegistration {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isDeferred: boolean
}

/** Everything the board logic needs from the engine, as plain closures. Built once per hook scope by hostOf($) in register.ts. */
export interface Host {
  readText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** null when the path does not exist. */
  stat(path: string): Promise<{ mtimeMs: number } | null>
  /** Names and kinds of a directory's entries; rejects when it cannot be listed. */
  listDir(path: string): Promise<Array<{ name: string; kind: 'file' | 'dir' | 'other' }>>
  /** Runs argv without a shell. `code` is the exit status. */
  run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  /** The session's project root (absolute). */
  root(): Promise<string>
  sessionId(): Promise<string>
  toast(text: string): void
  status(text?: string): void
  copy(text: string, surface?: string): Promise<boolean>
  /** Epoch milliseconds. */
  now(): Promise<number>
  /** $.state values; a key never written reads as its empty value. */
  getState<K extends keyof SyncState>(key: K): Promise<SyncState[K]>
  setState<K extends keyof SyncState>(key: K, value: SyncState[K]): Promise<void>
  /** Declares a tool to the model from the next prompt on; registering a name again replaces it. */
  registerTool(spec: ToolRegistration): Promise<void>
}
