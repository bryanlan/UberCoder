# AGENTS.md

This repo is an npm workspace for a local, server-first Codex/Claude Agent Console with a Fastify backend, React PWA, shared contracts, and tmux-backed live sessions.

## Quick Rules
- Treat the backend as authoritative for project, conversation, session, proxy, auth, and config state; the frontend must not become a raw terminal controller.
- Keep projects explicit and config-backed. Do not reintroduce implicit immediate-child project discovery.
- Preserve the one-conversation-to-one-hidden-tmux-session model for live sessions.
- Keep localhost proxy access authenticated and allowlisted per project/port.
- Never commit real secrets or local runtime config; use `config/agent-console.example.json` as the template.

## Build / Test / Verify
- Install: `npm install`
- Dev: `npm run dev`
- Test: `npm test`
- Verify: `npm run typecheck && npm run build`
- E2E: `npm test:e2e`

## Repo Map
- `apps/server/` — Fastify backend, provider adapters, SQLite cache, routes, proxy, auth, indexing, and tmux session management.
- `apps/web/` — React/Vite PWA for projects, conversations, settings, login, and live session display.
- `packages/shared/` — shared TypeScript contracts used by server and web.
- `config/` — example runtime configuration and project/proxy/auth settings shape.
- `scripts/` — password-hash generation and host-level Codex smoke validation helpers.
- `docs/` — managed architecture, file index, test guidance, and design notes.

## Repo-Specific Guardrails
- Provider transcript parsing belongs behind the Codex/Claude adapter interfaces; avoid leaking vendor history formats into routes or UI code.
- Root workspace scripts build `packages/shared/` first; prefer root `npm` commands unless you intentionally need a package-local target.
- Browser e2e artifacts under `test-results/` can be stale; rerun Playwright before treating them as current failures.
- The Codex smoke test is stateful and needs a running backend plus real Codex/tmux access; keep it opt-in.
- Call out config schema, auth, proxy, session lifecycle, or localhost exposure changes explicitly in handoffs.

## Additional References
- `docs/architecture.md` — backend-owned model, data flow, session lifecycle, and proxy boundary.
- `docs/fileindex.md` — key files, directories, and change hotspots.
- `docs/agent_docs/running_tests.md` — current test commands, host prerequisites, and e2e caveats.
- `config/agent-console.example.json` — runtime config template for projects, proxy allowlists, auth, and providers.
