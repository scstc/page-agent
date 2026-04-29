#!/usr/bin/env node
// Generate trusted localhost SSL certs for `npm run dev:demo:https` /
// `npm run dev:scripted`. Idempotent — safe to re-run.
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const certsDir = resolve(__dirname, '..', 'packages', 'page-agent', '.dev-certs')

let version
try {
	version = execSync('mkcert -version', { stdio: ['ignore', 'pipe', 'pipe'] })
		.toString()
		.trim()
} catch {
	console.error('mkcert not found in PATH.')
	console.error('')
	console.error('Install one of:')
	console.error('  macOS    brew install mkcert nss')
	console.error('  Linux    see https://github.com/FiloSottile/mkcert#linux')
	console.error('  Windows  choco install mkcert   (or  scoop install mkcert)')
	console.error('')
	console.error('Then re-run: npm run setup:dev-certs')
	process.exit(1)
}

console.log(`mkcert found: ${version}`)

console.log('→ mkcert -install   (installs/verifies the local root CA)')
execSync('mkcert -install', { stdio: 'inherit' })

mkdirSync(certsDir, { recursive: true })
console.log(`→ generating cert in ${certsDir}`)
execSync('mkcert localhost 127.0.0.1 ::1', { cwd: certsDir, stdio: 'inherit' })

console.log('')
console.log('Done. Files (gitignored):')
console.log(`  ${resolve(certsDir, 'localhost+2.pem')}`)
console.log(`  ${resolve(certsDir, 'localhost+2-key.pem')}`)
console.log('')
console.log('Next:  npm run dev:demo:https')
console.log('Then:  load https://localhost:5174/page-agent.demo.js via your bookmarklet')
