import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationSummary, SessionEvent } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { adoptPendingConversation } from '../src/sessions/pending-adoption.js';
import { ConversationTitleService, TITLE_GENERATION_AWAITING_MESSAGE } from '../src/titles/service.js';
import { PEER_WAKE_PROMPT } from '../src/coordination/wake.js';
import type { TitleResult, TitleRunner } from '../src/workers/runtime.js';
import { FakeTmux, createRecoveryManager, provider, providerSettings } from './helpers/session-fixtures.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const placeholder = 'New Codex conversation';
const nativeSummary: ConversationSummary = {
  ref: 'native-1', kind: 'history', projectSlug: 'demo', provider: 'codex', title: 'fix the login redirect please',
  createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:01.000Z', transcriptPath: '/tmp/codex/native-1.jsonl',
  isBound: false, degraded: false, rawMetadata: { firstUserTextHash: 'first-hash' },
};

async function fixture(options: { runner?: TitleRunner['title']; newConsoleChat?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-titles-'));
  const db = new AppDatabase(path.join(directory, 'agent-console.sqlite'));
  const eventBus = new RealtimeEventBus();
  const events: SessionEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  db.pendingConversations.put({
    ref: 'pending:new', kind: 'pending', projectSlug: 'demo', provider: 'codex', title: placeholder,
    createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:00.000Z', isBound: true, boundSessionId: 'session-1',
    degraded: false, rawMetadata: { pending: true,
      ...(options.newConsoleChat === false ? {} : { titleGeneration: TITLE_GENERATION_AWAITING_MESSAGE }) },
  });
  db.boundSessions.upsert({
    id: 'session-1', provider: 'codex', projectSlug: 'demo', conversationRef: 'pending:new', tmuxSessionName: 'ac-codex-demo-new',
    status: 'bound', shouldRestore: true, title: placeholder, startedAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:00.000Z',
  } satisfies BoundSession);
  const title = vi.fn<TitleRunner['title']>(options.runner ?? (async () => ({ title: 'Fix Login Redirect', usage: null })));
  const runner = { title, stop: vi.fn() };
  const errors: unknown[] = [];
  const service = new ConversationTitleService(db, eventBus, runner, (error) => errors.push(error));
  cleanups.push(async () => { await service.stop(); db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const send = async (text: string, conversationRef = db.boundSessions.getById('session-1')!.conversationRef) => {
    eventBus.emit({ type: 'session.user-input', sessionId: 'session-1', projectSlug: 'demo', provider: 'codex', conversationRef,
      messageId: `live:${text}`, text, timestamp: new Date().toISOString() });
    await service.settled();
  };
  const state = () => db.pendingConversations.get('pending:new')?.rawMetadata?.titleGeneration;
  const adopt = () => adoptPendingConversation({ db, projectSlug: 'demo', providerId: 'codex', pendingRef: 'pending:new',
    matchedConversation: { ...nativeSummary, title: placeholder } });
  return { db, events, runner, errors, service, send, state, adopt };
}

describe('generated conversation titles', () => {
  it('names a new chat from its first human message and shows the title everywhere', async () => {
    const f = await fixture();
    await f.send('please fix the login redirect, it loops forever after signing in');

    expect(f.runner.title).toHaveBeenCalledWith('please fix the login redirect, it loops forever after signing in', expect.any(String));
    expect(f.db.pendingConversations.get('pending:new')?.title).toBe('Fix Login Redirect');
    expect(f.db.boundSessions.getById('session-1')?.title).toBe('Fix Login Redirect');
    expect(f.state()).toBe('ready');
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'conversation.index-updated', conversationRef: 'pending:new' }));

    await f.send('and add a test for it');
    expect(f.runner.title).toHaveBeenCalledTimes(1);
  });

  it('saves the title under the native conversation when the chat was adopted before or during the call', async () => {
    const f = await fixture();
    f.adopt();
    expect(f.db.conversationIndex.list().find((row) => row.ref === 'native-1')?.title).toBe(placeholder);
    await f.send('fix the login redirect please');
    expect(f.db.conversationIndex.list().find((row) => row.ref === 'native-1')?.title).toBe('Fix Login Redirect');

    let finish!: (result: TitleResult) => void;
    const g = await fixture({ runner: () => new Promise((resolve) => { finish = resolve; }) });
    const sent = g.send('fix the login redirect please');
    await vi.waitFor(() => expect(g.runner.title).toHaveBeenCalled());
    g.adopt();
    finish({ title: 'Fix Login Redirect', usage: null });
    await sent;
    expect(g.db.titleOverrides.get('demo', 'codex', 'native-1')?.title).toBe('Fix Login Redirect');
    expect(g.db.titleOverrides.get('demo', 'codex', 'pending:new')).toBeUndefined();
  });

  it('keeps a title the user chose before or during generation', async () => {
    const before = await fixture();
    before.db.titleOverrides.set('demo', 'codex', 'pending:new', 'My Name', '2026-10-19T10:00:00.000Z');
    await before.send('fix the login redirect please');
    expect(before.runner.title).not.toHaveBeenCalled();
    expect(before.state()).toBe('skipped');

    let finish!: (result: TitleResult) => void;
    const during = await fixture({ runner: () => new Promise((resolve) => { finish = resolve; }) });
    const sent = during.send('fix the login redirect please');
    await vi.waitFor(() => expect(during.runner.title).toHaveBeenCalled());
    during.db.titleOverrides.set('demo', 'codex', 'pending:new', 'My Name', '2026-10-19T10:00:00.000Z');
    finish({ title: 'Fix Login Redirect', usage: null });
    await sent;
    expect(during.db.pendingConversations.get('pending:new')?.title).toBe('My Name');
    expect(during.state()).toBe('skipped');
  });

  it('waits for a real request and ignores chats that were not created as new Console chats', async () => {
    const f = await fixture();
    for (const control of ['/model', '2', PEER_WAKE_PROMPT, '   ']) await f.send(control);
    expect(f.runner.title).not.toHaveBeenCalled();
    expect(f.state()).toBe(TITLE_GENERATION_AWAITING_MESSAGE);

    const launched = await fixture({ newConsoleChat: false });
    await launched.send('fix the login redirect please');
    expect(launched.runner.title).not.toHaveBeenCalled();
  });

  it('records a failed call once and never retries it automatically', async () => {
    const f = await fixture({ runner: async () => ({ title: null, usage: null }) });
    await f.send('fix the login redirect please');
    await f.send('are you there?');
    expect(f.runner.title).toHaveBeenCalledTimes(1);
    expect(f.state()).toBe('failed');
    expect(f.errors).toHaveLength(1);
    expect(f.db.pendingConversations.get('pending:new')?.title).toBe(placeholder);
  });
});

describe('native registration titles', () => {
  async function registered(summary: ConversationSummary, session: Partial<BoundSession> = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-registration-title-'));
    const db = new AppDatabase(path.join(directory, 'agent-console.sqlite'));
    db.boundSessions.upsert({
      id: 'session-1', provider: 'codex', projectSlug: 'demo', conversationRef: 'native-1', resumeConversationRef: 'native-1',
      tmuxSessionName: 'ac-codex-demo-native', status: 'bound', shouldRestore: true, title: placeholder,
      startedAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:00.000Z', ...session,
    } satisfies BoundSession);
    const manager = createRecoveryManager(db, new FakeTmux(), directory, new RealtimeEventBus(),
      { ...provider, async getConversation() { return { summary, messages: [] }; } }, providerSettings);
    cleanups.push(async () => { manager.stop(); db.close(); await fs.rm(directory, { recursive: true, force: true }); });
    await manager.adoptRegisteredSession('session-1', 'codex', 'native-1');
    return db.conversationIndex.list().find((row) => row.ref === 'native-1')?.title;
  }

  it('keeps the transcript title when a resumed chat registers again', async () => {
    expect(await registered(nativeSummary)).toBe('fix the login redirect please');
  });

  it('uses the placeholder only until the transcript has a first message', async () => {
    expect(await registered({ ...nativeSummary, title: 'rollout-2026-10-19', rawMetadata: {} })).toBe(placeholder);
  });
});
