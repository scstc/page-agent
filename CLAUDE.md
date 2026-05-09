# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The block above imports the canonical project guide. Read it first — what follows only adds context not yet covered there.

## Environment

- Node `^22.13 || >=24` with `npm >= 11`. The repo's dev tooling assumes a Unix-like shell (macOS / Linux / WSL); some scripts (e.g. `npm run cleanup` uses `rm -rf`) won't work in plain Windows `cmd`.
- Husky + lint-staged + commitlint run on commit. Commit messages must follow Conventional Commits (`@commitlint/config-conventional`); CI rejects unlinted code.

## Local dev startup (HTTPS by default)

Both dev servers should run over HTTPS — the bookmarklet flow and any
script-injection from a real `https://` site (e.g. PDD) are blocked by
mixed-content rules otherwise. Start both **in parallel** (separate terminals
or background tasks); they're independent.

```bash
# One-time: generate trusted local certs (uses mkcert; idempotent)
npm run setup:dev-certs

# Terminal 1 — website / docs site
npm start                       # → https://localhost:5173/page-agent/
                                #   (vite auto-detects .dev-certs/ and enables https)

# Terminal 2 — IIFE bundle for the bookmarklet
npm run dev:demo:https          # → https://localhost:5174/page-agent.demo.js
                                #   (vite --watch + http-server -S, mkcert-signed)
```

Certs live in `packages/page-agent/.dev-certs/localhost+2{,-key}.pem`
(gitignored). Both servers reuse the same cert pair. If `npm start` falls
back to plain HTTP, the cert files are missing — re-run `setup:dev-certs`.

When restarting, prefer `run_in_background` for both — startup is several
seconds and you don't want to block.

## Commands not in AGENTS.md

```bash
npm run dev:demo              # Plain HTTP variant of dev:demo:https — only for same-origin testing
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

After `npm run dev:demo:https`, load the agent into any page via this bookmarklet:

```javascript
javascript:(function(){var s=document.createElement('script');s.src=`https://localhost:5174/page-agent.demo.js?t=${Math.random()}`;s.onload=()=>console.log('PageAgent ready!');document.head.appendChild(s);})();
```

Required for `https://` host pages (PDD, Tmall, etc.) — browsers block
`http://` script tags loaded into a secure document.

## Contribution constraints (from CONTRIBUTING.md)

- **AI-generated code is not accepted in the core lib or the extension.** It is welcome in the demo, the website, the UI, and tests.
- Reviewer is the human committer — anything Claude writes must be reviewed before commit, and the human is the author.
- Breaking changes, large PRs without prior discussion, and heavy dependencies added to core libs will be rejected.

## Website work

Anything under `packages/website/` follows `packages/website/AGENTS.md` (shadcn/ui + Magic UI conventions, wouter routing with `/page-agent` base, SPA-on-GitHub-Pages route registration in `vite.config.js`). Notably: never hand-edit `src/components/ui/`, and add new doc routes to `SPA_ROUTES`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **page-agent** (2576 symbols, 4753 relationships, 180 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/page-agent/context` | Codebase overview, check index freshness |
| `gitnexus://repo/page-agent/clusters` | All functional areas |
| `gitnexus://repo/page-agent/processes` | All execution flows |
| `gitnexus://repo/page-agent/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
| Work in the Ui area (102 symbols) | `.claude/skills/generated/ui/SKILL.md` |
| Work in the Agent area (75 symbols) | `.claude/skills/generated/agent/SKILL.md` |
| Work in the Panel area (49 symbols) | `.claude/skills/generated/panel/SKILL.md` |
| Work in the Home area (34 symbols) | `.claude/skills/generated/home/SKILL.md` |
| Work in the Components area (34 symbols) | `.claude/skills/generated/components/SKILL.md` |
| Work in the Dom area (28 symbols) | `.claude/skills/generated/dom/SKILL.md` |
| Work in the Dom_tree area (18 symbols) | `.claude/skills/generated/dom-tree/SKILL.md` |
| Work in the Mask area (13 symbols) | `.claude/skills/generated/mask/SKILL.md` |
| Work in the Cluster_22 area (12 symbols) | `.claude/skills/generated/cluster-22/SKILL.md` |
| Work in the Cluster_7 area (11 symbols) | `.claude/skills/generated/cluster-7/SKILL.md` |
| Work in the Cluster_8 area (10 symbols) | `.claude/skills/generated/cluster-8/SKILL.md` |
| Work in the Cluster_9 area (9 symbols) | `.claude/skills/generated/cluster-9/SKILL.md` |
| Work in the Hub area (8 symbols) | `.claude/skills/generated/hub/SKILL.md` |
| Work in the Cluster_20 area (7 symbols) | `.claude/skills/generated/cluster-20/SKILL.md` |
| Work in the Cluster_25 area (7 symbols) | `.claude/skills/generated/cluster-25/SKILL.md` |
| Work in the Cluster_12 area (6 symbols) | `.claude/skills/generated/cluster-12/SKILL.md` |
| Work in the Cluster_27 area (6 symbols) | `.claude/skills/generated/cluster-27/SKILL.md` |
| Work in the Cluster_21 area (5 symbols) | `.claude/skills/generated/cluster-21/SKILL.md` |
| Work in the Cluster_6 area (4 symbols) | `.claude/skills/generated/cluster-6/SKILL.md` |
| Work in the Patches area (4 symbols) | `.claude/skills/generated/patches/SKILL.md` |

<!-- gitnexus:end -->
