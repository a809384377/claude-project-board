import type { Host } from './host'

/** An in-progress pflow sprint found under ai/sprints/active/. */
export type Sprint = {
  /** Directory name. */
  name: string
  /** The goal title: BRIEF.md's heading or first line, else the directory name. */
  title: string
  /** PLAN.md's path relative to the project root. */
  planPath: string
}

const ACTIVE_REL = 'ai/sprints/active'
const TITLE_LIMIT = 80

const join = (dir: string, rel: string): string => (dir.endsWith('/') ? dir + rel : `${dir}/${rel}`)

/** The first heading (else the first non-empty line) of a BRIEF.md, without "Sprint:" and markdown marks; '' when there is none. */
export function briefTitle(text: string): string {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  let i = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) i = end + 1
  }
  for (; i < lines.length; i++) {
    const t = (lines[i] ?? '')
      .replace(/^\s*(?:#+|[-*>]+)\s*/, '')
      .replace(/^sprint\s*[:：]\s*/i, '')
      .trim()
    if (t !== '') return t.length > TITLE_LIMIT ? `${t.slice(0, TITLE_LIMIT - 1)}…` : t
  }
  return ''
}

/**
 * The sprints in progress under `root`, by directory name. A missing directory, an unreadable listing or
 * an unreadable BRIEF.md all come back as "nothing to report" for that part: this is a convenience on top of init.
 */
export async function activeSprints(host: Host, root: string): Promise<Sprint[]> {
  const entries = await host.listDir(join(root, ACTIVE_REL)).catch(() => [])
  const out: Sprint[] = []
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.kind !== 'dir' || e.name.startsWith('.')) continue
    const brief = await host.readText(join(root, `${ACTIVE_REL}/${e.name}/BRIEF.md`)).catch(() => '')
    out.push({ name: e.name, title: briefTitle(brief) || e.name, planPath: `${ACTIVE_REL}/${e.name}/PLAN.md` })
  }
  return out
}

/** Payload and reason of the goal.create proposal for a sprint. */
export function sprintProposal(s: Sprint): { payload: Record<string, unknown>; reason: string } {
  return {
    payload: { title: s.title, links: [{ type: 'path', kind: '方案', target: s.planPath, label: 'sprint 计划' }] },
    reason: `来自进行中的 sprint：${s.name}`,
  }
}

/** The sentence that tells Claude or the user what init found; '' when there is no sprint. */
export function sprintNotice(n: number): string {
  return n > 0 ? `发现 ${n} 个进行中的 sprint，已为每个生成待确认的目标提议。` : ''
}
