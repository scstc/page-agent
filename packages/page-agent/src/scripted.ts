/**
 * Standalone IIFE entry for the scripted flow.
 * Loaded via the bookmarklet at the bottom of this file (HTTPS dev server).
 *
 * Just exposes the core API on `window` and prints a welcome banner. All real
 * logic lives in `scripted-flow.ts`, which is also imported by `demo.ts` so the
 * scripted flow can be triggered from the demo bundle's panel header.
 */
import {
	isScriptedFlowRunning,
	pddPromotionPreset,
	runScriptedFlow,
	stopScriptedFlow,
} from './scripted-flow'

window.runScriptedFlow = runScriptedFlow
window.stopScriptedFlow = stopScriptedFlow
window.isScriptedFlowRunning = isScriptedFlowRunning
window.scriptedFlowPresets = { pddPromotion: pddPromotionPreset }

console.log('🤖 page-agent.scripted.js loaded')
console.log('   Run:  window.runScriptedFlow(window.scriptedFlowPresets.pddPromotion)')
console.log('   Stop: window.stopScriptedFlow()')

/*
Bookmarklet (dev, HTTPS via mkcert + http-server -S on :5174):

javascript:(function(){var s=document.createElement('script');s.src=`https://localhost:5174/page-agent.scripted.js?t=${Math.random()}`;s.onload=()=>console.log('ScriptedFlow ready!');document.head.appendChild(s);})();

Prerequisite: `npm run dev:scripted` serves the bundle over HTTPS using a mkcert-signed cert
in packages/page-agent/.dev-certs/. mkcert -install must have been run once on this machine
so that the cert is trusted by the browser.
*/
