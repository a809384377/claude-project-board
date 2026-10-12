import { describe, expect, test } from 'claude-code/testing'
import type { Host } from '../hooks/host'
import type { Link } from '../hooks/model/types'
import { absoluteCd, detectEnv, linkActions, pressLink, resolveTarget } from '../hooks/view/links'

const link = (over: Partial<Link>): Link => ({ type: 'path', kind: '报告', target: 'ai/scratch/cars/施工报告.md', label: '', forReview: false, ...over })
const ROOT = '/home/me/Desktop/project/记账 小程序'

describe('linkActions', () => {
  test('a path with Chinese characters and spaces goes into argv as one element', () => {
    const acts = linkActions(link({ target: '/home/me/Desktop/project/记账小程序/ai/scratch/cars/导出 报告.md' }), ROOT, 'darwin', false)
    expect(acts.map(a => a.label)).toEqual(['打开', 'VS Code', '复制路径'])
    expect(acts[0]?.argv).toEqual(['open', '/home/me/Desktop/project/记账小程序/ai/scratch/cars/导出 报告.md'])
    expect(acts[1]?.argv).toEqual(['open', '-a', 'Visual Studio Code', '/home/me/Desktop/project/记账小程序/ai/scratch/cars/导出 报告.md'])
    expect(acts[2]).toMatchObject({ kind: 'copy', text: '/home/me/Desktop/project/记账小程序/ai/scratch/cars/导出 报告.md' })
  })

  test('a relative path is resolved against the project root, spaces and all', () => {
    const acts = linkActions(link({}), ROOT, 'darwin', false)
    expect(acts[0]?.argv).toEqual(['open', `${ROOT}/ai/scratch/cars/施工报告.md`])
    expect(resolveTarget('./a/b.md', '/r/')).toBe('/r/a/b.md')
    expect(resolveTarget('/abs/x', '/r')).toBe('/abs/x')
  })

  test('a folder opens like a file', () => {
    const acts = linkActions(link({ kind: '文件夹', target: 'ai/scratch/cars/' }), ROOT, 'darwin', false)
    expect(acts[0]?.argv).toEqual(['open', `${ROOT}/ai/scratch/cars/`])
  })

  test('url: open and copy; command and ref: copy only', () => {
    const url = linkActions(link({ type: 'url', kind: '链接', target: 'https://example.com/a b?x=1' }), ROOT, 'darwin', false)
    expect(url.map(a => [a.label, a.kind])).toEqual([['打开', 'open'], ['复制', 'copy']])
    expect(url[0]?.argv).toEqual(['open', 'https://example.com/a b?x=1'])
    expect(url[1]?.text).toBe('https://example.com/a b?x=1')
    const cmd = linkActions(link({ type: 'command', kind: '命令', target: 'bun run build --watch "x y"' }), ROOT, 'darwin', false)
    expect(cmd).toEqual([{ label: '复制命令', kind: 'copy', text: 'bun run build --watch "x y"' }])
    const ref = linkActions(link({ type: 'ref', kind: '提交', target: 'a48128f' }), ROOT, 'darwin', false)
    expect(ref).toEqual([{ label: '复制', kind: 'copy', text: 'a48128f' }])
  })

  test('linux: xdg-open, and a VS Code button only when the code command exists', () => {
    const without = linkActions(link({}), '/r', 'linux', false)
    expect(without.map(a => a.label)).toEqual(['打开', '复制路径'])
    expect(without[0]?.argv).toEqual(['xdg-open', '/r/ai/scratch/cars/施工报告.md'])
    const withCode = linkActions(link({}), '/r', 'linux', true)
    expect(withCode.map(a => a.label)).toEqual(['打开', 'VS Code', '复制路径'])
    expect(withCode[1]?.argv).toEqual(['code', '/r/ai/scratch/cars/施工报告.md'])
  })
})

describe('~ paths', () => {
  test('resolveTarget expands ~ and ~/ to the home directory, and leaves it alone when the home is unknown', () => {
    expect(resolveTarget('~/Desktop/a b.md', '/r', '/home/me')).toBe('/home/me/Desktop/a b.md')
    expect(resolveTarget('~/x', '/r', '/home/me/')).toBe('/home/me/x')
    expect(resolveTarget('~', '/r', '/home/me')).toBe('/home/me')
    expect(resolveTarget('~x/y', '/r', '/home/me')).toBe('/r/~x/y')
    expect(resolveTarget('~/x', '/r')).toBe('/r/~/x')
  })

  test('open, VS Code, copy and the existence check all get the expanded path', () => {
    const acts = linkActions(link({ target: '~/Desktop/记账小程序/报告.md' }), ROOT, 'darwin', false, '/home/me')
    const abs = '/home/me/Desktop/记账小程序/报告.md'
    expect(acts[0]).toMatchObject({ argv: ['open', abs], mustExist: abs })
    expect(acts[1]).toMatchObject({ argv: ['open', '-a', 'Visual Studio Code', abs], mustExist: abs })
    expect(acts[2]).toMatchObject({ kind: 'copy', text: abs })
  })
})

describe('copying a command that starts with cd', () => {
  const root = '/home/me/Desktop/project/记账 小程序'
  test('a relative path becomes the absolute one under the project root, quoted when it needs it', () => {
    expect(absoluteCd('cd app/web && npm run dev', root)).toBe("cd '/home/me/Desktop/project/记账 小程序/app/web' && npm run dev")
    expect(absoluteCd('cd web && npm run dev', '/r')).toBe('cd /r/web && npm run dev')
    expect(absoluteCd('cd ./web/ ; ls', '/r')).toBe('cd /r/web ; ls')
    expect(absoluteCd('cd "my app" && ls', '/r')).toBe("cd '/r/my app' && ls")
    expect(absoluteCd("cd 'a b'", '/r')).toBe("cd '/r/a b'")
  })

  test('a quote inside the path is escaped', () => {
    expect(absoluteCd('cd it\'s', '/r').startsWith('cd ')).toBe(true)
    expect(absoluteCd('cd "it\'s" && ls', '/r')).toBe("cd '/r/it'\\''s' && ls")
  })

  test('absolute and ~ paths, other commands, and later cd calls are copied as written', () => {
    expect(absoluteCd('cd /abs/x && ls', root)).toBe('cd /abs/x && ls')
    expect(absoluteCd('cd ~/x && ls', root)).toBe('cd ~/x && ls')
    expect(absoluteCd('npm run dev', root)).toBe('npm run dev')
    expect(absoluteCd('cd a && cd b', '/r')).toBe('cd /r/a && cd b')
    expect(absoluteCd('cd $(pwd)/x', '/r')).toBe('cd $(pwd)/x')
    expect(absoluteCd('cd -', '/r')).toBe('cd -')
    expect(absoluteCd('cd web', '')).toBe('cd web')
  })

  test('the copy button carries the rewritten command', () => {
    const [copy] = linkActions(link({ type: 'command', kind: '命令', target: 'cd app/web && npm run dev' }), root, 'darwin', false)
    expect(copy).toEqual({ label: '复制命令', kind: 'copy', text: "cd '/home/me/Desktop/project/记账 小程序/app/web' && npm run dev" })
  })
})

type Spy = { runs: string[][]; copies: Array<{ text: string; surface: string | undefined }>; toasts: string[] }
function fakeHost(over: { run?: Host['run']; copy?: Host['copy']; exists?: boolean }): Host & { spy: Spy } {
  const spy: Spy = { runs: [], copies: [], toasts: [] }
  const host = {
    spy,
    run: async (argv: string[]) => {
      spy.runs.push([...argv])
      return over.run ? over.run(argv) : { code: 0, stdout: '', stderr: '' }
    },
    copy: async (text: string, surface?: string) => {
      spy.copies.push({ text, surface })
      return over.copy ? over.copy(text, surface) : true
    },
    exists: async () => over.exists ?? true,
    toast: (t: string) => void spy.toasts.push(t),
  }
  return host as unknown as Host & { spy: Spy }
}
const OPEN = { label: '打开', kind: 'open' as const, argv: ['open', '/r/导出 报告.md'], mustExist: '/r/导出 报告.md' }

describe('pressLink', () => {
  test('open runs the argv as given, nothing else', async () => {
    const h = fakeHost({})
    await pressLink(h, OPEN, 'terminal')
    expect(h.spy.runs).toEqual([['open', '/r/导出 报告.md']])
    expect(h.spy.toasts).toEqual([])
    expect(h.spy.copies).toEqual([])
  })

  test('a missing file is reported and nothing is run', async () => {
    const h = fakeHost({ exists: false })
    await pressLink(h, OPEN, 'terminal')
    expect(h.spy.runs).toEqual([])
    expect(h.spy.toasts).toEqual(['文件不存在：/r/导出 报告.md'])
  })

  test('a failing open falls back to copying the path', async () => {
    const h = fakeHost({ run: async () => ({ code: 1, stdout: '', stderr: 'Unable to find application' }) })
    await pressLink(h, OPEN, 'desktop')
    expect(h.spy.copies).toEqual([{ text: '/r/导出 报告.md', surface: 'desktop' }])
    expect(h.spy.toasts).toHaveLength(1)
    expect(h.spy.toasts[0]).toContain('Unable to find application')
    expect(h.spy.toasts[0]).toContain('已把路径复制到剪贴板')
  })

  test('an open that cannot run at all (no process support) falls back the same way', async () => {
    const h = fakeHost({
      run: async () => {
        throw new Error('process.run is not available here')
      },
    })
    await pressLink(h, OPEN, 'terminal')
    expect(h.spy.copies).toHaveLength(1)
    expect(h.spy.toasts[0]).toContain('process.run is not available here')
  })

  test('when copying fails too, the toast carries the full path', async () => {
    const h = fakeHost({ run: async () => ({ code: 1, stdout: '', stderr: '' }), copy: async () => false })
    await pressLink(h, OPEN, 'terminal')
    expect(h.spy.toasts[0]).toContain('完整内容：/r/导出 报告.md')
  })

  test('copy buttons report success and failure; the surface is passed on', async () => {
    const ok = fakeHost({})
    await pressLink(ok, { label: '复制路径', kind: 'copy', text: '/r/a b.md' }, 'terminal')
    expect(ok.spy.copies).toEqual([{ text: '/r/a b.md', surface: 'terminal' }])
    expect(ok.spy.toasts).toEqual(['已复制：/r/a b.md'])
    const bad = fakeHost({ copy: async () => false })
    await pressLink(bad, { label: '复制命令', kind: 'copy', text: 'bun run x' }, 'terminal')
    expect(bad.spy.toasts).toEqual(['复制失败，完整内容：bun run x'])
  })
})

describe('detectEnv', () => {
  test('darwin by default; linux checks for the code command once', async () => {
    const mac = fakeHost({ run: async () => ({ code: 0, stdout: 'Darwin\n', stderr: '' }) })
    expect(await detectEnv(mac)).toEqual({ platform: 'darwin', hasCode: false })
    expect(mac.spy.runs).toEqual([['uname', '-s']])
    const lin = fakeHost({ run: async argv => (argv[0] === 'uname' ? { code: 0, stdout: 'Linux\n', stderr: '' } : { code: 1, stdout: '', stderr: '' }) })
    expect(await detectEnv(lin)).toEqual({ platform: 'linux', hasCode: false })
    await detectEnv(lin)
    expect(lin.spy.runs).toEqual([['uname', '-s'], ['which', 'code']])
    const unknown = fakeHost({ run: async () => Promise.reject(new Error('no process')) })
    expect(await detectEnv(unknown)).toEqual({ platform: 'darwin', hasCode: false })
  })
})
