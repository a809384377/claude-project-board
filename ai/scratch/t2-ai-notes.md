# 任务 2：AI 侧减负 交付记录

## 改了什么
- hooks/model/invariants.ts：删除「review 必须有入口」校验（noReviewTargetReason 字段保留读写，不再强制）。
- hooks/model/ops.ts：applyOps 成功后对比批量前后看板，追加 `kind: 'hint'` 事件，仅两种情况：
  1. 事项变为 review（新加或状态转入）且没有 forReview 入口：「事项「X」没有验收入口，用户无法从看板打开它」
  2. 已有 forReview 入口的事项新增了不同 target 的 forReview 入口：「事项「X」已有入口：A、B；不再需要的用 item.link.remove 移除」（A、B 为批量前的旧入口 target）
- hooks/model/diff.ts：describeChanges 按表收窄。保留：关注、目标新增/关闭/合并/暂停恢复/改名/移除、事项新增/删除/状态/换目标、步骤新增/删除、决策新增/被替代/恢复、约定新增/删除、提议出现/被处理。去掉：目标成果与关联、事项改名/换步骤/负责人/备注/等待/验收标准/关联、步骤改名/短名/说明/关联/换目标、决策文字修改、约定修改、资料全部、里程碑全部。
- hooks/sync.ts：ToolNames 去掉 edit；TurnCounter 只统计派 agent；verdict() 返回 `{ stale, agents }`；提醒文案「上一轮派了 N 个 agent，看板未更新；如有进展请补记」。
- pi/project-board.ts：PI_TOOLS 去掉 edit。
- hooks/tools.ts：UPDATE_DESCRIPTION 规则按新文本改写；成功结果说明里提到 kind=hint。
- hooks/model/summary.ts：RULES_TEXT 只留标题行和定位说明。

## 新规则全文（board_update 工具说明里的「工作规则」）
1. 项目状态记在看板，用看板工具读写。有进行中的 sprint（ai/sprints/active/）时，sprint 内的执行进度只写该 sprint 的 PLAN.md；看板上用它对应的目标记目标级状态、待验收节点和决策。新开 sprint 时提议建对应目标并挂 PLAN.md，sprint 结束时提议关闭。
2. 推进时随手更新事项；用户在对话里拍板时立即用 decision.add 记录（kind=user，附原话 quote）；用户改口时新增决策并用 supersedes 指向旧的。长期有效的约束同时用 rule.add 写进约定。事项标题不超过约 25 字，过程细节写进 note。
3. 事项进入 review（待用户过目）时挂上验收入口（forReview 关联），让用户能从看板直接打开。用户在对话里给出验收结论后，在同一次 board_update 里更新该事项状态（done，或回到 doing / 拆出修改事项）并移除不再需要的入口。
4、5 条未改。
RULES_TEXT 现为：「# 项目看板（ai/board.json，project-board 维护）」+「以下是会话开始时的看板快照；之后的变化随用户消息告知，最新内容用 board_get。」

## 子 agent 完成回合能否识别
结论：引擎层面能识别，但本任务不接入，提醒只按「派出」判断。
证据：.claude-plugin/types/claude-code/index.d.ts 的 PromptOrigin 有 `kind: 'task-notification'`（「A background task's notification, dequeued when the session went idle or delivered into a running turn」），出现在 `prompt.submit` 事件的 origin 上；`turn.start` 事件只有 { text, turnId }，不带 origin，需要在 prompt.submit 里记下「这次提交是 task-notification」再与随后的 turn.start 关联。接入点在 hooks/register.ts（任务边界禁止修改）；pi 侧没有对应的来源字段（agent_start 事件无来源）。若要接入需另开任务，并先定义「处理了 agent 结果却没写看板」的判据（该回合内主会话没有写看板 = 提醒），文案也要重新定。

## 测试
- `claude plugin test .`：522 通过，0 失败；`bun test pi/tests`：43 通过，0 失败。
- 新增/改写：model.test.ts（无入口 review 成功带 hint、有入口不带 hint、非 forReview 链接不算、已在 review 不重复提示、删最后入口允许、重复挂入口 hint 列旧入口且首个入口无 hint、换入口 hint）；sync.test.ts（只改文件不提醒、派 agent 未写看板提醒、派且写了不提醒、子 agent 派出不计、TurnCounter、describeChanges 去掉/保留各类抽查）；steps.test.ts（步骤改名/说明/换目标不再输出，新增/删除仍输出）；sprints.test.ts（sprint 规则改查 board_update 说明，RULES_TEXT 不再含 sprint）；pi/tests/index.spec.ts（只改文件不提醒、派 subagent 提醒新文案）。
- 因行为变化而必须改的其他测试：tests/view.test.tsx 的 makeStale 辅助函数由「两次 Edit」改为「两次 Agent 派出」；steps.test.ts 去掉 RULES_TEXT 含步骤规则的断言（规则只在工具说明里，原有对 update 描述的断言仍在）；sync.test.ts「外部变化」用例的外部写入由新增资料改为新增约定（资料变化已不通知）。
- 快照预算类用例（steps.test.ts 大步骤目标、sync.test.ts 目标配额）：RULES_TEXT 缩短约 700 字后，原夹具不再触发降级，夹具规模调大（15 步 × 8 项；25 目标 × 6 项）以继续覆盖降级路径，断言语义不变。
- 变异验证（临时破坏后确认变红，已恢复）：让 Edit 计入派 agent → 「只改文件不提醒」「Edit 不计」两条红；关掉 hint 的两种分支 → 4 条 model 用例红；diff 里加回「负责人」输出 → describeChanges 去掉类用例红。

## 本次新增的限制/校验/防御及其代价
- 无新增拦截或校验。反向：删除了「review 必须有入口」的拦截，改为 hint 提示。
- hint 只在 AI 本来就在调用的 board_update 返回里出现；代价是 events 里多一两行文字，仅在上述两种情况出现。
- 提醒收窄后，「改了很多文件却没记看板」不再提醒；这是设计决定（避免噪音），代价是纯手工改文件的进展不会被催记。
- 注意：types/index.d.ts 里 `stale` 字段的注释仍写「changed files or spawned agents」，该文件不在本任务边界内，需后续任务顺手改为「spawned agents」。
