import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
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
  const switchHigh = () => manager.switchCodexModelProfile({ sessionId: session.id, project, provider: adapter, providerSettings, profile: 'high' });
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
    const { db, tmux, transcript, session, switchHigh } = await setup();
    await fs.appendFile(transcript, event('task_complete'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    await fs.appendFile(transcript, event('task_started', 'turn2'));
    await expect(switchHigh()).rejects.toThrow('session is working');
    expect(tmux.created).toHaveLength(1);
  });

  it.each(['input', 'keys'])('does not let the previous completion acknowledge newly submitted %s', async (transport) => {
    const { db, tmux, manager, transcript, session, switchHigh } = await setup();
    await fs.appendFile(transcript, event('task_complete'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    if (transport === 'input') await manager.sendInput(session.id, 'Continue the review');
    else await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: 'Continue the review' });
    await expect(switchHigh()).rejects.toThrow('session is working');
    expect(tmux.created).toHaveLength(1);
    await fs.appendFile(transcript, event('task_started', 'turn2') + event('turn_aborted', 'turn2'));
    await expect.poll(() => db.boundSessions.getById(session.id)?.isWorking).toBe(false);
    expect((await switchHigh()).session.codexProfile).toBe('high');
  });
});
