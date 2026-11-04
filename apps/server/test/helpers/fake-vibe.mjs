#!/usr/bin/env node
// A stand-in for `vibe-acp` (no flags): an ACP agent over stdio that answers the calls the Vibe plugin makes the way
// Vibe 3.0.4 does (shapes checked against the installed CLI on 2026-11-03). Tests steer it through the environment and
// the text of the prompt:
//   VIBE_HOME=<dir>         where the unified session store is written (<dir>/logs/session/unified/<id>/)
//   FAKE_VIBE_LOG=<file>    one JSON line per request or notification received: { method, params, pid, jsonrpc }
//   FAKE_VIBE_HOLD=<file>   a prompt that says "slow" ends when this file exists (or when the turn is cancelled)
//   FAKE_VIBE_TRUSTED=1     session/new reports the workspace already trusted
//   FAKE_VIBE_LOGGED_OUT=1  _auth/status reports authenticated: false
// Prompt text selects the turn: "slow" runs until released or cancelled; "tool" runs a tool call; "permission" asks the
// client first; "rate-limit" answers -31001; "fail" answers another JSON-RPC error; "drop-answer" advances the store to
// a quiescent next generation and never answers; "silent-cancel" ignores a cancel and never answers; an image block, or
// anything else, is a short reply. Any argv flag exits 2: vibe-acp takes none.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.length > 0) {
  process.stderr.write(`fake vibe: unexpected command line ${argv.join(' ')}\n`);
  process.exit(2);
}

const logFile = process.env.FAKE_VIBE_LOG;
const holdFile = process.env.FAKE_VIBE_HOLD;
const trusted = process.env.FAKE_VIBE_TRUSTED === '1';
const vibeHome = process.env.VIBE_HOME || path.join(process.env.HOME || '/tmp', '.vibe');

const MODELS = ['glm-5-3', 'mistral-large-4-0-3', 'zai-glm-5-3-flash', 'mistral-medium-3.5'];
const THINKING = ['low', 'high', 'max'];
const MODES = ['ask', 'accept-edits', 'smart-approve', 'auto-approve'];
const FORMAT = 'mistral.vibe.unified-session-store/v1';

/** Sessions held by this process: id -> { model, thinking, mode, cwd, working, promptId, trust, generation, snapshot, entries } */
const resident = new Map();

function log(entry) {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ ...entry, pid: process.pid })}\n`);
}
function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}
function notify(method, params) { send({ method, params }); }
function reply(id, result) { send({ id, result }); }
function fail(id, code, message, data) { send({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } }); }

function configOptions(session) {
  return [
    { id: 'model', name: 'Model', type: 'select', currentValue: session.model, options: MODELS.map(value => ({ value, name: value })) },
    { id: 'thinking', name: 'Thinking', type: 'select', currentValue: session.thinking, options: THINKING.map(value => ({ value, name: value })) },
    { id: 'mode', name: 'Mode', type: 'select', currentValue: session.mode, options: MODES.map(value => ({ value, name: value })) },
  ];
}

function storeDir(sessionId) {
  return path.join(vibeHome, 'logs', 'session', 'unified', sessionId);
}

/** Writes CURRENT and the generation the plugin reads to decide whether a disconnected turn finished. */
function writeStore(session, generation, executionState) {
  const dir = storeDir(session.id);
  const digest = `chunk-${generation}`;
  fs.mkdirSync(path.join(dir, 'generations', generation), { recursive: true });
  fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chunks', `${digest}.json`), JSON.stringify(session.entries));
  fs.writeFileSync(path.join(dir, 'generations', generation, 'manifest.json'), JSON.stringify({
    execution_state: executionState,
    projection_state: { path: 'projection-state.json', sha256: digest, chunks: [digest] },
  }));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    title: session.title,
    environment: { working_directory: session.cwd },
    config: { active_model: session.model, thinking: session.thinking },
  }));
  fs.writeFileSync(path.join(dir, 'CURRENT'), JSON.stringify({
    store_format: FORMAT,
    store_format_minor: 10,
    session_id: session.id,
    generation,
    snapshot_sequence: session.snapshot,
  }));
  session.generation = generation;
}

function usage(sessionId, used) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'usage_update',
      used,
      size: 800000,
      _meta: { steps: 1, promptTokens: used, completionTokens: 0, cachedTokens: 0, totalTokens: used },
    },
  });
}

function chunk(sessionId, kind, text) {
  notify('session/update', { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } } });
}

const pendingClientRequests = new Map();
let clientRequestId = 0;
function askClient(method, params) {
  clientRequestId += 1;
  const id = `agent-${clientRequestId}`;
  return new Promise((resolve) => { pendingClientRequests.set(id, resolve); send({ id, method, params }); });
}

function endTurn(id, session, stopReason) {
  session.working = false;
  clearInterval(session.holdTimer);
  if (session.respondToPrompt !== false) reply(id, { stopReason });
  session.promptId = undefined;
}

function restore(sessionId) {
  const current = path.join(storeDir(sessionId), 'CURRENT');
  if (!fs.existsSync(current)) return undefined;
  const held = resident.get(sessionId);
  if (held) return held;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(storeDir(sessionId), 'meta.json'), 'utf8')); } catch { /* a pointer with no meta still loads */ }
  const pointer = JSON.parse(fs.readFileSync(current, 'utf8'));
  const session = {
    id: sessionId,
    model: meta.config?.active_model || 'glm-5-3',
    thinking: meta.config?.thinking || 'high',
    mode: 'ask',
    cwd: meta.environment?.working_directory,
    title: meta.title || 'Fake session',
    working: false,
    trust: trusted ? 'trusted' : 'untrusted',
    generation: pointer.generation,
    snapshot: pointer.snapshot_sequence,
    entries: [],
  };
  resident.set(sessionId, session);
  return session;
}

async function runPrompt(id, params) {
  const session = resident.get(params.sessionId);
  if (!session) { fail(id, -32602, 'unknown session'); return; }
  const blocks = params.prompt ?? [];
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
  session.working = true;
  session.promptId = id;
  session.respondToPrompt = true;
  session.entries.push({
    type: 'message', role: 'user', source: 'turn_start', generationStatus: 'committed', createdAt: Date.now(),
    content: [{ type: 'text', text }],
  });
  if (text.includes('drop-answer')) {
    // The turn ended while nobody was reading the answer. The store is the only signal, and this process does not reply.
    writeStore(session, 'gen-0002', 'quiescent');
    return;
  }
  if (text.includes('rate-limit')) {
    session.working = false;
    fail(id, -31001, 'RateLimitError for provider mistral model glm-5-3', { provider: 'mistral', model: 'glm-5-3' });
    return;
  }
  if (text.includes('fail')) {
    session.working = false;
    fail(id, -32603, 'The model service returned an internal error.');
    return;
  }
  if (text.includes('permission')) {
    const outcome = await askClient('session/request_permission', {
      sessionId: session.id,
      toolCall: { toolCallId: 'perm-1', title: 'Run rm -rf build' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
    });
    log({ method: 'agent-saw-permission-outcome', params: outcome });
  }
  if (text.includes('tool')) {
    chunk(session.id, 'agent_thought_chunk', 'thinking about it');
    notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_terminal_command', kind: 'execute' } });
    notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', kind: 'execute', title: 'Execute `ls`' } });
  }
  if (text.includes('slow') || text.includes('silent-cancel')) {
    if (text.includes('silent-cancel')) session.respondToPrompt = false;
    chunk(session.id, 'agent_message_chunk', 'working on it');
    const finish = () => {
      if (!session.working || session.promptId !== id) return;
      chunk(session.id, 'agent_message_chunk', 'finished slowly');
      usage(session.id, 1234);
      writeStore(session, session.generation, 'quiescent');
      endTurn(id, session, 'end_turn');
    };
    session.holdTimer = setInterval(() => { if (holdFile && fs.existsSync(holdFile)) finish(); }, 20);
    session.cancel = () => {
      if (!session.working || session.promptId !== id) return;
      clearInterval(session.holdTimer);
      if (text.includes('silent-cancel')) { session.working = false; return; }
      endTurn(id, session, 'cancelled');
    };
    return;
  }
  chunk(session.id, 'agent_message_chunk', 'Hello from fake vibe');
  usage(session.id, 1234);
  session.entries.push({
    type: 'message', role: 'assistant', source: 'harness', generationStatus: 'committed', createdAt: Date.now(),
    content: [{ type: 'text', text: 'Hello from fake vibe' }],
  });
  writeStore(session, session.generation, 'quiescent');
  endTurn(id, session, 'end_turn');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === undefined) {
    const resolve = pendingClientRequests.get(message.id);
    if (resolve) { pendingClientRequests.delete(message.id); resolve(message.result ?? message.error); }
    return;
  }
  log({ method: message.method, params: message.params, jsonrpc: message.jsonrpc });
  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentInfo: { name: 'vibe', version: '3.0.4-fake' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { list: {}, fork: {}, close: {} },
        },
      });
      break;
    case '_auth/status':
      reply(id, { authenticated: process.env.FAKE_VIBE_LOGGED_OUT !== '1' });
      break;
    case 'session/new': {
      const sessionId = randomUUID();
      const session = {
        id: sessionId, model: 'glm-5-3', thinking: 'high', mode: 'ask', cwd: params.cwd, title: 'Fake session',
        working: false, trust: trusted ? 'trusted' : 'untrusted', generation: 'gen-0001', snapshot: 1, entries: [],
      };
      resident.set(sessionId, session);
      writeStore(session, 'gen-0001', 'quiescent');
      usage(sessionId, 10);
      reply(id, {
        sessionId,
        configOptions: configOptions(session),
        _meta: { workspace_trust: { status: session.trust } },
      });
      // Real vibe-acp follows session/new with notices that are not agent activity.
      setTimeout(() => {
        notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the conversation' }] } });
        notify('session/update', { sessionId, update: { sessionUpdate: 'session_info_update', title: session.title } });
      }, 5);
      break;
    }
    case 'session/load': {
      const session = restore(params.sessionId);
      if (!session) { fail(id, -32602, 'session not found'); break; }
      chunk(session.id, 'agent_message_chunk', 'earlier reply');
      usage(session.id, 10);
      reply(id, { configOptions: configOptions(session), _meta: { workspace_trust: { status: session.trust } } });
      break;
    }
    case 'session/list':
      reply(id, { sessions: [...resident.values()].map(session => ({ sessionId: session.id, cwd: session.cwd, title: session.title, updatedAt: new Date().toISOString() })) });
      break;
    case 'session/set_config_option': {
      const session = resident.get(params.sessionId);
      if (!session) { fail(id, -32602, 'unknown session'); break; }
      if (params.configId === 'model') {
        if (!MODELS.includes(params.value)) { fail(id, -32602, 'unknown model'); break; }
        session.model = params.value;
      } else if (params.configId === 'thinking') {
        if (!THINKING.includes(params.value)) { fail(id, -32602, 'unknown thinking'); break; }
        session.thinking = params.value;
      } else if (params.configId === 'mode') {
        if (!MODES.includes(params.value)) { fail(id, -32602, 'unknown mode'); break; }
        session.mode = params.value;
      } else { fail(id, -32602, 'unknown config'); break; }
      reply(id, { configOptions: configOptions(session) });
      break;
    }
    case 'session/prompt':
      void runPrompt(id, params);
      break;
    case 'session/cancel':
      resident.get(params.sessionId)?.cancel?.();
      break;
    case '_trust/status': {
      const session = resident.get(params.sessionId);
      reply(id, { trust_status: session?.trust ?? 'untrusted' });
      break;
    }
    case '_trust/decision': {
      const session = resident.get(params.sessionId);
      if (session && params.decision === 'trust_cwd') session.trust = 'trusted';
      reply(id, { trust_status: session?.trust ?? 'untrusted', details: '' });
      break;
    }
    case 'session/close':
      reply(id, {});
      break;
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }
});
