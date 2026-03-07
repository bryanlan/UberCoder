# Agent Console

Agent Console is a production-leaning MVP for Ubuntu/Linux that lets one user manage **local Codex CLI and Claude Code sessions** across multiple project folders from a desktop browser or phone.

The backend runs on the Linux box and stays authoritative. The frontend is a thin React PWA that renders a normalized chat UI instead of mirroring terminal frames.

## What it does

- discovers active projects from one parent directory
- indexes Codex and Claude local histories into a project/provider/conversation tree
- binds a selected conversation to a hidden detached tmux session
- sends user input to the bound agent session without exposing terminal control directly
- merges parsed provider history with live session output in a normalized timeline
- exposes a collapsible raw-output/debug drawer
- securely reverse-proxies allowlisted project-local localhost apps, including websocket upgrades
- supports secure single-user remote access with cookie auth and optional Tailscale identity bootstrap

## Stack

### Backend

- Node.js + TypeScript
- Fastify
- SQLite (`better-sqlite3`)
- tmux CLI integration
- chokidar
- zod
- SSE for live updates

### Frontend

- React + TypeScript
- Vite
- Tailwind CSS
- TanStack Query
- React Router
- PWA manifest / service worker registration

## Repository layout

```text
apps/
  server/   Fastify backend, providers, tmux session manager, proxy, tests
  web/      React PWA frontend
packages/
  shared/   shared types between backend and frontend
config/
  agent-console.example.json
scripts/
  generate-password-hash.mjs
/docs/
  architecture.md
```

## Ubuntu setup

### 1. Install runtime dependencies

```bash
sudo apt update
sudo apt install -y tmux build-essential python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Install Codex CLI and Claude Code separately according to their vendor instructions.

### 2. Clone and install

```bash
git clone <your-fork-or-repo-url> agent-console
cd agent-console
npm install
```

### 3. Generate a password hash and session secret

```bash
npm run auth:hash -- 'your-strong-password'
```

Copy the emitted `passwordHash` and `sessionSecret` into your config.

### 4. Create config

```bash
mkdir -p ~/.config/agent-console
cp config/agent-console.example.json ~/.config/agent-console/config.json
$EDITOR ~/.config/agent-console/config.json
```

Key things to change:

- `projectsRoot`
- `server.webDistPath` (usually set this to an absolute path on the host)
- `tailscaleAllowedUserLogin`
- `passwordHash`
- `sessionSecret`
- `security.cookieSecure` (`true` when you are fronting the app with HTTPS, such as Tailscale Serve)
- per-project `active` flags and `allowedLocalhostPorts`

### 5. Build

```bash
npm run build
```

### 6. Run

```bash
npm run start -w @agent-console/server
```

Open the configured host/port in your browser.

## Development

Run backend and frontend together:

```bash
npm run dev
```

Frontend Vite dev server proxies `/api` and `/proxy` back to the backend.

## Codex E2E smoke test

The highest-value host-level E2E check is the **Codex adoption flow**:

- Agent Console creates a **hidden detached tmux session** for a new Codex conversation
- your prompt is sent into that bound session
- Codex writes a real transcript under the configured local Codex sessions root
- the backend reconciles the temporary `pending:*` node to the real saved Codex conversation ref
- releasing the session tears down the tmux session cleanly

Run it against a running backend:

```bash
npm run smoke:codex -- --project <project-slug> --password '<login-password>'
```

Useful options:

```bash
npm run smoke:codex -- \
  --project demo-web \
  --password 'your-password' \
  --base-url http://127.0.0.1:4317 \
  --config ~/.config/agent-console/config.json \
  --timeout-ms 180000
```

This script proves the saved conversation lands under the expected Codex sessions root. It does **not** inspect GUI terminals, because the product model is a hidden tmux session on the Linux host rather than a visible local terminal window.

## Remote access model

The intended deployment path is **Tailscale first**.

### Tailnet-only access

Bind the backend to localhost and publish it privately through Tailscale Serve. A common pattern is to reverse-proxy your local backend port through a tailnet-only Serve endpoint; use the current `tailscale serve` syntax from Tailscale’s docs for your setup.

The backend also supports Tailscale identity headers. If `trustTailscaleHeaders` is enabled and `tailscaleAllowedUserLogin` matches the requester, the first `/api/auth/me` probe will bootstrap a normal cookie session.

### Public internet

This repo does **not** default to public internet exposure. If you later front it with a public tunnel, put real auth in front of it and use HTTPS.

## Reverse proxy model

Project-local web apps are reachable through:

```text
/proxy/:projectSlug/:port/*
```

The backend denies any port that is not explicitly listed in that project’s `allowedLocalhostPorts` config.

This is not a generic localhost gateway.

## Tests

Core tests cover:

- config parsing and config merge behavior
- project discovery
- provider history discovery
- command construction
- proxy allowlisting
- session state transitions

Run them with:

```bash
npm run test
```

## Provider assumptions and degraded mode

### Codex assumptions

- local state root is `$CODEX_HOME` or `~/.codex`
- session transcripts are primarily under `~/.codex/sessions/`
- resume commands are built from official `codex resume` patterns
- parsing is tolerant of JSONL layout differences and falls back to filename/title heuristics

### Claude assumptions

- local state root is `~/.claude`
- project transcripts are best-effort discovered under `~/.claude/projects/<encoded-path>/`
- `~/.claude/history.jsonl` is treated as a helpful but non-guaranteed index
- resume commands are built from official `claude --resume` / `claude --continue` patterns
- encoded path matching is intentionally loose because the layout is not a stable public API

### Degraded mode

If a transcript schema changes and the parser cannot fully normalize it:

- the conversation can still appear in the tree
- the title falls back to the first user prompt or filename
- message replay may be partial
- the UI marks the conversation as degraded instead of crashing

## Security notes

- single-user only
- httpOnly cookie session
- SameSite=Strict
- CSRF token required for mutating routes
- rate-limited login route
- optional Tailscale identity bootstrap
- no arbitrary shell API
- localhost proxy restricted per project and per port

## What is intentionally out of scope in v1

- exact recreation of Codex CLI or Claude Code TUIs
- issue/worktree/task queue abstractions
- multi-user collaboration
- arbitrary terminal multiplexing unrelated to Codex/Claude
- cloud-hosted backend
- full-text search across all transcripts

## Notes on validation in this environment

The repo is structured to be runnable with the declared dependencies and tests, but the actual Codex CLI / Claude Code binaries, tmux presence, and vendor-local state layouts still need to exist on the target Ubuntu host for end-to-end verification.
