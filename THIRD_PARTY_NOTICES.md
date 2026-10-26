# Third-party notices

## T3 Code

Parts of the Codex app-server plugin and its tests are copied or ported from T3 Code
(https://github.com/pingdotgg/t3code, tag v0.1.2, commit 044f0725), which is licensed under the MIT License.

    MIT License

    Copyright (c) 2026 T3 Tools Inc.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

### Copied or ported source files

Each of these files carries the T3 copyright and license notice in its header and names the T3 file and
lines it came from.

| File here | T3 source | What was taken |
|---|---|---|
| `apps/server/src/providers/transport/codex/errors.ts` | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` lines 1087-1150 | `parseCodexRetryProgress`, `codexErrorInfoCode`, `codexExhaustionHttpStatus`, `codexUsageLimitError`, copied and made independent of Effect. |
| `apps/server/src/providers/transport/codex/redact.ts` | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` lines 1473-1545 | `redactCodexProtocolValue`, `isSensitiveCodexProtocolKey`, copied. T3's value-bounding helper is replaced by a local one. |
| `apps/server/src/providers/transport/codex/usage.ts` | `apps/server/src/provider/codexUsageLimits.ts`, `apps/server/src/provider/CodexTurnTokenUsage.ts`, `CodexAdapterV2.ts` lines 195-207 | Rate-limit window parsing, partial merge and reset time; per-turn token usage; context fill. `Date` replaces Effect `DateTime`. |
| `apps/server/src/providers/transport/codex/jsonrpc.ts` | `packages/effect-codex-app-server/src/protocol.ts` | Ported pattern, not copied text: line splitter with a byte cap, pending-request table, routing by message shape. |
| `apps/server/test/helpers/replay-app-server.mjs` | `packages/effect-codex-app-server/src/replay.ts` | Ported semantics (`expect_outbound`, `emit_inbound` with `afterMs`, `runtime_exit`), not copied text. |

The behaviours that `app-server-session.ts` and `app-server-instance.ts` implement (turn adoption before
the `turn/start` response, interrupt and steer races, background-terminal termination, resume of archived
threads, the initialize handshake) follow patterns found in T3's `CodexAdapterV2.ts`. They are written
independently in plain TypeScript.

### Copied test data

`apps/server/test/helpers/codex-fixtures/<scenario>/codex_transcript.ndjson`, recorded by T3 Code against
`codex-cli` 0.156.1, copied unchanged from
`apps/server/src/orchestration-v2/testkit/fixtures/<scenario>/codex_transcript.ndjson`:

- `simple`
- `multi_turn`
- `message_steering`
- `queued_turn`
- `turn_interrupt`
- `turn_interrupt_mid_tool`
- `provider_thread_resume`
- `command_output_streaming`
- `plan_questions`

The directory also holds a `README.md` with the same notice.
