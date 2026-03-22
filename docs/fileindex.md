---
doc_type: fileindex
managed_by: sync-repo-docs
current_through_commit: 1c87c2d00464940608ec9e83b2d1b13be560f9ab
current_through_date: 2026-03-18T08:41:07-07:00
---

# File Index

## Top-Level Layout

- `apps/server/` contains the Fastify backend, provider adapters, SQLite layer, proxy, realtime bus, restart flow, routes, session manager, and tests.
- `apps/web/` contains the React/Vite PWA UI.
- `packages/shared/` contains shared types/contracts.
- `config/` contains the example runtime config.
- `scripts/` contains host helpers such as password hash generation and Codex smoke validation.
- `docs/` contains design and managed repo documentation.
- `test-results/` contains Playwright failure artifacts from recent e2e runs.

## Key Directories

- `apps/server/src/config/`: zod schema and config loading/merge behavior.
- `apps/server/src/projects/`: explicit project listing and path resolution from saved config entries.
- `apps/server/src/providers/`: provider registry plus Codex/Claude adapters and transcript parsers.
- `apps/server/src/indexing/`: filesystem-backed conversation indexing and cache refresh behavior.
- `apps/server/src/realtime/`: server-side event bus used for live UI invalidation.
- `apps/server/src/routes/`: auth, conversations, events, projects, sessions, and settings API routes.
- `apps/server/src/sessions/`: live-output capture, tmux integration, and session lifecycle management.
- `apps/server/src/security/`: auth-service and password handling.
- `apps/server/src/proxy/`: localhost proxy enforcement.
- `apps/server/src/runtime/`: controlled backend restart logic after config changes.
- `apps/web/src/components/`: sidebar, conversation pane, directory picker, and shared UI pieces.
- `apps/web/src/lib/`: API client and shared browser helpers such as clipboard fallback logic.
- `apps/web/src/pages/`: login and settings views.
- `apps/server/test/`: backend, route, provider, indexing, and session tests with fixtures.
- `apps/web/e2e/`: Playwright end-to-end coverage for settings/project flows.

## Key Files

- `AGENTS.md`: repo-root working guidance for coding conventions and command usage.
- `README.md`: canonical product/setup/ops guide.
- `readme.md`: lowercase shim that points tooling back to `README.md`.
- `package.json`: root workspace build/dev/test/typecheck commands.
- `apps/server/src/index.ts`: backend startup entrypoint.
- `apps/server/src/app.ts`: Fastify app assembly and route/plugin wiring.
- `apps/server/src/config/service.ts`: config loading, normalization, and override logic.
- `apps/server/src/config/schema.ts`: zod schema for global settings, projects, provider commands, and security.
- `apps/server/src/indexing/indexing-service.ts`: core conversation indexing/cache service.
- `apps/server/src/providers/codex-provider.ts` and `apps/server/src/providers/claude-provider.ts`: vendor adapters.
- `apps/server/src/sessions/session-manager.ts`: authoritative live-session lifecycle logic.
- `apps/server/src/sessions/session-screen.ts`: normalized live-screen projection for the UI.
- `apps/server/src/routes/settings.ts`: operator-facing settings API and config mutation flow.
- `apps/server/src/proxy/localhost-proxy.ts`: per-project allowlisted localhost proxy.
- `apps/server/src/runtime/restart-service.ts`: restart scheduling used after global config changes.
- `apps/web/src/App.tsx`, `apps/web/src/components/Sidebar.tsx`, and `apps/web/src/components/ConversationPane.tsx`: primary client shell and session UI.
- `apps/web/src/lib/clipboard.ts`: shared clipboard helper used by current web-tree changes.
- `apps/web/e2e/settings.spec.ts`: Playwright coverage for explicit saved-project settings flows.
- `scripts/smoke-codex-adoption.mjs`: real host-level Codex adoption smoke test.

## Change Hotspots

- `apps/server/src/providers/`, `apps/server/src/indexing/indexing-service.ts`, and `apps/server/test/providers.test.ts` move together when vendor transcript formats or discovery behavior change.
- `apps/server/src/sessions/`, `apps/server/test/session-screen.test.ts`, `apps/server/test/session-manager.test.ts`, and `apps/web/src/components/ConversationPane.tsx` move together when live-session behavior changes.
- `apps/server/src/config/`, `apps/server/src/routes/settings.ts`, `apps/web/src/pages/SettingsPage.tsx`, and `config/agent-console.example.json` move together when operator-visible settings change.
- `apps/server/src/projects/project-service.ts`, `apps/server/src/routes/settings.ts`, `apps/web/e2e/settings.spec.ts`, and settings-page UI move together when explicit project-management behavior changes.
- `apps/web/src/App.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/ConversationPane.tsx`, and `apps/web/src/lib/clipboard.ts` move together when navigation, mobile session UX, or copy actions change.

## Deferred or Unclear Areas

- The repo is intentionally MVP-scoped; higher-level task/worktree abstractions are absent by design, so future additions in that direction would need new docs rather than incremental edits here.
- The current working tree is dirty, so local UI changes and generated Playwright artifacts are ahead of the last recorded tracked-doc baseline.
- `node_modules/`, `dist/`, and `test-results/` are operational artifacts, not authored source.
- There is only one nested git repo under `UberCoder`, so parent-folder naming should not be treated as the deployable project boundary.
