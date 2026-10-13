import { execFile, spawn } from 'node:child_process'
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Host, SyncState, ToolRegistration } from '../hooks/host'

/** What the node host needs from the running pi session. */
export type HostEnv = {
  cwd: string
  sessionId: () => string
  notify: (text: string) => void
  status: (text?: string) => void
  registerTool: (spec: ToolRegistration) => void
}

/** Runs argv without a shell. A non-zero exit is a result; only a failure to start rejects. */
function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    if (cmd === undefined) return reject(new Error('empty argv'))
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) return resolve({ code: 0, stdout, stderr })
      const code = (err as { code?: unknown }).code
      if (typeof code === 'number') return resolve({ code, stdout, stderr })
      reject(err)
    })
  })
}

/** Puts text on the system clipboard with whatever tool the machine has; false when none works. */
async function copyText(text: string): Promise<boolean> {
  const tools: string[][] = process.platform === 'darwin' ? [['pbcopy']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]
  for (const [cmd, ...args] of tools) {
    const ok = await new Promise<boolean>(resolve => {
      try {
        const child = spawn(cmd as string, args, { stdio: ['pipe', 'ignore', 'ignore'] })
        child.on('error', () => resolve(false))
        child.on('close', code => resolve(code === 0))
        child.stdin.on('error', () => resolve(false))
        child.stdin.end(text)
      } catch {
        resolve(false)
      }
    })
    if (ok) return true
  }
  return false
}

/**
 * The board logic's view of the machine, on node and pi. The per-conversation values (`getState`) live in
 * memory: they last as long as the pi session that made the host, which is as long as they are needed.
 */
export function nodeHost(env: HostEnv): Host {
  const state: SyncState = { snapshot: null, untold: [], stale: false, reminder: '' }
  return {
    readText: path => readFile(path, 'utf8'),
    // The engine's file write makes missing directories; so does this one (the first write of a board creates ai/).
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, 'utf8')
    },
    exists: path =>
      access(path).then(
        () => true,
        () => false,
      ),
    listDir: async path => (await readdir(path, { withFileTypes: true })).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' })),
    stat: path =>
      stat(path).then(
        s => ({ mtimeMs: s.mtimeMs }),
        () => null,
      ),
    run,
    root: async () => env.cwd,
    sessionId: async () => env.sessionId(),
    toast: text => env.notify(text),
    status: text => env.status(text),
    copy: text => copyText(text),
    now: async () => Date.now(),
    getState: async <K extends keyof SyncState>(key: K): Promise<SyncState[K]> => state[key],
    setState: async <K extends keyof SyncState>(key: K, value: SyncState[K]): Promise<void> => {
      state[key] = value
    },
    registerTool: async spec => env.registerTool(spec),
  }
}
