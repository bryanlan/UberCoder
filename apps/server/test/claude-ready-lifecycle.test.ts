import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

describe('Claude work readiness', () => {
  it('waits for a real input prompt before recording a completed response, then handles continuation', async () => {
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

    const firstEnd = new Date().toISOString();
    await fs.appendFile(transcript, record('assistant', firstEnd, 'end_turn'));
    await expect.poll(() => (manager as unknown as { runRecovery: { getRunState: (id: string) => { status: string } | undefined } })
      .runRecovery.getRunState(session.id)?.status).toBe('completed');
    expect(db.boundSessions.getById(session.id)?.isWorking).toBe(true);
    expect(db.boundSessions.getById(session.id)?.lastResponseAt).toBeUndefined();

    tmux.paneText = 'Claude Code\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)';
    await manager.getSessionScreen(session.id);
    expect(db.boundSessions.getById(session.id)).toMatchObject({ isWorking: false, lastResponseAt: firstEnd });

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
