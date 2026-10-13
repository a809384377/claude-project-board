import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

import type { ToolRegistration } from '../hooks/host'

const LABEL: Record<string, string> = { board_get: '读看板', board_update: '改看板', board_propose: '提议', board_init: '创建看板' }
const SNIPPET: Record<string, string> = {
  board_get: 'Read the project board (ai/board.json): goals, steps, items, decisions, rules, notes',
  board_update: 'Update the project board: item status, steps, decisions, rules, notes (atomic batch)',
  board_propose: 'Propose goal/focus changes on the project board; the user must confirm them',
  board_init: 'Create the project board ai/board.json (only when the user asks)',
}

/** Runs one board tool call; resolves to the tool's JSON text. */
export type RunTool = (name: string, input: Record<string, unknown>) => Promise<string>

/**
 * A board tool as pi's tool definition. The schemas are the same JSON schemas the Claude Code plugin
 * declares; a failed call (`ok: false`) throws, so pi marks the result as an error and the model sees the reason.
 */
export function toolDefinition(spec: ToolRegistration, run: RunTool): ToolDefinition {
  return {
    name: spec.name,
    label: LABEL[spec.name] ?? spec.name,
    description: spec.description,
    promptSnippet: SNIPPET[spec.name],
    parameters: spec.inputSchema as never,
    exposure: spec.isDeferred ? 'deferred' : 'direct',
    // The store serializes writes, but one call should see the board as the previous one left it.
    executionMode: 'sequential',
    async execute(_id, params) {
      const text = await run(spec.name, (params ?? {}) as Record<string, unknown>)
      let ok = true
      try {
        ok = (JSON.parse(text) as { ok?: unknown }).ok !== false
      } catch {
        // not JSON: hand it over as it is
      }
      if (!ok) throw new Error(text)
      return { content: [{ type: 'text', text }], details: undefined }
    },
  } as ToolDefinition
}
