// @ts-check
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// IIFE bundle for the non-AI scripted flow.
// Sibling of vite.iife.config.js but with a separate entry + filename.
// Output: dist/iife/page-agent.scripted.js (loaded via bookmarklet).
export default defineConfig(() => ({
	plugins: [cssInjectedByJsPlugin({ relativeCSSInjection: true })],
	publicDir: false,
	build: {
		emptyOutDir: false, // keep page-agent.demo.js next to us
		lib: {
			entry: resolve(__dirname, 'src/scripted.ts'),
			name: 'PageAgentScripted',
			fileName: () => `page-agent.scripted.js`,
			formats: ['iife'],
		},
		outDir: resolve(__dirname, 'dist', 'iife'),
		cssCodeSplit: true,
		rollupOptions: {
			onwarn: function (message, handler) {
				if (message.code === 'EVAL') return
				handler(message)
			},
		},
	},
}))
