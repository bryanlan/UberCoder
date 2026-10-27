# Probe: where codex-cli 0.164.0 lists a running command (2026-10-27)

Why: the round-2 fix for "Stop after a backend restart leaves the adopted turn's command running" read the turn's items
(`thread/items/list`) to find in-progress `commandExecution` items. The real-provider proof on `59fde29` failed step k2
(the command was still running 5 s after Stop), so a direct probe asked the app-server what it returns while a command runs.

Method: `codex app-server` (0.164.0, `experimentalApi: true`, MCP servers disabled with `-c mcp_servers.<name>.enabled=false`),
one `thread/start` (approval `never`, sandbox `danger-full-access`), one `turn/start` asking for
`echo <marker>; for i in $(seq 1 90); do echo $i; sleep 1; done`, then, once `item/started` for the command arrived and the
shell was visible in `pgrep`, four listings, `turn/interrupt`, the same four listings, and `thread/backgroundTerminals/terminate`.

Verified:

- `item/started` for the command: `{"type":"commandExecution","id":"exec-…","processId":"89488","source":"unifiedExecStartup","status":"inProgress", …}`.
- `thread/items/list {threadId, turnId, limit: 50, sortDirection: 'desc'}` and `thread/items/list {threadId, limit: 50}` returned
  only completed items (the `userMessage` and a commentary `agentMessage`). The running `commandExecution` was absent, both
  while it ran and after the interrupt. The listing is not a source of in-progress commands on this version.
- `thread/backgroundTerminals/list {threadId}` returned the running command while it ran:
  `{"data":[{"itemId":"exec-…","processId":"89488","command":"echo …","cwd":"…","osPid":null,"cpuPercent":null,"rssKb":null}],"nextCursor":null}`,
  for an ordinary foreground command, not only a backgrounded one. It still listed it after `turn/interrupt`: the interrupt
  ended the turn (`turn/completed` with `status: "interrupted"`) and left the shell running.
- `thread/backgroundTerminals/terminate {threadId, processId: "89488"}` returned `{"terminated": true}`; the shell was gone
  within 1.5 s and Codex emitted `item/completed` for the command with `status: "failed"`.
- `thread/turns/list` showed the turn `inProgress` with `itemsView: "summary"` and only the `userMessage` in `items`.

Consequence: an adopted turn must take its running commands from `thread/backgroundTerminals/list` (item id → process id).
The item listing stays a secondary source for a version that lists in-progress items.

Also seen: `-c mcp_servers.<name>.enabled=false` is accepted and keeps that server from starting; `features.skills` in
`~/.codex/config.toml` is reported as an unrecognized setting by 0.164.0 (a warning, not an error).
