import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { RULES_TEXT, SNAPSHOT_LIMIT, buildSnapshot } from '../hooks/model/summary'
import { parseBoard } from '../hooks/model/parse'
import type { Board } from '../hooks/model/types'
import { briefTitle } from '../hooks/sprints'
import { toolSpecs } from '../hooks/tools'

const PROJ = '/proj'
const BOARD = `${PROJ}/ai/board.json`
const ACTIVE = `${PROJ}/ai/sprints/active`
const START = { cwd: PROJ, surface: 'terminal' as const, isInteractive: true }

/** Files in memory; fs.list answers from the same map, the way a real directory would. */
function world(on: On, seed: Record<string, string> = {}): Map<string, string> {
  const files = new Map<string, string>(Object.entries(seed))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: PROJ }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', (_$, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.stat', (_$, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: t.length, mtimeMs: 1, isLink: false } }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const kinds = new Map<string, 'file' | 'dir'>()
    for (const f of files.keys()) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const i = rest.indexOf('/')
      kinds.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
    }
    if (kinds.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...kinds].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__project-board__${e.name}` } }))
  return files
}

const boardOf = (files: Map<string, string>): Board => {
  const r = parseBoard(files.get(BOARD) ?? '')
  if (!r.ok) throw new Error(r.error)
  return r.board
}
const initTool = async ($: any, input: Record<string, unknown> = {}): Promise<Record<string, any>> =>
  JSON.parse(((await $.tool.call({ tool: 'mcp__project-board__board_init', ...input } as never)) as { result: string }).result)

const TWO_SPRINTS = {
  [`${ACTIVE}/a/BRIEF.md`]: '# Sprint: 接入支付\n\n## 问题描述\n…',
  [`${ACTIVE}/a/PLAN.md`]: '# 计划\n## Step 1: x [ ]',
  [`${ACTIVE}/b/BRIEF.md`]: '# 重做登录页\n',
  [`${ACTIVE}/b/PLAN.md`]: '# 计划\n## Step 1: y [wip]',
}

describe('board_init with sprints in progress', () => {
  test('two sprints give two goal.create proposals, each linking its PLAN.md, and the answer says so', async ($, on) => {
    const files = world(on, TWO_SPRINTS)
    mock.clock(on)
    await $.session.start(START)
    const out = await initTool($)
    expect(out.ok).toBe(true)
    expect(out.message).toContain('发现 2 个进行中的 sprint，已为每个生成待确认的目标提议')
    const b = boardOf(files)
    expect(b.goals).toEqual([])
    expect(b.proposals.map(p => p.action)).toEqual(['goal.create', 'goal.create'])
    expect(b.proposals.map(p => p.payload.title)).toEqual(['接入支付', '重做登录页'])
    expect(b.proposals[0]?.payload.links).toEqual([{ type: 'path', kind: '方案', target: 'ai/sprints/active/a/PLAN.md', label: 'sprint 计划', forReview: false }])
    expect(b.proposals[1]?.payload.links).toMatchObject([{ target: 'ai/sprints/active/b/PLAN.md' }])
    expect(b.proposals[0]?.reason).toContain('进行中的 sprint')
  })

  test('without ai/sprints/active there are no proposals and the answer does not mention sprints', async ($, on) => {
    const files = world(on, { [`${PROJ}/README.md`]: 'x' })
    mock.clock(on)
    await $.session.start(START)
    const out = await initTool($)
    expect(out.ok).toBe(true)
    expect(out.message).not.toContain('sprint')
    expect(boardOf(files).proposals).toEqual([])
  })

  test('a sprint without BRIEF.md is named after its directory; files and dot-directories are ignored', async ($, on) => {
    const files = world(on, {
      [`${ACTIVE}/pay-flow/PLAN.md`]: '# 计划',
      [`${ACTIVE}/.hidden/PLAN.md`]: '# 计划',
      [`${ACTIVE}/NOTES.md`]: 'x',
    })
    mock.clock(on)
    await $.session.start(START)
    expect((await initTool($)).message).toContain('发现 1 个')
    const b = boardOf(files)
    expect(b.proposals.map(p => p.payload.title)).toEqual(['pay-flow'])
  })

  test('/board init does the same and tells the user', async ($, on) => {
    const files = world(on, TWO_SPRINTS)
    mock.clock(on)
    await $.session.start(START)
    const r = (await ($ as any).command.run({ command: 'board', args: 'init' })) as { text?: string }
    expect(r.text).toContain('已创建 ai/board.json')
    expect(r.text).toContain('发现 2 个进行中的 sprint，已为每个生成待确认的目标提议')
    expect(boardOf(files).proposals).toHaveLength(2)
  })
})

describe('/board init without sprints', () => {
  test('creates the board with no proposals and says nothing about sprints', async ($, on) => {
    const files = world(on, {})
    mock.clock(on)
    await $.session.start(START)
    const r = (await ($ as any).command.run({ command: 'board', args: 'init' })) as { text?: string }
    expect(r.text).toContain('已创建 ai/board.json')
    expect(r.text).not.toContain('sprint')
    expect(boardOf(files).proposals).toEqual([])
  })
})

describe('briefTitle', () => {
  test('takes the first heading without the Sprint: prefix, skips front matter, and is empty for a blank file', () => {
    expect(briefTitle('# Sprint: 接入支付\n正文')).toBe('接入支付')
    expect(briefTitle('---\nname: x\n---\n\n目标：登录页重做\n')).toBe('目标：登录页重做')
    expect(briefTitle('\n  \n')).toBe('')
  })
})

describe('sprint split in the rules text', () => {
  test('the system prompt rules and the board_update description both send sprint progress to PLAN.md', () => {
    expect(RULES_TEXT).toContain('ai/sprints/active/')
    expect(RULES_TEXT).toContain('sprint 内的执行进度只写该 sprint 的 PLAN.md')
    expect(RULES_TEXT).toContain('新开 sprint 时提议建对应目标')
    expect(RULES_TEXT).toContain('sprint 结束时提议关闭')
    const update = toolSpecs.find(t => t.name === 'board_update')?.description ?? ''
    expect(update).toContain('sprint 内的执行进度只写该 sprint 的 PLAN.md')
    expect(update).not.toContain('不写其他进度文件')
  })

  test('the longer rules still leave the snapshot inside its budget', () => {
    expect(RULES_TEXT.length).toBeLessThan(SNAPSHOT_LIMIT / 4)
  })
})
