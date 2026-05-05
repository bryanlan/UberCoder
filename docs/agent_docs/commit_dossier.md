# Commit Dossier

- Repository: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console`
- Generated at: `2026-05-05T04:41:38+00:00`
- Repo HEAD: `f20fe3941ffd6b488366c2c875fd055774993af7` (2026-05-02T09:56:19-07:00)
- Worktree dirty: `true`
- Docs current through: `1c87c2d00464940608ec9e83b2d1b13be560f9ab`
- Docs current through date: `2026-03-18T08:41:07-07:00`

## Changed Paths Since Docs Baseline

- `apps/server/src/app.ts`
- `apps/server/src/config/schema.ts`
- `apps/server/src/config/service.ts`
- `apps/server/src/db/database.ts`
- `apps/server/src/indexing/indexing-service.ts`
- `apps/server/src/projects/project-service.ts`
- `apps/server/src/providers/transcripts/base.ts`
- `apps/server/src/providers/transcripts/claude.ts`
- `apps/server/src/routes/conversations.ts`
- `apps/server/src/routes/projects.ts`
- `apps/server/src/routes/sessions.ts`
- `apps/server/src/routes/settings.ts`
- `apps/server/src/sessions/session-manager.ts`
- `apps/server/src/sessions/session-screen.ts`
- `apps/server/src/sessions/tmux-client.ts`
- `apps/server/test/command-and-proxy.test.ts`
- `apps/server/test/config.test.ts`
- `apps/server/test/conversation-routes.test.ts`
- `apps/server/test/indexing-service.test.ts`
- `apps/server/test/indexing.test.ts`
- `apps/server/test/projects-routes.test.ts`
- `apps/server/test/projects.test.ts`
- `apps/server/test/providers.test.ts`
- `apps/server/test/session-manager.test.ts`
- `apps/server/test/session-screen.test.ts`
- `apps/server/test/settings.test.ts`
- `apps/web/e2e/settings.spec.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/components/ConversationPane.tsx`
- `apps/web/src/components/DirectoryPickerModal.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/features/conversation/useConversationDataController.ts`
- `apps/web/src/features/conversation/useConversationScrollController.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/clipboard.ts`
- `apps/web/src/pages/SettingsPage.tsx`
- `docs/agent_docs/commit_dossier.json`
- `docs/agent_docs/commit_dossier.md`
- `docs/agent_docs/doc_status.json`
- `docs/agent_docs/running_tests.md`
- `docs/architecture.md`
- `docs/fileindex.md`
- `packages/shared/src/index.ts`
- `test-results/.last-run.json`
- `test-results/settings-settings-project--14b08-of-the-console-after-reload/error-context.md`
- `test-results/settings-settings-project--176c0-history-in-the-console-tree/error-context.md`
- `test-results/settings-settings-project--ec38b-he-old-auto-discovery-model/error-context.md`

## Commits Since Docs Baseline

### 93d10cb docs: sync repo docs

- Date: `2026-03-21T20:07:13-07:00`
- Author: `bryanlan`
- Files:
  - `A` `docs/agent_docs/commit_dossier.json`
  - `A` `docs/agent_docs/commit_dossier.md`
  - `A` `docs/agent_docs/doc_status.json`
  - `A` `docs/agent_docs/running_tests.md`
  - `M` `docs/architecture.md`
  - `A` `docs/fileindex.md`

### 27ea242 chore: checkpoint local changes

- Date: `2026-03-21T21:14:32-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `apps/web/src/components/Sidebar.tsx`
  - `A` `apps/web/src/lib/clipboard.ts`
  - `A` `test-results/.last-run.json`
  - `A` `test-results/settings-settings-project--14b08-of-the-console-after-reload/error-context.md`
  - `A` `test-results/settings-settings-project--176c0-history-in-the-console-tree/error-context.md`
  - `A` `test-results/settings-settings-project--ec38b-he-old-auto-discovery-model/error-context.md`

### 786d858 web: refine mobile live bridge chrome

- Date: `2026-03-26T11:51:29-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### c231e86 bridge: keep scroll position and clear submitted input

- Date: `2026-03-28T13:19:46-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/src/sessions/tmux-client.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### 6bea219 web: restore mobile bind access

- Date: `2026-04-02T12:58:57-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.tsx`

### b1640f0 web: extend chrome hiders to desktop

- Date: `2026-04-03T09:10:42-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### ed1f8f6 settings: support markerless projects

- Date: `2026-04-04T08:41:25-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/config/schema.ts`
  - `M` `apps/server/src/config/service.ts`
  - `M` `apps/server/src/routes/settings.ts`
  - `M` `apps/server/test/command-and-proxy.test.ts`
  - `M` `apps/server/test/config.test.ts`
  - `M` `apps/server/test/indexing-service.test.ts`
  - `M` `apps/server/test/indexing.test.ts`
  - `M` `apps/server/test/providers.test.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/server/test/settings.test.ts`
  - `M` `apps/web/e2e/settings.spec.ts`
  - `M` `apps/web/src/components/DirectoryPickerModal.tsx`
  - `M` `apps/web/src/lib/api.ts`
  - `M` `apps/web/src/pages/SettingsPage.tsx`
  - `M` `packages/shared/src/index.ts`

### 8885a87 sessions: keep live bridge controls for new sessions

- Date: `2026-04-04T13:53:47-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### 205a111 server: persist and restore bound sessions

- Date: `2026-04-05T09:13:28-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/app.ts`
  - `M` `apps/server/src/db/database.ts`
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/src/sessions/session-screen.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `packages/shared/src/index.ts`

### 2617758 server: fix Claude live paste detection

- Date: `2026-04-05T09:16:51-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-screen.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/server/test/session-screen.test.ts`

### 970a10a server: harden bound session restore edge cases

- Date: `2026-04-05T09:35:18-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/src/sessions/session-screen.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/server/test/session-screen.test.ts`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `packages/shared/src/index.ts`

### 2fb7c7d server: fix model extraction from footer status lines

- Date: `2026-04-05T09:51:03-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-screen.ts`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### 3ecc9b0 server: show model name in Claude session status

- Date: `2026-04-05T10:32:03-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/providers/transcripts/base.ts`
  - `M` `apps/server/src/providers/transcripts/claude.ts`
  - `M` `apps/server/src/sessions/session-screen.ts`
  - `M` `apps/server/test/session-screen.test.ts`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `packages/shared/src/index.ts`

### 2a74684 console: restore deep history loading

- Date: `2026-04-16T07:29:05-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/routes/conversations.ts`
  - `M` `apps/server/src/routes/sessions.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `apps/web/src/lib/api.ts`
  - `M` `packages/shared/src/index.ts`

### 06d556e console: refactor conversation scroll ownership

- Date: `2026-04-16T17:52:33-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `A` `apps/web/src/features/conversation/useConversationDataController.ts`
  - `A` `apps/web/src/features/conversation/useConversationScrollController.ts`

### c988eb8 server: stop staging live bridge prompts

- Date: `2026-04-16T21:25:00-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/session-manager.test.ts`

### 3b5b36f bridge: reduce live bypass input lag

- Date: `2026-04-19T08:25:14-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### ba98517 bridge: fix selection and claude model parsing

- Date: `2026-04-19T08:27:56-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-screen.ts`
  - `M` `apps/server/test/session-screen.test.ts`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### 7d2786a screen: handle claude numbered choice menus

- Date: `2026-04-19T11:00:42-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-screen.ts`
  - `M` `apps/server/test/session-screen.test.ts`

### 662beba bridge: restore live input resize

- Date: `2026-04-19T11:01:09-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.tsx`

### e603ac0 session: harden recency repair and bridge resize

- Date: `2026-04-19T12:35:40-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `apps/web/src/features/conversation/useConversationScrollController.ts`

### ef79cde server: isolate explicit nested project history

- Date: `2026-04-21T09:09:32-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/projects/project-service.ts`
  - `M` `apps/server/test/projects.test.ts`
  - `M` `apps/server/test/providers.test.ts`

### f116c84 agent-console: lazy restore sessions

- Date: `2026-04-25T19:37:20-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/app.ts`
  - `M` `apps/server/src/indexing/indexing-service.ts`
  - `M` `apps/server/src/routes/projects.ts`
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `M` `apps/server/test/indexing-service.test.ts`
  - `M` `apps/server/test/projects-routes.test.ts`
  - `M` `apps/server/test/session-manager.test.ts`
  - `M` `apps/web/src/App.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### f20fe39 web: stabilize text selection and bypass toggle

- Date: `2026-05-02T09:56:19-07:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/web/src/components/ConversationPane.tsx`
  - `M` `apps/web/src/features/conversation/useConversationScrollController.ts`
