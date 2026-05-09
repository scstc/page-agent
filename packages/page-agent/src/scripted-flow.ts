/**
 * Scripted-flow core — non-AI fixed-flow automation.
 *
 * This is the pure module: it exports `runScriptedFlow`, `stopScriptedFlow`,
 * `isScriptedFlowRunning`, and the `pddPromotionPreset`. Both the standalone
 * IIFE entry (`scripted.ts`) and the demo bundle (`demo.ts`) import from here.
 *
 * Architecture:
 * - Uses @page-agent/page-controller for clickElement() animation + SimulatorMask.
 * - No LLM, no DOM indexing — selectors are passed in by the caller.
 * - All waits use MutationObserver / polling, never busy-loop.
 */
import { PageController, clickElement } from '@page-agent/page-controller'

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ScriptedFlowConfig {
	/** CSS selector for each row in the current page's table. */
	rowSelector: string

	/** CSS selector for the toggle element inside a row. */
	toggleSelector: string

	/**
	 * Predicate that decides whether the toggle is currently in the OPEN/ON state.
	 * Default: looks for an inner `<input type="checkbox">` and reads `.checked`,
	 * with `aria-checked` / class fallbacks for non-checkbox switches.
	 */
	isOpen?: (toggle: HTMLElement) => boolean

	/** Popup wait config. The popup is expected to appear after the second click. */
	popup: {
		selector: string
		timeoutMs?: number
	}

	/**
	 * Confirm button inside the popup.
	 * If `text` is given, we find a button whose visible text matches.
	 * If `selector` is given, we use it directly (scoped to the popup root).
	 *
	 * `verify` is an optional DOM-based outcome check that runs AFTER the click:
	 * the flow waits for either a success or failure toast to appear (whichever
	 * comes first), and treats absence-within-timeout as failure. This is the
	 * difference between "click was dispatched" and "server actually accepted".
	 */
	confirm: {
		text?: string
		selector?: string
		verify?: {
			/** Regex matching the success toast text (e.g. /暂停成功|开启成功/). */
			success?: RegExp
			/** Regex matching the failure toast text (e.g. /操作频繁|请稍后/). */
			failure?: RegExp
			/** Optional CSS selector to scope the toast scan. Default: common toast roots. */
			scanSelector?: string
			/** Max wait for a verdict, in ms. Default: 3000. */
			timeoutMs?: number
			/**
			 * Regex matching the toast that confirms the FIRST click (activation)
			 * actually took effect server-side, e.g. /开启成功|启动成功/. When set,
			 * the cooldown countdown (`delays.beforeConfirm`) is anchored at the
			 * moment this toast appears (T0) instead of at click-dispatch time —
			 * so the random pre-click2 wait + popup-wait overlap with the cooldown
			 * instead of stacking on top of it. If not seen within
			 * `activationTimeoutMs`, T0 falls back to ~click1 dispatch time.
			 */
			activationSuccess?: RegExp
			/** Max wait for activationSuccess, in ms. Default: 3000. */
			activationTimeoutMs?: number
		}
	}

	/** Pagination "next page" button (used at the END of each page to advance). */
	nextPage: {
		selector: string
		isDisabled?: (button: HTMLElement) => boolean
	}

	/**
	 * Direct page-number navigation (used when `startPage > 1` to jump there
	 * absolutely instead of clicking next-page N−1 times).
	 *
	 * Defaults target PDD's antd-style `.anq-pagination` markup:
	 *   <li class="anq-pagination-item anq-pagination-item-N" title="N"><a>N</a></li>
	 * with the active page carrying `.anq-pagination-item-active`.
	 */
	pagination?: {
		/** Selector for the pagination container. Default: `.anq-pagination`. */
		containerSelector?: string
		/** Locate the clickable element for page N within the container. */
		findPageButton?: (n: number, container: HTMLElement) => HTMLElement | null
		/** List the page numbers currently visible (i.e. not collapsed in "..."). */
		listVisiblePages?: (container: HTMLElement) => number[]
		/** Read the currently-highlighted page number, or null if undetectable. */
		getCurrentPage?: (container: HTMLElement) => number | null
	}

	delays?: {
		/** Fixed wait between click1 and click2. Default: 1000. Ignored when `betweenToggleClicksRandomMs` is set. */
		betweenToggleClicks?: number
		/**
		 * `[minMs, maxMs]` for a uniform-random wait between click1 and click2.
		 * When set, overrides `betweenToggleClicks`. Useful for human-like pacing
		 * to avoid anti-bot heuristics (PDD shows hand-tuned ~3–5s gaps). Default: unset.
		 */
		betweenToggleClicksRandomMs?: [number, number]
		/**
		 * Server-side cooldown duration after click1 before the confirm button is
		 * accepted. Anchored at the activation-toast moment (T0) when
		 * `verify.activationSuccess` is configured, otherwise at click1 dispatch.
		 * The HUD shows a live ticker on a dedicated aux line; the runner waits
		 * for whatever portion remains after popup appears. Default: 28000.
		 */
		beforeConfirm?: number
		/**
		 * Per-row uniform-random jitter added on top of `beforeConfirm`, in ms.
		 * Each row picks a fresh value in `[0, beforeConfirmJitterMs]`, so the
		 * actual cooldown is `beforeConfirm + jitter`. Used to make timings less
		 * machine-uniform (anti-bot heuristics). Default: 0 (no jitter).
		 */
		beforeConfirmJitterMs?: number
		/** Pause AFTER each row's pause flow finishes (success or failure). Default: 1000. */
		afterRow?: number
		/** Wait after clicking next-page, before scanning rows again. Default: 1500. */
		afterPageChange?: number
	}

	/**
	 * Retry policy for a row when its pause flow fails (e.g. PDD returned
	 * "操作频繁，请稍后再尝试"). The array specifies the wait BEFORE each
	 * retry attempt, in ms. Default: [1000, 2000, 4000] — i.e. up to 3 retries
	 * with exponential backoff after the initial attempt (4 attempts total).
	 *
	 * Each attempt re-checks whether the row's switch is still closed; if a
	 * prior attempt actually succeeded server-side (toggle now reads OPEN/OFF),
	 * we treat the row as done and skip remaining retries.
	 */
	retry?: {
		backoffMs?: number[]
	}

	/** Show the visual mask + animated cursor. Default: true. */
	enableMask?: boolean

	/** Dry-run: log every intended action but don't actually click anything. */
	dryRun?: boolean

	/** Cap the number of pages to process. Default: 200 (safety limit). */
	maxPages?: number

	/**
	 * Resume position: start from this page (1-based). The runner clicks
	 * next-page `(startPage − 1)` times before scanning rows; the first
	 * page-loop iteration uses `startPage` as its `pageNum`. Default: 1.
	 *
	 * Note: this is RELATIVE to the page the user is on when the flow starts —
	 * the runner does not read PDD's actual page indicator. Set startPage = 5
	 * to mean "advance 4 pages from current position".
	 */
	startPage?: number

	/**
	 * Resume position: on the start page only, skip the first
	 * `(startRow − 1)` rows. Subsequent pages are scanned from row 1.
	 * Default: 1.
	 */
	startRow?: number

	/** Optional logger. Default: console.log with a [scripted-flow] prefix. */
	log?: (message: string, ...rest: unknown[]) => void
}

interface ResolvedConfig {
	rowSelector: string
	toggleSelector: string
	isOpen: (toggle: HTMLElement) => boolean
	popup: { selector: string; timeoutMs: number }
	confirm: ScriptedFlowConfig['confirm']
	nextPage: { selector: string; isDisabled: (button: HTMLElement) => boolean }
	pagination: {
		containerSelector: string
		findPageButton: (n: number, container: HTMLElement) => HTMLElement | null
		listVisiblePages: (container: HTMLElement) => number[]
		getCurrentPage: (container: HTMLElement) => number | null
	}
	delays: {
		betweenToggleClicks: number
		betweenToggleClicksRandomMs: [number, number] | null
		beforeConfirm: number
		beforeConfirmJitterMs: number
		afterRow: number
		afterPageChange: number
	}
	retry: { backoffMs: number[] }
	enableMask: boolean
	dryRun: boolean
	maxPages: number
	startPage: number
	startRow: number
	log: (message: string, ...rest: unknown[]) => void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const defaultIsOpen = (toggle: HTMLElement): boolean => {
	const input = toggle.querySelector<HTMLInputElement>('input[type="checkbox"]')
	if (input) return input.checked
	if (toggle.getAttribute('aria-checked') === 'true') return true
	if (toggle.classList.contains('checked') || toggle.classList.contains('ui-switch_checked'))
		return true
	return false
}

const defaultIsDisabled = (button: HTMLElement): boolean => {
	if ((button as HTMLButtonElement).disabled) return true
	if (button.getAttribute('aria-disabled') === 'true') return true
	const cls = button.className
	if (
		typeof cls === 'string' &&
		/(\b|_)(disabled|is-disabled|ui-pagination-disabled)(\b|_)/.test(cls)
	)
		return true
	return false
}

// ---------------------------------------------------------------------------
// Pagination defaults — tuned to PDD's antd-style `.anq-pagination`. The page
// items are `<li class="anq-pagination-item anq-pagination-item-N" title="N">`,
// the active one carries `.anq-pagination-item-active`. Selectors are
// overridable per-preset.
// ---------------------------------------------------------------------------

const DEFAULT_PAGINATION_CONTAINER = '.anq-pagination'

const defaultFindPageButton = (n: number, container: HTMLElement): HTMLElement | null => {
	const byTitle = container.querySelector<HTMLElement>(`li.anq-pagination-item[title="${n}"]`)
	if (byTitle) return byTitle
	const byClass = container.querySelector<HTMLElement>(`li.anq-pagination-item-${n}`)
	if (byClass) return byClass
	// Generic fallback: any <li>/<a>/<button> in the container whose visible text equals N.
	const candidates = Array.from(container.querySelectorAll<HTMLElement>('li, a, button')).filter(
		(el) => el.textContent?.trim() === String(n) && isVisible(el)
	)
	return candidates[0] ?? null
}

const defaultListVisiblePages = (container: HTMLElement): number[] => {
	const items = Array.from(container.querySelectorAll<HTMLElement>('li.anq-pagination-item'))
	const fromItems = items
		.map((el) => parseInt(el.getAttribute('title') ?? '', 10))
		.filter((n) => Number.isFinite(n) && n >= 1)
	if (fromItems.length) return [...new Set(fromItems)].sort((a, b) => a - b)
	// Generic fallback.
	const numeric = Array.from(container.querySelectorAll<HTMLElement>('li, a, button'))
		.map((el) => /^(\d+)$/.exec(el.textContent?.trim() ?? '')?.[1])
		.filter((s): s is string => !!s)
		.map((s) => parseInt(s, 10))
		.filter((n) => Number.isFinite(n) && n >= 1)
	return [...new Set(numeric)].sort((a, b) => a - b)
}

const defaultGetCurrentPage = (container: HTMLElement): number | null => {
	const active = container.querySelector<HTMLElement>('.anq-pagination-item-active')
	if (active) {
		const fromTitle = parseInt(active.getAttribute('title') ?? '', 10)
		if (Number.isFinite(fromTitle) && fromTitle >= 1) return fromTitle
		const fromText = parseInt(active.textContent?.trim() ?? '', 10)
		if (Number.isFinite(fromText) && fromText >= 1) return fromText
	}
	const ariaCurrent = container.querySelector<HTMLElement>('[aria-current="page"]')
	if (ariaCurrent) {
		const n = parseInt(ariaCurrent.textContent?.trim() ?? '', 10)
		if (Number.isFinite(n) && n >= 1) return n
	}
	return null
}

function resolveConfig(c: ScriptedFlowConfig): ResolvedConfig {
	return {
		rowSelector: c.rowSelector,
		toggleSelector: c.toggleSelector,
		isOpen: c.isOpen ?? defaultIsOpen,
		popup: {
			selector: c.popup.selector,
			timeoutMs: c.popup.timeoutMs ?? 5000,
		},
		confirm: c.confirm,
		nextPage: {
			selector: c.nextPage.selector,
			isDisabled: c.nextPage.isDisabled ?? defaultIsDisabled,
		},
		pagination: {
			containerSelector: c.pagination?.containerSelector ?? DEFAULT_PAGINATION_CONTAINER,
			findPageButton: c.pagination?.findPageButton ?? defaultFindPageButton,
			listVisiblePages: c.pagination?.listVisiblePages ?? defaultListVisiblePages,
			getCurrentPage: c.pagination?.getCurrentPage ?? defaultGetCurrentPage,
		},
		delays: {
			betweenToggleClicks: c.delays?.betweenToggleClicks ?? 1000,
			betweenToggleClicksRandomMs: c.delays?.betweenToggleClicksRandomMs ?? null,
			beforeConfirm: c.delays?.beforeConfirm ?? 28000,
			beforeConfirmJitterMs: Math.max(0, Math.floor(c.delays?.beforeConfirmJitterMs ?? 0)),
			afterRow: c.delays?.afterRow ?? 1000,
			afterPageChange: c.delays?.afterPageChange ?? 1500,
		},
		retry: {
			backoffMs: c.retry?.backoffMs ?? [1000, 2000, 4000],
		},
		enableMask: c.enableMask ?? true,
		dryRun: c.dryRun ?? false,
		maxPages: c.maxPages ?? 200,
		startPage: Math.max(1, Math.floor(c.startPage ?? 1)),
		startRow: Math.max(1, Math.floor(c.startRow ?? 1)),
		log: c.log ?? ((msg, ...rest) => console.log(`[scripted-flow] ${msg}`, ...rest)),
	}
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

class AbortError extends Error {
	constructor() {
		super('Scripted flow aborted')
		this.name = 'AbortError'
	}
}

class RetryExhaustedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'RetryExhaustedError'
	}
}

class LocationNotFoundError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'LocationNotFoundError'
	}
}

interface AbortHandle {
	aborted: boolean
}

async function abortableSleep(ms: number, handle: AbortHandle): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < ms) {
		if (handle.aborted) throw new AbortError()
		await sleep(Math.min(100, ms - (Date.now() - start)))
	}
}

function waitFor<T>(
	predicate: () => T | null | undefined,
	timeoutMs: number,
	handle: AbortHandle
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const initial = predicate()
		if (initial) {
			resolve(initial)
			return
		}
		let settled = false
		let observer: MutationObserver | null = null
		let pollId: ReturnType<typeof setInterval> | null = null
		let timeoutId: ReturnType<typeof setTimeout> | null = null
		const cleanup = () => {
			if (observer) observer.disconnect()
			if (pollId !== null) clearInterval(pollId)
			if (timeoutId !== null) clearTimeout(timeoutId)
		}
		const check = () => {
			if (settled) return
			if (handle.aborted) {
				settled = true
				cleanup()
				reject(new AbortError())
				return
			}
			const result = predicate()
			if (result) {
				settled = true
				cleanup()
				resolve(result)
			}
		}
		observer = new MutationObserver(check)
		observer.observe(document.body, { childList: true, subtree: true, attributes: true })
		pollId = setInterval(check, 200)
		timeoutId = setTimeout(() => {
			if (settled) return
			settled = true
			cleanup()
			reject(new Error(`Timed out after ${timeoutMs}ms`))
		}, timeoutMs)
	})
}

const CONFIRM_BUTTON_CANDIDATES =
	'button, a, [role="button"], .ui-button, .MS-button, .ant-btn, .anq-btn'

function findCurrentConfirmButton(popup: HTMLElement, config: ResolvedConfig): HTMLElement | null {
	if (config.confirm.selector) {
		const el = popup.querySelector<HTMLElement>(config.confirm.selector)
		return el && isVisible(el) ? el : null
	}
	const baseText = config.confirm.text?.trim()
	if (!baseText) return null
	const candidates = popup.querySelectorAll<HTMLElement>(CONFIRM_BUTTON_CANDIDATES)
	for (const el of candidates) {
		if (!isVisible(el)) continue
		const text = (el.textContent || '').trim()
		if (text === baseText) return el
		if (text.startsWith(baseText)) {
			const remainder = text.slice(baseText.length).trim()
			if (remainder === '' || /^[(（]?\s*\d+/.test(remainder)) return el
		}
	}
	return null
}

function isConfirmReady(button: HTMLElement, config: ResolvedConfig): boolean {
	if ((button as HTMLButtonElement).disabled) return false
	if (button.getAttribute('aria-disabled') === 'true') return false
	if (config.confirm.text) {
		return (button.textContent || '').trim() === config.confirm.text.trim()
	}
	return true
}

function isVisible(el: Element): boolean {
	if (!(el instanceof HTMLElement)) return false
	if (!el.isConnected) return false
	const rect = el.getBoundingClientRect()
	if (rect.width === 0 && rect.height === 0) return false
	const style = getComputedStyle(el)
	if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
		return false
	return true
}

// Common toast / message component selectors (anq-ui mirrors antd, plus a few
// generic fallbacks). Used to scope the verify-toast scan.
const TOAST_CANDIDATE_SELECTOR = [
	'[class*="anq-message"]',
	'[class*="anq-notification"]',
	'[class*="anq-toast"]',
	'[class*="ant-message"]',
	'[class*="ant-notification"]',
	'[class*="MS-message"]',
	'[class*="message-notice"]',
	'[class*="notification-notice"]',
	'[role="alert"]',
	'[role="status"]',
].join(',')

/**
 * Snapshot the set of toast-like elements whose text already matches either
 * pattern. Used to ignore stale toasts that were on screen BEFORE we clicked
 * the confirm button.
 */
function snapshotMatchingToasts(
	verify: NonNullable<ScriptedFlowConfig['confirm']['verify']>
): Set<HTMLElement> {
	const stale = new Set<HTMLElement>()
	const selector = verify.scanSelector ?? TOAST_CANDIDATE_SELECTOR
	const candidates = document.querySelectorAll<HTMLElement>(selector)
	for (const el of candidates) {
		if (!isVisible(el)) continue
		const text = (el.textContent || '').trim()
		if (!text) continue
		if (verify.success?.test(text)) stale.add(el)
		if (verify.failure?.test(text)) stale.add(el)
	}
	return stale
}

interface VerifyResult {
	ok: boolean
	/** Toast text matched, or a synthetic message if the wait timed out. */
	message: string
}

/**
 * After clicking confirm, watch DOM for a NEW toast whose text matches either
 * `verify.success` or `verify.failure`. Pre-existing matches in `stale` are
 * ignored so we don't latch onto a leftover toast from the previous row.
 *
 * Failure ALWAYS beats success: if both kinds of toasts appear, we report
 * failure. PDD has been observed to show "暂停成功" alongside "操作频繁"
 * during rate-limit responses, so naively returning the first match is wrong.
 *
 * On a success match we wait a short grace window (`successGraceMs`) before
 * committing, in case a failure toast is still arriving on a separate channel.
 */
function waitForToastResult(
	verify: NonNullable<ScriptedFlowConfig['confirm']['verify']>,
	stale: Set<HTMLElement>,
	handle: AbortHandle
): Promise<VerifyResult> {
	const timeoutMs = verify.timeoutMs ?? 3000
	const selector = verify.scanSelector ?? TOAST_CANDIDATE_SELECTOR
	const successGraceMs = 600

	return new Promise<VerifyResult>((resolve, reject) => {
		let settled = false
		let pendingSuccess: string | null = null
		let observer: MutationObserver | null = null
		let pollId: ReturnType<typeof setInterval> | null = null
		let timeoutId: ReturnType<typeof setTimeout> | null = null
		let successCommitId: ReturnType<typeof setTimeout> | null = null

		const cleanup = (): void => {
			if (observer) observer.disconnect()
			if (pollId !== null) clearInterval(pollId)
			if (timeoutId !== null) clearTimeout(timeoutId)
			if (successCommitId !== null) clearTimeout(successCommitId)
		}

		const finishSuccess = (text: string): void => {
			if (settled) return
			settled = true
			cleanup()
			console.log(`[scripted-flow] toast verified — success: "${text}"`)
			resolve({ ok: true, message: text })
		}

		const finishFailure = (text: string): void => {
			if (settled) return
			settled = true
			cleanup()
			console.log(`[scripted-flow] toast verified — failure: "${text}"`)
			resolve({ ok: false, message: text })
		}

		const check = (): void => {
			if (settled) return
			if (handle.aborted) {
				settled = true
				cleanup()
				reject(new AbortError())
				return
			}

			// Two-pass scan: collect failure candidates first; if any present,
			// fail immediately. Otherwise accept success match (after grace delay).
			let failureMatch: string | null = null
			let successMatch: string | null = null

			const candidates = document.querySelectorAll<HTMLElement>(selector)
			for (const el of candidates) {
				if (stale.has(el)) continue
				if (!isVisible(el)) continue
				const text = (el.textContent || '').trim()
				if (!text || text.length > 200) continue
				if (verify.failure?.test(text)) {
					failureMatch = text
					break // failure wins outright
				}
				if (!successMatch && verify.success?.test(text)) {
					successMatch = text
				}
			}

			if (failureMatch) {
				finishFailure(failureMatch)
				return
			}

			if (successMatch && !pendingSuccess) {
				pendingSuccess = successMatch
				// Defer the success commit so a follow-up failure toast (rate-limit
				// races where PDD shows both) still gets the chance to override.
				successCommitId = setTimeout(() => {
					if (pendingSuccess) finishSuccess(pendingSuccess)
				}, successGraceMs)
			}
		}

		observer = new MutationObserver(check)
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
		})
		pollId = setInterval(check, 200)
		timeoutId = setTimeout(() => {
			if (settled) return
			settled = true
			cleanup()
			console.log(
				`[scripted-flow] toast verify timed out after ${timeoutMs}ms — no matching toast seen`
			)
			resolve({ ok: false, message: `${timeoutMs}ms 内未检测到结果反馈 toast` })
		}, timeoutMs)

		// Initial check after a tick — gives the toast a moment to mount.
		setTimeout(check, 50)
	})
}

/**
 * Snapshot toasts whose text already matches a single pattern. Used by the
 * activation-toast wait so a leftover "开启成功" from the previous row doesn't
 * latch onto this row's T0.
 */
function snapshotToastsMatching(pattern: RegExp, scanSelector?: string): Set<HTMLElement> {
	const stale = new Set<HTMLElement>()
	const candidates = document.querySelectorAll<HTMLElement>(
		scanSelector ?? TOAST_CANDIDATE_SELECTOR
	)
	for (const el of candidates) {
		if (!isVisible(el)) continue
		const text = (el.textContent || '').trim()
		if (!text) continue
		if (pattern.test(text)) stale.add(el)
	}
	return stale
}

/**
 * Watch for the first NEW toast matching `pattern`. Resolves with the timestamp
 * (`Date.now()`) when the match is observed. On timeout, resolves to a fallback
 * timestamp = `now − timeoutMs` (an approximation of "click1 dispatch time"),
 * so the cooldown ticker still starts and the row doesn't fail just because
 * the activation toast was missed. The caller is expected to log a warning.
 */
function waitForActivationToast(
	pattern: RegExp,
	scanSelector: string,
	stale: Set<HTMLElement>,
	timeoutMs: number,
	handle: AbortHandle
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		let settled = false
		let observer: MutationObserver | null = null
		let pollId: ReturnType<typeof setInterval> | null = null
		let timeoutId: ReturnType<typeof setTimeout> | null = null

		const cleanup = (): void => {
			if (observer) observer.disconnect()
			if (pollId !== null) clearInterval(pollId)
			if (timeoutId !== null) clearTimeout(timeoutId)
		}

		const check = (): void => {
			if (settled) return
			if (handle.aborted) {
				settled = true
				cleanup()
				reject(new AbortError())
				return
			}
			const candidates = document.querySelectorAll<HTMLElement>(scanSelector)
			for (const el of candidates) {
				if (stale.has(el)) continue
				if (!isVisible(el)) continue
				const text = (el.textContent || '').trim()
				if (!text || text.length > 200) continue
				if (pattern.test(text)) {
					settled = true
					cleanup()
					console.log(`[scripted-flow] activation toast matched: "${text}"`)
					resolve(Date.now())
					return
				}
			}
		}

		observer = new MutationObserver(check)
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
		})
		pollId = setInterval(check, 200)
		timeoutId = setTimeout(() => {
			if (settled) return
			settled = true
			cleanup()
			console.warn(
				`[scripted-flow] activation toast not seen in ${timeoutMs}ms — falling back to click-dispatch timestamp as T0`
			)
			resolve(Date.now() - timeoutMs)
		}, timeoutMs)

		setTimeout(check, 50)
	})
}

const randomBetween = (min: number, max: number): number =>
	Math.floor(min + Math.random() * Math.max(0, max - min))

// ---------------------------------------------------------------------------
// HUD overlay (top-left status panel)
// ---------------------------------------------------------------------------

interface HUDStats {
	rowsActioned: number
	rowsSkippedOpen: number
	rowsWithoutToggle: number
	errors: number
}

interface HUDContext {
	page: number
	maxPages: number
	row: number
	rowsTotal: number
}

interface ErrorEntry {
	page: number
	row: number
	message: string
}

class FlowHUD {
	private el: HTMLDivElement
	private titleEl: HTMLDivElement
	private statusEl: HTMLDivElement
	/**
	 * Optional secondary line below status, used for asynchronous tickers (e.g.
	 * the cooldown countdown that runs in parallel with the click sequence).
	 * Empty by default; doesn't reserve vertical space until populated.
	 */
	private auxEl: HTMLDivElement
	private statsEl: HTMLDivElement
	private errorsEl: HTMLDivElement
	private errors: ErrorEntry[] = []

	constructor() {
		this.el = document.createElement('div')
		this.el.id = 'page-agent-runtime_scripted-hud'
		this.el.setAttribute('data-page-agent-ignore', 'true')
		this.el.setAttribute('data-browser-use-ignore', 'true')
		Object.assign(this.el.style, {
			position: 'fixed',
			top: '20px',
			left: '20px',
			zIndex: '2147483642',
			padding: '12px 16px',
			minWidth: '260px',
			borderRadius: '10px',
			background: 'rgba(20, 22, 32, 0.92)',
			color: '#f5f7fa',
			fontFamily:
				'ui-monospace, "SF Mono", "Menlo", "Cascadia Mono", "Consolas", monospace, system-ui',
			fontSize: '13px',
			lineHeight: '1.55',
			letterSpacing: '0.2px',
			pointerEvents: 'none',
			boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
			backdropFilter: 'blur(6px)',
			border: '1px solid rgba(255,255,255,0.08)',
		})

		this.titleEl = document.createElement('div')
		this.titleEl.style.cssText = 'font-weight:600;margin-bottom:6px;color:#a8c5ff'
		this.titleEl.textContent = '🤖 Scripted Flow'

		this.statusEl = document.createElement('div')
		this.statusEl.style.cssText = 'min-height:20px'

		this.auxEl = document.createElement('div')
		this.auxEl.style.cssText = 'margin-top:2px;font-size:12px;color:#a8c5ff;min-height:0'

		this.statsEl = document.createElement('div')
		this.statsEl.style.cssText =
			'margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);font-size:11px;opacity:0.85'

		// Errors section: hidden until at least one error is reported. Scrolls
		// internally if many errors accumulate so the HUD never grows beyond ~50% viewport.
		this.errorsEl = document.createElement('div')
		this.errorsEl.style.cssText =
			'display:none;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,80,80,0.25);max-height:38vh;overflow-y:auto;font-size:11px;line-height:1.4'

		this.el.append(this.titleEl, this.statusEl, this.auxEl, this.statsEl, this.errorsEl)
		document.body.appendChild(this.el)
	}

	/** Set the secondary status line (HTML allowed for `<b>` highlights). */
	setAux(html: string): void {
		this.auxEl.innerHTML = html
	}

	/** Clear the secondary status line. Safe to call even when never set. */
	clearAux(): void {
		this.auxEl.innerHTML = ''
	}

	update(ctx: HUDContext, status: string, stats: HUDStats): void {
		const pageLine =
			ctx.maxPages < 200
				? `📄 第 <b>${ctx.page}</b> / ${ctx.maxPages} 页`
				: `📄 第 <b>${ctx.page}</b> 页`
		const rowLine =
			ctx.row >= 0
				? `🔘 第 <b>${ctx.row + 1}</b> / ${ctx.rowsTotal} 行`
				: `🔘 — / ${ctx.rowsTotal} 行`
		this.titleEl.innerHTML = `🤖 Scripted Flow &nbsp; <span style="opacity:0.55;font-weight:400">${pageLine} &nbsp; ${rowLine}</span>`
		this.statusEl.innerHTML = status
		this.statsEl.innerHTML = `✓ 已暂停 <b>${stats.rowsActioned}</b> &nbsp; ⏭ 已开/无开关 <b>${stats.rowsSkippedOpen + stats.rowsWithoutToggle}</b> &nbsp; ✗ 失败 <b>${stats.errors}</b>`
	}

	/**
	 * Add or update the error entry for a given (page, row). Multiple attempts
	 * on the same row replace the previous entry rather than stacking, so the
	 * list stays compact and reflects the latest known failure state.
	 */
	addError(entry: ErrorEntry): void {
		const idx = this.errors.findIndex((e) => e.page === entry.page && e.row === entry.row)
		if (idx >= 0) {
			this.errors[idx] = entry
		} else {
			this.errors.push(entry)
		}
		this.renderErrors()
	}

	/** Drop any error entries for the given (page, row), e.g. after a successful retry. */
	removeErrorsForRow(page: number, row: number): void {
		const before = this.errors.length
		this.errors = this.errors.filter((e) => !(e.page === page && e.row === row))
		if (this.errors.length !== before) this.renderErrors()
	}

	private renderErrors(): void {
		if (this.errors.length === 0) {
			this.errorsEl.style.display = 'none'
			this.errorsEl.innerHTML = ''
			return
		}
		this.errorsEl.style.display = 'block'
		this.errorsEl.innerHTML = ''
		this.errors.forEach((entry, i) => {
			const line = document.createElement('div')
			line.style.cssText = 'padding:4px 6px;border-radius:4px;color:#ffb4b4'
			line.style.background = i % 2 === 0 ? 'rgba(255,80,80,0.12)' : 'rgba(255,80,80,0.06)'

			const locator = document.createElement('span')
			locator.style.cssText = 'color:#ff8a8a;font-weight:600;margin-right:6px'
			locator.textContent = `P${entry.page}·R${entry.row + 1}`

			const msg = document.createElement('span')
			msg.style.cssText = 'color:#ffd4d4;word-break:break-word'
			msg.textContent = entry.message

			line.append(locator, msg)
			this.errorsEl.appendChild(line)
		})
		// Keep the freshest entry visible.
		this.errorsEl.scrollTop = this.errorsEl.scrollHeight
	}

	finish(message: string, stats: HUDStats): void {
		this.titleEl.innerHTML =
			'🤖 Scripted Flow &nbsp; <span style="opacity:0.55;font-weight:400">已结束</span>'
		this.statusEl.innerHTML = message
		this.statsEl.innerHTML = `✓ 已暂停 <b>${stats.rowsActioned}</b> &nbsp; ⏭ 已开/无开关 <b>${stats.rowsSkippedOpen + stats.rowsWithoutToggle}</b> &nbsp; ✗ 失败 <b>${stats.errors}</b>`
		// Keep the HUD visible longer when there are errors so the user can read them.
		const lingerMs = this.errors.length > 0 ? 60_000 : 10_000
		setTimeout(() => this.dispose(), lingerMs)
	}

	dispose(): void {
		this.el.remove()
	}
}

// ---------------------------------------------------------------------------
// Core flow
// ---------------------------------------------------------------------------

let runningHandle: AbortHandle | null = null

export function isScriptedFlowRunning(): boolean {
	return !!(runningHandle && !runningHandle.aborted)
}

export async function runScriptedFlow(rawConfig: ScriptedFlowConfig): Promise<void> {
	if (isScriptedFlowRunning()) {
		throw new Error('A scripted flow is already running. Call stopScriptedFlow() first.')
	}

	const config = resolveConfig(rawConfig)
	const { log } = config

	const handle: AbortHandle = { aborted: false }
	runningHandle = handle

	const controller = new PageController({ enableMask: config.enableMask })
	if (config.enableMask) await controller.showMask()

	const hud = config.enableMask ? new FlowHUD() : null

	const stats = {
		pagesProcessed: 0,
		rowsScanned: 0,
		rowsActioned: 0,
		rowsSkippedOpen: 0,
		rowsWithoutToggle: 0,
		errors: 0,
	}

	const ctx: HUDContext = { page: 0, maxPages: config.maxPages, row: -1, rowsTotal: 0 }

	try {
		log('Starting scripted flow', config)
		hud?.update(ctx, '🚀 启动中…', stats)

		// Resume-position: jump directly to startPage by clicking its page-number
		// button in the pagination bar. This is ABSOLUTE — startPage = 6 means
		// PDD's actual page 6, regardless of where the user currently is.
		// Limitation: the target page must be visible in the pagination strip.
		// If PDD has collapsed it inside "...", the user must first click the
		// adjacent ellipsis or a neighbor page so the target becomes visible.
		if (config.startPage > 1) {
			if (handle.aborted) throw new AbortError()
			const container = document.querySelector<HTMLElement>(config.pagination.containerSelector)
			if (!container) {
				throw new LocationNotFoundError(`找不到分页容器 (${config.pagination.containerSelector})`)
			}
			const current = config.pagination.getCurrentPage(container)
			if (current !== config.startPage) {
				const btn = config.pagination.findPageButton(config.startPage, container)
				if (!btn) {
					throw new LocationNotFoundError(
						`第 ${config.startPage} 页不在当前分页条可见范围内（请先点 … 或相邻页码让它出现）`
					)
				}
				hud?.update(ctx, `⏭ 跳到第 ${config.startPage} 页`, stats)
				log(`Navigating to startPage ${config.startPage} via pagination button`)
				if (config.dryRun) {
					log(`[dryRun] would click page button ${config.startPage}`)
				} else {
					await clickElement(btn)
					await abortableSleep(config.delays.afterPageChange, handle)
				}
			} else {
				log(`Already on startPage ${config.startPage}, skipping navigation`)
			}
		}

		for (let pageNum = config.startPage; pageNum <= config.maxPages; pageNum++) {
			if (handle.aborted) throw new AbortError()
			ctx.page = pageNum
			ctx.row = -1
			log(`--- Processing page ${pageNum} ---`)

			const rows = Array.from(document.querySelectorAll<HTMLElement>(config.rowSelector)).filter(
				isVisible
			)
			ctx.rowsTotal = rows.length
			log(`Found ${rows.length} rows on page ${pageNum}`)
			hud?.update(ctx, `📋 扫描到 ${rows.length} 行`, stats)
			stats.pagesProcessed++

			// Resume-position: skip the first (startRow − 1) rows on the start page
			// only. If the configured row doesn't exist on the page, abort — the
			// user pointed somewhere that isn't actually there.
			const rowStartIdx = pageNum === config.startPage ? config.startRow - 1 : 0
			if (pageNum === config.startPage && config.startRow > rows.length) {
				throw new LocationNotFoundError(
					`第 ${config.startPage} 页只有 ${rows.length} 行，找不到第 ${config.startRow} 行`
				)
			}

			for (let i = rowStartIdx; i < rows.length; i++) {
				if (handle.aborted) throw new AbortError()
				const row = rows[i]
				ctx.row = i
				stats.rowsScanned++

				const toggle = row.querySelector<HTMLElement>(config.toggleSelector)
				if (!toggle) {
					stats.rowsWithoutToggle++
					hud?.update(ctx, '⏭ 跳过：无开关（表头/分隔行）', stats)
					continue
				}

				const open = config.isOpen(toggle)
				if (open) {
					log(`Row ${i}: toggle is OPEN, skipping`)
					stats.rowsSkippedOpen++
					hud?.update(ctx, '⏭ 跳过：开关已打开', stats)
					continue
				}

				log(`Row ${i}: toggle is CLOSED, executing pause flow`)

				const maxAttempts = config.retry.backoffMs.length + 1 // initial + retries
				let lastError: Error | null = null
				let succeeded = false

				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					if (handle.aborted) throw new AbortError()

					// Re-resolve the toggle each attempt because PDD may have replaced
					// the DOM node after the previous attempt's click animations.
					const liveToggle = row.querySelector<HTMLElement>(config.toggleSelector)
					if (!liveToggle) {
						lastError = new Error('Toggle disappeared from row between attempts')
						break
					}

					// State semantics on PDD's promotion list:
					//   CLOSED toggle = promotion is paused (this is what we filter for at row entry)
					//   OPEN toggle   = promotion is running
					// After a failed pause attempt the toggle stays OPEN (server rejected
					// the close), so retries must adapt: skip the initial "open it first"
					// preamble and go straight to the popup-triggering click.
					const startedOpen = config.isOpen(liveToggle)
					if (attempt === 1 && startedOpen) {
						// First attempt but row started OPEN? — earlier scan must have raced
						// with PDD changing state. Skip rather than risk side-effects.
						log(`Row ${i}: toggle unexpectedly OPEN at first attempt, skipping`)
						stats.rowsSkippedOpen++
						hud?.update(ctx, '⏭ 跳过：开关已打开（首次扫描后状态变化）', stats)
						break
					}

					if (attempt > 1) {
						const waitMs = config.retry.backoffMs[attempt - 2]
						const waitS = Math.round(waitMs / 1000)
						hud?.update(
							ctx,
							`⏳ 第 ${attempt - 1}/${maxAttempts - 1} 次重试前等待 <b>${waitS}s</b>`,
							stats
						)
						await abortableSleep(waitMs, handle)
					}

					// Skip the spec's countdown on retries — the popup countdown is
					// only meant for the initial attempt; subsequent attempts rely on
					// the wait-for-clickable check (5s) plus the retry backoff.
					const skipCountdown = attempt > 1

					try {
						await pauseRow(
							row,
							liveToggle,
							startedOpen,
							skipCountdown,
							config,
							handle,
							hud,
							ctx,
							stats
						)
						succeeded = true
						lastError = null
						break
					} catch (err) {
						if (err instanceof AbortError) throw err
						lastError = err as Error
						log(`Row ${i} attempt ${attempt}/${maxAttempts}: failed — ${lastError.message}`)
						const attemptMessage = `[尝试 ${attempt}/${maxAttempts}] ${lastError.message}`
						hud?.update(ctx, `❌ ${attemptMessage}`, stats)
						// Surface the error in the HUD list immediately so long retry runs
						// don't leave the user wondering. The list overwrites per-row, so a
						// later successful retry will clean it up.
						hud?.addError({ page: pageNum, row: i, message: attemptMessage })
					}
				}

				if (succeeded) {
					stats.rowsActioned++
					hud?.update(ctx, '✅ 已暂停', stats)
					// Successful retry — clear any provisional error rows we added.
					hud?.removeErrorsForRow(pageNum, i)
				} else if (lastError) {
					stats.errors++
					const finalMessage = `[${maxAttempts} 次尝试均失败] ${lastError.message}`
					hud?.update(ctx, `❌ 失败：${finalMessage}`, stats)
					hud?.addError({ page: pageNum, row: i, message: finalMessage })
					// Halt the entire flow — the user explicitly does not want to keep
					// pressing on after exhausting retries on a single row.
					throw new RetryExhaustedError(`第 ${pageNum} 页第 ${i + 1} 行：${finalMessage}`)
				}

				await abortableSleep(config.delays.afterRow, handle)
			}

			const nextBtn = document.querySelector<HTMLElement>(config.nextPage.selector)
			if (!nextBtn) {
				log('No next-page button found — flow complete')
				hud?.update(ctx, '🏁 没有下一页按钮，流程结束', stats)
				break
			}
			if (config.nextPage.isDisabled(nextBtn)) {
				log('Next-page button is disabled — flow complete')
				hud?.update(ctx, '🏁 下一页禁用，流程结束', stats)
				break
			}

			log('Clicking next-page button')
			hud?.update(ctx, '➡ 翻到下一页', stats)
			if (config.dryRun) {
				log('[dryRun] would click next-page')
				break
			}
			await clickElement(nextBtn)
			await abortableSleep(config.delays.afterPageChange, handle)
		}

		log('Scripted flow finished', stats)
		hud?.finish('🏁 流程结束', stats)
	} catch (err) {
		if (err instanceof AbortError) {
			log('Scripted flow aborted by user', stats)
			hud?.finish('🛑 已停止', stats)
		} else if (err instanceof RetryExhaustedError) {
			log(`Scripted flow halted after retry exhaustion: ${err.message}`, stats)
			hud?.finish(`🛑 重试均失败，已中止流程：${err.message}`, stats)
		} else if (err instanceof LocationNotFoundError) {
			log(`Scripted flow halted: location not found — ${err.message}`, stats)
			hud?.finish(`🛑 找不到指定位置：${err.message}`, stats)
		} else {
			log(`Scripted flow errored: ${(err as Error).message}`, stats)
			hud?.finish(`💥 出错：${(err as Error).message}`, stats)
			throw err
		}
	} finally {
		if (config.enableMask) await controller.hideMask()
		controller.dispose()
		if (runningHandle === handle) runningHandle = null
	}
}

async function pauseRow(
	row: HTMLElement,
	toggle: HTMLElement,
	startedOpen: boolean,
	skipCountdown: boolean,
	config: ResolvedConfig,
	handle: AbortHandle,
	hud: FlowHUD | null,
	ctx: HUDContext,
	stats: HUDStats
): Promise<void> {
	const { log } = config
	const verify = config.confirm.verify

	if (config.dryRun) {
		log(
			(startedOpen
				? '[dryRun] retry-from-OPEN: would click once, wait popup, '
				: '[dryRun] would click toggle, wait toast/random, click again, wait popup, ') +
				(skipCountdown ? '[skip cooldown] ' : 'wait cooldown remainder, ') +
				'click confirm, verify'
		)
		return
	}

	let liveToggle = toggle
	// Cooldown anchor — non-null only on initial attempts where we actually
	// activated the row. Retry attempts (startedOpen=true) and skipCountdown
	// callers leave it null and the post-popup wait short-circuits.
	let cooldownDeadline: number | null = null
	let tickerId: ReturnType<typeof setInterval> | null = null

	try {
		if (!startedOpen) {
			// click1 — flips the row ON, which triggers PDD's server-side cooldown.
			// Anchor T0 at the activation toast (when configured) so the random
			// pre-click2 wait + popup wait overlap with the cooldown instead of
			// stacking on top of it.
			const activationStale = verify?.activationSuccess
				? snapshotToastsMatching(verify.activationSuccess, verify.scanSelector)
				: new Set<HTMLElement>()

			hud?.update(ctx, '🖱 第 1 次点击开关', stats)
			await clickElement(liveToggle)

			let t0: number
			if (verify?.activationSuccess && !skipCountdown) {
				hud?.update(ctx, '⏳ 等待启动反馈…', stats)
				t0 = await waitForActivationToast(
					verify.activationSuccess,
					verify.scanSelector ?? TOAST_CANDIDATE_SELECTOR,
					activationStale,
					verify.activationTimeoutMs ?? 3000,
					handle
				)
			} else {
				t0 = Date.now()
			}

			if (!skipCountdown) {
				// Per-row jitter: makes timings less machine-uniform. Picked once
				// per row so the same row's retries don't keep rolling new values
				// (retries skip this block entirely anyway).
				const jitter =
					config.delays.beforeConfirmJitterMs > 0
						? Math.floor(Math.random() * config.delays.beforeConfirmJitterMs)
						: 0
				cooldownDeadline = t0 + config.delays.beforeConfirm + jitter
				if (jitter > 0) {
					log(
						`Cooldown for this row: ${config.delays.beforeConfirm}ms + ${jitter}ms jitter = ${config.delays.beforeConfirm + jitter}ms`
					)
				}
				const deadline = cooldownDeadline
				const tick = (): void => {
					const remainMs = Math.max(0, deadline - Date.now())
					if (remainMs > 0) {
						const s = Math.ceil(remainMs / 1000)
						hud?.setAux(`⏳ 服务端冷却剩余 <b>${s}</b>s`)
					} else {
						hud?.setAux('✓ 服务端冷却完成')
					}
				}
				tick()
				tickerId = setInterval(tick, 250)
			}

			const randomRange = config.delays.betweenToggleClicksRandomMs
			const waitMs = randomRange
				? randomBetween(randomRange[0], randomRange[1])
				: config.delays.betweenToggleClicks
			hud?.update(ctx, `⏳ 等 ${(waitMs / 1000).toFixed(1)}s 再点第二次`, stats)
			await abortableSleep(waitMs, handle)
			if (handle.aborted) throw new AbortError()

			const refreshed = row.querySelector<HTMLElement>(config.toggleSelector)
			if (refreshed && refreshed.isConnected) liveToggle = refreshed
		} else {
			log('Row is OPEN — skipping initial activation step (retry from previous failure)')
		}

		// Click that triggers the Popconfirm. From CLOSED-start this is the 2nd click;
		// from OPEN-start (retry) this is the only click.
		hud?.update(ctx, startedOpen ? '🖱 点击开关触发弹窗' : '🖱 第 2 次点击开关', stats)
		await clickElement(liveToggle)

		hud?.update(ctx, '⏳ 等待弹窗出现', stats)
		const popup = await waitFor<HTMLElement>(
			() => {
				const candidates = document.querySelectorAll<HTMLElement>(config.popup.selector)
				for (const el of candidates) if (isVisible(el)) return el
				return null
			},
			config.popup.timeoutMs,
			handle
		)
		log('Popup appeared')

		// Wait for whatever cooldown remains. Common case: the random + click2 +
		// popup-wait already consumed most of it; we just block briefly here.
		// Fast-path skipped on retries (cooldownDeadline === null).
		if (cooldownDeadline !== null) {
			const remaining = cooldownDeadline - Date.now()
			if (remaining > 0) {
				const s = Math.ceil(remaining / 1000)
				hud?.update(ctx, `⏳ 等冷却归零（剩余 <b>${s}</b>s）`, stats)
				await sleepUntilDeadline(cooldownDeadline, popup, handle)
			} else {
				log(`Cooldown already elapsed by ${-remaining}ms when popup appeared`)
			}
		}

		hud?.update(ctx, '⏳ 等待按钮就绪…', stats)
		const confirmBtn = await waitFor<HTMLElement>(
			() => {
				const btn = findCurrentConfirmButton(popup, config)
				return btn && isConfirmReady(btn, config) ? btn : null
			},
			5000,
			handle
		)
		log('Confirm button ready, clicking')

		// Snapshot any pre-existing matching toasts BEFORE the click so we don't
		// latch onto leftover messages from the previous row.
		const stale = verify ? snapshotMatchingToasts(verify) : null

		hud?.update(ctx, '🖱 点击「确定暂停」', stats)
		await clickElement(confirmBtn)

		if (verify && stale) {
			hud?.update(ctx, '⏳ 等待结果反馈…', stats)
			const result = await waitForToastResult(verify, stale, handle)
			if (!result.ok) {
				throw new Error(result.message)
			}
			log(`Confirm verified: ${result.message}`)
		}
	} finally {
		if (tickerId !== null) clearInterval(tickerId)
		hud?.clearAux()
	}
}

/**
 * Block until `deadlineMs` while the popup stays mounted. Throws AbortError on
 * stop request, or a generic Error when the popup vanishes mid-wait (which
 * means the user — or the page — closed our pause dialog and the run can no
 * longer proceed). Polls every 250ms; the visible countdown is driven by a
 * separate ticker on the HUD's aux line.
 */
async function sleepUntilDeadline(
	deadlineMs: number,
	popup: HTMLElement,
	handle: AbortHandle
): Promise<void> {
	while (Date.now() < deadlineMs) {
		if (handle.aborted) throw new AbortError()
		if (!popup.isConnected || !isVisible(popup)) {
			throw new Error('Popup disappeared during cooldown wait')
		}
		const remaining = deadlineMs - Date.now()
		await sleep(Math.min(250, remaining))
	}
}

export function stopScriptedFlow(): boolean {
	if (!runningHandle || runningHandle.aborted) return false
	runningHandle.aborted = true
	console.log('[scripted-flow] stop requested')
	return true
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Preset for `yingxiao.pinduoduo.com/goods/promotion/list` (PDD promotion list).
 *
 * The page is built with PDD's `anq-ui` library (antd-style naming):
 *   - rows:     `.anq-table-row`
 *   - switches: `<button role="switch" aria-checked="true|false" class="anq-switch ...">`
 *   - pagination: `.anq-pagination-next`, disabled state via `.anq-pagination-disabled` +
 *                 `aria-disabled="true"`
 *   - confirm popup: `.anq-popover` (Popconfirm-style; portal-mounted under body),
 *                    confirm button is `<button class="anq-btn anq-btn-primary">确定暂停</button>`
 */
export const pddPromotionPreset: ScriptedFlowConfig = {
	rowSelector: '.anq-table-row',
	toggleSelector: '.anq-switch, [role="switch"]',
	popup: {
		selector: '.anq-popover',
		timeoutMs: 5000,
	},
	confirm: {
		text: '确定暂停',
		// PDD shows an `.anq-message` toast after the action lands on the server:
		//   - "暂停成功" / "开启成功" → success
		//   - "操作频繁，请稍后再尝试" / "失败" / etc. → real failure
		// Without this check, a rejected request would still look like success
		// because clickElement never throws on its own.
		verify: {
			success: /(暂停|开启|操作)成功/,
			// Broad failure pattern — anything PDD/anq-ui has shown for rejected actions.
			// `频率` / `太快` / `请勿` / `请重试` cover the common rate-limit phrasings;
			// `失败` / `错误` / `异常` / `不能` catch generic errors. We DON'T match
			// just `频繁` because the popup body itself contains "频繁启停可能..."
			// (would cause false positives). `操作频繁` is the actual toast wording.
			failure: /操作频繁|请稍后|请重试|请勿|频率|限流|太快|失败|错误|异常|不能|未能|无法|拒绝/,
			timeoutMs: 3000,
			// Activation toast = "开启成功" (sometimes "启动成功" / "启用成功" depending on PDD copy).
			// We anchor the cooldown countdown at this toast so the random pre-click2 wait
			// + popup wait overlap with the 30s server-side cooldown.
			activationSuccess: /(开启|启动|启用)成功/,
			activationTimeoutMs: 3000,
		},
	},
	nextPage: {
		selector: '.anq-pagination-next',
	},
	delays: {
		// Human-like jitter between click1 and click2 to dodge anti-bot heuristics.
		// Concurrent with the cooldown ticker, so it doesn't add to total runtime.
		betweenToggleClicksRandomMs: [3000, 5000],
		beforeConfirm: 30000,
		// 0–800ms per-row jitter on top of beforeConfirm — actual cooldown is
		// 30.0–30.8s, picked fresh for each row.
		beforeConfirmJitterMs: 800,
		afterPageChange: 1500,
	},
	enableMask: true,
}

// ---------------------------------------------------------------------------
// Panel button injection — adds a 🤖 button to the page-agent panel header,
// to the LEFT of the ⚡ quick-tasks button. Click opens a popover listing
// available scripted flows. Used by both `demo.ts` and the website's
// HeroSection so the user can launch a flow without opening DevTools.
// ---------------------------------------------------------------------------

const SCRIPTED_BUTTON_ID = 'page-agent-runtime_scripted-flow-button'
const SCRIPTED_POPOVER_ID = 'page-agent-runtime_scripted-flow-popover'

export interface ScriptedFlowItem {
	/** Short name shown in bold at the top of the popover row. */
	name: string
	/** Longer description shown beneath the name. */
	description: string
	/** Preset to run when the user clicks this item. */
	preset: ScriptedFlowConfig
}

export interface InjectButtonOptions {
	/** List of scripted flows shown in the popover. Default: PDD pause flow. */
	items?: ScriptedFlowItem[]
	label?: string
	runningLabel?: string
	title?: string
	runningTitle?: string
	/** Max retries waiting for the panel DOM to appear (one retry every 150ms). Default: 20. */
	maxRetries?: number
}

function isZhLanguage(): boolean {
	// Prefer the panel's actual language (set when user constructed PageAgent),
	// then fall back to <html lang> / navigator.language. Strings look like
	// "zh-CN" or "en-US"; we only care about the primary subtag.
	const lang =
		window.pageAgent?.config.language ?? document.documentElement.lang ?? navigator.language ?? ''
	return lang.toLowerCase().startsWith('zh')
}

function getDefaultItems(): ScriptedFlowItem[] {
	const isZh = isZhLanguage()
	return [
		{
			name: isZh ? 'PDD 批量推广001' : 'PDD batch promotion 001',
			description: isZh
				? '拼多多推广列表 / 翻完全部页 / 暂停所有未开启行'
				: 'Pinduoduo promotion list — paginate through all pages, pause every closed row',
			preset: pddPromotionPreset,
		},
	]
}

export function injectScriptedFlowButton(options: InjectButtonOptions = {}): void {
	const items = options.items ?? getDefaultItems()
	const label = options.label ?? '🤖'
	const runningLabel = options.runningLabel ?? '⏹'
	const title = options.title ?? '运行脚本流程'
	const runningTitle = options.runningTitle ?? '停止脚本流程'
	const maxRetries = options.maxRetries ?? 20

	const attempt = (retriesLeft: number): void => {
		const panel = document.getElementById('page-agent-runtime_agent-panel')
		if (!panel) {
			if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 150)
			return
		}

		// Replace any prior button so calling inject again with a new items list
		// rewires the click handler. Cheap (single element) and lets callers
		// extend the flow list later via re-call.
		const existing = panel.querySelector<HTMLButtonElement>(`#${SCRIPTED_BUTTON_ID}`)
		existing?.remove()
		document.getElementById(SCRIPTED_POPOVER_ID)?.remove()

		const quickTasksButton = panel.querySelector<HTMLElement>('[class*="quickTasksButton"]')
		const controlsContainer =
			quickTasksButton?.parentElement ?? panel.querySelector<HTMLElement>('[class*="controls"]')
		if (!controlsContainer) {
			console.warn('[scripted-flow] panel controls container not found — button not injected')
			return
		}

		// Reuse the panel's `controlButton` hashed class for visual consistency.
		const styleSource = quickTasksButton ?? controlsContainer.querySelector<HTMLElement>('button')
		const sharedClasses = styleSource
			? Array.from(styleSource.classList).filter((c) => {
					const lc = c.toLowerCase()
					return (
						!lc.includes('quicktasks') &&
						!lc.includes('settings') &&
						!lc.includes('expand') &&
						!lc.includes('stop')
					)
				})
			: []

		const button = document.createElement('button')
		button.id = SCRIPTED_BUTTON_ID
		button.type = 'button'
		if (sharedClasses.length) button.classList.add(...sharedClasses)
		button.textContent = label
		button.title = title
		button.setAttribute('aria-label', title)

		if (quickTasksButton) {
			controlsContainer.insertBefore(button, quickTasksButton)
		} else {
			controlsContainer.prepend(button)
		}

		const refresh = (): void => {
			const running = isScriptedFlowRunning()
			button.textContent = running ? runningLabel : label
			button.title = running ? runningTitle : title
		}

		button.addEventListener('click', () => {
			if (isScriptedFlowRunning()) {
				stopScriptedFlow()
				refresh()
				return
			}
			toggleScriptedFlowPopover(button, items, refresh)
		})
	}

	attempt(maxRetries)
}

function toggleScriptedFlowPopover(
	button: HTMLElement,
	items: ScriptedFlowItem[],
	refresh: () => void
): void {
	const existing = document.getElementById(SCRIPTED_POPOVER_ID)
	if (existing) {
		existing.remove()
		return
	}
	openScriptedFlowPopover(button, items, refresh)
}

function openScriptedFlowPopover(
	button: HTMLElement,
	items: ScriptedFlowItem[],
	refresh: () => void
): void {
	const pop = document.createElement('div')
	pop.id = SCRIPTED_POPOVER_ID
	pop.setAttribute('data-page-agent-ignore', 'true')
	pop.setAttribute('data-browser-use-ignore', 'true')
	Object.assign(pop.style, {
		position: 'fixed',
		zIndex: '2147483646',
		maxHeight: '320px',
		overflowY: 'auto',
		minWidth: '280px',
		background: 'rgba(2, 0, 20, 0.85)',
		backdropFilter: 'blur(12px)',
		border: '2px solid rgba(255, 255, 255, 0.4)',
		borderRadius: '14px',
		padding: '8px',
		boxShadow: '0 0 0 2px rgba(255, 255, 255, 0.15), 0 8px 32px rgba(0, 0, 0, 0.6)',
		boxSizing: 'border-box',
		fontFamily:
			'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
		color: 'white',
	})

	if (items.length === 0) {
		const empty = document.createElement('div')
		empty.textContent = '暂无脚本流程 / No scripted flows'
		Object.assign(empty.style, {
			padding: '16px',
			textAlign: 'center',
			color: 'rgba(255,255,255,0.45)',
			fontSize: '12px',
		})
		pop.appendChild(empty)
	} else {
		items.forEach((item, i) => pop.appendChild(buildPopoverItem(item, i, button, pop, refresh)))
	}

	document.body.appendChild(pop)

	// Mirror the panel's quick-tasks popover: a tray that's slightly inset from
	// the panel's outer edges and horizontally centered with it. The button only
	// decides vertical orientation (panel is bottom-fixed, so we usually open up).
	const panel = document.getElementById('page-agent-runtime_agent-panel')
	const btnRect = button.getBoundingClientRect()
	const panelRect = panel?.getBoundingClientRect() ?? null

	const popWidth = panelRect
		? Math.max(260, panelRect.width - 8)
		: Math.max(280, Math.min(420, 360))
	pop.style.width = `${popWidth}px`

	const baseLeft = panelRect ? panelRect.left + (panelRect.width - popWidth) / 2 : btnRect.left
	const left = Math.max(8, Math.min(window.innerWidth - popWidth - 8, baseLeft))
	pop.style.left = `${left}px`

	const popHeight = pop.offsetHeight
	if (btnRect.bottom > window.innerHeight / 2) {
		pop.style.top = `${Math.max(8, btnRect.top - popHeight - 8)}px`
	} else {
		pop.style.top = `${btnRect.bottom + 8}px`
	}

	// Close on outside click or ESC.
	const cleanup = (): void => {
		pop.remove()
		document.removeEventListener('click', handleOutside, true)
		document.removeEventListener('keydown', handleKey, true)
	}
	const handleOutside = (e: MouseEvent): void => {
		const target = e.target as HTMLElement | null
		if (!target) return
		if (pop.contains(target)) return
		if (button.contains(target)) return
		cleanup()
	}
	const handleKey = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') cleanup()
	}
	// Defer registration so the click that opened the popover doesn't immediately close it.
	setTimeout(() => {
		document.addEventListener('click', handleOutside, true)
		document.addEventListener('keydown', handleKey, true)
	}, 0)
}

const POPOVER_ACCENT_RGBS = [
	'57, 182, 255', // blue
	'189, 69, 251', // purple
	'72, 187, 120', // green
	'237, 137, 54', // orange
	'251, 113, 133', // pink
]

const COUNTDOWN_STORAGE_PREFIX = 'page-agent:scripted-flow:countdown:'

/** Resolve the seconds shown in the editable countdown field for a given item. */
function getStoredCountdownSec(item: ScriptedFlowItem): number {
	try {
		const raw = localStorage.getItem(COUNTDOWN_STORAGE_PREFIX + item.name)
		if (raw !== null) {
			const n = parseInt(raw, 10)
			if (Number.isFinite(n) && n >= 0) return n
		}
	} catch {
		// localStorage may be disabled — fall through to preset default.
	}
	return Math.max(0, Math.round((item.preset.delays?.beforeConfirm ?? 28000) / 1000))
}

function setStoredCountdownSec(item: ScriptedFlowItem, sec: number): void {
	try {
		localStorage.setItem(COUNTDOWN_STORAGE_PREFIX + item.name, String(sec))
	} catch {
		// ignore
	}
}

const START_PAGE_STORAGE_PREFIX = 'page-agent:scripted-flow:start-page:'
const START_ROW_STORAGE_PREFIX = 'page-agent:scripted-flow:start-row:'

function getStoredPositiveInt(key: string, fallback: number): number {
	try {
		const raw = localStorage.getItem(key)
		if (raw !== null) {
			const n = parseInt(raw, 10)
			if (Number.isFinite(n) && n >= 1) return n
		}
	} catch {
		// localStorage may be disabled
	}
	return fallback
}

function setStoredPositiveInt(key: string, n: number): void {
	try {
		localStorage.setItem(key, String(Math.max(1, Math.floor(n))))
	} catch {
		// ignore
	}
}

/**
 * Sniff the PDD-style `.anq-pagination` strip so the popover can populate the
 * start-page dropdown with the page numbers actually visible (not collapsed in
 * "..."), and the start-row dropdown with the configured per-page count.
 *
 * Returns null when the container isn't found (e.g. user opened the bookmarklet
 * on a non-list page) — caller falls back to free integer input.
 */
function detectPaginationInfo(): {
	visiblePages: number[]
	currentPage: number | null
	perPage: number | null
} | null {
	const container = document.querySelector<HTMLElement>(DEFAULT_PAGINATION_CONTAINER)
	if (!container) return null
	const visiblePages = defaultListVisiblePages(container)
	if (!visiblePages.length) return null
	const currentPage = defaultGetCurrentPage(container)
	// "每页 X 条" lives inside the same .anq-pagination ul on PDD.
	const perMatch = /每页\s*(\d+)\s*条/.exec(container.textContent ?? '')
	const perPage = perMatch ? parseInt(perMatch[1], 10) : null
	return {
		visiblePages,
		currentPage,
		perPage: perPage && Number.isFinite(perPage) && perPage > 0 ? perPage : null,
	}
}

function buildPopoverItem(
	item: ScriptedFlowItem,
	index: number,
	button: HTMLElement,
	pop: HTMLElement,
	refresh: () => void
): HTMLElement {
	const accent = POPOVER_ACCENT_RGBS[index % POPOVER_ACCENT_RGBS.length]
	// Use a div + role=button so we can nest a native <input> inside (which is
	// invalid HTML inside <button>). Keyboard activation is handled below.
	const itemEl = document.createElement('div')
	itemEl.setAttribute('role', 'button')
	itemEl.tabIndex = 0
	itemEl.dataset.index = String(index)
	Object.assign(itemEl.style, {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
		width: '100%',
		textAlign: 'left',
		padding: '10px 14px',
		marginBottom: '6px',
		background: `linear-gradient(135deg, rgba(${accent}, 0.18), rgba(${accent}, 0.06))`,
		border: 'none',
		borderLeft: `3px solid rgba(${accent}, 0.85)`,
		borderRadius: '8px',
		color: 'white',
		cursor: 'pointer',
		fontFamily: 'inherit',
		boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 3px rgba(0,0,0,0.15)',
		transition: 'background 0.15s ease, transform 0.15s ease',
		boxSizing: 'border-box',
	})

	const body = document.createElement('span')
	Object.assign(body.style, {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		flex: '1',
		minWidth: '0',
		overflow: 'hidden',
	})
	const nameEl = document.createElement('span')
	Object.assign(nameEl.style, {
		fontSize: '13px',
		fontWeight: '600',
		lineHeight: '1.2',
		color: 'white',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	})
	nameEl.textContent = item.name
	const descEl = document.createElement('span')
	Object.assign(descEl.style, {
		fontSize: '11px',
		lineHeight: '1.3',
		color: 'rgba(255,255,255,0.55)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	})
	descEl.textContent = item.description
	body.append(nameEl, descEl)
	itemEl.appendChild(body)
	itemEl.title = item.description

	// Right-side compact controls: start page / start row / countdown.
	// Page + row are constrained to detected PDD pagination when present
	// ("共 X 条 每页 Y 条" parsed at popover open); otherwise free integer input.
	// Countdown stays as before — shown only when the preset has a real countdown step.
	const isZh = isZhLanguage()
	const paging = detectPaginationInfo()
	const hasCountdown = (item.preset.delays?.beforeConfirm ?? 0) > 0
	const stopBubble = (e: Event): void => e.stopPropagation()
	const enterLaunches = (e: KeyboardEvent): void => {
		e.stopPropagation()
		if (e.key === 'Enter') itemEl.click()
	}
	const inputBaseStyle: Record<string, string> = {
		padding: '2px 4px',
		background: 'rgba(0,0,0,0.25)',
		color: 'white',
		border: '1px solid rgba(255,255,255,0.18)',
		borderRadius: '4px',
		fontFamily: 'inherit',
		fontSize: '12px',
		outline: 'none',
	}
	const subUnitStyle: Record<string, string> = {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		flexShrink: '0',
		padding: '4px 8px',
		background: 'rgba(255,255,255,0.08)',
		borderRadius: '6px',
		border: '1px solid rgba(255,255,255,0.1)',
	}
	const labelStyle: Record<string, string> = {
		fontSize: '11px',
		color: 'rgba(255,255,255,0.55)',
		fontFamily: 'inherit',
	}

	const buildSubUnit = (
		prefix: string,
		control: HTMLElement,
		suffix: string,
		title: string
	): HTMLElement => {
		const box = document.createElement('span')
		Object.assign(box.style, subUnitStyle)
		box.title = title
		if (prefix) {
			const p = document.createElement('span')
			p.textContent = prefix
			Object.assign(p.style, labelStyle)
			box.appendChild(p)
		}
		box.appendChild(control)
		if (suffix) {
			const s = document.createElement('span')
			s.textContent = suffix
			Object.assign(s.style, labelStyle)
			box.appendChild(s)
		}
		return box
	}

	const makeRangeControl = (
		storageKey: string,
		validValues: number[] | null,
		fallbackValue: number
	): { element: HTMLElement; getValue: () => number } => {
		const stored = getStoredPositiveInt(storageKey, fallbackValue)
		if (validValues && validValues.length > 0) {
			const select = document.createElement('select')
			Object.assign(select.style, { ...inputBaseStyle, minWidth: '46px' })
			for (const v of validValues) {
				const opt = document.createElement('option')
				opt.value = String(v)
				opt.textContent = String(v)
				select.appendChild(opt)
			}
			const initial = validValues.includes(stored)
				? stored
				: validValues.includes(fallbackValue)
					? fallbackValue
					: validValues[0]
			select.value = String(initial)
			select.addEventListener('click', stopBubble)
			select.addEventListener('mousedown', stopBubble)
			select.addEventListener('keydown', stopBubble)
			select.addEventListener('change', () => {
				const n = parseInt(select.value, 10) || fallbackValue
				setStoredPositiveInt(storageKey, n)
			})
			return {
				element: select,
				getValue: () => parseInt(select.value, 10) || fallbackValue,
			}
		}
		const input = document.createElement('input')
		input.type = 'number'
		input.min = '1'
		input.step = '1'
		input.value = String(Math.max(1, stored))
		Object.assign(input.style, {
			...inputBaseStyle,
			width: '44px',
			textAlign: 'right',
			fontFamily: 'ui-monospace, "SF Mono", "Menlo", "Cascadia Mono", "Consolas", monospace',
		})
		input.addEventListener('click', stopBubble)
		input.addEventListener('mousedown', stopBubble)
		input.addEventListener('keydown', enterLaunches)
		input.addEventListener('change', () => {
			const n = Math.max(1, parseInt(input.value, 10) || 1)
			input.value = String(n)
			setStoredPositiveInt(storageKey, n)
		})
		return { element: input, getValue: () => Math.max(1, parseInt(input.value, 10) || 1) }
	}

	const right = document.createElement('span')
	Object.assign(right.style, {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		flexShrink: '0',
	})

	const rowValues = paging?.perPage ? Array.from({ length: paging.perPage }, (_, i) => i + 1) : null
	const pageDefault = paging?.currentPage ?? 1
	const pageCtrl = makeRangeControl(
		START_PAGE_STORAGE_PREFIX + item.name,
		paging?.visiblePages ?? null,
		pageDefault
	)
	const rowCtrl = makeRangeControl(START_ROW_STORAGE_PREFIX + item.name, rowValues, 1)

	const pageTooltip = (() => {
		if (!paging) return isZh ? '起始页（未检测到分页）' : 'Start page (no pagination detected)'
		const list = paging.visiblePages.join(', ')
		const cur = paging.currentPage != null ? `当前 ${paging.currentPage}, ` : ''
		return isZh
			? `起始页（${cur}可选 ${list}；其他页请先在分页条点出来）`
			: `Start page (${paging.currentPage != null ? `now ${paging.currentPage}, ` : ''}options: ${list})`
	})()
	const rowTooltip = paging?.perPage
		? isZh
			? `起始行 (1 – ${paging.perPage})`
			: `Start row (1 – ${paging.perPage})`
		: isZh
			? '起始行（未检测到每页行数）'
			: 'Start row (per-page count not detected)'

	right.appendChild(buildSubUnit(isZh ? '页' : 'P', pageCtrl.element, '', pageTooltip))
	right.appendChild(buildSubUnit(isZh ? '行' : 'R', rowCtrl.element, '', rowTooltip))

	let countdownInput: HTMLInputElement | null = null
	if (hasCountdown) {
		countdownInput = document.createElement('input')
		countdownInput.type = 'number'
		countdownInput.min = '0'
		countdownInput.max = '600'
		countdownInput.step = '1'
		countdownInput.value = String(getStoredCountdownSec(item))
		Object.assign(countdownInput.style, {
			...inputBaseStyle,
			width: '44px',
			textAlign: 'right',
			fontFamily: 'ui-monospace, "SF Mono", "Menlo", "Cascadia Mono", "Consolas", monospace',
		})
		countdownInput.addEventListener('click', stopBubble)
		countdownInput.addEventListener('mousedown', stopBubble)
		countdownInput.addEventListener('keydown', enterLaunches)
		countdownInput.addEventListener('change', () => {
			const n = Math.max(0, parseInt(countdownInput!.value, 10) || 0)
			countdownInput!.value = String(n)
			setStoredCountdownSec(item, n)
		})
		right.appendChild(
			buildSubUnit(
				'',
				countdownInput,
				's',
				isZh ? '点击编辑倒计时秒数' : 'Click to edit countdown seconds'
			)
		)
	}

	itemEl.appendChild(right)

	itemEl.addEventListener('mouseenter', () => {
		itemEl.style.background = `linear-gradient(135deg, rgba(${accent}, 0.28), rgba(${accent}, 0.12))`
		itemEl.style.transform = 'translateX(1px)'
	})
	itemEl.addEventListener('mouseleave', () => {
		itemEl.style.background = `linear-gradient(135deg, rgba(${accent}, 0.18), rgba(${accent}, 0.06))`
		itemEl.style.transform = ''
	})

	const launch = (): void => {
		// Build a per-launch preset that carries the popover's startPage / startRow
		// and (if applicable) overrides beforeConfirm with the countdown input.
		// We clone instead of mutating so the original preset is untouched.
		const startPage = pageCtrl.getValue()
		const startRow = rowCtrl.getValue()
		setStoredPositiveInt(START_PAGE_STORAGE_PREFIX + item.name, startPage)
		setStoredPositiveInt(START_ROW_STORAGE_PREFIX + item.name, startRow)
		let launchPreset: ScriptedFlowConfig = {
			...item.preset,
			startPage,
			startRow,
		}
		if (countdownInput) {
			const sec = Math.max(0, parseInt(countdownInput.value, 10) || 0)
			setStoredCountdownSec(item, sec)
			launchPreset = {
				...launchPreset,
				delays: {
					...(launchPreset.delays ?? {}),
					beforeConfirm: sec * 1000,
				},
			}
		}
		pop.remove()
		button.textContent = '⏹'
		button.title = '停止脚本流程'
		runScriptedFlow(launchPreset)
			.catch((err) => console.error('[scripted-flow] failed:', err))
			.finally(refresh)
	}

	itemEl.addEventListener('click', launch)
	itemEl.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			launch()
		}
	})

	return itemEl
}

// ---------------------------------------------------------------------------
// Window globals — declared once so both entry files (scripted.ts, demo.ts)
// can assign without TS "unknown property" errors.
// ---------------------------------------------------------------------------

declare global {
	interface Window {
		runScriptedFlow: typeof runScriptedFlow
		stopScriptedFlow: typeof stopScriptedFlow
		isScriptedFlowRunning: typeof isScriptedFlowRunning
		scriptedFlowPresets: { pddPromotion: ScriptedFlowConfig }
	}
}
