#!/usr/bin/env node
// Opt-in real-provider proof. Only disposable sessions/transcripts are faulted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildApp } from '../apps/server/dist/app.js';

if (!process.argv.includes('--run')) throw new Error('Use --run to opt into four disposable real Codex/Claude sessions. Run npm run build first.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-recovery-proof-'));
const project = path.join(root, 'projects', 'demo');
fs.mkdirSync(project, { recursive: true });
execFileSync('git', ['init', '-q', project]);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'This is a disposable Console recovery fixture. Do not edit files. Follow the test prompt and preserve its marker task until it is complete.\n');
const configPath = path.join(root, 'config.json');
const socket = `console-proof-${randomUUID().slice(0, 8)}`;
const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-console/config.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(new URL('../config/agent-console.example.json', import.meta.url), 'utf8'));
const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
Object.assign(config, { projectsRoot: path.join(root, 'projects'), runtimeDir: path.join(root, 'runtime'), databasePath: path.join(root, 'fixture.sqlite'),
  projects: { demo: { active: true, explicit: true, path: project } }, coordination: { enabled: true, pilotPaths: [project] }, workerSummaries: { enabled: false } });
Object.assign(config.server, { host: '127.0.0.1', port: 14378, publicBaseUrl: 'http://127.0.0.1:14378', webDistPath: path.resolve('apps/web/dist') });
Object.assign(config.security, { passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`, sessionSecret: randomBytes(40).toString('hex'), trustTailscaleHeaders: false });
config.sessions.pressureSuspendAvailableMiB = 512;
for (const id of ['codex', 'claude']) {
  config.providers[id] = structuredClone(installed.providers[id]);
  config.providers[id].commands.env = { ...config.providers[id].commands.env, AGENT_CONSOLE_CONFIG: configPath, AGENT_COORD_RUNTIME: config.runtimeDir, AGENT_CONSOLE_TMUX_SOCKET: socket };
}
for (const key of ['newCommand', 'resumeCommand', 'continueCommand']) {
  config.providers.codex.commands[key].push('--dangerously-bypass-hook-trust', '-c',
    `mcp_servers.agent_console_coordination.env.AGENT_COORD_RUNTIME=${JSON.stringify(config.runtimeDir)}`);
  config.providers.claude.commands[key].push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {
    agent_console_coordination: { command: 'node', args: [path.resolve('scripts/agent-coord.mjs'), 'mcp'], env: { AGENT_COORD_RUNTIME: config.runtimeDir } },
  } }));
}
process.env.AGENT_CONSOLE_TMUX_SOCKET = socket;
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
const { app } = await buildApp({ configPath });
await app.ready();
const db = new Database(config.databasePath, { readonly: true });
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
assert.equal(login.statusCode, 200);
const headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
const api = async (method, url, payload) => {
  const result = await app.inject({ method, url, payload, headers });
  assert.ok(result.statusCode < 300, `${url}: ${result.statusCode} ${result.body}`);
  return result.body ? result.json() : undefined;
};
const rpc = payload => new Promise((resolve, reject) => {
  const request = http.request({ socketPath: path.join(config.runtimeDir, 'coordination/agent.sock'), path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
    let text = ''; response.on('data', data => { text += data; }); response.on('end', () => {
      const result = JSON.parse(text); response.statusCode === 200 ? resolve(result) : reject(new Error(text));
    });
  });
  request.on('error', reject); request.end(JSON.stringify(payload));
});
const wait = async (label, predicate, timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error(`Timed out: ${label}; evidence ${root}`);
};
const senderToken = randomBytes(32).toString('hex');
const sender = await rpc({ action: 'register', provider: 'codex', nativeSessionId: randomUUID(), token: senderToken, pid: process.pid, cwd: project });
const senderAuth = { assignmentId: sender.assignmentId, token: senderToken };
const ids = [], evidence = [];
console.log(JSON.stringify({ evidence: root, socket }));
try {
  for (const provider of (process.env.PROOF_PROVIDERS ?? 'codex,claude').split(',')) {
    for (const fault of ['capacity', 'killed']) {
      const marker = `RECOVERY_${provider}_${fault}_${randomUUID().slice(0, 8)}`;
      const bound = await api('POST', `/api/conversations/demo/${provider}/new/bind`, {});
      let id = bound.session.id; ids.push(id);
      if (provider === 'codex') await wait('disposable Codex folder startup', () => {
        const screen = execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-S', '-60', '-t', bound.session.tmuxSessionName], { encoding: 'utf8' });
        if (screen.includes('Folder access') && screen.includes(project) && screen.includes('1. Trust and continue') && screen.includes('2. Quit')) {
          execFileSync('tmux', ['-L', socket, 'send-keys', '-t', bound.session.tmuxSessionName, 'Enter']); return true;
        }
        return /gpt-\d/i.test(screen);
      }, 30_000);
      await api('POST', `/api/sessions/${id}/model-profile`, { profile: 'low' });
      if (provider === 'claude') await wait('Claude profile and ready composer before initial input', async () => {
        const screen = await api('GET', `/api/sessions/${id}/screen?lines=120`);
        const state = db.prepare('select model_profile_request_json from bound_sessions where id=?').get(id);
        return !state.model_profile_request_json && screen.screen?.inputActive;
      }, 45_000);
      const prompt = `You are a disposable real-session Console recovery test. Do not edit files or launch agents. This human-authorized task remains unfinished until you send marker ${marker} to assignment ${sender.assignmentId}. First use agent_coordination update to describe the test and set continuation unattended. Then reply READY_${marker} and end this turn, preserving the assignment. On an automatic recovery/continuation, read your inbox, acknowledge its message IDs, and send exactly ${marker} to the sender with agent_coordination, then finish the assignment. Use the existing authenticated coordination tools, or their canonical node helper if a cached tool lacks continuation. Do not send the marker until you receive the test inbox message.`;
      let submitted;
      if (provider === 'claude') {
        // Match normal UI typing. Claude tags a large bracketed paste as quoted
        // content; the fixture's human instruction must be ordinary input.
        for (let offset = 0; offset < prompt.length; offset += 100)
          await api('POST', `/api/sessions/${id}/keys`, { text: prompt.slice(offset, offset + 100), deferScreenUpdate: true });
        submitted = await api('POST', `/api/sessions/${id}/keys`, { keys: ['Enter'], submittedText: prompt });
      } else submitted = await api('POST', `/api/sessions/${id}/input`, { text: prompt });
      id = submitted.session.id; ids.push(id);
      const session = () => db.prepare('select * from bound_sessions where id=?').get(id);
      const assignment = () => db.prepare('select * from coordination_assignments where provider=? and native_session_id=?').get(provider, session().conversation_ref);
      const transcript = () => db.prepare('select transcript_path from conversation_index where project_slug=? and provider=? and ref=?').get('demo', provider, session().conversation_ref)?.transcript_path;
      await wait('native setup and ready prompt', async () => {
        await api('GET', `/api/conversations/demo/${provider}/${encodeURIComponent(bound.conversationRef)}/messages?limit=0`);
        if (!assignment() || !transcript()) return false;
        const control = JSON.parse(db.prepare('select value from meta where key=?').get(`assignment-continuation:${assignment().id}`)?.value ?? '{}');
        const screen = await api('GET', `/api/sessions/${id}/screen?lines=120`);
        return control.continuation === 'unattended' && screen.screen?.inputActive && !session().is_working
          && fs.readFileSync(transcript(), 'utf8').includes(`READY_${marker}`);
      });
      const native = assignment(), before = session(), started = Date.now();
      if (fault === 'capacity') {
        const timestamp = new Date().toISOString();
        const records = provider === 'codex'
          ? [{ type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: `fixture-${marker}` } },
             { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: `fixture-${marker}`, error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.' } } }]
          : [{ type: 'user', uuid: `fixture-${marker}`, timestamp, message: { content: 'Disposable simulated provider-capacity turn.' } },
             { type: 'assistant', timestamp, isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }];
        fs.appendFileSync(transcript(), records.map(record => JSON.stringify(record)).join('\n') + '\n');
        await wait('failure scheduled', () => JSON.parse(session().run_failure_json ?? '{}').status === 'scheduled', 10_000);
      } else {
        process.kill(native.pid, 'SIGKILL');
      }
      const messageId = randomUUID();
      const queued = await rpc({ ...senderAuth, action: 'send', messageId, recipientId: native.id, text: `Recovery proof inbox: send ${marker} to my assignment, acknowledge this message, and finish this fixture.` });
      console.log(JSON.stringify({ provider, fault, nativeSession: native.native_session_id, queued: queued.delivery }));
      await wait('automatic native response and delivery', () => db.prepare('select id from coordination_messages where sender_id=? and recipient_id=? and text=?').get(native.id, sender.assignmentId, marker));
      assert.ok(db.prepare('select acknowledged_at from coordination_messages where id=?').get(messageId).acknowledged_at);
      await wait('retry badge cleared', () => !session().run_failure_json, 30_000);
      const events = fs.readFileSync(session().event_log_path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.type === 'user-input').length, 1, 'Recovery must not add a human input event');
      if (fault === 'killed') assert.notEqual(session().pid, before.pid);
      evidence.push({ provider, fault, nativeSession: native.native_session_id, sessionId: id, oldPid: before.pid, newPid: session().pid,
        elapsedMs: Date.now() - started, messageId, acknowledged: true, retryNoticeCleared: true, humanInputCount: 1 });
      fs.writeFileSync(path.join(root, 'proof.json'), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence.at(-1)));
      await api('POST', `/api/sessions/${id}/release`, {});
    }
  }
} finally {
  for (const id of ids) if (db.prepare('select should_restore from bound_sessions where id=?').get(id)?.should_restore)
    await api('POST', `/api/sessions/${id}/release`, {}).catch(() => {});
  await rpc({ ...senderAuth, action: 'finish', summary: 'Disposable recovery proof controller finished.' }).catch(() => {});
  await app.close(); db.close();
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* Releasing the last pane can exit the private tmux server. */ }
}
