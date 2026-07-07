# Commit Dossier

- Repository: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console`
- Generated at: `2026-07-07T04:26:23+00:00`
- Repo HEAD: `35f7d35c9fcaadb279dba096c4132de19f01b630` (2026-07-06T21:14:04-04:00)
- Worktree dirty: `true`
- Docs current through: `6c0c76e8fb45eb59070431cd89e6ea8b78f02082`
- Docs current through date: `2026-07-05T18:31:15-04:00`

## Changed Paths Since Docs Baseline

- `AGENTS.md`
- `apps/server/src/app.ts`
- `apps/server/src/db/database.ts`
- `apps/server/src/db/repos/interaction-summaries.ts`
- `apps/server/src/db/repos/search-index.ts`
- `apps/server/src/db/repos/transcript-parse-cache.ts`
- `apps/server/src/db/schema.ts`
- `apps/server/src/index.ts`
- `apps/server/src/indexing/indexing-service.ts`
- `apps/server/src/lib/conversation-summary.ts`
- `apps/server/src/lib/provider-conversation-cache.ts`
- `apps/server/src/providers/claude-provider.ts`
- `apps/server/src/providers/codex-provider.ts`
- `apps/server/src/providers/file-utils.ts`
- `apps/server/src/providers/registry.ts`
- `apps/server/src/providers/transcripts/base.ts`
- `apps/server/src/providers/transcripts/codex.ts`
- `apps/server/src/providers/types.ts`
- `apps/server/src/routes/conversations.ts`
- `apps/server/src/sessions/session-manager.ts`
- `apps/server/src/sessions/timeline-merge.ts`
- `apps/server/src/sessions/tmux-client.ts`
- `apps/server/src/summaries/session-summary-service.ts`
- `apps/server/test/helpers/session-fixtures.ts`
- `apps/server/test/indexing-service.test.ts`
- `apps/server/test/providers.test.ts`
- `apps/server/test/session-lifecycle.test.ts`
- `apps/server/test/session-summary-service.test.ts`
- `apps/server/test/tmux-health.test.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/features/realtime/reducers.test.ts`
- `apps/web/src/features/realtime/reducers.ts`
- `docs/agent_docs/agents_md_status.json`
- `docs/agent_docs/commit_dossier.json`
- `docs/agent_docs/commit_dossier.md`
- `docs/agent_docs/doc_status.json`
- `docs/agent_docs/running_tests.md`
- `docs/architecture.md`
- `docs/fileindex.md`
- `package.json`
- `packages/shared/src/index.ts`
- `scripts/backfill-work-mode-session-summaries.mjs`

## Commits Since Docs Baseline

### 7322e11 Sync repo docs

- Date: `2026-07-06T00:30:13-04:00`
- Author: `bryanlan`
- Files:
  - `M` `docs/agent_docs/commit_dossier.json`
  - `M` `docs/agent_docs/commit_dossier.md`
  - `M` `docs/agent_docs/doc_status.json`
  - `M` `docs/agent_docs/running_tests.md`
  - `M` `docs/architecture.md`
  - `M` `docs/fileindex.md`

### a5ef615 Refresh AGENTS.md

- Date: `2026-07-06T02:13:13-04:00`
- Author: `bryanlan`
- Files:
  - `M` `AGENTS.md`
  - `M` `docs/agent_docs/agents_md_status.json`

### 3487b83 Add regression coverage for workflow hotspot

- Date: `2026-07-06T04:17:40-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/features/realtime/reducers.test.ts`

### dd98f37 Address Ralph review findings

- Date: `2026-07-06T04:25:07-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/features/realtime/reducers.test.ts`
  - `M` `apps/web/src/features/realtime/reducers.ts`

### 4917397 Merge pull request #3 from bryanlan/automation/regression-hotspot-sentinel-coding/agent-console/dd98f37f5e32

- Date: `2026-07-06T04:28:23-04:00`
- Author: `bryanlan`

### b4102a1 Show all pending Codex progress messages

- Date: `2026-07-06T06:28:42-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/providers/transcripts/codex.ts`
  - `M` `apps/server/test/providers.test.ts`

### 6e14465 Isolate tmux session lifecycle from server restarts

- Date: `2026-07-06T06:48:05-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/app.ts`
  - `M` `apps/server/src/index.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/src/sessions/tmux-client.ts`
  - `M` `apps/server/test/helpers/session-fixtures.ts`
  - `M` `apps/server/test/session-lifecycle.test.ts`
  - `M` `apps/server/test/tmux-health.test.ts`

### 36a7336 Fix O(n²) transcript parse hotspot and shed dead-weight features

- Date: `2026-07-06T20:59:15-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/app.ts`
  - `M` `apps/server/src/db/database.ts`
  - `D` `apps/server/src/db/repos/interaction-summaries.ts`
  - `M` `apps/server/src/db/repos/search-index.ts`
  - `A` `apps/server/src/db/repos/transcript-parse-cache.ts`
  - `M` `apps/server/src/db/schema.ts`
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `M` `apps/server/src/lib/conversation-summary.ts`
  - `M` `apps/server/src/lib/provider-conversation-cache.ts`
  - `M` `apps/server/src/providers/claude-provider.ts`
  - `M` `apps/server/src/providers/codex-provider.ts`
  - `M` `apps/server/src/providers/file-utils.ts`
  - `M` `apps/server/src/providers/registry.ts`
  - `M` `apps/server/src/providers/transcripts/base.ts`
  - `M` `apps/server/src/providers/transcripts/codex.ts`
  - `M` `apps/server/src/providers/types.ts`
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/src/sessions/timeline-merge.ts`
  - `D` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/server/test/indexing-service.test.ts`
  - `M` `apps/server/test/providers.test.ts`
  - `M` `apps/server/test/session-lifecycle.test.ts`
  - `D` `apps/server/test/session-summary-service.test.ts`
  - `M` `apps/web/src/components/Sidebar.tsx`
  - `M` `package.json`
  - `M` `packages/shared/src/index.ts`
  - `D` `scripts/backfill-work-mode-session-summaries.mjs`

### 35f7d35 Address Codex review findings on perf overhaul

- Date: `2026-07-06T21:14:04-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/app.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/session-lifecycle.test.ts`
