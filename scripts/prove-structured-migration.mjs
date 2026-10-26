#!/usr/bin/env node
// Opt-in real-provider proof of the tmux-to-structured migration (docs/structured-cutover.md, "Migration of live tmux bindings").
//
// Starts an isolated Console backend with the installed tmux provider commands (as `prove-granted-launches.mjs` builds them),
// both structured lanes enabled and `defaultTransport: 'tmux'`, and creates one real tmux Codex chat and one real tmux Claude
// chat through the normal bind routes. Each answers "TMUX". The config is then rewritten to `defaultTransport: 'structured'`
// (the flip procedure's config edit), the backend is closed and rebuilt, and the proof watches `reconcileSessions` (first pass 5 s
// after start) move both rows: transport structured, asleep, the tmux sessions gone, no provider process of the tmux phase left.
// Each conversation then answers "MIGRATED" on the structured path, in the same native conversation. Real turns run with the host's
// Codex and Claude logins; every prompt is one short fixed sentence and message bodies are never printed or recorded.
//
// Usage (build first):  env -u NODE_ENV npm run build
//                       env -u NODE_ENV node scripts/prove-structured-migration.mjs --run > /tmp/proof-migration-backend.log
// Step results go to stderr (one `PROOF` line each). Evidence JSON is written after every step to
// test-results/structured-migration-proof/<timestamp>.json. The Claude transcript the CLI writes under
// ~/.claude/projects/<escaped scratch cwd>/ is removed after a passing run; Codex rollouts stay under ~/.codex/sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (!process.argv.includes('--run')) {
  process.stderr.write('Use --run to opt into a real tmux-to-structured migration proof (one Codex and one Claude chat, four short turns). Run `npm run build` first.\n');
  process.exit(2);
}

const { createProofKit } = await import('./structured-proof-kit.mjs');

const PROMPTS = { tmux: 'Reply with the single word TMUX.', migrated: 'Reply with the single word MIGRATED.' };
const TURN_TIMEOUT_MS = Number(process.env.PROOF_TURN_TIMEOUT_MS) || 240_000;
const version = (command) => { try { return execFileSync(command, ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
const kit = await createProofKit({
  script: 'scripts/prove-structured-migration.mjs', rootPrefix: 'console-structured-migration-proof', evidenceSubdir: 'structured-migration-proof',
  expectedSteps: 8, extraEvidence: { codexVersion: version('codex'), claudeVersion: version('claude'), rows: {} },
});
const { evidence, say, finding, call, api, wait, alive, step } = kit;
say(`${evidence.codexVersion}; ${evidence.claudeVersion}`);

// ---- configuration: the installed tmux provider commands, pinned to this proof's runtime ------------------------------
const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-console/config.json'), 'utf8'));
const helper = path.join(kit.repoRoot, 'scripts/agent-coord.mjs');
const writeConfig = defaultTransport => kit.writeConfig(config => {
  for (const provider of ['codex', 'claude']) {
    config.providers[provider] = structuredClone(installed.providers[provider]);
    config.providers[provider].commands.env = {
      ...config.providers[provider].commands.env,
      AGENT_CONSOLE_CONFIG: kit.configPath, AGENT_COORD_RUNTIME: kit.runtimeDir, AGENT_CONSOLE_TMUX_SOCKET: kit.tmuxSocket,
    };
  }
  for (const key of ['newCommand', 'resumeCommand', 'continueCommand']) {
    // The global ~/.codex MCP entry and the user-scope Claude MCP entry name the live runtime: pin this proof's processes to its own.
    config.providers.codex.commands[key].push('--dangerously-bypass-hook-trust', '-c',
      `mcp_servers.agent_console_coordination.env.AGENT_COORD_RUNTIME=${JSON.stringify(kit.runtimeDir)}`, '-c',
      `mcp_servers.agent_console_coordination.args=${JSON.stringify([helper, 'mcp'])}`);
    config.providers.claude.commands[key].push('--strict-mcp-config');
  }
  config.structuredSessions = {
    defaultTransport,
    codex: { enabled: true, command: ['codex', 'app-server'], idleUnloadMinutes: 60, env: {} },
    claude: { enabled: true, command: ['claude'], idleUnloadMinutes: 60, env: {} },
  };
});
writeConfig('tmux');

const PROVIDERS = ['codex', 'claude'];
/** Per provider: the Console session id, the native conversation, the pids of the tmux phase. */
const chats = Object.fromEntries(PROVIDERS.map(provider => [provider, { provider, sessionId: undefined, pendingRef: undefined, nativeId: undefined, tmuxName: undefined, tmuxPids: [], transcript: undefined }]));
const row = chat => kit.db.prepare('select * from bound_sessions where id = ?').get(chat.sessionId);
const indexRow = chat => kit.db.prepare('select transcript_path from conversation_index where project_slug = ? and provider = ? and ref = ?').get('demo', chat.provider, chat.nativeId);
const refOf = chat => row(chat)?.conversation_ref ?? chat.pendingRef;
const timeline = async chat => (await call('GET', `/api/conversations/demo/${chat.provider}/${encodeURIComponent(refOf(chat))}/messages?limit=200`)).body?.messages ?? [];
const countAssistant = async (chat, marker) => {
  const pattern = new RegExp(`\\b${marker}\\b`, 'i');
  return (await timeline(chat)).filter(message => message.role === 'assistant' && pattern.test(message.text)).length;
};
const sessionState = async chat => (await call('GET', `/api/sessions/${chat.sessionId}/screen`)).body;
const nativeChats = () => PROVIDERS.map(provider => chats[provider]);
/** Codex asks to trust a new folder before it shows a prompt; the tmux phase answers it the way a person would. */
const answerTrustPrompts = () => {
  const names = kit.tmux('list-sessions', '-F', '#{session_name}').stdout.split('\n').filter(Boolean);
  for (const name of names) {
    const screen = kit.tmux('capture-pane', '-p', '-S', '-60', '-t', name).stdout;
    if (screen.includes('1. Trust and continue') && screen.includes(kit.project)) kit.tmux('send-keys', '-t', name, 'Enter');
  }
};

try {
  await kit.boot();

  await step('a', 'tmux phase: a Codex chat and a Claude chat bind on tmux through the normal routes', async values => {
    const tree = await api('GET', '/api/projects/tree');
    assert.deepEqual([...tree.structuredProviders].sort(), ['claude', 'codex'], 'Both lanes are enabled while the default is tmux.');
    for (const chat of nativeChats()) {
      const bound = await api('POST', `/api/conversations/demo/${chat.provider}/new/bind`, { transport: 'tmux' });
      chat.sessionId = bound.session.id;
      chat.pendingRef = bound.conversationRef;
      chat.tmuxName = bound.session.tmuxSessionName;
      assert.equal(bound.session.transport, 'tmux');
      assert.ok(!chat.tmuxName.startsWith('structured:'));
      assert.equal(kit.tmux('has-session', '-t', chat.tmuxName).status, 0, `${chat.provider}: the tmux session must exist on the private socket.`);
      evidence.rows[chat.provider] = { sessionId: chat.sessionId, tmuxName: chat.tmuxName };
      values[`${chat.provider}Session`] = chat.sessionId;
      values[`${chat.provider}Tmux`] = chat.tmuxName;
    }
  }, { fatal: true });

  await step('b', 'tmux phase: each chat answers TMUX, is bound to a native conversation and is indexed', async values => {
    for (const chat of nativeChats()) {
      // The TUI must be showing a prompt before text is typed into it.
      await wait(`${chat.provider} TUI to be ready`, async () => {
        answerTrustPrompts();
        const state = await sessionState(chat);
        return state?.screen?.inputActive && !state.session.isWorking;
      }, 90_000, 1000);
      if (chat.provider === 'codex' && process.env.PROOF_CODEX_PROFILE) {
        // The default (medium) Codex model is rate limited on this host at times: Codex then waits out a backoff of minutes and
        // the turn only looks hung. The profile is recorded on the row; the first message of a pending Codex chat then relaunches
        // Codex with it and the prompt (the /input route's first-turn restart, as in the web client). The row keeps the profile
        // across the move, so the structured turns use it too.
        const switched = await call('POST', `/api/sessions/${chat.sessionId}/model-profile`, { profile: process.env.PROOF_CODEX_PROFILE });
        assert.ok(switched.status < 300, `model-profile: HTTP ${switched.status} ${switched.body?.error ?? ''}`);
        await wait('the low profile to be recorded', () => !row(chat).model_profile_request_json && row(chat).codex_profile === process.env.PROOF_CODEX_PROFILE, 30_000, 250);
        values.codexProfile = process.env.PROOF_CODEX_PROFILE;
      }
      const before = await countAssistant(chat, 'TMUX');
      const sent = await api('POST', `/api/sessions/${chat.sessionId}/input`, { text: PROMPTS.tmux });
      // The first message of a pending Codex chat relaunches Codex with it as the initial prompt and binds a new Console session.
      if (sent.session?.id && sent.session.id !== chat.sessionId) {
        values[`${chat.provider}FirstTurnRebind`] = `${chat.sessionId} -> ${sent.session.id}`;
        chat.sessionId = sent.session.id;
        evidence.rows[chat.provider].sessionId = chat.sessionId;
      }
      let observed = {};
      await wait(`${chat.provider} reply TMUX, a native conversation id and an indexed transcript`, async () => {
        answerTrustPrompts();
        const stored = row(chat);
        const screenTail = () => kit.tmux('capture-pane', '-p', '-t', stored.tmux_session_name).stdout.split('\n').filter(line => line.trim()).slice(-4).join(' / ').slice(0, 300);
        const registered = kit.db.prepare("select a.provider, a.status, substr(a.native_session_id, 1, 8) as native from coordination_assignments a").all();
        const bindings = kit.db.prepare("select count(*) as n from meta where key like 'console-session:%'").get().n;
        observed = { ref: stored.conversation_ref.slice(0, 8), registered, consoleSessionMeta: bindings, tmux: stored.tmux_session_name, profile: stored.codex_profile ?? stored.claude_profile, working: stored.is_working, screen: screenTail() };
        if (!stored || stored.conversation_ref.startsWith('pending:')) { await timeline(chat); return false; }
        chat.nativeId = stored.conversation_ref;
        const indexed = indexRow(chat);
        if (!indexed?.transcript_path) { await timeline(chat); return false; }
        chat.transcript = indexed.transcript_path;
        const state = await sessionState(chat);
        return state?.session.isWorking !== true && (await countAssistant(chat, 'TMUX')) > before;
      }, TURN_TIMEOUT_MS, 1500).catch(error => { throw new Error(`${error.message} (last seen ${JSON.stringify(observed)})`); });
      const stored = row(chat);
      assert.equal(stored.transport, 'tmux');
      assert.equal(stored.status, 'bound');
      assert.ok(stored.pid > 0 && alive(stored.pid), `${chat.provider}: the tmux pane process must be alive.`);
      assert.ok(fs.existsSync(chat.transcript), `${chat.provider}: the transcript file must exist.`);
      chat.tmuxName = stored.tmux_session_name; // a first-message restart may have replaced the session
      assert.equal(kit.tmux('has-session', '-t', chat.tmuxName).status, 0, `${chat.provider}: the tmux session must be live.`);
      chat.panePid = stored.pid;
      chat.tmuxPids = kit.withEnv(`AGENT_CONSOLE_SESSION_ID=${chat.sessionId}`);
      assert.ok(chat.tmuxPids.length > 0, `${chat.provider}: the tmux phase must have processes carrying the session id.`);
      Object.assign(evidence.rows[chat.provider], { nativeId: chat.nativeId, panePid: chat.panePid, tmuxPhaseProcesses: chat.tmuxPids.length, transcript: chat.transcript.replace(os.homedir(), '~') });
      values[`${chat.provider}Native`] = chat.nativeId;
      values[`${chat.provider}PanePid`] = chat.panePid;
      values[`${chat.provider}Processes`] = chat.tmuxPids.length;
    }
  }, { fatal: true });

  let before;
  await step('c', 'flip: config edited to defaultTransport structured, backend restarted; the dry run lists both rows as idle', async values => {
    // The tmux sessions belong to the private tmux server, so they outlive the backend (as on the live service).
    await kit.shutdown();
    for (const chat of nativeChats()) assert.equal(kit.tmux('has-session', '-t', chat.tmuxName).status, 0, `${chat.provider}: the tmux session must survive the backend.`);
    writeConfig('structured');
    const bootedAt = Date.now();
    await kit.boot();
    before = (await api('GET', '/api/sessions/structured-migration'));
    values.secondsAfterBoot = Math.round((Date.now() - bootedAt) / 100) / 10;
    assert.equal(before.defaultTransport, 'structured');
    assert.deepEqual([...before.providers].sort(), ['claude', 'codex']);
    Object.assign(values, { providers: before.providers.join(','), structuredRows: before.structuredRows, idle: before.outcomes.idle, dead: before.outcomes.dead, working: before.outcomes.working, noTranscript: before.outcomes.noTranscript });
    // The first reconcile pass runs 5 s after start; a dry run taken in time reports the rows as still to move.
    if (before.structuredRows === 0) assert.equal(before.outcomes.idle + before.outcomes.dead, 2, 'Both rows must be movable (idle or dead).');
    else finding('dry-run-late', 'The first reconcile pass moved rows before the dry run could be read.');
    evidence.migrationReportBefore = before;
  }, { fatal: true });

  await step('d', 'reconcile moves both rows: transport structured, asleep, sentinel name, identity unchanged', async values => {
    const after = await wait('the report to show both rows moved', async () => {
      const report = await api('GET', '/api/sessions/structured-migration');
      return report.structuredRows === 2 && report.outcomes.idle + report.outcomes.dead === 0 ? report : undefined;
    }, 120_000, 1000);
    evidence.migrationReportAfter = after;
    for (const chat of nativeChats()) {
      const stored = row(chat);
      assert.equal(stored.transport, 'structured', `${chat.provider}: transport`);
      assert.ok(stored.idle_suspended_at, `${chat.provider}: idle_suspended_at must be set (the row is asleep).`);
      assert.equal(stored.tmux_session_name, `structured:${chat.sessionId}`, `${chat.provider}: sentinel tmux name`);
      assert.equal(stored.pid, null, `${chat.provider}: pid is cleared`);
      assert.equal(stored.raw_log_path, null, `${chat.provider}: raw log is cleared`);
      assert.equal(stored.conversation_ref, chat.nativeId, `${chat.provider}: the native conversation does not change`);
      assert.equal(stored.should_restore, 1);
      assert.equal(stored.status, 'bound');
      values[`${chat.provider}IdleSuspendedAt`] = stored.idle_suspended_at;
    }
    values.outcomesAfter = JSON.stringify(Object.fromEntries(Object.entries(after.outcomes).filter(([, count]) => count > 0)));
    values.structuredRows = after.structuredRows;
  });

  await step('e', 'the tmux sessions are gone and no provider process of the tmux phase survives', async values => {
    for (const chat of nativeChats()) {
      assert.notEqual(kit.tmux('has-session', '-t', chat.tmuxName).status, 0, `${chat.provider}: the tmux session must be gone.`);
      await wait(`${chat.provider} tmux-phase processes to exit`, () => chat.tmuxPids.every(pid => !alive(pid)), 20_000, 250);
      assert.ok(!alive(chat.panePid));
      values[`${chat.provider}TmuxPhaseProcessesAlive`] = chat.tmuxPids.filter(pid => alive(pid)).length;
    }
    assert.notEqual(kit.tmux('list-sessions').status, 0, 'The private tmux server must have no session left.');
    await wait('every process carrying this proof\'s runtime to exit', () => kit.listProcesses().length === 0, 20_000, 250);
    values.processesWithProofRuntime = 0;
    values.tmuxSessions = 0;
  });

  const structuredTurn = async (chat, values) => {
    const pending = row(chat);
    assert.ok(pending.idle_suspended_at, 'the row starts asleep');
    const before = await countAssistant(chat, 'MIGRATED');
    const submissionId = randomUUID();
    await api('POST', `/api/sessions/${chat.sessionId}/keys`, { submissionId, submittedText: PROMPTS.migrated, text: PROMPTS.migrated, keys: ['Enter'] });
    await wait(`${chat.provider} reply MIGRATED`, async () => {
      const state = await call('GET', `/api/sessions/${chat.sessionId}/screen`);
      return state.status === 200 && state.body.session.isWorking !== true && (await countAssistant(chat, 'MIGRATED')) > before;
    }, TURN_TIMEOUT_MS, 1000);
    const stored = row(chat);
    assert.equal(stored.transport, 'structured');
    assert.equal(stored.conversation_ref, chat.nativeId, 'The same native conversation answers.');
    assert.equal(stored.idle_suspended_at, null, 'The message must wake the row.');
    assert.ok(stored.pid > 0 && alive(stored.pid), 'The structured provider process must be running.');
    const state = (await sessionState(chat)).session;
    assert.ok(state.lastResponseAt, 'lastResponseAt must be set by the structured turn.');
    // The earlier tmux reply is still in the same conversation: the history continues, it did not restart.
    assert.ok((await countAssistant(chat, 'TMUX')) >= 1, 'The conversation must still hold the reply from the tmux phase.');
    assert.equal(indexRow(chat)?.transcript_path, chat.transcript, 'The index must still point at the same transcript.');
    assert.equal(kit.tmux('list-sessions').status === 0 ? kit.tmux('list-sessions').stdout.trim() : '', '', 'Nothing may start a tmux session.');
    Object.assign(values, { pid: stored.pid, nativeId: stored.conversation_ref, lastResponseAt: state.lastResponseAt, historyKept: true });
    return stored;
  };

  await step('f', 'Codex answers MIGRATED on the structured path in the same thread', async values => {
    const chat = chats.codex;
    const stored = await structuredTurn(chat, values);
    const record = kit.hostRecord('codex');
    assert.equal(record.child.pid, stored.pid, 'The row pid is the app-server held by the session host.');
    values.hostPid = record.host.pid;
    values.appServerPid = stored.pid;
    evidence.rows.codex.structuredPid = stored.pid;
  });

  await step('g', 'Claude answers MIGRATED on the structured path in the same session (resumed by id)', async values => {
    const chat = chats.claude;
    const stored = await structuredTurn(chat, values);
    const argv = kit.cmdlineOf(stored.pid);
    assert.ok(argv.includes('--resume') && argv[argv.indexOf('--resume') + 1] === chat.nativeId, 'The process must resume the same session id.');
    assert.equal(kit.envValue(stored.pid, 'AGENT_CONSOLE_SESSION_ID'), chat.sessionId);
    assert.equal(kit.hostRecord(`claude-${chat.sessionId}`).child.pid, stored.pid);
    values.claudeFlags = argv.filter(arg => ['--model', '--effort'].includes(arg)).join(',') || 'none';
    values.model = argv[argv.indexOf('--model') + 1] ?? 'default';
    evidence.rows.claude.structuredPid = stored.pid;
    if (!argv.includes('--model')) finding('migrated-claude-no-profile', 'A migrated Claude row resumed with no --model: it takes the CLI default.');
  });

  await step('h', 'release ends both structured conversations; no process of this proof remains', async values => {
    for (const chat of nativeChats()) {
      await api('POST', `/api/sessions/${chat.sessionId}/release`);
      const stored = row(chat);
      assert.equal(stored.status, 'ended');
      assert.equal(stored.should_restore, 0);
    }
    // The shared Codex app-server outlives its last thread by design; the host is ended explicitly, as in the Codex proof.
    await kit.shutdown();
    const { terminateHost } = await import(new URL('../apps/server/dist/providers/transport/line-transport.js', import.meta.url));
    await terminateHost(kit.runtimeDir, 'codex', { info: () => undefined, warn: () => undefined });
    await wait('every process of this proof to exit', () => kit.listProcesses().length === 0, 30_000, 250);
    assert.ok(!fs.existsSync(kit.hostRecordPath('codex')));
    assert.ok(!fs.existsSync(kit.hostRecordPath(`claude-${chats.claude.sessionId}`)), 'The Claude session host ended with the release.');
    assert.notEqual(kit.tmux('list-sessions').status, 0);
    values.processesAfterShutdown = 0;
    values.coordMcpAfterShutdown = kit.coordMcpProcesses().length;
  });
} finally {
  await kit.finish({
    hostIds: ['codex', ...(chats.claude.sessionId ? [`claude-${chats.claude.sessionId}`] : [])],
    releaseAll: async () => {
      for (const chat of nativeChats()) {
        if (chat.sessionId && kit.db && row(chat)?.should_restore) await call('POST', `/api/sessions/${chat.sessionId}/release`);
      }
    },
    afterCleanup: async note => {
      // The Claude transcript the CLI wrote for the scratch project: removed only after a passing run, and only this proof's directory.
      const claudeBase = path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'), 'projects');
      const dirs = [...new Set([kit.project, fs.existsSync(kit.project) ? fs.realpathSync(kit.project) : kit.project].map(cwd => path.join(claudeBase, cwd.replace(/[^A-Za-z0-9]/g, '-'))))];
      if (evidence.steps.some(entry => !entry.pass)) { note('transcripts', true, `kept for diagnosis: ${dirs.filter(dir => fs.existsSync(dir)).map(dir => dir.replace(os.homedir(), '~')).join(', ')}`); return; }
      for (const dir of dirs) if (path.dirname(dir) === claudeBase) fs.rmSync(dir, { recursive: true, force: true });
      if (chats.claude.nativeId) for (const area of ['session-env', 'file-history']) fs.rmSync(path.join(path.dirname(claudeBase), area, chats.claude.nativeId), { recursive: true, force: true });
      note('transcripts', dirs.every(dir => !fs.existsSync(dir)), 'removed with the proof');
    },
  });
}
process.exit(process.exitCode ?? 1);
