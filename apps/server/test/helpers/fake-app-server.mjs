#!/usr/bin/env node
// A scriptable stand-in for `codex app-server` (newline-delimited JSON-RPC over stdio, no `jsonrpc` field).
//
//   node fake-app-server.mjs <scenario.json> [ignored args such as: app-server -c key=value]
//
// The scenario is a JSON file:
//   {
//     "version": "0.164.0",                      // reported in the initialize userAgent
//     "logFile": "/path/fake.log",               // every received frame and process event is appended as JSON
//     "stderr": "text",                          // written to stderr at startup
//     "exitAtStart": 3,                          // exit with this code right after startup (before any request is answered)
//     "ignoreStdinEof": false,                   // keep running after stdin closes
//     "ignoreSigterm": false,                    // keep running on SIGTERM
//     "initializeError": { code, message },      // answer the first initialize with this error (the connection stays usable)
//     "afterInitialize": [Emission],             // emitted right after the initialize response
//     "handlers": { "<method>": Handler | [Handler, ...] }   // an array is consumed one call at a time, the last repeats
//   }
//   Handler  = { "result": any } | { "error": { "code": n, "message": s } }
//              plus optional "delayMs", "noResponse": true, "emitBefore": [Emission], "emitAfter": [Emission]
//   Emission = { "delayMs"?: n, "frame"?: {...}, "raw"?: "line text", "bigLineBytes"?: n, "stderr"?: s, "exit"?: { "code"?: n } }
//   A frame with a "method" and "id": "auto" is a server request (ids count up from 0, like codex).
//   Strings equal to "{{params.a.b}}" or "{{id}}" are replaced with the value from the request being answered.
//
// Every frame the fake receives or sends is logged as { dir: 'in' | 'out', frame }, in order.
//
// Before `initialize`, every request fails with -32600 "Not initialized"; a second `initialize` fails with
// "Already initialized"; unknown methods fail with -32601. Server-request answers are recorded in the log as
// { "dir": "in", "response": { id, result|error } }.

import fs from 'node:fs';
import readline from 'node:readline';

const scenarioPath = process.argv[2];
const scenario = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
const handlers = new Map(Object.entries(scenario.handlers ?? {}));
const callCounts = new Map();
let handshaken = false;
let nextServerRequestId = 0;

function log(entry) {
  if (!scenario.logFile) return;
  fs.appendFileSync(scenario.logFile, `${JSON.stringify(entry)}\n`);
}

function write(frame) {
  log({ dir: 'out', frame });
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lookup(path, context) {
  return path.split('.').reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), context);
}

function template(value, context) {
  if (typeof value === 'string') {
    const whole = /^\{\{([^}]+)\}\}$/.exec(value);
    if (whole) return lookup(whole[1].trim(), context);
    return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => String(lookup(path.trim(), context)));
  }
  if (Array.isArray(value)) return value.map((entry) => template(entry, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, template(entry, context)]));
  return value;
}

async function emit(emissions, context) {
  for (const emission of emissions ?? []) {
    if (emission.delayMs) await sleep(emission.delayMs);
    if (emission.stderr) process.stderr.write(emission.stderr);
    if (emission.raw !== undefined) process.stdout.write(`${emission.raw}\n`);
    if (emission.bigLineBytes) write({ method: 'big/notification', params: { data: 'x'.repeat(emission.bigLineBytes) } });
    if (emission.frame) {
      const frame = template(emission.frame, context);
      if (frame.method && frame.id === 'auto') frame.id = nextServerRequestId++;
      write(frame);
    }
    if (emission.exit) {
      log({ dir: 'event', event: 'exit', code: emission.exit.code ?? 0 });
      process.stdout.write('', () => process.exit(emission.exit.code ?? 0));
      await sleep(10_000);
    }
  }
}

function pickHandler(method) {
  const entry = handlers.get(method);
  if (entry === undefined) return undefined;
  if (!Array.isArray(entry)) return entry;
  const count = callCounts.get(method) ?? 0;
  callCounts.set(method, count + 1);
  return entry[Math.min(count, entry.length - 1)];
}

async function handleRequest(frame) {
  const { id, method, params } = frame;
  const context = { id, params };
  if (method === 'initialize') {
    if (handshaken) {
      write({ id, error: { code: -32600, message: 'Already initialized' } });
      return;
    }
    handshaken = true;
    if (scenario.initializeError) {
      // Simulates a server that finished an earlier handshake: this one fails, the connection is usable.
      write({ id, error: scenario.initializeError });
      return;
    }
    write({
      id,
      result: {
        userAgent: `${params?.clientInfo?.name ?? 'client'}/${scenario.version ?? '0.164.0'} (Fake OS 1.0; x86_64) fake (${params?.clientInfo?.name}; ${params?.clientInfo?.version})`,
        codexHome: process.env.CODEX_HOME ?? '/fake/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await emit(scenario.afterInitialize, context);
    return;
  }
  if (!handshaken) {
    write({ id, error: { code: -32600, message: 'Not initialized' } });
    return;
  }
  const handler = pickHandler(method);
  if (!handler) {
    write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    return;
  }
  await emit(handler.emitBefore, context);
  if (handler.delayMs) await sleep(handler.delayMs);
  if (handler.error) write({ id, error: template(handler.error, context) });
  else if (!handler.noResponse) write({ id, result: template(handler.result ?? {}, context) });
  await emit(handler.emitAfter, context);
}

function handleFrame(frame) {
  if (typeof frame.method === 'string' && frame.id !== undefined) {
    handleRequest(frame).catch((error) => process.stderr.write(`fake app-server failed: ${error?.stack ?? error}\n`));
    return;
  }
  if (typeof frame.method === 'string') return; // a client notification such as `initialized` (already logged)
  // The client's answer to one of our server requests.
  if (frame.id !== undefined) log({ dir: 'in', response: frame });
}

if (scenario.stderr) process.stderr.write(scenario.stderr);
log({ dir: 'event', event: 'start', pid: process.pid, argv: process.argv.slice(2), env: { CODEX_HOME: process.env.CODEX_HOME ?? null, ORIGINATOR: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? null, SESSION: process.env.AGENT_CONSOLE_SESSION_ID ?? null, THREAD: process.env.CODEX_THREAD_ID ?? null }, cwd: process.cwd() });

if (scenario.exitAtStart !== undefined) process.stderr.write('', () => process.exit(scenario.exitAtStart));

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  if (frame.method) log({ dir: 'in', frame });
  handleFrame(frame);
});
process.stdin.on('end', () => {
  log({ dir: 'event', event: 'stdin-eof' });
  if (scenario.ignoreStdinEof) return;
  process.exit(0);
});
process.on('SIGTERM', () => {
  log({ dir: 'event', event: 'sigterm' });
  if (!scenario.ignoreSigterm) process.exit(143);
});
if (scenario.ignoreStdinEof || scenario.ignoreSigterm) setInterval(() => undefined, 1_000);
