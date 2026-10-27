// Throwaway: spawn `codex app-server` over stdio, ask the model for a question with its request_user_input tool,
// log every frame for the thread, then send "blue" as a second turn. Usage: node capture.mjs <run-name>
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const here = path.dirname(new URL(import.meta.url).pathname);
const run = process.argv[2] ?? 'run1';
const second = process.argv[3] ?? 'blue';
const mode = process.argv[4] ?? 'plain'; // plain | steer
const logFile = path.join(here, `${run}.jsonl`);
const cwd = path.join(here, `scratch-repo-${run}`);
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd });
fs.writeFileSync(logFile, '');
const t0 = Date.now();
const log = (dir, msg) => fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - t0, dir, msg })}\n`);

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
child.stderr.on('data', (chunk) => log('stderr', String(chunk).slice(0, 2000)));
let nextId = 1;
const pending = new Map();
let threadId = null;
const turns = [];
const waiters = [];
const write = (msg) => { log('out', msg); child.stdin.write(`${JSON.stringify(msg)}\n`); };
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  write({ id, method, params });
});
const events = [];
const rl = readline.createInterface({ input: child.stdout });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { log('in-raw', line); return; }
  log('in', msg);
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // A server request: answer so the turn does not hang, and note it.
    events.push({ kind: 'serverRequest', method: msg.method });
    if (msg.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const q of msg.params?.questions ?? []) answers[q.id] = { answers: ['blue'] };
      write({ id: msg.id, result: { answers } });
    } else {
      write({ id: msg.id, result: { decision: 'decline' } });
    }
    return;
  }
  events.push({ kind: 'notification', method: msg.method, params: msg.params });
  for (const w of [...waiters]) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
});
const waitFor = (test, ms) => new Promise((resolve) => {
  const w = { test, resolve };
  waiters.push(w);
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
});

const sandboxPolicy = { type: 'dangerFullAccess' };
const turnParams = (text) => ({
  threadId, input: [{ type: 'text', text }], summary: 'detailed', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy,
});

try {
  await call('initialize', { clientInfo: { name: 'f5-capture', title: 'F5 capture', version: '0.0.1' }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['turn/diff/updated'] } });
  write({ method: 'initialized' });
  const started = await call('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user', config: { mcp_optional_startup_grace_ms: 10000 }, ephemeral: false });
  threadId = started.thread.id;
  log('note', { threadId, cwd });

  const prompt = 'Ask me which color I prefer, red or blue, using your request_user_input tool with a title and options, then wait for my answer.';
  const r1 = await call('turn/start', turnParams(prompt));
  const turn1 = r1.turn.id;
  log('note', { turn1 });
  // Wait up to 90 s for the first turn to complete or for a question-carrying frame.
  const first = await waitFor((m) => (m.method === 'turn/completed' && m.params?.turn?.id === turn1)
    || (m.method === 'item/completed' && (m.params?.item?.questions?.length || m.params?.item?.delivery === 'async')), 90_000);
  log('note', { firstWaitEnded: first ? `${first.method}` : 'timeout' });
  // Give the turn a few more seconds to show what follows the question.
  await new Promise((r) => setTimeout(r, 8000));
  const answerStart = Date.now();
  let r2;
  try {
    if (mode === 'steer') r2 = await call('turn/steer', { threadId, expectedTurnId: turn1, input: [{ type: 'text', text: second }] });
    else r2 = await call('turn/start', turnParams(second));
    log('note', { secondResponse: r2 });
  } catch (error) {
    log('note', { secondError: String(error) });
  }
  const done = await waitFor((m) => m.method === 'turn/completed' && m.params?.turn?.id === (r2?.turn?.id ?? r2?.turnId ?? '__none__'), 90_000);
  log('note', { secondTurnCompleted: Boolean(done), afterMs: Date.now() - answerStart });
  // If the first turn is still open (second queued/steered), wait for it too.
  await waitFor((m) => m.method === 'turn/completed' && m.params?.turn?.id === turn1, 30_000);
} catch (error) {
  log('note', { fatal: String(error) });
} finally {
  child.stdin.end();
  setTimeout(() => child.kill('SIGTERM'), 3000);
  setTimeout(() => process.exit(0), 4500);
}
