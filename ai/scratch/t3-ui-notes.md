# 任务 3 报告：看板界面改造

状态：完成。两套测试全绿：`claude plugin test .` 542 通过 / 0 失败；`bun test pi/tests` 46 通过 / 0 失败（`bun pi/scripts/gen-board.ts` 之后）。

## 改动清单

- `hooks/view/derive.ts`
  - `reviewItems(b, lv)`、`boardCounts(b, lv)`、`shownLinks(b, expanded, mode, lv)` 接收 `LocalView`：只算未收起的 review 事项（`isWaiting`），不检查被隐藏的关联。
  - `GOAL_LINKS_INLINE` 换成 `LINKS_INLINE = 3` + `goalLinksInline(b, g)`（焦点目标 3，其他目标 0 即一律折叠）；`linksOpen` 加 `inline` 参数，步骤仍是 3。
  - `itemOpen` 默认不展开（原来 review 事项默认展开）。见「偏离与自行判断」。
  - `reviewItems` 的 `pinned` 参数（盖章用）删除。
- `hooks/view/text.ts`：`entryText` 接收 `local`，「待验收 N」改为「待你看 N」，只计未收起的。
- `hooks/view/effects.ts`：`textSignature(fx, now)` 去掉 stamps；`deriveEffects` 删掉「用户按钮把 review 改 done 不亮行」的特例。
- `hooks/view/ticker.ts`：只改注释（去掉 stamp 字样）。
- `hooks/view/board.tsx`
  - `ViewModel` 去 `stamps`，加 `local`、`hover`；`Actions` 去 `approveItem`，加 `markSeen`、`hideLink`、`unhideLink`；`StoreActions` 排除这三个与 toggle 两个。
  - 删 `approveEl`、`STAMP_MS`、itemsGroup 里的 pinned、`makeActions.approveItem`。
  - 「待你看」区块：◆ 标题（单行截断）· 目标 › 步骤 · 相对时间（reportedAt 与 vm.now，now=0 或无时间不显示）· [看过了]（key `seen:<id>`）；下列可见的 forReview 入口（key `todo-link:<id>:<关联在事项里的原序号>`）；不放已隐藏折叠。
  - 事项行：一行，标题截断；行尾短标签依次 `@owner`、`等：<12 字>`、别的会话 `别的会话 · MM-DD HH:mm` 或超过 12 小时 `可能已停`；已看的 review 事项图标 ◇、变暗、行尾「已看」。依赖、备注、完整等待事项、验收标准、别的会话说明移进点开后的详情。
  - 关联行：文件名 / url 本身是打开按钮（key 仍是 `…:open`）；command / ref 没有可打开的东西，复制按钮常驻。hover 界面：VS Code、复制路径、[×] 放进 `display:none` + `hover:{display:flex}` 的绝对定位盒（照搬「设为关注」）；无 hover：常驻 `[复制] [×]`，不显示 VS Code。
  - 每个所属对象（目标 / 步骤 / 事项）下「▸ 已隐藏 N 条」（expanded key `hidden:<ownerId>`），展开每条带 [恢复]（key `restore:<ownerId>:<序号>`）。
  - 没有事项的步骤不渲染标题行（即使 expanded 里是展开的），步骤自己挂着资料时照常渲染。
  - 提议卡片底部加暗色「也可以在对话里直接说」。
- `hooks/register.ts`：`ViewState` 去 stamps，加 `local: LocalStore`；路径 `localPath($.env.get('HOME'), root)`；warm 里首次 `load`，missing 缓存的 key 加上 local；`actionsOf` 实现三个本机动作（`LocalStore.update` 后 `ui.invalidate`，不经 store）；`hover = surface === 'terminal'`；ticker 不再看 stamps。命令注册段未动。
- `pi/ui/state.ts`：同上接 `LocalStore`，路径 `localPath(homedir(), root)`；`hover: false`；首次读文件在 `localView()` 里发起、读完重画一次。`UiEnv` 加可选 `home`（缺省 `homedir()`），见下。
- `pi/gen/board.js`：生成脚本重新生成。

## 偏离设计 / 自行判断之处

1. **事项详情默认不展开（含 review 事项）**。原来 review 事项默认展开，入口会在「待你看」和事项下各出现一次；设计要求事项一行、详情点开才看。判断：与「一行一项减负」一致，入口在「待你看」里已经能打开。已看的 review 事项（离开了待你看）要点开才看到入口。
2. **command / ref 类关联的复制按钮常驻**（含有 hover 的终端）。设计只说「文件名是打开按钮，command/ref 除外」，没说它们的复制放哪；它们没有可打开的东西，复制是唯一用途，藏到悬停里会更难用。[×] 照常悬停才出现。
3. **无 hover 界面复制按钮统一叫「复制」**（设计写 `[复制] [×]`），command 保留「复制命令」以免和文件混淆；有 hover 时仍是原来的「复制路径」/「复制」/「复制命令」。
4. **「可能已停」只在 now≠0 时判断**：`vm.now = 0` 是静止帧（pi engine.spec 里的 vm），此时只显示「别的会话 · 时间」，不判断超时，也不显示相对时间。
5. **已看的 review 事项所在目标仍按 review 着色、默认展开**（`goalState` 是模型层的派生，没改）；步骤条上的 ◆ 也不变。只有计数药丸、吉祥物、入口行、`continuous` 跟着本机状态走。
6. **`pi/ui/state.ts` 的 `UiEnv` 加了可选 `home`**：Bun 的 `os.homedir()` 不读运行时改的 `$HOME`，pi 侧测试没法把本机状态文件引到临时目录（第一次跑测试时真的写进了我本机 `~/.cache/project-board/view/`，已删除，见下）。生产代码不传，仍是 `homedir()`。
7. 隐藏折叠在目标 / 步骤下的位置：与「资料」同一层，在可见关联之后；资料全被隐藏时只剩「▸ 已隐藏 N 条」一行。

## 删改的旧用例

- `tests/view.test.tsx`
  - 删：board buttons 的「验收通过 exists on review items only…」「验收通过 on an item that is no longer in review…」；`pressing 验收通过 answers at once` 整组（3 条）；one-off effects 的「the stamp goes ▓▓▓▓…」。
  - 改写：「上次报告在跑」那条 → 行尾「别的会话 · 10-10 21:30」，详情里「别的会话报告在跑 · … · 未核实」；「待你处理」一组 → 「待你看」（看过了按钮、入口带 hide 键、不再有任何 approve 键）；「waiting-for shows under the item」→ 行尾标签 + 提议卡片提示行；acceptance buttons 一组按 surface 区分有无 VS Code、多了 hide 键，事项入口要先点开事项；goal links 两条改成焦点目标 / 非焦点目标的折叠规则；entryText 文案；依赖测试先点开事项；用「验收通过」触发撒花的 3 条（step 撒花、目标撒花、motion off）改为 AI 通过 board_update 写 done；motion off 那条去掉盖章断言；颜色测试里的「待你处理」标题。
- `tests/effects.test.ts`：「a button of the user does not ripple…」两条合并改写为「review 变 done 谁写都亮行」；`textSignature` 用例去掉 stamps 参数，补撒花结束时签名变化。
- `tests/view-derive.test.ts`：boardCounts / shownLinks / reviewItems 传 LocalView；「review 事项默认展开」改为默认不展开；删 pinned 用例。
- `pi/tests/engine.spec.ts`：vm 去 stamps、加 local/hover；98–99 行改为断言「待你看」「[ 看过了 ]」、不含「验收通过」；entry 传 local。

## 新增用例

`tests/view.test.tsx`（两个 surface 各跑一遍的标 ×2）：
- 看过了：离开待你看、计数（desktop 文本药丸 ◆ 1→0）、事项行 ◇ + 变暗 + 已看、状态仍 review、board.json 一字不变、本机文件 `/home/me/.cache/project-board/view/<hash>.json` 写入、下一条用户消息无外部变化通知（×2）
- 重新出现：AI 再次设 review（reportedAt 变）、AI 挂新 forReview 入口（×2）
- [×]：同一文件同时挂在目标和事项上，只隐藏点的那一处；「▸ 已隐藏 1 条」→ 展开 → [恢复] 后重新显示；board.json 不变、无通知（×2）（重点检查项 5）
- 入口全部 [×] 视同已看；点开事项看到「已隐藏 2 条」；AI 新挂入口后重新出现（×2）（重点检查项 3）
- 无入口 review 事项进待你看、显示「2 小时前」、能点看过了（×2）（重点检查项 2）
- 关联按钮集合：终端 open/vscode/copy/hide 且在 hover 盒里；无 hover 只有 open/复制/×、无 VS Code、无 hover 属性（×2）
- 空步骤不渲染标题行（展开过也不）；只挂资料的步骤保留标题（×2）
- 非焦点目标资料一律折叠，焦点目标内联（×2）
- 本机文件首次绘制前读入（×2）
- pi 侧同时写过本机文件，这边写入时保留对方记录（×2）（重点检查项 1 在界面层）
- 本机文件损坏：看板照常、只 toast 一次、写不进去时看过了本会话仍生效（×2）（重点检查项 4）
- 事项一行：标题、@owner、等待事项截 12 字；备注 / 依赖 / 完整等待只在详情（×2）
- 「可能已停」：`isoLocal(clock.now() - 13h)` 构造；11 小时前的仍显示「别的会话 · 时间」（×2）
- 吉祥物：看过最后一个待看事项后不再是「等你」姿势
`tests/view-derive.test.ts`：已看 / 入口全隐藏不计数；隐藏关联不检查、同一文件挂在别的 owner 上不受影响；焦点 / 非焦点目标资料阈值。
`tests/effects.test.ts`：见上。
`pi/tests/engine.spec.ts`：无 hover 时 `[ 复制 ] [ × ]` 常驻、无 VS Code、按钮 key；有 hover 时 pi 只画名字。
`pi/tests/host.spec.ts`：pi 的 BoardUi 点「看过了」和 [×] 写到 home 下的本机文件，board.json 一字不变。

## 变红验证

逐条临时破坏实现、跑全量、确认变红、恢复（脚本自动还原，恢复后全绿）：

| 破坏 | 变红用例数 |
|---|---|
| reviewItems 不看本机状态 | 13 |
| 计数不看本机状态 | 3 |
| 被隐藏的关联照常列出 | 4 |
| 空步骤照常画标题 | 2 |
| 无 hover 也显示 VS Code | 3 |
| Claude Code 不传 hover | 9 |
| 看过了不写本机文件 | 15 |
| 去掉 12 小时判断 | 2 |
| 非焦点目标资料不折叠 | 5 |

## 测试数

- `claude plugin test .`：542 通过，0 失败（任务开始时基线 522；任务 2 已于 02895f7 提交，其改动包含在内）。
- `bun test pi/tests`：46 通过，0 失败（基线 43）。
- `bunx tsc --noEmit -p .` 通过。

## 本次新增的限制 / 校验 / 防御及其代价

- 无新增校验或防御。`markSeen` 找不到事项（点击后被删）时不写任何东西，这是动作本身的取值，不是额外检查。
- `UiEnv.home` 可选注入：只为测试能把文件引到临时目录；代价是一个可选字段，生产路径不变。

## 其他事项

- 第一次跑 pi 侧新测试时，因为 Bun 的 `homedir()` 不受运行时 `$HOME` 影响，测试往真实的 `~/.cache/project-board/view/b0e8c59c244c6e74.json` 写了一份（内容是测试数据 `i-1` / `g-1`）。已确认是本测试写的（时间、内容），删除了该文件和随之新建的两个空目录；之后改为注入 home，再跑没有写到真实目录。
- 未做：真机走查（任务 5）；README（任务 5）。

## 文本截图（pi 引擎按 tests/fixture-board.ts 画出，宽 72；为显示时间，把 review 事项与两个在跑事项的 reportedAt 设成了相对 now=2026-10-15 12:00 的值）

```
=== pi（无 hover）：初始 ===
看板 · 记账小程序 · 阶段：1 记账与统计
 ◆ 1  待你   ● 2  在跑   ○ 31  待办   ✓ 0  完成
★ 先把账单导出做完，再接图表的趋势折线
授权：导出相关改动可以直接做，做完请用户验收
╭──────────────────────────────────────────────────────────────────────╮
│ 待你看                                                               │
│ ◆ 月度支出饼图                        · 统计图表 2 小时前 [ 看过了 ] │
│   预览 饼图.html · 饼图预览                           [ 复制 ] [ × ] │
╰──────────────────────────────────────────────────────────────────────╯

▎ ▾ ★ 账单导出                                          ▱▱▱▱         0/4
    资料
      方案 导出方案.md · 导出的列与格式                   [ 复制 ] [ × ]
      命令 cd app && npm run dev · 启动开发服务       [ 复制命令 ] [ × ]
    ● 导出 CSV：按月份生成文件              @main 别的会话 · 10-15 09:30
    ⏸ 导出：大账本分批写入                       等：等 CSV 基础导出做完
    ○ 导出 CSV：金额列保留两位小数
    ○ 导出：分享到微信聊天

▎ ▾ 统计图表                               ▱▱▱▱▱        0/5 [ 设为关注 ]
    ▸ 资料 2 条
    ◆ 月度支出饼图
    ○ 趋势折线：近 6 个月
    ○ 图表空数据占位
    ○ 图表暗色模式配色
    ○ 图表可访问性：颜色之外加图案

▎ ▾ 云端同步                               ▱▱▱▱▱▱▱      0/7 [ 设为关注 ]
    ▸ 资料 1 条
    ● 登录后拉取云端账本                                  @main 可能已停
    ⏸ 换设备首次同步进度条                            等：等登录流程完成
    ○ 离线记账，联网后合并
    ○ 冲突提示：同一笔改动两处
    ○ 同步失败重试与提示
    ○ 同步日志页（给自己排查）
    ○ 云端账本备份与恢复

▎ ▸ 体验打磨                              ▱▱▱▱▱▱▱▱▱▱   0/10 [ 设为关注 ]

▎ ▸ 技术债与预算                           ▱▱▱▱▱▱▱▱     0/8 [ 设为关注 ]

▸ ⏸ 暂停 1 个目标 · 上架发布

=== Claude Code 终端（有 hover，指针不在行上）：初始 ===
看板 · 记账小程序 · 阶段：1 记账与统计
 ◆ 1  待你   ● 2  在跑   ○ 31  待办   ✓ 0  完成
★ 先把账单导出做完，再接图表的趋势折线
授权：导出相关改动可以直接做，做完请用户验收
╭──────────────────────────────────────────────────────────────────────╮
│ 待你看                                                               │
│ ◆ 月度支出饼图                        · 统计图表 2 小时前 [ 看过了 ] │
│   预览 饼图.html · 饼图预览                                          │
╰──────────────────────────────────────────────────────────────────────╯

▎ ▾ ★ 账单导出                                          ▱▱▱▱         0/4
    资料
      方案 导出方案.md · 导出的列与格式
      命令 cd app && npm run dev · 启动开发服务             [ 复制命令 ]
    ● 导出 CSV：按月份生成文件              @main 别的会话 · 10-15 09:30
    ⏸ 导出：大账本分批写入                       等：等 CSV 基础导出做完
    ○ 导出 CSV：金额列保留两位小数
    ○ 导出：分享到微信聊天

…（其余与上图相同）

=== pi：点了「看过了」，并对焦点目标的第一条资料点了 [×]，展开「已隐藏」 ===
看板 · 记账小程序 · 阶段：1 记账与统计
 ◆ 0  待你   ● 2  在跑   ○ 31  待办   ✓ 0  完成
★ 先把账单导出做完，再接图表的趋势折线
授权：导出相关改动可以直接做，做完请用户验收

▎ ▾ ★ 账单导出                                          ▱▱▱▱         0/4
    资料
      命令 cd app && npm run dev · 启动开发服务       [ 复制命令 ] [ × ]
    ▾ 已隐藏 1 条
      方案 导出方案.md · 导出的列与格式                         [ 恢复 ]
    ● 导出 CSV：按月份生成文件              @main 别的会话 · 10-15 09:30
    ⏸ 导出：大账本分批写入                       等：等 CSV 基础导出做完
    ○ 导出 CSV：金额列保留两位小数
    ○ 导出：分享到微信聊天

▎ ▾ 统计图表                               ▱▱▱▱▱        0/5 [ 设为关注 ]
    ▸ 资料 2 条
    ◇ 月度支出饼图                                                  已看
    ○ 趋势折线：近 6 个月
    ○ 图表空数据占位
    ○ 图表暗色模式配色
…
```
