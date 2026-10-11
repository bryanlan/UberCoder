import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { FakeTmux, project, provider, providerSettings } from './helpers/session-fixtures.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-output-restoration-'));
  const db = new AppDatabase(path.join(dir, 'test.sqlite'));
  const tmux = new FakeTmux();
  tmux.paneText = 'OpenAI Codex\n\nCompleted response.\n› Ask Codex to do anything\ngpt-5.6-sol medium · 98% left · ~/demo';
  let finish!: (text: string) => void;
  const history = new Promise<string>(resolve => { finish = resolve; });
  const manager = new SessionManager(db, tmux, path.join(dir, 'runtime'), new RealtimeEventBus(),
    undefined, undefined, { readLastUserInput: () => history });
  const session = await manager.bindConversation({ project, provider, providerSettings,
    conversationRef: 'cold-output', title: 'Cold output', kind: 'history' });
  // Exercise the actual OutputWatcher callback deterministically, without a
  // filesystem notification deciding when the history/input race occurs.
  const flush = (text: string) => (manager as unknown as {
    flushPendingChunk(id: string, text: string): void;
  }).flushPendingChunk(session.id, text);
  const drained = async () => {
    const state = (manager as unknown as { runtimeState(id: string): { rawOutputFlush?: Promise<void> } }).runtimeState(session.id);
    await state.rawOutputFlush;
  };
  const events = async () => (await fs.readFile(session.eventLogPath!, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; text: string });
  const cleanup = async () => { finish('older prompt'); await drained(); await manager.stop(); db.close(); await fs.rm(dir, { recursive: true, force: true }); };
  return { db, manager, session, flush, finish, drained, events, cleanup };
}

describe('output waiting for prompt restoration', () => {
  it('keeps pre-prompt restore repaint out of the recorded reply', async () => {
    const f = await fixture();
    try {
      f.flush('Restore repaint A.');
      await f.manager.sendInput(f.session.id, 'continue');
      f.flush('Response B.');
      f.finish('older prompt');
      await f.drained();
      const events = await f.events();
      expect(events.filter(e => e.type === 'raw-output').map(e => e.text)).toEqual(['Response B.']);
      expect(events.filter(e => e.type === 'user-input').at(-1)?.text).toBe('continue');
    } finally { await f.cleanup(); }
  });

  it('preserves the order of meaningful batches when new input warms the cache mid-read', async () => {
    const f = await fixture();
    try {
      f.db.boundSessions.upsert({ ...f.session, isWorking: true, lastActivityAt: new Date().toISOString() });
      f.flush('Earlier answer A.');
      await f.manager.sendInput(f.session.id, 'continue');
      f.flush('Later answer B.');
      f.finish('older prompt');
      await f.drained();
      expect((await f.events()).filter(e => e.type === 'raw-output').map(e => e.text))
        .toEqual(['Earlier answer A.', 'Later answer B.']);
    } finally { await f.cleanup(); }
  });

  it('discards a waiting batch after manual suspension and keeps its timers cleared', async () => {
    const f = await fixture();
    try {
      f.db.boundSessions.upsert({ ...f.session, isWorking: true, lastActivityAt: new Date().toISOString() });
      f.flush('Output before suspension.');
      // The provider completes while history is still loading; suspension is
      // now permitted, although the queued batch arrived during its turn.
      f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
      await f.manager.suspendSession(f.session.id);
      f.finish('older prompt');
      await f.drained();
      expect((await f.events()).filter(e => e.type === 'raw-output')).toEqual([]);
      expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ isWorking: false });
      const state = (f.manager as unknown as { runtimeState(id: string): {
        workingIdleTimer?: unknown; rawOutputScreenUpdateTimer?: unknown;
      } }).runtimeState(f.session.id);
      expect(state.workingIdleTimer).toBeUndefined();
      expect(state.rawOutputScreenUpdateTimer).toBeUndefined();
    } finally { await f.cleanup(); }
  });

  it('records the deliberate final warm output flush during server shutdown', async () => {
    const f = await fixture();
    try {
      f.finish('older prompt');
      await f.manager.sendInput(f.session.id, 'continue');
      await fs.appendFile(f.session.rawLogPath!, '\nFinal shutdown output.\n');
      const watchers = (f.manager as unknown as { outputWatchers: {
        watchers: Map<string, { pendingChunk: string }>;
      } }).outputWatchers.watchers;
      const deadline = Date.now() + 1500;
      while (!watchers.get(f.session.id)?.pendingChunk.includes('Final shutdown output.')) {
        if (Date.now() >= deadline) throw new Error('Watcher did not buffer shutdown output');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await f.manager.stop();
      expect((await f.events()).filter(e => e.type === 'raw-output').map(e => e.text))
        .toEqual(['\nFinal shutdown output.\n']);
    } finally { await f.cleanup(); }
  });
});
