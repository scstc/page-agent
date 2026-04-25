import { I18n, type SupportedLanguage } from '../i18n'
import { escapeHtml, truncate } from '../utils'
import { createCard, createReflectionLines } from './cards'
import type { AgentActivity, PanelAgentAdapter } from './types'

import styles from './Panel.module.css'

/**
 * Panel configuration
 */
export interface PanelConfig {
	language?: SupportedLanguage
	/**
	 * Whether to prompt for next task after task completion
	 * @default true
	 */
	promptForNextTask?: boolean
}

/** localStorage key for persisting LLM settings entered via the settings dialog. */
const SETTINGS_STORAGE_KEY = 'page-agent:llm-settings'
/** localStorage key for persisting user-defined quick tasks. */
const QUICK_TASKS_STORAGE_KEY = 'page-agent:quick-tasks'
/** Maximum number of quick tasks the user can save. */
const QUICK_TASKS_MAX = 5
/** Max length of a quick task's short label. */
const QUICK_TASK_NAME_MAX_LENGTH = 10
/** Max length of a quick task's full content (what actually runs). */
const QUICK_TASK_CONTENT_MAX_LENGTH = 1000
/** Auto-grow ceiling for the panel task textarea (px). */
const MAX_TASK_INPUT_HEIGHT = 120
/** Auto-grow ceiling for the quick-task content textarea inside settings (px). */
const MAX_QUICK_TASK_INPUT_HEIGHT = 160

type SettingsTab = 'llm' | 'quick'

/**
 * A user-defined reusable task.
 * - `name` is the short label shown in the header dropdown (capped at QUICK_TASK_NAME_MAX_LENGTH).
 * - `content` is the actual prompt sent to the agent when the task is clicked.
 */
interface QuickTask {
	name: string
	content: string
}

/** Re-size a textarea to fit its content, capped at maxHeight. */
function autoResizeTextarea(el: HTMLTextAreaElement, maxHeight: number): void {
	el.style.height = 'auto'
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
}

interface PersistedLLMSettings {
	model?: string
	baseURL?: string
	apiKey?: string
}

function loadPersistedSettings(): PersistedLLMSettings | null {
	try {
		const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
		if (!raw) return null
		const parsed = JSON.parse(raw)
		return typeof parsed === 'object' && parsed ? parsed : null
	} catch {
		return null
	}
}

function savePersistedSettings(settings: PersistedLLMSettings): void {
	try {
		localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
	} catch {
		/* quota exceeded / privacy mode — surface nothing, settings just won't persist */
	}
}

/**
 * Load saved quick tasks. Migrates any legacy `string[]` payloads from the
 * earlier prototype: each plain string becomes `{ name, content }` with the
 * first 10 chars used as the name.
 */
function loadQuickTasks(): QuickTask[] {
	try {
		const raw = localStorage.getItem(QUICK_TASKS_STORAGE_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		const tasks: QuickTask[] = []
		for (const item of parsed) {
			if (tasks.length >= QUICK_TASKS_MAX) break
			if (typeof item === 'string') {
				const text = item.trim()
				if (!text) continue
				tasks.push({ name: text.slice(0, QUICK_TASK_NAME_MAX_LENGTH), content: text })
			} else if (item && typeof item === 'object') {
				const name =
					typeof (item as QuickTask).name === 'string' ? (item as QuickTask).name.trim() : ''
				const content =
					typeof (item as QuickTask).content === 'string' ? (item as QuickTask).content.trim() : ''
				if (!name || !content) continue
				tasks.push({ name: name.slice(0, QUICK_TASK_NAME_MAX_LENGTH), content })
			}
		}
		return tasks
	} catch {
		return []
	}
}

function saveQuickTasks(tasks: QuickTask[]): void {
	try {
		localStorage.setItem(QUICK_TASKS_STORAGE_KEY, JSON.stringify(tasks))
	} catch {
		/* quota exceeded / privacy mode — silently drop, tasks just won't persist */
	}
}

/**
 * Agent control panel
 *
 * Architecture:
 * - History list: renders directly from agent.history (historical events)
 * - Header bar: shows activity events (transient state) and agent status
 *
 * This separation ensures data consistency - history is the single source of truth
 * for what has been done, while activity shows what is happening now.
 */
export class Panel {
	#wrapper: HTMLElement
	#indicator: HTMLElement
	#statusText: HTMLElement
	#historySection: HTMLElement
	#expandButton: HTMLElement
	#actionButton: HTMLElement
	#inputSection: HTMLElement
	#taskInput: HTMLTextAreaElement
	#sendButton: HTMLButtonElement | null = null
	#settingsButton: HTMLElement | null = null
	#settingsOverlay: HTMLElement | null = null
	#quickTasksButton: HTMLElement | null = null
	#quickTasksPopover: HTMLElement | null = null
	/** Working copy mutated inside the dialog; persisted on Save, reloaded on each Open. */
	#quickTasks: QuickTask[] = []

	#agent: PanelAgentAdapter
	#config: PanelConfig
	#isExpanded = false
	#i18n: I18n
	#userAnswerResolver: ((input: string) => void) | null = null
	#isWaitingForUserAnswer: boolean = false
	#headerUpdateTimer: ReturnType<typeof setInterval> | null = null
	#pendingHeaderText: string | null = null
	#isAnimating = false

	// Event handlers (bound for removal)
	#onStatusChange = () => this.#handleStatusChange()
	#onHistoryChange = () => this.#handleHistoryChange()
	#onActivity = (e: Event) => this.#handleActivity((e as CustomEvent<AgentActivity>).detail)
	#onAgentDispose = () => this.dispose()
	#onDocumentClick = (e: MouseEvent) => this.#handleDocumentClick(e)

	get wrapper(): HTMLElement {
		return this.#wrapper
	}

	/**
	 * Create a Panel bound to an agent
	 * @param agent - Agent instance that implements PanelAgentAdapter
	 * @param config - Optional panel configuration
	 */
	constructor(agent: PanelAgentAdapter, config: PanelConfig = {}) {
		this.#agent = agent
		this.#config = config
		this.#i18n = new I18n(config.language ?? 'en-US')

		// Set up askUser callback on agent
		this.#agent.onAskUser = (question) => this.#askUser(question)

		// Create UI elements
		this.#wrapper = this.#createWrapper()
		this.#indicator = this.#wrapper.querySelector(`.${styles.indicator}`)!
		this.#statusText = this.#wrapper.querySelector(`.${styles.statusText}`)!
		this.#historySection = this.#wrapper.querySelector(`.${styles.historySection}`)!
		this.#expandButton = this.#wrapper.querySelector(`.${styles.expandButton}`)!
		this.#actionButton = this.#wrapper.querySelector(`.${styles.stopButton}`)!
		this.#inputSection = this.#wrapper.querySelector(`.${styles.inputSectionWrapper}`)!
		this.#taskInput = this.#wrapper.querySelector(`.${styles.taskInput}`)!
		this.#sendButton = this.#wrapper.querySelector(`.${styles.sendButton}`)
		this.#settingsButton = this.#wrapper.querySelector(`.${styles.settingsButton}`)
		this.#quickTasksButton = this.#wrapper.querySelector(`.${styles.quickTasksButton}`)

		// Quick tasks are user preferences that persist across reloads. Load now
		// so the header button shows immediately if the user has saved tasks.
		this.#quickTasks = loadQuickTasks()
		this.#updateQuickTasksButtonVisibility()

		// Restore any persisted settings before the first task so the agent
		// uses the user's last-saved values without a manual round-trip.
		if (this.#agent.updateLLMConfig) {
			const persisted = loadPersistedSettings()
			if (persisted) this.#agent.updateLLMConfig(persisted)
		}

		// Listen to agent events
		this.#agent.addEventListener('statuschange', this.#onStatusChange)
		this.#agent.addEventListener('historychange', this.#onHistoryChange)
		this.#agent.addEventListener('activity', this.#onActivity)
		this.#agent.addEventListener('dispose', this.#onAgentDispose)

		this.#setupEventListeners()
		this.#startHeaderUpdateLoop()

		this.#showInputArea()

		this.hide() // Start hidden
	}

	// ========== Agent event handlers ==========

	/** Handle agent status change */
	#handleStatusChange(): void {
		const status = this.#agent.status

		// Map agent status to UI indicator type
		const indicatorType =
			status === 'running' ? 'thinking' : status === 'idle' ? 'thinking' : status
		this.#updateStatusIndicator(indicatorType)

		// Morph action button: running = stop (■), not running = close (X)
		if (status === 'running') {
			this.#actionButton.textContent = '■'
			this.#actionButton.title = this.#i18n.t('ui.panel.stop')
		} else {
			this.#actionButton.textContent = 'X'
			this.#actionButton.title = this.#i18n.t('ui.panel.close')
		}

		// Show/hide based on status
		if (status === 'running') {
			this.show()
			this.#hideInputArea() // Hide input while running
		}

		// Handle completion
		if (status === 'completed' || status === 'error') {
			if (!this.#isExpanded) {
				this.#expand()
			}
			if (this.#shouldShowInputArea()) {
				this.#showInputArea()
			}
		}
	}

	/** Handle agent history change - re-render history list from agent.history */
	#handleHistoryChange(): void {
		this.#renderHistory()
	}

	/**
	 * Handle agent activity - transient state for immediate UI feedback
	 * Activity events are NOT persisted in history, only used for header bar updates
	 */
	#handleActivity(activity: AgentActivity): void {
		switch (activity.type) {
			case 'thinking':
				this.#pendingHeaderText = this.#i18n.t('ui.panel.thinking')
				this.#updateStatusIndicator('thinking')
				break

			case 'executing':
				this.#pendingHeaderText = this.#getToolExecutingText(activity.tool, activity.input)
				this.#updateStatusIndicator('executing')
				break

			case 'executed':
				this.#pendingHeaderText = truncate(activity.output, 50)
				break

			case 'retrying':
				this.#pendingHeaderText = `Retrying (${activity.attempt}/${activity.maxAttempts})`
				this.#updateStatusIndicator('retrying')
				break

			case 'error':
				this.#pendingHeaderText = truncate(activity.message, 50)
				this.#updateStatusIndicator('error')
				break
		}
	}

	/**
	 * Ask for user input (internal, called by agent via onAskUser)
	 */
	#askUser(question: string): Promise<string> {
		return new Promise((resolve) => {
			// Set `waiting for user answer` state
			this.#isWaitingForUserAnswer = true
			this.#userAnswerResolver = resolve

			// Expand history panel
			if (!this.#isExpanded) {
				this.#expand()
			}

			// Add temporary question card so user can see the full question
			const tempCard = document.createElement('div')
			tempCard.innerHTML = createCard({
				icon: '❓',
				content: `Question: ${question}`,
				type: 'question',
			})
			const cardElement = tempCard.firstElementChild as HTMLElement
			cardElement.setAttribute('data-temp-card', 'true')
			this.#historySection.appendChild(cardElement)
			this.#scrollToBottom()

			this.#showInputArea(this.#i18n.t('ui.panel.userAnswerPrompt'))
		})
	}

	// ========== Public control methods ==========

	show(): void {
		this.wrapper.style.display = 'block'
		void this.wrapper.offsetHeight
		this.wrapper.style.opacity = '1'
		this.wrapper.style.transform = 'translateX(-50%) translateY(0)'
	}

	hide(): void {
		this.wrapper.style.opacity = '0'
		this.wrapper.style.transform = 'translateX(-50%) translateY(20px)'
		this.wrapper.style.display = 'none'
	}

	reset(): void {
		this.#statusText.textContent = this.#i18n.t('ui.panel.ready')
		this.#updateStatusIndicator('thinking')
		this.#renderHistory()
		this.#collapse()
		// Reset user input state
		this.#isWaitingForUserAnswer = false
		this.#userAnswerResolver = null
		// Show input area
		this.#showInputArea()
	}

	expand(): void {
		this.#expand()
	}

	collapse(): void {
		this.#collapse()
	}

	/**
	 * Dispose panel and clean up event listeners
	 */
	dispose(): void {
		// Remove agent event listeners
		this.#agent.removeEventListener('statuschange', this.#onStatusChange)
		this.#agent.removeEventListener('historychange', this.#onHistoryChange)
		this.#agent.removeEventListener('activity', this.#onActivity)
		this.#agent.removeEventListener('dispose', this.#onAgentDispose)

		// Document-level outside-click listener for the quick-tasks popover
		document.removeEventListener('click', this.#onDocumentClick, true)

		// Clean up UI
		this.#isWaitingForUserAnswer = false
		this.#stopHeaderUpdateLoop()
		this.wrapper.remove()
		this.#settingsOverlay?.remove()
		this.#quickTasksPopover?.remove()
	}

	// ========== Private methods ==========

	#getToolExecutingText(toolName: string, args: unknown): string {
		const a = args as Record<string, string | number>
		switch (toolName) {
			case 'click_element_by_index':
				return this.#i18n.t('ui.tools.clicking', { index: a.index })
			case 'input_text':
				return this.#i18n.t('ui.tools.inputting', { index: a.index })
			case 'select_dropdown_option':
				return this.#i18n.t('ui.tools.selecting', { text: a.text })
			case 'scroll':
				return this.#i18n.t('ui.tools.scrolling')
			case 'wait':
				return this.#i18n.t('ui.tools.waiting', { seconds: a.seconds })
			case 'ask_user':
				return this.#i18n.t('ui.tools.askingUser')
			case 'done':
				return this.#i18n.t('ui.tools.done')
			default:
				return this.#i18n.t('ui.tools.executing', { toolName })
		}
	}

	/**
	 * Action button handler: stop when running, close (dispose) when idle
	 */
	#handleActionButton(): void {
		if (this.#agent.status === 'running') {
			this.#agent.stop()
		} else {
			this.#agent.dispose()
		}
	}

	/**
	 * Submit task
	 */
	#submitTask() {
		const input = this.#taskInput.value.trim()
		if (!input) return

		// Hide input area
		this.#hideInputArea()

		if (this.#isWaitingForUserAnswer) {
			// Handle user input mode
			this.#handleUserAnswer(input)
		} else {
			// Execute task via agent
			this.#agent.execute(input)
		}
	}

	/**
	 * Handle user answer
	 */
	#handleUserAnswer(input: string): void {
		// Remove temporary question cards (only direct children for safety)
		Array.from(this.#historySection.children).forEach((child) => {
			if (child.getAttribute('data-temp-card') === 'true') {
				child.remove()
			}
		})

		// Reset state
		this.#isWaitingForUserAnswer = false

		// Call resolver to return user input
		if (this.#userAnswerResolver) {
			this.#userAnswerResolver(input)
			this.#userAnswerResolver = null
		}
	}

	/**
	 * Show input area
	 */
	#showInputArea(placeholder?: string): void {
		// Clear input field and reset auto-grown height back to one row
		this.#taskInput.value = ''
		this.#taskInput.style.height = ''
		this.#taskInput.placeholder = placeholder || this.#i18n.t('ui.panel.taskInput')
		this.#inputSection.classList.remove(styles.hidden)
		this.#updateSendButtonState()
		// Focus on input field
		setTimeout(() => {
			this.#taskInput.focus()
		}, 100)
	}

	#updateSendButtonState(): void {
		if (!this.#sendButton) return
		this.#sendButton.disabled = this.#taskInput.value.trim().length === 0
	}

	/**
	 * Hide input area
	 */
	#hideInputArea(): void {
		this.#inputSection.classList.add(styles.hidden)
	}

	/**
	 * Check if input area should be shown
	 */
	#shouldShowInputArea(): boolean {
		// Always show input area if waiting for user input
		if (this.#isWaitingForUserAnswer) return true

		const history = this.#agent.history
		if (history.length === 0) {
			return true // Initial state
		}

		const status = this.#agent.status
		const isTaskEnded = status === 'completed' || status === 'error'

		// Only show input area after task completion if configured to do so
		if (isTaskEnded) {
			return this.#config.promptForNextTask ?? true
		}

		return false
	}

	#createWrapper(): HTMLElement {
		const taskInputMaxLength = 1000
		const wrapper = document.createElement('div')
		wrapper.id = 'page-agent-runtime_agent-panel'
		wrapper.className = styles.wrapper
		wrapper.setAttribute('data-browser-use-ignore', 'true')
		wrapper.setAttribute('data-page-agent-ignore', 'true')

		const settingsSupported = typeof this.#agent.updateLLMConfig === 'function'
		const settingsButtonHTML = settingsSupported
			? `<button class="${styles.controlButton} ${styles.settingsButton}" title="${this.#i18n.t('ui.panel.settings')}">⚙</button>`
			: ''
		// Quick-tasks shortcut button — sits to the left of the settings cog.
		// Only meaningful when the settings dialog is reachable (otherwise the
		// user has no way to add tasks). Hidden via the `hidden` attribute until
		// at least one task is saved, controlled by #updateQuickTasksButtonVisibility.
		const quickTasksButtonHTML = settingsSupported
			? `<button class="${styles.controlButton} ${styles.quickTasksButton}" title="${this.#i18n.t('ui.panel.quickTasks')}" hidden>⚡</button>`
			: ''

		wrapper.innerHTML = `
			<div class="${styles.background}"></div>
			<div class="${styles.historySectionWrapper}">
				<div class="${styles.historySection}">
					<div class="${styles.historyItem}">
						<div class="${styles.historyContent}">
							<span class="${styles.statusIcon}">🧠</span>
							<span>${this.#i18n.t('ui.panel.waitingPlaceholder')}</span>
						</div>
					</div>
				</div>
			</div>
			<div class="${styles.header}">
				<div class="${styles.statusSection}">
					<div class="${styles.indicator} ${styles.thinking}"></div>
					<div class="${styles.statusText}">${this.#i18n.t('ui.panel.ready')}</div>
				</div>
				<div class="${styles.controls}">
					${quickTasksButtonHTML}
					${settingsButtonHTML}
					<button class="${styles.controlButton} ${styles.expandButton}" title="${this.#i18n.t('ui.panel.expand')}">
						▼
					</button>
					<button class="${styles.controlButton} ${styles.stopButton}" title="${this.#i18n.t('ui.panel.close')}">
						X
					</button>
				</div>
			</div>
			<div class="${styles.inputSectionWrapper} ${styles.hidden}">
				<div class="${styles.inputSection}">
					<textarea
						class="${styles.taskInput}"
						rows="3"
						maxlength="${taskInputMaxLength}"
						name="page-agent-task"
						autocomplete="off"
						autocapitalize="off"
						autocorrect="off"
						spellcheck="false"
						data-form-type="other"
						data-1p-ignore="true"
						data-lpignore="true"
					></textarea>
					<button class="${styles.sendButton}" type="button" title="${this.#i18n.t('ui.panel.send')}" aria-label="${this.#i18n.t('ui.panel.send')}" disabled>
						<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
							<path d="M15.964.686a.5.5 0 0 0-.65-.65L.767 5.855H.766l-.452.18a.5.5 0 0 0-.082.887l.41.26.001.002 4.995 3.178 3.178 4.995.002.002.26.41a.5.5 0 0 0 .886-.083zm-1.833 1.89L6.637 10.07l-.215-.338a.5.5 0 0 0-.154-.154l-.338-.215 7.494-7.494 1.178-.471z"/>
						</svg>
					</button>
				</div>
			</div>
		`

		document.body.appendChild(wrapper)

		if (settingsSupported) {
			this.#settingsOverlay = this.#createSettingsOverlay()
			document.body.appendChild(this.#settingsOverlay)
			this.#quickTasksPopover = this.#createQuickTasksPopover()
			document.body.appendChild(this.#quickTasksPopover)
		}

		return wrapper
	}

	#createSettingsOverlay(): HTMLElement {
		const overlay = document.createElement('div')
		overlay.className = styles.settingsOverlay
		overlay.setAttribute('data-browser-use-ignore', 'true')
		overlay.setAttribute('data-page-agent-ignore', 'true')
		overlay.innerHTML = `
			<div class="${styles.settingsDialog}">
				<div class="${styles.settingsHeader}">
					<h3>${this.#i18n.t('ui.panel.settingsTitle')}</h3>
					<button class="${styles.settingsClose}" type="button" data-action="close">X</button>
				</div>
				<div class="${styles.settingsBody}">
					<nav class="${styles.settingsNav}">
						<button class="${styles.settingsTab} ${styles.active}" type="button" data-tab="llm">${this.#i18n.t('ui.panel.settingsTabLLM')}</button>
						<button class="${styles.settingsTab}" type="button" data-tab="quick">${this.#i18n.t('ui.panel.settingsTabQuickTasks')}</button>
					</nav>
					<div class="${styles.settingsContent}">
						<section class="${styles.settingsPane}" data-pane="llm">
							<label>
								<span class="${styles.labelText}">${this.#i18n.t('ui.panel.settingsModel')}</span>
								<input type="text" data-field="model" name="page-agent-llm-model" autocomplete="off" spellcheck="false" data-form-type="other" data-1p-ignore="true" data-lpignore="true" />
							</label>
							<label>
								<span class="${styles.labelText}">${this.#i18n.t('ui.panel.settingsBaseURL')}</span>
								<input type="text" data-field="baseURL" name="page-agent-llm-baseurl" autocomplete="off" spellcheck="false" data-form-type="other" data-1p-ignore="true" data-lpignore="true" />
							</label>
							<label>
								<span class="${styles.labelText}">${this.#i18n.t('ui.panel.settingsApiKey')}</span>
								<input type="password" data-field="apiKey" name="page-agent-llm-apikey" autocomplete="new-password" spellcheck="false" data-form-type="other" data-1p-ignore="true" data-lpignore="true" />
							</label>
							<p class="${styles.settingsHint}">${this.#i18n.t('ui.panel.settingsHint')}</p>
							<p class="${styles.settingsError}" data-role="error" hidden></p>
							<input type="file" accept="application/json,.json" data-role="import-file" hidden />
							<div class="${styles.paneActions}">
								<button class="${styles.importButton}" type="button" data-action="import">${this.#i18n.t('ui.panel.settingsImport')}</button>
							</div>
						</section>
						<section class="${styles.settingsPane}" data-pane="quick" hidden>
							<p class="${styles.settingsHint}">${this.#i18n.t('ui.panel.quickTasksHint', { max: QUICK_TASKS_MAX })}</p>
							<ul class="${styles.quickTasksList}" data-role="quick-tasks-list"></ul>
							<div class="${styles.quickTasksAdd}">
								<input type="text" data-role="quick-task-name-input" maxlength="${QUICK_TASK_NAME_MAX_LENGTH}" placeholder="${this.#i18n.t('ui.panel.quickTasksNamePlaceholder', { max: QUICK_TASK_NAME_MAX_LENGTH })}" autocomplete="off" spellcheck="false" data-form-type="other" data-1p-ignore="true" data-lpignore="true" />
								<textarea data-role="quick-task-content-input" rows="3" maxlength="${QUICK_TASK_CONTENT_MAX_LENGTH}" placeholder="${this.#i18n.t('ui.panel.quickTasksContentPlaceholder')}" autocomplete="off" spellcheck="false" data-form-type="other" data-1p-ignore="true" data-lpignore="true"></textarea>
								<button class="${styles.addButton}" type="button" data-action="add-quick-task">${this.#i18n.t('ui.panel.quickTasksAdd')}</button>
							</div>
						</section>
					</div>
				</div>
				<div class="${styles.settingsActions}">
					<span class="${styles.actionsSpacer}"></span>
					<button class="${styles.cancelButton}" type="button" data-action="cancel">${this.#i18n.t('ui.panel.settingsCancel')}</button>
					<button class="${styles.saveButton}" type="button" data-action="save">${this.#i18n.t('ui.panel.settingsSave')}</button>
				</div>
			</div>
		`
		return overlay
	}

	#createQuickTasksPopover(): HTMLElement {
		const pop = document.createElement('div')
		pop.className = styles.quickTasksPopover
		pop.setAttribute('data-browser-use-ignore', 'true')
		pop.setAttribute('data-page-agent-ignore', 'true')
		return pop
	}

	#switchSettingsTab(tab: SettingsTab): void {
		const overlay = this.#settingsOverlay
		if (!overlay) return
		overlay.querySelectorAll<HTMLElement>(`.${styles.settingsTab}`).forEach((el) => {
			el.classList.toggle(styles.active, el.dataset.tab === tab)
		})
		overlay.querySelectorAll<HTMLElement>(`.${styles.settingsPane}`).forEach((el) => {
			el.hidden = el.dataset.pane !== tab
		})
		// Focus the most relevant input for the active tab.
		if (tab === 'llm') {
			overlay.querySelector<HTMLInputElement>('input[data-field="model"]')?.focus()
		} else {
			overlay.querySelector<HTMLInputElement>('input[data-role="quick-task-input"]')?.focus()
		}
	}

	#renderQuickTasksDialogList(): void {
		const overlay = this.#settingsOverlay
		if (!overlay) return
		const list = overlay.querySelector<HTMLElement>('[data-role="quick-tasks-list"]')
		const nameEl = overlay.querySelector<HTMLInputElement>('[data-role="quick-task-name-input"]')
		const contentEl = overlay.querySelector<HTMLTextAreaElement>(
			'[data-role="quick-task-content-input"]'
		)
		const addBtn = overlay.querySelector<HTMLButtonElement>('[data-action="add-quick-task"]')
		if (!list) return

		if (this.#quickTasks.length === 0) {
			list.innerHTML = `<li class="${styles.quickTasksEmpty}">${this.#i18n.t('ui.panel.quickTasksEmpty')}</li>`
		} else {
			list.innerHTML = this.#quickTasks
				.map(
					(task, i) => `
						<li class="${styles.quickTasksItem}">
							<div class="${styles.quickTaskBody}">
								<div class="${styles.quickTaskName}">${escapeHtml(task.name)}</div>
								<div class="${styles.quickTaskContent}" title="${escapeHtml(task.content)}">${escapeHtml(task.content)}</div>
							</div>
							<button class="${styles.quickTaskRemove}" type="button" data-action="remove-quick-task" data-index="${i}" title="${this.#i18n.t('ui.panel.quickTasksRemove')}">X</button>
						</li>
					`
				)
				.join('')
		}

		const atMax = this.#quickTasks.length >= QUICK_TASKS_MAX
		if (nameEl) {
			nameEl.disabled = atMax
			nameEl.placeholder = atMax
				? this.#i18n.t('ui.panel.quickTasksLimit', { max: QUICK_TASKS_MAX })
				: this.#i18n.t('ui.panel.quickTasksNamePlaceholder', { max: QUICK_TASK_NAME_MAX_LENGTH })
		}
		if (contentEl) {
			contentEl.disabled = atMax
			contentEl.placeholder = atMax
				? this.#i18n.t('ui.panel.quickTasksLimit', { max: QUICK_TASKS_MAX })
				: this.#i18n.t('ui.panel.quickTasksContentPlaceholder')
		}
		if (addBtn) addBtn.disabled = atMax
	}

	#addQuickTask(): void {
		const overlay = this.#settingsOverlay
		if (!overlay) return
		if (this.#quickTasks.length >= QUICK_TASKS_MAX) return
		const nameEl = overlay.querySelector<HTMLInputElement>('[data-role="quick-task-name-input"]')
		const contentEl = overlay.querySelector<HTMLTextAreaElement>(
			'[data-role="quick-task-content-input"]'
		)
		if (!nameEl || !contentEl) return
		const name = nameEl.value.trim().slice(0, QUICK_TASK_NAME_MAX_LENGTH)
		const content = contentEl.value.trim()
		// Both fields are required — silently no-op if either is missing so
		// the user just keeps typing rather than getting a popup.
		if (!name || !content) return
		this.#quickTasks.push({ name, content })
		nameEl.value = ''
		contentEl.value = ''
		contentEl.style.height = ''
		this.#renderQuickTasksDialogList()
		nameEl.focus()
	}

	#removeQuickTask(index: number): void {
		if (index < 0 || index >= this.#quickTasks.length) return
		this.#quickTasks.splice(index, 1)
		this.#renderQuickTasksDialogList()
	}

	#triggerImportFilePicker(): void {
		const fileInput = this.#settingsOverlay?.querySelector<HTMLInputElement>(
			'input[data-role="import-file"]'
		)
		if (!fileInput) return
		// Reset value so picking the same file twice still fires `change`.
		fileInput.value = ''
		fileInput.click()
	}

	async #handleImportFile(file: File): Promise<void> {
		const errorEl = this.#settingsOverlay?.querySelector<HTMLElement>('[data-role="error"]')
		const showError = (msg: string) => {
			if (!errorEl) return
			errorEl.textContent = msg
			errorEl.hidden = false
		}
		const clearError = () => {
			if (!errorEl) return
			errorEl.textContent = ''
			errorEl.hidden = true
		}

		try {
			const text = await file.text()
			const parsed = JSON.parse(text) as Record<string, unknown>
			if (!parsed || typeof parsed !== 'object') {
				showError(this.#i18n.t('ui.panel.settingsImportError'))
				return
			}
			const overlay = this.#settingsOverlay
			if (!overlay) return

			const setField = (field: 'model' | 'baseURL' | 'apiKey', value: unknown) => {
				if (typeof value !== 'string') return
				const input = overlay.querySelector<HTMLInputElement>(`input[data-field="${field}"]`)
				if (input) input.value = value
			}
			setField('model', parsed.model)
			setField('baseURL', parsed.baseURL)
			setField('apiKey', parsed.apiKey)
			clearError()
		} catch {
			showError(this.#i18n.t('ui.panel.settingsImportError'))
		}
	}

	#openSettings(): void {
		if (!this.#settingsOverlay) return
		const overlay = this.#settingsOverlay

		// LLM tab — populate from current agent config.
		if (this.#agent.getLLMConfig) {
			const current = this.#agent.getLLMConfig()
			const set = (field: string, value: string) => {
				const input = overlay.querySelector<HTMLInputElement>(`input[data-field="${field}"]`)
				if (input) input.value = value
			}
			set('model', current.model ?? '')
			set('baseURL', current.baseURL ?? '')
			set('apiKey', current.apiKey ?? '')
		}

		// Quick tasks tab — re-read storage so Cancel cleanly discards in-dialog edits.
		this.#quickTasks = loadQuickTasks()
		const nameEl = overlay.querySelector<HTMLInputElement>('[data-role="quick-task-name-input"]')
		const contentEl = overlay.querySelector<HTMLTextAreaElement>(
			'[data-role="quick-task-content-input"]'
		)
		if (nameEl) nameEl.value = ''
		if (contentEl) {
			contentEl.value = ''
			contentEl.style.height = ''
		}
		this.#renderQuickTasksDialogList()

		// Clear any lingering import-error from a previous session
		const errorEl = overlay.querySelector<HTMLElement>('[data-role="error"]')
		if (errorEl) {
			errorEl.textContent = ''
			errorEl.hidden = true
		}
		this.#switchSettingsTab('llm')
		overlay.classList.add(styles.visible)
	}

	#closeSettings(): void {
		this.#settingsOverlay?.classList.remove(styles.visible)
	}

	#saveSettings(): void {
		if (!this.#settingsOverlay) return
		const overlay = this.#settingsOverlay

		if (this.#agent.updateLLMConfig) {
			const get = (field: string) =>
				overlay.querySelector<HTMLInputElement>(`input[data-field="${field}"]`)?.value.trim() ?? ''
			const updates = {
				model: get('model'),
				baseURL: get('baseURL'),
				apiKey: get('apiKey'),
			}
			this.#agent.updateLLMConfig(updates)
			savePersistedSettings(updates)
		}

		saveQuickTasks(this.#quickTasks)
		this.#updateQuickTasksButtonVisibility()
		this.#closeSettings()
	}

	#updateQuickTasksButtonVisibility(): void {
		const btn = this.#quickTasksButton
		if (!btn) return
		btn.hidden = this.#quickTasks.length === 0
		if (btn.hidden) this.#closeQuickTasksPopover()
	}

	#renderQuickTasksPopover(): void {
		const pop = this.#quickTasksPopover
		if (!pop) return
		if (this.#quickTasks.length === 0) {
			pop.innerHTML = `<div class="${styles.quickTasksPopoverEmpty}">${this.#i18n.t('ui.panel.quickTasksEmpty')}</div>`
			return
		}
		pop.innerHTML = this.#quickTasks
			.map(
				(task, i) => `
					<button type="button" class="${styles.quickTasksPopoverItem}" data-index="${i}" title="${escapeHtml(task.content)}">
						<span class="${styles.popoverItemBody}">
							<span class="${styles.popoverItemName}">${escapeHtml(task.name)}</span>
							<span class="${styles.popoverItemContent}">${escapeHtml(task.content)}</span>
						</span>
					</button>
				`
			)
			.join('')
	}

	#openQuickTasksPopover(): void {
		const btn = this.#quickTasksButton
		const pop = this.#quickTasksPopover
		const wrapper = this.#wrapper
		if (!btn || !pop) return
		this.#renderQuickTasksPopover()
		// Match the panel's footprint: a tray that's slightly inset from the
		// panel's outer edges, horizontally centered with it. The button
		// just decides vertical orientation (panel is bottom-fixed, so we
		// usually open upward).
		const panelRect = wrapper.getBoundingClientRect()
		const btnRect = btn.getBoundingClientRect()
		const popWidth = Math.max(260, Math.min(480, panelRect.width - 40))
		const centerLeft = panelRect.left + (panelRect.width - popWidth) / 2
		const left = Math.max(8, Math.min(window.innerWidth - popWidth - 8, centerLeft))
		pop.style.width = `${popWidth}px`
		pop.style.left = `${left}px`
		pop.style.top = '0px'
		pop.classList.add(styles.visible)
		const openUp = btnRect.bottom > window.innerHeight / 2
		if (openUp) {
			const popHeight = pop.offsetHeight
			pop.style.top = `${Math.max(8, btnRect.top - popHeight - 8)}px`
		} else {
			pop.style.top = `${btnRect.bottom + 8}px`
		}
	}

	#closeQuickTasksPopover(): void {
		this.#quickTasksPopover?.classList.remove(styles.visible)
	}

	#toggleQuickTasksPopover(): void {
		const pop = this.#quickTasksPopover
		if (!pop) return
		if (pop.classList.contains(styles.visible)) this.#closeQuickTasksPopover()
		else this.#openQuickTasksPopover()
	}

	#runQuickTask(index: number): void {
		const task = this.#quickTasks[index]
		if (!task) return
		this.#closeQuickTasksPopover()
		// Don't hijack a running task or an in-flight ask_user prompt — those
		// inputs mean different things to the agent.
		if (this.#agent.status === 'running' || this.#isWaitingForUserAnswer) return
		// Send the *content*, not the name. The name is just a label.
		this.#taskInput.value = task.content
		autoResizeTextarea(this.#taskInput, MAX_TASK_INPUT_HEIGHT)
		this.#updateSendButtonState()
		this.#submitTask()
	}

	#handleDocumentClick(e: MouseEvent): void {
		const pop = this.#quickTasksPopover
		if (!pop || !pop.classList.contains(styles.visible)) return
		const target = e.target as HTMLElement | null
		if (!target) return
		if (pop.contains(target)) return
		if (this.#quickTasksButton && this.#quickTasksButton.contains(target)) return
		this.#closeQuickTasksPopover()
	}

	#setupEventListeners(): void {
		// Click header area to expand/collapse
		const header = this.wrapper.querySelector(`.${styles.header}`)!
		header.addEventListener('click', (e) => {
			// Don't trigger expand/collapse if clicking on buttons
			if ((e.target as HTMLElement).closest(`.${styles.controlButton}`)) {
				return
			}
			this.#toggle()
		})

		// Expand button
		this.#expandButton.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#toggle()
		})

		// Action button (stop / close)
		this.#actionButton.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#handleActionButton()
		})

		// Settings button (only present when agent supports updateLLMConfig)
		this.#settingsButton?.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#openSettings()
		})

		// Quick-tasks button — toggles the popover dropdown
		this.#quickTasksButton?.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#toggleQuickTasksPopover()
		})

		// Quick-tasks popover — clicking an item runs that task
		this.#quickTasksPopover?.addEventListener('click', (e) => {
			const target = e.target as HTMLElement
			const item = target.closest<HTMLElement>(`.${styles.quickTasksPopoverItem}`)
			if (!item) return
			const idx = Number.parseInt(item.dataset.index ?? '-1', 10)
			this.#runQuickTask(idx)
		})

		// Outside-click closes the popover. Capture phase so we see the click
		// before any element's `stopPropagation` (the panel header uses one).
		document.addEventListener('click', this.#onDocumentClick, true)

		// Settings overlay — clicks on backdrop close, tab switches and
		// action buttons handled via data-tab / data-action.
		this.#settingsOverlay?.addEventListener('click', (e) => {
			const target = e.target as HTMLElement
			if (target === this.#settingsOverlay) {
				this.#closeSettings()
				return
			}
			const tab = target.closest<HTMLElement>(`.${styles.settingsTab}`)?.dataset.tab
			if (tab === 'llm' || tab === 'quick') {
				this.#switchSettingsTab(tab)
				return
			}
			const actionEl = target.closest<HTMLElement>('[data-action]')
			const action = actionEl?.dataset.action
			if (action === 'close' || action === 'cancel') this.#closeSettings()
			else if (action === 'save') this.#saveSettings()
			else if (action === 'import') this.#triggerImportFilePicker()
			else if (action === 'add-quick-task') this.#addQuickTask()
			else if (action === 'remove-quick-task') {
				const idx = Number.parseInt(actionEl?.dataset.index ?? '-1', 10)
				this.#removeQuickTask(idx)
			}
		})

		// Hidden file input for JSON import — populates form fields, doesn't auto-save
		this.#settingsOverlay
			?.querySelector<HTMLInputElement>('input[data-role="import-file"]')
			?.addEventListener('change', (e) => {
				const file = (e.target as HTMLInputElement).files?.[0]
				if (file) void this.#handleImportFile(file)
			})

		// Quick-task add form keyboard plumbing:
		// - Enter on the name input moves focus to the content textarea (avoids
		//   submitting half-filled tasks)
		// - Enter on the content textarea adds the task; Shift+Enter inserts a newline
		const quickTaskNameEl = this.#settingsOverlay?.querySelector<HTMLInputElement>(
			'[data-role="quick-task-name-input"]'
		)
		const quickTaskContentEl = this.#settingsOverlay?.querySelector<HTMLTextAreaElement>(
			'[data-role="quick-task-content-input"]'
		)
		quickTaskNameEl?.addEventListener('keydown', (e) => {
			if (e.isComposing) return
			if (e.key === 'Enter') {
				e.preventDefault()
				quickTaskContentEl?.focus()
			}
		})
		quickTaskContentEl?.addEventListener('keydown', (e) => {
			if (e.isComposing) return
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault()
				this.#addQuickTask()
			}
		})
		quickTaskContentEl?.addEventListener('input', () => {
			if (quickTaskContentEl) autoResizeTextarea(quickTaskContentEl, MAX_QUICK_TASK_INPUT_HEIGHT)
		})

		// Submit on Enter; Shift+Enter inserts a newline (textarea behaviour).
		this.#taskInput.addEventListener('keydown', (e) => {
			if (e.isComposing) return // Ignore IME composition keys
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault()
				this.#submitTask()
			}
		})

		// Auto-grow the task textarea up to MAX_TASK_INPUT_HEIGHT, then scroll;
		// keep the send button's disabled state in sync with input emptiness.
		this.#taskInput.addEventListener('input', () => {
			autoResizeTextarea(this.#taskInput, MAX_TASK_INPUT_HEIGHT)
			this.#updateSendButtonState()
		})

		this.#sendButton?.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#submitTask()
		})

		// Prevent input area click event bubbling
		this.#inputSection.addEventListener('click', (e) => {
			e.stopPropagation()
		})
	}

	#toggle(): void {
		if (this.#isExpanded) {
			this.#collapse()
		} else {
			this.#expand()
		}
	}

	#expand(): void {
		this.#isExpanded = true
		this.wrapper.classList.add(styles.expanded)
		this.#expandButton.textContent = '▲'
	}

	#collapse(): void {
		this.#isExpanded = false
		this.wrapper.classList.remove(styles.expanded)
		this.#expandButton.textContent = '▼'
	}

	/**
	 * Start periodic header update loop
	 */
	#startHeaderUpdateLoop(): void {
		// Check every 450ms (same as total animation duration)
		this.#headerUpdateTimer = setInterval(() => {
			this.#checkAndUpdateHeader()
		}, 450)
	}

	/**
	 * Stop periodic header update loop
	 */
	#stopHeaderUpdateLoop(): void {
		if (this.#headerUpdateTimer) {
			clearInterval(this.#headerUpdateTimer)
			this.#headerUpdateTimer = null
		}
	}

	/**
	 * Check if header needs update and trigger animation if not currently animating
	 */
	#checkAndUpdateHeader(): void {
		// If no pending text or currently animating, skip
		if (!this.#pendingHeaderText || this.#isAnimating) {
			return
		}

		// If text is already displayed, clear pending and skip
		if (this.#statusText.textContent === this.#pendingHeaderText) {
			this.#pendingHeaderText = null
			return
		}

		// Start animation
		const textToShow = this.#pendingHeaderText
		this.#pendingHeaderText = null
		this.#animateTextChange(textToShow)
	}

	/**
	 * Animate text change with fade out/in effect
	 */
	#animateTextChange(newText: string): void {
		this.#isAnimating = true

		// Fade out current text
		this.#statusText.classList.add(styles.fadeOut)

		setTimeout(() => {
			// Update text content
			this.#statusText.textContent = newText

			// Fade in new text
			this.#statusText.classList.remove(styles.fadeOut)
			this.#statusText.classList.add(styles.fadeIn)

			setTimeout(() => {
				this.#statusText.classList.remove(styles.fadeIn)
				this.#isAnimating = false
			}, 300)
		}, 150) // Half the duration of fade out animation
	}

	#updateStatusIndicator(
		type: 'thinking' | 'executing' | 'executed' | 'retrying' | 'completed' | 'error'
	): void {
		// Clear all status classes
		this.#indicator.className = styles.indicator

		// Add corresponding status class
		this.#indicator.classList.add(styles[type])
	}

	#scrollToBottom(): void {
		// Execute in next event loop to ensure DOM update completion
		setTimeout(() => {
			this.#historySection.scrollTop = this.#historySection.scrollHeight
		}, 0)
	}

	/**
	 * Render history directly from agent.history
	 *
	 * Renders:
	 * 1. Task (first item, from agent.task)
	 * 2. Reflection cards (evaluation, memory, next_goal)
	 * 3. Tool execution with output
	 * 4. Observations
	 */
	#renderHistory(): void {
		const items: string[] = []

		// 1. Task card (always first)
		const task = this.#agent.task
		if (task) {
			items.push(this.#createTaskCard(task))
		}

		// 2. Render each history event
		const history = this.#agent.history
		for (const event of history) {
			items.push(...this.#createHistoryCards(event))
		}

		this.#historySection.innerHTML = items.join('')
		this.#scrollToBottom()
	}

	#createTaskCard(task: string): string {
		return createCard({ icon: '🎯', content: task, type: 'input' })
	}

	/** Create cards for a history event */
	#createHistoryCards(event: PanelAgentAdapter['history'][number]): string[] {
		const cards: string[] = []
		const meta =
			event.type === 'step' && event.stepIndex !== undefined
				? this.#i18n.t('ui.panel.step', {
						number: (event.stepIndex + 1).toString(),
					})
				: undefined

		if (event.type === 'step') {
			// Reflection card
			if (event.reflection) {
				const lines = createReflectionLines(event.reflection)
				if (lines.length > 0) {
					cards.push(createCard({ icon: '🧠', content: lines, meta }))
				}
			}

			// Action card
			const action = event.action
			if (action) {
				cards.push(...this.#createActionCards(action, meta))
			}
		} else if (event.type === 'observation') {
			cards.push(
				createCard({ icon: '👁️', content: event.content || '', meta, type: 'observation' })
			)
		} else if (event.type === 'user_takeover') {
			cards.push(createCard({ icon: '👤', content: 'User takeover', meta, type: 'input' }))
		} else if (event.type === 'retry') {
			const retryInfo = `${event.message || 'Retrying'} (${event.attempt}/${event.maxAttempts})`
			cards.push(createCard({ icon: '🔄', content: retryInfo, meta, type: 'observation' }))
		} else if (event.type === 'error') {
			cards.push(
				createCard({ icon: '❌', content: event.message || 'Error', meta, type: 'observation' })
			)
		}

		return cards
	}

	/** Create cards for an action */
	#createActionCards(
		action: { name: string; input: unknown; output: string },
		meta?: string
	): string[] {
		const cards: string[] = []

		if (action.name === 'done') {
			const input = action.input as { text?: string }
			const text = input.text || action.output || ''
			if (text) {
				cards.push(createCard({ icon: '🤖', content: text, meta, type: 'output' }))
			}
		} else if (action.name === 'ask_user') {
			const input = action.input as { question?: string }
			const answer = action.output.replace(/^User answered:\s*/i, '')
			cards.push(
				createCard({
					icon: '❓',
					content: `Question: ${input.question || ''}`,
					meta,
					type: 'question',
				})
			)
			cards.push(createCard({ icon: '💬', content: `Answer: ${answer}`, meta, type: 'input' }))
		} else {
			const toolText = this.#getToolExecutingText(action.name, action.input)
			cards.push(createCard({ icon: '🔨', content: toolText, meta }))
			if (action.output?.length > 0) {
				cards.push(createCard({ icon: '🔨', content: action.output, meta, type: 'output' }))
			}
		}

		return cards
	}
}
