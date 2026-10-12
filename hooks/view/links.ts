import type { Host } from '../host'
import type { Link } from '../model/types'

export type Platform = 'darwin' | 'linux'
export type LinkAction = {
  label: string
  kind: 'open' | 'vscode' | 'copy'
  argv?: string[]
  text?: string
  /** Absolute path that must exist before `argv` runs. */
  mustExist?: string
}

/** Absolute paths stay as they are, `~/` is the home directory, anything else is relative to the project root. */
export function resolveTarget(target: string, root: string, home = ''): string {
  if (target.startsWith('/')) return target
  if (home !== '' && (target === '~' || target.startsWith('~/'))) return home.replace(/\/+$/, '') + target.slice(1)
  const rel = target.replace(/^(\.\/)+/, '')
  return root.endsWith('/') ? root + rel : `${root}/${rel}`
}

const SAFE_WORD = /^[A-Za-z0-9_./@%+=:,-]+$/
const shellWord = (w: string): string => (SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

/**
 * `cd <relative path> && …` pasted into a fresh terminal starts from the home directory, so the path
 * becomes the absolute one under the project root. Anything else is copied as written.
 */
export function absoluteCd(command: string, root: string): string {
  const m = /^(\s*cd\s+)("([^"]*)"|'([^']*)'|[^\s;&|<>()$`"']+)(?=\s*(?:$|&&|;))/.exec(command)
  if (m === null || root === '') return command
  const arg = m[3] ?? m[4] ?? m[2] ?? ''
  if (arg === '' || arg === '-' || arg.startsWith('/') || arg.startsWith('~')) return command
  return `${m[1] ?? ''}${shellWord(resolveTarget(arg, root).replace(/\/+$/, ''))}${command.slice(m[0].length)}`
}

/** The buttons of one link. Arguments go to the program one by one, never through a shell. */
export function linkActions(link: Link, root: string, platform: Platform, hasCode: boolean, home = ''): LinkAction[] {
  const opener = platform === 'darwin' ? 'open' : 'xdg-open'
  switch (link.type) {
    case 'path': {
      const abs = resolveTarget(link.target, root, home)
      const out: LinkAction[] = [{ label: '打开', kind: 'open', argv: [opener, abs], mustExist: abs }]
      if (platform === 'darwin') out.push({ label: 'VS Code', kind: 'vscode', argv: ['open', '-a', 'Visual Studio Code', abs], mustExist: abs })
      else if (hasCode) out.push({ label: 'VS Code', kind: 'vscode', argv: ['code', abs], mustExist: abs })
      out.push({ label: '复制路径', kind: 'copy', text: abs })
      return out
    }
    case 'url':
      return [
        { label: '打开', kind: 'open', argv: [opener, link.target] },
        { label: '复制', kind: 'copy', text: link.target },
      ]
    case 'command':
      return [{ label: '复制命令', kind: 'copy', text: absoluteCd(link.target, root) }]
    case 'ref':
      return [{ label: '复制', kind: 'copy', text: link.target }]
  }
}

const envCache = new WeakMap<Host, Promise<{ platform: Platform; hasCode: boolean }>>()

/** Platform and, on Linux, whether a `code` command exists. Asked once per Host. */
export function detectEnv(host: Host): Promise<{ platform: Platform; hasCode: boolean }> {
  let p = envCache.get(host)
  if (p === undefined) {
    p = (async () => {
      const uname = await host.run(['uname', '-s']).catch(() => null)
      const platform: Platform = uname !== null && /linux/i.test(uname.stdout) ? 'linux' : 'darwin'
      if (platform === 'darwin') return { platform, hasCode: false }
      const which = await host.run(['which', 'code']).catch(() => null)
      return { platform, hasCode: which !== null && which.code === 0 }
    })()
    envCache.set(host, p)
  }
  return p
}

const shown = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * Runs one button. Open buttons that fail (no process support, missing program, non-zero exit)
 * fall back to copying the path; when copying fails too, the toast carries the full text.
 */
export async function pressLink(host: Host, a: LinkAction, surface: string): Promise<void> {
  if (a.kind === 'copy') {
    const text = a.text ?? ''
    const ok = await host.copy(text, surface).catch(() => false)
    host.toast(ok ? `已复制：${shown(text)}` : `复制失败，完整内容：${text}`)
    return
  }
  const argv = a.argv ?? []
  const target = argv[argv.length - 1] ?? ''
  if (a.mustExist !== undefined) {
    const there = await host.exists(a.mustExist).catch(() => true)
    if (!there) {
      host.toast(`文件不存在：${a.mustExist}`)
      return
    }
  }
  let why: string
  try {
    const r = await host.run(argv)
    if (r.code === 0) return
    why = r.stderr.trim() || `退出码 ${r.code}`
  } catch (e) {
    why = (e as Error).message
  }
  const copied = await host.copy(target, surface).catch(() => false)
  host.toast(copied ? `打开失败（${shown(why, 60)}），已把${target.startsWith('/') ? '路径' : '内容'}复制到剪贴板` : `打开失败（${shown(why, 60)}）。完整内容：${target}`)
}
