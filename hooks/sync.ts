import type { Host } from './host'
import { describeChanges } from './model/diff'
import { buildSnapshot } from './model/summary'
import type { BoardStore, Change } from './store'

export const UNTOLD_LIMIT = 1500

/** Which tool names count as spawning agents; each host names its tools differently. */
export type ToolNames = { agent: ReadonlySet<string> }

export const CLAUDE_TOOLS: ToolNames = { agent: new Set(['Agent']) }

/** What a user submission looks like: not sent into a running turn, and typed by a person or the SDK host. */
export function isUserSubmission(e: { turnId?: string | undefined; origin: { kind: string } }): boolean {
  return e.turnId === undefined && (e.origin.kind === 'composer' || e.origin.kind === 'sdk' || e.origin.kind === 'bridge')
}

/** The lines as one context block; past UNTOLD_LIMIT only a count is left. */
export function formatUntold(lines: readonly string[]): string {
  if (lines.length === 0) return ''
  const text = `看板自你上次了解后有 ${lines.length} 处变化（不是你做的）：\n${lines.map(l => `- ${l}`).join('\n')}`
  return text.length <= UNTOLD_LIMIT ? text : `看板有 ${lines.length} 处外部变更，用 board_get 查看`
}

/** Counts what the main session did in one turn. */
export class TurnCounter {
  private agents = 0
  private board = 0
  constructor(private readonly names: ToolNames = CLAUDE_TOOLS) {}
  reset(): void {
    this.agents = 0
    this.board = 0
  }
  /** `isBoardWrite` marks a successful board write; any other call is classified by tool name. */
  count(toolName: string, isBoardWrite: boolean): void {
    if (isBoardWrite) this.board++
    else if (this.names.agent.has(toolName)) this.agents++
  }
  verdict(): { stale: boolean; agents: number } {
    return { stale: this.agents > 0 && this.board === 0, agents: this.agents }
  }
}

const ACTOR_LABEL = { external: '外部', main: '主会话', agent: '子 agent', user: '用户' } as const

/**
 * Keeps what the AI knows of the board: the prompt snapshot, the changes it was not told about,
 * and the end-of-turn bookkeeping verdict. Values live in $.state; this object only serializes access.
 */
export class Sync {
  readonly turn: TurnCounter
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly host: Host,
    private readonly store: BoardStore,
    tools: ToolNames = CLAUDE_TOOLS,
  ) {
    this.turn = new TurnCounter(tools)
    store.onChange(c => void this.serial(() => this.apply(c)))
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Resolves when every change heard so far has been recorded. */
  flush(): Promise<void> {
    return this.serial(async () => undefined)
  }

  private async apply(c: Change): Promise<void> {
    const h = this.host
    if (c.source === 'main') {
      await this.clearStale()
      this.turn.count('', true)
      return
    }
    if (c.source === 'agent') {
      // A sub-agent's write is bookkeeping for the turn it ran in: the main session is not owed a reminder.
      await this.clearStale()
      this.turn.count('', true)
    }
    const lines = this.linesOf(c)
    if (lines.length > 0) await h.setState('untold', [...(await h.getState('untold')), ...lines])
  }

  private linesOf(c: Change): string[] {
    const who = ACTOR_LABEL[c.source]
    if (c.before && c.after) return describeChanges(c.before, c.after, who)
    if (c.after) return [`${who}：看板文件出现或恢复（rev ${c.after.rev}）`]
    return [`${who}：看板文件被删除或无法解析，写入会被拒绝`]
  }

  private async clearStale(): Promise<void> {
    if (await this.host.getState('stale')) await this.host.setState('stale', false)
    if ((await this.host.getState('reminder')) !== '') await this.host.setState('reminder', '')
  }

  /**
   * The system-prompt section of this conversation: the same text every time once built. Null while the
   * project has no readable board. Building it also resets what Claude has been told.
   */
  async snapshot(): Promise<string | null> {
    const h = this.host
    const kept = await this.serial(() => h.getState('snapshot'))
    if (kept !== null) return kept
    // Look at the file once before the first build, and let what that finds be recorded first:
    // the snapshot then already contains it, and the reset below drops the matching untold lines.
    await this.store.poll().catch(() => undefined)
    await this.flush()
    return this.serial(async () => {
      const again = await h.getState('snapshot')
      if (again !== null) return again
      const board = this.store.current().board
      if (board === null) return null
      const text = buildSnapshot(board)
      await h.setState('snapshot', text)
      await h.setState('untold', [])
      return text
    })
  }

  /** /clear: the next compose builds a fresh snapshot, and nothing from the old conversation is owed. */
  reset(): Promise<void> {
    return this.serial(async () => {
      const h = this.host
      await h.setState('snapshot', null)
      await h.setState('untold', [])
      await h.setState('reminder', '')
      await h.setState('stale', false)
    })
  }

  /** The context blocks owed for the user's next message; empties what it returns. */
  takeForSubmit(): Promise<string[]> {
    return this.serial(async () => {
      const h = this.host
      const untold = await h.getState('untold')
      const reminder = await h.getState('reminder')
      if (untold.length === 0 && reminder === '') return []
      const out: string[] = []
      if (untold.length > 0) out.push(formatUntold(untold))
      if (reminder !== '') out.push(reminder)
      await h.setState('untold', [])
      await h.setState('reminder', '')
      return out
    })
  }

  /** A main-session turn ended: decide whether the board fell behind. */
  turnComplete(): Promise<void> {
    return this.serial(async () => {
      const v = this.turn.verdict()
      if (!v.stale) return
      await this.host.setState('stale', true)
      await this.host.setState('reminder', `上一轮派了 ${v.agents} 个 agent，看板未更新；如有进展请补记`)
    })
  }
}
