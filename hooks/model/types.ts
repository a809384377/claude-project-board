export const ITEM_STATUSES = ['todo', 'queued', 'doing', 'running', 'review', 'done', 'dropped'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export const LINK_TYPES = ['path', 'url', 'command', 'ref'] as const
export type LinkType = (typeof LINK_TYPES)[number]

export const MILESTONE_STATUSES = ['未开始', '进行中', '完成', '跳过'] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

export const PROPOSAL_ACTIONS = [
  'goal.create',
  'goal.update',
  'goal.close',
  'goal.merge',
  'goal.pause',
  'goal.resume',
  'focus.set',
] as const
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number]

export type Link = {
  type: LinkType
  kind: string
  target: string
  label: string
  forReview: boolean
  step?: number
}

export type Step = {
  id: string
  title: string
  /** Short name for the step bar; '' = derived from the title (see derive.ts). */
  label: string
  note: string
  links: Link[]
}

export type Item = {
  id: string
  title: string
  /** '' = not in any step; otherwise a step of the same goal. */
  stepId: string
  status: ItemStatus
  owner: string
  note: string
  waitingFor: string
  dependsOn: string[]
  scope: string[]
  acceptance: string
  links: Link[]
  noReviewTargetReason: string
  reportedAt: string
  session: string
  doneBy: '' | 'user' | 'claude'
  createdAt: string
  updatedAt: string
  doneAt: string
}

export type Goal = {
  id: string
  title: string
  outcome: string
  status: 'active' | 'paused'
  links: Link[]
  /** Ordered; [] for a goal without steps. */
  steps: Step[]
  items: Item[]
  confirmedBy?: 'conversation' | 'sidebar'
  quote?: string
  createdAt: string
  updatedAt: string
  /** Archived goals only. */
  closedAt?: string
  closeReason?: '完成' | '放弃'
}

export type Decision = {
  id: string
  date: string
  text: string
  kind: 'user' | 'delegated'
  /** Empty string = project-level. */
  goalId: string
  quote?: string
  supersedes?: string
  status: 'active' | 'superseded'
}

export type Rule = { id: string; text: string; group: string; fromDecision?: string }
export type Note = { id: string; title: string; text: string; group: string }
export type Gate = { date: string; name: string; result: string; points: string }
export type Milestone = { id: string; title: string; status: MilestoneStatus; note: string; gates: Gate[] }

export type Proposal = {
  id: string
  action: ProposalAction
  payload: Record<string, unknown>
  reason: string
  createdAt: string
}

/** Empty string means "not set" for goalId and mandate. */
export type Focus = { text: string; goalId: string; mandate: string; updatedAt: string }

export type Archive = { goals: Goal[]; decisions: Decision[] }

export type Board = {
  /** As read from the file; the file written follows `usesSteps` (see parse.ts). */
  schema: 1 | 2
  rev: number
  project: { name: string; type?: string }
  focus: Focus
  milestones: { enabled: boolean; items: Milestone[] }
  goals: Goal[]
  decisions: Decision[]
  rules: Rule[]
  notes: Note[]
  proposals: Proposal[]
  archive: Archive
}
