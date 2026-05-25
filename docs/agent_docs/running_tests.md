---
doc_type: running_tests
managed_by: sync-repo-docs
current_through_commit: 245086a325e22f429bfabe9999e0f212510272db
current_through_date: 2026-05-25T02:03:14-07:00
---

# Running Tests
## Primary Commands
- `npm run test`
- `npm run typecheck`
- `npm run build`
- `npx playwright test`

## Targeted Test Patterns
- `npx playwright test tests/<file>.spec.ts`

## Environment and Fixtures
- Install dependencies using the package manager or Python environment described by the current manifests before running tests.
- Check `.env.example`, `env.example`, README setup sections, and local service requirements before running integration checks.
- Prefer focused unit or build checks when broad tests require external services.

## Edge Cases
- Treat deploy, restore, migration, promotion, scheduler, and production data commands as operational workflows, not tests.
- If a broad test command needs live credentials, databases, browsers, or sibling services, document that dependency and run the smallest safe check available.

## Known Gaps
- Commands in this file are derived from current manifests and tracked tests; if a repo-specific guide documents a stricter check, prefer the guide.
