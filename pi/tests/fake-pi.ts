import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import projectBoard from '../project-board'

type Handler = (event: any, ctx: any) => any

export type Fake = {
  dir: string
  ctx: any
  tools: Map<string, any>
  commands: Map<string, any>
  notices: string[]
  messages: any[]
  widgets: Array<{ key: string; content: unknown }>
  fire(event: string, payload?: Record<string, unknown>): Promise<any[]>
  call(tool: string, params: Record<string, unknown>): Promise<string>
  command(name: string, args: string): Promise<void>
  board(): Promise<any>
  put(board: unknown): Promise<void>
  cleanup(): Promise<void>
}

/** A pi session in a temp project: the extension is loaded against a stand-in for ExtensionAPI. */
export async function fakePi(opts: { board?: boolean; child?: boolean; mode?: 'tui' | 'print' } = {}): Promise<Fake> {
  const dir = await mkdtemp(join(tmpdir(), 'pb-pi-'))
  if (opts.board !== false) {
    const { emptyBoard, serializeBoard } = await import('../../hooks/model/parse')
    await mkdir(join(dir, 'ai'), { recursive: true })
    await writeFile(join(dir, 'ai', 'board.json'), serializeBoard(emptyBoard('demo')))
  }
  const prevChild = process.env.PI_SUBAGENT_CHILD
  if (opts.child) process.env.PI_SUBAGENT_CHILD = '1'
  else delete process.env.PI_SUBAGENT_CHILD
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  const notices: string[] = []
  const messages: any[] = []
  const widgets: Fake['widgets'] = []
  const ctx = {
    cwd: dir,
    mode: opts.mode ?? 'print',
    hasUI: (opts.mode ?? 'print') === 'tui',
    sessionManager: { getSessionId: () => 'sess-1' },
    ui: {
      notify: (t: string) => notices.push(t),
      setStatus: () => undefined,
      setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
    },
  }
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h])
      return () => undefined
    },
    registerTool: (t: any) => void tools.set(t.name, t),
    registerCommand: (name: string, o: any) => void commands.set(name, o),
    sendMessage: async (m: any) => void messages.push(m),
  }
  projectBoard(pi as never)
  if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD
  else process.env.PI_SUBAGENT_CHILD = prevChild
  const fire = async (event: string, payload: Record<string, unknown> = {}): Promise<any[]> => {
    const out: any[] = []
    for (const h of handlers.get(event) ?? []) out.push(await h({ type: event, ...payload }, ctx))
    return out
  }
  await fire('session_start', { reason: 'startup' })
  return {
    dir,
    ctx,
    tools,
    commands,
    notices,
    messages,
    widgets,
    fire,
    call: async (tool, params) => {
      const r = await tools.get(tool).execute('id', params, undefined, undefined, ctx)
      return r.content[0].text as string
    },
    command: (name, args) => commands.get(name).handler(args, ctx),
    board: async () => JSON.parse(await readFile(join(dir, 'ai', 'board.json'), 'utf8')),
    put: async b => writeFile(join(dir, 'ai', 'board.json'), `${JSON.stringify(b, null, 2)}\n`),
    cleanup: async () => {
      await fire('session_shutdown', { reason: 'quit' })
      await rm(dir, { recursive: true, force: true })
    },
  }
}
