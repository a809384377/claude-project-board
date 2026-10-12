import { applyOps, type OpCtx } from './model/ops'
import { approve, executeDirect, propose } from './model/propose'
import { query, QueryError, SCOPES, type QueryArgs } from './model/query'
import { sprintNotice } from './sprints'
import { NOT_ENABLED, type BoardStore } from './store'

export type ToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isDeferred: boolean
}

export type ToolCtx = {
  store: BoardStore
  /** 'agent' when the call carries an agentId. */
  actor: 'main' | 'agent'
  session: string
  /** ISO timestamp with the local offset. */
  now: string
  toast: (text: string) => void
}

export const TOOL_NAMES = ['board_get', 'board_update', 'board_propose', 'board_init'] as const

const LINK_SHAPE = '{type: "path"|"url"|"command"|"ref", target, kind?, label?, forReview?, step?（数字：同一事项多个验收入口的先后顺序，与看板步骤无关）}'

const UPDATE_DESCRIPTION = `项目看板（ai/board.json）的记录工具：一批操作要么全部生效，要么全不生效。

工作规则：
1. 项目状态记在看板，用看板工具读写。有进行中的 sprint（ai/sprints/active/）时，sprint 内的执行进度只写该 sprint 的 PLAN.md；看板上用它对应的目标记目标级状态、待验收节点和决策。
2. 推进时随手更新事项；用户在对话里拍板时立即用 decision.add 记录（kind=user，附原话 quote）；你自己替用户做的非关键判断记 kind=delegated；用户改口时新增决策并用 supersedes 指向旧的。长期有效的约束同时用 rule.add 写进约定。
3. 事项进入 review（待验收）必须有验收入口：该事项至少一条 forReview=true 的关联（item.link.add 或 item.add 的 links），或填写 noReviewTargetReason 说明为什么没有可看的东西。
4. 目标与关注的变化先用 board_propose 提议；用户对一个具体方案明确说了同意（如「同意合并」「就按这个建」）才加 userConfirmed 与原话直接执行。用户只是提出整理、拆分、合并、新建之类的要求不算同意，先提议，等用户回应。
5. 目标是用户确认过的一件完整的事；为达成它的成果（outcome）而做的阶段，用 step.add 拆成步骤（如 A→B→C→D），事项用 stepId 挂到步骤上。步骤由你自己拆分、增删，不需要提议；成果之外的新事情，提议新目标。只有几件事的目标可以不拆步骤。sprint 对应的目标（挂着 PLAN.md 的）不拆步骤、不参与合并，步骤记在 PLAN.md。看板上几个目标其实是同一件事的不同阶段时，用 board_propose goal.merge 提议合并成一个目标。

操作（ops 数组，每项 {op, ...字段}）：
- item.add {goalId, stepId?, title, status?, owner?, note?, waitingFor?, dependsOn?[], scope?[], acceptance?, links?[], noReviewTargetReason?}  新增事项，id 由系统生成并在结果 events 里返回
- item.update {id, stepId?, title?, status?, owner?, note?, waitingFor?, dependsOn?[], scope?[], acceptance?, noReviewTargetReason?}  只改传入的字段；status 取 todo|queued|doing|running|review|done|dropped；stepId 必须是事项所在目标的步骤，传 "" 表示移出步骤
- item.move {id, goalId, stepId?}   item.remove {id}   移到别的目标时 stepId 默认置空，传了就必须是目的目标的步骤
- step.add {goalId, title, label?, note?, links?[], before?}  新增步骤，默认加在末尾；before 为同目标步骤 id 时插在它前面；label 是步骤条上的短名，不填则取标题开头的编号
- step.update {id, title?, label?, note?}   step.remove {id}（其中的事项改为未分步骤，不删除事项）
- step.link.add {id, link}   step.link.remove {id, target}
- item.link.add {id, link}   item.link.remove {id, target}
- goal.link.add {goalId, link}   goal.link.remove {goalId, target}
- decision.add {text, kind: user|delegated, goalId?, quote?, supersedes?}   decision.update {id, text?, quote?, goalId?, status?: active|superseded}
- rule.add {text, group?, fromDecision?}   rule.update {id, text?, group?, fromDecision?}   rule.remove {id}
- note.add {title, text?, group?}   note.update {id, title?, text?, group?}   note.remove {id}
- milestones.enable {enabled?}   milestone.add {title, status?, note?}   milestone.update {id, title?, status?, note?}   milestone.remove {id}   milestone.gate {id, name, result, date?, points?}
link = ${LINK_SHAPE}
  path 的 target 写相对项目根的路径、绝对路径或 ~ 开头的路径都可以。

注意：
- 新建、改标题、合并、关闭、暂停目标以及设置关注不在这里，用 board_propose。
- step.add 返回的步骤 id 在结果 events 里；同一批操作里新建的步骤，id 要等返回后才能用，所以「建步骤」与「挂事项」分两次调用。
- 操作（ops 里的每一项）出现未声明的字段会报错；传 id 的操作必须用已存在的 id。dependsOn 里的 id 必须是活动区里已有的事项；事项被删除或随目标关闭时，别的事项对它的依赖自动解除，结果 events 里有记录。
- 规则检查针对批量执行后的整个看板（不只是本批改到的事项），失败时返回第一条失败操作的序号 index 与原因 error，文件保持不变；按原因修正后整批重发。
- 成功时返回新 rev 与 events（含新建对象的 id）。`

const GET_DESCRIPTION = `读取项目看板。scope：
- summary：关注、里程碑、各目标及其步骤（含各步骤的完成数/总数、在跑数、待验收数）、未完成事项、待确认提议、各类条数（先看这个）
- goal {id}：一个目标的完整内容（含步骤与全部事项，事项带 stepId）；item {id}：一个事项的完整内容
- decisions {goalId?, includeSuperseded?}：决策日志，默认只含生效中的
- rules {group?}：约定；notes {group?, id?}：资料
- archive {keyword?}：已关闭的目标与决策；search {keyword}：全文搜索（含归档）。archive 与 search 每类最多返回 50 条，超出时用 keyword 缩小范围
返回 JSON 文本。`

const PROPOSE_DESCRIPTION = `提议目标与关注的变更。这些变更需要用户确认，不能用 board_update 直接改。
- 提议：{action, payload, reason?}，进入看板的待确认卡片，用户点「同意」后生效。action 与 payload：
  goal.create {title, outcome?, links?[]}；goal.update {goalId, title?, outcome?}（至少改一项）；goal.close {goalId, reason: "完成"|"放弃"}；goal.merge {title, goalIds[], outcome?}（把 2 个以上活动区目标合并成一个新目标，每个旧目标变成新目标的一个步骤，事项、决策、关注随之转移；暂停的目标合并后一并恢复）；goal.pause {goalId}；goal.resume {goalId}；focus.set {text, goalId?, mandate?}
- focus.set 是整体替换：没传的 goalId、mandate 会被清空，需要保留的值要重新传。
- goal.close 会把目标、其事项、步骤和相关决策移入归档；goal.close 与 goal.merge 都会删除引用相关目标的其他待确认提议（payload 的 goalId 或 goalIds 含该目标即算引用）。
- 用户已在对话里对这个具体方案明确说了同意：加 userConfirmed: true 与 quote（用户原话）直接执行，不经提议。用户只是提出要求（「整理一下看板」「拆一下」）不算同意，先提议。goal.merge、goal.close 执行后无法撤销，必须先提议。
- 执行已有提议：{approve: 提议 id, quote?}，只在用户已在对话里同意后使用，quote 填用户原话。
- userConfirmed 与 approve 只接受主会话；子 agent 只能提议。
成功返回 rev 与 events（提议的 id 在 events 里）；失败返回 error，文件不变。`

const INIT_DESCRIPTION = '在当前项目创建看板 ai/board.json。仅在用户明确要求时调用；创建后才有 board_get / board_update / board_propose。可选 name（项目名）、type（如 miniapp）。'

export const toolSpecs: ToolSpec[] = [
  {
    name: 'board_get',
    description: GET_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: [...SCOPES] },
        id: { type: 'string', description: 'goal / item / notes 的 id' },
        goalId: { type: 'string', description: 'decisions 按目标筛选' },
        group: { type: 'string', description: 'rules / notes 按分组筛选' },
        keyword: { type: 'string', description: 'archive / search 的关键词' },
        includeSuperseded: { type: 'boolean', description: 'decisions 是否包含已被替代的' },
      },
      required: ['scope'],
    },
    isDeferred: false,
  },
  {
    name: 'board_update',
    description: UPDATE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: '按顺序执行的操作',
          items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] },
        },
      },
      required: ['ops'],
    },
    isDeferred: false,
  },
  {
    name: 'board_propose',
    description: PROPOSE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['goal.create', 'goal.update', 'goal.close', 'goal.merge', 'goal.pause', 'goal.resume', 'focus.set'] },
        payload: { type: 'object' },
        reason: { type: 'string', description: '为什么提议，显示在卡片上' },
        approve: { type: 'string', description: '要执行的提议 id' },
        userConfirmed: { type: 'boolean', description: '用户已在对话里对这个具体方案明确说了同意，直接执行' },
        quote: { type: 'string', description: '用户原话' },
      },
    },
    isDeferred: false,
  },
  {
    name: 'board_init',
    description: INIT_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '项目名，缺省用目录名' },
        type: { type: 'string', description: '项目类型，如 miniapp；可不填' },
      },
    },
    isDeferred: true,
  },
]

/**
 * The tools to register. Without a board only board_init is offered (behind tool search), so projects
 * that do not use the board carry one line of cost; the other three appear once a board exists.
 */
export function specsFor(hasBoard: boolean): ToolSpec[] {
  return hasBoard ? toolSpecs : toolSpecs.filter(t => t.name === 'board_init')
}

const text = (o: unknown): string => JSON.stringify(o)
const err = (error: string, index?: number): string => text(index === undefined ? { ok: false, error } : { ok: false, error, index })

export async function handleTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const { store } = ctx
  const opCtx: OpCtx = { now: ctx.now, session: ctx.session, actor: ctx.actor }
  try {
    switch (name) {
      case 'board_get': {
        let cur = store.current()
        if (cur.board === null && cur.error === null) {
          await store.locate()
          cur = store.current()
        }
        if (cur.board === null) return err(cur.error ?? NOT_ENABLED)
        const { scope, id, goalId, group, keyword, includeSuperseded } = input
        if (typeof scope !== 'string') return err('缺少 scope')
        const args = { id, goalId, group, keyword, includeSuperseded } as QueryArgs
        try {
          return text({ ok: true, rev: cur.board.rev, scope, data: query(cur.board, scope, args) })
        } catch (e) {
          if (e instanceof QueryError) return err(e.message)
          throw e
        }
      }
      case 'board_update': {
        const ops = input.ops
        if (!Array.isArray(ops)) return err('ops 必须是数组', 0)
        if (ops.length === 0) return err('ops 不能为空', 0)
        const r = await store.commit(b => applyOps(b, ops, opCtx), ctx.actor)
        if (!r.ok) return err(r.reason, r.index)
        const decisions = r.events.filter(e => e.kind === 'decision.add')
        if (decisions.length > 0) ctx.toast(`已记录 ${decisions.length} 条决策：${decisions[0]?.summary ?? ''}`)
        return text({ ok: true, rev: r.rev, events: r.events })
      }
      case 'board_propose': {
        const quote = typeof input.quote === 'string' ? input.quote : ''
        let run: (b: Parameters<typeof propose>[0]) => ReturnType<typeof propose>
        if (input.approve !== undefined) {
          if (typeof input.approve !== 'string' || input.approve === '') return err('approve 必须是提议 id')
          if (input.action !== undefined) return err('approve 与 action 不能同时传')
          const id = input.approve
          run = b => approve(b, id, opCtx, 'conversation', quote)
        } else {
          if (typeof input.action !== 'string') return err('缺少 action（或用 approve 执行已有提议）')
          if (input.userConfirmed !== undefined && typeof input.userConfirmed !== 'boolean') return err('userConfirmed 必须是 true 或 false')
          const action = input.action
          if (input.userConfirmed === true) run = b => executeDirect(b, action, input.payload, quote, opCtx)
          else {
            const reason = typeof input.reason === 'string' ? input.reason : ''
            run = b => propose(b, action, input.payload, reason, opCtx)
          }
        }
        const r = await store.commit(run, ctx.actor)
        if (!r.ok) return err(r.reason, r.index)
        return text({ ok: true, rev: r.rev, events: r.events })
      }
      case 'board_init': {
        if (input.name !== undefined && typeof input.name !== 'string') return err('name 必须是字符串')
        if (input.type !== undefined && typeof input.type !== 'string') return err('type 必须是字符串')
        const made = await store.init(typeof input.name === 'string' ? input.name : '', typeof input.type === 'string' ? input.type : '')
        const cur = store.current()
        return text({ ok: true, rev: cur.board?.rev ?? 0, root: cur.root, message: `已创建 ai/board.json${made > 0 ? `。${sprintNotice(made)}` : ''}` })
      }
      default:
        return err(`未知工具：${name}`)
    }
  } catch (e) {
    return err((e as Error).message)
  }
}
