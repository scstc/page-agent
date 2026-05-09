# Scripted Flow

一种**不依赖 AI 的固定流程自动化**：复用 page-agent 的动效鼠标 + 视觉遮罩，
但绕过 LLM。适用于"对每页每行执行同一套已知步骤"这种场景——步骤事先就清楚，
让 AI 来判断既慢又贵，没必要。

参考流程是 **拼多多推广列表 `yingxiao.pinduoduo.com/goods/promotion/list`
的批量暂停**，但 runner 本身是通用的：行选择器、弹窗目标、确认按钮文案、翻页
按钮等全部由 `ScriptedFlowConfig` 配置驱动，其他表格类后台都能接入。

---

## TL;DR

```js
// 1. 加载 page-agent（demo bundle 自带 🤖 按钮）
//    在 https 站点上使用 bookmarklet:
javascript:(function(){var s=document.createElement('script');s.src=`https://localhost:5174/page-agent.demo.js?t=${Math.random()}`;s.onload=()=>console.log('PageAgent demo ready!');document.head.appendChild(s);})();

// 2. 点击面板头部的 🤖 → 在弹出框中选择 "PDD 批量推广001"
//    或者从控制台直接运行：
window.runScriptedFlow(window.scriptedFlowPresets.pddPromotion)

// 3. 提前停止：
window.stopScriptedFlow()
```

左上角 HUD 实时显示进度、倒计时、成功/跳过/失败计数和实时错误列表。

---

## 架构

| 文件                                              | 职责                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/page-agent/src/scripted-flow.ts`        | 纯模块：类型、runner、HUD、按钮注入器、预设                         |
| `packages/page-agent/src/scripted.ts`             | 独立 IIFE 入口 —— 暴露 `window.runScriptedFlow`                     |
| `packages/page-agent/src/demo.ts`                 | Demo IIFE 入口 —— 同时把 🤖 按钮注入面板                            |
| `packages/page-agent/vite.scripted.config.js`     | 构建 `dist/iife/page-agent.scripted.js`（约 67 kB）                 |
| `packages/page-agent/.dev-certs/`                 | mkcert 签发的本地 HTTPS 证书（已 gitignore，跑 `npm run setup:dev-certs` 生成） |
| `packages/website/src/pages/home/HeroSection.tsx` | 通过 `page-agent/scripted-flow` 子路径懒加载按钮注入器              |

公共 API：

```ts
import {
    runScriptedFlow,
    stopScriptedFlow,
    isScriptedFlowRunning,
    injectScriptedFlowButton,
    pddPromotionPreset,
    type ScriptedFlowConfig,
    type ScriptedFlowItem,
} from 'page-agent/scripted-flow'
```

子路径导出**仅限 dev**：`package.json` 的 `exports` 暴露它，但
`publishConfig.exports` 让发布到 npm 的包对外只保留 `.` 主入口。

---

## 整体流程

```mermaid
flowchart TD
    Start([runScriptedFlow]) --> ShowHUD[显示 HUD<br/>启用 SimulatorMask]
    ShowHUD --> Skip{startPage > 1?}
    Skip -- 是 --> JumpPage[在 .anq-pagination 里找<br/>title=startPage 的按钮，点一下]
    JumpPage -. 容器/按钮缺失 .-> NotFound([🛑 LocationNotFoundError])
    Skip -- 否 --> PageLoop
    JumpPage --> PageLoop[按 rowSelector 扫描当前页所有行]
    PageLoop --> StartRowGate{第一次循环<br/>且 startRow > 行数?}
    StartRowGate -- 是 --> NotFound
    StartRowGate -- 否 --> RowLoop[逐行处理<br/>第一页从 startRow 开始]
    RowLoop --> PerRow[单行流程<br/>见下]
    PerRow --> MoreRows{本页还有行?}
    MoreRows -- 有 --> RowLoop
    MoreRows -- 无 --> NextBtn{下一页按钮<br/>存在且可用?}
    NextBtn -- 是 --> ClickNext[点下一页<br/>等 afterPageChange]
    ClickNext --> PageLoop
    NextBtn -- 否 --> Finish([运行结束<br/>HUD 停留 10s/有错误时 60s])
    Abort[stopScriptedFlow / ⏹] -.每一步前都会检查.-> PerRow
    PerRow -. 单行重试均失败 .-> Halt([🛑 RetryExhaustedError<br/>中止整个流程])
```

## 单行流程

冷却倒计时**从 click1 的"开启成功"toast 起算**（T0），随后的"随机间隔 + click2 + 等弹窗"
都跟它**并行**消耗时间，弹窗出现后只补等剩余的那点。HUD 的 aux 行独立 ticker 显示倒计时，
status 行同步显示当前操作。

```mermaid
flowchart TD
    Start([单行]) --> Read[读取开关状态]
    Read --> IsOpen{已开启?}
    IsOpen -- 是 --> Skip[跳过<br/>rowsSkippedOpen++]
    IsOpen -- 否 --> AttemptStart[第 n / maxAttempts 次尝试]

    AttemptStart --> StartedOpen{startedOpen?}
    StartedOpen -- false<br/>初次 --> Click1[点开关 → 开启]
    StartedOpen -- true<br/>重试 --> Click2[点开关 → 触发 Popconfirm]

    Click1 --> WaitToast[等 activationSuccess toast<br/>≤ activationTimeoutMs]
    WaitToast -. toast 命中 .-> SetT0[T0 = 现在<br/>cooldownDeadline = T0 + beforeConfirm]
    WaitToast -. 超时无 toast .-> SetT0Fb[T0 = click1 时刻<br/>console.warn]
    SetT0 --> StartTicker[启动 HUD aux ticker<br/>每 250ms 显示剩余]
    SetT0Fb --> StartTicker
    StartTicker --> Random[随机等 betweenToggleClicksRandomMs<br/>例: 3000–5000]
    Random --> Click2

    Click2 --> WaitPopup[等待弹窗 ≤ popup.timeoutMs]
    WaitPopup --> SkipCD{cooldownDeadline?}
    SkipCD -- null<br/>重试 --> WaitBtn
    SkipCD -- 有 --> Remaining{remaining<br/>= deadline − now}
    Remaining -- &gt; 0 --> WaitRem[补等 remaining<br/>仍守护 popup 是否还在]
    Remaining -- ≤ 0 --> WaitBtn
    WaitRem --> WaitBtn[等按钮可点 ≤5s]
    WaitBtn --> Snapshot[快照已有 toast]
    Snapshot --> ClickConfirm[点击 确定暂停]
    ClickConfirm --> Verify{验证 toast}

    Verify -- 命中 success 正则 --> Ok[成功<br/>+ 600ms 缓冲窗口]
    Verify -- 命中 failure 正则 --> Failed[失败]
    Verify -- timeoutMs 超时 --> Failed

    Ok --> Succeeded[rowsActioned++<br/>清 HUD 错误项 + 清 aux ticker]
    Failed --> UpdateHUD[覆盖 HUD 错误项 + 清 aux ticker]
    UpdateHUD --> RetriesLeft{还有重试?}

    RetriesLeft -- 有 --> Backoff[退避等待<br/>1s / 2s / 4s]
    Backoff --> Reset[startedOpen=true<br/>skipCountdown=true]
    Reset --> AttemptStart
    RetriesLeft -- 无 --> Final[错误保留在 HUD<br/>errors++]
    Final --> Halt([🛑 中止整个流程<br/>RetryExhaustedError])

    Skip --> AfterRow[afterRow 等 1s]
    Succeeded --> AfterRow
    AfterRow --> End([下一行])
```

### 为什么 CLOSED 状态要点两次？

因为用户描述的拼多多推广列表流程是"对每个已暂停的行，先短暂打开再触发暂停确认
对话框并确认"。这种"两连点"是在 CLOSED 起点行上**稳定唤起 PDD 的 `<Popconfirm>`
组件**的可靠方法。

### 重试路径：`startedOpen = true`

第一次尝试失败时（比如服务端限流），开关会停留在 **OPEN** 状态——第一次点击把
CLOSED→OPEN 切换了，但第二次点击和确认被拒，所以"关掉"这个动作没真正落地。

重试时因此**跳过初次激活步骤**：开关已经 OPEN，再点一次就能直接触发暂停
Popconfirm。

### 重试跳过冷却倒计时

`delays.beforeConfirm` 服务端冷却（默认 30s，可在弹出框输入框中按流程修改 ——
最近一次值会持久化到 localStorage）只在初次尝试期间挂 ticker + 在弹窗后补等。
重试因为没有重新 click1，本身就过了冷却窗口；只依赖 `等按钮可点 (≤5s)`
这个安全网清掉 PDD 的反刷限制。如果 PDD 强制了"每次重开弹窗 N 秒锁定"，
这一步会超时让本次重试快速失败 —— 下一轮更长的退避（1s → 2s → 4s）会给
限流窗口足够的过期时间。

### 每行冷却时间随机抖动

`delays.beforeConfirmJitterMs`（默认 0；PDD preset 给的是 800）会在每行进入冷却
之前生成一个 `[0, beforeConfirmJitterMs)` 的随机毫秒数加到 `beforeConfirm` 上。
比如设 30000 + 抖动 800，实际每行的冷却是 30.0–30.8s 之间均匀随机。

**作用范围**：每行一次（不是每次重试一次），retry 路径本身就跳过整个冷却区段。
**目的**：避免每行都精准卡 30.0s 这种机器节拍；console 会 log 实际抖动值方便排查。
**关闭方式**：preset 里去掉这个字段或设为 0。

### activation toast 没出现的兜底

`verify.activationSuccess` 配了正则但 `activationTimeoutMs`（默认 3s）内没观察到
匹配的 toast 时，runner **不抛错**：把 T0 回退到约等于 click1 的时刻
（`Date.now() − activationTimeoutMs`），同时在 console.warn 一行
`activation toast not seen ... — falling back to click-dispatch timestamp as T0`。

理由：toast 是可观测信号，不是真值来源。click1 是否真的开启了，下一步
"等弹窗"会给出权威信号 —— 如果 click1 没生效，弹窗根本不会出现，runner
会在 `popup.timeoutMs`（默认 5s）后抛错进入重试。

---

## 重试 & 术语

> "3 次重试" 指**初次之外的 3 次重试**。总数 = 1 次初次 + 3 次重试 = **4 次尝试**。
> HUD 显示的是 `1/4`、`2/4`……分母是总尝试数，不是重试次数。

`retry.backoffMs` 是**每次重试前**的等待数组，长度 = `总尝试数 − 1`：

| `backoffMs`            | 总尝试数 | 尝试间等待序列 |
| ---------------------- | -------- | -------------- |
| `[1000, 2000, 4000]`（默认） | 4        | 1s、2s、4s     |
| `[2000, 5000]`         | 3        | 2s、5s         |
| `[]`                   | 1（无重试） | —              |

### 错误的逐次上报

每次失败的尝试会**覆盖**该行在 HUD 错误列表中的条目（而不是失败 4 次就堆 4
行）。列表展示每行的最新状态：

- 重试中：`P3·R1 [尝试 2/4] 操作频繁，请稍后再尝试`
- 4 次都失败后：`P3·R1 [4 次尝试均失败] 操作频繁...`
- 重试成功后：该条目会**从列表中移除**。

有错误结尾的运行，HUD 停留 60s（无错误是 10s），方便操作人员看清再自动消失。

### 单行重试用尽 = 中止整个流程

任意一行的 4 次尝试都失败后，runner 抛 `RetryExhaustedError`，**整个流程立即停止**，
不再继续处理本页剩余行或翻页。HUD 顶部会显示 `🛑 重试均失败，已中止流程：第 N 页第 M 行：...`。

设计取舍：连续命中"操作频繁"通常意味着账号已被服务端节流，继续往下点只会徒增失败计数；
让用户感知到问题、手动介入比静默跑完一整个失败页更有用。

### 起始位置：`startPage` / `startRow`

`ScriptedFlowConfig` 提供两个 1-based 选项用于"从中间继续跑"：

- `startPage`（默认 1）：**绝对**页号——runner 在分页条 `.anq-pagination` 里找
  `title=${startPage}` 的 `<li class="anq-pagination-item">`，点一下直接跳过去；
  当前页就是 `startPage` 时跳过点击。
- `startRow`（默认 1）：起始页那一页跳过前 `(startRow − 1)` 行；从此之后的页正常从第 1 行开始。

**唯一限制**：目标页必须**当前可见在分页条上**。PDD 的分页条把远端页折叠在 `…` 里，
比如当前在第 1 页时分页条是 `< 1 2 3 4 5 … 28 >`，想跳第 11 页：必须先在 PDD 上手动
点 `…` 或相邻页，让 11 出现在分页条上，再启动书签。

popover 的"页"下拉框只列**实际可见的页码**（即上面例子里就是 `[1, 2, 3, 4, 5, 28]`），
默认选中**当前页**——避免选到一个被折叠的不可达值。

`pagination` 配置可重写四个回调（`containerSelector` / `findPageButton` /
`listVisiblePages` / `getCurrentPage`）适配非 PDD 站点，默认实现已经覆盖
PDD 的 antd-style markup。

任何一项越界（找不到分页容器、目标页按钮缺失、起始行超过实际行数）都抛
`LocationNotFoundError`，HUD 显示 `🛑 找不到指定位置：...`，**中止整个流程**。

---

## 基于 toast 的结果验证

点完确认按钮后，runner 不会以"没抛异常"作为成功标志 —— 那只能说明点击事件
被派发出去了。服务端可能依然拒绝操作，并通过 toast 提示。

```ts
confirm: {
    text: '确定暂停',
    verify: {
        success: /(暂停|开启|操作)成功/,
        failure: /操作频繁|请稍后|请重试|请勿|频率|限流|太快
                 |失败|错误|异常|不能|未能|无法|拒绝/,
        timeoutMs: 3000,
    },
},
```

```mermaid
flowchart TD
    Start[点击确认按钮] --> Snap[点击前快照:<br/>已有 toast 全部忽略]
    Snap --> Watch[监听 DOM 新增 toast<br/>MutationObserver + 200ms 轮询]
    Watch --> Match{toast 文本匹配…}

    Match -- failure 正则 --> FailWin[抛失败<br/>失败优先于成功]
    Match -- success 正则 --> Grace[等 600ms 缓冲]
    Grace --> Recheck{缓冲期内<br/>有 failure toast?}
    Recheck -- 是 --> FailWin
    Recheck -- 否 --> Success([判定成功])
    Match -- 3s 超时/无匹配 --> TimeoutFail[抛超时失败]
```

验证规则：

1. **失败优先于成功**。如果两种 toast 同时出现（实际观测到 PDD 在限流时会同时
   显示 "暂停成功" 和 "操作频繁"），失败胜出。
2. **成功要等 600ms 缓冲窗口才落定**，让后续可能出现的失败 toast 还有覆盖机会。
3. **超时无反馈算失败** —— 重试一次比静默判定 "点了就当成功" 更稳妥。
4. **点击前已有的 toast 会被忽略**：动作前先做快照。否则上一行残留的"暂停成功"
   会粘到下一行的验证上。

Toast 扫描默认覆盖常见组件根：

```
[class*="anq-message"], [class*="anq-notification"], [class*="anq-toast"],
[class*="ant-message"], [class*="ant-notification"], [class*="MS-message"],
[class*="message-notice"], [class*="notification-notice"],
[role="alert"], [role="status"]
```

如果你的目标站点 toast 根不一样，通过 `verify.scanSelector` 覆盖即可。

---

## HUD 浮层

左上角，固定定位，半透明深色面板，等宽字体。从上到下依次：

| 区段     | 内容                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| 标题     | `🤖 Scripted Flow  📄 第 N / M 页  🔘 第 i / N 行`                                |
| 状态     | 当前操作：`🖱 第 1 次点击开关`、`⏳ 等启动反馈…`、`🖱 第 2 次点击开关`、`✅ 已暂停`… |
| **Aux**  | 独立 ticker：`⏳ 服务端冷却剩余 24s` → 23s → … → `✓ 服务端冷却完成`（仅初次尝试有） |
| 统计     | `✓ 已暂停 N  ⏭ 已开/无开关 M  ✗ 失败 K`                                            |
| 错误列表 | 每行一条，按 (页, 行) 维度只保留最新状态                                          |

aux 行从 click1 → activation toast 命中（或超时回退）那一刻开始，每 250ms 重写。
重试路径不挂 ticker，aux 行始终为空。`finally` 块保证无论成败，aux 都会被清空。

错误列表在第一次出错前是隐藏的，超过部分内部滚动，最大约 `38vh`。HUD 设置了
`pointer-events: none`，叠在遮罩之上，并通过 `data-page-agent-ignore` 让自己
不出现在任何 DOM 扫描结果里。

---

## 拼多多预设

```ts
export const pddPromotionPreset: ScriptedFlowConfig = {
    rowSelector: '.anq-table-row',
    toggleSelector: '.anq-switch, [role="switch"]',
    popup: {
        selector: '.anq-popover',
        timeoutMs: 5000,
    },
    confirm: {
        text: '确定暂停',
        verify: {
            success: /(暂停|开启|操作)成功/,
            failure: /操作频繁|请稍后|...|拒绝/,
            timeoutMs: 3000,
            // click1 之后等这条 toast 落地 → 锚定 T0；超时回退到 click1 时刻
            activationSuccess: /(开启|启动|启用)成功/,
            activationTimeoutMs: 3000,
        },
    },
    nextPage: {
        selector: '.anq-pagination-next',
    },
    delays: {
        // 随机 3–5s（与冷却 ticker 并行，不会拖长总时间）
        betweenToggleClicksRandomMs: [3000, 5000],
        beforeConfirm: 30000,
        // 每行额外随机加 0–800ms（实际冷却 30.0–30.8s 之间），让 PDD 看不出固定节拍
        beforeConfirmJitterMs: 800,
        afterPageChange: 1500,
    },
    enableMask: true,
}
```

选择器基于 **anq-ui**（PDD 的 antd 风格组件库）：

| 概念   | anq-ui class                                 |
| ------ | -------------------------------------------- |
| 行     | `.anq-table-row`                             |
| 开关   | `<button role="switch" class="anq-switch">`  |
| Popover | `.anq-popover`（portal 挂在 body 下）        |
| 翻页   | `.anq-pagination-next`                       |
| Toast  | `.anq-message-notice` 等                     |

---

## 跨次运行的持久化

| Key                                                            | 存储          | 用途                              |
| -------------------------------------------------------------- | ------------- | --------------------------------- |
| `page-agent:scripted-flow:countdown:<flow.name>`               | localStorage  | 用户为该流程编辑过的倒计时秒数    |

清掉某流程持久化的倒计时：

```js
localStorage.removeItem('page-agent:scripted-flow:countdown:PDD 批量推广001')
```

---

## 新增一个流程

1. 为目标页面定义一份 `ScriptedFlowConfig`（选择器 + 验证正则）
2. 通过 `injectScriptedFlowButton({ items })` 注册：

```ts
import {
    injectScriptedFlowButton,
    pddPromotionPreset,
    type ScriptedFlowItem,
} from 'page-agent/scripted-flow'

const items: ScriptedFlowItem[] = [
    {
        name: 'PDD 批量推广001',
        description: '拼多多推广列表 / 翻完全部页 / 暂停所有未开启行',
        preset: pddPromotionPreset,
    },
    {
        name: '淘宝直通车暂停',
        description: '直通车 / 当前账户 / 暂停全部计划',
        preset: tbZtcPreset, // 你的新配置
    },
]

injectScriptedFlowButton({ items })
```

弹出框会为每一项渲染一个条目，并自动循环主题色（蓝 → 紫 → 绿 → 橙 → 粉）。
每个条目都有自己的"倒计时秒数"输入框，默认值取自 `preset.delays.beforeConfirm`。

---

## 心智模型：runner 什么时候才认为成功？

`rowsActioned++` 当且仅当下面**全部**成立：

1. 扫描时开关是 CLOSED（否则计入 `rowsSkippedOpen`）
2. 暂停流程的确认点击被派发
3. **出现了一个匹配 `verify.success` 的 toast**
4. **缓冲窗口内没有 failure toast 出现**
5. **该 (页, 行) 在 HUD 中的错误条目已被清除**

其他情况 —— 服务端拒绝、超时、弹窗未出现、开关消失、被中止 —— 在重试用尽后
都计入 `errors++`，失败信息会保留在 HUD 列表和控制台里。

---

## 单行时间预算（最坏情况）

冷却 30s 是从 click1 toast 起算的"墙钟"。其他步骤会**吸收**它的一部分，
所以总时间 ≈ `max(冷却, 实际串行步骤)` + 等按钮 + 验证 + afterRow。

| 阶段                                 | 初次尝试                | 重试尝试               |
| ------------------------------------ | ----------------------- | ---------------------- |
| click1 + 等 activation toast         | 约 0.5s + ≤ 3s          | —                      |
| 随机间隔 (`betweenToggleClicksRandomMs`) | 3–5s（被冷却吸收）   | —                      |
| click2                               | 约 0.5s（被冷却吸收）  | 约 0.5s                |
| 等弹窗                               | ≤ 5s（被冷却吸收）     | ≤ 5s                   |
| 等冷却归零（剩余）                   | ≈ 30s − 上面已耗费     | **跳过**               |
| 等按钮可点                           | ≤ 5s                    | ≤ 5s                   |
| 点确认 + 验证 toast                  | 约 3.5s                 | 约 3.5s                |
| afterRow                             | 1s                      | 1s                     |
| **小计**                             | **约 30 + 9.5 ≈ 40s**   | **约 13s**             |
| 该次尝试前的退避                     | 0                       | 1 / 2 / 4s             |

> 对比改造前（28s 倒计时**等弹窗后才开始**）的约 42s，改造后约 40s，
> 但**节奏更像人**（随机 3–5s）+ **冷却起点真正对齐 PDD 服务端**。

最坏情况：单行失败 4 次 ≈ 40 + 1 + 13 + 2 + 13 + 4 + 13 ≈ 86s。
全成功跑一遍：5 行/页 × 28 页 × 约 40s ≈ 93 分钟。

---

## 中止

- `window.stopScriptedFlow()` 翻起中止标志位；runner 在每一步之间都会检查
  （延迟最多约 100ms：来自 `abortableSleep` 内部、`waitFor` 轮询内部、以及
  行/页边界）。
- 点击面板按钮上的 `⏹` 效果相同。
- HUD 以 `🛑 已停止` 收尾，停留 10s。
