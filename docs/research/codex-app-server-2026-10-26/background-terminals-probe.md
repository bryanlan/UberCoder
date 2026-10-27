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

## Second probe (2026-10-27 03:46 UTC): a process an earlier turn left behind

Question: can an adopted turn tell its own running command from a background terminal an earlier turn left running?

Method: the same app-server setup; turn 1 asked the model to start `sh -c "echo <bg-marker>; sleep 600"` in the background
and reply at once; turn 2 ran the 90 s counting loop; the item list and the terminal list were read after turn 1, during
turn 2 and after `turn/interrupt` of turn 2.

Seen:

- The model ran turn 1's command as `/bin/bash -lc "nohup sh -c '…' > /tmp/… 2>&1 &"`. Its `commandExecution` item got
  `item/started` (`processId: "31245"`, `inProgress`) and then `item/completed` (`status: "completed"`) inside turn 1, and
  turn 1 completed. Right after that no process carrying the marker was alive: Codex ends the process group of a completed
  command, so a `nohup … &` child does not outlive its command.
- After turn 1, `thread/backgroundTerminals/list` was empty, and `thread/items/list` listed turn 1's command as a completed
  item with its `processId` and `turnId`.
- During turn 2 the terminal list held exactly one entry, turn 2's running command (`itemId`, `processId: "6340"`); the item
  list still did not contain it. After `turn/interrupt` the entry was still there and `terminate` ended it
  (`item/completed` with `status: "failed"`).

Consequence: an earlier turn can leave a process behind only as a Codex background terminal that is still in progress (a
long command the model did not wait for), and such a terminal carries no turn id and no timestamp, so the lists cannot
assign it to a turn. Console therefore records which turn started each command from the `item/started` frames it sees
(`turnId`, `processId`) and, at adoption, leaves the terminals recorded under another turn alone.
