#!/usr/bin/env node
// Opt-in real-Claude proof of the structured Claude lane (docs/structured-cutover.md, "Verification").
//
// Starts an isolated Console backend (temp root, temp database, temp runtime, scratch git project, private tmux socket,
// coordination enabled for the scratch project) with `structuredSessions.claude.enabled` and `defaultTransport: 'tmux'`
// (the proof names `transport: 'structured'` on the bind), then drives ONE structured Claude conversation through the HTTP
// API the web client uses: bind, send, transcript and index, coordination hook and MCP, steer, Stop, an AskUserQuestion
// answered through the card route, an image turn, a live model/effort switch, manual sleep and restore, a graceful backend
// restart while idle (k1) and during a running turn (k2: the `claude` process, held by its session host, survives it; the
// turn is re-adopted, Stop interrupts it and ends its command within 5 s, a message sent meanwhile steers it, the next message completes
// on the same process and every turn ends exactly once), a screenshot-sized image over
// 5 MB (l) and release (m). Real Claude turns run with the host's subscription login and the hooks already installed in Bryan's
// `~/.claude/settings.json` (their helper path is the live checkout's `agent-coord.mjs`; the per-process `AGENT_COORD_RUNTIME` and
// `AGENT_CONSOLE_CONFIG` the plugin sets redirect it to this proof's runtime, which step b and d check). Every prompt is one
// short fixed sentence; message bodies are never printed or recorded.
//
// Usage (build first):  env -u NODE_ENV npm run build
//                       env -u NODE_ENV node scripts/prove-structured-claude.mjs --run > /tmp/proof-claude-backend.log
// Step results go to stderr (one `PROOF` line each); fastify's request log goes to stdout. Evidence JSON is written after
// every step to test-results/structured-claude-proof/<timestamp>.json. The transcripts the CLI writes under
// ~/.claude/projects/<escaped scratch cwd>/ are removed after a passing run and kept (path in the evidence) after a failed one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (!process.argv.includes('--run')) {
  process.stderr.write('Use --run to opt into a real Claude proof (about twenty short turns on the host login). Run `npm run build` first.\n');
  process.exit(2);
}

const { createProofKit, sleep, solidPng, noisyPng, readEventLog, lostTurnStatusLines, consoleControlTexts, findControlText } = await import('./structured-proof-kit.mjs');
const { CLAUDE_COST_PROFILES } = await import('@agent-console/shared');

// ---- prompts (the only message text this proof ever sends) -----------------------------------------------
const RUN_TAG = randomBytes(4).toString('hex');
/** A counting command that carries a unique marker, so its process can be found (and shown gone) on the host. */
const countMarker = tag => `proof-${tag}-${RUN_TAG}`;
const countPrompt = (tag, to = 30) => `Run exactly this shell command and wait for it to finish before replying: echo ${countMarker(tag)}; for i in $(seq 1 ${to}); do echo $i; sleep 1; done`;
/** The counting command, after a coordination `update` that marks the assignment unattended (a message from the person pauses it, so the agent sets it in the same turn). */
const unattendedCountPrompt = (tag, to = 30) => `First call the agent_coordination MCP tool with action update and continuation unattended. After that call succeeds, run exactly this shell command and wait for it to finish before replying: echo ${countMarker(tag)}; for i in $(seq 1 ${to}); do echo $i; sleep 1; done`;
const PROMPTS = {
  first: 'Reply with exactly the single word PONG.',
  coordination: 'Call the agent_coordination MCP tool with action status. If the call succeeded, reply with exactly the single word REGISTERED and nothing else.',
  steer: 'Stop counting now and reply with the single word STEERED.',
  question: 'Use the AskUserQuestion tool to ask me which color I prefer, with options red and blue. After I answer, reply with exactly the single word of the color I chose.',
  image: 'What color is the attached image? Reply with one word.',
  bigImage: 'What is the dominant color of the attached image? Reply with one word.',
  medium: 'Reply with the single word MODEL.',
  low: 'Reply with the single word LOWER.',
  settle: 'Reply with the single word SETTLED.',
  restored: 'Reply with the single word RESTORED.',
  resumed: 'Reply with the single word RESUMED.',
  followUp: 'When your current work is finished, reply with exactly the single word FOLLOWED.',
};
const TURN_TIMEOUT_MS = 240_000;

const claudeVersion = (() => { try { return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const kit = await createProofKit({
  script: 'scripts/prove-structured-claude.mjs', rootPrefix: 'console-structured-claude-proof', evidenceSubdir: 'structured-claude-proof',
  expectedSteps: 14, extraEvidence: { claudeVersion, sessionId: null, nativeSessionId: null, models: {} },
});
const { evidence, say, finding, call, api, wait, alive, pgrep, step } = kit;
say(claudeVersion);

kit.writeConfig(config => {
  // The lane under test is Claude's; the tmux provider block stays as the example template has it (it is never launched).
  config.structuredSessions = { defaultTransport: 'tmux', claude: { enabled: true, command: ['claude'], idleUnloadMinutes: 60, env: {} } };
});

// ---- where Claude keeps the transcript ---------------------------------------------------------------------
const claudeConfigDir = (() => {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return path.join(os.homedir(), '.claude');
  return configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(2)) : path.resolve(configured);
})();
const escapeCwd = cwd => cwd.replace(/[^A-Za-z0-9]/g, '-');
const transcriptDirs = [...new Set([kit.project, fs.realpathSync(kit.project)].map(cwd => path.join(claudeConfigDir, 'projects', escapeCwd(cwd))))];
const tilde = file => file.replace(os.homedir(), '~');

// ---- session accessors -------------------------------------------------------------------------------------
let sessionId;
let nativeId;
const hostId = () => `claude-${sessionId}`;
const row = () => kit.db.prepare('select * from bound_sessions where id = ?').get(sessionId);
const sessionState = async () => {
  const response = await call('GET', `/api/sessions/${sessionId}/screen`);
  return response.status === 404 ? { isWorking: false, pendingRequests: [] } : response.body.session;
};
const idle = async () => (await sessionState()).isWorking !== true;
const indexRow = () => kit.db.prepare('select transcript_path from conversation_index where project_slug = ? and provider = ? and ref = ?').get('demo', 'claude', nativeId);
const assignment = () => kit.db.prepare('select * from coordination_assignments where provider = ? and native_session_id = ?').get('claude', nativeId);
const epoch = () => kit.db.prepare('select value from meta where key = ?').get(`structured-epoch:${sessionId}`)?.value;
/** The continuation state the Console keeps for an assignment (`unattended` lets RunRecovery act on a lost turn). */
const continuationOf = id => {
  const found = kit.db.prepare('select value from meta where key = ?').get(`assignment-continuation:${id}`);
  return found ? JSON.parse(found.value) : undefined;
};
const queueRecord = requestId => {
  const found = kit.db.prepare('select value from meta where key = ?').get(`session-input:${sessionId}:${requestId}`);
  return found ? JSON.parse(found.value) : undefined;
};
const timeline = async () => (await api('GET', `/api/conversations/demo/claude/${encodeURIComponent(nativeId)}/messages?limit=200`)).messages ?? [];
const assistantTexts = async () => (await timeline()).filter(message => message.role === 'assistant').map(message => message.text);
/** Assistant messages that hold the marker as a whole word (so `red` does not match `registered`). */
const countAssistant = async marker => {
  const pattern = new RegExp(`\\b${marker}\\b`, 'i');
  return (await assistantTexts()).filter(text => pattern.test(text)).length;
};

/** The transcript file, read incrementally (it holds large request blobs; only new bytes are parsed on each poll). */
const transcript = { file: undefined, offset: 0, rest: '', records: [] };
const transcriptFile = () => transcript.file ?? (nativeId ? transcriptDirs.map(dir => path.join(dir, `${nativeId}.jsonl`)).find(file => fs.existsSync(file)) : undefined);
const records = () => {
  const file = transcriptFile();
  if (!file) return transcript.records;
  transcript.file = file;
  const size = fs.statSync(file).size;
  if (size < transcript.offset) Object.assign(transcript, { offset: 0, rest: '', records: [] });
  if (size > transcript.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - transcript.offset);
      fs.readSync(fd, buffer, 0, buffer.length, transcript.offset);
      transcript.offset = size;
      const lines = (transcript.rest + buffer.toString('utf8')).split('\n');
      transcript.rest = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { transcript.records.push(JSON.parse(line)); } catch { /* a torn or non-JSON line */ }
      }
    } finally { fs.closeSync(fd); }
  }
  return transcript.records;
};
const blocksOf = record => Array.isArray(record.message?.content) ? record.message.content : typeof record.message?.content === 'string' ? [{ type: 'text', text: record.message.content }] : [];
const textOf = record => blocksOf(record).filter(block => block.type === 'text').map(block => block.text).join('\n');
const resultText = block => typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(part => part.text ?? '').join('\n') : '';
const toolUsesSince = (skip, name) => records().slice(skip).filter(record => record.type === 'assistant').flatMap(record => blocksOf(record).filter(block => block.type === 'tool_use' && (!name || block.name === name)));
const toolResultsSince = skip => records().slice(skip).filter(record => record.type === 'user').flatMap(record => blocksOf(record).filter(block => block.type === 'tool_result'));
/**
 * The models the conversation's own requests asked for since `skip` (the `api-request` records; a headless process labels them
 * `querySource: "sdk"`, the TUI `repl_main_thread`; side queries such as titles carry other labels), and the efforts its assistant rows carry.
 */
const modelRequestsSince = skip => records().slice(skip)
  .filter(record => record.type === 'api-request' && (!record.querySource || record.querySource === 'sdk' || record.querySource === 'repl_main_thread'))
  .map(record => record.params?.model).filter(Boolean);
/** The reasoning effort each of those requests carried (`output_config.effort`). */
const effortRequestsSince = skip => [...new Set(records().slice(skip)
  .filter(record => record.type === 'api-request' && (!record.querySource || record.querySource === 'sdk' || record.querySource === 'repl_main_thread'))
  .map(record => record.params?.output_config?.effort).filter(Boolean))];
const hooksSince = skip => [...new Set(records().slice(skip).filter(record => record.type === 'attachment' && record.attachment?.type === 'hook_success').map(record => record.attachment.hookEvent))].sort();
/** Escape writes this one user row and ends the turn (the Console's run monitor reads the same shape). */
const isInterruptionRecord = entry => {
  if (entry.type !== 'user' || entry.isSidechain === true) return false;
  const parts = blocksOf(entry).filter(block => block.type === 'text');
  return parts.length === 1 && /^\[Request interrupted by user(?: for tool use)?\]$/.test(String(parts[0].text).trim());
};
/** A submitted prompt: a user row with text, not a tool result, a meta row or an interruption. */
const isPromptRecord = entry => entry.type === 'user' && entry.isSidechain !== true && entry.isMeta !== true && entry.isCompactSummary !== true
  && !isInterruptionRecord(entry) && blocksOf(entry).some(block => block.type === 'text' && String(block.text).trim().length > 0);
/**
 * The turn-end rows of the transcript from record `from` on, counted from the first prompt in that window (the end of an earlier turn can still
 * be landing). A completed turn writes one Stop hook summary (a headless transcript has no `turn_duration` rows); a stopped turn writes the
 * interruption row and runs no Stop hook.
 */
const turnEndsSince = from => {
  const rows = records().slice(from).filter(entry => entry.isSidechain !== true);
  const first = rows.findIndex(isPromptRecord);
  const own = first < 0 ? [] : rows.slice(first);
  return { completed: own.filter(entry => entry.type === 'system' && entry.subtype === 'stop_hook_summary').length, interrupted: own.filter(isInterruptionRecord).length };
};
/**
 * Waits for the turn-end rows `expected` names, lets the transcript settle for 2 s so a second end would have arrived, then requires exactly
 * those since record `from`: one end per turn, not zero and not two. The counts go into `values[key]`.
 */
const assertTurnEnds = async (label, from, expected, values, key) => {
  const wanted = expected.completed + expected.interrupted;
  const found = () => { const seen = turnEndsSince(from); return seen.completed + seen.interrupted; };
  try { await wait(`${wanted} turn-end row(s) in the transcript (${label})`, () => found() >= wanted, 20_000, 250); } catch (error) { if (!/^Timed out/.test(error.message)) throw error; }
  await sleep(2000);
  const seen = turnEndsSince(from);
  values[key] = `${seen.completed} completed, ${seen.interrupted} interrupted`;
  assert.deepEqual(seen, expected, `Every turn must end exactly once (${label}); the transcript holds ${seen.completed} Stop hook summary(ies) and ${seen.interrupted} interruption row(s), expected ${expected.completed} and ${expected.interrupted}.`);
};

/** Send one chat message the way the web client does and return the queue record it produced. */
const send = async (text, extra = {}) => {
  const submissionId = randomUUID();
  const response = await api('POST', `/api/sessions/${sessionId}/keys`, { submissionId, submittedText: text, text, keys: ['Enter'], ...extra });
  const record = queueRecord(submissionId);
  assert.ok(record, 'The queued-input record is missing.');
  return { submissionId, record, response, sentAt: Date.now() };
};
/** Wait until the turn is over and one more assistant message carries the marker than before `before`. */
const waitForReply = (marker, before) => wait(`assistant reply containing ${marker}`, async () => (await idle()) && (await countAssistant(marker)) > before, TURN_TIMEOUT_MS);
/** Send a message and wait for its reply. */
const converse = async (text, marker, extra) => {
  const before = await countAssistant(marker);
  const sent = await send(text, extra);
  await waitForReply(marker, before);
  return sent;
};
const switchProfile = async profile => {
  const response = await call('POST', `/api/sessions/${sessionId}/model-profile`, { profile });
  assert.ok(response.status < 300, `model-profile ${profile}: HTTP ${response.status} ${response.body?.error ?? ''}`);
  await wait(`the ${profile} profile request to complete`, () => !row().model_profile_request_json, 30_000, 250);
  assert.equal(row().claude_profile, profile);
};
const claudePid = () => row()?.pid;
const eventLogPath = () => row()?.event_log_path;
/** After a restart: the same process under the same host, one provider process under the host, and exactly one live holder of the session. */
const assertSameProcess = (oldPid, before) => {
  const after = kit.hostRecord(hostId());
  assert.equal(after.host.pid, before.host.pid, 'The same session host must still hold it.');
  assert.equal(after.child.pid, oldPid);
  assert.equal(after.child.startTicks, kit.startTicksOf(oldPid), 'The record must still match /proc: no restart happened.');
  assert.equal(after.child.startTicks, before.child.startTicks);
  assert.deepEqual(kit.procEntries().filter(pid => kit.parentOf(pid) === after.host.pid), [oldPid], 'The host holds exactly one provider process: no second writer.');
  const holders = fs.readdirSync(path.join(claudeConfigDir, 'sessions')).filter(name => name.endsWith('.json')).flatMap(name => {
    try { const entry = JSON.parse(fs.readFileSync(path.join(claudeConfigDir, 'sessions', name), 'utf8')); return entry.sessionId === nativeId && alive(entry.pid) ? [entry.pid] : []; } catch { return []; }
  });
  assert.deepEqual(holders, [oldPid], 'Exactly one live process may hold the session.');
  return { after, holders };
};


/** A failed step can leave a turn running or a question open; settle both so the next step is judged on its own. */
kit.hooks.beforeStep = async entry => {
  if (!sessionId || !kit.app || !kit.db) return;
  const state = await sessionState();
  for (const request of state.pendingRequests ?? []) {
    await call('POST', `/api/sessions/${sessionId}/requests/${request.requestId}`, { decision: 'decline' });
    entry.values.declinedLeftoverQuestion = true;
  }
  if (state.isWorking !== true) return;
  try { await wait('the previous turn to end', idle, 20_000, 500); return; } catch { /* still working: stop it */ }
  entry.values.stoppedLeftoverTurn = true;
  await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
  await wait('the leftover turn to stop', idle, 20_000, 500);
};

/** The turn is working; wait for the marked command to be running on the host, then a moment more. */
const countingStarted = async (tag, values) => {
  await wait('the session to start working', async () => (await sessionState()).isWorking === true, 90_000, 250);
  const found = await wait('the counting command to be running', () => { const pids = pgrep(countMarker(tag)); return pids.length ? pids : undefined; }, 120_000, 250);
  values.commandPids = found.length;
  await sleep(1500);
  return found;
};

let mcpIsolated;
try {
  await kit.boot();

  await step('a', 'project tree advertises the structured provider', async values => {
    const tree = await api('GET', '/api/projects/tree');
    assert.deepEqual(tree.structuredProviders, ['claude']);
    values.structuredProviders = tree.structuredProviders.join(',');
  }, { fatal: true });

  await step('b', 'structured bind: UUID native id, sentinel name, host record, process environment', async values => {
    const bound = await api('POST', '/api/conversations/demo/claude/new/bind', { transport: 'structured' });
    sessionId = bound.session.id;
    evidence.sessionId = sessionId;
    assert.equal(bound.session.transport, 'structured');
    assert.match(bound.conversationRef, /^pending:/, 'The response keeps the pending alias ref.');
    const stored = row();
    assert.match(stored.conversation_ref, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'conversation_ref must be the Claude session UUID.');
    assert.equal(stored.resume_conversation_ref, stored.conversation_ref);
    assert.ok(stored.tmux_session_name.startsWith('structured:'), 'The tmux name must be the sentinel.');
    assert.equal(stored.transport, 'structured');
    assert.equal(stored.raw_log_path, null);
    assert.ok(stored.pid > 0, 'pid must hold the claude process id.');
    nativeId = stored.conversation_ref;
    evidence.nativeSessionId = nativeId;
    evidence.pids.claudeFirst = stored.pid;
    assert.notEqual(kit.tmux('ls').status, 0, 'The private tmux socket must have no server.');
    // The per-session host record names the process, its group and start times, and the process is the host's child.
    const record = kit.hostRecord(hostId());
    assert.equal(record.child.pid, stored.pid, 'The host record must name the pid that the row holds.');
    assert.equal(record.child.processGroup, stored.pid, 'The claude process must lead its own process group.');
    assert.equal(record.child.startTicks, kit.startTicksOf(stored.pid), 'The recorded start time must match /proc.');
    assert.equal(record.host.startTicks, kit.startTicksOf(record.host.pid), 'The recorded host start time must match /proc.');
    assert.equal(kit.parentOf(stored.pid), record.host.pid, 'The claude process must be a child of its session host.');
    assert.ok(record.parentDeathSignal, 'The claude process must be started with a parent death signal relative to the host.');
    evidence.pids.sessionHost = record.host.pid;
    // The child's own environment: this proof's runtime and config, this conversation's identity, no inherited identity.
    assert.equal(kit.envValue(stored.pid, 'AGENT_COORD_RUNTIME'), kit.runtimeDir, 'The process must point hooks at this Console runtime.');
    assert.equal(kit.envValue(stored.pid, 'AGENT_CONSOLE_CONFIG'), kit.configPath, 'The process must name this Console config.');
    assert.equal(kit.envValue(stored.pid, 'AGENT_CONSOLE_SESSION_ID'), sessionId, 'The process must carry its own Console session id.');
    assert.equal(kit.envValue(stored.pid, 'TMUX'), undefined, 'No tmux identity may reach the process.');
    assert.equal(kit.envValue(stored.pid, 'CLAUDE_CODE_SDK_READS_SESSION_STATE'), '1');
    const argv = kit.cmdlineOf(stored.pid);
    assert.ok(argv.includes('--session-id') && argv[argv.indexOf('--session-id') + 1] === nativeId, 'The argv must launch --session-id <native id>.');
    assert.ok(argv.includes('--dangerously-skip-permissions') && argv.includes('--input-format') && !argv.includes('-p'), 'The argv must be stream-json input without -p.');
    // Hooks and the coordination MCP server are the Console's: the MCP server the CLI starts must carry this runtime. Without
    // that, a turn that calls the tool would reach the live Console (the user-scope MCP entry names the live runtime).
    const mcp = await wait('the coordination MCP server of the process to start', () => {
      const servers = kit.descendantsOf(stored.pid).filter(pid => kit.cmdlineOf(pid).some(arg => arg.endsWith('agent-coord.mjs')) && kit.cmdlineOf(pid).includes('mcp'));
      return servers.length ? servers : undefined;
    }, 20_000, 500).catch(() => []);
    const runtimes = mcp.map(pid => kit.envValue(pid, 'AGENT_COORD_RUNTIME'));
    mcpIsolated = mcp.length > 0 && runtimes.every(runtime => runtime === kit.runtimeDir);
    if (mcp.length && mcpIsolated) finding('mcp-precedence', `~/.claude.json defines a user-scope agent_console_coordination server that names the live runtime; the plugin's --mcp-config entry of the same name won: ${mcp.length} coordination MCP server(s) started, all with the isolated runtime.`);
    if (mcp.length && !mcpIsolated) finding('mcp-precedence', `The CLI started a coordination MCP server with runtime ${runtimes.map(runtime => tilde(String(runtime))).join(', ')} instead of the isolated one: the user-scope MCP entry won over --mcp-config.`);
    Object.assign(values, { sessionId, nativeId, pid: stored.pid, hostPid: record.host.pid, tmuxName: stored.tmux_session_name, tmuxServer: 'none', coordEnv: 'ok', consoleSessionIdEnv: 'ok', mcpServers: mcp.length, mcpIsolated: String(mcpIsolated) });
  }, { fatal: true });

  await step('c', 'first message completes; transcript, human turn origin and index', async values => {
    // The default profile (medium: Opus) is the launch model. The proof switches to the low profile before the first turn to
    // keep the turns cheap; that also settles that a profile change reaches an already running process (set_model).
    const pidBefore = claudePid();
    await switchProfile('low');
    assert.equal(claudePid(), pidBefore, 'The claude process must not restart for a model change.');
    const { record } = await send(PROMPTS.first);
    assert.equal(record.state, 'submitted');
    assert.equal(record.deliveryMode, 'turn');
    assert.ok(record.turnId, 'The record must carry the provider turn id (the message uuid).');
    await waitForReply('PONG', 0);
    const { session } = await api('GET', `/api/sessions/${sessionId}/screen`);
    assert.ok(session.lastResponseAt, 'lastResponseAt must be set by the completed turn.');
    const file = await wait('the conversation index to learn the transcript path', async () => {
      await api('GET', `/api/conversations/demo/claude/${encodeURIComponent(nativeId)}/messages?limit=0`);
      return indexRow()?.transcript_path;
    }, 60_000);
    assert.ok(fs.existsSync(file), 'The transcript file is missing.');
    assert.ok(transcriptDirs.some(dir => file === path.join(dir, `${nativeId}.jsonl`)), `The transcript must live at ~/.claude/projects/<escaped cwd>/<id>.jsonl, not ${tilde(file)}.`);
    const all = records();
    const prompt = all.find(entry => entry.type === 'user' && textOf(entry).includes(PROMPTS.first));
    assert.ok(prompt, 'The transcript has no user row for the prompt.');
    assert.equal(prompt.turnOrigin, 'human', 'The transcript must record the turn as human-originated.');
    assert.equal(prompt.origin?.kind, 'human');
    const models = modelRequestsSince(0);
    assert.ok(models.length > 0 && models.every(model => model.includes(CLAUDE_COST_PROFILES.low.model)), `The first turn must run on the low profile's model (saw ${models.join(', ')}).`);
    const firstEfforts = effortRequestsSince(0);
    assert.deepEqual(firstEfforts, [CLAUDE_COST_PROFILES.low.reasoningEffort], `The first turn must carry the low profile's effort (saw ${firstEfforts.join(', ')}).`);
    evidence.models.firstTurn = `${models[0]} ${firstEfforts.join('/')}`;
    Object.assign(values, {
      turnId: record.turnId, deliveryMode: record.deliveryMode, lastResponseAt: session.lastResponseAt, transcript: tilde(file), records: all.length,
      turnOrigin: prompt.turnOrigin, entrypoint: prompt.entrypoint, promptSource: prompt.promptSource, model: models[0], effort: firstEfforts[0], profileSwitchedBeforeTurn: 'low', pid: claudePid(),
    });
  }, { fatal: true });

  await step('d', 'coordination: SessionStart hook registered the session; the agent called the MCP tool', async values => {
    const registered = await wait('the SessionStart hook to register the session', () => assignment(), 30_000);
    assert.equal(registered.native_session_id, nativeId);
    const before = registered.last_seen_at;
    // The user-scope MCP entry in ~/.claude.json names the live runtime. If the process's MCP server is not the proof's, the
    // tool call would reach the live Console, so the call is not made.
    assert.notEqual(mcpIsolated, false, 'The process\'s coordination MCP server is not pinned to this proof\'s runtime; the MCP call was not attempted.');
    const skip = records().length;
    await sleep(1100);
    const mcpPids = new Set();
    const base = await countAssistant('REGISTERED');
    const sent = await send(PROMPTS.coordination);
    assert.equal(sent.record.state, 'submitted');
    await wait('assistant reply containing REGISTERED', async () => {
      for (const pid of kit.coordMcpProcesses()) mcpPids.add(pid);
      return (await idle()) && (await countAssistant('REGISTERED')) > base;
    }, TURN_TIMEOUT_MS, 250);
    assert.ok(mcpPids.size > 0, 'No agent-coord.mjs mcp process with this proof\'s runtime was seen: the MCP server is not pinned to this Console.');
    const after = assignment();
    assert.ok(after.last_seen_at > before, 'The assignment must have been seen again during the turn.');
    const calls = toolUsesSince(skip).filter(block => /agent_coordination/.test(block.name));
    assert.ok(calls.length > 0, 'The transcript shows no agent_coordination tool call.');
    const results = toolResultsSince(skip).filter(block => calls.some(use => use.id === block.tool_use_id));
    assert.ok(results.length > 0 && results.every(block => !block.is_error), 'The agent_coordination call must have succeeded.');
    Object.assign(values, { assignmentId: after.id, nativeSessionId: after.native_session_id, status: after.status, lastSeenBefore: before, lastSeenAfter: after.last_seen_at, mcpProcesses: mcpPids.size, mcpToolName: calls[0].name });
  });

  await step('e', 'steer: a message sent mid-turn is delivered as a steer; how it lands in the transcript', async values => {
    const skip = records().length;
    const baseline = await countAssistant('STEERED');
    const first = await send(countPrompt('e'));
    assert.equal(first.record.deliveryMode, 'turn');
    await countingStarted('e', values);
    const steered = await send(PROMPTS.steer);
    assert.equal(steered.record.state, 'submitted');
    assert.equal(steered.record.deliveryMode, 'steer', 'A message sent while a turn runs must steer it.');
    assert.equal(steered.record.turnId, first.record.turnId, 'A steer joins the running turn.');
    await waitForReply('STEERED', baseline);
    values.steerToReplyMs = Date.now() - steered.sentAt;
    Object.assign(values, { turnId: steered.record.turnId, deliveryMode: steered.record.deliveryMode });
    // Settle brief sections 4 and 14: the shape of a mid-turn message in the transcript and whether it was folded into the turn.
    const rows = records().slice(skip);
    const steerIndex = rows.findIndex(entry => JSON.stringify(entry.attachment ?? entry.message ?? entry.content ?? '').includes('Stop counting now'));
    const steerRow = rows[steerIndex];
    const queued = rows.find(entry => entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && JSON.stringify(entry.attachment).includes('Stop counting now'));
    const operations = rows.filter(entry => entry.type === 'queue-operation' && JSON.stringify(entry).includes('Stop counting now')).map(entry => entry.operation);
    const resultIndex = rows.findIndex(entry => entry.type === 'user' && blocksOf(entry).some(block => block.type === 'tool_result' && resultText(block).includes(countMarker('e'))));
    const output = resultIndex >= 0 ? blocksOf(rows[resultIndex]).filter(block => block.type === 'tool_result').map(resultText).join('\n') : '';
    const numbers = [...output.matchAll(/^(\d+)$/gm)].map(match => Number(match[1]));
    const lastAssistant = rows.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === 'assistant').at(-1)?.index;
    // A headless transcript has no turn_duration rows; every finished turn writes one Stop hook summary.
    const turns = rows.filter(entry => entry.type === 'system' && entry.subtype === 'stop_hook_summary').length;
    const hooks = hooksSince(skip);
    Object.assign(values, {
      steerRowType: steerRow ? (queued ? 'attachment:queued_command' : steerRow.type) : 'not found',
      queuedCommandOrigin: queued?.attachment?.origin?.kind ?? 'none', queuedCommandHumanTurn: String(queued?.attachment?.humanTurn ?? 'none'),
      queueOperations: operations.join(',') || 'none', steerRowIndex: steerIndex, toolResultIndex: resultIndex, finalAssistantIndex: lastAssistant ?? -1,
      commandOutputLastNumber: numbers.at(-1) ?? 0, stopHookSummaries: turns, hooksSeen: hooks.join(','),
    });
    assert.ok(hooks.includes('Stop') && hooks.includes('PostToolUse'), `The Stop and PostToolUse hooks must run in a headless turn (saw ${hooks.join(', ')}).`);
    finding('steer-shape', `A plain mid-turn message (deliveryMode steer) was recorded as ${values.steerRowType}${queued ? ` (origin ${values.queuedCommandOrigin}, humanTurn ${values.queuedCommandHumanTurn})` : ''}; `
      + `the counting command had printed up to ${values.commandOutputLastNumber} of 30 when its result row was written, and the transcript has ${turns} Stop hook summary(ies) for this exchange, `
      + `so the message was ${turns <= 1 ? 'folded into the running turn' : 'run as a separate turn'}${values.commandOutputLastNumber >= 30 ? ' only after the shell command finished (fold happens at the tool boundary, it does not shorten a running command)' : ' while the command was still running'}.`);
  });

  await step('f', 'Stop: Escape interrupts a running turn; the process survives and the shell command ends', async values => {
    const skip = records().length;
    const pid = claudePid();
    await send(countPrompt('f'));
    const commandPids = await countingStarted('f', values);
    const stopped = Date.now();
    await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
    await wait('the session to become idle after Stop', idle, 15_000, 250);
    values.idleAfterMs = Date.now() - stopped;
    assert.equal(claudePid(), pid, 'The row pid must not change for an interrupt.');
    assert.ok(alive(pid), 'The claude process must survive an interrupt.');
    assert.equal(kit.hostRecord(hostId()).child.pid, pid, 'The host must still hold the same process.');
    // Within 5 s, as in k2: the 30 s count would otherwise run out on its own inside a longer wait and pass for a Stop that worked.
    await wait('the counting command to end within 5 s of Stop', () => commandPids.every(commandPid => !alive(commandPid)) && pgrep(countMarker('f')).length === 0, 5_000, 100);
    values.commandGoneAfterMs = Date.now() - stopped;
    const marker = await wait('the transcript to record the interruption', () =>
      records().slice(skip).find(entry => entry.type === 'user' && /Request interrupted by user/i.test(textOf(entry) + blocksOf(entry).map(resultText).join('\n'))), 15_000, 500);
    values.interruptionMarker = textOf(marker).slice(0, 60) || 'in a tool_result';
    assert.equal((await sessionState()).isWorking, false);
    Object.assign(values, { pid, processSurvived: true });
  });

  await step('g', 'question: AskUserQuestion becomes a pending request, the card route answers it, the answer reaches the model', async values => {
    const skip = records().length;
    const before = await countAssistant('blue');
    await send(PROMPTS.question);
    let sawWorking = false;
    const outcome = await wait('a pending question or the end of the turn', async () => {
      const state = await sessionState();
      if (state.pendingRequests?.length) return { kind: 'question', request: state.pendingRequests[0], working: state.isWorking };
      if (state.isWorking === true) sawWorking = true;
      if (sawWorking && state.isWorking !== true) return { kind: 'ended' };
      return undefined;
    }, 150_000, 250);
    if (outcome.kind === 'ended') {
      // The tool was not offered, or the CLI refused it: a finding about the real CLI, not a failure of the Console.
      const uses = toolUsesSince(skip, 'AskUserQuestion');
      const results = toolResultsSince(skip).filter(block => uses.some(use => use.id === block.tool_use_id)).map(resultText);
      values.askUserQuestionOffered = 'no question reached the Console';
      values.toolAttempts = uses.length;
      values.toolResult = (results[0] ?? '').slice(0, 120);
      finding('ask-user-question', `AskUserQuestion produced no pending request under --dangerously-skip-permissions --permission-prompt-tool stdio (tool attempts ${uses.length}; first tool result: ${JSON.stringify((results[0] ?? '').slice(0, 160))}).`);
      return;
    }
    const request = outcome.request;
    assert.equal(request.kind, 'question');
    assert.equal(outcome.working, true, 'The turn is blocked on the question: the session must read as working.');
    assert.ok(request.questions.length >= 1, 'The pending request must carry its question.');
    const question = request.questions[0];
    const labels = question.options.map(option => option.label);
    const blue = labels.find(label => /blue/i.test(label));
    assert.ok(blue && labels.some(label => /red/i.test(label)), `The options must offer red and blue (saw ${labels.join(', ')}).`);
    values.requestKind = request.kind;
    values.options = labels.join('/');
    values.multiSelect = String(question.multiSelect ?? false);
    values.allowCustom = String(question.allowCustom ?? false);
    const answered = await api('POST', `/api/sessions/${sessionId}/requests/${request.requestId}`, { decision: 'answer', answers: { [question.id]: [blue] } });
    assert.equal(answered.session.pendingRequests?.length ?? 0, 0, 'The answered question must leave the row.');
    const second = await call('POST', `/api/sessions/${sessionId}/requests/${request.requestId}`, { decision: 'answer', answers: { [question.id]: [blue] } });
    assert.ok(second.status >= 400, 'A second answer to the same question must be refused.');
    await waitForReply('blue', before);
    const uses = toolUsesSince(skip, 'AskUserQuestion');
    assert.ok(uses.length > 0, 'The transcript shows no AskUserQuestion call.');
    const results = toolResultsSince(skip).filter(block => uses.some(use => use.id === block.tool_use_id)).map(resultText);
    assert.ok(results.some(text => /blue/i.test(text)), 'The tool result the model received must carry the answer.');
    values.toolResultCarriesAnswer = true;
    values.secondAnswerStatus = second.status;
  });

  await step('h', 'image: an attached PNG reaches the model as an image block', async values => {
    const skip = records().length;
    const before = await countAssistant('green');
    const upload = await kit.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/images`, payload: solidPng(64, [0, 170, 0]), headers: { ...kit.headers, 'content-type': 'image/png' } });
    assert.equal(upload.statusCode, 201, `image upload: HTTP ${upload.statusCode}`);
    const image = upload.json().image;
    const sent = await send(PROMPTS.image, { imageIds: [image.id] });
    assert.equal(sent.record.state, 'submitted');
    await waitForReply('green', before);
    const prompt = records().slice(skip).find(entry => entry.type === 'user' && textOf(entry).includes('What color is the attached image'));
    assert.ok(prompt, 'The transcript has no user row for the image prompt.');
    const imageBlocks = blocksOf(prompt).filter(block => block.type === 'image');
    assert.equal(imageBlocks.length, 1, 'The user row must carry the image as a content block.');
    const reads = toolUsesSince(skip, 'Read').length;
    Object.assign(values, { imageId: image.id, mediaType: image.mediaType, imageBlocks: imageBlocks.length, sourceType: imageBlocks[0].source?.type ?? 'unknown', width: image.width, readToolCalls: reads });
    if (reads > 0) finding('image-envelope-read', 'The image reached the model as a native image block, and the model also opened the stored file with the Read tool because the prompt text still carries the tmux "inspect the attached files" envelope; the answer is the same, one extra tool call.');
  });

  await step('i', 'model and effort: the profile reaches the running process on the next turn, with no restart', async values => {
    const pid = claudePid();
    const argvBefore = kit.cmdlineOf(pid).join(' ');
    const turn = async (profile, prompt, marker) => {
      await switchProfile(profile);
      const skip = records().length;
      await converse(prompt, marker);
      const models = modelRequestsSince(skip);
      const efforts = effortRequestsSince(skip);
      const expected = CLAUDE_COST_PROFILES[profile];
      assert.ok(models.length > 0 && models.every(model => model.includes(expected.model)), `The ${profile} turn must use ${expected.model} (saw ${models.join(', ')}).`);
      assert.deepEqual(efforts, [expected.reasoningEffort], `The ${profile} turn must carry effort ${expected.reasoningEffort} (saw ${efforts.join(', ')}).`);
      evidence.models[`${profile}Turn`] = `${models[0]} ${efforts.join('/')}`;
      return { models, efforts, modelRows: records().slice(skip).filter(entry => entry.type === 'user' && textOf(entry).includes('<command-name>/model')).length };
    };
    const medium = await turn('medium', PROMPTS.medium, 'MODEL');
    const low = await turn('low', PROMPTS.low, 'LOWER');
    assert.equal(claudePid(), pid, 'The claude process must not restart for a model change.');
    assert.equal(kit.cmdlineOf(pid).join(' '), argvBefore, 'The process command line is fixed at launch.');
    // A live switch writes `/model` local-command rows into the transcript; the timeline must not show them as messages.
    const leaked = (await timeline()).filter(message => /command-name|local-command|command-message/.test(message.text));
    assert.equal(leaked.length, 0, 'The /model local-command rows must not appear in the conversation timeline.');
    Object.assign(values, {
      pid, mediumModel: medium.models[0], mediumEffort: medium.efforts[0], lowModel: low.models[0], lowEffort: low.efforts[0],
      modelCommandRowsPerSwitch: medium.modelRows, timelineLeaks: leaked.length,
    });
    finding('model-switch-rows', `A live profile switch (set_model) writes a "/model <id>" local-command row into the transcript (${medium.modelRows} per switch); the Console timeline filters them out. The effort follows the profile too (request effort ${medium.efforts[0]} then ${low.efforts[0]}).`);
  });

  await step('j', 'manual sleep ends the process; restore resumes the same session on a new process', async values => {
    const pidBefore = claudePid();
    const epochBefore = epoch();
    // An interrupted turn runs no Stop hook, so the assignment can stay `active`, and a manual sleep is refused while it is.
    values.assignmentBefore = assignment()?.status ?? 'none';
    if (values.assignmentBefore === 'active') {
      const refused = await call('POST', `/api/sessions/${sessionId}/suspend`);
      assert.equal(refused.status, 409, 'A manual sleep must be refused while the assignment is active.');
      values.refusedWhileActive = true;
      await converse(PROMPTS.settle, 'SETTLED');
      await wait('the assignment to leave `active` after a completed turn', () => assignment()?.status !== 'active', 30_000);
    }
    const record = kit.hostRecord(hostId());
    const suspended = await api('POST', `/api/sessions/${sessionId}/suspend`);
    assert.ok(suspended.session.manualSuspendedAt, 'manualSuspendedAt must be set.');
    assert.ok(row().manual_suspended_at);
    values.manualSuspendedAt = suspended.session.manualSuspendedAt;
    await wait('the claude process to exit', () => !alive(pidBefore), 15_000, 100);
    await wait('the session host to exit', () => !alive(record.host.pid), 15_000, 100);
    assert.equal((await call('GET', `/api/sessions/${sessionId}/screen`)).status, 404, 'A suspended row has no screen to poll.');
    const resumed = await api('POST', `/api/sessions/${sessionId}/resume`);
    assert.equal(resumed.session.manualSuspendedAt, undefined, 'manualSuspendedAt must be cleared.');
    assert.equal(row().manual_suspended_at, null);
    const pidAfter = await wait('a new claude process', () => { const pid = claudePid(); return pid && pid !== pidBefore && alive(pid) ? pid : undefined; }, 30_000, 250);
    const argv = kit.cmdlineOf(pidAfter);
    assert.ok(argv.includes('--resume') && argv[argv.indexOf('--resume') + 1] === nativeId, 'The new process must resume the same session id.');
    assert.ok(!argv.includes('--session-id'), 'A restore must resume, not start a session.');
    assert.equal(kit.envValue(pidAfter, 'AGENT_CONSOLE_SESSION_ID'), sessionId);
    assert.notEqual(epoch(), epochBefore, 'Restoring the session must start a new epoch.');
    await converse(PROMPTS.restored, 'RESTORED');
    evidence.pids.claudeAfterRestore = pidAfter;
    Object.assign(values, { pidBefore, pidAfter, processEnded: true, resumedSameSession: true, epochChanged: true });
  });

  await step('k1', 'graceful backend restart while idle: the process survives in its session host and answers the next turn', async values => {
    const oldPid = claudePid();
    const before = kit.hostRecord(hostId());
    assert.equal(before.child.pid, oldPid);
    assert.equal(before.child.startTicks, kit.startTicksOf(oldPid));
    const epochBefore = epoch();
    await kit.shutdown();
    await sleep(2000); // long enough for a host that died with the backend to take the process down with it
    assert.ok(alive(oldPid), 'The claude process must survive the backend.');
    assert.ok(alive(before.host.pid), 'The session host must survive the backend.');
    assert.equal(kit.hostRecord(hostId()).child.startTicks, kit.startTicksOf(oldPid), 'The host record must still match /proc.');
    await kit.boot();
    const stored = row();
    assert.equal(stored.should_restore, 1, 'The binding must stay restorable after a restart.');
    assert.equal(stored.conversation_ref, nativeId);
    // The first reconcile pass (5 s after start) adopts a surviving per-session process without starting anything, before any message.
    await sleep(8000);
    values.reattachedAtBoot = epoch() !== epochBefore;
    assert.ok(values.reattachedAtBoot, 'The first reconcile pass must adopt the surviving process (a new epoch) before any message.');
    assert.equal(claudePid(), oldPid, 'The adopted process is the one that survived.');
    const screen = await api('GET', `/api/sessions/${sessionId}/screen`);
    assert.match(screen.screen.status, /idle$/, 'The adopted row reads as loaded and idle before the message.');
    values.screenBeforeMessage = screen.screen.status;
    assert.deepEqual(kit.procEntries().filter(pid => kit.parentOf(pid) === before.host.pid), [oldPid], 'Adoption must not start a second process.');
    await converse(PROMPTS.resumed, 'RESUMED');
    assert.equal(claudePid(), oldPid, 'The same claude process must answer after the restart.');
    const { after, holders } = assertSameProcess(oldPid, before);
    Object.assign(values, { oldPid, newPid: claudePid(), samePid: true, hostPid: after.host.pid, recordMatchesProc: true, liveHolders: holders.length });
  });

  await step('k2', 'graceful backend restart during a running turn: the turn is re-adopted, Stop interrupts it, a message sent meanwhile steers it and is answered after it, the next message completes on the same process, and every turn ends exactly once', async values => {
    const control = await consoleControlTexts();
    const skip = records().length;
    const eventLog = eventLogPath();
    const eventsBeforeShutdown = readEventLog(eventLog).size;

    /**
     * Starts a 25 s count, restarts the backend while it runs, and returns once the new backend has adopted the turn and the row has
     * read working for as long as the count ran. `put` records evidence values. `unattended`: the agent marks its assignment
     * unattended first, so that a recovery prompt the Console wrongly fired (it declares a running turn lost) would really be sent.
     */
    const restartDuringCount = async (tag, put, { unattended = false } = {}) => {
      const oldPid = claudePid();
      const before = kit.hostRecord(hostId());
      assert.equal(before.child.pid, oldPid);
      const counting = await send(unattended ? unattendedCountPrompt(tag, 25) : countPrompt(tag, 25));
      assert.equal(counting.record.deliveryMode, 'turn');
      const seen = {};
      const commandPids = await countingStarted(tag, seen);
      put('commandPids', seen.commandPids);
      if (unattended) {
        const marked = await wait('the agent to mark the assignment unattended', () => { const found = assignment(); const state = found && continuationOf(found.id); return state?.continuation === 'unattended' ? state : undefined; }, 60_000, 250);
        put('continuationBeforeRestart', marked.continuation);
      }
      const countSeenAt = Date.now();
      const epochBefore = epoch();
      await kit.shutdown();
      await sleep(1000);
      assert.ok(alive(oldPid), 'The claude process must survive the backend.');
      assert.ok(alive(before.host.pid), 'The session host must survive the backend.');
      assert.ok(commandPids.some(pid => alive(pid)), 'The counting command must keep running while the backend is down.');
      // The first poll is judged on what the new backend writes; the whole window (shutdown included) is checked at the end.
      const eventsFrom = readEventLog(eventLog).size;
      await kit.boot();
      const bootedAt = Date.now();
      // Before any message and before the first reconcile pass (5 s after start): the row the database holds, then the first screen
      // poll that an open web page makes. That poll must not write the loss line a turn that ended with its connection would get.
      const stored = row();
      assert.equal(stored.status, 'bound');
      assert.equal(stored.should_restore, 1, 'The binding must stay restorable after a restart.');
      assert.equal(stored.conversation_ref, nativeId);
      const samples = [];
      const httpStatuses = new Set();
      const poll = async () => {
        const response = await call('GET', `/api/sessions/${sessionId}/screen`);
        samples.push(response.body?.session?.isWorking === true);
        httpStatuses.add(response.status);
        return response;
      };
      const firstPoll = await poll();
      const lostAfterFirstPoll = lostTurnStatusLines(readEventLog(eventLog, eventsFrom).entries);
      put('firstPollHttp', firstPoll.status);
      put('firstPollScreen', firstPoll.body?.screen?.status ?? 'none');
      put('firstPollWorking', String(samples[0]));
      put('connectionEndedAfterFirstPoll', lostAfterFirstPoll.length > 0);
      assert.deepEqual(lostAfterFirstPoll, [], `The first screen poll after the restart wrote a lost-turn status line: ${lostAfterFirstPoll.join(' | ')}`);
      // Loaded (adopted) within the first reconcile pass, with no message sent.
      await wait('the surviving process to be adopted by the first reconcile pass', async () => { await poll(); return epoch() !== epochBefore; }, 12_000, 500);
      put('adoptedAfterBootMs', Date.now() - bootedAt);
      assert.equal(claudePid(), oldPid, 'The adopted process is the one that survived.');
      assert.deepEqual(kit.procEntries().filter(pid => kit.parentOf(pid) === before.host.pid), [oldPid], 'Adoption must not start a second process.');
      // The turn is still running, so the row must read as working for as long as the count runs.
      let lastPoll;
      for (let index = 0; index < 4; index += 1) { await sleep(500); lastPoll = await poll(); }
      put('screenWhileCounting', lastPoll.body?.screen?.status ?? 'none');
      put('polls', samples.length);
      const notWorking = samples.filter(working => !working).length;
      assert.equal(notWorking, 0, `isWorking read false in ${notWorking} of ${samples.length} polls (HTTP ${[...httpStatuses].join('/')}) while the count was still running.`);
      const stillCounting = pgrep(countMarker(tag));
      put('countSeenRunningForMs', Date.now() - countSeenAt);
      assert.ok(stillCounting.length > 0, `The 25 s count had already finished ${Date.now() - countSeenAt} ms after it was seen running, so the adopted turn could not be tested; rerun.`);
      return { oldPid, before, stillCounting };
    };

    // Phase 1: Stop reaches the re-adopted turn: idle within 15 s, same process, the command ends, the transcript records the interruption.
    const stopRun = await restartDuringCount('k2', (key, value) => { values[key] = value; }, { unattended: true });
    const { oldPid, before, stillCounting } = stopRun;
    const stopped = Date.now();
    await api('POST', `/api/sessions/${sessionId}/keys`, { keys: ['Escape'] });
    await wait('the session to become idle after Stop', idle, 15_000, 250);
    values.idleAfterMs = Date.now() - stopped;
    assert.equal(claudePid(), oldPid, 'The row pid must not change for an interrupt.');
    assert.ok(alive(oldPid), 'The claude process must survive an interrupt.');
    // Within 5 s: Stop ends the command's process group. The 25 s count would otherwise run out on its own inside a longer wait and pass for a Stop that worked.
    await wait('the counting command to end within 5 s of Stop', () => stillCounting.every(pid => !alive(pid)) && pgrep(countMarker('k2')).length === 0, 5_000, 100);
    values.commandGoneAfterMs = Date.now() - stopped;
    const marker = await wait('the transcript to record the interruption', () =>
      records().slice(skip).find(entry => entry.type === 'user' && /Request interrupted by user/i.test(textOf(entry) + blocksOf(entry).map(resultText).join('\n'))), 15_000, 500);
    values.interruptionMarker = textOf(marker).slice(0, 60) || 'in a tool_result';
    assert.equal((await sessionState()).isWorking, false);
    // The adopted turn ended once, as an interruption: not twice, and not also as a completion.
    await assertTurnEnds('after Stop', skip, { completed: 0, interrupted: 1 }, values, 'turnEndsAfterStop');
    // The next message gets its own reply from the same process.
    const resumedFrom = records().length;
    await converse(PROMPTS.resumed, 'RESUMED');
    await assertTurnEnds('after the resumed message', resumedFrom, { completed: 1, interrupted: 0 }, values, 'turnEndsAfterResume');
    assert.equal(claudePid(), oldPid, 'The same claude process must answer after the restart.');
    assertSameProcess(oldPid, before);

    // Phase 2: a message sent while a re-adopted turn runs is delivered to that turn as a steer (it does not start a second turn),
    // and is answered once the turn's work is done. The count is not stopped this time.
    const steerFrom = records().length;
    const steerRun = await restartDuringCount('k2s', (key, value) => { values[`steer${key[0].toUpperCase()}${key.slice(1)}`] = value; });
    const followedBefore = await countAssistant('FOLLOWED');
    const followUp = await send(PROMPTS.followUp);
    values.followUpDelivery = followUp.record.deliveryMode;
    assert.equal(followUp.record.deliveryMode, 'steer', 'A message sent while the adopted turn runs must be delivered as a steer.');
    assert.equal(followUp.record.state, 'submitted');
    assert.ok(pgrep(countMarker('k2s')).length > 0, 'The count must still be running when the message is sent.');
    // "Not answered yet" proves nothing right after the send. Watch the count run for 2 s with the steer in, then look for a reply; the count must
    // still be running when the look is over, or a reply would be allowed.
    await wait('the count to be seen running 2 s after the steer was accepted', () => {
      if (pgrep(countMarker('k2s')).length === 0) throw new Error(`The count ended ${Date.now() - followUp.sentAt} ms after the steer was accepted, before the 2 s the check needs; rerun.`);
      return Date.now() - followUp.sentAt >= 2000;
    }, 15_000, 250);
    const repliesWhileCounting = await countAssistant('FOLLOWED');
    assert.ok(pgrep(countMarker('k2s')).length > 0, 'The count ended while the unanswered check ran, so the check proves nothing; rerun.');
    values.followUpUnansweredForMs = Date.now() - followUp.sentAt;
    assert.equal(repliesWhileCounting, followedBefore, 'The steered message must not be answered while the count still runs.');
    await wait('the counting command to finish by itself', () => pgrep(countMarker('k2s')).length === 0, 60_000, 250);
    await waitForReply('FOLLOWED', followedBefore);
    values.followUpAnswered = 'after the count';
    // The steer joined the adopted turn: that turn ended once, and the steer started no turn of its own.
    await assertTurnEnds('after the steered turn', steerFrom, { completed: 1, interrupted: 0 }, values, 'turnEndsAfterSteeredTurn');
    assert.equal(claudePid(), steerRun.oldPid, 'The same claude process must answer the steered message.');
    const { after, holders } = assertSameProcess(steerRun.oldPid, steerRun.before);

    // Nothing the Console sends on its own (recovery, wake) reached the conversation, and no loss line was written at any point.
    const events = readEventLog(eventLog, eventsBeforeShutdown).entries;
    assert.deepEqual(lostTurnStatusLines(events), [], 'No lost-turn status line may be written for a turn that survived the restart.');
    const injected = findControlText(events, control) ?? findControlText(records().slice(skip).filter(entry => entry.type === 'user'), control);
    assert.equal(injected, undefined, `The Console sent control text into the conversation: ${injected}`);
    Object.assign(values, { oldPid, newPid: claudePid(), samePid: true, hostPid: after.host.pid, liveHolders: holders.length, recoveryOrWakeText: 'none' });
  });

  await step('l', 'screenshot-sized image: a 2560x1440 PNG above 5 MB completes without an image error, and the reply names its dominant colour', async values => {
    const skip = records().length;
    const eventsFrom = readEventLog(eventLogPath()).size;
    const failureBefore = row().run_failure_json;
    const before = await countAssistant('red');
    const png = noisyPng(2560, 1440, [225, 25, 25]);
    values.fileBytes = png.length;
    const upload = await kit.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/images`, payload: png, headers: { ...kit.headers, 'content-type': 'image/png' } });
    assert.equal(upload.statusCode, 201, `image upload: HTTP ${upload.statusCode}`);
    const image = upload.json().image;
    const sent = await send(PROMPTS.bigImage, { imageIds: [image.id] });
    assert.equal(sent.record.state, 'submitted');
    // A turn that ends in an image error leaves a run failure on the row, an API error record in the transcript, or a status line.
    const failure = () => {
      const stored = row().run_failure_json;
      const apiErrors = records().slice(skip).filter(entry => entry.type === 'assistant' && (entry.isApiErrorMessage || entry.error)).map(entry => textOf(entry).slice(0, 160));
      const lines = readEventLog(eventLogPath(), eventsFrom).entries.filter(entry => entry.type === 'status' && /image/i.test(String(entry.text ?? ''))).map(entry => String(entry.text).slice(0, 160));
      return [stored && stored !== failureBefore ? stored.slice(0, 200) : undefined, ...apiErrors, ...lines].filter(Boolean);
    };
    await wait('a completed turn whose reply names the colour', async () => {
      const failed = failure();
      if (failed.length) throw new Error(`The image turn failed (image_error?): ${failed.join(' | ')}`);
      return (await idle()) && (await countAssistant('red')) > before;
    }, TURN_TIMEOUT_MS, 500);
    const prompt = records().slice(skip).find(entry => entry.type === 'user' && textOf(entry).includes('dominant color of the attached image'));
    assert.ok(prompt, 'The transcript has no user row for the image prompt.');
    const imageBlocks = blocksOf(prompt).filter(block => block.type === 'image');
    assert.equal(imageBlocks.length, 1, 'The user row must carry the image as a content block.');
    Object.assign(values, {
      imageId: image.id, mediaType: image.mediaType, width: image.width, height: image.height, storedBytes: image.sizeBytes,
      blockBytes: imageBlocks[0].source?.data ? Math.floor(imageBlocks[0].source.data.length * 3 / 4) : 'unknown', sourceType: imageBlocks[0].source?.type ?? 'unknown', readToolCalls: toolUsesSince(skip, 'Read').length,
    });
  });

  await step('m', 'release ends the session and the process; no process of this proof remains', async values => {
    const pid = claudePid();
    const record = kit.hostRecord(hostId());
    await api('POST', `/api/sessions/${sessionId}/release`);
    const stored = row();
    assert.equal(stored.status, 'ended');
    assert.equal(stored.should_restore, 0);
    values.status = stored.status;
    await wait('the claude process to exit', () => !alive(pid), 15_000, 100);
    await wait('the session host to exit', () => !alive(record.host.pid) && !fs.existsSync(kit.hostRecordPath(hostId())), 20_000, 100);
    await kit.wait('every process of this proof to exit', () => kit.listProcesses().length === 0, 20_000, 250);
    assert.notEqual(kit.tmux('ls').status, 0, 'No tmux server may have been started during the whole run.');
    values.tmuxServer = 'none';
    values.processesAfterRelease = 0;
    values.coordMcpAfterRelease = kit.coordMcpProcesses().length;
    values.claudeProcessesAfterRelease = pgrep('claude --output-format').filter(candidate => kit.environOf(candidate).includes(`AGENT_COORD_RUNTIME=${kit.runtimeDir}`)).length;
    assert.equal(values.coordMcpAfterRelease + values.claudeProcessesAfterRelease, 0);
    await kit.shutdown();
    assert.equal(kit.listProcesses().length, 0);
    values.processesAfterShutdown = 0;
  });
} finally {
  await kit.finish({
    hostIds: sessionId ? [hostId()] : [],
    releaseAll: async () => {
      if (sessionId && kit.db && row()?.should_restore) await call('POST', `/api/sessions/${sessionId}/release`);
    },
    afterCleanup: async note => {
      const failed = evidence.steps.some(entry => !entry.pass);
      if (failed) {
        evidence.transcriptKept = transcriptDirs.filter(dir => fs.existsSync(dir)).map(tilde);
        note('transcripts', true, `kept for diagnosis: ${evidence.transcriptKept.join(', ')}`);
        return;
      }
      const base = path.join(claudeConfigDir, 'projects');
      for (const dir of transcriptDirs) {
        // Only the directory of this proof's random temp root, never a shared one.
        if (path.dirname(dir) === base && dir.includes(path.basename(kit.root).replace(/[^A-Za-z0-9]/g, '-'))) fs.rmSync(dir, { recursive: true, force: true });
      }
      // The CLI also makes an (empty) per-session directory for the hook and shell environment; it is named by this proof's own session id.
      for (const area of ['session-env', 'file-history']) if (nativeId) fs.rmSync(path.join(claudeConfigDir, area, nativeId), { recursive: true, force: true });
      note('transcripts', transcriptDirs.every(dir => !fs.existsSync(dir)), 'removed with the proof');
    },
  });
}
// The backend is closed; end the process even if a library timer is still pending.
process.exit(process.exitCode ?? 1);
