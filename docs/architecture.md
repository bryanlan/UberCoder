---
doc_type: architecture
managed_by: sync-repo-docs
current_through_commit: 3cefa8cdec786585f937fdf05a80a111ab610632
current_through_date: 2026-05-25T19:39:43-07:00
---

# Architecture
## System Overview
agent-console is a local, server-first agent console. The primary human overview is `README.md`;
this managed doc is a current-state navigation and architecture companion for agents.

First-class runtime surfaces:
- Node/JavaScript package described by `package.json`.
- npm scripts: `npm run auth:hash`, `npm run build`, `npm run dev`, `npm run smoke:codex`, `npm run test`, `npm run test:e2e`, `npm run typecheck`.

## Main Components
- `apps/server/` - Fastify backend, project/config/auth routes, provider adapters, SQLite state,
  tmux session management, live-output normalization, and localhost proxying.
- `apps/web/` - React/Vite PWA for project navigation, conversation timelines, live session
  display, settings, and auth flows.
- `packages/shared/` - shared TypeScript contracts for sessions, conversations, projects, and
  provider data.
- `config/` - example runtime configuration for projects, providers, proxy allowlists, and auth.
- `scripts/` - operator/development helpers such as auth hash generation and host smoke checks.
- `docs/` - repository documentation and managed doc-sync metadata.
- `test-results/` - tracked repository area; inspect contained files before changing behavior.

Representative source anchors include `README.md`, `AGENTS.md`, `CLAUDE.md`, `package.json`, `requirements.txt`, `package-lock.json`, `playwright.config.ts`, `apps/server/src/routes/auth.ts`, `apps/server/src/routes/conversations.ts`, `apps/server/src/routes/events.ts`.

## Data Flow
The server is authoritative for project configuration, conversation indexes, bound sessions,
provider transcript loading, proxy access, and auth. The web app requests server APIs and renders
the resulting conversation/session model; it should not become a raw terminal controller.

Conversation timelines merge provider transcripts with live session event logs. Raw tmux screen
captures are parsed by `apps/server/src/sessions/session-screen.ts` for session state, while
user-visible incremental output comes through `apps/server/src/sessions/live-output.ts` and the
event log attached to the bound session. This keeps terminal chrome, repaint fragments, and echoed
user input out of assistant-visible timeline text.

The latest doc sync reviewed 6 changed path(s) since the previous docs baseline.

## External Integrations
- Anthropic/Claude references appear in manifests, README, or environment examples; verify concrete clients in source before changing behavior.
- PostgreSQL/database references appear in manifests, README, or environment examples; verify concrete clients in source before changing behavior.
- FastAPI/HTTP references appear in manifests, README, or environment examples; verify concrete clients in source before changing behavior.

## Key Decisions
- Managed docs are synchronized against the live tree and finalized to the current git `HEAD`; commit dossier files are navigation context, not source of truth.
- Prefer current ownership modules over stale facade or compatibility paths when changing behavior.
- Do not add compatibility layers, fallback mappings, or legacy response fields unless the caller contract explicitly requires them.
- Session recency is not a generic "screen changed" timestamp. Opening an old session, restoring a
  tmux binding, viewing an old transcript, raw restore output, or the screen merely leaving
  `Working` must not make a conversation look fresh.
- Completion recency moves after new trackable output has idled past the completion window. Review
  `apps/server/src/sessions/session-manager.ts` and `apps/server/test/session-manager.test.ts`
  before changing `lastActivityAt`, `lastOutputAt`, `lastCompletedAt`, `isWorking`, restore, or
  recovery behavior.
- Live-output latency and correctness belong in the event-log normalization path. Review
  `apps/server/src/sessions/live-output.ts`, `apps/server/test/live-output.test.ts`, and
  `apps/web/src/features/conversation/useConversationDataController.ts` before changing timeline
  merge or refresh behavior.

## Operational Notes
Use `docs/agent_docs/running_tests.md` for safe verification commands. Do not infer deploy, restore, migration, promotion, scheduler, or production-mutating workflows from test documentation.
