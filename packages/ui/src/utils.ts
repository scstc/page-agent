import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function truncate(text: string, maxLength: number): string {
	if (text.length > maxLength) {
		return text.substring(0, maxLength) + '...'
	}
	return text
}

/**
 * Escape HTML special characters to prevent XSS and rendering issues
 */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;')
}

/**
 * Render Markdown to sanitized HTML.
 *
 * The agent's `done` text and other tool outputs are written into the panel
 * via innerHTML, which means a malicious page or prompt-injection-laden LLM
 * output could otherwise inject script/iframe/onerror sinks. We always
 * sanitize after marked so the trusted DOM only contains a known-safe
 * subset of tags and attributes.
 */
export function renderMarkdown(text: string): string {
	const html = marked.parse(text, { async: false, breaks: true, gfm: true }) as string
	return DOMPurify.sanitize(html)
}
