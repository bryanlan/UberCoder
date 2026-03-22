---
doc_type: running_tests
managed_by: sync-repo-docs
current_through_commit: 1c87c2d00464940608ec9e83b2d1b13be560f9ab
current_through_date: 2026-03-18T08:41:07-07:00
---

# Running Tests

## Primary Commands

Observed during this sync:

- `npm run build` passed on March 21, 2026.
- `npm run typecheck` passed on March 21, 2026.
- `npm test` failed on March 21, 2026 with 1 failing Vitest case in `apps/server/test/session-screen.test.ts`.
- `npm run test:e2e -- apps/web/e2e/settings.spec.ts` failed on March 21, 2026 with 3 failing Playwright cases in `apps/web/e2e/settings.spec.ts`.

Install dependencies from the repo root:

```bash
npm install
```

Run the main backend test suite:

```bash
npm test
```

Run browser e2e coverage:

```bash
npm test:e2e
```

Useful development/build commands:

```bash
npm run dev
npm run build
npm run typecheck
```

## Targeted Test Patterns

- Run a specific backend Vitest file:

```bash
npm run test -w @agent-console/server -- session-manager.test.ts
npm run test -w @agent-console/server -- session-screen.test.ts
npm run test -w @agent-console/server -- settings.test.ts
npm run test -w @agent-console/server -- conversations.test.ts
```

- Run the Codex adoption smoke test against a running backend:

```bash
npm run smoke:codex -- --project <project-slug> --password '<login-password>'
```

- Run a specific Playwright spec:

```bash
npm run test:e2e -- apps/web/e2e/settings.spec.ts
```

## Environment and Fixtures

- Host prerequisites are listed in `requirements.txt`: Node.js, npm, tmux, git, Python 3, Codex CLI, and Claude Code.
- Create a runtime config from `config/agent-console.example.json` in the user's config directory before starting the backend.
- The backend tests use fixtures under `apps/server/test/fixtures/` to simulate Codex/Claude local transcript state.
- The Playwright suite starts its own backend via `npm exec --workspace @agent-console/server tsx apps/server/test/e2e/server.ts` and its own Vite dev server via `npm run dev -w @agent-console/web -- --host 127.0.0.1`.
- The Codex smoke test needs a running backend plus real host access to Codex/tmux and the configured project roots.

## Edge Cases

- Root commands depend on `packages/shared/` building first; the workspace scripts handle that, but ad hoc package-local commands may not.
- Many core behaviors depend on host filesystem layout and installed external CLIs, so a passing backend unit suite is not the same thing as a passing host integration environment.
- The Codex smoke test is intentionally stateful and slower than unit coverage because it validates real adoption and transcript persistence behavior.
- The current Vitest failure is specific to `parseSessionScreenSnapshot` handling trailing interactive picker output: the parser still surfaces picker text as `inputText` when the test expects that text to remain in main content only.
- The current Playwright failures are not generic boot failures. One test assumes there are no saved projects, but the live settings config already contains multiple explicit projects; the other two fail while clicking directory-picker buttons because overlapping UI elements intercept pointer events during the modal flow.
- Session and proxy behavior can fail for environment reasons such as missing tmux, bad allowlists, or incorrect project-root config even when the UI code is fine.

## Known Gaps

- The main automated suite is still server-heavy; there is Playwright coverage for settings flows, but there is no comparable dedicated web unit-test layer in the root scripts today.
- End-to-end validation still depends on real host tools and local vendor state rather than a fully hermetic integration harness.
- Current test docs do not yet describe a full CI bootstrap for Tailscale-authenticated remote access scenarios.
