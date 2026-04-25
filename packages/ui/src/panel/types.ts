/**
 * Agent activity - transient state for immediate UI feedback.
 *
 * Unlike historical events (which are persisted), activities are ephemeral
 * and represent "what the agent is doing right now". UI components should
 * listen to 'activity' events to show real-time feedback.
 *
 * Note: There is no 'idle' activity - absence of activity events means idle.
 *
 * Events dispatched: CustomEvent<AgentActivity>
 */
export type AgentActivity =
	| { type: 'thinking' }
	| { type: 'executing'; tool: string; input: unknown }
	| { type: 'executed'; tool: string; input: unknown; output: string; duration: number }
	| { type: 'retrying'; attempt: number; maxAttempts: number }
	| { type: 'error'; message: string }

/**
 * Minimal interface that Panel expects from an agent.
 * Panel does not depend on PageAgent directly - it only requires this interface.
 * This enables decoupling and allows any agent implementation to work with Panel.
 *
 * Events:
 * - 'statuschange': Agent status changed (idle/running/completed/error)
 * - 'historychange': Historical events updated (persisted)
 * - 'activity': Transient activity for immediate UI feedback (thinking/executing/etc)
 * - 'dispose': Agent is being disposed
 */
export interface PanelAgentAdapter extends EventTarget {
	/** Current agent status */
	readonly status: 'idle' | 'running' | 'completed' | 'error'

	/** History of agent events */
	readonly history: readonly {
		type: 'step' | 'observation' | 'user_takeover' | 'retry' | 'error'
		stepIndex?: number
		/** For 'step' type */
		reflection?: {
			evaluation_previous_goal?: string
			memory?: string
			next_goal?: string
		}
		/** For 'step' type */
		action?: {
			name: string
			input: unknown
			output: string
		}
		/** For 'observation' type */
		content?: string
		/** For 'retry' type */
		attempt?: number
		maxAttempts?: number
		/** For 'retry' and 'error' types */
		message?: string
	}[]

	/** Current task being executed */
	readonly task: string

	/**
	 * Callback for when agent needs user input.
	 * Panel will set this to handle user questions via its UI.
	 */
	onAskUser?: (question: string) => Promise<string>

	/** Execute a task */
	execute(task: string): Promise<unknown>

	/** Stop the current task (agent remains reusable) */
	stop(): void

	/** Dispose the agent (terminal, cannot be reused) */
	dispose(): void

	/**
	 * Read the agent's current LLM connection settings. Used to pre-populate
	 * the in-panel settings form. Optional — when absent the panel hides its
	 * settings button.
	 */
	getLLMConfig?(): { model: string; baseURL: string; apiKey?: string }

	/**
	 * Apply LLM connection settings; takes effect on the next step's request.
	 * Implementations should mutate any internal LLM client config in place
	 * so existing references stay valid.
	 */
	updateLLMConfig?(config: { model?: string; baseURL?: string; apiKey?: string }): void
}
