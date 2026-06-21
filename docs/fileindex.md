---
doc_type: fileindex
managed_by: sync-repo-docs
current_through_commit: 8f674be667f798fc07f590d033ca14fc21fbf733
current_through_date: 2026-06-20T18:00:31-07:00
---

# File Index
## Top-Level Layout
- `apps/` - JavaScript/TypeScript source for the Fastify server and React PWA.
- `config/` - configuration files.
- `docs/` - repository documentation and managed doc-sync metadata.
- `packages/` - JavaScript/TypeScript source.
- `scripts/` - operator or development scripts.
- `test-results/` - ignored/generated Playwright evidence; rerun e2e before treating contents as
  current failures.

## Key Directories
- `apps/server/src/sessions/` - tmux session manager, screen parsing, and event-log live-output
  normalization.
- `apps/server/src/routes/` - Fastify API routes for auth, conversations, sessions, projects,
  settings, and live events.
- `apps/server/src/providers/` - Codex/Claude adapters and transcript normalization.
- `apps/server/test/` - Vitest coverage for server routes, providers, sessions, live output, and
  indexing behavior.
- `apps/web/src/features/conversation/` - client-side conversation data fetching and timeline
  refresh controller.
- `apps/web/src/components/` - sidebar, conversation pane, and app-level UI components.
- `apps/web/e2e/` - Playwright browser coverage for settings and explicit project workflows.
- `config/` - runtime config templates and project/proxy/auth settings shape.
- `packages/` - shared TypeScript contracts.
- `scripts/` - operator or development scripts.
- `test-results/` - ignored/generated Playwright failure artifacts, not source architecture.

## Key Files
- `README.md` - key tracked file or entrypoint for this repo.
- `AGENTS.md` - key tracked file or entrypoint for this repo.
- `CLAUDE.md` - key tracked file or entrypoint for this repo.
- `package.json` - key tracked file or entrypoint for this repo.
- `requirements.txt` - key tracked file or entrypoint for this repo.
- `package-lock.json` - key tracked file or entrypoint for this repo.
- `playwright.config.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/auth.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/conversations.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/events.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/projects.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/sessions.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/settings.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/app.ts` - Fastify app composition, route registration, static serving, indexing startup, and session observation.
- `apps/server/src/config/schema.ts` and `service.ts` - config schema, merge behavior, runtime paths, provider/project settings, and security knobs.
- `apps/server/src/db/database.ts` - SQLite persistence boundary.
- `apps/server/src/indexing/indexing-service.ts` - provider/project conversation indexing and tree refresh.
- `apps/server/src/projects/project-service.ts` - explicit project config and project tree behavior.
- `apps/server/src/providers/codex-provider.ts`, `claude-provider.ts`, and `registry.ts` - vendor transcript discovery and launch command adapters.
- `apps/server/src/proxy/localhost-proxy.ts` - authenticated allowlisted localhost proxy.
- `apps/server/src/security/auth-service.ts` and `password.ts` - cookie auth, Tailscale identity bootstrap, and password verification.
- `apps/server/src/sessions/session-manager.ts` - bound-session lifecycle, restore, recovery,
  working state, and recency timestamps.
- `apps/server/src/sessions/live-output.ts` - event-log normalization for user-visible live output.
- `apps/server/src/sessions/session-screen.ts` - raw tmux screen parsing for session status/content.
- `apps/server/src/sessions/tmux-client.ts` - tmux command boundary.
- `apps/web/src/features/conversation/useConversationDataController.ts` - conversation timeline
  fetch/refresh path on the web side.
- `apps/web/src/components/Sidebar.tsx` and `ConversationPane.tsx` - main conversation navigation and display surfaces.
- `apps/web/src/pages/SettingsPage.tsx` - explicit project/config management UI.
- `apps/web/src/lib/api.ts` - web API client boundary.
- `apps/web/e2e/settings.spec.ts` - browser coverage for settings, explicit project additions, and legacy project migration behavior.
- `scripts/generate-password-hash.mjs` - operator helper for auth password hashes.
- `scripts/smoke-codex-adoption.mjs` - opt-in host smoke check for real Codex/tmux session adoption.
- `apps/server/test/auth.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/command-and-proxy.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/config.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/conversation-routes.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/conversations.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/database.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/e2e/server.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/fixtures/claude/history.jsonl` - key tracked file or entrypoint for this repo.
- `apps/server/test/fixtures/claude/projects/-tmp-demo-project-/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl` - key tracked file or entrypoint for this repo.
- `apps/server/test/fixtures/codex/sessions/2026/02/14/rollout-11111111-2222-4333-8444-555555555555.jsonl` - key tracked file or entrypoint for this repo.
- `apps/server/test/indexing-service.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/indexing.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/live-output.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/projects-routes.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/projects.test.ts` - key tracked file or entrypoint for this repo.

Test and verification anchors:
- `apps/server/test/auth.test.ts` - representative test or verification file.
- `apps/server/test/command-and-proxy.test.ts` - representative test or verification file.
- `apps/server/test/config.test.ts` - representative test or verification file.
- `apps/server/test/conversation-routes.test.ts` - representative test or verification file.
- `apps/server/test/conversations.test.ts` - representative test or verification file.
- `apps/server/test/database.test.ts` - representative test or verification file.
- `apps/server/test/indexing-service.test.ts` - representative test or verification file.
- `apps/server/test/indexing.test.ts` - representative test or verification file.
- `apps/server/test/live-output.test.ts` - representative test or verification file.
- `apps/server/test/session-manager.test.ts` - representative test or verification file.
- `apps/server/test/projects-routes.test.ts` - representative test or verification file.
- `apps/server/test/projects.test.ts` - representative test or verification file.
- `apps/server/test/providers.test.ts` - representative test or verification file.
- `apps/server/test/session-manager.test.ts` - representative test or verification file.
- `apps/server/test/session-routes.test.ts` - representative test or verification file.
- `apps/server/test/session-screen.test.ts` - representative test or verification file.
- `apps/server/test/settings.test.ts` - representative test or verification file.

## Change Hotspots
- Runtime entrypoint changes should be reviewed with adjacent service, route, CLI, or frontend modules and the tests that exercise them.
- Manifest or dependency changes should be reviewed with setup docs and `docs/agent_docs/running_tests.md`.
- Documentation-only changes should stay scoped to managed docs unless source-of-truth operator docs are stale.
- Session recency, restore, recovery, or idle-completion changes should review
  `apps/server/src/sessions/session-manager.ts`, `apps/server/test/session-manager.test.ts`,
  `apps/web/src/components/Sidebar.tsx`, and any API response shape consumed by the sidebar.
- Live output or text latency changes should review `apps/server/src/sessions/live-output.ts`,
  `apps/server/test/live-output.test.ts`,
  `apps/web/src/features/conversation/useConversationDataController.ts`, and
  `apps/web/src/components/ConversationPane.tsx`.
- Settings/project-discovery changes should review `apps/server/src/config/service.ts`,
  `apps/server/src/projects/project-service.ts`, `apps/server/src/routes/settings.ts`,
  `apps/web/src/pages/SettingsPage.tsx`, and the Playwright settings e2e tests together.
- When recent commits rename, split, or demote modules, verify whether the old file still owns behavior or only delegates to newer modules.

## Deferred or Unclear Areas
- Playwright e2e artifacts under `test-results/` are generated evidence, not source architecture.
- Host-level Codex smoke validation requires a running backend plus real Codex/tmux access and is intentionally opt-in.
