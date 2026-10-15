# 「待你看」与 AI 减负 · 实施计划

> 执行者：按任务顺序推进，每个任务结束时两套测试都要全绿。用 superpowers:subagent-driven-development 或 superpowers:executing-plans 执行。

**目标**：「待验收」改为只提醒、只跳转的「待你看」，看过和隐藏只记在本机；收窄 AI 接收的信息；看板减负。

**设计**：`docs/superpowers/specs/2026-10-15-review-and-ai-load-design.html`（行为、文案、取舍以它为准，本计划只补实现要点）

**技术栈**：TypeScript mod（`claude-code` 引擎接口），pi 适配层复用 `hooks/view/board.tsx`（生成到 `pi/gen/board.js`）。

**测试命令**：`claude plugin test .`（基线 489 通过）、`bun test pi/tests`（基线 43 通过）。改了 `board.tsx` 后先跑 `bun pi/scripts/gen-board.ts`。

**分支**：在 `feat/review-and-ai-load` 上做，每个任务一次提交。

## 全局约束

- `ai/board.json` 格式不变，不升 schema，不新增字段。
- 界面文案以设计文档为准：「待你看」「看过了」「已看」「▸ 已隐藏 N 条」「恢复」「也可以在对话里直接说」「别的会话 · MM-DD HH:mm」「可能已停」。
- 「可能已停」阈值 12 小时；标题长度规则「约 25 字」。
- 提醒文字：「上一轮派了 N 个 agent，看板未更新；如有进展请补记」。
- 本机视图状态的路径：`<HOME>/.cache/project-board/view/<16 位 hex>.json`。哈希用纯 TS 写（mod 里不能 import node 模块），可参考 `hooks/view/motion.ts` 的 `hashOf`。
- 代码注释与测试名沿用仓库风格（英文注释、英文测试名、中文文案）。

## 重点检查项（测试必须覆盖）

1. Claude Code 和 pi 同时开着同一个项目：两边都点「看过了」或 [×] 时，不能互相覆盖对方的记录（写入前重新读文件再合并）。
2. 事项在 review 但没有任何验收入口（现在允许了）：照样出现在「待你看」，能点「看过了」。
3. 一个事项的验收入口全部被 [×] 隐藏：视同已看，离开「待你看」。AI 新挂一个入口后重新出现。
4. 本机状态文件损坏或无法写入：看板照常显示，只 toast 一次，本会话内的已看 / 隐藏仍然生效。
5. 同一个文件同时挂在目标和事项上：隐藏只对点了 [×] 的那一处生效。

---

### 任务 1：本机视图状态模块

**新建** `hooks/view/local.ts` 和 `tests/local.test.ts`。

对外接口（后续任务依赖这些名字）：

```ts
export type LocalView = { seen: Record<string, string>; hidden: Record<string, string[]> }
export const EMPTY_LOCAL: LocalView
export function localPath(home: string, root: string): string
export function reviewPrint(it: Item): string               // `${reportedAt}|${forReview target 排序后连接的哈希}`
export function isWaiting(lv: LocalView, it: Item): boolean // status=review，指纹未看过，且不是「入口全部被隐藏」
export function visibleLinks(lv: LocalView, ownerId: string, links: readonly Link[]): Link[]
export function hiddenLinks(lv: LocalView, ownerId: string, links: readonly Link[]): Link[]
export function markSeen(lv: LocalView, it: Item): LocalView
export function hideLink(lv: LocalView, ownerId: string, target: string): LocalView
export function unhideLink(lv: LocalView, ownerId: string, target: string): LocalView
export class LocalStore {
  constructor(host: Pick<Host, 'readText' | 'writeText' | 'toast'>)
  load(path: string): Promise<void>      // 同一路径只读一次；文件不存在 = 空；损坏 = 空 + toast
  get(path: string): LocalView           // 还没加载时返回 EMPTY_LOCAL
  update(path: string, fn: (v: LocalView) => LocalView): Promise<void> // 先重读文件，应用 fn，再写回
}
```

**先验证写入位置**：用本仓库的插件起一次真实 Claude Code 会话（`claude --plugin-dir <仓库路径>`，或按 README 的本地安装方式），确认 `$.fs.write` 能写到 `~/.cache/...`。**写不了就停下来回报**，不要自行把文件挪进项目目录。

**测试**：指纹相同 / 不同、`reportedAt` 变化后重新出现、入口集合变化后重新出现、全部入口隐藏视同已看、无入口的 review 事项、损坏文件、写入前重读合并（重点检查项 1、4）。

### 任务 2：AI 侧减负

- `hooks/model/invariants.ts`：删掉「review 必须有入口」的校验。
- `hooks/model/ops.ts`：`applyOps` 成功后，对比批量执行前后的看板，追加 `kind: 'hint'` 事件（文案见设计文档）：
  - 事项变成 review 但没有 forReview 入口时提示。
  - 已有 forReview 入口的事项又新增了 forReview 入口时，列出旧入口提示。
- `hooks/model/diff.ts`：按设计文档的「保留 / 去掉」表收窄 `describeChanges`。
- `hooks/sync.ts`：`TurnCounter` 只统计派 agent，`ToolNames` 去掉 `edit`；`verdict()` 返回 `{ stale, agents }`；提醒改用新文案。同步改 `pi/project-board.ts` 里的 `PI_TOOLS`。如果引擎能识别「由子 agent 完成通知触发的回合」，就把这种回合也算进去；识别不了就只按派出算，并在交付报告里写明。
- `hooks/tools.ts`、`hooks/model/summary.ts`：
  - 工作规则只保留 `UPDATE_DESCRIPTION` 里的那一份，并把 `RULES_TEXT` 独有的 sprint 那句并进第 1 条。
  - 删掉 delegated 规则，`kind` 枚举里保留 `delegated`。
  - 第 2 条加标题长度规则；第 3 条改写，并加上「结论出来后收拾入口」。
  - `RULES_TEXT` 只留标题和一句定位说明。
- 测试要改的：
  - `tests/model.test.ts`：invariants 一组里原来断言「review 没入口就失败」的用例，改为断言「成功并带 hint」。
  - `tests/sync.test.ts`：提醒相关用例改为「只改文件不提醒」「派 agent 未写看板提醒」；补 describeChanges 去掉类别的用例。
  - `pi/tests/index.spec.ts`：bookkeeping reminder 一组同样调整。
  - 断言 `RULES_TEXT` 的用例随新文本调整。

### 任务 3：看板界面

`hooks/view/board.tsx`、`derive.ts`、`text.ts`、`effects.ts`、`ticker.ts`、`hooks/register.ts`、`pi/ui/state.ts`。

- **接口调整**：
  - `ViewModel` 去掉 `stamps`，加 `local: LocalView` 和 `hover: boolean`（Claude Code 终端为 true，pi 和其他界面为 false）。
  - `Actions` 去掉 `approveItem`，加 `markSeen(itemId)`、`hideLink(ownerId, target)`、`unhideLink(ownerId, target)`；这三个由 register.ts / pi state 用 `LocalStore` 实现，不经过 store。
  - `StoreActions` 相应排除这三个动作。
- **derive / text**：`reviewItems`、`boardCounts`、`shownLinks`、`entryText` 都接收 `LocalView`，只统计、只显示未收起的事项和未隐藏的入口。`entryText` 里的「待验收」改为「待你看」。计数药丸、吉祥物「等你」姿势、`continuous` 都跟着变。
- **待你看区块**：每行显示标题、目标 › 步骤、相对时间（取 `reportedAt` 和 `vm.now`；`now` 为 0 时不显示时间）、`[看过了]`（key `seen:<id>`）。下面列出可见的入口。
- **事项行**：
  - 一行截断，行尾短标签依次是 `@owner`、`等：<12 字>`、别的会话的在跑标签或「可能已停」。
  - 已看的 review 事项图标为 `◇`、变暗、行尾标「已看」。
  - 原来的 subline 内容（依赖、备注、完整的等待事项、验收标准）移进点开后的详情。
- **关联行**：
  - 文件名本身是「打开」按钮，command / ref 类型除外。
  - 支持 hover 时，VS Code、复制、`[×]` 悬停才出现（照搬「设为关注」的写法）；不支持时常驻显示 `[复制] [×]`。
  - 每个所属对象下面加「▸ 已隐藏 N 条」折叠行（展开状态记在 expanded，key 为 `hidden:<ownerId>`），展开后每条带 `[恢复]`。
- **其他**：
  - 非焦点目标的资料一律折叠，焦点目标保留 3 条内联；步骤资料不变。
  - 没有事项的步骤不渲染标题行；但步骤自己挂着资料时照常渲染，否则资料会无处显示。
  - 提议卡片底部加提示行。
  - 删掉盖章相关的全部代码：`approveEl`、`STAMP_MS`、stamps、`textSignature` 的 stamps 参数、`deriveEffects` 里 user review→done 的特例。
- **测试**：
  - 删掉或改写依赖「验收通过」和盖章的用例：`tests/view.test.tsx` 的 board buttons 两条、「待你处理」一组、「pressing 验收通过 answers at once」整组、one-off effects 里的 stamp 两条、「上次报告在跑」那条；`tests/effects.test.ts` 的 textSignature；`pi/tests/engine.spec.ts` 第 98–99 行。
  - 补上设计文档「测试 · 视图」列出的各项，以及重点检查项 2、3、5。
  - 「可能已停」的用例用 `isoLocal(await $.clock.now() - 13h)` 构造。
- 跑 `bun pi/scripts/gen-board.ts`，再跑两套测试。

### 任务 4：`/board` 列表命令只显示不进上下文

查清两个宿主：

- pi：`sendMessage` 的显示型消息会不会进入模型上下文，有没有只显示的替代方式（通知、widget）。
- Claude Code：命令输出有没有不进上下文的选项。

能做到就改，并补测试；做不到就保持现状，在 README 写明输出会进入对话，并在交付报告里说明查证依据。

### 任务 5：README 与收尾

- README 更新：「看板怎么看」（待你看、看过了、[×] / 恢复）、「Claude 怎么用它」（结论在对话里给、提醒规则）、「会读写什么」（本机状态文件的位置）、pi 一节里「验收通过」的说明，以及把「点按钮验收」相关的句子全部删除。改完后全文通读一遍，确认没有遗留旧说法。
- 两套测试全量通过。
- 在 Claude Code 和 pi 里各真机走一遍：AI 交一个待你看 → 看过了 → AI 再挂新入口后重新出现 → [×] 隐藏 → 恢复。截一张图附在交付报告里。
- 派一次独立审查（opus）看整条分支，核实后只修必修项。
