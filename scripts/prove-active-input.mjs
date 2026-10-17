#!/usr/bin/env node
// Opt-in integration proof: actual provider terminals, model calls and authenticated Console input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildApp } from '../apps/server/dist/app.js';

if (!process.argv.includes('--run')) throw Error('Build first, then use --run to opt into real disposable Codex/Claude input tests.');
const checkout = path.resolve(new URL('..', import.meta.url).pathname);
// Keep the private coordination Unix-socket path below Linux's 108-byte limit.
const root = path.join(os.homedir(), '.local/state/agent-console-diagnostics', `ai-${randomUUID().slice(0, 8)}`);
const project = path.join(root, 'projects/demo');
fs.mkdirSync(project, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
execFileSync('git', ['init', '-q', project]);
const configPath = path.join(root, 'config.json');
const socket = `active-input-${randomUUID().slice(0, 8)}`;
const config = JSON.parse(fs.readFileSync(path.join(checkout, 'config/agent-console.example.json'), 'utf8'));
const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-console/config.json'), 'utf8'));
const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
Object.assign(config, { projectsRoot: path.join(root, 'projects'), runtimeDir: path.join(root, 'runtime'),
  databasePath: path.join(root, 'fixture.sqlite'), projects: { demo: { active: true, explicit: true, path: project } },
  coordination: { enabled: true, pilotPaths: [] }, workerSummaries: { enabled: false } });
Object.assign(config.server, { host: '127.0.0.1', port: 14383, publicBaseUrl: 'http://127.0.0.1:14383',
  webDistPath: path.join(checkout, 'apps/web/dist') });
Object.assign(config.security, { passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
  sessionSecret: randomBytes(40).toString('hex'), trustTailscaleHeaders: false, cookieSecure: false });
config.sessions.pressureSuspendAvailableMiB = 512;
for (const provider of ['codex', 'claude']) {
  config.providers[provider] = structuredClone(installed.providers[provider]);
  config.providers[provider].commands.env = { ...config.providers[provider].commands.env,
    AGENT_CONSOLE_CONFIG: configPath, AGENT_COORD_RUNTIME: config.runtimeDir, AGENT_CONSOLE_TMUX_SOCKET: socket };
}
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
process.env.AGENT_CONSOLE_TMUX_SOCKET = socket;
const { app } = await buildApp({ configPath });
app.log.level = 'warn';
await app.ready();
const db = new Database(config.databasePath, { readonly: true });
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
assert.equal(login.statusCode, 200);
const headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
const api = async (method, url, payload) => {
  const response = await app.inject({ method, url, payload, headers });
  assert.ok(response.statusCode < 300, `${url}: ${response.statusCode} ${response.body}`);
  return response.body ? response.json() : undefined;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (label, predicate, timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await pause(500); }
  throw Error(`Timed out: ${label}; evidence ${root}`);
};
const capture = session => execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', session.tmuxSessionName], { encoding: 'utf8' });
const textOf = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map(part => part.text ?? '').join('\n');
const evidence = [];
const save = () => fs.writeFileSync(path.join(root, 'proof.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ evidence: root, socket }));
try {
  for (const provider of (process.env.PROOF_PROVIDERS ?? 'codex,claude').split(',')) {
    assert.ok(['codex', 'claude'].includes(provider));
    const label = `${provider}-${randomUUID().slice(0, 8)}`;
    const startedFile = path.join(project, `${label}-started`), finishedFile = path.join(project, `${label}-finished`);
    const toolFile = `${label}-tool.py`;
    fs.writeFileSync(path.join(project, toolFile), `import pathlib, time\npathlib.Path(${JSON.stringify(startedFile)}).write_text(str(time.time()))\ntime.sleep(20)\npathlib.Path(${JSON.stringify(finishedFile)}).write_text(str(time.time()))\nprint('FOREGROUND_TOOL_FINISHED')\n`);
    const original = `ORIGINAL_COMPLETE_${label}`;
    const token = `MIDTURN_RECEIVED_${label}`;
    const initial = `Run python3 ${toolFile} once with your shell tool in the foreground, timeout 60000ms (yield_time_ms=30000 if supported). Wait for completion. Then reply exactly ${original}. Do not edit files, run other work, or launch agents.`;
    const followup = `Acknowledge this message in your next visible reply with ${token}. Let the existing foreground tool finish normally, then make your final reply exactly ${token}. Do not restart it or start other work.`;
    const bound = await api('POST', `/api/conversations/demo/${provider}/new/bind`, {});
    let session = bound.session;
    await wait(`${provider} native startup`, async () => {
      if (provider === 'codex') {
        const screen = capture(session);
        if (screen.includes('Folder access') && screen.includes(project)
          && screen.includes('1. Trust and continue') && screen.includes('2. Quit')) {
          await api('POST', `/api/sessions/${session.id}/keys`, { keys: ['Enter'] });
        }
      }
      const state = await api('GET', `/api/sessions/${session.id}/screen?lines=120`);
      return state.screen?.inputActive && !state.screen.inputText.trim();
    }, 60_000);
    await api('POST', `/api/sessions/${session.id}/model-profile`, { profile: 'low' });
    await wait(`${provider} low profile ready`, async () => {
      const state = await api('GET', `/api/sessions/${session.id}/screen?lines=120`);
      return !state.session.modelProfileRequest && state.screen?.inputActive && !state.screen.inputText.trim();
    }, 60_000);
    const submitted = await api('POST', `/api/sessions/${session.id}/input`, { text: initial });
    session = submitted.session;
    await wait(`${provider} real foreground tool started`, () => fs.existsSync(startedFile));
    const before = await api('GET', `/api/sessions/${session.id}/screen?lines=120`);
    fs.writeFileSync(path.join(root, `${provider}-before.txt`), capture(session));
    assert.equal(fs.existsSync(finishedFile), false, 'The tool must still be running at injection.');
    assert.equal(before.session.isWorking, true, 'The native turn must be running.');
    assert.equal(before.screen.inputActive, true, 'A real native composer must be available.');
    assert.equal(before.screen.inputText.trim(), '');
    const injectedAt = new Date().toISOString(), requestId = randomUUID();
    const receipt = await api('POST', `/api/sessions/${session.id}/keys`, {
      text: followup, submittedText: followup, keys: ['Enter'], submissionId: requestId,
    });
    evidence.push({ provider, status: 'injected', sessionId: session.id, panePid: before.session.pid,
      requestId, injectedAt, toolWasRunning: true, requestSubmitted: !receipt.queuedInput,
      recordedInput: receipt.recordedUserInput?.text === followup });
    save();
    assert.equal(receipt.queuedInput, undefined, 'Human input must submit while the original turn is running.');
    assert.equal(receipt.recordedUserInput?.text, followup);
    const transcript = await wait(`${provider} transcript adoption`, async () => {
      await api('GET', `/api/conversations/demo/${provider}/${encodeURIComponent(bound.conversationRef)}/messages?limit=0`);
      const current = db.prepare('select * from bound_sessions where id=?').get(session.id);
      return db.prepare('select transcript_path from conversation_index where project_slug=? and provider=? and ref=?')
        .get('demo', provider, current.conversation_ref)?.transcript_path;
    });
    const records = () => fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const firstFinish = rows => provider === 'codex'
      ? rows.findIndex(row => row.type === 'event_msg' && row.payload?.type === 'task_complete')
      : rows.findIndex(row => row.type === 'assistant' && row.message?.stop_reason === 'end_turn'
        && textOf(row.message).trim());
    await wait(`${provider} first native turn completed`, () => firstFinish(records()) >= 0);
    const rows = records(), finishIndex = firstFinish(rows), originalTurn = rows.slice(0, finishIndex + 1);
    const assistant = originalTurn.filter(row => provider === 'codex'
      ? row.type === 'response_item' && row.payload?.role === 'assistant'
      : row.type === 'assistant').map(row => textOf(row.payload ?? row.message)).join('\n');
    assert.ok(assistant.includes(token), 'The follow-up must be answered within the first native turn.');
    assert.ok(!assistant.includes(original), 'The original final answer must be replaced before that turn ends.');
    const inputs = rows.filter(row => provider === 'codex'
      ? row.type === 'response_item' && row.payload?.role === 'user' && textOf(row.payload).includes(token)
      : row.type === 'queue-operation' && row.operation === 'enqueue' && row.content === followup);
    assert.equal(inputs.length, 1, 'The real provider must receive the follow-up exactly once.');
    if (provider === 'claude') {
      const absorbed = rows.filter(row => row.type === 'queue-operation' && row.operation === 'remove'
        && row.reason === 'absorbed_mid_turn' && row.content === followup);
      assert.equal(absorbed.length, 1, 'Claude must absorb the follow-up within its original running turn.');
      assert.ok(absorbed[0].timestamp < rows[finishIndex].timestamp);
    }
    const after = await api('GET', `/api/sessions/${session.id}/screen?lines=120`);
    assert.equal(after.session.pid, before.session.pid, 'The native session must not be replaced.');
    assert.ok(fs.existsSync(finishedFile), 'The original foreground tool must finish without interruption.');
    fs.writeFileSync(path.join(root, `${provider}-after.txt`), capture(session));
    fs.copyFileSync(transcript, path.join(root, `${provider}-transcript.jsonl`));
    Object.assign(evidence.at(-1), { status: 'passed', nativeTranscript: transcript,
      firstTurnFinishedAt: rows[finishIndex].timestamp, answeredWithinOriginalTurn: true,
      nativeFollowupCount: inputs.length, panePidPreserved: true, originalToolCompleted: true });
    save(); console.log(JSON.stringify(evidence.at(-1)));
    await api('POST', `/api/sessions/${session.id}/release`, {});
  }
} catch (error) {
  fs.writeFileSync(path.join(root, 'failure.txt'), error.stack ?? String(error));
  throw error;
} finally {
  for (const row of db.prepare('select id from bound_sessions where should_restore=1').all()) {
    const state = db.prepare('select * from bound_sessions where id=?').get(row.id);
    try { fs.writeFileSync(path.join(root, `cleanup-${row.id}.txt`), capture({ tmuxSessionName: state.tmux_session_name })); } catch {}
    await api('POST', `/api/sessions/${row.id}/release`, {}).catch(() => {});
  }
  await app.close(); db.close();
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
}
