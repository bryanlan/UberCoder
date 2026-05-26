---
doc_type: fileindex
managed_by: sync-repo-docs
current_through_commit: 3cefa8cdec786585f937fdf05a80a111ab610632
current_through_date: 2026-05-25T19:39:43-07:00
---

# File Index
## Top-Level Layout
- `apps/` - JavaScript/TypeScript source.
- `config/` - configuration files.
- `docs/` - repository documentation and managed doc-sync metadata.
- `packages/` - JavaScript/TypeScript source.
- `scripts/` - operator or development scripts.
- `test-results/` - tracked repository area; inspect contained files before changing behavior.

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
- `config/` - runtime config templates and project/proxy/auth settings shape.
- `packages/` - shared TypeScript contracts.
- `scripts/` - operator or development scripts.
- `test-results/` - tracked repository area; inspect contained files before changing behavior.

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
- `apps/server/src/sessions/session-manager.ts` - bound-session lifecycle, restore, recovery,
  working state, and recency timestamps.
- `apps/server/src/sessions/live-output.ts` - event-log normalization for user-visible live output.
- `apps/server/src/sessions/session-screen.ts` - raw tmux screen parsing for session status/content.
- `apps/web/src/features/conversation/useConversationDataController.ts` - conversation timeline
  fetch/refresh path on the web side.
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
- When recent commits rename, split, or demote modules, verify whether the old file still owns behavior or only delegates to newer modules.

## Deferred or Unclear Areas
- This rollout used live manifests, README content, tracked file layout, and representative source paths. Confirm deeper domain semantics in source before large behavior changes.
