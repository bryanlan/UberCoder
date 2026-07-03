# Commit Dossier

- Repository: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console`
- Generated at: `2026-07-03T04:52:42+00:00`
- Repo HEAD: `146bfe4862378e8b96e3c1c5485c594c2c5eae2c` (2026-07-02T12:31:45-04:00)
- Worktree dirty: `true`
- Docs current through: `25559bbced6c7fe785af3f64fe16004e681a62fd`
- Docs current through date: `2026-07-01T21:15:13-04:00`

## Changed Paths Since Docs Baseline

- `AGENTS.md`
- `apps/server/src/sessions/output-watcher.ts`
- `apps/server/src/sessions/session-manager.ts`
- `apps/server/src/sessions/timeline-merge.ts`
- `apps/server/src/sessions/transcript-watcher.ts`
- `apps/server/test/conversation-routes.test.ts`
- `apps/server/test/output-watcher.test.ts`
- `apps/server/test/timeline-merge.test.ts`
- `apps/server/test/transcript-watcher.test.ts`
- `apps/web/src/components/ConversationPane.test.tsx`
- `apps/web/src/components/ConversationPane.tsx`
- `apps/web/src/features/conversation/useConversationData.ts`
- `apps/web/src/features/realtime/apply-session-event.test.ts`
- `apps/web/src/features/realtime/apply-session-event.ts`
- `docs/agent_docs/agents_md_status.json`
- `docs/agent_docs/commit_dossier.json`
- `docs/agent_docs/commit_dossier.md`
- `docs/agent_docs/doc_status.json`
- `docs/agent_docs/running_tests.md`
- `docs/architecture.md`
- `docs/fileindex.md`
- `packages/shared/src/index.ts`

## Commits Since Docs Baseline

### 2e726c3 Sync repo docs

- Date: `2026-07-02T00:31:58-04:00`
- Author: `bryanlan`
- Files:
  - `M` `docs/agent_docs/commit_dossier.json`
  - `M` `docs/agent_docs/commit_dossier.md`
  - `M` `docs/agent_docs/doc_status.json`
  - `M` `docs/agent_docs/running_tests.md`
  - `M` `docs/architecture.md`
  - `M` `docs/fileindex.md`

### e16cdd2 Refresh AGENTS.md

- Date: `2026-07-02T03:33:36-04:00`
- Author: `bryanlan`
- Files:
  - `M` `AGENTS.md`
  - `M` `docs/agent_docs/agents_md_status.json`

### b0b7138 Poll raw output logs when watch events drop

- Date: `2026-07-02T07:35:48-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/output-watcher.ts`
  - `M` `apps/server/test/output-watcher.test.ts`

### c9dde57 Ensure live transcript updates refresh conversations

- Date: `2026-07-02T07:53:50-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/session-manager.ts`
  - `A` `apps/server/src/sessions/transcript-watcher.ts`
  - `A` `apps/server/test/transcript-watcher.test.ts`
  - `M` `apps/web/src/features/conversation/useConversationData.ts`
  - `A` `apps/web/src/features/realtime/apply-session-event.test.ts`
  - `M` `apps/web/src/features/realtime/apply-session-event.ts`
  - `M` `packages/shared/src/index.ts`

### e7d1051 Clear live bridge draft on submit

- Date: `2026-07-02T08:19:47-04:00`
- Author: `bryanlan`
- Files:
  - `A` `apps/web/src/components/ConversationPane.test.tsx`
  - `M` `apps/web/src/components/ConversationPane.tsx`

### 146bfe4 Keep raw terminal output out of transcript timelines

- Date: `2026-07-02T12:31:45-04:00`
- Author: `bryanlan`
- Files:
  - `M` `apps/server/src/sessions/timeline-merge.ts`
  - `M` `apps/server/test/conversation-routes.test.ts`
  - `M` `apps/server/test/timeline-merge.test.ts`
