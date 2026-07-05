# Commit Dossier

- Repository: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console`
- Generated at: `2026-07-05T08:35:44+00:00`
- Repo HEAD: `4ea81ed1b37d50a8d0f1d83c5f81b4db2b91dff1` (2026-07-05T00:30:34-04:00)
- Worktree dirty: `true`
- Docs current through: `6c49fd69971a255984fda8c0659aefaf2abff859`
- Docs current through date: `2026-07-03T14:36:17-04:00`

## Changed Paths Since Docs Baseline

- `apps/server/src/app.ts`
- `apps/server/src/indexing/indexing-service.ts`
- `apps/server/src/lib/provider-conversation-cache.ts`
- `apps/server/src/providers/transcripts/claude.ts`
- `apps/server/src/providers/transcripts/codex.ts`
- `apps/server/src/providers/transcripts/types.ts`
- `apps/server/src/routes/conversations.ts`
- `apps/server/src/routes/sessions.ts`
- `apps/server/src/sessions/session-manager.ts`
- `apps/server/src/sessions/tmux-client.ts`
- `apps/server/src/summaries/session-summary-service.ts`
- `apps/server/test/conversation-routes.test.ts`
- `apps/server/test/indexing-service.test.ts`
- `apps/server/test/search.test.ts`
- `apps/server/test/session-lifecycle.test.ts`
- `apps/server/test/session-routes.test.ts`
- `apps/server/test/session-summary-service.test.ts`
- `apps/server/test/tmux-health.test.ts`
- `apps/web/src/components/ConversationPane.test.tsx`
- `apps/web/src/components/ConversationPane.tsx`
- `apps/web/src/features/conversation/useConversationData.ts`
- `apps/web/src/features/realtime/apply-session-event.ts`
- `apps/web/src/lib/api.ts`
- `docs/agent_docs/commit_dossier.json`
- `docs/agent_docs/commit_dossier.md`
- `docs/agent_docs/doc_status.json`
- `docs/agent_docs/running_tests.md`
- `docs/architecture.md`
- `docs/fileindex.md`

## Commits Since Docs Baseline

### ecd56f2 Sync repo docs

- Date: `2026-07-04T01:24:32-04:00`
- Author: `bryanlan`
- Files:
  - `M` `docs/agent_docs/commit_dossier.json`
  - `M` `docs/agent_docs/commit_dossier.md`
  - `M` `docs/agent_docs/doc_status.json`
  - `M` `docs/agent_docs/running_tests.md`
  - `M` `docs/architecture.md`
  - `M` `docs/fileindex.md`

### 45cf9e1 Restore live session screen rendering

- Date: `2026-07-04T07:17:58-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.test.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `apps/web/src/features/conversation/useConversationData.ts`
  - `M` `apps/web/src/features/realtime/apply-session-event.ts`
  - `M` `apps/web/src/lib/api.ts`

### ef82e97 Stop trusting terminal input as transcript text

- Date: `2026-07-04T08:03:34-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.test.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### 7534831 Fix slow conversation switching hot paths

- Date: `2026-07-04T09:13:21-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `M` `apps/server/src/lib/provider-conversation-cache.ts`
  - `M` `apps/server/src/providers/transcripts/claude.ts`
  - `M` `apps/server/src/providers/transcripts/codex.ts`
  - `M` `apps/server/src/providers/transcripts/types.ts`
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/summaries/session-summary-service.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/indexing-service.test.ts`
  - `M` `apps/server/test/search.test.ts`
  - `M` `apps/server/test/session-summary-service.test.ts`

### 4ea81ed Autocommit: improve live session recovery handling

- Date: `2026-07-05T00:30:34-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/app.ts`
  - `M` `apps/server/src/routes/sessions.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/src/sessions/tmux-client.ts`
  - `M` `apps/server/test/session-lifecycle.test.ts`
  - `M` `apps/server/test/session-routes.test.ts`
  - `M` `apps/server/test/tmux-health.test.ts`
