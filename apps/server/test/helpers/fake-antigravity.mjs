#!/usr/bin/env node
// A stand-in for `agy acp --stdio --dangerously-skip-permissions`: an ACP agent over stdio matching Antigravity 1.5.19.
// Steered via env and prompt text:
//   ANTIGRAVITY_DATA_DIR=<dir>  where transcripts/metadata are written
//   FAKE_AGY_LOG=<file>         one JSON line per request/notification received
//   FAKE_AGY_HOLD=<file>        a prompt saying "slow" ends when this file exists or on session/cancel
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const logFile = process.env.FAKE_AGY_LOG;
const holdFile = process.env.FAKE_AGY_HOLD;
const dataDir = process.env.ANTIGRAVITY_DATA_DIR || path.join(process.env.HOME || '/tmp', '.gemini', 'antigravity-cli');

const MODELS = ['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.8-flash'];
const THOUGHT_LEVELS_FOR = (model) => (model === 'gemini-3.8-flash' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh']);
const MODES = ['default', 'accept-edits', 'plan'];

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
  const levels = THOUGHT_LEVELS_FOR(session.model);
  if (!levels.includes(session.thinking)) session.thinking = 'high';
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: MODELS.map(value => ({ value, name: value })) },
    { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: session.thinking, options: levels.map(value => ({ value, name: value })) },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: session.mode, options: MODES.map(value => ({ value, name: value })) },
  ];
}

function transcriptPath(sessionId) {
  return path.join(dataDir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

function appendStep(session, step) {
  const file = transcriptPath(session.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { step_index: session.nextStep++, status: 'DONE', created_at: new Date().toISOString(), ...step };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  const metaPath = path.join(dataDir, 'cache', 'conversation_metadata.json');
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  let existing = { conversations: {} };
  try { existing = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* fresh */ }
  existing.conversations[session.id] = {
    summary: { ID: session.id, Title: session.title, UpdatedAt: record.created_at, WorkspaceURIs: session.cwd ? [pathToFileURL(session.cwd).href] : [], Internal: false },
    is_internal: false,
  };
  fs.writeFileSync(metaPath, JSON.stringify(existing, null, 2));
}

function usage(sessionId, used) {
  notify('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used, size: 1048576 } });
}

function chunk(sessionId, kind, text) {
  notify('session/update', { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } } });
}

function endTurn(id, session, stopReason) {
  session.working = false;
  clearInterval(session.holdTimer);
  reply(id, { stopReason });
  session.promptId = undefined;
}

function runPrompt(id, params) {
  const session = resident.get(params.sessionId);
  if (!session) { fail(id, -32602, 'unknown session'); return; }
  const blocks = params.prompt ?? [];
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
  session.working = true;
  session.promptId = id;
  appendStep(session, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });

  if (text.includes('rate-limit')) {
    session.working = false;
    fail(id, 429, 'RESOURCE_EXHAUSTED: Google AI Pro quota exceeded');
    return;
  }
  if (text.includes('tool')) {
    chunk(session.id, 'agent_thought_chunk', 'thinking');
    notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_command', kind: 'execute' } });
    notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', kind: 'execute', title: 'Run `ls`' } });
  }
  if (text.includes('slow')) {
    chunk(session.id, 'agent_message_chunk', 'working...');
    const finish = () => {
      if (!session.working || session.promptId !== id) return;
      chunk(session.id, 'agent_message_chunk', 'done');
      usage(session.id, 2048);
      appendStep(session, { source: 'MODEL', type: 'PLANNER_RESPONSE', model: `${session.model}-${session.thinking}`, content: 'done' });
      endTurn(id, session, 'end_turn');
    };
    session.holdTimer = setInterval(() => { if (holdFile && fs.existsSync(holdFile)) finish(); }, 20);
    session.cancel = () => {
      if (!session.working || session.promptId !== id) return;
      clearInterval(session.holdTimer);
      endTurn(id, session, 'cancelled');
    };
    return;
  }
  chunk(session.id, 'agent_message_chunk', 'Hello from fake antigravity');
  usage(session.id, 1024);
  appendStep(session, { source: 'MODEL', type: 'PLANNER_RESPONSE', model: `${session.model}-${session.thinking}`, content: 'Hello from fake antigravity' });
  endTurn(id, session, 'end_turn');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log({ method: message.method, params: message.params, jsonrpc: message.jsonrpc });
  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.19-fake' },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
      });
      break;
    case 'session/new': {
      const sessionId = randomUUID();
      const session = { id: sessionId, model: 'gemini-4-neon', thinking: 'high', mode: 'default', cwd: params.cwd, title: 'Fake AGY', working: false, nextStep: 0 };
      resident.set(sessionId, session);
      reply(id, { sessionId, configOptions: configOptions(session) });
      setTimeout(() => {
        notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] } });
      }, 5);
      break;
    }
    case 'session/load': {
      const file = transcriptPath(params.sessionId);
      if (!fs.existsSync(file)) { fail(id, -32602, 'session not found'); break; }
      const session = resident.get(params.sessionId) ?? { id: params.sessionId, model: 'gemini-4-neon', thinking: 'high', mode: 'default', cwd: params.cwd, title: 'Fake AGY', working: false, nextStep: 10 };
      resident.set(params.sessionId, session);
      chunk(session.id, 'agent_message_chunk', 'replayed reply');
      reply(id, { sessionId: session.id, configOptions: configOptions(session) });
      break;
    }
    case 'session/set_config_option': {
      const session = resident.get(params.sessionId);
      if (!session) { fail(id, -32602, 'unknown session'); break; }
      if (params.configId === 'model') {
        if (!MODELS.includes(params.value)) { fail(id, -32602, 'unknown model'); break; }
        session.model = params.value;
      } else if (params.configId === 'thought_level') {
        if (!THOUGHT_LEVELS_FOR(session.model).includes(params.value)) { fail(id, -32602, 'unsupported thought_level'); break; }
        session.thinking = params.value;
      } else if (params.configId === 'mode') {
        if (!MODES.includes(params.value)) { fail(id, -32602, 'unknown mode'); break; }
        session.mode = params.value;
      } else { fail(id, -32602, 'unknown config'); break; }
      reply(id, { configOptions: configOptions(session) });
      break;
    }
    case 'session/prompt':
      runPrompt(id, params);
      break;
    case 'session/cancel':
      resident.get(params.sessionId)?.cancel?.();
      break;
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }
});
