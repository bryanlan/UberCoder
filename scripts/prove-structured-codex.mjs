#!/usr/bin/env node
// Opt-in real-Codex proof of the structured provider lane (docs/structured-providers.md, "Verification").
//
// Starts an isolated Console backend (temp root, temp database, temp runtime, scratch git project, private tmux
// socket) with `structuredSessions.codex.enabled`, then drives ONE structured Codex conversation through the HTTP
// API the web client uses: bind, send, coordination hook and MCP, steer, Stop, model profile, manual sleep and
// restore, backend restart and release. Real Codex turns run with the host's ChatGPT login; every prompt is one
// short fixed sentence.
//
// Usage (build first):  env -u NODE_ENV npm run build
//                       env -u NODE_ENV node scripts/prove-structured-codex.mjs --run > /tmp/proof-backend.log
// Step results go to stderr (one `PROOF` line each); fastify's request log goes to stdout. Evidence JSON is
// written after every step to test-results/structured-codex-proof/<timestamp>.json. Message bodies are never
// printed or recorded; only the fixed prompts below are sent.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

if (!process.argv.includes('--run')) {
  process.stderr.write('Use --run to opt into a real Codex app-server proof (several short turns on the host login). Run `npm run build` first.\n');
  process.exit(2);
}

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { buildApp } = await import(new URL('../apps/server/dist/app.js', import.meta.url));
const { CODEX_COST_PROFILES } = await import('@agent-console/shared');

// ---- prompts (the only message text this proof ever sends) -----------------------------------------------
const PROMPTS = {
  first: 'Reply with exactly the single word PONG and nothing else.',
  coordination: 'Call the agent_coordination MCP tool with action status. If the call succeeded, reply with exactly the single word REGISTERED and nothing else.',
  count: 'Run exactly this shell command and wait for it to finish before replying: for i in $(seq 1 30); do echo $i; sleep 1; done',
  steer: 'Stop counting now and reply with the single word STEERED.',
  model: 'Reply with the single word MODEL.',
  settle: 'Reply with the single word SETTLED.',
  restored: 'Reply with the single word RESTORED.',
  resumed: 'Reply with the single word RESUMED.',
};
const TURN_TIMEOUT_MS = 180_000;

// ---- isolated environment ----------------------------------------------------------------------------------
const startedAt = new Date();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-structured-proof-'));
const project = path.join(root, 'projects', 'demo');
fs.mkdirSync(project, { recursive: true });
execFileSync('git', ['init', '-q', project]);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'This is a disposable Console proof project. Do not edit files. Follow each short test prompt exactly.\n');
const configPath = path.join(root, 'config.json');
const runtimeDir = path.join(root, 'runtime');
const databasePath = path.join(root, 'fixture.sqlite');
const tmuxSocket = `console-structured-proof-${randomUUID().slice(0, 8)}`;
const coordHelper = path.join(repoRoot, 'scripts/agent-coord.mjs');

const freePort = async () => {
  for (let port = 14390; port <= 14399; port += 1) {
    const free = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No free port in 14390-14399.');
};
const port = await freePort();

const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/agent-console.example.json'), 'utf8'));
const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-console/config.json'), 'utf8'));
const password = randomBytes(24).toString('hex');
const salt = randomBytes(16).toString('hex');
Object.assign(config, {
  projectsRoot: path.join(root, 'projects'), runtimeDir, databasePath,
  projects: { demo: { active: true, explicit: true, path: project } },
  coordination: { enabled: true, pilotPaths: [project] },
  workerSummaries: { enabled: false },
  conversationTitles: { enabled: false, runtimeCommand: config.conversationTitles.runtimeCommand },
  // The global coordination MCP entry pins AGENT_COORD_RUNTIME to the live runtime; override it for this process only.
  structuredSessions: { codex: {
    enabled: true, idleUnloadMinutes: 60, env: {},
    command: ['codex', 'app-server',
      '-c', `mcp_servers.agent_console_coordination.env.AGENT_COORD_RUNTIME=${JSON.stringify(runtimeDir)}`,
      '-c', `mcp_servers.agent_console_coordination.args=${JSON.stringify([coordHelper, 'mcp'])}`],
  } },
});
Object.assign(config.server, { host: '127.0.0.1', port, publicBaseUrl: `http://127.0.0.1:${port}`, webDistPath: path.join(repoRoot, 'apps/web/dist') });
Object.assign(config.security, {
  passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
  sessionSecret: randomBytes(40).toString('hex'), trustTailscaleHeaders: false,
});
config.sessions.pressureSuspendAvailableMiB = 512;
config.providers.codex = structuredClone(installed.providers.codex);
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
// A structured session must never reach tmux; if it did, the call would land on this private, empty socket.
process.env.AGENT_CONSOLE_TMUX_SOCKET = tmuxSocket;

// ---- evidence ------------------------------------------------------------------------------------------------
const evidenceDir = path.join(repoRoot, 'test-results/structured-codex-proof');
fs.mkdirSync(evidenceDir, { recursive: true });
const evidencePath = path.join(evidenceDir, `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
const codexVersion = (() => { try { return execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const evidence = {
  script: 'scripts/prove-structured-codex.mjs', startedAt: startedAt.toISOString(), finishedAt: null,
  revision: (() => { try { return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
  codexVersion, node: process.version, tempRoot: root, runtimeDir, port, threadId: null, sessionId: null,
  pids: {}, models: {}, steps: [], cleanup: [], result: 'running',
};
const flush = () => fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
const say = line => process.stderr.write(`PROOF ${line}\n`);
const brief = values => Object.entries(values).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' ');
say(`evidence ${evidencePath}`);
say(`temp root ${root} (removed at the end); ${codexVersion}`);

// ---- backend, auth, helpers --------------------------------------------------------------------------------
let app;
let db;
let headers;
const boot = async () => {
  ({ app } = await buildApp({ configPath }));
  await app.ready();
  db = new Database(databasePath, { readonly: true });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  assert.equal(login.statusCode, 200, `login: ${login.statusCode}`);
  headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
};
const shutdown = async () => {
  const closing = app;
  app = undefined;
  try { db?.close(); } catch { /* already closed */ }
  db = undefined;
  if (closing) await closing.close();
};
const call = async (method, url, payload) => {
  const response = await app.inject({ method, url, payload, headers });
  return { status: response.statusCode, body: response.body ? (() => { try { return response.json(); } catch { return undefined; } })() : undefined };
};
const api = async (method, url, payload) => {
  const { status, body } = await call(method, url, payload);
  assert.ok(status < 300, `${method} ${url.replace(/[0-9a-f-]{36}/g, ':id')}: HTTP ${status} ${body?.error ?? ''}`);
  return body;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (label, predicate, timeout = TURN_TIMEOUT_MS, interval = 500) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeout / 1000)} s: ${label}`);
    await sleep(interval);
  }
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const listProcesses = () => {
  const found = spawnSync('pgrep', ['-f', root], { encoding: 'utf8' });
  return found.stdout.split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid);
};

// ---- session accessors -------------------------------------------------------------------------------------
let sessionId;
let threadId;
const row = () => db.prepare('select * from bound_sessions where id = ?').get(sessionId);
const sessionState = async () => (await api('GET', `/api/sessions/${sessionId}/screen`)).session;
const indexRow = () => db.prepare('select transcript_path from conversation_index where project_slug = ? and provider = ? and ref = ?').get('demo', 'codex', threadId);
const assignment = () => db.prepare('select * from coordination_assignments where provider = ? and native_session_id = ?').get('codex', threadId);
const timeline = async () => (await api('GET', `/api/conversations/demo/codex/${encodeURIComponent(threadId)}/messages?limit=200`)).messages ?? [];
const assistantHas = async marker => (await timeline()).some(message => message.role === 'assistant' && message.text.includes(marker));
const rolloutPath = () => indexRow()?.transcript_path ?? undefined;
const rolloutRecords = () => {
  const file = rolloutPath();
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
};
const queueRecord = requestId => {
  const found = db.prepare('select value from meta where key = ?').get(`session-input:${sessionId}:${requestId}`);
  return found ? JSON.parse(found.value) : undefined;
};
const idle = async () => (await sessionState()).isWorking !== true;

/** Send one chat message the way the web client does and return the queue record it produced. */
const send = async text => {
  const submissionId = randomUUID();
  const response = await api('POST', `/api/sessions/${sessionId}/keys`, { submissionId, submittedText: text, text, keys: ['Enter'] });
  const record = queueRecord(submissionId);
  assert.ok(record, 'The queued-input record is missing.');
  return { submissionId, record, response };
};
/** Wait until the turn is over and an assistant message carries the marker. */
const waitForReply = marker => wait(`assistant reply containing ${marker}`, async () => (await idle()) && (await assistantHas(marker)));
const toolCallsSince = (skip, pattern) => rolloutRecords().slice(skip).filter(record => {
  const type = record.payload?.type;
  return record.type !== 'turn_context' && /(?:function_call|custom_tool_call|local_shell_call|tool_call_begin|tool_call_end|exec_command)/.test(type ?? '')
    && (!pattern || JSON.stringify(record).includes(pattern));
});

/**
 * Codex records sampling retries (for example `429 Too Many Requests` with a long server-chosen backoff) in its own
 * log database, not in the rollout. A turn that waits out such a backoff looks hung from the Console, so the
 * evidence names every retry of this thread. Read-only; best effort.
 */
const providerRetries = () => {
  if (!threadId) return undefined;
  try {
    const file = fs.readdirSync(path.join(os.homedir(), '.codex')).filter(name => /^logs_\d+\.sqlite$/.test(name)).sort().at(-1);
    if (!file) return undefined;
    const logs = new Database(path.join(os.homedir(), '.codex', file), { readonly: true, fileMustExist: true });
    try {
      return logs.prepare("select ts, feedback_log_body as body from logs where thread_id = ? and target = 'codex_core::responses_retry' order by id").all(threadId)
        .map(({ ts, body }) => ({
          at: new Date(ts * 1000).toISOString(),
          attempt: body.match(/retries=(\d+)/)?.[1],
          backoffSeconds: Math.round(Number(body.match(/in ([\d.]+)s\)/)?.[1] ?? NaN)),
          cause: body.match(/last status: ([^\n]*)$/)?.[1]?.trim() ?? body.match(/sampling_error=([^\n]*)$/)?.[1]?.trim(),
        }));
    } finally { logs.close(); }
  } catch { return undefined; }
};

// ---- step runner ---------------------------------------------------------------------------------------------
let aborted = false;
/** A failed step can leave a turn running; stop it so the next step is judged on its own. */
const ensureIdle = async entry => {
  if (!sessionId || !app || !db || await idle()) return;
  try { await wait('the previous turn to end', idle, 20_000, 500); return; } catch { /* still working: stop it */ }
  entry.values.stoppedLeftoverTurn = true;
  await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
  await wait('the leftover turn to stop', idle, 20_000, 500);
};
const step = async (id, name, fn, { fatal = false } = {}) => {
  const entry = { id, name, pass: false, skipped: false, ms: 0, values: {} };
  if (aborted) {
    entry.skipped = true;
    entry.error = 'Skipped: an earlier fatal step failed.';
  } else {
    const t0 = Date.now();
    try {
      await ensureIdle(entry);
      await fn(entry.values);
      entry.pass = true;
    } catch (error) {
      entry.error = String(error instanceof Error ? error.message : error).slice(0, 600);
      if (fatal) aborted = true;
    }
    entry.ms = Date.now() - t0;
  }
  evidence.steps.push(entry);
  flush();
  say(`${entry.skipped ? 'SKIP' : entry.pass ? 'PASS' : 'FAIL'} ${id}. ${name} (${entry.ms} ms)${entry.error ? ` -- ${entry.error}` : ` ${brief(entry.values)}`}`);
};

// ---- the proof -----------------------------------------------------------------------------------------------
/** The turn is working; give the model up to a minute to start the command (it may still be reasoning). */
const countingStarted = async (skip, values) => {
  await wait('the session to start working', async () => (await sessionState()).isWorking === true, 60_000, 250);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && toolCallsSince(skip).length === 0) await sleep(500);
  values.commandRunning = toolCallsSince(skip).length > 0;
  await sleep(1500);
};

try {
  await boot();

  await step('a', 'project tree advertises the structured provider', async values => {
    const tree = await api('GET', '/api/projects/tree');
    assert.deepEqual(tree.structuredProviders, ['codex']);
    values.structuredProviders = tree.structuredProviders.join(',');
  }, { fatal: true });

  await step('b', 'structured bind: thread id, no tmux session, app-server pid and environment', async values => {
    const bound = await api('POST', '/api/conversations/demo/codex/new/bind', { transport: 'structured' });
    sessionId = bound.session.id;
    evidence.sessionId = sessionId;
    assert.equal(bound.session.transport, 'structured');
    assert.match(bound.conversationRef, /^pending:/, 'The response keeps the pending alias ref.');
    const stored = row();
    assert.match(stored.conversation_ref, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'conversation_ref must be the thread UUID.');
    assert.equal(stored.resume_conversation_ref, stored.conversation_ref);
    assert.ok(stored.tmux_session_name.startsWith('structured:'), 'The tmux name must be the sentinel.');
    assert.equal(stored.transport, 'structured');
    assert.equal(stored.raw_log_path, null);
    assert.ok(stored.pid > 0, 'pid must hold the app-server process id.');
    threadId = stored.conversation_ref;
    evidence.threadId = threadId;
    evidence.pids.appServerFirst = stored.pid;
    const tmux = spawnSync('tmux', ['-L', tmuxSocket, 'ls'], { encoding: 'utf8' });
    assert.notEqual(tmux.status, 0, 'The private tmux socket must have no server.');
    assert.ok(!/structured/.test(tmux.stdout ?? ''), 'No tmux session may exist for the structured conversation.');
    const environ = fs.readFileSync(`/proc/${stored.pid}/environ`, 'utf8').split('\0');
    const env = name => environ.find(entry => entry.startsWith(`${name}=`))?.slice(name.length + 1);
    assert.equal(env('AGENT_COORD_RUNTIME'), runtimeDir, 'The app-server must point hooks at this Console runtime.');
    assert.equal(env('AGENT_CONSOLE_CONFIG'), configPath, 'The app-server must name this Console config.');
    assert.equal(env('AGENT_CONSOLE_SESSION_ID'), undefined, 'The shared process must not carry a session identity.');
    Object.assign(values, { sessionId, threadId, pid: stored.pid, tmuxName: stored.tmux_session_name, tmuxServer: 'none', coordEnv: 'ok' });
  }, { fatal: true });

  // The default (medium) profile's model is rate limited on this host at times: Codex then waits out a long 429
  // backoff and the turn only looks hung. The profile is therefore switched before the first turn; step j returns to
  // the medium profile and checks that its model reaches the provider without waiting for that model to answer.
  await step('c', 'model profile: low applies before the first turn, with no restart', async values => {
    const pidBefore = row().pid;
    const response = await call('POST', `/api/sessions/${sessionId}/model-profile`, { profile: 'low' });
    assert.ok(response.status < 300, `model-profile: HTTP ${response.status} ${response.body?.error ?? ''}`);
    await wait('the model-profile request to complete', () => !row().model_profile_request_json, 30_000, 250);
    assert.equal(row().pid, pidBefore, 'The app-server must not restart for a model change.');
    assert.equal(row().codex_profile, 'low');
    const { screen } = await api('GET', `/api/sessions/${sessionId}/screen`);
    Object.assign(values, { pid: pidBefore, screenModel: screen.model ?? 'unknown' });
  }, { fatal: true });

  await step('d', 'first message completes with an assistant reply', async values => {
    const { record } = await send(PROMPTS.first);
    assert.equal(record.state, 'submitted');
    assert.equal(record.deliveryMode, 'turn');
    assert.ok(record.turnId, 'The record must carry the provider turn id.');
    await waitForReply('PONG');
    const { session } = await api('GET', `/api/sessions/${sessionId}/screen`);
    assert.ok(session.lastResponseAt, 'lastResponseAt must be set by the completed turn.');
    Object.assign(values, { turnId: record.turnId, deliveryMode: record.deliveryMode, lastResponseAt: session.lastResponseAt });
  }, { fatal: true });

  await step('e', 'rollout file exists, the index points at it, and the first turn ran on the low model', async values => {
    const file = await wait('the conversation index to learn the rollout path', async () => {
      await api('GET', `/api/conversations/demo/codex/${encodeURIComponent(threadId)}/messages?limit=0`);
      return rolloutPath();
    }, 60_000);
    assert.ok(fs.existsSync(file), 'The rollout file is missing.');
    assert.ok(file.startsWith(path.join(os.homedir(), '.codex', 'sessions')), 'The rollout must live under ~/.codex/sessions.');
    assert.ok(file.includes(threadId), 'The rollout name must carry the thread id.');
    const records = rolloutRecords();
    assert.equal(records.find(record => record.type === 'session_meta')?.payload?.id, threadId);
    const context = records.find(record => record.type === 'turn_context');
    assert.ok(context, 'The rollout has no turn_context.');
    assert.equal(context.payload.model, CODEX_COST_PROFILES.low.model, 'The first turn must carry the profile chosen before it.');
    const effort = context.payload.effort ?? context.payload.collaboration_mode?.settings?.reasoning_effort;
    evidence.models.firstTurn = `${context.payload.model} ${effort}`;
    Object.assign(values, { rollout: path.basename(file), records: records.length, model: context.payload.model, effort });
  });

  await step('f', 'coordination: hook registered the thread and the agent called the MCP tool', async values => {
    const registered = await wait('the SessionStart hook to register the thread', () => assignment(), 30_000);
    const before = registered.last_seen_at;
    const skip = rolloutRecords().length;
    await sleep(1100);
    const { record } = await send(PROMPTS.coordination);
    assert.equal(record.state, 'submitted');
    await waitForReply('REGISTERED');
    const after = assignment();
    assert.ok(after.last_seen_at > before, 'The assignment must have been seen again during the turn.');
    const calls = toolCallsSince(skip, 'agent_coordination');
    assert.ok(calls.length > 0, 'The rollout shows no agent_coordination tool call.');
    Object.assign(values, { assignmentId: after.id, nativeSessionId: after.native_session_id, status: after.status, lastSeenBefore: before, lastSeenAfter: after.last_seen_at, mcpCallRecords: calls.length });
  });

  await step('g', 'steer: a message sent mid-turn is delivered as a steer', async values => {
    const skip = rolloutRecords().length;
    const first = await send(PROMPTS.count);
    assert.equal(first.record.deliveryMode, 'turn');
    await countingStarted(skip, values);
    const steered = await send(PROMPTS.steer);
    assert.equal(steered.record.state, 'submitted');
    assert.equal(steered.record.deliveryMode, 'steer', 'A message sent while a turn runs must steer it.');
    assert.equal(steered.record.turnId, first.record.turnId, 'A steer joins the running turn.');
    await waitForReply('STEERED');
    Object.assign(values, { turnId: steered.record.turnId, deliveryMode: steered.record.deliveryMode });
  });

  await step('h', 'Stop: Escape interrupts a running turn', async values => {
    const skip = rolloutRecords().length;
    await send(PROMPTS.count);
    await countingStarted(skip, values);
    const stopped = Date.now();
    await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
    await wait('the session to become idle after Stop', idle, 15_000, 250);
    values.idleAfterMs = Date.now() - stopped;
    const abortRecord = await wait('the rollout to record the interrupted turn', () =>
      rolloutRecords().slice(skip).find(record => record.type === 'event_msg' && record.payload?.type === 'turn_aborted'), 15_000, 500);
    assert.equal(abortRecord.payload.reason, 'interrupted');
    assert.equal((await sessionState()).isWorking, false);
    values.turnAborted = abortRecord.payload.reason;
  });


  await step('i', 'manual sleep unloads the thread and restore reloads it', async values => {
    const pidBefore = row().pid;
    // An interrupted turn runs no Stop hook, so the assignment stays `active`, and Console refuses a manual sleep
    // while an assignment is active (the same rule as for tmux sessions). A completed turn marks it `waiting`.
    values.assignmentBefore = assignment()?.status ?? 'none';
    if (values.assignmentBefore === 'active') {
      const refused = await call('POST', `/api/sessions/${sessionId}/suspend`);
      assert.equal(refused.status, 409, 'A manual sleep must be refused while the assignment is active.');
      values.refusedWhileActive = true;
      await send(PROMPTS.settle);
      await waitForReply('SETTLED');
      await wait('the assignment to leave `active` after a completed turn', () => assignment()?.status !== 'active', 30_000);
    }
    const suspended = await api('POST', `/api/sessions/${sessionId}/suspend`);
    assert.ok(suspended.session.manualSuspendedAt, 'manualSuspendedAt must be set.');
    assert.ok(row().manual_suspended_at);
    values.manualSuspendedAt = suspended.session.manualSuspendedAt;
    const resumed = await api('POST', `/api/sessions/${sessionId}/resume`);
    assert.equal(resumed.session.manualSuspendedAt, undefined, 'manualSuspendedAt must be cleared.');
    assert.equal(row().manual_suspended_at, null);
    await send(PROMPTS.restored);
    await waitForReply('RESTORED');
    assert.equal(row().pid, pidBefore, 'Restoring a thread reuses the running app-server.');
    values.pid = row().pid;
    values.manualSuspendedAfterResume = 'cleared';
  });

  await step('j', 'model profile: medium reaches the provider on the next turn, then back to low', async values => {
    const pidBefore = row().pid;
    const switchTo = async profile => {
      const response = await call('POST', `/api/sessions/${sessionId}/model-profile`, { profile });
      assert.ok(response.status < 300, `model-profile ${profile}: HTTP ${response.status} ${response.body?.error ?? ''}`);
      await wait(`the ${profile} profile request to complete`, () => !row().model_profile_request_json, 30_000, 250);
      assert.equal(row().codex_profile, profile);
    };
    await switchTo('medium');
    const skip = rolloutRecords().length;
    await send(PROMPTS.model);
    // The turn's model is recorded when the turn starts; do not wait for that model to answer (it can be rate limited).
    const context = await wait('the medium turn to start', () => rolloutRecords().slice(skip).find(record => record.type === 'turn_context'), 60_000, 250);
    assert.equal(context.payload.model, CODEX_COST_PROFILES.medium.model);
    evidence.models.mediumTurn = context.payload.model;
    values.model = context.payload.model;
    if ((await sessionState()).isWorking === true) {
      await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
      values.stoppedMediumTurn = true;
    }
    await wait('the session to become idle', idle, 20_000, 250);
    await switchTo('low');
    assert.equal(row().pid, pidBefore, 'The app-server must not restart for a model change.');
    values.pid = pidBefore;
  });

  await step('k', 'backend restart: the conversation resumes on a new app-server', async values => {
    const oldPid = row().pid;
    await shutdown();
    await wait('the old app-server to exit with the old backend', () => !alive(oldPid), 20_000, 250);
    await boot();
    const stored = row();
    assert.equal(stored.should_restore, 1, 'The binding must stay restorable after a restart.');
    assert.equal(stored.conversation_ref, threadId);
    values.statusAfterRestart = stored.status;
    await send(PROMPTS.resumed);
    await waitForReply('RESUMED');
    const newPid = row().pid;
    assert.ok(newPid > 0 && newPid !== oldPid, 'A new app-server process must serve the resumed thread.');
    evidence.pids.appServerAfterRestart = newPid;
    Object.assign(values, { oldPid, newPid, oldPidGone: !alive(oldPid) });
  });

  await step('l', 'release ends the session and no app-server from this proof remains', async values => {
    await api('POST', `/api/sessions/${sessionId}/release`);
    const stored = row();
    assert.equal(stored.status, 'ended');
    assert.equal(stored.should_restore, 0);
    values.status = stored.status;
    assert.notEqual(spawnSync('tmux', ['-L', tmuxSocket, 'ls'], { encoding: 'utf8' }).status, 0, 'No tmux server may have been started during the whole run.');
    values.tmuxServer = 'none';
    values.processesAfterRelease = listProcesses().length;
    await shutdown();
    await wait('every process of this proof to exit after backend shutdown', () => listProcesses().length === 0, 20_000, 250);
    values.processesAfterShutdown = 0;
  });
} finally {
  // Cleanup runs on every path: release the session, stop the backend, kill any child, remove the temp root.
  const note = (name, ok, detail) => { evidence.cleanup.push({ name, ok, ...(detail ? { detail } : {}) }); };
  try {
    if (app && sessionId && db && row()?.should_restore) {
      await call('POST', `/api/sessions/${sessionId}/release`);
      note('release session', true);
    }
  } catch (error) { note('release session', false, String(error.message)); }
  try { await shutdown(); note('backend shutdown', true); } catch (error) { note('backend shutdown', false, String(error.message)); }
  try {
    const leftover = listProcesses();
    for (const pid of leftover) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    if (leftover.length) await sleep(2000);
    for (const pid of listProcesses()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    note('leftover processes', true, `${leftover.length} found`);
  } catch (error) { note('leftover processes', false, String(error.message)); }
  try { spawnSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  try { fs.rmSync(root, { recursive: true, force: true }); note('remove temp root', !fs.existsSync(root)); } catch (error) { note('remove temp root', false, String(error.message)); }
  const failed = evidence.steps.filter(entry => !entry.pass && !entry.skipped).length;
  const skipped = evidence.steps.filter(entry => entry.skipped).length;
  evidence.providerRetries = providerRetries();
  if (evidence.providerRetries?.length) say(`NOTE Codex retried a model request ${evidence.providerRetries.length} time(s) on this thread (${[...new Set(evidence.providerRetries.map(entry => entry.cause))].join('; ')}); turns that waited out a backoff look hung.`);
  evidence.finishedAt = new Date().toISOString();
  evidence.result = failed === 0 && skipped === 0 && evidence.steps.length === 12 ? 'pass' : 'fail';
  evidence.summary = { passed: evidence.steps.filter(entry => entry.pass).length, failed, skipped };
  flush();
  say(`${evidence.result.toUpperCase()}: ${evidence.summary.passed} passed, ${failed} failed, ${skipped} skipped. Evidence ${evidencePath}`);
  process.exitCode = evidence.result === 'pass' ? 0 : 1;
}
// The backend is closed; end the process even if a library timer is still pending.
process.exit(process.exitCode ?? 1);
