---
doc_type: architecture
managed_by: sync-repo-docs
current_through_commit: 245086a325e22f429bfabe9999e0f212510272db
current_through_date: 2026-05-25T02:03:14-07:00
---

# Architecture
## System Overview
agent-console is documented from the current repository tree. The primary human overview is `README.md`; this managed doc is a current-state navigation and architecture companion for agents.

First-class runtime surfaces:
- Node/JavaScript package described by `package.json`.
- npm scripts: `npm run auth:hash`, `npm run build`, `npm run dev`, `npm run smoke:codex`, `npm run test`, `npm run test:e2e`, `npm run typecheck`.

## Main Components
- `apps/` - JavaScript/TypeScript source.
- `config/` - configuration files.
- `docs/` - repository documentation and managed doc-sync metadata.
- `packages/` - JavaScript/TypeScript source.
- `scripts/` - operator or development scripts.
- `test-results/` - tracked repository area; inspect contained files before changing behavior.

Representative source anchors include `README.md`, `AGENTS.md`, `CLAUDE.md`, `package.json`, `requirements.txt`, `package-lock.json`, `playwright.config.ts`, `apps/server/src/routes/auth.ts`, `apps/server/src/routes/conversations.ts`, `apps/server/src/routes/events.ts`.

## Data Flow
Start at the runtime surfaces above, then follow imports, routes, command handlers, or scripts into the source directories listed in `docs/fileindex.md`. Treat generated outputs, caches, local data, and reports as derived artifacts unless the repo README or an operator guide explicitly says they are source inputs.

The latest doc sync reviewed 6 changed path(s) since the previous docs baseline.

## External Integrations
- Anthropic/Claude references appear in manifests, README, or environment examples; verify concrete clients in source before changing behavior.
- PostgreSQL/database references appear in manifests, README, or environment examples; verify concrete clients in source before changing behavior.
- FastAPI/HTTP references appear in manifests, README, or environment examples; verify concrete clients in source before changing behavior.

## Key Decisions
- Managed docs are synchronized against the live tree and finalized to the current git `HEAD`; commit dossier files are navigation context, not source of truth.
- Prefer current ownership modules over stale facade or compatibility paths when changing behavior.
- Do not add compatibility layers, fallback mappings, or legacy response fields unless the caller contract explicitly requires them.

## Operational Notes
Use `docs/agent_docs/running_tests.md` for safe verification commands. Do not infer deploy, restore, migration, promotion, scheduler, or production-mutating workflows from test documentation.
