import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { createRecoveryManager, FakeTmux, project, providerSettings } from './helpers/session-fixtures.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function record(type: 'user' | 'assistant', timestamp: string, stopReason?: string): string {
  return JSON.stringify({
    type, timestamp, uuid: `${type}-${timestamp}`, isSidechain: false,
    message: type === 'user'
      ? { role: 'user', content: 'Please continue' }
      : { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stop_reason: stopReason },
  }) + '\n';
}

const ready = (text = '') => `Claude Code\n❯ ${text}\n⏵⏵ bypass permissions on (shift+tab to cycle)`;

async function restoredFixture(currentTurn: boolean, completed = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-restored-ready-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  const started = new Date(Date.now() - 120_000).toISOString();
  await fs.writeFile(transcript, record('user', started)
    + record('assistant', new Date(Date.now() - 110_000).toISOString(), completed ? 'end_turn' : 'tool_use'));
  let db = new AppDatabase(path.join(dir, 'test.sqlite'));
  class ComposerTmux extends FakeTmux {
    pid = 4242;
    override async getPanePid(): Promise<number> { return this.pid; }
    override async sendLiteralText(name: string, text: string): Promise<void> {
      await super.sendLiteralText(name, text);
      this.paneText = ready(text);
    }
    override async sendKeys(name: string, keys: string[]): Promise<void> {
      await super.sendKeys(name, keys);
      if (keys.includes('Enter')) this.paneText = 'Claude Code\n✶ Thinking... (esc to interrupt)';
    }
  }
  const tmux = new ComposerTmux();
  // In one case the transcript turn belongs to this writer. In the other it
  // belongs to a process that exited before this writer resumed the history.
  tmux.sessionCreatedAt = new Date(Date.now() - (currentTurn ? 180_000 : 10_000)).toISOString();
  tmux.paneText = ready();
  const adapter = new ClaudeProvider();
  const createManager = () => createRecoveryManager(db, tmux, dir, new RealtimeEventBus(), adapter,
    { ...providerSettings, id: 'claude' });
  let manager = createManager();
  db.conversationIndex.replace('demo', 'claude', [{
    ref: 'c1', kind: 'history', projectSlug: 'demo', provider: 'claude', title: 'Resumed',
    updatedAt: started, transcriptPath: transcript, isBound: false, degraded: false,
  }]);
  const session = await manager.bindConversation({ project, provider: adapter,
    providerSettings: { ...providerSettings, id: 'claude' }, conversationRef: 'c1', title: 'Resumed', kind: 'history' });
  cleanup.push(async () => { await manager.stop(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { get db() { return db; }, get manager() { return manager; }, tmux, session, transcript,
    async reopen() {
      await manager.stop(); db.close(); db = new AppDatabase(path.join(dir, 'test.sqlite'));
      manager = createManager(); await manager.observeSessions();
    },
    submit: () => manager.sendKeystrokes(session.id, {
      text: 'We are back, please continue', submittedText: 'We are back, please continue', keys: ['Enter'], submissionId: randomUUID(),
    }),
  };
}

describe('Claude work readiness', () => {
  it('drops the exited writer\'s submitted-turn marker when the provider is restored', async () => {
    const f = await restoredFixture(true);
    await expect.poll(() => f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(true);
    const runtime = (f.manager as unknown as { runtimeState(id: string): { submittedTurnAt?: string } }).runtimeState(f.session.id);
    runtime.submittedTurnAt = new Date(Date.now() - 90_000).toISOString();
    expect((await f.submit()).queuedInput?.state).toBe('queued');
    f.tmux.alive.clear();
    f.tmux.pid++;
    f.tmux.sessionCreatedAt = new Date().toISOString();
    await f.manager.ensureSession(f.session.id);
    await expect.poll(() => f.tmux.sentKeys).toEqual([['Enter']]);
    expect(f.tmux.sent).toEqual(['We are back, please continue']);
    expect(f.tmux.created).toHaveLength(2);
  });

  it('delivers queued human input after reopening a restored unfinished conversation', async () => {
    const f = await restoredFixture(false);
    f.tmux.paneText = 'Claude Code\n✶ Thinking... (esc to interrupt)';
    expect((await f.submit()).queuedInput?.state).toBe('queued');
    expect(f.tmux.sent).toEqual([]);
    f.tmux.paneText = ready();
    // A backend restart must rediscover the existing writer's epoch rather
    // than restore the transcript's old running state.
    await f.reopen();
    await expect.poll(() => f.tmux.sentKeys).toEqual([['Enter']]);
    expect(f.tmux.sent).toEqual(['We are back, please continue']);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
    expect(f.db.boundSessions.getById(f.session.id)?.lastResponseAt).toBeUndefined();
    const events = (await fs.readFile(f.session.eventLogPath!, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'user-input')).toHaveLength(1);
  });

  it('keeps an actual current turn busy across backend restart until its reply completes', async () => {
    const f = await restoredFixture(true);
    await expect.poll(() => f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(true);
    expect((await f.submit()).queuedInput?.state).toBe('queued');
    await f.reopen();
    await expect.poll(() => f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(true);
    expect(f.tmux.sent).toEqual([]);
    const completedAt = new Date().toISOString();
    await fs.appendFile(f.transcript, record('assistant', completedAt, 'end_turn'));
    await expect.poll(() => f.tmux.sentKeys).toEqual([['Enter']]);
    expect(f.tmux.sent).toEqual(['We are back, please continue']);
    expect(f.db.boundSessions.getById(f.session.id)?.lastResponseAt).toBe(completedAt);
  });

  it('does not turn a historical completion into a new response when history resumes', async () => {
    const f = await restoredFixture(false, true);
    await f.reopen();
    await f.manager.getSessionScreen(f.session.id);
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ isWorking: false });
    expect(f.db.boundSessions.getById(f.session.id)?.lastResponseAt).toBeUndefined();
    expect(f.db.boundSessions.getById(f.session.id)?.lastCompletedAt).toBeUndefined();
  });

  it.each([
    ['approval', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend'],
    ['draft', ready('preserve this unsent human draft')],
  ])('still protects a %s in a restored process with historical work', async (_label, screen) => {
    const f = await restoredFixture(false);
    f.tmux.paneText = screen;
    expect((await f.submit()).queuedInput).toBeDefined();
    await f.reopen();
    await f.manager.getSessionScreen(f.session.id);
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it.each([
    {
      layout: 'permissions footer',
      readyScreen: 'Claude Code\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)',
    },
    {
      layout: 'bug report notification without a permissions footer',
      readyScreen: [
        'Claude Code',
        'The answer is ready.',
        '╭────────────────────────────────────────────────────────────────────╮',
        '│ ✻ Bug report drafted: A saved instruction was too broad             │',
        '│ │ - What happened: A rule was applied outside its intended scope.   │',
        '│ 1 to review · 2 to send · 0 to dismiss                              │',
        '╰────────────────────────────────────────────────────────────────────╯',
        '──────────────────────────────────────────────────────────────────────',
        '❯ ',
      ].join('\n'),
    },
    { layout: 'empty composer without a footer', readyScreen: 'Claude Code\n❯ ' },
  ])('waits for a real input prompt with $layout, then handles continuation', async ({ readyScreen }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-ready-'));
    const transcript = path.join(dir, 'transcript.jsonl');
    const started = new Date(Date.now() - 2_000).toISOString();
    await fs.writeFile(transcript, record('user', started));
    const db = new AppDatabase(path.join(dir, 'test.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'Claude Code\n✶ Thinking... (esc to interrupt)';
    const adapter = new ClaudeProvider();
    const manager = createRecoveryManager(db, tmux, dir, new RealtimeEventBus(), adapter,
      { ...providerSettings, id: 'claude' });
    cleanup.push(async () => { await manager.stop(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
    db.conversationIndex.replace('demo', 'claude', [{
      ref: 'c1', kind: 'history', projectSlug: 'demo', provider: 'claude', title: 'Ready',
      updatedAt: started, transcriptPath: transcript, isBound: false, degraded: false,
    }]);
    const session = await manager.bindConversation({
      project, provider: adapter, providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'c1', title: 'Ready', kind: 'history',
    });
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(true);
    db.boundSessions.setRunFailure(session.id, {
      turnId: 'original-failure', failedAt: started, code: 'server_overloaded', message: 'API Error: 529 Overloaded',
      attempts: 1, maxAttempts: 3, status: 'retrying', retrySubmittedAt: started,
    });

    const firstEnd = new Date().toISOString();
    await fs.appendFile(transcript, record('assistant', firstEnd, 'end_turn'));
    await expect.poll(() => (manager as unknown as { runRecovery: { getRunState: (id: string) => { status: string } | undefined } })
      .runRecovery.getRunState(session.id)?.status).toBe('completed');
    expect(db.boundSessions.getById(session.id)?.isWorking).toBe(true);
    expect(db.boundSessions.getById(session.id)?.lastResponseAt).toBeUndefined();
    expect(db.boundSessions.getById(session.id)?.runFailure).toMatchObject({ status: 'retrying', attempts: 1 });

    tmux.paneText = [
      'Claude Code',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    await manager.getSessionScreen(session.id);
    expect(db.boundSessions.getById(session.id)?.isWorking).toBe(true);
    expect(db.boundSessions.getById(session.id)?.lastResponseAt).toBeUndefined();
    expect(db.boundSessions.getById(session.id)?.runFailure?.attempts).toBe(1);

    tmux.paneText = readyScreen;
    await manager.getSessionScreen(session.id);
    expect(db.boundSessions.getById(session.id)).toMatchObject({ isWorking: false, lastResponseAt: firstEnd });
    expect(db.boundSessions.getById(session.id)?.runFailure).toBeUndefined();

    tmux.paneText = 'Claude Code\n✶ Thinking... (esc to interrupt)';
    await fs.appendFile(transcript, record('assistant', new Date(Date.now() + 1).toISOString(), 'tool_use'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(true);
  });

  it('records a completed main reply while a background agent remains visible below the prompt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-ready-agent-'));
    const transcript = path.join(dir, 'transcript.jsonl');
    const started = new Date(Date.now() - 2_000).toISOString();
    await fs.writeFile(transcript, record('user', started));
    const db = new AppDatabase(path.join(dir, 'test.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'Claude Code\n✶ Thinking... (esc to interrupt)';
    const adapter = new ClaudeProvider();
    const manager = createRecoveryManager(db, tmux, dir, new RealtimeEventBus(), adapter,
      { ...providerSettings, id: 'claude' });
    cleanup.push(async () => { await manager.stop(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
    db.conversationIndex.replace('demo', 'claude', [{
      ref: 'c1', kind: 'history', projectSlug: 'demo', provider: 'claude', title: 'Ready',
      updatedAt: started, transcriptPath: transcript, isBound: false, degraded: false,
    }]);
    const session = await manager.bindConversation({
      project, provider: adapter, providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'c1', title: 'Ready', kind: 'history',
    });
    const completedAt = new Date().toISOString();
    await fs.appendFile(transcript, record('assistant', completedAt, 'end_turn'));
    await expect.poll(() => (manager as unknown as { runRecovery: { getRunState: (id: string) => { status: string } | undefined } })
      .runRecovery.getRunState(session.id)?.status).toBe('completed');

    tmux.paneText = [
      'Claude Code',
      'Answer already delivered.',
      '✻ Waiting for 1 background agent to finish',
      '❯ an unsent draft',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · ↓ to manage',
      '  ● main',
      '  ◯ general-purpose (+2)  Re-checking Social Security 8m 19s',
    ].join('\n');
    const result = await manager.getSessionScreen(session.id);
    expect(result?.screen.inputText).toBe('an unsent draft');
    expect(db.boundSessions.getById(session.id)).toMatchObject({ isWorking: false, lastResponseAt: completedAt });
  });
});
