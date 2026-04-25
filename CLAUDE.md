# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The block above imports the canonical project guide. Read it first — what follows only adds context not yet covered there.

## Environment

- Node `^22.13 || >=24` with `npm >= 11`. The repo's dev tooling assumes a Unix-like shell (macOS / Linux / WSL); some scripts (e.g. `npm run cleanup` uses `rm -rf`) won't work in plain Windows `cmd`.
- Husky + lint-staged + commitlint run on commit. Commit messages must follow Conventional Commits (`@commitlint/config-conventional`); CI rejects unlinted code.

## Commands not in AGENTS.md

```bash
npm run dev:demo              # Serve the IIFE build at http://localhost:5174/page-agent.demo.js (rebuild on change)
npm run dev:ext               # Run the browser extension in dev mode
npm run build:website         # Build the website only
npm run cleanup               # Remove all packages/*/dist and packages/*/.output (Unix shell)
npm run ci                    # Run the full CI pipeline locally
node scripts/sync-version.js  # Sync versions across workspaces (also runs as `npm version`)
```

Note: there is **no test runner** wired up at the root — `npm test` is not defined. Manual verification on the demo site (and other sites via the bookmarklet flow below) is the expected QA path.

## Workspaces beyond AGENTS.md

`packages/mcp/` (npm: `@page-agent/mcp`) is an MCP server that controls the browser through the Page Agent extension. AGENTS.md predates it; treat it as a published package alongside `core`, `page-agent`, `llms`, `page-controller`, and `ui`.

## Local LLM testing

Create `.env` at repo root to point the dev demo at your own LLM (restart the dev server after editing):

```env
LLM_MODEL_NAME=...
LLM_API_KEY=...
LLM_BASE_URL=...
```

Without `.env`, the demo falls back to the project's free testing proxy. **Warning:** the API key in `.env` is inlined into the IIFE bundle — do not distribute that build.

## Testing on arbitrary sites

After `npm run dev:demo`, load the agent into any page via this bookmarklet:

```javascript
javascript:(function(){var s=document.createElement('script');s.src=`http://localhost:5174/page-agent.demo.js?t=${Math.random()}`;s.onload=()=>console.log('PageAgent ready!');document.head.appendChild(s);})();
```

## Contribution constraints (from CONTRIBUTING.md)

- **AI-generated code is not accepted in the core lib or the extension.** It is welcome in the demo, the website, the UI, and tests.
- Reviewer is the human committer — anything Claude writes must be reviewed before commit, and the human is the author.
- Breaking changes, large PRs without prior discussion, and heavy dependencies added to core libs will be rejected.

## Website work

Anything under `packages/website/` follows `packages/website/AGENTS.md` (shadcn/ui + Magic UI conventions, wouter routing with `/page-agent` base, SPA-on-GitHub-Pages route registration in `vite.config.js`). Notably: never hand-edit `src/components/ui/`, and add new doc routes to `SPA_ROUTES`.
