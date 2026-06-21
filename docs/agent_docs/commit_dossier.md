# Commit Dossier

- Repository: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console`
- Generated at: `2026-06-21T05:42:48+00:00`
- Repo HEAD: `8f674be667f798fc07f590d033ca14fc21fbf733` (2026-06-20T18:00:31-07:00)
- Worktree dirty: `true`
- Docs current through: `ee48f2ebc65fdf5e35e82162b6df71bb43f530ee`
- Docs current through date: `2026-06-12T23:21:25-07:00`

## Changed Paths Since Docs Baseline

- `apps/server/src/app.ts`
- `apps/server/src/db/database.ts`
- `apps/server/src/indexing/indexing-service.ts`
- `apps/server/src/lib/bound-session-state.ts`
- `apps/server/src/lib/conversation-summary.ts`
- `apps/server/src/lib/conversation-visibility.ts`
- `apps/server/src/lib/prose-sanitizer.ts`
- `apps/server/src/providers/transcripts/base.ts`
- `apps/server/src/providers/transcripts/codex.ts`
- `apps/server/src/providers/transcripts/types.ts`
- `apps/server/src/routes/conversations.ts`
- `apps/server/src/routes/search.ts`
- `apps/server/src/search/conversation-search.ts`
- `apps/server/src/sessions/live-output.ts`
- `apps/server/src/sessions/session-manager.ts`
- `apps/server/src/summaries/session-summary-service.ts`
- `apps/server/test/conversation-routes.test.ts`
- `apps/server/test/database.test.ts`
- `apps/server/test/indexing-service.test.ts`
- `apps/server/test/live-output.test.ts`
- `apps/server/test/providers.test.ts`
- `apps/server/test/search.test.ts`
- `apps/server/test/session-manager.test.ts`
- `apps/server/test/session-summary-service.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/components/ConversationPane.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/features/conversation/useConversationDataController.ts`
- `apps/web/src/features/conversation/useConversationScrollController.ts`
- `apps/web/src/lib/api.ts`
- `docs/agent_docs/commit_dossier.json`
- `docs/agent_docs/commit_dossier.md`
- `docs/agent_docs/doc_status.json`
- `docs/agent_docs/running_tests.md`
- `docs/architecture.md`
- `docs/fileindex.md`
- `package.json`
- `packages/shared/src/index.d.ts`
- `packages/shared/src/index.js`
- `packages/shared/src/index.ts`
- `scripts/backfill-work-mode-session-summaries.mjs`

## Commits Since Docs Baseline

### 9c134ce Sync repo docs

- Date: `2026-06-13T23:43:02-07:00`
- Author: `bryanlan`
- Files:
  - `M` `docs/agent_docs/commit_dossier.json`
  - `M` `docs/agent_docs/commit_dossier.md`
  - `M` `docs/agent_docs/doc_status.json`
  - `M` `docs/agent_docs/running_tests.md`
  - `M` `docs/architecture.md`
  - `M` `docs/fileindex.md`

### 402fbb0 Autocommit: add session interaction summaries

- Date: `2026-06-17T23:16:17-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/app.ts`
  - `M` `apps/server/src/db/database.ts`
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `M` `apps/server/src/lib/conversation-summary.ts`
  - `A` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/server/test/indexing-service.test.ts`
  - `A` `apps/server/test/session-summary-service.test.ts`
  - `M` `apps/web/src/components/Sidebar.tsx`
  - `M` `packages/shared/src/index.d.ts`
  - `M` `packages/shared/src/index.ts`

### 7994252 Autocommit: hide errored sessions from console tree

- Date: `2026-06-18T22:59:25-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/db/database.ts`
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `A` `apps/server/src/lib/bound-session-state.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/server/test/database.test.ts`
  - `M` `apps/server/test/indexing-service.test.ts`
  - `M` `apps/server/test/session-manager.test.ts`

### eabfb3c add chat search and summary backfill

- Date: `2026-06-19T12:32:17-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/app.ts`
  - `M` `apps/server/src/db/database.ts`
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `A` `apps/server/src/lib/conversation-visibility.ts`
  - `A` `apps/server/src/lib/prose-sanitizer.ts`
  - `M` `apps/server/src/routes/conversations.ts`
  - `A` `apps/server/src/routes/search.ts`
  - `A` `apps/server/src/search/conversation-search.ts`
  - `M` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/server/test/indexing-service.test.ts`
  - `A` `apps/server/test/search.test.ts`
  - `M` `apps/server/test/session-summary-service.test.ts`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `apps/web/src/components/Sidebar.tsx`
  - `M` `apps/web/src/features/conversation/useConversationScrollController.ts`
  - `M` `apps/web/src/lib/api.ts`
  - `M` `package.json`
  - `M` `packages/shared/src/index.d.ts`
  - `M` `packages/shared/src/index.js`
  - `M` `packages/shared/src/index.ts`
  - `A` `scripts/backfill-work-mode-session-summaries.mjs`

### 406cf3e fix summary hover spacing

- Date: `2026-06-19T13:04:18-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/web/src/components/Sidebar.tsx`

### c9ae0f5 address ralph review findings

- Date: `2026-06-19T13:17:43-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/db/database.ts`
  - `M` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/server/test/search.test.ts`
  - `M` `apps/server/test/session-summary-service.test.ts`
  - `M` `apps/web/src/components/Sidebar.tsx`
  - `M` `scripts/backfill-work-mode-session-summaries.mjs`

### 1f7352c fix summary backfill workflow

- Date: `2026-06-19T14:55:10-07:00`
- Author: `bryanlan`
- Files:
  - `M` `package.json`
  - `M` `scripts/backfill-work-mode-session-summaries.mjs`

### 6a72674 filter codex exec conversations

- Date: `2026-06-19T17:17:31-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `M` `apps/server/src/lib/conversation-visibility.ts`
  - `M` `apps/server/src/providers/transcripts/base.ts`
  - `M` `apps/server/src/providers/transcripts/codex.ts`
  - `M` `apps/server/src/providers/transcripts/types.ts`
  - `M` `apps/server/src/search/conversation-search.ts`
  - `M` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/server/test/database.test.ts`
  - `M` `apps/server/test/providers.test.ts`
  - `M` `apps/server/test/search.test.ts`

### d43aae7 fix chat search and live timeline performance

- Date: `2026-06-20T17:08:29-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/search/conversation-search.ts`
  - `M` `apps/server/src/sessions/live-output.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/live-output.test.ts`
  - `M` `apps/server/test/search.test.ts`
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `apps/web/src/components/Sidebar.tsx`
  - `M` `apps/web/src/features/conversation/useConversationDataController.ts`
  - `M` `apps/web/src/features/conversation/useConversationScrollController.ts`
  - `M` `apps/web/src/lib/api.ts`

### 8f674be exclude raw live assistant chunks from transcripts

- Date: `2026-06-20T18:00:31-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/search/conversation-search.ts`
  - `M` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/search.test.ts`
  - `M` `apps/server/test/session-summary-service.test.ts`
