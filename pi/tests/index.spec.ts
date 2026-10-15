import { afterEach, describe, expect, test } from 'bun:test'

import { fakePi, type Fake } from './fake-pi'

/** File times have a grain: let one pass between two writes the store must tell apart. */
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))

let live: Fake[] = []
const make = async (...a: Parameters<typeof fakePi>): Promise<Fake> => {
  const f = await fakePi(...a)
  live.push(f)
  return f
}
afterEach(async () => {
  for (const f of live) await f.cleanup()
  live = []
})

const sections = async (f: Fake): Promise<Record<string, string>> => {
  const event = { messageType: 'user', prompt: 'hi', systemPromptOptions: { sections: {} as Record<string, string> } }
  await f.fire('before_agent_start', event)
  return event.systemPromptOptions.sections
}

describe('tools', () => {
  test('a project with a board gets all four tools, direct', async () => {
    const f = await make()
    expect([...f.tools.keys()].sort()).toEqual(['board_get', 'board_init', 'board_propose', 'board_update'])
    expect(f.tools.get('board_update').exposure).toBe('direct')
    expect(f.tools.get('board_update').parameters.required).toEqual(['ops'])
  })

  test('a project without a board offers only board_init, behind tool search', async () => {
    const f = await make({ board: false })
    expect([...f.tools.keys()]).toEqual(['board_init'])
    expect(f.tools.get('board_init').exposure).toBe('deferred')
  })

  test('board_init creates the board and the full set appears', async () => {
    const f = await make({ board: false })
    const r = JSON.parse(await f.call('board_init', { name: 'fresh' }))
    expect(r.ok).toBe(true)
    expect((await f.board()).project.name).toBe('fresh')
    expect([...f.tools.keys()].sort()).toEqual(['board_get', 'board_init', 'board_propose', 'board_update'])
    expect(f.tools.get('board_get').exposure).toBe('direct')
  })

  test('board_update writes ai/board.json; board_get reads it back', async () => {
    const f = await make()
    const w = JSON.parse(await f.call('board_update', { ops: [{ op: 'rule.add', text: '先测后发', group: '流程' }] }))
    expect(w).toMatchObject({ ok: true, rev: 1 })
    expect((await f.board()).rules[0].text).toBe('先测后发')
    const g = JSON.parse(await f.call('board_get', { scope: 'rules' }))
    expect(JSON.stringify(g.data)).toContain('先测后发')
  })

  test('a refused call throws, so pi marks the result as an error, and the file is untouched', async () => {
    const f = await make()
    await expect(f.call('board_update', { ops: [{ op: 'item.update', id: 'i-nope', title: 'x' }] })).rejects.toThrow('"ok":false')
    expect((await f.board()).rev).toBe(0)
  })
})

describe('who is calling', () => {
  test('the main session may confirm its own proposal with the user\'s words', async () => {
    const f = await make()
    const r = JSON.parse(await f.call('board_propose', { action: 'goal.create', payload: { title: '导出' }, userConfirmed: true, quote: '就按这个建' }))
    expect(r.ok).toBe(true)
    expect((await f.board()).goals).toHaveLength(1)
  })

  test('a pi sub-agent (PI_SUBAGENT_CHILD=1) can only propose: userConfirmed is refused', async () => {
    const f = await make({ child: true })
    await expect(f.call('board_propose', { action: 'goal.create', payload: { title: '导出' }, userConfirmed: true, quote: '好' })).rejects.toThrow()
    expect((await f.board()).goals).toHaveLength(0)
    const p = JSON.parse(await f.call('board_propose', { action: 'goal.create', payload: { title: '导出' } }))
    expect(p.ok).toBe(true)
    expect((await f.board()).proposals).toHaveLength(1)
  })

  test('a sub-agent gets neither the prompt snapshot nor the /board widget', async () => {
    const f = await make({ child: true, mode: 'tui' })
    expect(await sections(f)).toEqual({})
    expect(f.widgets).toHaveLength(0)
  })
})

describe('prompt', () => {
  test('the snapshot is a system prompt section, the same text every turn', async () => {
    const f = await make()
    const first = (await sections(f)).project_board
    expect(first).toContain('# 项目看板')
    await f.call('board_update', { ops: [{ op: 'rule.add', text: '新约定' }] })
    expect((await sections(f)).project_board).toBe(first)
  })

  test('no board: no section', async () => {
    const f = await make({ board: false })
    expect(await sections(f)).toEqual({})
  })

  test('a change made behind the AI\'s back is told on the next user message, once', async () => {
    const f = await make()
    await sections(f)
    await tick()
    const b = await f.board()
    b.rev += 1
    b.rules.push({ id: 'r-ext001', text: '外部加的约定', group: '' })
    await f.put(b)
    const event = { messageType: 'user', prompt: 'hi', systemPromptOptions: { sections: {} as Record<string, string> } }
    const [res] = await f.fire('before_agent_start', event)
    expect(res.message.content).toContain('外部')
    expect(res.message.display).toBe(false)
    const [again] = await f.fire('before_agent_start', { ...event, systemPromptOptions: { sections: {} } })
    expect(again).toBeUndefined()
  })

  test('a run that is not a user message gets the snapshot but no notices', async () => {
    const f = await make()
    await sections(f)
    await tick()
    const b = await f.board()
    b.rev += 1
    b.rules.push({ id: 'r-ext002', text: '外部', group: '' })
    await f.put(b)
    const [res] = await f.fire('before_agent_start', { messageType: 'custom', systemPromptOptions: { sections: {} } })
    expect(res).toBeUndefined()
  })
})

describe('bookkeeping reminder', () => {
  test('a turn that only edited files owes nothing', async () => {
    const f = await make()
    await sections(f)
    await f.fire('agent_start')
    await f.fire('tool_call', { toolName: 'edit' })
    await f.fire('tool_call', { toolName: 'write' })
    await f.fire('agent_end', { messages: [] })
    const [res] = await f.fire('before_agent_start', { messageType: 'user', prompt: 'next', systemPromptOptions: { sections: {} } })
    expect(res).toBeUndefined()
  })

  test('a turn that also wrote the board owes nothing', async () => {
    const f = await make()
    await sections(f)
    await f.fire('agent_start')
    await f.fire('tool_call', { toolName: 'subagent' })
    await f.call('board_update', { ops: [{ op: 'rule.add', text: '记了' }] })
    await f.fire('agent_end', { messages: [] })
    const [res] = await f.fire('before_agent_start', { messageType: 'user', prompt: 'next', systemPromptOptions: { sections: {} } })
    expect(res).toBeUndefined()
  })

  test('spawning a sub-agent without writing the board leaves the reminder', async () => {
    const f = await make()
    await sections(f)
    await f.fire('agent_start')
    await f.fire('tool_call', { toolName: 'subagent' })
    await f.fire('agent_end', { messages: [] })
    const [res] = await f.fire('before_agent_start', { messageType: 'user', prompt: 'next', systemPromptOptions: { sections: {} } })
    expect(res.message.content).toContain('上一轮派了 1 个 agent，看板未更新；如有进展请补记')
  })
})

describe('/board', () => {
  test('init creates the board where there is none', async () => {
    const f = await make({ board: false })
    await f.command('board', 'init miniapp')
    expect((await f.board()).project.type).toBe('miniapp')
    expect(f.notices.at(-1)).toContain('已创建 ai/board.json')
    expect(f.tools.has('board_get')).toBe(true)
  })

  test('a listing goes into the conversation; no argument toggles and says so', async () => {
    const f = await make()
    await f.call('board_update', { ops: [{ op: 'rule.add', text: '提交前跑测试', group: '流程' }] })
    await f.command('board', '约定')
    expect(f.messages).toHaveLength(1)
    expect(f.messages[0].content).toContain('提交前跑测试')
    expect(f.messages[0].display).toBe(true)
    await f.command('board', '')
    expect(f.notices.at(-1)).toBe('已收起看板')
    await f.command('board', '')
    expect(f.notices.at(-1)).toBe('已打开看板')
  })

  test('without a board it says how to create one', async () => {
    const f = await make({ board: false })
    await f.command('board', '约定')
    expect(f.messages[0].content).toContain('/board init')
  })

  test('argument completion offers the subcommands', async () => {
    const f = await make()
    const c = f.commands.get('board').getArgumentCompletions
    expect(c('决').map((x: any) => x.value)).toEqual(['决策'])
    expect(c('zzz')).toBeNull()
  })
})

describe('widget', () => {
  test('in the terminal a board gets one widget above the editor, drawn from the file', async () => {
    const f = await make({ mode: 'tui' })
    expect(f.widgets).toHaveLength(1)
    expect(f.widgets[0]?.key).toBe('project-board')
    const factory = f.widgets[0]?.content as (tui: unknown, theme: unknown) => { render(w: number): string[] }
    const comp = factory({ requestRender: () => undefined, terminal: { columns: 90, rows: 50 } }, { appearance: 'dark' })
    const text = (): string => comp.render(80).join('\n').replace(/\x1b\[[0-9;]*m/g, '')
    expect(text()).toContain('看板 · demo')
    await f.call('board_update', { ops: [{ op: 'rule.add', text: 'x' }] })
    expect(comp.render(80).length).toBeGreaterThan(3)
  })

  test('no UI, no widget; no board, no widget', async () => {
    expect((await make({ mode: 'print' })).widgets).toHaveLength(0)
    expect((await make({ mode: 'tui', board: false })).widgets).toHaveLength(0)
  })

  test('a board created later gets its widget then', async () => {
    const f = await make({ mode: 'tui', board: false })
    await f.command('board', 'init')
    expect(f.widgets.filter(w => w.content !== undefined)).toHaveLength(1)
  })

  test('shutdown takes the widget down', async () => {
    const f = await make({ mode: 'tui' })
    await f.fire('session_shutdown', { reason: 'quit' })
    expect(f.widgets.at(-1)).toEqual({ key: 'project-board', content: undefined })
  })
})
