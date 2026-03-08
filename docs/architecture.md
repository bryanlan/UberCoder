# Agent Console architecture

## Product shape

Agent Console is a server-first control plane for a **single user** running on an Ubuntu/Linux host. The browser/PWA is intentionally thin. It does not own state and it never drives terminal windows directly. The backend is the source of truth for:

- active projects
- parsed Codex / Claude conversation history
- bound session metadata
- authenticated access
- per-project localhost proxy allowlists

The primary navigation model is fixed to:

`project -> provider -> conversation history`

No issue queue, worktree orchestration, or general shell multiplexing abstraction is baked into the product model.

## System topology

```text
Browser / PWA
   |
   | HTTPS / HTTP + SSE
   v
Fastify backend
   |-- AuthService (single-user cookie auth, optional Tailscale bootstrap)
   |-- ProjectService (immediate child folder discovery)
   |-- IndexingService (background history discovery + cache)
   |-- ProviderRegistry
   |     |-- CodexProvider
   |     `-- ClaudeProvider
   |-- SessionManager
   |     `-- tmux hidden detached sessions
   |-- LocalhostProxyService (/proxy/:projectSlug/:port/*)
   `-- SQLite (metadata/cache/session state)

Local vendor state on disk
   |-- ~/.codex/sessions/...
   |-- ~/.codex/history.jsonl
   |-- ~/.claude/projects/<encoded-path>/...
   `-- ~/.claude/history.jsonl (best effort)
```

## Why this shape

### Backend owns truth

The frontend only renders backend-owned state and submits intent. For bound sessions, that means a parsed live screen model (`output + status`) rather than direct terminal control. This keeps phone, laptop, refreshes, and reconnects consistent.

### tmux is a runtime primitive, not a UI primitive

Each bound live conversation maps to exactly one hidden tmux session. The user never manipulates terminal windows as part of the product interaction loop.

### History-first, live-second transcript strategy

1. **Primary history / replay source:** provider transcript/session files on disk.
2. **Secondary live source:** tmux raw output capture.

This avoids modeling the product around ANSI-frame scraping while still keeping live sessions responsive.

## Core components

### ConfigService

Loads one JSON config file, validates it with zod, expands home-directory paths, and deep-merges provider overrides predictably.

### ProjectService

Scans exactly one configured parent directory and only treats immediate children as projects. Only directories marked `active: true` in config are surfaced.

### Provider adapters

Provider-specific parsing stays isolated behind a uniform interface:

- `discoverLocalState()`
- `listConversations()`
- `getConversation()`
- `getLaunchCommand()`

The adapters are intentionally defensive. If a vendor transcript schema shifts, the UI degrades to partial summaries rather than hard-failing the entire app.

### IndexingService

Builds and refreshes the cached conversation index in SQLite. It watches configured roots with chokidar and emits SSE invalidation events for the thin client.

### SessionManager

Responsible for the runtime lifecycle of bound sessions:

- deterministic tmux session naming
- create detached tmux session in project cwd
- pipe pane output to a runtime log
- capture the current tmux screen and project it into a simplified live session surface
- append live event JSONL for UI replay after refresh
- send input to tmux
- terminate cleanly on release

### LocalhostProxyService

Implements the remote debugging tunnel for project-local web apps.

Only ports explicitly listed in the project config are proxied. The backend never exposes arbitrary localhost or general shell access.

## Persistence model

SQLite stores app-owned metadata only:

- cached conversation index
- bound session metadata
- auth sessions
- pending new-conversation placeholders
- future UI prefs / title overrides

Full provider transcripts remain on disk under vendor-owned locations.

## Security model

### Defaults

- listen on localhost or a Tailscale-served endpoint by default
- single-user cookie auth
- rate-limited password login
- httpOnly cookie session
- SameSite=Strict cookies
- CSRF header for mutating API routes
- optional Tailscale identity bootstrap into a normal cookie session

### Non-goals

- no multi-user RBAC
- no arbitrary shell exposure
- no public unauthenticated internet mode

## Request flows

### Existing conversation bind

1. User selects project/provider/conversation.
2. Backend resolves merged provider command template.
3. SessionManager starts hidden tmux session in the project directory.
4. Provider CLI resumes by conversation ID.
5. UI shows bound state + green dot.
6. Timeline merges disk history and live event output.

### New conversation bind

1. User clicks **New conversation** under a provider.
2. Backend creates a pending conversation placeholder.
3. SessionManager launches a new hidden tmux session with the provider’s new command.
4. UI navigates to the pending node immediately.
5. When the vendor writes history to disk, it appears in the provider tree on refresh/background reindex.

### Remote localhost debugging

1. UI renders per-project proxy badges from config.
2. User opens `/proxy/:projectSlug/:port/`.
3. Backend authenticates the request.
4. Backend verifies the requested port is allowlisted for that project.
5. Request is proxied to `127.0.0.1:<port>` with websocket upgrades supported.

## Degraded-mode behavior

The vendor adapters intentionally accept that on-disk schemas can move.

When parsing becomes ambiguous:

- the conversation still appears if enough metadata is available
- titles fall back to the first user prompt or filename
- transcript messages may be partial
- the UI marks the conversation as degraded rather than failing globally

## Deliberate v1 exclusions

- exact terminal/TUI mirroring
- issue/worktree/task-centered abstractions
- full text search across all conversations
- multi-user collaboration
- arbitrary terminal multiplexing unrelated to Codex/Claude
- cloud-hosted backend
