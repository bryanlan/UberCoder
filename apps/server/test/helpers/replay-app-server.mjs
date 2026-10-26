#!/usr/bin/env node
// Replays a recorded Codex app-server wire transcript (T3 Code fixtures, codex 0.156.1) to a real client over
// stdio. Ported from the semantics of T3 Code's `packages/effect-codex-app-server/src/replay.ts` (MIT, see
// THIRD_PARTY_NOTICES.md):
//
//   expect_outbound   the client must send a matching frame next
//   emit_inbound      send a frame to the client (optionally after `afterMs`)
//   runtime_exit      end of this process (a transcript with several segments describes several launches)
//
//   node replay-app-server.mjs <codex_transcript.ndjson> <state-file> [ignored args]
//
// The state file counts launches: the Nth launch plays the Nth segment (segments end at `runtime_exit`).
//
// Differences from T3's replay, because this repository's client is not T3's client:
//   - Outbound frames are matched by kind and method only, not by their params. T3 and this client send
//     different `clientInfo`, thread config and turn settings. Tests assert on params through the log file.
//   - The numeric id of an outbound request is mapped onto the id the transcript used: inbound responses get
//     the client's actual id. Server-request ids (emit_inbound frames with a method) are kept.
//   - The client's answer to a server request matches on `id` and on being a result or an error; the answer
//     itself is not compared (the transcript holds a human's answer, this client declines).
//   - Requests listed in REPLAY_OPTIONAL_METHODS (comma separated) that the transcript does not expect at
//     that point are answered with -32601 and do not move the cursor.
//   - Any other unexpected frame stops the replay with exit code 2 and a message on stderr.
//
// REPLAY_LOG, when set, receives every frame the client sends as a JSON line { segment, frame }.

import fs from 'node:fs';
import readline from 'node:readline';

const [, , transcriptPath, stateFile] = process.argv;
if (!transcriptPath || !stateFile) {
  process.stderr.write('usage: replay-app-server.mjs <transcript.ndjson> <state-file>\n');
  process.exit(64);
}

const optional = new Set((process.env.REPLAY_OPTIONAL_METHODS ?? '').split(',').filter(Boolean));
const logFile = process.env.REPLAY_LOG;

const records = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const segments = [];
let current = [];
for (const entry of records.slice(1)) {
  current.push(entry);
  if (entry.type === 'runtime_exit') {
    segments.push(current);
    current = [];
  }
}
if (current.length > 0) segments.push(current);

let segmentIndex = 0;
try {
  segmentIndex = JSON.parse(fs.readFileSync(stateFile, 'utf8')).launches ?? 0;
} catch {
  segmentIndex = 0;
}
fs.writeFileSync(stateFile, JSON.stringify({ launches: segmentIndex + 1 }));

const entries = segments[segmentIndex];
if (!entries) {
  process.stderr.write(`replay: the transcript has no segment ${segmentIndex} (launch ${segmentIndex + 1})\n`);
  process.exit(2);
}

let cursor = 0;
const idMap = new Map();

function fail(message, actual) {
  process.stderr.write(`REPLAY MISMATCH at entry ${cursor} (segment ${segmentIndex}): ${message}\n`);
  if (actual !== undefined) process.stderr.write(`  actual: ${JSON.stringify(actual).slice(0, 400)}\n`);
  const expected = entries[cursor];
  if (expected) process.stderr.write(`  expected: ${JSON.stringify(expected).slice(0, 400)}\n`);
  process.exit(2);
}

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRequest(frame) {
  return typeof frame.method === 'string' && frame.id !== undefined;
}

function isResponse(frame) {
  return frame.method === undefined && frame.id !== undefined && ('result' in frame || 'error' in frame);
}

function matches(expected, actual) {
  if (isRequest(expected)) return isRequest(actual) && expected.method === actual.method;
  if (typeof expected.method === 'string') return typeof actual.method === 'string' && actual.id === undefined && expected.method === actual.method;
  if (isResponse(expected)) return isResponse(actual) && expected.id === actual.id;
  return false;
}

async function drain() {
  while (cursor < entries.length) {
    const entry = entries[cursor];
    if (entry.type === 'emit_inbound') {
      if (entry.afterMs) await sleep(entry.afterMs);
      const frame = { ...entry.frame };
      if (isResponse(frame) && idMap.has(frame.id)) frame.id = idMap.get(frame.id);
      write(frame);
      cursor += 1;
      continue;
    }
    if (entry.type === 'runtime_exit') {
      cursor += 1;
      if (entry.status === 'success') {
        process.stdout.write('', () => process.exit(0));
        await sleep(10_000);
      }
      process.stderr.write(`replay: runtime exit with status ${entry.status}\n`);
      process.exit(1);
    }
    return; // expect_outbound
  }
}

let queue = drain();

async function onFrame(actual) {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ segment: segmentIndex, frame: actual })}\n`);
  await drain();
  const entry = entries[cursor];
  if (isRequest(actual) && optional.has(actual.method) && !(entry?.type === 'expect_outbound' && matches(entry.frame, actual))) {
    write({ id: actual.id, error: { code: -32601, message: `Not in the transcript: ${actual.method}` } });
    return;
  }
  if (!entry) fail('the transcript is exhausted but the client sent a frame', actual);
  if (entry.type !== 'expect_outbound') fail(`expected ${entry.type}`, actual);
  if (!matches(entry.frame, actual)) fail('the client frame does not match', actual);
  if (isRequest(entry.frame)) idMap.set(entry.frame.id, actual.id);
  cursor += 1;
  await drain();
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  queue = queue.then(() => onFrame(frame)).catch((error) => fail(String(error?.stack ?? error)));
});
process.stdin.on('end', () => process.exit(0));
