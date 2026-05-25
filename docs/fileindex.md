---
doc_type: fileindex
managed_by: sync-repo-docs
current_through_commit: 8eedf7118f5bd513ebdd2519e8fcbf4779df0c87
current_through_date: 2026-05-24T19:02:42-07:00
---

# File Index
## Top-Level Layout
- `apps/` - top-level directory in the current tree.
- `config/` - top-level directory in the current tree.
- `docs/` - top-level directory in the current tree.
- `packages/` - top-level directory in the current tree.
- `scripts/` - top-level directory in the current tree.
- `test-results/` - top-level directory in the current tree.

## Key Directories
- `apps/` - contains `apps/server/package.json`, `apps/server/src/app.ts`, `apps/server/src/config/schema.ts`, `apps/server/src/config/service.ts`, `apps/server/src/db/database.ts`.
- `config/` - contains `config/agent-console.example.json`.
- `docs/` - contains `docs/agent_docs/agents_md_status.json`, `docs/agent_docs/commit_dossier.json`, `docs/agent_docs/commit_dossier.md`, `docs/agent_docs/doc_status.json`, `docs/agent_docs/running_tests.md`.
- `packages/` - contains `packages/shared/package.json`, `packages/shared/src/index.d.ts`, `packages/shared/src/index.js`, `packages/shared/src/index.ts`, `packages/shared/tsconfig.json`.
- `scripts/` - contains `scripts/generate-password-hash.mjs`, `scripts/smoke-codex-adoption.mjs`.
- `test-results/` - contains `test-results/.last-run.json`, `test-results/settings-settings-project--14b08-of-the-console-after-reload/error-context.md`, `test-results/settings-settings-project--176c0-history-in-the-console-tree/error-context.md`, `test-results/settings-settings-project--ec38b-he-old-auto-discovery-model/error-context.md`.

## Key Files
- `README.md` - repository configuration, entrypoint, or operator documentation.
- `AGENTS.md` - repository configuration, entrypoint, or operator documentation.
- `CLAUDE.md` - repository configuration, entrypoint, or operator documentation.
- `package.json` - repository configuration, entrypoint, or operator documentation.
- `package-lock.json` - repository configuration, entrypoint, or operator documentation.
- `requirements.txt` - repository configuration, entrypoint, or operator documentation.
- JS/TS anchors: `apps/server/src/app.ts`, `apps/server/src/config/schema.ts`, `apps/server/src/config/service.ts`, `apps/server/src/db/database.ts`, `apps/server/src/index.ts`, `apps/server/src/indexing/indexing-service.ts`, `apps/server/src/lib/agent-console-path.ts`, `apps/server/src/lib/async.ts`, `apps/server/src/lib/conversation-summary.ts`, `apps/server/src/lib/path-utils.ts`, `apps/server/src/lib/pending-conversation-match.ts`, `apps/server/src/lib/provider-conversation-cache.ts`.
- Test anchors: `apps/server/test/auth.test.ts`, `apps/server/test/command-and-proxy.test.ts`, `apps/server/test/config.test.ts`, `apps/server/test/conversation-routes.test.ts`, `apps/server/test/conversations.test.ts`, `apps/server/test/database.test.ts`, `apps/server/test/indexing-service.test.ts`, `apps/server/test/indexing.test.ts`, `apps/server/test/live-output.test.ts`, `apps/server/test/projects-routes.test.ts`, `apps/server/test/projects.test.ts`, `apps/server/test/providers.test.ts`.

## Change Hotspots
- `apps/` changes should be reviewed with adjacent tests and docs.
- `scripts/` changes should be reviewed with adjacent tests and docs.
- `docs/` changes should be reviewed with adjacent tests and docs.
- When touching manifests or runtime entrypoints, update this file and `docs/architecture.md` in the same change.

## Deferred or Unclear Areas
- This automated rollout used live manifests, README content, and tracked file layout; deeper domain semantics should be confirmed in representative source before large behavior changes.
