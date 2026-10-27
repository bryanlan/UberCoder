#!/usr/bin/env node
// Opt-in real-Codex proof of the structured provider lane (docs/structured-providers.md, "Verification").
//
// Starts an isolated Console backend (temp root, temp database, temp runtime, scratch git project, private tmux
// socket) with `structuredSessions.codex.enabled`, then drives ONE structured Codex conversation through the HTTP
// API the web client uses: bind, send, coordination hook and MCP, steer, Stop, a question answered through the card
// route (h2), an image turn (h3), model profile, manual sleep and restore, a graceful backend restart while idle (k: the
// app-server, held by its session host, survives it and serves the next turn) and during a running turn (k2: the turn is
// re-adopted, Stop interrupts it and ends its command within 5 s, a message sent meanwhile steers it, the next message completes on the
// same app-server and every turn ends exactly once), a screenshot-sized image over 5 MB (l)
// and release (m). The coordination MCP server is pinned to the proof's runtime by the product itself (the app-server argv), not
// by this script; a backend crash is not exercised here. Real Codex turns run with the host's ChatGPT login; every prompt is one
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
import { windowLeft, solidPng, noisyPng, readEventLog, lostTurnStatusLines, consoleControlTexts, findControlText, installExitBackstop, endProofProcesses, scanProofProcesses, summarizeProcesses } from './structured-proof-kit.mjs';

if (!process.argv.includes('--run')) {
  process.stderr.write('Use --run to opt into a real Codex app-server proof (several short turns on the host login). Run `npm run build` first.\n');
  process.exit(2);
}

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { buildApp } = await import(new URL('../apps/server/dist/app.js', import.meta.url));
const { CODEX_COST_PROFILES } = await import('@agent-console/shared');
const { terminateHost } = await import(new URL('../apps/server/dist/providers/transport/line-transport.js', import.meta.url));

// ---- prompts (the only message text this proof ever sends) -----------------------------------------------
const RUN_TAG = randomBytes(4).toString('hex');
/** A counting command that carries a unique marker, so its process can be found (and shown gone) on the host. */
const countMarker = tag => `proof-${tag}-${RUN_TAG}`;
const countPrompt = (tag, to = 30) => `Run exactly this shell command and wait for it to finish before replying: echo ${countMarker(tag)}; for i in $(seq 1 ${to}); do echo $i; sleep 1; done`;
/** The counting command, after a coordination `update` that marks the assignment unattended (a message from the person pauses it, so the agent sets it in the same turn). */
const unattendedCountPrompt = (tag, to = 30) => `First call the agent_coordination MCP tool with action update and continuation unattended. After that call succeeds, run exactly this shell command and wait for it to finish before replying: echo ${countMarker(tag)}; for i in $(seq 1 ${to}); do echo $i; sleep 1; done`;
const PROMPTS = {
  first: 'Reply with exactly the single word PONG and nothing else.',
  coordination: 'Call the agent_coordination MCP tool with action status. If the call succeeded, reply with exactly the single word REGISTERED and nothing else.',
  steer: 'Stop counting now and reply with the single word STEERED.',
  question: 'Ask me which color I prefer, red or blue, using your request_user_input tool with a title and options, then wait for my answer. After I answer, reply with exactly the single word of the color I chose.',
  image: 'What color is the attached image? Reply with one word.',
  bigImage: 'What is the dominant color of the attached image? Reply with one word.',
  model: 'Reply with the single word MODEL.',
  settle: 'Reply with the single word SETTLED.',
  restored: 'Reply with the single word RESTORED.',
  resumed: 'Reply with the single word RESUMED.',
  followUp: 'When your current work is finished, reply with exactly the single word FOLLOWED.',
};
const TURN_TIMEOUT_MS = 180_000;

// ---- isolated environment ----------------------------------------------------------------------------------
const startedAt = new Date();
const tmuxSocket = `console-structured-proof-${randomUUID().slice(0, 8)}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-structured-proof-'));
// Covers a failure before the `try` below (and an uncaught one): the temp root is removed and anything started is ended.
installExitBackstop(root, () => tmuxSocket);
const project = path.join(root, 'projects', 'demo');
fs.mkdirSync(project, { recursive: true });
execFileSync('git', ['init', '-q', project]);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'This is a disposable Console proof project. Do not edit files. Follow each short test prompt exactly.\n');
const configPath = path.join(root, 'config.json');
const runtimeDir = path.join(root, 'runtime');
const databasePath = path.join(root, 'fixture.sqlite');

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
  // The global ~/.codex coordination MCP entry names the live runtime and checkout. Nothing here overrides it: the
  // product adds the per-Console overrides to the app-server argv, and step b and f check that it did.
  structuredSessions: { codex: { enabled: true, idleUnloadMinutes: 60, env: {}, command: ['codex', 'app-server'] } },
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
  workingTree: (() => { try { return execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', 'apps', 'packages'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(line => line.slice(3)); } catch { return []; } })(),
  codexVersion, node: process.version, tempRoot: root, runtimeDir, port, threadId: null, sessionId: null,
  pids: {}, models: {}, steps: [], findings: [], cleanup: [], result: 'running',
};
const flush = () => fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
const say = line => process.stderr.write(`PROOF ${line}\n`);
/** A place where the real provider behaved differently from the research brief, or settled something it left open. */
const finding = (id, text) => {
  if (!evidence.findings.some(entry => entry.id === id)) evidence.findings.push({ id, text });
  say(`FINDING ${id}: ${text}`);
};
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
// The first signal stops the proof at its next poll so the cleanup below runs; a second one leaves at once (the `exit` backstop still cleans up).
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (interrupted) { say(`${signal} again: leaving now`); process.exit(130); }
  interrupted = true;
  say(`${signal}: stopping at the next poll; cleanup will run`);
});
const wait = async (label, predicate, timeout = TURN_TIMEOUT_MS, interval = 500) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (interrupted) throw new Error('Interrupted by a signal.');
    const result = await predicate();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeout / 1000)} s: ${label}`);
    await sleep(interval);
  }
};
/** Running, not merely a zombie awaiting its parent. */
const alive = pid => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
  } catch { return false; }
};
const pgrep = pattern => spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid);
const procEntries = () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number);
const environOf = pid => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); } catch { return []; } };
/** Every process carrying this proof's coordination runtime in its environment: the app-server, its native child, hooks, MCP servers and model commands. */
const processesWithRuntime = () => procEntries().filter(pid => pid !== process.pid && environOf(pid).includes(`AGENT_COORD_RUNTIME=${runtimeDir}`));
/** The coordination MCP servers (`agent-coord.mjs mcp`) Codex started for this Console's runtime. Their runtime is in the environment, not the command line. */
const coordMcpProcesses = () => pgrep('agent-coord\\.mjs mcp').filter(pid => environOf(pid).includes(`AGENT_COORD_RUNTIME=${runtimeDir}`));
/** Members of a process group, read from /proc (the launcher leads it; the native app-server is its child). */
const groupMembers = pgid => procEntries().filter(pid => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) === pgid;
  } catch { return false; }
});
/** The start time of a live process in clock ticks (field 22 of /proc/<pid>/stat), as the session host records it. */
const startTicksOf = pid => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return undefined; }
};
const parentOf = pid => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch { return undefined; }
};
/** The record the session host holding the app-server wrote: pids, start times and boot of the host and of the app-server. */
const hostRecordPath = path.join(runtimeDir, 'structured', 'hosts', 'codex.json');
const hostRecord = () => JSON.parse(fs.readFileSync(hostRecordPath, 'utf8'));
/** Processes of this proof: anything whose command line holds the temp root, anything started with this runtime, and every lane process that names the temp root. */
const listProcesses = () => [...new Set([...pgrep(root), ...processesWithRuntime(), ...scanProofProcesses(root).map(entry => entry.pid)])];

// ---- session accessors -------------------------------------------------------------------------------------
let sessionId;
let threadId;
const row = () => db.prepare('select * from bound_sessions where id = ?').get(sessionId);
const sessionState = async () => (await api('GET', `/api/sessions/${sessionId}/screen`)).session;
const indexRow = () => db.prepare('select transcript_path from conversation_index where project_slug = ? and provider = ? and ref = ?').get('demo', 'codex', threadId);
const assignment = () => db.prepare('select * from coordination_assignments where provider = ? and native_session_id = ?').get('codex', threadId);
const timeline = async () => (await api('GET', `/api/conversations/demo/codex/${encodeURIComponent(threadId)}/messages?limit=200`)).messages ?? [];
const assistantHas = async marker => (await timeline()).some(message => message.role === 'assistant' && message.text.includes(marker));
/** Assistant messages that hold the marker as a whole word (so `red` does not match `registered`). */
const countAssistant = async marker => {
  const pattern = new RegExp(`\\b${marker}\\b`, 'i');
  return (await timeline()).filter(message => message.role === 'assistant' && pattern.test(message.text)).length;
};
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
const eventLogPath = () => row()?.event_log_path;
const epoch = () => db.prepare('select value from meta where key = ?').get(`structured-epoch:${sessionId}`)?.value;
/** The continuation state the Console keeps for an assignment (`unattended` lets RunRecovery act on a lost turn). */
const continuationOf = id => {
  const found = db.prepare('select value from meta where key = ?').get(`assignment-continuation:${id}`);
  return found ? JSON.parse(found.value) : undefined;
};
/** Collects the `session.screen-updated` events of the session from the event stream the web client listens to. */
const watchScreens = async () => {
  const response = await app.inject({ method: 'GET', url: '/api/events', headers, payloadAsStream: true });
  const statuses = [];
  let buffer = '';
  response.stream().on('data', chunk => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const data = buffer.slice(0, end).split('\n').find(line => line.startsWith('data: '));
      buffer = buffer.slice(end + 2);
      try {
        const event = data ? JSON.parse(data.slice(6)) : undefined;
        if (event?.type === 'session.screen-updated' && event.sessionId === sessionId) statuses.push(event.screen?.status);
      } catch { /* not a JSON event */ }
    }
  });
  return statuses;
};

/** Send one chat message the way the web client does and return the queue record it produced. */
const send = async (text, extra = {}) => {
  const submissionId = randomUUID();
  const response = await api('POST', `/api/sessions/${sessionId}/keys`, { submissionId, submittedText: text, text, keys: ['Enter'], ...extra });
  const record = queueRecord(submissionId);
  assert.ok(record, 'The queued-input record is missing.');
  return { submissionId, record, response };
};
/** Wait until the turn is over and an assistant message carries the marker. */
const waitForReply = marker => wait(`assistant reply containing ${marker}`, async () => (await idle()) && (await assistantHas(marker)));
/**
 * How the turns in the rollout from record `from` on began and ended. Codex writes `task_started` and then exactly one of `task_complete`
 * or `turn_aborted` (a Stop) per turn id, so a turn that ended twice, or not at all, shows in these counts. `irregular` names every turn
 * that did not begin once and end once. Only turns that began at or after `from` count: the end of an earlier turn can still be landing.
 */
const turnEndsSince = from => {
  const turns = new Map();
  for (const record of rolloutRecords().slice(from)) {
    const type = record.type === 'event_msg' ? record.payload?.type : undefined;
    if (type !== 'task_started' && type !== 'task_complete' && type !== 'turn_aborted') continue;
    const id = typeof record.payload.turn_id === 'string' ? record.payload.turn_id : '(no turn id)';
    const turn = turns.get(id) ?? { started: 0, ends: [] };
    if (type === 'task_started') turn.started += 1; else turn.ends.push(type);
    turns.set(id, turn);
  }
  const own = [...turns].filter(([, turn]) => turn.started > 0);
  const ends = type => own.reduce((sum, [, turn]) => sum + turn.ends.filter(end => end === type).length, 0);
  return {
    turns: own.length, completed: ends('task_complete'), aborted: ends('turn_aborted'),
    irregular: own.filter(([, turn]) => turn.started !== 1 || turn.ends.length !== 1).map(([id, turn]) => `${id.slice(0, 8)}: ${turn.started} start(s), ${turn.ends.join('+') || 'no end'}`),
  };
};
/**
 * Waits for the turn-end records `expected` names, lets the rollout settle for 2 s so a second end would have arrived, then requires exactly
 * the expected turns and ends since record `from`: one end per turn, not zero and not two. The counts go into `values[key]`.
 */
const assertTurnEnds = async (label, from, expected, values, key) => {
  const wanted = expected.completed + expected.aborted;
  const found = () => { const seen = turnEndsSince(from); return seen.completed + seen.aborted; };
  try { await wait(`${wanted} turn-end record(s) in the rollout (${label})`, () => found() >= wanted, 20_000, 250); } catch (error) { if (!/^Timed out/.test(error.message)) throw error; }
  await sleep(2000);
  const seen = turnEndsSince(from);
  values[key] = `${seen.turns} turn(s), ${seen.completed} completed, ${seen.aborted} aborted`;
  assert.deepEqual({ ...seen, irregular: seen.irregular.length }, { ...expected, irregular: 0 }, `Every turn must start once and end exactly once (${label}); the rollout holds ${JSON.stringify(seen)}, expected ${JSON.stringify(expected)}.`);
};
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
  if (!sessionId || !app || !db) return;
  const polled = await call('GET', `/api/sessions/${sessionId}/screen`);
  if (polled.status === 404) return; // a suspended row has no screen and nothing running
  for (const request of polled.body.session.pendingRequests ?? []) {
    await call('POST', `/api/sessions/${sessionId}/requests/${request.requestId}`, { decision: 'decline' });
    entry.values.declinedLeftoverQuestion = true;
  }
  if (await idle()) return;
  try { await wait('the previous turn to end', idle, 20_000, 500); return; } catch { /* still working: stop it */ }
  entry.values.stoppedLeftoverTurn = true;
  await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
  await wait('the leftover turn to stop', idle, 20_000, 500);
};
const step = async (id, name, fn, { fatal = false } = {}) => {
  const entry = { id, name, pass: false, skipped: false, ms: 0, values: {} };
  if (interrupted) aborted = true;
  if (aborted) {
    entry.skipped = true;
    entry.error = 'Skipped: an earlier fatal step failed or the proof was interrupted.';
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
    // The product, not this script, pins the coordination MCP server to this Console's runtime and helper.
    const argv = fs.readFileSync(`/proc/${stored.pid}/cmdline`, 'utf8').split('\0');
    const override = key => argv.includes(`mcp_servers.agent_console_coordination.${key}`);
    assert.ok(override(`env.AGENT_COORD_RUNTIME=${JSON.stringify(runtimeDir)}`), 'The app-server argv must pin the MCP runtime to this Console.');
    assert.ok(override(`args=${JSON.stringify([path.join(repoRoot, 'scripts/agent-coord.mjs'), 'mcp'])}`), 'The app-server argv must pin the MCP helper of this checkout.');
    assert.ok(override('command="node"'), 'The app-server argv must pin the MCP command.');
    assert.ok(argv.indexOf('check_for_update_on_startup=false') < argv.findIndex(arg => arg.startsWith('mcp_servers.agent_console_coordination.')), 'The overrides follow the update check override.');
    assert.ok(!argv.some(arg => arg.includes('AGENT_CONSOLE_SESSION_ID')), 'No session id may be pinned into the shared process.');
    // The app-server runs behind a session host that outlives the backend. Its record names both processes by pid and
    // start time, and the app-server (the npm launcher with its native child) leads its own process group.
    const record = hostRecord();
    assert.equal(record.child.pid, stored.pid, 'The host record must name the app-server pid that the row holds.');
    assert.equal(record.child.processGroup, stored.pid, 'The host record must name the process group the app-server leads.');
    assert.equal(record.child.startTicks, startTicksOf(stored.pid), 'The recorded app-server start time must match /proc.');
    assert.equal(record.host.startTicks, startTicksOf(record.host.pid), 'The recorded host start time must match /proc.');
    assert.equal(parentOf(stored.pid), record.host.pid, 'The app-server must be a child of its session host.');
    assert.notEqual(parentOf(record.host.pid), stored.pid);
    assert.ok(record.parentDeathSignal, 'The app-server must be started with a parent death signal relative to the host.');
    const members = groupMembers(stored.pid);
    assert.ok(members.includes(stored.pid), 'The app-server must lead its process group.');
    evidence.pids.appServerGroup = members;
    evidence.pids.sessionHost = record.host.pid;
    Object.assign(values, { sessionId, threadId, pid: stored.pid, hostPid: record.host.pid, tmuxName: stored.tmux_session_name, tmuxServer: 'none', coordEnv: 'ok', mcpPinned: 'ok', processGroup: record.child.processGroup, groupMembers: members.length });
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
    // The MCP server of the thread must be this Console's: it runs with the proof's runtime in its environment.
    let mcpPids = [];
    await wait('assistant reply containing REGISTERED', async () => {
      const seen = coordMcpProcesses();
      if (seen.length) mcpPids = [...new Set([...mcpPids, ...seen])];
      return (await idle()) && (await assistantHas('REGISTERED'));
    });
    assert.ok(mcpPids.length > 0, 'No agent-coord.mjs mcp process with this proof\'s runtime was seen: the MCP server is not pinned to this Console.');
    values.mcpProcesses = mcpPids.length;
    const after = assignment();
    assert.ok(after.last_seen_at > before, 'The assignment must have been seen again during the turn.');
    const calls = toolCallsSince(skip, 'agent_coordination');
    assert.ok(calls.length > 0, 'The rollout shows no agent_coordination tool call.');
    Object.assign(values, { assignmentId: after.id, nativeSessionId: after.native_session_id, status: after.status, lastSeenBefore: before, lastSeenAfter: after.last_seen_at, mcpCallRecords: calls.length });
  });

  await step('g', 'steer: a message sent mid-turn is delivered as a steer', async values => {
    const skip = rolloutRecords().length;
    const first = await send(countPrompt('g'));
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
    await send(countPrompt('h'));
    await countingStarted(skip, values);
    // The counting command carries a marker: it must be running now and gone after Stop.
    const marker = countMarker('h');
    const commandPids = await wait('the counting command to be running', () => { const found = pgrep(marker); return found.length ? found : undefined; }, 30_000, 250);
    values.commandPids = commandPids.length;
    const stopped = Date.now();
    await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
    await wait('the session to become idle after Stop', idle, 15_000, 250);
    values.idleAfterMs = Date.now() - stopped;
    // Within 5 s of Stop (not of idle), as in k2: the 30 s count would otherwise run out on its own inside a longer wait and pass for a Stop that worked.
    const gone = 'the counting command to end within 5 s of Stop';
    await wait(gone, () => commandPids.every(pid => !alive(pid)) && pgrep(marker).length === 0, windowLeft(gone, stopped, 5_000), 100);
    values.commandGoneAfterMs = Date.now() - stopped;
    const abortRecord = await wait('the rollout to record the interrupted turn', () =>
      rolloutRecords().slice(skip).find(record => record.type === 'event_msg' && record.payload?.type === 'turn_aborted'), 15_000, 500);
    assert.equal(abortRecord.payload.reason, 'interrupted');
    assert.equal((await sessionState()).isWorking, false);
    values.turnAborted = abortRecord.payload.reason;
  });

  await step('h2', 'question: request_user_input_async shows a card, the card route answers it, the answer reaches the model', async values => {
    // codex-cli 0.164 in the default collaboration mode offers the model `request_user_input_async`: the tool answers {"accepted":true}
    // at once and Codex raises no blocking request. The question reaches the Console as an assistant message item with `delivery: 'async'`
    // and `questions: [{ title, options }]`; the turn stays open while the model polls, and the person's answer is an ordinary message.
    const skip = rolloutRecords().length;
    await send(PROMPTS.question);
    let sawWorking = false;
    const sentAt = Date.now();
    const outcome = await wait('a question card, the end of the turn, or 90 s with no card', async () => {
      const state = await sessionState();
      if (state.pendingRequests?.length) return { kind: 'question', request: state.pendingRequests[0], working: state.isWorking === true };
      if (state.isWorking === true) sawWorking = true;
      if (sawWorking && state.isWorking !== true) return { kind: 'ended' };
      if (Date.now() - sentAt > 90_000) return { kind: 'none' };
      return undefined;
    }, 150_000, 250);
    if (outcome.kind !== 'question') {
      const records = rolloutRecords().slice(skip);
      const calls = records.filter(record => record.payload?.type === 'function_call' && /request_user_input/.test(record.payload.name ?? ''));
      const outputs = records.filter(record => record.payload?.type === 'function_call_output' && calls.some(call => call.payload.call_id === record.payload.call_id)).map(record => String(record.payload.output).slice(0, 120));
      const names = [...new Set(calls.map(record => record.payload.name))];
      values.outcome = outcome.kind;
      values.toolNames = names.join(',') || 'none';
      values.toolAttempts = calls.length;
      values.toolOutputs = outputs.join(' | ');
      if (outcome.kind === 'none') {
        await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
        await wait('the waiting turn to stop', idle, 20_000, 250);
        values.stoppedWaitingTurn = true;
      }
      if (!outputs.some(output => /"accepted"\s*:\s*true/.test(output))) {
        // The model never made a call Codex accepted (for example it named a field the tool does not have), so no question was asked
        // and there is nothing for the Console to show. That is a finding about the model's call, not about the Console.
        finding('request-user-input', `Codex ${evidence.codexVersion} never accepted a request_user_input call from the model (tool ${names.join(', ') || '(none)'}, ${calls.length} call(s); outputs: ${outputs.join(' | ') || 'none'}), so no question was asked and the card could not be exercised.`);
        return;
      }
      assert.fail(`Codex accepted the question (${outputs.join(' | ')}) but no card reached the Console (${outcome.kind === 'ended' ? 'the turn ended first' : 'none within 90 s'}).`);
    }
    const request = outcome.request;
    assert.equal(request.kind, 'question');
    assert.equal(request.responseMode, 'message', 'An async question is answered as a message, not through a held request.');
    assert.ok(request.questions.length >= 1, 'The pending request must carry its question.');
    const question = request.questions[0];
    const labels = question.options.map(option => option.label);
    const blue = labels.find(label => /blue/i.test(label));
    assert.ok(blue && labels.some(label => /red/i.test(label)), `The options must offer red and blue (saw ${labels.join(', ')}).`);
    values.cardAfterMs = Date.now() - sentAt;
    values.options = labels.join('/');
    values.allowCustom = String(question.allowCustom ?? false);
    values.turnWorkingWhileAsking = outcome.working;
    // The question text itself is an assistant message that names both colors; count the replies from here on.
    const beforeAnswer = await countAssistant('blue');
    const answeredAt = Date.now();
    const answered = await api('POST', `/api/sessions/${sessionId}/requests/${request.requestId}`, { decision: 'answer', answers: { [question.id]: [blue] } });
    assert.equal(answered.session.pendingRequests?.length ?? 0, 0, 'The answered question must leave the row.');
    const second = await call('POST', `/api/sessions/${sessionId}/requests/${request.requestId}`, { decision: 'answer', answers: { [question.id]: [blue] } });
    assert.ok(second.status >= 400, 'A second answer to the same question must be refused.');
    values.secondAnswerStatus = second.status;
    await wait('the model to receive the answer and reply blue', async () => (await idle()) && (await countAssistant('blue')) > beforeAnswer, 90_000, 250);
    values.answerToReplyMs = Date.now() - answeredAt;
    // The rollout holds the answer as a user message after the question, so the reply answers it rather than the model guessing.
    const received = rolloutRecords().slice(skip).find(record => record.payload?.type === 'message' && record.payload.role === 'user' && JSON.stringify(record).includes('Answer to your question'));
    assert.ok(received, 'The rollout shows no user message carrying the answer.');
    values.answerDelivered = JSON.stringify(received.payload.content).slice(0, 120);
  });

  await step('h3', 'image: an attached PNG reaches the model as a local image item', async values => {
    const skip = rolloutRecords().length;
    const before = await countAssistant('green');
    const upload = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/images`, payload: solidPng(64, [0, 170, 0]), headers: { ...headers, 'content-type': 'image/png' } });
    assert.equal(upload.statusCode, 201, `image upload: HTTP ${upload.statusCode}`);
    const image = upload.json().image;
    const sent = await send(PROMPTS.image, { imageIds: [image.id] });
    assert.equal(sent.record.state, 'submitted');
    await wait('assistant reply containing green', async () => (await idle()) && (await countAssistant('green')) > before);
    // The rollout records the user message with its image content; the stored file is what the item points at.
    const imageRecord = rolloutRecords().slice(skip).find(record => JSON.stringify(record).includes('input_image') || JSON.stringify(record).includes('localImage') || JSON.stringify(record).includes('local_image'));
    assert.ok(imageRecord, 'The rollout shows no image content for the turn.');
    Object.assign(values, { imageId: image.id, mediaType: image.mediaType, rolloutRecordType: imageRecord.payload?.type ?? imageRecord.type });
  });


  await step('i', 'manual sleep unloads the thread (screen reads asleep) and restore reloads it (new epoch)', async values => {
    const pidBefore = row().pid;
    const screens = await watchScreens();
    assert.equal((await api('GET', `/api/sessions/${sessionId}/screen`)).screen.status, 'Codex (app-server) idle', 'A loaded thread reads idle.');
    const epochBefore = epoch();
    assert.ok(epochBefore, 'The loaded thread must have an epoch.');
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
    // Unloaded: the synthesized screen says asleep (published to the event stream; the poll has no screen for a suspended row).
    await wait('the asleep screen to be published', () => screens.at(-1) === 'Codex (app-server) asleep', 10_000, 100);
    assert.equal((await call('GET', `/api/sessions/${sessionId}/screen`)).status, 404, 'A suspended row has no screen to poll.');
    const resumed = await api('POST', `/api/sessions/${sessionId}/resume`);
    assert.equal(resumed.session.manualSuspendedAt, undefined, 'manualSuspendedAt must be cleared.');
    assert.equal(row().manual_suspended_at, null);
    // Loaded again: a new epoch, and the screen reads idle after the asleep line.
    await wait('the restored screen to be published', () => screens.length > 0 && screens.lastIndexOf('Codex (app-server) idle') > screens.lastIndexOf('Codex (app-server) asleep'), 30_000, 100);
    assert.notEqual(epoch(), epochBefore, 'Restoring the thread must start a new epoch.');
    await send(PROMPTS.restored);
    await waitForReply('RESTORED');
    assert.equal(row().pid, pidBefore, 'Restoring a thread reuses the running app-server.');
    values.pid = row().pid;
    values.screenSequence = screens.filter((status, index) => status !== screens[index - 1]).join(' > ');
    values.epochChanged = true;
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

  await step('k', 'graceful backend restart: the app-server survives in its session host and serves the next turn', async values => {
    const oldPid = row().pid;
    const before = hostRecord();
    assert.equal(before.child.pid, oldPid);
    assert.equal(before.child.startTicks, startTicksOf(oldPid));
    const oldGroup = groupMembers(oldPid);
    assert.ok(oldGroup.includes(oldPid));
    await shutdown();
    await sleep(2000); // long enough for a host that died with the backend to take the app-server down with it
    assert.ok(alive(oldPid), 'The app-server must survive the backend.');
    assert.ok(alive(before.host.pid), 'The session host must survive the backend.');
    assert.ok(oldGroup.every(pid => alive(pid)), 'Every process of the app-server group must survive the backend.');
    await boot();
    const stored = row();
    assert.equal(stored.should_restore, 1, 'The binding must stay restorable after a restart.');
    assert.equal(stored.conversation_ref, threadId);
    values.statusAfterRestart = stored.status;
    await send(PROMPTS.resumed);
    await waitForReply('RESUMED');
    // The same process: the new backend reconnected to the host instead of starting a second app-server.
    const newPid = row().pid;
    assert.equal(newPid, oldPid, 'The same app-server must serve the resumed thread.');
    const after = hostRecord();
    assert.equal(after.host.pid, before.host.pid, 'The same session host must still hold it.');
    assert.equal(after.child.pid, oldPid);
    assert.equal(after.child.startTicks, startTicksOf(oldPid), 'The record must still match /proc: no restart happened.');
    assert.equal(after.child.startTicks, before.child.startTicks);
    assert.equal(after.host.startTicks, startTicksOf(after.host.pid));
    assert.deepEqual(procEntries().filter(pid => parentOf(pid) === after.host.pid), [oldPid], 'The host holds exactly one provider process: no second writer.');
    evidence.pids.appServerAfterRestart = newPid;
    Object.assign(values, { oldPid, newPid, samePid: newPid === oldPid, hostPid: after.host.pid, recordMatchesProc: true });
  });

  await step('k2', 'graceful backend restart during a running turn: the turn is re-adopted, Stop interrupts it and ends its command, a message sent meanwhile steers it and is answered after it, the next message completes on the same app-server, and every turn ends exactly once', async values => {
    const control = await consoleControlTexts();
    const skip = rolloutRecords().length;
    const eventLog = eventLogPath();
    const eventsBeforeShutdown = readEventLog(eventLog).size;

    /**
     * Starts a 25 s count, restarts the backend while it runs, and returns once the new backend has attached to the app-server and the
     * row has read working for as long as the count ran. `put` records evidence values. `unattended`: the agent marks its assignment
     * unattended first, so that a recovery prompt the Console wrongly fired (it declares a running turn lost) would really be sent.
     */
    const restartDuringCount = async (tag, put, { unattended = false } = {}) => {
      const oldPid = row().pid;
      const before = hostRecord();
      assert.equal(before.child.pid, oldPid);
      const oldGroup = groupMembers(oldPid);
      const callsFrom = rolloutRecords().length;
      const counting = await send(unattended ? unattendedCountPrompt(tag, 25) : countPrompt(tag, 25));
      assert.equal(counting.record.deliveryMode, 'turn');
      const seen = {};
      await countingStarted(callsFrom, seen);
      put('commandRunning', seen.commandRunning);
      const commandPids = await wait('the counting command to be running', () => { const found = pgrep(countMarker(tag)); return found.length ? found : undefined; }, 30_000, 250);
      put('commandPids', commandPids.length);
      if (unattended) {
        const marked = await wait('the agent to mark the assignment unattended', () => { const found = assignment(); const state = found && continuationOf(found.id); return state?.continuation === 'unattended' ? state : undefined; }, 60_000, 250);
        put('continuationBeforeRestart', marked.continuation);
      }
      const countSeenAt = Date.now();
      const epochBefore = epoch();
      await shutdown();
      await sleep(1000);
      assert.ok(alive(oldPid), 'The app-server must survive the backend.');
      assert.ok(alive(before.host.pid), 'The session host must survive the backend.');
      assert.ok(oldGroup.every(pid => alive(pid)), 'Every process of the app-server group must survive the backend.');
      assert.ok(commandPids.some(pid => alive(pid)), 'The counting command must keep running while the backend is down.');
      // The first poll is judged on what the new backend writes; the whole window (shutdown included) is checked at the end.
      const eventsFrom = readEventLog(eventLog).size;
      await boot();
      const bootedAt = Date.now();
      // Before any message: the row the database holds, then the first screen poll that an open web page makes. That poll must not
      // write the loss line a turn that ended with its connection would get, and must not send recovery into the running turn.
      const stored = row();
      assert.equal(stored.status, 'bound');
      assert.equal(stored.should_restore, 1, 'The binding must stay restorable after a restart.');
      assert.equal(stored.conversation_ref, threadId);
      const samples = [];
      const httpStatuses = new Set();
      let screenStatus;
      const poll = async () => {
        const response = await call('GET', `/api/sessions/${sessionId}/screen`);
        samples.push(response.body?.session?.isWorking === true);
        httpStatuses.add(response.status);
        screenStatus = response.body?.screen?.status ?? 'none';
        return response;
      };
      const firstPoll = await poll();
      const lostAfterFirstPoll = lostTurnStatusLines(readEventLog(eventLog, eventsFrom).entries);
      put('firstPollHttp', firstPoll.status);
      put('firstPollScreen', screenStatus);
      put('firstPollWorking', String(samples[0]));
      put('connectionEndedAfterFirstPoll', lostAfterFirstPoll.length > 0);
      assert.deepEqual(lostAfterFirstPoll, [], `The first screen poll after the restart wrote a lost-turn status line: ${lostAfterFirstPoll.join(' | ')}`);
      // Attached again (loaded, not asleep) within the first reconcile pass, to the app-server that survived.
      await wait('the thread to be attached again', async () => { const response = await poll(); return response.status === 200 && !/asleep$/.test(screenStatus); }, 12_000, 500);
      put('attachedAfterBootMs', Date.now() - bootedAt);
      put('epochChanged', epoch() !== epochBefore);
      assert.equal(row().pid, oldPid, 'The thread is served by the app-server that survived.');
      assert.deepEqual(procEntries().filter(pid => parentOf(pid) === before.host.pid), [oldPid], 'Attaching must not start a second app-server.');
      // The turn is still running, so the row must read as working for as long as the count runs.
      for (let index = 0; index < 4; index += 1) { await sleep(500); await poll(); }
      put('screenWhileCounting', screenStatus);
      put('polls', samples.length);
      const notWorking = samples.filter(working => !working).length;
      assert.equal(notWorking, 0, `isWorking read false in ${notWorking} of ${samples.length} polls (HTTP ${[...httpStatuses].join('/')}) while the count was still running.`);
      const stillCounting = pgrep(countMarker(tag));
      put('countSeenRunningForMs', Date.now() - countSeenAt);
      assert.ok(stillCounting.length > 0, `The 25 s count had already finished ${Date.now() - countSeenAt} ms after it was seen running, so the adopted turn could not be tested; rerun.`);
      return { oldPid, before, stillCounting };
    };

    // Phase 1: Stop reaches the re-adopted turn: idle within 15 s, same app-server, the rollout records the interruption. The command
    // the turn started before the restart must be ended by Stop itself, within 5 s: Codex does not end it on `turn/interrupt`, and
    // the 25 s count would otherwise run out on its own inside a longer wait and pass for a Stop that worked.
    const stopRun = await restartDuringCount('k2', (key, value) => { values[key] = value; }, { unattended: true });
    const { oldPid, before, stillCounting } = stopRun;
    const stopped = Date.now();
    await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
    await wait('the session to become idle after Stop', idle, 15_000, 250);
    values.idleAfterMs = Date.now() - stopped;
    assert.equal(row().pid, oldPid, 'The row pid must not change for an interrupt.');
    const gone = 'the counting command to end within 5 s of Stop';
    await wait(gone, () => stillCounting.every(pid => !alive(pid)) && pgrep(countMarker('k2')).length === 0, windowLeft(gone, stopped, 5_000), 100);
    values.commandGoneAfterMs = Date.now() - stopped;
    const abortRecord = await wait('the rollout to record the interrupted turn', () =>
      rolloutRecords().slice(skip).find(record => record.type === 'event_msg' && record.payload?.type === 'turn_aborted'), 15_000, 500);
    assert.equal(abortRecord.payload.reason, 'interrupted');
    values.turnAborted = abortRecord.payload.reason;
    assert.equal((await sessionState()).isWorking, false);
    // The adopted turn ended once, as an abort: not twice, and not also as a completion.
    await assertTurnEnds('after Stop', skip, { turns: 1, completed: 0, aborted: 1 }, values, 'turnEndsAfterStop');
    // The next message gets its own reply from the same app-server.
    const resumedBefore = await countAssistant('RESUMED');
    const resumedFrom = rolloutRecords().length;
    await send(PROMPTS.resumed);
    await wait('assistant reply containing RESUMED', async () => (await idle()) && (await countAssistant('RESUMED')) > resumedBefore);
    await assertTurnEnds('after the resumed message', resumedFrom, { turns: 1, completed: 1, aborted: 0 }, values, 'turnEndsAfterResume');
    assert.equal(row().pid, oldPid, 'The same app-server must serve the resumed thread.');
    const afterStop = hostRecord();
    assert.equal(afterStop.host.pid, before.host.pid, 'The same session host must still hold it.');
    assert.equal(afterStop.child.pid, oldPid);
    assert.equal(afterStop.child.startTicks, startTicksOf(oldPid), 'The record must still match /proc: no restart happened.');
    assert.equal(afterStop.child.startTicks, before.child.startTicks);
    assert.deepEqual(procEntries().filter(pid => parentOf(pid) === afterStop.host.pid), [oldPid], 'The host holds exactly one provider process: no second writer.');

    // Phase 2: a message sent while a re-adopted turn runs is delivered to that turn as a steer (it does not start a second turn),
    // and is answered once the turn's work is done. The count is not stopped this time.
    const steerFrom = rolloutRecords().length;
    const steerRun = await restartDuringCount('k2s', (key, value) => { values[`steer${key[0].toUpperCase()}${key.slice(1)}`] = value; });
    const followedBefore = await countAssistant('FOLLOWED');
    const followUp = await send(PROMPTS.followUp);
    const acceptedAt = Date.now();
    values.followUpDelivery = followUp.record.deliveryMode;
    assert.equal(followUp.record.deliveryMode, 'steer', 'A message sent while the adopted turn runs must be delivered as a steer.');
    assert.equal(followUp.record.state, 'submitted');
    assert.ok(pgrep(countMarker('k2s')).length > 0, 'The count must still be running when the message is sent.');
    // "Not answered yet" proves nothing right after the send. Watch the count run for 2 s with the steer in, then look for a reply; the count must
    // still be running when the look is over, or a reply would be allowed.
    await wait('the count to be seen running 2 s after the steer was accepted', () => {
      if (pgrep(countMarker('k2s')).length === 0) throw new Error(`The count ended ${Date.now() - acceptedAt} ms after the steer was accepted, before the 2 s the check needs; rerun.`);
      return Date.now() - acceptedAt >= 2000;
    }, 15_000, 250);
    const repliesWhileCounting = await countAssistant('FOLLOWED');
    assert.ok(pgrep(countMarker('k2s')).length > 0, 'The count ended while the unanswered check ran, so the check proves nothing; rerun.');
    values.followUpUnansweredForMs = Date.now() - acceptedAt;
    assert.equal(repliesWhileCounting, followedBefore, 'The steered message must not be answered while the count still runs.');
    await wait('the counting command to finish by itself', () => pgrep(countMarker('k2s')).length === 0, 60_000, 250);
    await wait('assistant reply containing FOLLOWED', async () => (await idle()) && (await countAssistant('FOLLOWED')) > followedBefore);
    values.followUpAnswered = 'after the count';
    // The steer joined the adopted turn: that turn started once and ended once, and the steer started no turn of its own.
    await assertTurnEnds('after the steered turn', steerFrom, { turns: 1, completed: 1, aborted: 0 }, values, 'turnEndsAfterSteeredTurn');
    assert.equal(row().pid, steerRun.oldPid, 'The same app-server must answer the steered message.');
    const after = hostRecord();
    assert.equal(after.host.pid, steerRun.before.host.pid, 'The same session host must still hold it.');
    assert.equal(after.child.pid, steerRun.oldPid);
    assert.equal(after.child.startTicks, startTicksOf(steerRun.oldPid), 'The record must still match /proc: no restart happened.');
    assert.equal(after.child.startTicks, steerRun.before.child.startTicks);
    assert.deepEqual(procEntries().filter(pid => parentOf(pid) === after.host.pid), [steerRun.oldPid], 'The host holds exactly one provider process: no second writer.');

    // Nothing the Console sends on its own (recovery, wake) reached the conversation, and no loss line was written at any point.
    const events = readEventLog(eventLog, eventsBeforeShutdown).entries;
    assert.deepEqual(lostTurnStatusLines(events), [], 'No lost-turn status line may be written for a turn that survived the restart.');
    const injected = findControlText(events, control) ?? rolloutRecords().slice(skip).map(record => findControlText(record, control)).find(Boolean);
    assert.equal(injected, undefined, `The Console sent control text into the conversation: ${injected}`);
    Object.assign(values, { oldPid, newPid: row().pid, samePid: true, hostPid: after.host.pid, recordMatchesProc: true, recoveryOrWakeText: 'none' });
  });

  await step('l', 'screenshot-sized image: a 2560x1440 PNG above 5 MB completes without an image error, and the reply names its dominant colour', async values => {
    const skip = rolloutRecords().length;
    const eventsFrom = readEventLog(eventLogPath()).size;
    const failureBefore = row().run_failure_json;
    const before = await countAssistant('red');
    const png = noisyPng(2560, 1440, [225, 25, 25]);
    values.fileBytes = png.length;
    const upload = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/images`, payload: png, headers: { ...headers, 'content-type': 'image/png' } });
    assert.equal(upload.statusCode, 201, `image upload: HTTP ${upload.statusCode}`);
    const image = upload.json().image;
    const sent = await send(PROMPTS.bigImage, { imageIds: [image.id] });
    assert.equal(sent.record.state, 'submitted');
    // A turn that ends in an image error leaves a run failure on the row, an error record in the rollout, or a status line.
    const failure = () => {
      const stored = row().run_failure_json;
      const errors = rolloutRecords().slice(skip).filter(record => record.type === 'event_msg' && record.payload?.type === 'error').map(record => String(record.payload.message ?? '').slice(0, 160));
      const lines = readEventLog(eventLogPath(), eventsFrom).entries.filter(entry => entry.type === 'status' && /image/i.test(String(entry.text ?? ''))).map(entry => String(entry.text).slice(0, 160));
      return [stored && stored !== failureBefore ? stored.slice(0, 200) : undefined, ...errors, ...lines].filter(Boolean);
    };
    await wait('a completed turn whose reply names the colour', async () => {
      const failed = failure();
      if (failed.length) throw new Error(`The image turn failed (image_error?): ${failed.join(' | ')}`);
      return (await idle()) && (await countAssistant('red')) > before;
    });
    const imageRecord = rolloutRecords().slice(skip).find(record => JSON.stringify(record).includes('input_image') || JSON.stringify(record).includes('localImage') || JSON.stringify(record).includes('local_image'));
    assert.ok(imageRecord, 'The rollout shows no image content for the turn.');
    const dataUrl = JSON.stringify(imageRecord).match(/data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/);
    Object.assign(values, {
      imageId: image.id, mediaType: image.mediaType, width: image.width, height: image.height, storedBytes: image.sizeBytes,
      sentBytes: dataUrl ? Math.floor(dataUrl[1].length * 3 / 4) : 'unknown', rolloutRecordType: imageRecord.payload?.type ?? imageRecord.type,
    });
  });

  await step('m', 'release ends the session; after the session host is ended no process from this proof remains', async values => {
    await api('POST', `/api/sessions/${sessionId}/release`);
    const stored = row();
    assert.equal(stored.status, 'ended');
    assert.equal(stored.should_restore, 0);
    values.status = stored.status;
    assert.notEqual(spawnSync('tmux', ['-L', tmuxSocket, 'ls'], { encoding: 'utf8' }).status, 0, 'No tmux server may have been started during the whole run.');
    values.tmuxServer = 'none';
    // The shared app-server stays up after its last thread is released; the check below must still see its MCP server.
    values.processesAfterRelease = listProcesses().length;
    values.coordMcpAfterRelease = coordMcpProcesses().length;
    await shutdown();
    // The session host and the app-server it holds outlive the backend by design; ending them is a separate, explicit act.
    const host = hostRecord();
    assert.ok(alive(host.host.pid) && alive(host.child.pid), 'The host and the app-server must still be running after backend shutdown.');
    values.hostSurvivedShutdown = true;
    await terminateHost(runtimeDir, 'codex', { info: () => undefined, warn: () => undefined });
    await wait('every process of this proof to exit after the session host is ended', () => listProcesses().length === 0, 20_000, 250);
    assert.ok(!fs.existsSync(hostRecordPath), 'The host record must be removed with the host.');
    values.processesAfterShutdown = 0;
    values.coordMcpAfterShutdown = coordMcpProcesses().length;
  });
} finally {
  // Cleanup runs on every path: release the session, stop the backend, end the session host, kill any child, scan once more for
  // lane processes of this proof, remove the temp root.
  const note = (name, ok, detail) => { evidence.cleanup.push({ name, ok, ...(detail ? { detail } : {}) }); };
  try {
    if (app && sessionId && db && row()?.should_restore) {
      await call('POST', `/api/sessions/${sessionId}/release`);
      note('release session', true);
    }
  } catch (error) { note('release session', false, String(error.message)); }
  try { await shutdown(); note('backend shutdown', true); } catch (error) { note('backend shutdown', false, String(error.message)); }
  try {
    if (fs.existsSync(hostRecordPath)) {
      await terminateHost(runtimeDir, 'codex', { info: () => undefined, warn: () => undefined });
      note('terminate host codex', !fs.existsSync(hostRecordPath));
    }
  } catch (error) { note('terminate host codex', false, String(error.message)); }
  try {
    const leftover = listProcesses();
    for (const pid of leftover) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    if (leftover.length) await sleep(2000);
    const stubborn = listProcesses();
    for (const pid of stubborn) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    if (stubborn.length) await sleep(500);
    // After a run whose steps all passed, release had already ended everything: a process found here is a defect, not tidying up after a failure.
    note('leftover processes', listProcesses().length === 0 && (leftover.length === 0 || evidence.steps.some(entry => !entry.pass)), `${leftover.length} found, ${stubborn.length} needed SIGKILL`);
  } catch (error) { note('leftover processes', false, String(error.message)); }
  try { spawnSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  try {
    const { found, remaining } = await endProofProcesses(root);
    note('final process scan', found.length === 0 && remaining.length === 0, found.length ? `had to end ${found.length} lane process(es) still running: ${summarizeProcesses(found)}${remaining.length ? `; ${remaining.length} survived SIGKILL` : ''}` : 'no lane process of this proof left');
    if (found.length) say(`FINAL SCAN found and ended ${found.length} lane process(es): ${summarizeProcesses(found)}`);
  } catch (error) { note('final process scan', false, String(error.message)); }
  try { fs.rmSync(root, { recursive: true, force: true }); note('remove temp root', !fs.existsSync(root)); } catch (error) { note('remove temp root', false, String(error.message)); }
  const failed = evidence.steps.filter(entry => !entry.pass && !entry.skipped).length;
  const skipped = evidence.steps.filter(entry => entry.skipped).length;
  const cleanupFailed = evidence.cleanup.filter(entry => !entry.ok).length;
  evidence.providerRetries = providerRetries();
  if (evidence.providerRetries?.length) say(`NOTE Codex retried a model request ${evidence.providerRetries.length} time(s) on this thread (${[...new Set(evidence.providerRetries.map(entry => entry.cause))].join('; ')}); turns that waited out a backoff look hung.`);
  evidence.finishedAt = new Date().toISOString();
  evidence.result = failed === 0 && skipped === 0 && cleanupFailed === 0 && evidence.steps.length === 16 ? 'pass' : 'fail';
  evidence.summary = { passed: evidence.steps.filter(entry => entry.pass).length, failed, skipped, cleanupFailed };
  flush();
  say(`${evidence.result.toUpperCase()}: ${evidence.summary.passed} passed, ${failed} failed, ${skipped} skipped, ${cleanupFailed} cleanup problems. Evidence ${evidencePath}`);
  process.exitCode = evidence.result === 'pass' ? 0 : 1;
}
// The backend is closed; end the process even if a library timer is still pending.
process.exit(process.exitCode ?? 1);
