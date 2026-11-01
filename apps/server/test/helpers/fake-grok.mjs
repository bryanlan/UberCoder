#!/usr/bin/env node
// A stand-in for `grok agent --always-approve [--model M] [--reasoning-effort E] stdio`: an ACP agent over stdio that answers the
// calls the Grok plugin makes the way grok 1.0.70 does (shapes taken from a real run on 2026-11-01). Tests steer it through
// environment variables and the text of the prompt:
//   FAKE_GROK_STATE=<dir>   saved sessions, so a second process can `session/load` what the first one created
//   FAKE_GROK_LOG=<file>    one JSON line per request or notification received: { method, params, pid }
//   FAKE_GROK_HOLD=<file>   a prompt that says "slow" ends when this file exists (or when the turn is cancelled)
// Prompt text selects the turn: "slow" runs until released or cancelled; "tool" runs a tool call; "permission" asks the client for
// permission first; "limit" and "fail" answer with errors; "silent-cancel" ignores a cancel and never answers; anything else is a
// short reply. Starting with argv "agent --always-approve ... stdio" is checked so a wrong command line fails the test.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const stateDir = process.env.FAKE_GROK_STATE;
const logFile = process.env.FAKE_GROK_LOG;
const holdFile = process.env.FAKE_GROK_HOLD;

if (argv[0] !== 'agent' || argv.at(-1) !== 'stdio') {
  process.stderr.write(`fake grok: unexpected command line ${argv.join(' ')}\n`);
  process.exit(2);
}

const MODELS = [
  { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000, supportsReasoningEffort: true, reasoningEfforts: ['xhigh', 'high', 'medium', 'low'].map(id => ({ id, value: id })) } },
  { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { totalContextTokens: 200000, supportsReasoningEffort: true, reasoningEfforts: ['xhigh', 'high', 'medium', 'low'].map(id => ({ id, value: id })) } },
];

/** sessions held by this process: id -> { model, effort, working, history, cancelled, holdTimer } */
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
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: MODELS.map(m => ({ value: m.modelId, name: m.name })) },
    { id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: session.effort,
      options: ['xhigh', 'high', 'medium', 'low'].map(value => ({ value, name: value })) },
  ];
}
function saveSession(id, session) {
  if (!stateDir) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${id}.json`), JSON.stringify({ model: session.model, effort: session.effort, history: session.history, cwd: session.cwd }));
}
function loadSession(id) {
  if (!stateDir) return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), 'utf8')); } catch { return undefined; }
}
let promptCounter = 0;
function chunk(sessionId, kind, text, extra = {}) {
  const promptId = resident.get(sessionId)?.promptName;
  notify('session/update', { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } }, _meta: { totalTokens: 1234, ...(promptId ? { promptId } : {}), ...extra } });
}

const pendingClientRequests = new Map();
let clientRequestId = 0;
function askClient(method, params) {
  clientRequestId += 1;
  const id = `agent-${clientRequestId}`;
  return new Promise((resolve) => { pendingClientRequests.set(id, resolve); send({ id, method, params }); });
}

function endTurn(id, sessionId, session, stopReason) {
  session.working = false;
  clearInterval(session.holdTimer);
  const promptName = session.promptName;
  notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'turn_completed', prompt_id: promptName, stop_reason: stopReason,
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 1234 } } });
  notify('_x.ai/session/prompt_complete', { sessionId, promptId: promptName, stopReason });
  if (session.respondToPrompt !== false) reply(id, { stopReason, _meta: { sessionId, promptId: promptName, totalTokens: 1234, modelId: session.model } });
  // The same end-of-prompt signal again, late, as Grok has been seen to send it after the next prompt started.
  if (session.lateDuplicate) setTimeout(() => notify('_x.ai/session/prompt_complete', { sessionId, promptId: promptName, stopReason }), 120);
  session.promptId = undefined;
}

async function runPrompt(id, params) {
  const sessionId = params.sessionId;
  const session = resident.get(sessionId);
  if (!session) { fail(id, -32602, 'Invalid params', 'unknown session'); return; }
  const text = (params.prompt ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  session.history.push({ role: 'user', text });
  session.working = true;
  session.promptId = id;
  promptCounter += 1;
  session.promptName = `prompt-${promptCounter}`;
  session.lateDuplicate = text.includes('late-duplicate');
  session.respondToPrompt = true;
  saveSession(sessionId, session);
  notify('_x.ai/sessions/changed', { upserted: [{ sessionId, activity: 'working', resident: true }], removed: [] });
  chunk(sessionId, 'agent_thought_chunk', 'thinking about it');
  if (text.includes('limit')) { session.working = false; fail(id, -32603, 'You hit your weekly limit.', { detail: 'usage_limit_reached' }); return; }
  if (text.includes('fail')) { session.working = false; fail(id, -32603, 'The model service returned an internal error.'); return; }
  if (text.includes('permission')) {
    const outcome = await askClient('session/request_permission', { sessionId, toolCall: { toolCallId: 'perm-1', title: 'Run rm -rf build' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
    log({ method: 'agent-saw-permission-outcome', params: outcome });
  }
  if (text.includes('tool')) {
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_terminal_command', kind: 'execute', rawInput: { command: 'ls' } }, _meta: { totalTokens: 1500 } });
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', kind: 'execute', title: 'Execute `ls`' }, _meta: { totalTokens: 1600 } });
  }
  if (text.includes('slow') || text.includes('silent-cancel')) {
    if (text.includes('silent-cancel')) session.respondToPrompt = false;
    chunk(sessionId, 'agent_message_chunk', 'working on it');
    const finish = () => {
      if (!session.working || session.promptId !== id) return;
      session.history.push({ role: 'assistant', text: 'finished slowly' });
      saveSession(sessionId, session);
      chunk(sessionId, 'agent_message_chunk', 'finished slowly');
      endTurn(id, sessionId, session, 'end_turn');
    };
    session.holdTimer = setInterval(() => { if (holdFile && fs.existsSync(holdFile)) finish(); }, 20);
    session.cancel = () => {
      if (!session.working || session.promptId !== id) return;
      clearInterval(session.holdTimer);
      if (text.includes('silent-cancel')) { session.working = false; return; } // never answers
      endTurn(id, sessionId, session, 'cancelled');
    };
    return;
  }
  chunk(sessionId, 'agent_message_chunk', 'Hello ');
  chunk(sessionId, 'agent_message_chunk', 'from fake grok');
  session.history.push({ role: 'assistant', text: 'Hello from fake grok' });
  saveSession(sessionId, session);
  endTurn(id, sessionId, session, 'end_turn');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === undefined) { // a reply to a request this agent made
    const resolve = pendingClientRequests.get(message.id);
    if (resolve) { pendingClientRequests.delete(message.id); resolve(message.result ?? message.error); }
    return;
  }
  log({ method: message.method, params: message.params, jsonrpc: message.jsonrpc });
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      notify('_x.ai/models/update', { currentModelId: 'grok-4.7', availableModels: MODELS });
      reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], _meta: { agentVersion: '1.0.70-fake', modelState: { currentModelId: 'grok-4.7', availableModels: MODELS } } });
      break;
    case '_x.ai/auth/check_subscription':
      reply(id, { authenticated: process.env.FAKE_GROK_LOGGED_OUT !== '1', meta: { subscription_tier: 'SuperGrok' } });
      break;
    case 'session/new': {
      const sessionId = `${randomUUID()}`;
      const session = { model: flag('--model') ?? 'grok-4.7', effort: flag('--reasoning-effort') ?? 'high', history: [], cwd: params.cwd, working: false };
      resident.set(sessionId, session);
      saveSession(sessionId, session);
      notify('_x.ai/session/setup', { method: 'session/new', phase: 'finalize_response', sessionId });
      reply(id, { sessionId, models: { currentModelId: session.model, availableModels: MODELS }, configOptions: configOptions(session) });
      break;
    }
    case 'session/load': {
      const saved = loadSession(params.sessionId);
      if (!saved) { fail(id, -32603, 'Path not found.', { detail: 'No such file or directory (os error 2)', code: 'FS_NOT_FOUND' }); break; }
      const session = { ...saved, working: false };
      resident.set(params.sessionId, session);
      for (const item of saved.history) chunk(params.sessionId, item.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', item.text);
      reply(id, { models: { currentModelId: session.model, availableModels: MODELS }, configOptions: configOptions(session) });
      break;
    }
    case '_x.ai/sessions/list':
      reply(id, { result: { sessions: [...resident].map(([sessionId, session]) => ({ sessionId, cwd: session.cwd, modelId: session.model, reasoningEffort: session.effort,
        activity: session.working ? 'working' : 'idle', resident: true })) } });
      break;
    case 'session/set_config_option': {
      const session = resident.get(params.sessionId);
      if (!session) { fail(id, -32602, 'Invalid params', 'unknown session'); break; }
      if (typeof params.value !== 'string') { fail(id, -32602, 'Invalid params', 'data did not match any variant of untagged enum SessionConfigOptionValue'); break; }
      if (params.configId === 'model') {
        if (!MODELS.some(m => m.modelId === params.value)) { fail(id, -32602, 'Invalid params', 'unknown model id'); break; }
        session.model = params.value;
      } else if (params.configId === 'reasoning_effort') session.effort = params.value;
      saveSession(params.sessionId, session);
      reply(id, { configOptions: configOptions(session) });
      break;
    }
    case 'session/prompt':
      void runPrompt(id, params);
      break;
    case 'session/cancel':
      resident.get(params.sessionId)?.cancel?.();
      break;
    default:
      if (id !== undefined) fail(id, -32601, 'Method not found', `unknown ACP extension method: ${method}`);
  }
});
rl.on('close', () => process.exit(0));
