# Commit Dossier

- Repository: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console`
- Generated at: `2026-05-25T02:00:37+00:00`
- Repo HEAD: `55170a6163e7a99c0afb2adb40c27ef363699205` (2026-05-24T08:16:21-07:00)
- Worktree dirty: `true`
- Docs current through: `542274559fe10f99377395c543a3d1d8518d55aa`
- Docs current through date: `2026-05-18T02:16:20-07:00`

## Changed Paths Since Docs Baseline

- `apps/server/src/indexing/indexing-service.ts`
- `apps/server/src/lib/pending-conversation-match.ts`
- `apps/server/src/routes/conversations.ts`
- `apps/server/src/routes/sessions.ts`
- `apps/server/src/routes/settings.ts`
- `apps/server/src/sessions/session-manager.ts`
- `apps/server/test/conversation-routes.test.ts`
- `apps/server/test/indexing-service.test.ts`
- `apps/server/test/session-manager.test.ts`
- `apps/server/test/settings.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/components/ConversationPane.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/features/conversation/useConversationDataController.ts`
- `apps/web/src/pages/SettingsPage.tsx`
- `docs/agent_docs/commit_dossier.json`
- `docs/agent_docs/commit_dossier.md`
- `docs/agent_docs/doc_status.json`
- `docs/agent_docs/running_tests.md`
- `docs/architecture.md`
- `docs/fileindex.md`
- `packages/shared/src/index.ts`

## Commits Since Docs Baseline

### d95ac9a Sync repo docs

- Date: `2026-05-21T02:27:15-07:00`
- Author: `bryanlan`
- Files:
  - `M` `docs/agent_docs/commit_dossier.json`
  - `M` `docs/agent_docs/commit_dossier.md`
  - `M` `docs/agent_docs/doc_status.json`
  - `M` `docs/agent_docs/running_tests.md`
  - `M` `docs/architecture.md`
  - `M` `docs/fileindex.md`

### bc28285 web: reduce text bypass render latency

- Date: `2026-05-23T07:28:58-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.tsx`

### ca6b8ca web/server: reduce text bypass latency

- Date: `2026-05-23T11:42:54-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/routes/sessions.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `packages/shared/src/index.ts`

### 90888c1 server/web: fix session recency tracking

- Date: `2026-05-23T20:02:15-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `A` `apps/server/src/lib/pending-conversation-match.ts`
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/routes/sessions.ts`
  - `M` `apps/server/src/routes/settings.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/indexing-service.test.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/server/test/settings.test.ts`
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/Sidebar.tsx`
  - `M` `apps/web/src/pages/SettingsPage.tsx`
  - `M` `packages/shared/src/index.ts`

### cad4ab6 server: ignore restore noise for session recency

- Date: `2026-05-23T20:33:46-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/session-manager.test.ts`

### 55170a6 Fix live output refresh latency

- Date: `2026-05-24T08:16:21-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `apps/web/src/features/conversation/useConversationDataController.ts`
