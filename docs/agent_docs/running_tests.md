---
doc_type: running_tests
managed_by: sync-repo-docs
current_through_commit: 8eedf7118f5bd513ebdd2519e8fcbf4779df0c87
current_through_date: 2026-05-24T19:02:42-07:00
---

# Running Tests
## Primary Commands
- `npm run test`
- `npm run typecheck`
- `npm run build`

## Targeted Test Patterns
- Use the matching package script from `package.json` for focused Node/TypeScript checks where available.

## Environment and Fixtures
No committed environment example was detected. Avoid assuming live credentials or production services are available during tests.

## Edge Cases
- Treat deploy, restore, migration, promotion, and production data commands as operational workflows, not tests.
- If a broad test command needs external services, prefer a smaller unit or build check while documenting the missing dependency.

## Known Gaps
- Commands listed here were inferred from current manifests and tracked tests during the rollout; run them before relying on a change.
