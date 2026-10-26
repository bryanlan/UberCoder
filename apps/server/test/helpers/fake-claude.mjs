#!/usr/bin/env node
// A scriptable stand-in for the `claude` CLI in stream-json mode (newline-delimited JSON on stdin and stdout).
//
//   node fake-claude.mjs <scenario.json> [the real flags: --output-format ... --session-id <id> | --resume <id> ...]
//
// It models what the plugin depends on in `claude` 2.1.310 (see docs/research/claude-headless-2026-10-26/): the
// `initialize` reply, SessionStart hook frames before it, a command queue with `command_lifecycle` frames, a
// `system/init` per turn, one `result` per turn that lists `user_message_uuids`, folding of queued messages at a
// fold point, `priority: 'now'` preemption, the `interrupt` control request, duplicate uuids acknowledged with a bare
// `completed`, server requests (`can_use_tool`, `elicitation`) that block the turn until answered, end of input
// (finish the turn, then exit 0, or 1 after an error result), SIGTERM (exit 143, no result) and the registry file
// under `<sessionsDir>/<pid>.json`.
//
// Scenario (all keys optional):
//   logFile                 every received and sent frame is appended as {dir:'in'|'out', frame}; the first entry is
//                           {dir:'start', argv, env, cwd, pid}
//   version, account, models, apiKeySource, pendingPermissionRequests   what `initialize` and `system/init` report
//   sessionStartHook        emit SessionStart hook_started/hook_response frames before the initialize reply
//   hookStdout              the hook_response `stdout`
//   initializeDelayMs, noInitializeReply, initializeError
//   backgroundTasksOnReinitialize   the `tasks` of a `system/background_tasks_changed` snapshot the CLI sends right behind
//                           the reply to every `initialize` after the first (a host that re-initializes a running process)
//   exitAfterReinitializeMs   exit with code 1 this long after answering an `initialize` after the first
//   reinitializeError       answer every `initialize` after the first with this error instead of a reply
//   reinitializeStateOverride   the `session_state` every `initialize` after the first reports instead of the real one
//   (the `session_state` of an `initialize` reply is `running` while a turn runs, `idle` otherwise)
//   startupFailure          {errors, reason?, exitCode?}: write the zeroed error result a failed startup writes, exit
//   exitAtStart             exit with this code right after startup
//   ignoreStdinEof, ignoreSigterm
//   startDelayMs            a queued send waits this long before it starts
//   cancelQueuedAfterMs     a queued send is dropped (lifecycle cancelled) after this long and never starts
//   grandchild              start a `sleep 300` in the process group, as an MCP server would be
//   sessionsDir             write/remove the registry file there
//   contextUsage            {totalTokens, rawMaxTokens} for get_context_usage, or "error"
//   interrupt               {ignore: true, lateResultMs}: accept `interrupt` but end the turn only after lateResultMs
//   turns, defaultTurn      Turn = {steps: [Step], onInterrupt?: [Step]}; consumed one per started turn
//   Step: {sleep: ms} | {emit: frame} | {assistant: {text|blocks, error?}} | {toolUse: {id,name,input}} |
//         {toolResult: {id}} | {request: {request_id, request}} | {fold: true} | {waitInterrupt: true} |
//         {hold: true} | {result: {...overrides}} | {exit: code}
//   Strings "{{uuid}}" (first uuid of the turn), "{{lastUuid}}", "{{uuids}}", "{{sessionId}}" are replaced.

import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const scenarioPath = process.argv[2];
const scenario = scenarioPath && fs.existsSync(scenarioPath) ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
const argv = process.argv.slice(3);

function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID();

function log(entry) {
  if (!scenario.logFile) return;
  fs.appendFileSync(scenario.logFile, `${JSON.stringify(entry)}\n`);
}

function write(frame) {
  log({ dir: 'out', frame });
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

log({ dir: 'start', argv, env: process.env, cwd: process.cwd(), pid: process.pid });

// ---------------------------------------------------------------------------------------------------------
// Registry file

let registryFile;
function procStart() {
  try {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}
if (scenario.sessionsDir) {
  fs.mkdirSync(scenario.sessionsDir, { recursive: true });
  registryFile = `${scenario.sessionsDir}/${process.pid}.json`;
  fs.writeFileSync(registryFile, JSON.stringify({ pid: process.pid, sessionId, cwd: process.cwd(), procStart: procStart(), kind: 'interactive', entrypoint: 'sdk-cli', status: 'idle' }));
}

function finish(code) {
  if (registryFile) fs.rmSync(registryFile, { force: true });
  process.exit(code);
}

process.on('SIGTERM', () => {
  log({ dir: 'event', event: 'sigterm' });
  if (scenario.ignoreSigterm) return;
  finish(143);
});

// ---------------------------------------------------------------------------------------------------------
// State

const turns = [...(scenario.turns ?? [])];
const seenUuids = new Set();
const queue = []; // {uuid, content, priority}
let running; // {uuids, steps, interrupted, wake, fold, ...}
let eof = false;
let lastResultWasError = false;
let resultIndex = 0;
let turnCount = 0;
let nextRequestId = 0;
let initializeCount = 0;
const responseWaiters = new Map(); // request_id -> resolve
const openRequests = new Map(); // request_id -> control_request frame the CLI is still waiting on

function template(value, context) {
  if (typeof value === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(value);
    if (whole) return context[whole[1]];
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => String(context[key]));
  }
  if (Array.isArray(value)) return value.map((entry) => template(entry, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, template(entry, context)]));
  return value;
}

function contextOf(turn) {
  return { uuid: turn.uuids[0], lastUuid: turn.uuids.at(-1), uuids: turn.uuids, sessionId };
}

function lifecycle(uuid, state) {
  write({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: randomUUID(), session_id: sessionId });
}

function sessionState(state) {
  if (process.env.CLAUDE_CODE_SDK_READS_SESSION_STATE !== '1') return;
  write({ type: 'system', subtype: 'session_state_changed', state, uuid: randomUUID(), session_id: sessionId });
}

function accountInfo() {
  return scenario.account ?? { tokenSource: 'none', apiProvider: 'firstParty' };
}

// ---------------------------------------------------------------------------------------------------------
// Turns

function startTurn(command) {
  const turn = {
    uuids: [command.uuid],
    interrupted: false,
    ended: false,
    wake: undefined,
    resolveInterrupt: undefined,
    aborted: false,
  };
  running = turn;
  turnCount += 1;
  sessionState('running');
  lifecycle(command.uuid, 'started');
  write({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ['Bash', 'Read', 'Edit', 'AskUserQuestion'],
    mcp_servers: scenario.mcpServers ?? [],
    model: flag('--model') ?? 'claude-test',
    permissionMode: 'bypassPermissions',
    apiKeySource: scenario.initApiKeySource ?? scenario.apiKeySource ?? 'none',
    claude_code_version: scenario.version ?? '2.1.310',
    capabilities: ['interrupt_receipt_v1'],
    uuid: randomUUID(),
    user_message_uuids: [...turn.uuids],
  });
  write({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId, uuid: randomUUID(), user_message_uuids: [...turn.uuids] });
  const script = turns.shift() ?? scenario.defaultTurn ?? { steps: [{ assistant: { text: 'done' } }] };
  void runSteps(turn, script).catch((error) => {
    log({ dir: 'event', event: 'script-error', message: String(error?.stack ?? error) });
    finish(70);
  });
}

function assistantFrame(turn, blocks, extra = {}) {
  return {
    type: 'assistant',
    message: { id: `msg_${randomUUID()}`, model: 'claude-test', role: 'assistant', type: 'message', content: blocks },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
    user_message_uuid: turn.uuids.at(-1),
    user_message_uuids: [...turn.uuids],
    ...extra,
  };
}

function resultFrame(turn, overrides = {}) {
  const frame = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 5,
    duration_api_ms: 3,
    num_turns: 1,
    result: 'ok',
    stop_reason: 'end_turn',
    session_id: sessionId,
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100,
      iterations: [{ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }],
    },
    modelUsage: { 'claude-test': { inputTokens: 10, outputTokens: 5, contextWindow: 200000, maxOutputTokens: 32000, costUSD: 0 } },
    permission_denials: [],
    terminal_reason: 'completed',
    user_message_uuid: turn.uuids.at(-1),
    user_message_uuids: [...turn.uuids],
    queued_turn_count: queue.length,
    result_index: resultIndex,
    uuid: randomUUID(),
    ...overrides,
  };
  return frame;
}

function endTurn(turn, overrides) {
  if (turn.ended) return;
  turn.ended = true;
  const frame = resultFrame(turn, overrides);
  resultIndex += 1;
  lastResultWasError = frame.is_error === true || frame.subtype !== 'success';
  write(frame);
  // An API-error turn ends `cancelled`, a normal one `completed`.
  const apiFailure = frame.is_error === true && frame.subtype === 'success' && frame.terminal_reason === 'api_error';
  for (const uuid of turn.uuids) lifecycle(uuid, apiFailure || turn.aborted ? 'cancelled' : 'completed');
  if (running === turn) running = undefined;
  if (queue.length === 0) sessionState('idle');
  pump();
}

function pump() {
  if (running) return;
  const next = queue.shift();
  if (next) {
    startTurn(next);
    return;
  }
  if (eof && !scenario.ignoreStdinEof) finish(lastResultWasError ? 1 : 0);
}

function foldQueued(turn) {
  // Plain queued messages join the running turn at a tool boundary: each reports `completed` before the result.
  while (queue.length > 0 && queue[0].priority !== 'now') {
    const folded = queue.shift();
    turn.uuids.push(folded.uuid);
    lifecycle(folded.uuid, 'completed');
  }
}

async function runSteps(turn, script) {
  const steps = script.steps ?? [];
  for (const raw of steps) {
    if (turn.aborted) return;
    if (turn.interrupted && !turn.ended) break;
    const step = template(raw, contextOf(turn));
    if (step.sleep) {
      await Promise.race([sleep(step.sleep), new Promise((resolve) => (turn.wake = resolve))]);
      turn.wake = undefined;
    } else if (step.emit) {
      write(step.emit);
    } else if (step.assistant) {
      const blocks = step.assistant.blocks ?? [{ type: 'text', text: step.assistant.text ?? '' }];
      write(assistantFrame(turn, blocks, step.assistant.error ? { error: step.assistant.error, is_api_error_message: true, ...(step.assistant.apiErrorParams ? { api_error_params: step.assistant.apiErrorParams } : {}) } : {}));
    } else if (step.toolUse) {
      write(assistantFrame(turn, [{ type: 'tool_use', id: step.toolUse.id, name: step.toolUse.name, input: step.toolUse.input ?? {} }]));
    } else if (step.toolResult) {
      write({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: step.toolResult.id, content: step.toolResult.content ?? 'ok' }] },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: randomUUID(),
      });
    } else if (step.request) {
      const requestId = step.request.request_id ?? `fake-req-${nextRequestId++}`;
      const requestFrame = { type: 'control_request', request_id: requestId, request: step.request.request };
      openRequests.set(requestId, requestFrame);
      write(requestFrame);
      await Promise.race([new Promise((resolve) => responseWaiters.set(requestId, resolve)), new Promise((resolve) => (turn.wake = resolve))]);
      responseWaiters.delete(requestId);
      openRequests.delete(requestId);
      turn.wake = undefined;
    } else if (step.fold) {
      foldQueued(turn);
    } else if (step.waitInterrupt || step.hold) {
      await new Promise((resolve) => (turn.wake = resolve));
      turn.wake = undefined;
      if (step.hold && !turn.interrupted) return;
    } else if (step.result) {
      endTurn(turn, step.result);
    } else if (step.exit !== undefined) {
      finish(step.exit);
    }
  }
  if (turn.ended) return;
  if (turn.interrupted && !turn.aborted) {
    await runInterrupt(turn, script);
    return;
  }
  endTurn(turn);
}

async function runInterrupt(turn, script) {
  if (turn.ended) return;
  const steps = script.onInterrupt;
  if (steps) {
    for (const raw of steps) {
      const step = template(raw, contextOf(turn));
      if (step.sleep) await sleep(step.sleep);
      else if (step.emit) write(step.emit);
      else if (step.result) {
        endTurn(turn, step.result);
        return;
      } else if (step.exit !== undefined) finish(step.exit);
    }
    return;
  }
  abortTurn(turn);
}

function abortTurn(turn) {
  turn.aborted = true;
  endTurn(turn, { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: ['prompt_check: the turn was stopped before its prompt was checked'], result: undefined, stop_reason: null });
}

// ---------------------------------------------------------------------------------------------------------
// Inbound

function reply(requestId, response, envelope = {}) {
  write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, ...(response !== undefined ? { response } : {}), ...envelope } });
}

function replyError(requestId, error) {
  write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
}

async function handleControl(frame) {
  const requestId = frame.request_id;
  const request = frame.request ?? {};
  switch (request.subtype) {
    case 'initialize': {
      if (scenario.noInitializeReply) return;
      if (scenario.initializeDelayMs) await sleep(scenario.initializeDelayMs);
      if (scenario.initializeError) {
        replyError(requestId, scenario.initializeError);
        return;
      }
      if (initializeCount >= 1 && scenario.reinitializeError) {
        initializeCount += 1;
        replyError(requestId, scenario.reinitializeError);
        return;
      }
      reply(
        requestId,
        {
          commands: [],
          agents: [],
          models: scenario.models ?? [
            { value: 'default', resolvedModel: 'claude-test', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
            { value: 'haiku', resolvedModel: 'claude-haiku-test', displayName: 'Haiku', supportsEffort: false },
          ],
          account: accountInfo(),
          pid: process.pid,
          claude_code_version: scenario.version ?? '2.1.310',
          current_permission_mode: 'bypassPermissions',
          hooks_applied: true,
          session_state: initializeCount >= 1 && scenario.reinitializeStateOverride ? scenario.reinitializeStateOverride : running && !running.ended ? 'running' : 'idle',
          capabilities: ['interrupt_receipt_v1'],
        },
        { pending_permission_requests: [...(scenario.pendingPermissionRequests ?? []), ...openRequests.values()], pending_user_dialog_requests: [] },
      );
      initializeCount += 1;
      if (initializeCount > 1 && scenario.exitAfterReinitializeMs !== undefined) setTimeout(() => finish(1), scenario.exitAfterReinitializeMs);
      if (initializeCount > 1 && scenario.backgroundTasksOnReinitialize) {
        write({ type: 'system', subtype: 'background_tasks_changed', tasks: scenario.backgroundTasksOnReinitialize, uuid: randomUUID(), session_id: sessionId });
      }
      return;
    }
    case 'interrupt': {
      const cancelled = [];
      if (request.cancel_queued) {
        while (queue.length > 0) {
          const dropped = queue.shift();
          cancelled.push(dropped.uuid);
          lifecycle(dropped.uuid, 'cancelled');
        }
      }
      reply(requestId, request.cancel_queued ? { still_queued: [], cancelled } : { still_queued: queue.map((entry) => entry.uuid) });
      if (running && !running.ended) {
        running.interrupted = true;
        if (scenario.interrupt?.ignore) {
          const turn = running;
          if (scenario.interrupt.lateResultMs) setTimeout(() => abortTurn(turn), scenario.interrupt.lateResultMs);
          return;
        }
        const turn = running;
        if (turn.wake) turn.wake();
      }
      return;
    }
    case 'set_model':
      reply(requestId, { model: `resolved-${request.model}` });
      return;
    case 'apply_flag_settings':
      reply(requestId);
      return;
    case 'get_context_usage':
      if (scenario.contextUsage === 'error') replyError(requestId, 'get_context_usage is not available');
      else reply(requestId, { totalTokens: scenario.contextUsage?.totalTokens ?? 1234, maxTokens: 200000, rawMaxTokens: scenario.contextUsage?.rawMaxTokens ?? 200000, percentage: 1, model: 'claude-test', categories: [] });
      return;
    default:
      replyError(requestId, `Unsupported control request: ${request.subtype}`);
  }
}

function handleUser(frame) {
  const uuid = frame.uuid;
  if (uuid && seenUuids.has(uuid)) {
    // The transcript already holds this uuid: acknowledged, nothing runs.
    lifecycle(uuid, 'completed');
    return;
  }
  if (uuid) seenUuids.add(uuid);
  const command = { uuid, content: frame.message?.content, priority: frame.priority };
  lifecycle(uuid, 'queued');
  if (frame.priority === 'now' && running && !running.ended) {
    queue.unshift(command);
    const turn = running;
    turn.interrupted = true;
    if (turn.wake) turn.wake();
    return;
  }
  queue.push(command);
  if (scenario.cancelQueuedAfterMs) {
    // The CLI drops the send before it starts, with no result.
    setTimeout(() => {
      const index = queue.indexOf(command);
      if (index >= 0) queue.splice(index, 1);
      lifecycle(uuid, 'cancelled');
    }, scenario.cancelQueuedAfterMs);
    return;
  }
  if (scenario.startDelayMs) setTimeout(pump, scenario.startDelayMs);
  else pump();
}

function handleLine(line) {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  log({ dir: 'in', frame });
  switch (frame.type) {
    case 'control_request':
      void handleControl(frame);
      return;
    case 'control_response': {
      const waiter = responseWaiters.get(frame.response?.request_id);
      if (waiter) waiter(frame.response);
      return;
    }
    case 'control_cancel_request':
      return;
    case 'user':
      handleUser(frame);
      return;
    default:
  }
}

// ---------------------------------------------------------------------------------------------------------
// Startup

// An MCP server the CLI started: a descendant in the CLI's process group that does not end with it.
if (scenario.grandchild) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  log({ dir: 'event', event: 'grandchild', pid: child.pid });
}

// A real CLI stays up while a turn runs even after its input ended; so does this one, until `finish` is called.
setInterval(() => undefined, 60_000);

if (scenario.stderr) process.stderr.write(scenario.stderr);

if (scenario.startupFailure) {
  const failure = scenario.startupFailure;
  write({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    stop_reason: null,
    session_id: sessionId,
    total_cost_usd: 0,
    modelUsage: {},
    permission_denials: [],
    errors: failure.errors ?? ['startup failed'],
    ...(failure.reason ? { startup_failure_reason: failure.reason } : {}),
    result_index: 0,
    uuid: randomUUID(),
  });
  setTimeout(() => finish(failure.exitCode ?? 1), 20);
} else if (scenario.exitAtStart !== undefined) {
  setTimeout(() => finish(scenario.exitAtStart), 20);
} else {
  if (scenario.sessionStartHook) {
    const hookId = randomUUID();
    write({ type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: 'SessionStart:startup', hook_event: 'SessionStart', uuid: randomUUID(), session_id: sessionId });
    write({
      type: 'system',
      subtype: 'hook_response',
      hook_id: hookId,
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      output: scenario.hookStdout ?? '',
      stdout: scenario.hookStdout ?? '',
      stderr: '',
      exit_code: 0,
      outcome: 'success',
      uuid: randomUUID(),
      session_id: sessionId,
    });
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', handleLine);
  input.on('close', () => {
    eof = true;
    log({ dir: 'event', event: 'stdin-eof' });
    if (scenario.ignoreStdinEof) return;
    // Idle: exit now. Mid-turn: the turn finishes (pump exits when the queue drains).
    if (!running) finish(lastResultWasError ? 1 : 0);
  });
}
