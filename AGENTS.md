# Repository Guidelines

## Project Structure & Module Organization
`agent-console` is an npm workspace monorepo. `apps/server/src` contains the Fastify backend, provider adapters, tmux/session management, auth, and proxy logic; backend tests and fixtures live in `apps/server/test`. `apps/web/src` holds the React PWA, with static assets in `apps/web/public` and shared styles in `apps/web/src/styles`. Put cross-app types in `packages/shared/src`. Keep example config in `config/`, architecture notes in `docs/`, and utility scripts such as `scripts/generate-password-hash.mjs` at the repo root.

## Build, Test, and Development Commands
Run `npm install` once at the root. Use `npm run dev` to start the server watcher and Vite frontend together. `npm run build` compiles `shared`, `server`, and `web` in workspace order. `npm run test` runs the server Vitest suite. `npm run typecheck` validates all TypeScript projects without emitting files. Use `npm run start -w @agent-console/server` to run the built backend, and `npm run auth:hash -- 'strong-password'` when preparing local config secrets.

## Coding Style & Naming Conventions
The repo uses strict TypeScript with ESM modules. Follow the existing style: 2-space indentation, semicolons, single quotes, and named exports where practical. Use `PascalCase` for React components and page files (`LoginPage.tsx`), and descriptive kebab-case for backend modules (`project-service.ts`, `localhost-proxy.ts`). Keep shared contracts in `packages/shared` instead of duplicating types. There is no dedicated lint/format step in this snapshot, so match surrounding code and rely on `npm run typecheck` before submitting.

## Testing Guidelines
Backend tests use Vitest, with HTTP coverage supported by Supertest. Name tests `*.test.ts` and place them in `apps/server/test`. Reuse or extend `apps/server/test/fixtures` for provider-history scenarios instead of embedding large inline samples. Changes to config parsing, routing, auth, proxy rules, or session lifecycle should include or update tests. Frontend changes do not currently have an automated suite here, so note manual verification steps in the PR.

## Commit & Pull Request Guidelines
Git history is not available in this workspace snapshot, so use short, imperative commit subjects and scope them when helpful, for example `server: harden proxy allowlist`. Keep PRs focused, describe behavior changes, list verification commands run, and include screenshots for UI updates. Call out any config schema changes, auth impacts, or proxy/security-sensitive behavior explicitly, and never commit real secrets from `config.json`.
