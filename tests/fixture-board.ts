// A fictional project board: 6 goals (5 active, 1 paused), cross-goal dependsOn, 29 rules, 25 live decisions.
const board: unknown =
{
  "schema": 1,
  "rev": 0,
  "project": {
    "name": "记账小程序",
    "type": "miniapp"
  },
  "focus": {
    "text": "先把账单导出做完，再接图表的趋势折线",
    "goalId": "g-fnlfi4",
    "mandate": "导出相关改动可以直接做，做完请用户验收",
    "updatedAt": "2026-10-11T02:08:37+08:00"
  },
  "milestones": {
    "enabled": true,
    "items": [
      {
        "id": "m-wy5x4u",
        "title": "0 立项",
        "status": "完成",
        "note": "定位与范围已写入 `docs/立项.md`",
        "gates": []
      },
      {
        "id": "m-g4gfde",
        "title": "1 记账与统计",
        "status": "进行中",
        "note": "记账页已完成，统计图表与导出进行中",
        "gates": [
          {
            "date": "2026-10-09",
            "name": "记账页验收",
            "result": "通过",
            "points": "三次点击内可记一笔；分类选择顺手"
          }
        ]
      },
      {
        "id": "m-tvo4ui",
        "title": "2 云端同步",
        "status": "未开始",
        "note": "",
        "gates": []
      }
    ]
  },
  "goals": [
    {
      "id": "g-mzv9ys",
      "title": "统计图表",
      "outcome": "首页和统计页能一眼看出钱花在哪、本月比上月多还是少",
      "status": "active",
      "links": [
        {
          "type": "path",
          "kind": "方案",
          "target": "docs/图表规格.md",
          "label": "图表类型与交互",
          "forReview": false
        },
        {
          "type": "url",
          "kind": "链接",
          "target": "http://localhost:5173/",
          "label": "开发预览地址",
          "forReview": false
        }
      ],
      "items": [
        {
          "id": "i-p3e2z8",
          "title": "月度支出饼图",
          "status": "review",
          "owner": "",
          "note": "按分类汇总，点击扇区看明细",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [
            {
              "type": "path",
              "kind": "预览",
              "target": "docs/预览/饼图.html",
              "label": "饼图预览",
              "forReview": true
            }
          ],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-iq9y7j",
          "title": "趋势折线：近 6 个月",
          "status": "todo",
          "owner": "",
          "note": "依赖导出的月度汇总口径",
          "waitingFor": "",
          "dependsOn": [
            "i-k9p34y"
          ],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-zb6cn6",
          "title": "图表空数据占位",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-z43dvy",
          "title": "图表暗色模式配色",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-rkttnj",
          "title": "图表可访问性：颜色之外加图案",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [
            "i-6n3wd2"
          ],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        }
      ],
      "createdAt": "2026-10-08T09:00:00+08:00",
      "updatedAt": "2026-10-11T02:08:37+08:00",
      "confirmedBy": "conversation",
      "quote": "就按这个建"
    },
    {
      "id": "g-fnlfi4",
      "title": "账单导出",
      "outcome": "用户能把任意月份的账单导出成 CSV 并分享出去",
      "status": "active",
      "links": [
        {
          "type": "path",
          "kind": "方案",
          "target": "docs/导出方案.md",
          "label": "导出的列与格式",
          "forReview": false
        },
        {
          "type": "command",
          "kind": "命令",
          "target": "cd app && npm run dev",
          "label": "启动开发服务",
          "forReview": false
        }
      ],
      "items": [
        {
          "id": "i-k9p34y",
          "title": "导出 CSV：按月份生成文件",
          "status": "running",
          "owner": "main",
          "note": "账单按月导出为 CSV，列顺序与小程序账单页一致",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-6n3wd2",
          "title": "导出 CSV：金额列保留两位小数",
          "status": "todo",
          "owner": "",
          "note": "避免表格软件把 12.50 显示成 12.5",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-5rq4f5",
          "title": "导出：分享到微信聊天",
          "status": "todo",
          "owner": "",
          "note": "调用分享接口，文件名带月份",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-zr37e3",
          "title": "导出：大账本分批写入",
          "status": "queued",
          "owner": "",
          "note": "超过一万条时分批写，避免卡顿",
          "waitingFor": "等 CSV 基础导出做完",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        }
      ],
      "createdAt": "2026-10-08T09:00:00+08:00",
      "updatedAt": "2026-10-11T02:08:37+08:00",
      "confirmedBy": "conversation",
      "quote": "就按这个建"
    },
    {
      "id": "g-80zbmr",
      "title": "云端同步",
      "outcome": "换手机或换微信号后账本不丢，两台设备上的记录能自动合并",
      "status": "active",
      "links": [
        {
          "type": "path",
          "kind": "方案",
          "target": "docs/同步设计.md",
          "label": "同步与冲突规则",
          "forReview": false
        }
      ],
      "items": [
        {
          "id": "i-fbf5jx",
          "title": "登录后拉取云端账本",
          "status": "running",
          "owner": "main",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-vlsi47",
          "title": "离线记账，联网后合并",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [
            "i-zr37e3"
          ],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-wqal9v",
          "title": "冲突提示：同一笔改动两处",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-q24zkl",
          "title": "同步失败重试与提示",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-mvt45h",
          "title": "换设备首次同步进度条",
          "status": "queued",
          "owner": "",
          "note": "",
          "waitingFor": "等登录流程完成",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-u43jsi",
          "title": "同步日志页（给自己排查）",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-om1tma",
          "title": "云端账本备份与恢复",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [
            "i-p3e2z8"
          ],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        }
      ],
      "createdAt": "2026-10-08T09:00:00+08:00",
      "updatedAt": "2026-10-11T02:08:37+08:00",
      "confirmedBy": "conversation",
      "quote": "就按这个建"
    },
    {
      "id": "g-ykglfy",
      "title": "体验打磨",
      "outcome": "常用操作都顺手：记一笔不超过三次点击，主要页面在小屏手机上不拥挤",
      "status": "active",
      "links": [],
      "items": [
        {
          "id": "i-7v3di8",
          "title": "界面细节：记账页键盘遮挡输入框",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-fppv5a",
          "title": "界面细节：分类图标统一线宽",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-spzh8r",
          "title": "界面细节：列表滑动删除的回弹",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-zhqmoe",
          "title": "界面细节：金额输入千分位",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [
            "i-6n3wd2"
          ],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-95b9ee",
          "title": "界面细节：日期选择器默认今天",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-0vbgi0",
          "title": "界面细节：空账本引导页",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-9qynk8",
          "title": "界面细节：设置页分组间距",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-w3tzpp",
          "title": "界面细节：加载骨架屏",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-pp6up3",
          "title": "界面细节：深色模式下阴影",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-c4dsa7",
          "title": "界面细节：长备注截断规则",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        }
      ],
      "createdAt": "2026-10-08T09:00:00+08:00",
      "updatedAt": "2026-10-11T02:08:37+08:00",
      "confirmedBy": "conversation",
      "quote": "就按这个建"
    },
    {
      "id": "g-qc23a7",
      "title": "技术债与预算",
      "outcome": "代码可以放心改动：关键路径有测试，体积与性能有明确上限",
      "status": "active",
      "links": [
        {
          "type": "path",
          "kind": "报告",
          "target": "docs/体积预算.md",
          "label": "包体积基线",
          "forReview": false
        }
      ],
      "items": [
        {
          "id": "i-l3609y",
          "title": "技术债：拆分超长的账单页组件",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-6n14do",
          "title": "技术债：统一金额计算为整数分",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [
            "i-fbf5jx"
          ],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-9gmnu7",
          "title": "技术债：接口错误码整理成表",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-7vtuuj",
          "title": "技术债：补账单增删改的自动化测试",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-596lgu",
          "title": "技术债：清理未使用的图片资源",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-ax1dxn",
          "title": "技术债：升级小程序基础库版本",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-9y1xj5",
          "title": "技术债：埋点事件命名统一",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-gxname",
          "title": "技术债：构建产物体积预算 2MB",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        }
      ],
      "createdAt": "2026-10-08T09:00:00+08:00",
      "updatedAt": "2026-10-11T02:08:37+08:00",
      "confirmedBy": "conversation",
      "quote": "就按这个建"
    },
    {
      "id": "g-451cag",
      "title": "上架发布（图表与同步完成后开）",
      "outcome": "小程序通过审核并对外可搜索",
      "status": "paused",
      "links": [],
      "items": [
        {
          "id": "i-yywlec",
          "title": "提交审核材料",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [
            "i-p3e2z8",
            "i-fbf5jx"
          ],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-fpecxv",
          "title": "隐私政策页",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        },
        {
          "id": "i-m11hug",
          "title": "上线后第一周观察清单",
          "status": "todo",
          "owner": "",
          "note": "",
          "waitingFor": "",
          "dependsOn": [
            "i-k9p34y"
          ],
          "scope": [],
          "acceptance": "",
          "links": [],
          "noReviewTargetReason": "",
          "reportedAt": "",
          "session": "",
          "doneBy": "",
          "createdAt": "2026-10-08T09:00:00+08:00",
          "updatedAt": "2026-10-11T02:08:37+08:00",
          "doneAt": ""
        }
      ],
      "createdAt": "2026-10-08T09:00:00+08:00",
      "updatedAt": "2026-10-11T02:08:37+08:00"
    }
  ],
  "decisions": [
    {
      "id": "d-bh8rgp",
      "date": "2026-10-08",
      "text": "项目名定为「记账小程序」，面向个人日常开销，不做多人共享账本",
      "kind": "delegated",
      "goalId": "",
      "status": "active"
    },
    {
      "id": "d-9ywvk5",
      "date": "2026-10-08",
      "text": "先做微信小程序，不做独立 App",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-h3br4h",
      "date": "2026-10-08",
      "text": "金额用整数分存储，避免小数误差",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-15g5e4",
      "date": "2026-10-08",
      "text": "首页只放本月概览和「记一笔」入口",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-g7t0lz",
      "date": "2026-10-08",
      "text": "分类先内置 12 个，用户自定义放到后面",
      "kind": "delegated",
      "goalId": "",
      "status": "active"
    },
    {
      "id": "d-qh82xf",
      "date": "2026-10-08",
      "text": "统计图表只做饼图和折线两种",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-7ag3bc",
      "date": "2026-10-08",
      "text": "导出格式选 CSV，不做 Excel 原生格式",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-jjxdis",
      "date": "2026-10-08",
      "text": "云端同步用微信登录身份，不另建账号体系",
      "kind": "user",
      "goalId": "g-fnlfi4",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-wbhm1g",
      "date": "2026-10-08",
      "text": "离线优先：断网也能记账",
      "kind": "delegated",
      "goalId": "g-fnlfi4",
      "status": "active"
    },
    {
      "id": "d-201wzc",
      "date": "2026-10-08",
      "text": "冲突时保留两份让用户选，不自动覆盖",
      "kind": "user",
      "goalId": "g-80zbmr",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-wufs6r",
      "date": "2026-10-09",
      "text": "深色模式跟随系统，不提供手动开关",
      "kind": "user",
      "goalId": "g-80zbmr",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-vypwjd",
      "date": "2026-10-09",
      "text": "上架前不做广告位",
      "kind": "user",
      "goalId": "g-80zbmr",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-elc8pm",
      "date": "2026-10-09",
      "text": "预算功能延后到 1.1 版",
      "kind": "delegated",
      "goalId": "",
      "status": "active"
    },
    {
      "id": "d-3804gr",
      "date": "2026-10-09",
      "text": "账单搜索支持备注和金额范围",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-a35owi",
      "date": "2026-10-09",
      "text": "图表配色避免只靠红绿区分",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-fi2tba",
      "date": "2026-10-09",
      "text": "包体积预算 2MB，超了就拆分包",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-hs0gnl",
      "date": "2026-10-09",
      "text": "埋点只记功能使用次数，不记金额",
      "kind": "delegated",
      "goalId": "",
      "status": "active"
    },
    {
      "id": "d-zkf2jd",
      "date": "2026-10-09",
      "text": "隐私政策页放在设置页底部",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-mb0lo5",
      "date": "2026-10-09",
      "text": "备份恢复走云端，不提供本地文件导入",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-uhwcfw",
      "date": "2026-10-09",
      "text": "记一笔的默认日期是今天",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-05g59p",
      "date": "2026-10-10",
      "text": "长按账单进入多选",
      "kind": "delegated",
      "goalId": "",
      "status": "active"
    },
    {
      "id": "d-2p1jje",
      "date": "2026-10-10",
      "text": "导出文件名格式为「账单-年月.csv」",
      "kind": "user",
      "goalId": "",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-5x9okv",
      "date": "2026-10-10",
      "text": "同步日志页只给开发者开关",
      "kind": "user",
      "goalId": "g-fnlfi4",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-9i92wr",
      "date": "2026-10-10",
      "text": "键盘弹出时输入框上移而不是页面压缩",
      "kind": "user",
      "goalId": "g-ykglfy",
      "status": "active",
      "quote": "好，就这样"
    },
    {
      "id": "d-w8xw1e",
      "date": "2026-10-10",
      "text": "上线首周每天看一次错误日志",
      "kind": "delegated",
      "goalId": "g-qc23a7",
      "status": "active"
    }
  ],
  "rules": [
    {
      "id": "r-cmsmn5",
      "text": "金额一律用整数分存储和计算，只在显示层转成元",
      "group": "代码"
    },
    {
      "id": "r-e6eucl",
      "text": "页面组件不直接调用云接口，统一经 `api/` 目录下的封装",
      "group": "代码"
    },
    {
      "id": "r-du0um5",
      "text": "新增页面先在 `pages.json` 登记，再写代码",
      "group": "代码"
    },
    {
      "id": "r-7ocubr",
      "text": "样式用 CSS 变量，不写死颜色值",
      "group": "代码"
    },
    {
      "id": "r-l5ptp5",
      "text": "文案集中放在 `locale/zh.ts`，组件里不出现中文字面量",
      "group": "代码"
    },
    {
      "id": "r-aa819t",
      "text": "日期统一用 ISO 字符串存储，显示时再格式化",
      "group": "代码"
    },
    {
      "id": "r-9um9zz",
      "text": "所有列表页先写空状态与加载状态再写数据态",
      "group": "代码"
    },
    {
      "id": "r-8106x8",
      "text": "改金额计算的代码必须同时改测试，测试覆盖负数、零、最大值",
      "group": "测试"
    },
    {
      "id": "r-rcd1gd",
      "text": "提交前跑 `npm test`，红的不提交",
      "group": "测试"
    },
    {
      "id": "r-iwfkgy",
      "text": "截图对比用例放在 `tests/visual/`，更新基准图要在提交说明里写原因",
      "group": "测试"
    },
    {
      "id": "r-q83mtx",
      "text": "新增接口封装时补一条失败重试的用例",
      "group": "测试"
    },
    {
      "id": "r-qw8y9x",
      "text": "每个任务开始前在看板挂事项，做完再改状态",
      "group": "协作"
    },
    {
      "id": "r-w1sb09",
      "text": "要用户验收的事项必须附可点开的验收入口",
      "group": "协作"
    },
    {
      "id": "r-b9u7z3",
      "text": "不确定的需求先写进「待定」资料，不自行拍板",
      "group": "协作"
    },
    {
      "id": "r-kxxzu6",
      "text": "改动超过 5 个文件的任务先给方案再动手",
      "group": "协作"
    },
    {
      "id": "r-z3fch2",
      "text": "提交说明第一行写做了什么，第二段写为什么",
      "group": "协作"
    },
    {
      "id": "r-6wsz14",
      "text": "体积超过 2MB 的改动要附瘦身说明",
      "group": "发布"
    },
    {
      "id": "r-skwwch",
      "text": "上架前检查隐私政策页与权限申请文案一致",
      "group": "发布"
    },
    {
      "id": "r-swyuwf",
      "text": "版本号只在发布当天改，平时不动",
      "group": "发布"
    },
    {
      "id": "r-xgzcs8",
      "text": "灰度先给自己的微信号，一天无异常再扩大",
      "group": "发布"
    },
    {
      "id": "r-q7psk4",
      "text": "方案文档放 `docs/`，一个方案一个文件",
      "group": "文档"
    },
    {
      "id": "r-fr4dj7",
      "text": "图表规格变更同步更新预览页",
      "group": "文档"
    },
    {
      "id": "r-9n9g8t",
      "text": "资料类文件命名用中文短名",
      "group": "文档"
    },
    {
      "id": "r-e6pvae",
      "text": "在文档里引用代码用相对路径",
      "group": "文档"
    },
    {
      "id": "r-arwplq",
      "text": "废弃的方案移到 `docs/_废弃/` 而不是删除",
      "group": "文档"
    },
    {
      "id": "r-cmk5n1",
      "text": "导出文件编码用 UTF-8 带 BOM，保证表格软件不乱码",
      "group": "数据"
    },
    {
      "id": "r-lzts1o",
      "text": "分类名称改动不回溯历史账单",
      "group": "数据"
    },
    {
      "id": "r-lxiw47",
      "text": "删除账单是软删除，保留 30 天",
      "group": "数据"
    },
    {
      "id": "r-e65gh2",
      "text": "同步冲突时保留两份，让用户选",
      "group": "数据"
    }
  ],
  "notes": [
    {
      "id": "n-2c49lg",
      "title": "规模",
      "text": "单人使用的个人账本，预计账单量每人每年一千到五千条",
      "group": "项目"
    },
    {
      "id": "n-j80u3v",
      "title": "待定",
      "text": "是否做预算提醒；是否支持多币种",
      "group": "项目"
    },
    {
      "id": "n-h6dvix",
      "title": "测试账号",
      "text": "开发者工具里用体验版测试号，数据与正式环境隔离",
      "group": "环境"
    }
  ],
  "proposals": [],
  "archive": {
    "goals": [
      {
        "id": "g-arch01",
        "title": "项目初始化",
        "outcome": "脚手架、目录与基础页面就位",
        "status": "active",
        "links": [],
        "items": [
          {
            "id": "i-5128n6",
            "title": "建项目骨架",
            "status": "done",
            "owner": "",
            "note": "",
            "waitingFor": "",
            "dependsOn": [],
            "scope": [],
            "acceptance": "",
            "links": [],
            "noReviewTargetReason": "",
            "reportedAt": "",
            "session": "",
            "doneBy": "user",
            "createdAt": "2026-10-08T09:00:00+08:00",
            "updatedAt": "2026-10-11T02:08:37+08:00",
            "doneAt": "2026-10-11T02:08:37+08:00"
          },
          {
            "id": "i-osz31y",
            "title": "接入微信开发者工具",
            "status": "done",
            "owner": "",
            "note": "",
            "waitingFor": "",
            "dependsOn": [],
            "scope": [],
            "acceptance": "",
            "links": [],
            "noReviewTargetReason": "",
            "reportedAt": "",
            "session": "",
            "doneBy": "user",
            "createdAt": "2026-10-08T09:00:00+08:00",
            "updatedAt": "2026-10-11T02:08:37+08:00",
            "doneAt": "2026-10-11T02:08:37+08:00"
          }
        ],
        "createdAt": "2026-10-08T09:00:00+08:00",
        "updatedAt": "2026-10-11T02:08:37+08:00",
        "closedAt": "2026-10-08T09:00:00+08:00",
        "closeReason": "完成"
      }
    ],
    "decisions": [
      {
        "id": "d-fvg0t4",
        "date": "2026-10-06",
        "text": "采用 uni-app 作为小程序框架",
        "kind": "user",
        "goalId": "g-arch01",
        "status": "active"
      }
    ]
  }
}

export default board
