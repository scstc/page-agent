# Scripted Flow

A **non-AI fixed-flow automation** that drives the browser through page-agent's
animated cursor + visual mask without going through an LLM. Built for the
"do this exact thing on every row of every page" use case where the steps are
known up front and AI judgment is unnecessary (and slow, and expensive).

The reference flow is **batch-pause every running promotion on PDD's
`yingxiao.pinduoduo.com/goods/promotion/list`** but the runner is generic:
selectors, popup targets, confirm-button text, and pagination markers all
come from a `ScriptedFlowConfig` so other tabular admin pages can plug in.

---

## TL;DR

```js
// 1. Load page-agent (demo bundle has the 🤖 button preinstalled)
//    bookmarklet on a https origin:
javascript:(function(){var s=document.createElement('script');s.src=`https://localhost:5174/page-agent.demo.js?t=${Math.random()}`;s.onload=()=>console.log('PageAgent demo ready!');document.head.appendChild(s);})();

// 2. Click 🤖 in the panel header → choose "PDD 批量暂停" from the popover.
//    OR run from console:
window.runScriptedFlow(window.scriptedFlowPresets.pddPromotion)

// 3. Stop early:
window.stopScriptedFlow()
```

The HUD (top-left) shows live progress, ticking countdown, success/skip/fail
counters, and a real-time error list.

---

## Architecture

| File                                              | Role                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `packages/page-agent/src/scripted-flow.ts`        | Pure module: types, runner, HUD, button injector, presets   |
| `packages/page-agent/src/scripted.ts`             | Standalone IIFE entry — exposes `window.runScriptedFlow`    |
| `packages/page-agent/src/demo.ts`                 | Demo IIFE entry — also injects the 🤖 button into the panel |
| `packages/page-agent/vite.scripted.config.js`     | Builds `dist/iife/page-agent.scripted.js` (~67 kB)          |
| `packages/page-agent/.dev-certs/`                 | mkcert-signed local cert for HTTPS dev (gitignored)         |
| `packages/website/src/pages/home/HeroSection.tsx` | Lazy-imports the button injector via `page-agent/scripted-flow` subpath |

Public API surface:

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

The subpath export is **dev-only**: `package.json` exposes it via `exports`
but `publishConfig.exports` keeps the published npm package's API at just `.`.

---

## Per-row flow (CLOSED start)

```
                          ┌── ROW LOOP ─────────────────────────────┐
                          │                                         │
                          │  read switch state                      │
                          │      │                                  │
                          │      ▼                                  │
                          │  OPEN? ───── yes ─── skip (rowsSkippedOpen++)
                          │      │ no                               │
                          │      ▼                                  │
                          │  ┌── ATTEMPT LOOP (1..maxAttempts) ──┐  │
                          │  │                                   │  │
                          │  │  ┌──────────────────────────────┐ │  │
                          │  │  │ pauseRow(startedOpen=false): │ │  │
                          │  │  │  click switch  (→ OPEN)      │ │  │
                          │  │  │  wait 1s                     │ │  │
                          │  │  │  click switch  (triggers     │ │  │
                          │  │  │                  Popconfirm) │ │  │
                          │  │  │  wait popup    (≤5s)         │ │  │
                          │  │  │  countdown 25s (HUD ticks)   │ │  │
                          │  │  │  wait btn ready (≤5s)        │ │  │
                          │  │  │  snapshot stale toasts       │ │  │
                          │  │  │  click 确定暂停              │ │  │
                          │  │  │  verify toast                │ │  │
                          │  │  │   ├ success regex → ok       │ │  │
                          │  │  │   ├ failure regex → throw    │ │  │
                          │  │  │   └ timeout 3s    → throw    │ │  │
                          │  │  └──────────────────────────────┘ │  │
                          │  │      │ ok               │ throw   │  │
                          │  │      ▼                  ▼         │  │
                          │  │   succeeded     update HUD error  │  │
                          │  │   (clear errors  list (per-row)   │  │
                          │  │    for this row)                  │  │
                          │  │                  retries left?    │  │
                          │  │                   ├ yes:          │  │
                          │  │                   │   wait        │  │
                          │  │                   │   1s/2s/4s    │  │
                          │  │                   │   loop again  │  │
                          │  │                   │   (this time  │  │
                          │  │                   │    startedOpen│  │
                          │  │                   │    =true)     │  │
                          │  │                   └ no:           │  │
                          │  │                       leave err   │  │
                          │  │                       in HUD list │  │
                          │  │                       errors++    │  │
                          │  └───────────────────────────────────┘  │
                          │           afterRow wait (1s)            │
                          └─────────────────────────────────────────┘
```

### Why click twice on a CLOSED switch?

Because the user-described flow on PDD's promotion list is "for each
already-paused row, briefly toggle on then trigger the pause-confirmation
dialog and confirm it". That two-click dance is what reliably surfaces
PDD's `<Popconfirm>` component on a row that started CLOSED.

### Retry path: `startedOpen = true`

When the first attempt fails (server rate-limit etc.), the switch is left
in **OPEN** state — first click toggled CLOSED→OPEN, subsequent click and
confirm got rejected so the OFF action never landed.

On retry, we therefore **skip the initial activation step**: the switch is
already OPEN, so a single click triggers the pause Popconfirm directly.

### Retries skip the spec countdown

The `delays.beforeConfirm` countdown (default 28 s, customizable per-flow
via the popover input — last value persisted in localStorage) only runs on
the initial attempt. Retries rely on the `wait btn ready (≤5s)` safety net
to clear PDD's anti-spam disabled state. If PDD enforces a 30 s lockout per
re-open of the popup, the wait-ready check will time out and that retry
attempt fails fast — the next retry's longer backoff (1 s → 2 s → 4 s) gives
the rate-limit window time to expire.

---

## Retry & terminology

> "3 次重试" means 3 RETRY attempts after the initial. Total = 1 initial + 3
> retries = **4 attempts**. The HUD displays `1/4`, `2/4`, … because the
> denominator is the total attempt budget, not the retry count.

`retry.backoffMs` is the array of waits **before** each retry, so its length
is `total attempts − 1`:

| `backoffMs`            | Total attempts | Wait sequence between attempts |
| ---------------------- | -------------- | ------------------------------ |
| `[1000, 2000, 4000]` (default) | 4 | 1 s, 2 s, 4 s                  |
| `[2000, 5000]`         | 3              | 2 s, 5 s                       |
| `[]`                   | 1 (no retries) | —                              |

### Per-attempt error reporting

Every failed attempt **overwrites** that row's entry in the HUD error list
(rather than stacking 4 lines for a row that fails 4 times). The list shows
the latest known state for each row:

- During retries: `P3·R1 [尝试 2/4] 操作频繁，请稍后再尝试`
- After 4 failures: `P3·R1 [4 次尝试均失败] 操作频繁...`
- After a successful retry: the entry is **removed** from the list.

The HUD lingers 60 s after a run ends with errors (vs 10 s for clean runs)
so the operator has time to read them before it auto-disposes.

---

## Toast-based outcome verification

After clicking the confirm button, the runner doesn't trust "no exception
thrown" as success — that just means the click was dispatched. The server
might still reject the action and surface that via a toast.

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

Verification rules:

1. **Failure beats success.** If both toasts appear (PDD has been observed
   to show "暂停成功" alongside "操作频繁" during rate-limit), the failure
   wins.
2. **Success is committed after a 600 ms grace window** so a follow-up
   failure toast still has a chance to override.
3. **Timeout-without-feedback counts as failure** — better to retry than
   silently mark "click happened, must be fine".
4. **Pre-existing toasts are ignored** via a snapshot taken before the
   click. Otherwise a leftover "暂停成功" from the previous row would latch
   onto the next row's verification.

Toast scan defaults to common component roots:

```
[class*="anq-message"], [class*="anq-notification"], [class*="anq-toast"],
[class*="ant-message"], [class*="ant-notification"], [class*="MS-message"],
[class*="message-notice"], [class*="notification-notice"],
[role="alert"], [role="status"]
```

Override via `verify.scanSelector` if your site uses a different toast root.

---

## HUD overlay

Top-left, fixed, semi-transparent dark panel with monospace font. Sections
(top to bottom):

| Section | Content                                                     |
| ------- | ----------------------------------------------------------- |
| Title   | `🤖 Scripted Flow  📄 第 N / M 页  🔘 第 i / N 行`           |
| Status  | Live: `🖱 第 1 次点击开关`, `⏳ 倒计时：剩余 14s`, `✅ 已暂停`, ... |
| Stats   | `✓ 已暂停 N  ⏭ 已开/无开关 M  ✗ 失败 K`                     |
| Errors  | Per-row list, latest update wins per (page, row) tuple      |

Errors list is hidden until the first error occurs, scrolls internally up
to ~38 vh max-height. The HUD is `pointer-events: none`, sits above the
mask, and uses `data-page-agent-ignore` to opt out of any DOM scans.

---

## PDD preset

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
        },
    },
    nextPage: {
        selector: '.anq-pagination-next',
    },
    delays: {
        betweenToggleClicks: 1000,
        beforeConfirm: 28000,
        afterPageChange: 1500,
    },
    enableMask: true,
}
```

Selectors are based on **anq-ui** (PDD's antd-styled component lib):

| Concept    | anq-ui class                                 |
| ---------- | -------------------------------------------- |
| Row        | `.anq-table-row`                             |
| Switch     | `<button role="switch" class="anq-switch">`  |
| Popover    | `.anq-popover` (portal-mounted under body)   |
| Pagination | `.anq-pagination-next`                       |
| Toast      | `.anq-message-notice` etc.                   |

---

## State that persists across runs

| Key                                                            | Where         | Purpose                                  |
| -------------------------------------------------------------- | ------------- | ---------------------------------------- |
| `page-agent:scripted-flow:countdown:<flow.name>`               | localStorage  | Per-flow user-edited countdown seconds   |

To reset a stored countdown:

```js
localStorage.removeItem('page-agent:scripted-flow:countdown:PDD 批量暂停')
```

---

## Adding a new flow

1. Define a `ScriptedFlowConfig` for the target page (selectors + verify
   patterns).
2. Pass it via `injectScriptedFlowButton({ items })`:

```ts
import {
    injectScriptedFlowButton,
    pddPromotionPreset,
    type ScriptedFlowItem,
} from 'page-agent/scripted-flow'

const items: ScriptedFlowItem[] = [
    {
        name: 'PDD 批量暂停',
        description: '拼多多推广列表 / 翻完全部页 / 暂停所有未开启行',
        preset: pddPromotionPreset,
    },
    {
        name: '淘宝直通车暂停',
        description: '直通车 / 当前账户 / 暂停全部计划',
        preset: tbZtcPreset, // your new config
    },
]

injectScriptedFlowButton({ items })
```

The popover renders one entry per item, with auto-cycling accent colors
(blue → purple → green → orange → pink). Each entry has its own editable
countdown-seconds field whose default is taken from `preset.delays.beforeConfirm`.

---

## Mental model: when does the runner think it succeeded?

A row counts as `rowsActioned++` when **all** of the following hold:

1. The switch was CLOSED at scan time (otherwise it's `rowsSkippedOpen`)
2. The pause-flow's confirm click got dispatched
3. **A toast verifying success appeared** (`verify.success` matched)
4. **No failure toast appeared** within the success grace window
5. **The (page, row) tuple's error entry has been cleared** from the HUD

Anything else — server rejection, timeout, popover not appearing,
disappeared toggle, abort — counts as `errors++` (after retries are
exhausted) with the failure message preserved in the HUD list and the
console.

---

## Time budget per row (worst-case)

| Phase                         | Initial attempt | Retry attempt           |
| ----------------------------- | --------------- | ----------------------- |
| Click + 1s + click            | ~1.5 s          | ~0.5 s (single click)   |
| Wait popup                    | ≤ 5 s           | ≤ 5 s                   |
| Countdown                     | 25–28 s         | **skipped**             |
| Wait button clickable         | ≤ 5 s           | ≤ 5 s                   |
| Click confirm + verify toast  | ~3.5 s          | ~3.5 s                  |
| afterRow                      | 1 s             | 1 s                     |
| **Subtotal**                  | **~31 s**       | **~10 s**               |
| Backoff before this attempt   | 0               | 1 / 2 / 4 s             |

Worst case for a single row that fails 4 times: ~31 + 1 + 10 + 2 + 10 + 4 + 10 ≈ 68 s.
At 5 rows/page × 28 pages × ~31 s ≈ 72 minutes for an all-success run.

---

## Aborting

- `window.stopScriptedFlow()` flips the abort flag; the runner checks it
  between every step (max ~100 ms latency from inside `abortableSleep`,
  inside `waitFor`'s polling, and at row/page boundaries).
- Clicking `⏹` on the panel button does the same.
- The HUD finishes with `🛑 已停止` and lingers 10 s.
