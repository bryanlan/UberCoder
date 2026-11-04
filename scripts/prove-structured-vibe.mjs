#!/usr/bin/env node
// Opt-in real-Vibe proof of the structured Mistral Vibe lane (docs/structured-providers.md, "Vibe plugin").
//
// Starts an isolated Console backend (temp root, temp database, temp runtime, scratch git project, coordination enabled
// for the scratch project) with only the Vibe lane on. VIBE_HOME and the discovery root are a directory inside that
// temp root, so trust_cwd does not write Bryan's ~/.vibe. It then drives ONE structured Vibe conversation through the
// HTTP API the web client uses: the project tree advertises vibe, bind checks the session host and that the child is
// `vibe-acp` with no flags and no Mistral API key, the Console registers the conversation itself, the first prompt
// answers PONG, Stop interrupts a running turn, and release ends the process.
//
// Not run in the session that added this script. Usage (build first):
//   env -u NODE_ENV npm run build
//   env -u NODE_ENV node scripts/prove-structured-vibe.mjs --run > /tmp/proof-vibe-backend.log
// Step results go to stderr (one PROOF line each). Evidence JSON is written to test-results/structured-vibe-proof/.
// The throwaway VIBE_HOME is removed with the temp root.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

if (!process.argv.includes('--run')) {
  process.stderr.write('Use --run to opt into a real Mistral Vibe proof (a handful of short turns on the host subscription). Run `npm run build` first. This script was not run when it was added.\n');
  process.exit(2);
}

const { createProofKit } = await import('./structured-proof-kit.mjs');

const PROMPTS = {
  first: 'Reply with exactly the single word PONG.',
  hold: 'Run exactly this shell command and wait for it to finish before replying: sleep 25; then reply with the single word STOPPED.',
};
const TURN_TIMEOUT_MS = 180_000;

const kit = await createProofKit({
  script: 'scripts/prove-structured-vibe.mjs',
  rootPrefix: 'console-structured-vibe-proof',
  evidenceSubdir: 'structured-vibe-proof',
  expectedSteps: 6,
  portFrom: 14410,
  portTo: 14419,
  extraEvidence: { sessionId: null, nativeSessionId: null },
});
const { evidence, call, api, wait, alive, step } = kit;
const vibeHome = path.join(kit.root, 'vibe-home');

kit.writeConfig(config => {
  config.structuredSessions = {
    codex: { enabled: false },
    claude: { enabled: false },
    grok: { enabled: false },
    vibe: { enabled: true, command: ['vibe-acp'], idleUnloadMinutes: 60, env: { VIBE_HOME: vibeHome } },
  };
  config.providers.vibe = { enabled: true, discoveryRoot: vibeHome };
});

let sessionId;
let nativeId;
const hostId = () => `vibe-${sessionId}`;
const row = () => kit.db.prepare('select * from bound_sessions where id = ?').get(sessionId);
const sessionState = async () => {
  const response = await call('GET', `/api/sessions/${sessionId}/screen`);
  return response.status === 404 ? { isWorking: false } : response.body.session;
};
const idle = async () => (await sessionState()).isWorking !== true;
const assignment = () => kit.db.prepare('select * from coordination_assignments where provider = ? and native_session_id = ?').get('vibe', nativeId);
const queueRecord = requestId => {
  const found = kit.db.prepare('select value from meta where key = ?').get(`session-input:${sessionId}:${requestId}`);
  return found ? JSON.parse(found.value) : undefined;
};
const timeline = async () => (await api('GET', `/api/conversations/demo/vibe/${encodeURIComponent(nativeId)}/messages?limit=200`)).messages ?? [];
const assistantTexts = async () => (await timeline()).filter(message => message.role === 'assistant').map(message => message.text);
const countAssistant = async marker => (await assistantTexts()).filter(text => new RegExp(`\\b${marker}\\b`, 'i').test(text)).length;

const send = async (text) => {
  const submissionId = randomUUID();
  const response = await api('POST', `/api/sessions/${sessionId}/keys`, { submissionId, submittedText: text, text, keys: ['Enter'] });
  const record = queueRecord(submissionId);
  assert.ok(record, 'The queued-input record is missing.');
  return { submissionId, record, response };
};

try {
  await kit.boot();

  await step('a', 'project tree advertises Mistral Vibe', async values => {
    const tree = await api('GET', '/api/projects/tree');
    assert.deepEqual(tree.structuredProviders, ['vibe']);
    values.structuredProviders = tree.structuredProviders.join(',');
  }, { fatal: true });

  await step('b', 'structured bind: server session id, host record, vibe-acp with no flags, no Mistral API key, throwaway VIBE_HOME', async values => {
    const bound = await api('POST', '/api/conversations/demo/vibe/new/bind', {});
    sessionId = bound.session.id;
    evidence.sessionId = sessionId;
    const stored = row();
    assert.match(stored.conversation_ref, /^[0-9a-f-]{36}$/, 'conversation_ref must be the session id Vibe allocated.');
    assert.equal(stored.provider, 'vibe');
    assert.ok(stored.tmux_session_name.startsWith('structured:'));
    assert.ok(stored.pid > 0, 'pid must hold the vibe-acp process id.');
    nativeId = stored.conversation_ref;
    evidence.nativeSessionId = nativeId;
    const record = kit.hostRecord(hostId());
    assert.equal(record.child.pid, stored.pid);
    assert.equal(kit.parentOf(stored.pid), record.host.pid, 'vibe-acp must be a child of its session host.');
    const argv = kit.cmdlineOf(stored.pid);
    // vibe-acp is a Python entry script, so argv is the interpreter and then the script path.
    const script = argv.findIndex(arg => path.basename(arg) === 'vibe-acp');
    assert.ok(script >= 0 && script <= 1, `The child must be vibe-acp (saw ${argv.join(' ')}).`);
    assert.equal(argv.length, script + 1, `vibe-acp takes no arguments (saw ${argv.join(' ')}).`);
    assert.equal(argv.includes('--model') || argv.includes('--always-approve') || argv.includes('--reasoning-effort'), false, 'vibe-acp takes no model or approval flags.');
    assert.equal(kit.envValue(stored.pid, 'VIBE_HOME'), vibeHome, 'The child must use this proof\'s VIBE_HOME.');
    assert.ok(kit.envValue(stored.pid, 'MISTRAL_API_KEY') === undefined, 'The child must not carry a Mistral API key.');
    assert.equal(kit.envValue(stored.pid, 'AGENT_CONSOLE_SESSION_ID'), sessionId);
    Object.assign(values, { sessionId, nativeId, pid: stored.pid, hostPid: record.host.pid, vibeHome: 'throwaway' });
  }, { fatal: true });

  await step('c', 'the Console registers the Vibe conversation and writes its coordination credential', async values => {
    const registered = await wait('the Console to register the session', () => assignment(), 30_000);
    assert.equal(registered.provider, 'vibe');
    assert.equal(registered.native_session_id, nativeId);
    const key = createHash('sha256').update(`vibe:${nativeId}`).digest('hex');
    const statePath = path.join(kit.runtimeDir, 'coordination', 'clients', `${key}.json`);
    assert.equal(fs.existsSync(statePath), true, 'The coordination client credential must exist.');
    const credential = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(credential.provider, 'vibe');
    assert.equal(credential.nativeSessionId, nativeId);
    assert.equal(credential.assignmentId, registered.id);
    const owner = path.join(kit.runtimeDir, 'coordination', 'owners', `${credential.ownerPid}-${credential.ownerStart}.json`);
    assert.equal(fs.existsSync(owner), true, 'The owner locator must name the credential.');
    Object.assign(values, { assignmentId: registered.id, credential: 'present' });
  }, { fatal: true });

  await step('d', 'first message completes and the reply contains PONG', async values => {
    const sent = await send(PROMPTS.first);
    assert.equal(sent.record.state, 'submitted', `The first message was not sent (${sent.record.state}: ${sent.record.reason}).`);
    await wait('assistant reply containing PONG', async () => (await idle()) && (await countAssistant('PONG')) > 0, TURN_TIMEOUT_MS);
    // Vibe stores the session-start block and the first message as one prompt; the bubble shows only the person's words.
    const users = (await timeline()).filter(message => message.role === 'user').map(message => message.text);
    assert.deepEqual(users, [PROMPTS.first], `The first user bubble must be the message alone (saw ${JSON.stringify(users).slice(0, 200)}).`);
    Object.assign(values, { turnId: sent.record.turnId, deliveryMode: sent.record.deliveryMode, firstBubble: 'message only' });
  }, { fatal: true });

  await step('e', 'Stop interrupts a running turn and the process survives', async values => {
    const pid = row().pid;
    await send(PROMPTS.hold);
    await wait('the session to start working', async () => (await sessionState()).isWorking === true, 90_000, 250);
    await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
    await wait('the interrupted turn to stop', idle, 30_000, 250);
    assert.equal(alive(pid), true, 'Stop must not end the vibe-acp process.');
    assert.equal(row().pid, pid);
    Object.assign(values, { pid, survived: true });
  });

  await step('f', 'release ends the session and the process', async values => {
    const pid = row().pid;
    const record = kit.hostRecord(hostId());
    await api('POST', `/api/sessions/${sessionId}/release`);
    assert.equal(row().status, 'ended');
    assert.equal(row().should_restore, 0);
    await wait('the vibe process to exit', () => !alive(pid), 15_000, 100);
    await wait('the session host to exit', () => !alive(record.host.pid) && !fs.existsSync(kit.hostRecordPath(hostId())), 20_000, 100);
    values.processesAfterRelease = 0;
    await kit.shutdown();
  });
} finally {
  await kit.finish({
    hostIds: sessionId ? [hostId()] : [],
    releaseAll: async () => {
      if (sessionId && kit.db && row()?.should_restore) await call('POST', `/api/sessions/${sessionId}/release`);
    },
    afterCleanup: async note => {
      note('vibe home stays inside the temp root', vibeHome.startsWith(kit.root), vibeHome);
      // Vibe installs plugin files read-only; make its throwaway home removable.
      const writable = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          fs.chmodSync(full, entry.isDirectory() ? 0o700 : 0o600);
          if (entry.isDirectory()) writable(full);
        }
      };
      if (fs.existsSync(vibeHome)) { fs.chmodSync(vibeHome, 0o700); writable(vibeHome); }
    },
  });
}
