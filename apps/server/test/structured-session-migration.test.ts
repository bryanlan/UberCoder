import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import type { BoundSession } from '@agent-console/shared';
import { CoordinationService } from '../src/coordination/service.js';
import { InputQueue } from '../src/sessions/input-queue.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';
import { claudeProvider, project, provider, providerSettings } from './helpers/session-fixtures.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const IDLE_CODEX_SCREEN = 'OpenAI Codex\nCompleted response.\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 90% left · ~/demo';
const CODEX_DRAFT_SCREEN = 'OpenAI Codex\nCompleted response.\n› half-typed message\ngpt-6.1-sol xhigh · 90% left · ~/demo';

const open: StructuredSessionFixture[] = [];
/** A structured-default Console with both lanes on, holding tmux conversations that were bound before the flip. */
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture({
    extraPlugins: [{ id: 'claude', capabilities: { processModel: 'per-session', nativeIds: 'client-allocated' } }],
    ...options,
    manager: { defaultTransport: 'structured', ...options.manager },
  });
  open.push(f);
  f.tmux.paneText = IDLE_CODEX_SCREEN;
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

/** A conversation bound the old way, on tmux, as the live Console holds them. */
async function bindTmux(f: StructuredSessionFixture, conversationRef: string, extra: { claude?: boolean; pending?: boolean } = {}): Promise<BoundSession> {
  return f.manager.bindConversation({
    project,
    provider: extra.claude ? claudeProvider : provider,
    providerSettings,
    conversationRef,
    title: `Conversation ${conversationRef}`,
    kind: extra.pending ? 'pending' : 'history',
    transport: 'tmux',
  });
}

/** The tmux calls that change or read a pane; the liveness check (has-session) is the only call a dead row may cost. */
function spyTmux(f: StructuredSessionFixture) {
  return {
    kill: vi.spyOn(f.tmux, 'killSession'),
    capture: vi.spyOn(f.tmux, 'capturePane'),
    keys: vi.spyOn(f.tmux, 'sendKeys'),
    interrupt: vi.spyOn(f.tmux, 'interrupt'),
    options: vi.spyOn(f.tmux, 'getOption'),
    create: vi.spyOn(f.tmux, 'newDetachedSession'),
  };
}

function makeIdleFor(f: StructuredSessionFixture, sessionId: string, minutes = 120) {
  const at = new Date(Date.now() - minutes * 60_000).toISOString();
  f.db.sqlite.prepare(`update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, is_working=0 where id=?`)
    .run(at, at, at, at, at, at, sessionId);
}

describe('Moving tmux conversations to the structured transport', () => {
  it('stops an idle live tmux session the way idle sleep does, then flips the row to a sleeping structured row', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-idle');
    const before = f.row(bound.id);
    expect(before).toMatchObject({ transport: 'tmux', status: 'bound' });
    expect(f.tmux.alive.has(before.tmuxSessionName)).toBe(true);
    const lastActivity = before.lastActivityAt;

    await f.manager.reconcileSessions();

    const after = f.row(bound.id);
    expect(f.tmux.alive.has(before.tmuxSessionName)).toBe(false);
    expect(after).toMatchObject({
      id: bound.id, transport: 'structured', status: 'bound', shouldRestore: true,
      tmuxSessionName: `structured:${bound.id}`, conversationRef: 'native-idle', resumeConversationRef: 'native-idle',
      rawLogPath: undefined, pid: undefined, isWorking: false, lastActivityAt: lastActivity,
    });
    expect(after.idleSuspendedAt).toBeTruthy();
    expect(eventLogLines(after).map(line => line.text)).toContain('Moved to the structured transport; the next message resumes this conversation.');
    expect(f.events.some(event => event.type === 'session.updated' && event.session.id === bound.id && event.session.transport === 'structured')).toBe(true);
    // Nothing was loaded: the conversation waits for its next message.
    expect(f.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'start' || call.method === 'resume')).toHaveLength(0);
  });

  it('converts a row whose tmux session already ended without a kill, a screen read or any pane call', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-dead');
    f.tmux.alive.delete(f.row(bound.id).tmuxSessionName);
    const spies = spyTmux(f);

    await f.manager.reconcileSessions();

    expect(f.row(bound.id)).toMatchObject({ transport: 'structured', tmuxSessionName: `structured:${bound.id}`, pid: undefined, rawLogPath: undefined });
    expect(f.row(bound.id).idleSuspendedAt).toBeTruthy();
    expect(spies.kill).not.toHaveBeenCalled();
    expect(spies.capture).not.toHaveBeenCalled();
    expect(spies.keys).not.toHaveBeenCalled();
    expect(spies.interrupt).not.toHaveBeenCalled();
    expect(spies.options).not.toHaveBeenCalled();
    expect(spies.create).not.toHaveBeenCalled();
  });

  it('leaves a working row on tmux untouched, then converts it on a later pass once it is idle', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-working');
    f.db.sqlite.prepare('update bound_sessions set is_working=1 where id=?').run(bound.id);
    const spies = spyTmux(f);

    await f.manager.reconcileSessions();
    expect(f.row(bound.id)).toMatchObject({ transport: 'tmux', isWorking: true });
    expect(f.tmux.alive.has(f.row(bound.id).tmuxSessionName)).toBe(true);
    expect(spies.kill).not.toHaveBeenCalled();

    f.db.sqlite.prepare('update bound_sessions set is_working=0 where id=?').run(bound.id);
    await f.manager.reconcileSessions();
    expect(f.row(bound.id)).toMatchObject({ transport: 'structured', pid: undefined });
    expect(spies.kill).toHaveBeenCalledTimes(1);
  });

  it('leaves a row with a queued message on tmux', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-queued');
    new InputQueue(f.db.sqlite).put(bound.id, { requestId: randomUUID(), state: 'queued', text: 'later', requestedAt: new Date().toISOString(), reason: 'Waiting for the composer.' });
    expect(f.row(bound.id).queuedInputs).toHaveLength(1);
    const spies = spyTmux(f);
    await f.manager.reconcileSessions();
    expect(f.row(bound.id).transport).toBe('tmux');
    expect(spies.kill).not.toHaveBeenCalled();
    expect((await f.manager.structuredMigrationReport()).rows.find(row => row.id === bound.id)?.outcome).toBe('queuedInput');
  });

  it('leaves a row with a model change in flight on tmux', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-model');
    f.db.boundSessions.replaceModelProfileRequest(bound.id, { requestId: randomUUID(), profile: 'low', requestedAt: new Date().toISOString(), state: 'queued' }, new Date().toISOString());
    const spies = spyTmux(f);
    // The reconcile pass applies a queued model change on its own; the move waits for the switch to finish.
    const outcome = (await f.manager.structuredMigrationReport()).rows.find(row => row.id === bound.id)?.outcome;
    expect(outcome).toBe('modelRequest');
    expect(spies.kill).not.toHaveBeenCalled();
    expect(f.row(bound.id).transport).toBe('tmux');
  });

  it('leaves a conversation that has no native id yet', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'pending:abc', { pending: true });
    const spies = spyTmux(f);
    await f.manager.reconcileSessions();
    expect(f.row(bound.id)).toMatchObject({ transport: 'tmux', conversationRef: 'pending:abc' });
    expect(spies.kill).not.toHaveBeenCalled();
    expect(f.tmux.alive.has(f.row(bound.id).tmuxSessionName)).toBe(true);
  });

  it('leaves a live session with an unsent draft alone: the idle guard refuses it', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-draft');
    f.tmux.paneText = CODEX_DRAFT_SCREEN;
    const spies = spyTmux(f);
    await f.manager.reconcileSessions();
    expect(f.row(bound.id).transport).toBe('tmux');
    expect(spies.kill).not.toHaveBeenCalled();
    expect(f.tmux.alive.has(f.row(bound.id).tmuxSessionName)).toBe(true);
  });

  it('does not flip the row when the tmux session survives the kill: there is never a second writer', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-stubborn');
    f.tmux.failKill = true;
    await f.manager.reconcileSessions();
    expect(f.row(bound.id)).toMatchObject({ transport: 'tmux', tmuxSessionName: expect.not.stringContaining('structured:') });
    expect(f.tmux.alive.has(f.row(bound.id).tmuxSessionName)).toBe(true);
    expect(f.row(bound.id).idleSuspendedAt).toBeUndefined();

    f.tmux.failKill = false;
    await f.manager.reconcileSessions();
    expect(f.row(bound.id).transport).toBe('structured');
  });

  it('does not flip a row whose tmux session is gone while the provider process still runs outside the binding', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-outside');
    f.tmux.alive.delete(f.row(bound.id).tmuxSessionName);
    // A coordination assignment whose process is alive and is not this binding's tmux session.
    new CoordinationService(f.db, { enabled: true, pilotPaths: [] })
      .register({ provider: 'codex', nativeSessionId: 'native-outside', token: randomUUID(), pid: process.pid, cwd: f.root });
    expect((await f.manager.structuredMigrationReport()).rows.find(row => row.id === bound.id)?.outcome).toBe('externalOwner');
    await f.manager.reconcileSessions();
    expect(f.row(bound.id).transport).toBe('tmux');
  });

  it('leaves a Claude conversation whose transcript file is missing, and converts it once the file exists', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'claude-native-1', { claude: true });
    f.tmux.alive.delete(f.row(bound.id).tmuxSessionName);

    await f.manager.reconcileSessions();
    expect(f.row(bound.id).transport).toBe('tmux');
    const report = await f.manager.structuredMigrationReport();
    expect(report.rows.find(row => row.id === bound.id)?.outcome).toBe('noTranscript');

    // An indexed path that does not exist is as good as none.
    const transcript = path.join(f.root, 'claude-native-1.jsonl');
    f.db.conversationIndex.upsert({
      ref: 'claude-native-1', kind: 'history', projectSlug: project.slug, provider: 'claude', title: 'Claude work',
      updatedAt: new Date().toISOString(), transcriptPath: transcript, isBound: true, degraded: false,
    });
    await f.manager.reconcileSessions();
    expect(f.row(bound.id).transport).toBe('tmux');

    fs.writeFileSync(transcript, '{"type":"user"}\n');
    await f.manager.reconcileSessions();
    expect(f.row(bound.id)).toMatchObject({ transport: 'structured', provider: 'claude', conversationRef: 'claude-native-1' });
  });

  it.each([
    ['the provider lane is off', { disabled: true }],
    ['the default transport is tmux', { manager: { defaultTransport: 'tmux' as const } }],
  ])('converts nothing when %s', async (_name, options) => {
    const f = fixture(options as Parameters<typeof fixture>[0]);
    const bound = await bindTmux(f, 'native-stays');
    const spies = spyTmux(f);
    await f.manager.reconcileSessions();
    await f.manager.reconcileSessions();
    expect(f.row(bound.id).transport).toBe('tmux');
    expect(spies.kill).not.toHaveBeenCalled();
    expect(f.tmux.alive.has(f.row(bound.id).tmuxSessionName)).toBe(true);
  });

  it('converts only the providers whose lane is on', async () => {
    const f = fixture({ manager: { structuredSessions: {
      codex: { enabled: true, command: ['fake-codex'], idleUnloadMinutes: 60, env: {} },
      claude: { enabled: false, command: ['fake-claude'], idleUnloadMinutes: 60, env: {} },
    } } });
    const codex = await bindTmux(f, 'native-codex');
    const claude = await bindTmux(f, 'native-claude', { claude: true });
    f.tmux.alive.delete(f.row(claude.id).tmuxSessionName);
    await f.manager.reconcileSessions();
    expect(f.row(codex.id).transport).toBe('structured');
    expect(f.row(claude.id).transport).toBe('tmux');
    expect((await f.manager.structuredMigrationReport()).rows.find(row => row.id === claude.id)?.outcome).toBe('providerOff');
  });

  it('moves suspended rows too, keeping their own sleep marker', async () => {
    const f = fixture();
    const manual = await bindTmux(f, 'native-manual');
    f.tmux.alive.delete(f.row(manual.id).tmuxSessionName);
    f.db.boundSessions.setManualSuspendedAt(manual.id, '2026-10-01T00:00:00.000Z');
    const pressure = await bindTmux(f, 'native-pressure');
    f.tmux.alive.delete(f.row(pressure.id).tmuxSessionName);
    f.db.boundSessions.setPressureSuspendedAt(pressure.id, '2026-10-02T00:00:00.000Z');
    const idle = await bindTmux(f, 'native-idle-asleep');
    f.tmux.alive.delete(f.row(idle.id).tmuxSessionName);
    f.db.boundSessions.setIdleSuspendedAt(idle.id, '2026-10-03T00:00:00.000Z');

    await f.manager.reconcileSessions();

    expect(f.row(manual.id)).toMatchObject({ transport: 'structured', manualSuspendedAt: '2026-10-01T00:00:00.000Z', idleSuspendedAt: undefined });
    expect(f.row(pressure.id)).toMatchObject({ transport: 'structured', pressureSuspendedAt: '2026-10-02T00:00:00.000Z', idleSuspendedAt: undefined });
    expect(f.row(idle.id)).toMatchObject({ transport: 'structured', idleSuspendedAt: '2026-10-03T00:00:00.000Z' });
  });

  it('does not let one failed move stop the pass, and tries that row again on the next one', async () => {
    const f = fixture();
    const first = await bindTmux(f, 'native-first');
    const second = await bindTmux(f, 'native-second');
    for (const row of [first, second]) f.tmux.alive.delete(f.row(row.id).tmuxSessionName);
    const failing = vi.spyOn(f.db.boundSessions, 'setTransport').mockImplementationOnce(() => { throw new Error('database is locked'); });

    await f.manager.reconcileSessions();
    expect(failing).toHaveBeenCalledTimes(2);
    expect([first, second].map(row => f.row(row.id).transport).sort()).toEqual(['structured', 'tmux']);

    await f.manager.reconcileSessions();
    expect([first, second].map(row => f.row(row.id).transport)).toEqual(['structured', 'structured']);
  });

  it('resumes the converted conversation structurally on its next message, without tmux', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-resume');
    await f.manager.reconcileSessions();
    expect(f.row(bound.id).transport).toBe('structured');
    const spies = spyTmux(f);

    const result = await f.manager.sendInput(bound.id, 'pick up where we left off');
    await settle();

    const resumes = f.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.args[0]).toBe('native-resume');
    const thread = f.plugin.instance!.sessions[0]!;
    expect(thread.resumed).toBe(true);
    expect(thread.calls.filter(call => call.method === 'sendTurn')).toHaveLength(1);
    expect(thread.calls.find(call => call.method === 'sendTurn')!.args[0]).toMatchObject({ text: 'pick up where we left off' });
    expect(result.session).toMatchObject({ transport: 'structured', status: 'bound', idleSuspendedAt: undefined });
    expect(f.row(bound.id).pid).toBe(process.pid);
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.kill).not.toHaveBeenCalled();
    expect(spies.keys).not.toHaveBeenCalled();
  });

  it('does not move a row twice and leaves converted rows to the structured sleep and restore paths', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-once');
    await f.manager.reconcileSessions();
    const converted = f.row(bound.id);
    const spies = spyTmux(f);
    await f.manager.reconcileSessions();
    expect(f.row(bound.id)).toEqual(converted);
    expect(spies.kill).not.toHaveBeenCalled();
    expect(eventLogLines(f.row(bound.id)).filter(line => /Moved to the structured transport/.test(line.text))).toHaveLength(1);
  });
});

describe('Moving a row whose failed run is being recovered', () => {
  const failure = (status: 'scheduled' | 'retrying' | 'stopped') => ({
    turnId: 'turn-1', failedAt: new Date().toISOString(), code: 'server_overloaded', message: 'Selected model is at capacity.', attempts: 1, maxAttempts: 3,
    status, ...(status === 'scheduled' ? { nextRetryAt: new Date(Date.now() + 10 * 60_000).toISOString() } : {}),
    ...(status === 'retrying' ? { retrySubmittedAt: new Date().toISOString() } : {}),
  });

  it.each(['scheduled', 'retrying'] as const)('waits while a %s recovery is pending, never cancels it, and moves once it has stopped', async status => {
    const f = fixture();
    const idle = await bindTmux(f, 'native-recovering-idle');
    const dead = await bindTmux(f, 'native-recovering-dead');
    f.tmux.alive.delete(f.row(dead.id).tmuxSessionName);
    for (const id of [idle.id, dead.id]) f.db.boundSessions.setRunFailure(id, failure(status));
    const spies = spyTmux(f);

    // The dry run says why, and the pass leaves both rows exactly as they were.
    const report = await f.manager.structuredMigrationReport();
    expect(Object.fromEntries(report.rows.map(row => [row.id, row.outcome]))).toEqual({ [idle.id]: 'recovering', [dead.id]: 'recovering' });
    expect(report.outcomes.recovering).toBe(2);
    await f.manager.reconcileSessions();
    for (const id of [idle.id, dead.id]) {
      expect(f.row(id)).toMatchObject({ transport: 'tmux', runFailure: { status, attempts: 1, maxAttempts: 3 } });
      expect(f.row(id).runFailure?.stoppedReason).toBeUndefined();
    }
    expect(spies.kill).not.toHaveBeenCalled();
    expect(f.tmux.alive.has(f.row(idle.id).tmuxSessionName)).toBe(true);
    expect(eventLogLines(f.row(idle.id)).some(line => /Moved to the structured transport/.test(line.text))).toBe(false);
    expect(eventLogLines(f.row(idle.id)).some(line => /cancelled by user input or Stop/i.test(line.text))).toBe(false);

    // Once recovery has resolved (here: it stopped for good) the row is no different from any other, and moves.
    for (const id of [idle.id, dead.id]) f.db.boundSessions.setRunFailure(id, failure('stopped'));
    await f.manager.reconcileSessions();
    for (const id of [idle.id, dead.id]) expect(f.row(id)).toMatchObject({ transport: 'structured' });
  });
});

describe('The migration dry run', () => {
  it('counts what the next pass would do, and changes nothing', async () => {
    const f = fixture();
    const alive = await bindTmux(f, 'native-alive');
    const dead = await bindTmux(f, 'native-dead-row');
    f.tmux.alive.delete(f.row(dead.id).tmuxSessionName);
    const working = await bindTmux(f, 'native-working-row');
    f.db.sqlite.prepare('update bound_sessions set is_working=1 where id=?').run(working.id);
    const pending = await bindTmux(f, 'pending:xyz', { pending: true });
    const claude = await bindTmux(f, 'native-claude-row', { claude: true });
    f.tmux.alive.delete(f.row(claude.id).tmuxSessionName);
    const structured = await f.bindHistory('native-already-structured');
    const spies = spyTmux(f);

    const report = await f.manager.structuredMigrationReport();

    expect(report.defaultTransport).toBe('structured');
    expect(report.providers).toEqual(['codex', 'claude']);
    expect(report.structuredRows).toBe(1);
    expect(report.outcomes).toMatchObject({ idle: 1, dead: 1, working: 1, pending: 1, noTranscript: 1 });
    expect(Object.values(report.outcomes).reduce((sum, count) => sum + count, 0)).toBe(5);
    expect(Object.fromEntries(report.rows.map(row => [row.id, row.outcome]))).toEqual({
      [alive.id]: 'idle', [dead.id]: 'dead', [working.id]: 'working', [pending.id]: 'pending', [claude.id]: 'noTranscript',
    });
    expect(report.rows.some(row => row.id === structured.id)).toBe(false);
    expect(spies.kill).not.toHaveBeenCalled();
    expect(spies.capture).not.toHaveBeenCalled();
    for (const id of [alive.id, dead.id, working.id, pending.id, claude.id]) expect(f.row(id).transport).toBe('tmux');
  });

  it('is served read-only at GET /api/sessions/structured-migration behind authentication', async () => {
    const f = fixture();
    const bound = await bindTmux(f, 'native-route');
    f.tmux.alive.delete(f.row(bound.id).tmuxSessionName);
    const authenticated = vi.fn(async () => undefined);
    const app = fastify();
    await registerSessionRoutes(app, { ensureAuthenticated: authenticated } as never, f.db,
      { getProjectBySlug: async () => project } as never, { get: () => provider } as never, f.manager);
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/sessions/structured-migration' });
      expect(response.statusCode).toBe(200);
      expect(authenticated).toHaveBeenCalled();
      expect(response.json()).toMatchObject({
        defaultTransport: 'structured', structuredRows: 0, outcomes: { dead: 1, idle: 0 },
        rows: [{ id: bound.id, provider: 'codex', projectSlug: 'demo', outcome: 'dead' }],
      });
      expect(f.row(bound.id).transport).toBe('tmux');
    } finally {
      await app.close();
    }
  });
});
