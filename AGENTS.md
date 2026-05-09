# Instructions for Coding Assistants

## Project Overview

This is a **monorepo** with npm workspaces:

- **Page Agent** (`packages/page-agent/`) - Main entry with built-in UI Panel, published as `page-agent` on npm
- **Extension** (`packages/extension/`) - Browser extension (WXT + React)
- **Website** (`packages/website/`) - React docs and landing page. **When working on website, follow `packages/website/AGENTS.md`**

Internal packages:

- **Core** (`packages/core/`) - PageAgentCore without UI (npm: `@page-agent/core`)
- **LLMs** (`packages/llms/`) - LLM client with reflection-before-action mental model
- **Page Controller** (`packages/page-controller/`) - DOM operations and visual feedback (SimulatorMask), independent of LLM
- **UI** (`packages/ui/`) - Panel and i18n. Decoupled from PageAgent

## Development Commands

```bash
npm start                      # Start website dev server
npm run build                  # Build all packages
npm run build:libs             # Build all libraries
npm run build:ext              # Build and zip the extension package
npm run typecheck              # Typecheck all packages
npm run lint                   # ESLint
```

## Architecture

### Monorepo Structure

Source-first monorepo: library `package.json` exports point to `src/*.ts` during development. At publish time, `scripts/pre-publish.js` promotes `publishConfig` fields to top-level (swapping to `dist/`), and `scripts/post-publish.js` restores the originals.

```
packages/
├── core/                    # npm: "@page-agent/core" ⭐ Core agent logic (headless)
├── page-agent/              # npm: "page-agent" entry class (with UI + controller + demo builds)
├── website/                 # @page-agent/website (private)
├── llms/                    # @page-agent/llms
├── extension/               # Browser extension
├── page-controller/         # @page-agent/page-controller
└── ui/                      # @page-agent/ui
```

`workspaces` in `package.json` must be in topological order.

### Module Boundaries

- **Page Agent**: Main entry with UI. Extends PageAgentCore and adds Panel. Imports from `@page-agent/core`, `@page-agent/ui`
- **Core**: PageAgentCore without UI. Imports from `@page-agent/llms`, `@page-agent/page-controller`
- **LLMs**: LLM client with MacroToolInput contract. No dependency on page-agent
- **UI**: Panel and i18n. Decoupled from PageAgent via PanelAgentAdapter interface
- **Page Controller**: DOM operations with optional visual feedback (SimulatorMask). No LLM dependency. Enable mask via `enableMask: true` config

### PageController ↔ PageAgent Communication

All communication is async and isolated:

```typescript
// PageAgent delegates DOM operations to PageController
await this.pageController.updateTree()
await this.pageController.clickElement(index)
await this.pageController.inputText(index, text)
await this.pageController.scroll({ down: true, numPages: 1 })

// PageController exposes state via async methods
const simplifiedHTML = await this.pageController.getSimplifiedHTML()
const pageInfo = await this.pageController.getPageInfo()
```

### DOM Pipeline

1. **DOM Extraction**: Live DOM → `FlatDomTree` via `page-controller/src/dom/dom_tree/`
2. **Dehydration**: DOM tree → simplified text for LLM
3. **LLM Processing**: AI returns action plans (page-agent)
4. **Indexed Operations**: PageAgent calls PageController by element index

## Key Files Reference

### Page Agent (`packages/page-agent/`)

| File               | Description                                  |
| ------------------ | -------------------------------------------- |
| `src/PageAgent.ts` | ⭐ Main class with UI, extends PageAgentCore |
| `src/demo.ts`      | IIFE demo entry (auto-init with demo API)    |

### Core (`packages/core/`)

| File                   | Description                             |
| ---------------------- | --------------------------------------- |
| `src/PageAgentCore.ts` | ⭐ Core agent class without UI          |
| `src/tools/`           | Tool definitions calling PageController |
| `src/config/`          | Configuration types and constants       |
| `src/prompts/`         | System prompt templates                 |

### LLMs (`packages/llms/`)

| File                  | Description                           |
| --------------------- | ------------------------------------- |
| `src/index.ts`        | ⭐ LLM class with retry logic         |
| `src/types.ts`        | MacroToolInput, AgentBrain, LLMConfig |
| `src/OpenAIClient.ts` | OpenAI-compatible client              |

### Page Controller (`packages/page-controller/`)

| File                        | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `src/PageController.ts`     | ⭐ Main controller class with optional mask support        |
| `src/SimulatorMask.ts`      | Visual overlay blocking user interaction during automation |
| `src/actions.ts`            | Element interactions (click, input, scroll)                |
| `src/dom/dom_tree/index.js` | Core DOM extraction engine                                 |

## Adding New Features

### New Agent Tool

1. Implement in `packages/core/src/tools/index.ts`
2. If tool needs DOM ops, add method to PageController first
3. Tool calls `this.pageController.methodName()` for DOM interactions

### New PageController Action

1. Add implementation in `packages/page-controller/src/actions.ts`
2. Expose via async method in `PageController.ts`
3. Export from `packages/page-controller/src/index.ts`

## Code Standards

- Explicit typing for exported/public APIs
- ESLint relaxes some unsafe rules for rapid iteration
- Every change you make should not only implement the desired functionality but also improve the quality of the codebase
- All code and comments must be in English.
- Do not try to hide errors or risks. They are valuable feedbacks for developers and users. Make them visible and actionable.
- Traceability and predictability is more important than success rate.

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
