// Demo build (auto-init with demo LLM, for quick testing)
export const CDN_DEMO_URL =
	'https://cdn.jsdelivr.net/npm/page-agent@1.8.0/dist/iife/page-agent.demo.js'
export const CDN_DEMO_CN_URL =
	'https://registry.npmmirror.com/page-agent/1.8.0/files/dist/iife/page-agent.demo.js'
// Local IIFE served by `npm run dev:demo` (only meaningful while that is running)
export const LOCAL_DEMO_URL = 'http://localhost:5174/page-agent.demo.js'

// Demo LLM for website testing (homepage quick trial uses flash)
export const DEMO_MODEL = 'qwen3.5-flash'
export const DEMO_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
// export const DEMO_API_KEY = ''
