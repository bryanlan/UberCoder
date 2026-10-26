# Codex app-server wire fixtures

Recorded Codex app-server traffic used as test data by `test/structured-codex-plugin.test.ts`, played back by
`test/helpers/replay-app-server.mjs` so the real JSON-RPC client and plugin run against real wire shapes
without spending quota.

- Source: T3 Code (https://github.com/pingdotgg/t3code, tag v0.1.2),
  `apps/server/src/orchestration-v2/testkit/fixtures/<scenario>/codex_transcript.ndjson`.
- Recorded with `codex-cli` **0.156.1** (the installed CLI during the Agent Console work was 0.164.0).
- Copied unchanged: `simple`, `multi_turn`, `message_steering`, `queued_turn`, `turn_interrupt`,
  `turn_interrupt_mid_tool`, `provider_thread_resume`, `command_output_streaming`, `plan_questions`.
- Format: one JSON object per line. The first line is `transcript_start`; the rest are `expect_outbound`
  (what the client must send), `emit_inbound` (what the server sends, with optional `afterMs`) and
  `runtime_exit`. The outbound frames are T3 Code's, not this client's, so the replay peer matches them by
  method only.

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
