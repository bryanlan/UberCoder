import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { registerConversationRoutes } from '../src/routes/conversations.js';
import { createRecoveryManager, FakeTmux, project, providerSettings } from './helpers/session-fixtures.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const event = (type: string, turn = 'turn1') => JSON.stringify({
  type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn },
}) + '\n';

async function setup(indexed = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-profile-lifecycle-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  await fs.writeFile(transcript, event('task_started'));
  const db = new AppDatabase(path.join(dir, 'test.sqlite'));
  const tmux = new FakeTmux();
  tmux.paneText = 'OpenAI Codex\n› Ask Codex to do anything\ngpt-5.6-sol medium · 98% left · ~/demo';
  const adapter = new CodexProvider();
  const events = new RealtimeEventBus();
  const manager = createRecoveryManager(db, tmux, dir, events, adapter);
  cleanup.push(async () => { await manager.stop(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const summary = { ref: 'c1', kind: 'history' as const, projectSlug: 'demo', provider: 'codex' as const, title: 'Switch', updatedAt: new Date().toISOString(), transcriptPath: transcript, isBound: false, degraded: false };
  if (indexed) db.conversationIndex.replace('demo', 'codex', [summary]);
  const session = await manager.bindConversation({ project, provider: adapter, providerSettings, conversationRef: 'c1', title: 'Switch', kind: 'history' });
  if (indexed) await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(true);
  const switchHigh = async () => {
    const accepted = await manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest, { timeout: 3000 }).toBeUndefined();
    return { accepted, session: db.boundSessions.getById(session.id)! };
  };
  return { db, tmux, manager, transcript, session, switchHigh, adapter, events, summary };
}

describe('model switching at provider turn boundaries', () => {
  it.each(['read', 'bind'])('attaches turn monitoring when an unindexed bound conversation is opened through %s', async (route) => {
    const { db, manager, transcript, session, switchHigh, adapter, events, summary } = await setup(false);
    adapter.getConversation = async () => ({ summary, messages: [] });
    const app = fastify();
    await registerConversationRoutes(app, { ensureAuthenticated: async () => undefined } as never, db,
      { getProjectBySlug: async () => project, getMergedProviderSettings: () => providerSettings } as never,
      { get: () => adapter } as never, manager, events);
    try {
      const response = await app.inject(route === 'read'
        ? { method: 'GET', url: '/api/conversations/demo/codex/c1/messages?limit=10' }
        : { method: 'POST', url: '/api/conversations/demo/codex/c1/bind', payload: {} });
      expect(response.statusCode).toBe(200);
      expect(db.conversationIndex.get('demo', 'codex', 'c1')?.transcriptPath).toBe(transcript);
      await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(true);
      const lastOutputAt = new Date().toISOString();
      db.boundSessions.upsert({ ...db.boundSessions.getById(session.id)!, lastOutputAt });
      await fs.appendFile(transcript, event('turn_aborted'));
      await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking, { timeout: 3000 }).toBe(false);
      expect((await switchHigh()).session.codexProfile).toBe('high');
    } finally { await app.close(); }
  });

  it.each(['turn_aborted', 'task_complete'])('releases %s before the output cooldown and switches the same session', async (type) => {
    const { db, tmux, manager, transcript, session, switchHigh } = await setup();
    const lastOutputAt = new Date().toISOString();
    db.boundSessions.upsert({ ...db.boundSessions.getById(session.id)!, lastOutputAt, lastActivityAt: lastOutputAt });
    if (type === 'turn_aborted') await manager.sendKeystrokes(session.id, { keys: ['Escape'] });
    await fs.appendFile(transcript, event(type));
    // The transcript watcher must release the browser queue without waiting for a screen poll.
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking, { timeout: 3000 }).toBe(false);
    expect(db.boundSessions.getById(session.id)?.lastCompletedAt).toBeUndefined();
    expect((await manager.getSessionScreen(session.id))?.session.isWorking).toBe(false);
    // A terminal repaint can lag behind the authoritative completion event.
    tmux.paneText = 'OpenAI Codex\n• Working (20s • esc to interrupt)';
    const result = await switchHigh();
    expect(result.session).toMatchObject({ id: session.id, conversationRef: 'c1', codexProfile: 'high', isWorking: false });
    expect(tmux.createdCommands.at(-1)).toContain('gpt-6-astra');
  });

  it('rechecks the transcript before switching even if the watcher has not seen the next turn', async () => {
    const { db, tmux, manager, transcript, session } = await setup();
    await fs.appendFile(transcript, event('task_complete'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    await fs.appendFile(transcript, event('task_started', 'turn2'));
    const accepted = await manager.requestModelProfile(session.id, 'high');
    expect(accepted.session.modelProfileRequest).toMatchObject({ profile: 'high', state: 'queued' });
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest).toMatchObject({
      profile: 'high', state: 'queued', deferredReason: 'turn_running',
    });
    expect(tmux.created).toHaveLength(1);
  });

  it.each(['input', 'keys'])('does not let the previous completion acknowledge newly submitted %s', async (transport) => {
    const { db, tmux, manager, transcript, session } = await setup();
    await fs.appendFile(transcript, event('task_complete'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    if (transport === 'input') await manager.sendInput(session.id, 'Continue the review');
    else await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: 'Continue the review' });
    const accepted = await manager.requestModelProfile(session.id, 'high');
    expect(accepted.session.modelProfileRequest).toMatchObject({ profile: 'high', state: 'queued' });
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest).toMatchObject({
      profile: 'high', state: 'queued', deferredReason: 'turn_running',
    });
    expect(tmux.created).toHaveLength(1);
    await fs.appendFile(transcript, event('task_started', 'turn2') + event('turn_aborted', 'turn2'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.codexProfile, { timeout: 3000 }).toBe('high');
  });

  it('keeps only the latest queued profile and applies it after the turn', async () => {
    const { db, tmux, manager, transcript, session } = await setup();
    await manager.requestModelProfile(session.id, 'high');
    const latest = await manager.requestModelProfile(session.id, 'low');

    expect(latest.session.modelProfileRequest).toMatchObject({ profile: 'low', state: 'queued' });
    expect(tmux.created).toHaveLength(1);
    await fs.appendFile(transcript, event('task_complete'));

    await expect.poll(() => db.boundSessions.getById(session.id)?.codexProfile, { timeout: 3000 }).toBe('low');
    expect(tmux.createdCommands.at(-1)).toContain('gpt-6-luna');
  });

  it('cancels a queued change when the confirmed active profile is selected again', async () => {
    const { db, tmux, manager, transcript, session } = await setup();
    tmux.paneText = 'OpenAI Codex\n› Ask Codex to do anything\ngpt-6-astra xhigh · 98% left · ~/demo';
    const current = db.boundSessions.getById(session.id)!;
    db.boundSessions.upsert({
      ...current,
      codexProfile: 'high',
      updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
    });

    await manager.requestModelProfile(session.id, 'low');
    const cancelled = await manager.requestModelProfile(session.id, 'high');

    expect(cancelled.session).toMatchObject({ codexProfile: 'high', modelProfileRequest: undefined });
    await fs.appendFile(transcript, event('task_complete'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    expect(tmux.created).toHaveLength(1);
  });

  it('reapplies a saved profile when its running model predates the catalog change', async () => {
    const { db, tmux, manager, transcript, session } = await setup();
    await fs.appendFile(transcript, event('task_complete'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    const current = db.boundSessions.getById(session.id)!;
    db.boundSessions.upsert({ ...current, codexProfile: 'medium' });

    const accepted = await manager.requestModelProfile(session.id, 'medium');
    expect(accepted.session.modelProfileRequest).toMatchObject({ profile: 'medium', state: 'queued' });
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest).toBeUndefined();
    expect(tmux.created).toHaveLength(2);
    expect(tmux.createdCommands.at(-1)).toContain('gpt-6-sol');
    expect(db.boundSessions.getById(session.id)?.codexProfile).toBe('medium');
  });

  it('cancels the exact queued request without switching after completion', async () => {
    const { db, tmux, manager, transcript, session } = await setup();
    const accepted = await manager.requestModelProfile(session.id, 'high');
    const requestId = accepted.session.modelProfileRequest!.requestId;

    await expect(manager.cancelModelProfileRequest(session.id, '00000000-0000-4000-8000-000000000000'))
      .rejects.toThrow('request changed');
    const cancelled = await manager.cancelModelProfileRequest(session.id, requestId);
    expect(cancelled.session.modelProfileRequest).toBeUndefined();
    await fs.appendFile(transcript, event('task_complete'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    expect(tmux.created).toHaveLength(1);
    expect(db.boundSessions.getById(session.id)?.codexProfile).toBeUndefined();
  });

  it('defers for a real terminal draft and applies after reconciliation sees it cleared', async () => {
    const { db, tmux, manager, transcript, session } = await setup();
    await fs.appendFile(transcript, event('task_complete'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    tmux.paneText = 'OpenAI Codex\n› do not lose this draft\ngpt-5.6-sol medium · 98% left · ~/demo';

    await manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest).toMatchObject({
      state: 'queued', deferredReason: 'unsent_input',
    });
    expect(tmux.created).toHaveLength(1);

    tmux.paneText = 'OpenAI Codex\n› Ask Codex to do anything\ngpt-5.6-sol medium · 98% left · ~/demo';
    await manager.reconcileSessions();
    await expect.poll(() => db.boundSessions.getById(session.id)?.codexProfile).toBe('high');
    expect(tmux.created).toHaveLength(2);
  });

  it('finalizes an applying request after restart only when tmux evidence matches', async () => {
    const { db, tmux, manager, session } = await setup();
    const requestId = '8de22a12-5618-43b8-8306-69f362d7897c';
    const applying = {
      requestId,
      profile: 'high' as const,
      requestedAt: new Date().toISOString(),
      state: 'applying' as const,
      startedAt: new Date().toISOString(),
      resumeConversationRef: session.conversationRef,
    };
    db.boundSessions.replaceModelProfileRequest(session.id, applying, applying.startedAt);
    await tmux.setOption(session.tmuxSessionName, '@agent_console_codex_profile', 'high');
    await tmux.setOption(session.tmuxSessionName, '@agent_console_model_profile_request_id', requestId);

    await manager.reconcileSessions();

    expect(db.boundSessions.getById(session.id)).toMatchObject({
      codexProfile: 'high',
      modelProfileRequest: undefined,
    });
    expect(tmux.created).toHaveLength(1);
  });

  it('fails an ambiguous applying request after restart without repeating the switch', async () => {
    const { db, tmux, manager, session } = await setup();
    const applying = {
      requestId: '68eaef29-acb1-41bc-a810-55cae9ff17c8',
      profile: 'high' as const,
      requestedAt: new Date().toISOString(),
      state: 'applying' as const,
      startedAt: new Date().toISOString(),
      resumeConversationRef: session.conversationRef,
    };
    db.boundSessions.replaceModelProfileRequest(session.id, applying, applying.startedAt);

    await manager.reconcileSessions();

    expect(db.boundSessions.getById(session.id)?.modelProfileRequest).toMatchObject({
      state: 'failed',
      profile: 'high',
      message: expect.stringContaining('could not prove its outcome'),
    });
    expect(db.boundSessions.getById(session.id)?.codexProfile).toBeUndefined();
    expect(tmux.created).toHaveLength(1);
  });

  it('continues a queued request after the manager restarts without a browser request', async () => {
    const { db, tmux, manager, transcript, session, adapter, events } = await setup();
    await manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest).toMatchObject({
      state: 'queued', profile: 'high', deferredReason: 'turn_running',
    });
    await manager.stop();
    await fs.appendFile(transcript, event('task_complete'));

    const resumedManager = createRecoveryManager(db, tmux, path.dirname(transcript), events, adapter);
    cleanup.push(async () => { await resumedManager.stop(); });
    await resumedManager.reconcileSessions();

    await expect.poll(() => db.boundSessions.getById(session.id)?.codexProfile, { timeout: 3000 }).toBe('high');
    expect(db.boundSessions.getById(session.id)?.modelProfileRequest).toBeUndefined();
    expect(tmux.createdCommands.at(-1)).toContain('gpt-6-astra');
  });

  it('clears a queued request when its session is released', async () => {
    const { db, tmux, manager, session } = await setup();
    await manager.requestModelProfile(session.id, 'high');

    await manager.releaseSession(session.id);

    expect(db.boundSessions.getById(session.id)).toMatchObject({
      status: 'ended',
      shouldRestore: false,
      modelProfileRequest: undefined,
    });
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(false);
  });
});

describe('Claude model profiles', () => {
  async function setupClaude(kind: 'history' | 'pending') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-model-profile-'));
    const db = new AppDatabase(path.join(dir, 'test.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'Claude Code\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)';
    const adapter = new ClaudeProvider();
    const settings = {
      ...providerSettings,
      id: 'claude' as const,
      commands: {
        ...providerSettings.commands,
        newCommand: ['claude'],
        resumeCommand: ['claude', '--resume', '{{conversationId}}'],
        continueCommand: ['claude', '--continue'],
      },
    };
    const manager = createRecoveryManager(db, tmux, dir, new RealtimeEventBus(), adapter, settings);
    cleanup.push(async () => { await manager.stop(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const session = await manager.bindConversation({
      project, provider: adapter, providerSettings: settings,
      conversationRef: kind === 'pending' ? 'pending:claude-first-turn' : 'claude-history',
      title: 'Claude profile', kind,
    });
    return { db, tmux, manager, session };
  }

  it('rebinds the same Claude conversation with the selected H and L models', async () => {
    const { db, tmux, manager, session } = await setupClaude('history');
    await manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => db.boundSessions.getById(session.id)?.claudeProfile).toBe('high');
    expect(tmux.createdCommands.at(-1)).toContain("'claude-fable-5-1' '--effort' 'xhigh'");
    expect(db.boundSessions.getById(session.id)).toMatchObject({ conversationRef: 'claude-history', modelProfileRequest: undefined });

    await manager.requestModelProfile(session.id, 'low');
    await expect.poll(() => db.boundSessions.getById(session.id)?.claudeProfile).toBe('low');
    expect(tmux.createdCommands.at(-1)).toContain("'claude-sonnet-5' '--effort' 'high'");
    expect(tmux.createdCommands.at(-1)).toContain("'--resume' 'claude-history'");
  });

  it('starts the chosen Claude model before the first turn in a pending conversation', async () => {
    const { db, tmux, manager, session } = await setupClaude('pending');
    expect(session.claudeProfile).toBe('medium');
    expect(tmux.createdCommands[0]).toContain("'claude-opus-5-5' '--effort' 'xhigh'");

    await manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => db.boundSessions.getById(session.id)?.claudeProfile).toBe('high');
    expect(tmux.created).toHaveLength(2);
    expect(tmux.createdCommands.at(-1)).toContain("'claude-fable-5-1' '--effort' 'xhigh'");
    expect(tmux.createdCommands.at(-1)).not.toContain('--resume');
  });

  it('keeps a pending Claude draft intact while a profile request waits', async () => {
    const { db, tmux, manager, session } = await setupClaude('pending');
    tmux.paneText = 'Claude Code\n❯ keep this draft\n⏵⏵ bypass permissions on (shift+tab to cycle)';

    await manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest).toMatchObject({
      profile: 'high', state: 'queued', deferredReason: 'unsent_input',
    });
    expect(tmux.created).toHaveLength(1);
    expect(db.boundSessions.getById(session.id)?.claudeProfile).toBe('medium');
  });
});
