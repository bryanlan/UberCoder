---
doc_type: architecture
managed_by: sync-repo-docs
current_through_commit: 8eedf7118f5bd513ebdd2519e8fcbf4779df0c87
current_through_date: 2026-05-24T19:02:42-07:00
---

# Architecture
## System Overview
agent-console is documented from the current repository tree. Agent Console; Agent Console is a production-leaning MVP for Ubuntu/Linux that lets one user manage local Codex CLI and Claude Code sessions across multiple project folders from a desktop browser; The backend runs on the Linux box and stays authoritative. The frontend is a thin React PWA that renders an abstracted live session surface instead of exposing tmux or Linux termin; What it does
The primary human overview is `README.md`; this managed doc is a navigation and architecture companion for agents.

## First-Class Runtime Surfaces
- Node/TypeScript project with package scripts: dev, build, test, test:e2e, typecheck, auth:hash, smoke:codex.
- Runtime or support surface under apps/.
- Runtime or support surface under scripts/.

## Main Components
- `apps/` is a top-level area present in the live tree; see `docs/fileindex.md` for navigation details.
- `config/` is a top-level area present in the live tree; see `docs/fileindex.md` for navigation details.
- `docs/` is a top-level area present in the live tree; see `docs/fileindex.md` for navigation details.
- `packages/` is a top-level area present in the live tree; see `docs/fileindex.md` for navigation details.
- `scripts/` is a top-level area present in the live tree; see `docs/fileindex.md` for navigation details.
- `test-results/` is a top-level area present in the live tree; see `docs/fileindex.md` for navigation details.
- JavaScript/TypeScript anchors include `apps/server/src/app.ts`, `apps/server/src/config/schema.ts`, `apps/server/src/config/service.ts`, `apps/server/src/db/database.ts`, `apps/server/src/index.ts`, `apps/server/src/indexing/indexing-service.ts`, `apps/server/src/lib/agent-console-path.ts`, `apps/server/src/lib/async.ts`.

## Data Flow
Start from the runtime surfaces above, then follow imports into the component directories. Treat generated outputs, caches, and reports as derived artifacts unless a repo-specific README says otherwise.

## External Integrations
No external integration can be asserted from filenames alone; verify provider clients in source before changing integration behavior.

## Key Decisions
- Managed docs are synchronized against the live tree and finalized to the current git `HEAD`; commit dossier files are context, not source of truth.
- Future agents should verify ownership in source files before preserving older compatibility paths or workaround behavior.

## Operational Notes
Use `docs/agent_docs/running_tests.md` for safe verification commands. Do not infer deploy, restore, or production-mutating workflows from test documentation.
