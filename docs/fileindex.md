---
doc_type: fileindex
managed_by: sync-repo-docs
current_through_commit: 245086a325e22f429bfabe9999e0f212510272db
current_through_date: 2026-05-25T02:03:14-07:00
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
- `apps/` - JavaScript/TypeScript source.
- `config/` - configuration files.
- `docs/` - repository documentation and managed doc-sync metadata.
- `packages/` - JavaScript/TypeScript source.
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
- When recent commits rename, split, or demote modules, verify whether the old file still owns behavior or only delegates to newer modules.

## Deferred or Unclear Areas
- This rollout used live manifests, README content, tracked file layout, and representative source paths. Confirm deeper domain semantics in source before large behavior changes.
