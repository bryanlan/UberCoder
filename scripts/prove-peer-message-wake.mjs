#!/usr/bin/env node
// Opt-in real-provider proof of inbox replies while waiting for a human decision.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildApp } from '../apps/server/dist/app.js';
import { parseClaudeConversationFile } from '../apps/server/dist/providers/transcripts/claude.js';

if (!process.argv.includes('--run')) throw new Error('Use --run to opt into disposable real Codex/Claude inbox sessions. Run npm run build first.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-peer-wake-proof-'));
const project = path.join(root, 'projects', 'demo');
fs.mkdirSync(project, { recursive: true });
const senderProject = path.join(root, 'projects', 'sender'); fs.mkdirSync(senderProject, { recursive: true });
execFileSync('git', ['init', '-q', project]);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'This is a disposable Console peer-message wake fixture. Do not edit files. Follow the test prompt and preserve its marker task until it is complete.\n');
const configPath = path.join(root, 'config.json');
let fixtureClaudeExecutable;
if (process.env.PROOF_CLAUDE_EXECUTABLE) {
  // The host hook identifies its native owner by the provider process name.
  // Preserve that identity when testing an installed versioned binary.
  fixtureClaudeExecutable = path.join(root, 'bin', 'claude');
  fs.mkdirSync(path.dirname(fixtureClaudeExecutable));
  fs.copyFileSync(process.env.PROOF_CLAUDE_EXECUTABLE, fixtureClaudeExecutable); fs.chmodSync(fixtureClaudeExecutable, 0o700);
}
const fixtureHooks = Object.fromEntries(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'].map(event => [event, [{ hooks: [{ type: 'command', command: `node '${path.resolve('scripts/agent-coord.mjs').replaceAll("'", "'\\''")}' hook claude`, timeout: 3 }] }]]));
const socket = `console-proof-${randomUUID().slice(0, 8)}`;
const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-console/config.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(new URL('../config/agent-console.example.json', import.meta.url), 'utf8'));
const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
Object.assign(config, { projectsRoot: path.join(root, 'projects'), runtimeDir: path.join(root, 'runtime'), databasePath: path.join(root, 'fixture.sqlite'),
  projects: { demo: { active: true, explicit: true, path: project }, sender: { active: true, explicit: true, path: senderProject } }, coordination: { enabled: true, pilotPaths: [project] }, workerSummaries: { enabled: false } });
Object.assign(config.server, { host: '127.0.0.1', port: 14379, publicBaseUrl: 'http://127.0.0.1:14379', webDistPath: path.resolve('apps/web/dist') });
Object.assign(config.security, { passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`, sessionSecret: randomBytes(40).toString('hex'), trustTailscaleHeaders: false });
config.sessions.pressureSuspendAvailableMiB = 512;
for (const id of ['codex', 'claude']) {
  config.providers[id] = structuredClone(installed.providers[id]);
  config.providers[id].commands.env = { ...config.providers[id].commands.env, AGENT_CONSOLE_CONFIG: configPath, AGENT_COORD_RUNTIME: config.runtimeDir, AGENT_CONSOLE_TMUX_SOCKET: socket };
}
for (const key of ['newCommand', 'resumeCommand', 'continueCommand']) {
  if (fixtureClaudeExecutable) config.providers.claude.commands[key][0] = fixtureClaudeExecutable;
  config.providers.codex.commands[key].push('--dangerously-bypass-hook-trust', '-c',
    `mcp_servers.agent_console_coordination.env.AGENT_COORD_RUNTIME=${JSON.stringify(config.runtimeDir)}`);
  config.providers.claude.commands[key].push('--setting-sources', '', '--settings', JSON.stringify({ hooks: fixtureHooks }));
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
const sender = await rpc({ action: 'register', provider: 'codex', nativeSessionId: randomUUID(), token: senderToken, pid: process.pid, cwd: senderProject });
const senderAuth = { assignmentId: sender.assignmentId, token: senderToken };
const ids = [], evidence = [];
const proofStartedAt = Date.now();
let lastBeat = performance.now(), maxEventLoopGapMs = 0, loadPasses = 0, loadError;
const heartbeat = setInterval(() => { const now = performance.now(); maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastBeat); lastBeat = now; }, 20);
let loadRun;
const load = () => {
  if (!process.env.PROOF_METADATA_LOAD || loadRun) return;
  loadRun = parseClaudeConversationFile({ filePath: process.env.PROOF_METADATA_LOAD, provider: 'claude', projectSlug: 'load', conversationRef: 'read-only-load' })
    .then(() => { loadPasses++; }, error => { loadError = error; }).finally(() => { loadRun = undefined; });
};
const loadTimer = setInterval(load, 2000); load();
console.log(JSON.stringify({ evidence: root, socket }));
try {
  for (const provider of (process.env.PROOF_PROVIDERS ?? 'codex,claude').split(',')) {
    const marker = `PEER_WAITING_${provider}_${randomUUID().slice(0, 8)}`;
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
    if (provider === 'claude') await wait('Claude profile and ready composer', async () => {
      const screen = await api('GET', `/api/sessions/${id}/screen?lines=120`);
      return !db.prepare('select model_profile_request_json from bound_sessions where id=?').get(id).model_profile_request_json && screen.screen?.inputActive;
    }, 45_000);
    const prompt = `This is a disposable Console inbox test. Do not edit files or launch agents. Your existing human-authorized test task is to receive a peer message from assignment ${sender.assignmentId}, acknowledge it and send exactly ${marker} back to that assignment. First use agent_coordination update to set continuation waiting_for_input and describe this fixture. Reply READY_${marker} and end this turn without finishing the assignment. Bryan has a pending decision choosing option A or B: keep that decision pending; a peer response cannot choose it. When a peer-inbox wake arrives, acknowledge the peer message, send the marker, then report that the A/B decision is still pending and return to waiting_for_input without finishing. Do not enable unattended continuation or poll for new messages.`;
    let submitted;
    if (provider === 'claude') {
      for (let offset = 0; offset < prompt.length; offset += 100)
        await api('POST', `/api/sessions/${id}/keys`, { text: prompt.slice(offset, offset + 100), deferScreenUpdate: true });
      submitted = await api('POST', `/api/sessions/${id}/keys`, { keys: ['Enter'], submittedText: prompt });
    } else submitted = await api('POST', `/api/sessions/${id}/input`, { text: prompt });
    id = submitted.session.id; ids.push(id);
    const session = () => db.prepare('select * from bound_sessions where id=?').get(id);
    const assignment = () => db.prepare('select * from coordination_assignments where provider=? and native_session_id=?').get(provider, session().conversation_ref);
    const control = () => JSON.parse(db.prepare('select value from meta where key=?').get(`assignment-continuation:${assignment().id}`)?.value ?? '{}');
    const transcript = () => db.prepare('select transcript_path from conversation_index where project_slug=? and provider=? and ref=?').get('demo', provider, session().conversation_ref)?.transcript_path;
    await wait('native fixture waiting for Bryan', async () => {
      await api('GET', `/api/conversations/demo/${provider}/${encodeURIComponent(bound.conversationRef)}/messages?limit=0`);
      if (!assignment() || !transcript()) return false;
      const screen = await api('GET', `/api/sessions/${id}/screen?lines=120`);
      return control().continuation === 'waiting_for_input' && screen.screen?.inputActive && !session().is_working
        && fs.readFileSync(transcript(), 'utf8').includes(`READY_${marker}`);
    });
    const native = assignment(), before = control(), messageId = randomUUID(), started = Date.now();
    const queued = await rpc({ ...senderAuth, action: 'send', messageId, recipientId: native.id, text: `The existing test inbox message has arrived. Send the authorized marker ${marker} and keep the A/B human decision pending.` });
    assert.equal(queued.delivery, 'wake_pending');
    await wait('real native acknowledgement and reply', () => db.prepare('select id from coordination_messages where sender_id=? and recipient_id=? and text=?').get(native.id, sender.assignmentId, marker));
    assert.ok(db.prepare('select acknowledged_at from coordination_messages where id=?').get(messageId).acknowledged_at);
    const receipt = await rpc({ ...senderAuth, action: 'send', messageId, recipientId: native.id, text: `The existing test inbox message has arrived. Send the authorized marker ${marker} and keep the A/B human decision pending.` });
    assert.equal(receipt.delivery, 'acknowledged');
    await wait('response turn ends with decision pending', async () => {
      const screen = await api('GET', `/api/sessions/${id}/screen?lines=120`);
      return screen.screen?.inputActive && !session().is_working && assignment().status === 'waiting';
    });
    assert.equal(control().continuation, 'waiting_for_input');
    assert.equal(control().recovery, null);
    const events = fs.readFileSync(session().event_log_path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.type === 'user-input').length, 1, 'Peer wake must add no human input');
    const attempt = JSON.parse(db.prepare('select value from meta where key=?').get(`peer-wake-attempt:${messageId}`).value);
    assert.equal(attempt.status, 'submitted');
    // Exercise a real human Stop after the inbox response, then send a new message.
    await api('POST', `/api/sessions/${id}/keys`, { keys: ['Escape'] });
    const pausedId = randomUUID();
    const paused = await rpc({ ...senderAuth, action: 'send', messageId: pausedId, recipientId: native.id, text: `Stay manually stopped; this peer message must not wake you. ${marker}` });
    assert.equal(paused.delivery, 'on_resume');
    await new Promise(resolve => setTimeout(resolve, 17_000));
    assert.equal(db.prepare('select value from meta where key=?').get(`peer-wake-attempt:${pausedId}`), undefined);
    assert.equal(db.prepare('select acknowledged_at from coordination_messages where id=?').get(pausedId).acknowledged_at, null);
    if (loadError) throw loadError;
    if (process.env.PROOF_METADATA_LOAD) {
      assert.ok(loadPasses > 0, 'Metadata load was not exercised');
      assert.ok(maxEventLoopGapMs < 500, `Backend stalled for ${maxEventLoopGapMs}ms`);
    }
    const failureDir = path.join(config.runtimeDir, 'coordination/telemetry');
    const hookFailures = fs.readdirSync(failureDir).filter(name => name.endsWith('.failures.jsonl'))
      .flatMap(name => fs.readFileSync(path.join(failureDir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
      .filter(record => record.timestamp >= proofStartedAt && record.kind === 'hook' && record.outcome === 'error');
    assert.equal(hookFailures.length, 0, 'Native hooks failed during the proof');
    evidence.push({ metadataLoadPasses: loadPasses, maxEventLoopGapMs, hookFailureCount: hookFailures.length, provider, nativeSession: native.native_session_id, sessionId: id, messageId, acknowledged: true,
      reply: marker, elapsedMs: Date.now() - started, continuationBefore: before.continuation,
      continuationAfter: control().continuation, recovery: control().recovery, humanInputCount: 1, manualStopPreserved: true });
    fs.writeFileSync(path.join(root, 'proof.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence.at(-1)));
    await api('POST', `/api/sessions/${id}/release`, {});
  }
} finally {
  clearInterval(heartbeat); clearInterval(loadTimer); await loadRun;
  for (const id of ids) if (db.prepare('select should_restore from bound_sessions where id=?').get(id)?.should_restore)
    await api('POST', `/api/sessions/${id}/release`, {}).catch(() => {});
  await rpc({ ...senderAuth, action: 'finish', summary: 'Disposable waiting-agent inbox proof controller finished.' }).catch(() => {});
  await app.close(); db.close();
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* Last pane can exit the private server. */ }
}
