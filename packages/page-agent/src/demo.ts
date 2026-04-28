/**
 * IIFE demo entry - auto-initializes with built-in demo API for testing.
 *
 * Also bundles the scripted-flow API so console users can run e.g.
 *   window.runScriptedFlow(window.scriptedFlowPresets.pddPromotion)
 * and so the panel header shows a 🤖 button (left of the ⚡ quick-tasks button)
 * that triggers the PDD scripted flow with a single click.
 */
import { PageAgent, type PageAgentConfig } from './PageAgent'
import {
	injectScriptedFlowButton,
	isScriptedFlowRunning,
	pddPromotionPreset,
	runScriptedFlow,
	stopScriptedFlow,
} from './scripted-flow'

// Clean up existing instances to prevent multiple injections from bookmarklet
if (window.pageAgent) {
	window.pageAgent.dispose()
}

// Mount to global window object
window.PageAgent = PageAgent
window.runScriptedFlow = runScriptedFlow
window.stopScriptedFlow = stopScriptedFlow
window.isScriptedFlowRunning = isScriptedFlowRunning
window.scriptedFlowPresets = { pddPromotion: pddPromotionPreset }

console.log('🚀 page-agent.js loaded!')

const DEMO_MODEL = 'qwen3.5-plus'
const DEMO_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const DEMO_API_KEY = 'NA'

const currentScript = document.currentScript as HTMLScriptElement | null

// in case document.x is not ready yet
setTimeout(() => {
	let config: PageAgentConfig

	if (currentScript) {
		console.log('🚀 page-agent.js detected current script:', currentScript.src)
		const url = new URL(currentScript.src)
		const model = url.searchParams.get('model') || DEMO_MODEL
		const baseURL = url.searchParams.get('baseURL') || DEMO_BASE_URL
		const apiKey = url.searchParams.get('apiKey') || DEMO_API_KEY
		const language = (url.searchParams.get('lang') as 'zh-CN' | 'en-US') || 'zh-CN'
		config = { model, baseURL, apiKey, language }
	} else {
		console.log('🚀 page-agent.js no current script detected, using default demo config')
		config = {
			model: import.meta.env.LLM_MODEL_NAME ? import.meta.env.LLM_MODEL_NAME : DEMO_MODEL,
			baseURL: import.meta.env.LLM_BASE_URL ? import.meta.env.LLM_BASE_URL : DEMO_BASE_URL,
			apiKey: import.meta.env.LLM_API_KEY ? import.meta.env.LLM_API_KEY : DEMO_API_KEY,
		}
	}

	// Create agent
	window.pageAgent = new PageAgent(config)
	window.pageAgent.panel.show()

	console.log('🚀 page-agent.js initialized with config:', window.pageAgent.config)

	// Inject the 🤖 button to the left of the ⚡ quick-tasks button.
	injectScriptedFlowButton()
})
