---
doc_type: architecture
managed_by: sync-repo-docs
current_through_commit: 1c87c2d00464940608ec9e83b2d1b13be560f9ab
current_through_date: 2026-03-18T08:41:07-07:00
---

# Architecture

## System Overview

Agent Console is a server-first, single-user control plane for managing local Codex CLI and Claude Code sessions on a Linux host. The backend is authoritative: the React/PWA frontend renders project, conversation, and live-session state that the server derives from explicit project config, vendor history files, SQLite metadata, and hidden tmux sessions.

The product model is intentionally narrow:

- explicit saved projects under one configured `projectsRoot`
- provider-specific conversation indexing for Codex and Claude
- binding a selected conversation to one hidden detached tmux session
- secure per-project localhost proxying for local web apps

It is not a generic terminal multiplexer or worktree/task orchestration platform.

## Main Components

- `apps/server/` is the Fastify backend and contains config loading, SQLite persistence, explicit project management, provider adapters, routes, auth/security, proxying, indexing, restart handling, and tmux-backed session management.
- `apps/web/` is the React/Vite PWA that renders the project sidebar, conversation history, live session pane, settings, and login flows.
- `packages/shared/` holds shared types and contracts used by both the backend and frontend.
- `config/agent-console.example.json` is the canonical runtime config template that defines projects, proxy allowlists, auth settings, and provider-specific overrides.
- `scripts/` holds host-level helpers such as password-hash generation and the Codex adoption smoke test.
- `docs/` contains the managed architecture/file index/test docs and repo design notes.

## Data Flow

The common read path is:

1. `ConfigService` loads `~/.config/agent-console/config.json`, normalizes paths, and merges provider defaults plus per-project overrides.
2. `ProjectService` enumerates only configured `projects` entries marked active and resolves their concrete paths under or alongside `projectsRoot`.
3. Provider adapters inspect local vendor state on disk under Codex/Claude roots.
4. `IndexingService` normalizes conversations into a SQLite-backed cache and emits SSE invalidation events to the frontend.
5. The browser requests conversations, settings, project state, or live session updates through HTTP/SSE routes.

The settings/project-management path is:

1. The settings UI reads stored config and current UI preferences through `/api/settings` and `/api/settings/ui-preferences`.
2. The directory picker browses the filesystem under `projectsRoot`.
3. New explicit projects are only addable when the selected directory contains `AGENTS.md`, `agents.md`, `CLAUDE.md`, or `claude.md`.
4. Project edits persist immediately back into the config file, then trigger tree refreshes and, when needed, a controlled backend restart.

The live-session path is:

1. A user selects or creates a conversation under a provider.
2. `SessionManager` launches or resumes exactly one detached tmux session in the project directory.
3. Provider-specific launch commands resume Codex/Claude with merged environment overrides.
4. tmux pane output is captured to runtime logs, simplified into a backend-owned `content + input + status` model, and replayed to the UI.
5. User input is sent back through the backend into tmux rather than exposing a raw terminal surface to the browser.
6. The live screen parser and event log let the UI survive refreshes or reconnects without becoming a raw terminal emulator.

The proxy path is:

1. The client requests the per-project proxy route exposed by the backend.
2. The backend authenticates the request and checks the configured allowlist for that project.
3. Only approved localhost ports are proxied, including websocket upgrades.

## External Integrations

- Codex CLI local state under the configured Codex home directory
- Claude Code local state under the configured Claude home directory
- tmux for hidden detached session runtime
- SQLite via `better-sqlite3` for app-owned metadata/cache state
- chokidar for filesystem watching and refresh scheduling
- Tailscale identity headers/bootstrap for secure remote access, when configured

## Key Decisions

- The backend owns truth; the frontend is intentionally thin and never controls a raw terminal directly.
- Projects are explicit saved config entries rather than implicit immediate-child folders. This avoids accidental repo sprawl in the UI and makes nested repos first-class.
- Each bound conversation maps to one hidden detached tmux session, keeping mobile/desktop refresh behavior consistent without exposing host terminals.
- Provider transcript parsing is isolated behind adapter interfaces so Codex and Claude history schema changes degrade locally instead of breaking the whole app.
- History replay is preferred over terminal mirroring; tmux output is a live source, but the product surface is a simplified session model rather than a raw shell.
- The localhost proxy is explicitly allowlisted per project/port so remote debugging does not turn into arbitrary shell or network access.
- Global config writes can schedule a controlled self-restart through `RestartService` instead of requiring a separate supervisor flow.

## Operational Notes

- The intended host is Ubuntu/Linux with Node.js, npm, tmux, Codex CLI, and Claude Code installed.
- Runtime config lives outside the repo in the user's config directory, based on the example in `config/agent-console.example.json`.
- The root build/test scripts depend on building `packages/shared/` before server/web tasks.
- `npm run build` and `npm run typecheck` currently pass in the live tree.
- The highest-value host integration check is `scripts/smoke-codex-adoption.mjs`, which exercises real Codex session adoption, persistence, and tmux teardown behavior against a running backend.
- The current worktree is dirty: local web changes are in `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/ConversationPane.tsx`, and `apps/web/src/lib/clipboard.ts`, and those changes are part of the live tree these docs describe.
