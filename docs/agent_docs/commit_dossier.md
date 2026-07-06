# Commit Dossier

- Repository: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console`
- Generated at: `2026-07-06T04:24:02+00:00`
- Repo HEAD: `6c0c76e8fb45eb59070431cd89e6ea8b78f02082` (2026-07-05T18:31:15-04:00)
- Worktree dirty: `true`
- Docs current through: `4ea81ed1b37d50a8d0f1d83c5f81b4db2b91dff1`
- Docs current through date: `2026-07-05T00:30:34-04:00`

## Changed Paths Since Docs Baseline

- `AGENTS.md`
- `apps/server/src/db/repos/bound-sessions.ts`
- `apps/server/src/db/repos/conversation-index.ts`
- `apps/server/src/db/repos/search-index.ts`
- `apps/server/src/indexing/indexing-service.ts`
- `apps/server/src/providers/codex-provider.ts`
- `apps/server/src/providers/file-utils.ts`
- `apps/server/src/providers/transcripts/base.ts`
- `apps/server/src/providers/types.ts`
- `apps/server/src/routes/conversations.ts`
- `apps/server/src/sessions/live-output/filters.ts`
- `apps/server/src/sessions/pending-adoption.ts`
- `apps/server/src/sessions/session-manager.ts`
- `apps/server/test/conversation-routes.test.ts`
- `apps/server/test/database.test.ts`
- `apps/server/test/indexing.test.ts`
- `apps/server/test/live-output.test.ts`
- `apps/server/test/session-recency.test.ts`
- `apps/server/test/session-runtime.test.ts`
- `apps/web/src/components/ConversationPane.test.tsx`
- `apps/web/src/components/ConversationPane.tsx`
- `docs/agent_docs/commit_dossier.json`
- `docs/agent_docs/commit_dossier.md`
- `docs/agent_docs/doc_status.json`
- `docs/agent_docs/running_tests.md`
- `docs/architecture.md`
- `docs/fileindex.md`

## Commits Since Docs Baseline

### eee56ef Improve agent documentation navigation

- Date: `2026-07-05T04:37:04-04:00`
- Author: `bryanlan`
- Files:
  - `M` `AGENTS.md`
  - `M` `docs/agent_docs/commit_dossier.json`
  - `M` `docs/agent_docs/commit_dossier.md`
  - `M` `docs/agent_docs/doc_status.json`
  - `M` `docs/agent_docs/running_tests.md`
  - `M` `docs/architecture.md`
  - `M` `docs/fileindex.md`

### 802e111 Fix duplicate sessions and repaint noise

- Date: `2026-07-05T15:49:30-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/db/repos/bound-sessions.ts`
  - `M` `apps/server/src/db/repos/conversation-index.ts`
  - `M` `apps/server/src/db/repos/search-index.ts`
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `M` `apps/server/src/sessions/live-output/filters.ts`
  - `M` `apps/server/test/database.test.ts`
  - `M` `apps/server/test/live-output.test.ts`

### ba1a44d Filter Codex repaint chatter from live output

- Date: `2026-07-05T16:30:29-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/live-output/filters.ts`
  - `M` `apps/server/test/live-output.test.ts`

### c5bd13d Show live provider progress in conversation pane

- Date: `2026-07-05T17:27:35-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.test.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### 10d9977 Fix pending transcript adoption for long Codex chats

- Date: `2026-07-05T17:41:49-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/providers/codex-provider.ts`
  - `M` `apps/server/src/providers/file-utils.ts`
  - `M` `apps/server/src/providers/transcripts/base.ts`
  - `M` `apps/server/src/providers/types.ts`
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/sessions/pending-adoption.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/indexing.test.ts`

### 7cc30cb Harden session timing tests

- Date: `2026-07-05T18:09:09-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/test/session-recency.test.ts`
  - `M` `apps/server/test/session-runtime.test.ts`

### 6c0c76e Allow binding provider-readable unindexed conversations

- Date: `2026-07-05T18:31:15-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
