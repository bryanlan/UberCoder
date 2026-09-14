import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRunMonitor } from '../src/providers/transcripts/codex-run-state.js';
import { parseCodexConversationFile } from '../src/providers/transcripts/codex.js';
import { AppDatabase } from '../src/db/database.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
import { createRecoveryManager, FakeTmux, project, provider, providerSettings } from './helpers/session-fixtures.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function file() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-run-state-')); paths.push(dir); return path.join(dir, 'transcript.jsonl'); }
const record = (type: string, turn = 'turn1', error?: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn, error } }) + '\n';
const capacity = { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' };

describe('Codex authoritative run state', () => {
  it('reads the incident failure and preserves it as visible status history', async () => {
    const p = await file(); await fs.writeFile(p, record('task_started') + record('task_complete', 'turn1', capacity));
    expect(await new CodexRunMonitor().read(p)).toMatchObject({ status: 'failed', error: { code: 'server_overloaded', message: capacity.message } });
    const transcript = await parseCodexConversationFile({ filePath: p, provider: 'codex', projectSlug: 'demo', conversationRef: 'c1' });
    expect(transcript.displayMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'status', text: `Run stopped: ${capacity.message}` })]));
  });

  it('waits for complete appended records and does not let an old turn overwrite a new one', async () => {
    const p = await file(); const m = new CodexRunMonitor(); await fs.writeFile(p, record('task_started'));
    expect((await m.read(p))?.status).toBe('running');
    const failure = record('task_complete', 'turn1', capacity); await fs.appendFile(p, failure.slice(0, 30));
    expect((await m.read(p))?.status).toBe('running');
    await fs.appendFile(p, failure.slice(30)); expect((await m.read(p))?.status).toBe('failed');
    await fs.appendFile(p, record('task_started', 'turn2') + record('task_complete', 'turn1', capacity));
    expect(await m.read(p)).toMatchObject({ turnId: 'turn2', status: 'running' });
    await fs.appendFile(p, record('task_complete', 'turn2')); expect((await m.read(p))?.status).toBe('completed');
  });

  it('handles giant tool records, unrelated error text, and file truncation', async () => {
    const p = await file(); const m = new CodexRunMonitor();
    await fs.writeFile(p, JSON.stringify({ type: 'response_item', payload: { text: 'server_overloaded '.repeat(100_000) } }) + '\n' + record('task_started'));
    expect((await m.read(p))?.status).toBe('running');
    await fs.writeFile(p, record('task_complete', 'other', capacity));
    expect(await m.read(p)).toMatchObject({ turnId: 'other', status: 'failed' });
  });

  it('observes a managed transcript failure without a conversation-page poll and cancels through the real input path', async () => {
    const p = await file(); await fs.writeFile(p, record('task_started'));
    const db = new AppDatabase(path.join(path.dirname(p), 'test.sqlite'));
    const tmux = new FakeTmux(); const events = new RealtimeEventBus();
    const adapter = { ...provider, createRunMonitor: () => new CodexProvider().createRunMonitor() };
    const manager = createRecoveryManager(db, tmux, path.dirname(p), events, adapter);
    db.conversationIndex.replace('demo', 'codex', [{ ref: 'c1', kind: 'history', projectSlug: 'demo', provider: 'codex', title: 'Recovery', updatedAt: new Date().toISOString(), transcriptPath: p, isBound: false, degraded: false }]);
    try {
      const session = await manager.bindConversation({ project, provider: adapter, providerSettings, conversationRef: 'c1', title: 'Recovery', kind: 'history' });
      await fs.appendFile(p, record('task_complete', 'turn1', capacity));
      const deadline = Date.now() + 4000;
      while (!db.boundSessions.getById(session.id)?.runFailure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(db.boundSessions.getById(session.id)).toMatchObject({ isWorking: false, runFailure: { status: 'scheduled', message: capacity.message } });
      await manager.sendKeystrokes(session.id, { keys: ['Escape'] });
      expect(db.boundSessions.getById(session.id)?.runFailure?.status).toBe('stopped');
      expect(tmux.sent).toEqual([]);
    } finally { await manager.stop(); db.close(); }
  });
  it('submits one automatic continuation through the owned Codex tmux session', async () => {
    const p = await file(); await fs.writeFile(p, record('task_started'));
    const db = new AppDatabase(path.join(path.dirname(p), 'test.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\nSelected model is at capacity.\ngpt-5.4 medium · 98% left · ~/demo';
    const adapter = { ...provider, createRunMonitor: () => new CodexProvider().createRunMonitor() };
    const manager = createRecoveryManager(db, tmux, path.dirname(p), new RealtimeEventBus(), adapter);
    db.conversationIndex.replace('demo', 'codex', [{ ref: 'c1', kind: 'history', projectSlug: 'demo', provider: 'codex', title: 'Recovery', updatedAt: new Date().toISOString(), transcriptPath: p, isBound: false, degraded: false }]);
    try {
      const session = await manager.bindConversation({ project, provider: adapter, providerSettings, conversationRef: 'c1', title: 'Recovery', kind: 'history' });
      await fs.appendFile(p, record('task_complete', 'turn1', capacity));
      const deadline = Date.now() + 20_000;
      while (!tmux.sent.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      expect(tmux.sent.join('')).toContain('Automatic recovery after a transient provider capacity failure');
      expect(tmux.sentKeys.filter(keys => keys.includes('Enter'))).toHaveLength(1);
      expect(db.boundSessions.getById(session.id)?.runFailure).toMatchObject({ attempts: 1, status: 'retrying' });
      await fs.appendFile(p, record('task_started', 'retry1') + record('task_complete', 'retry1'));
      const completionDeadline = Date.now() + 3000;
      while (db.boundSessions.getById(session.id)?.runFailure && Date.now() < completionDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(db.boundSessions.getById(session.id)?.runFailure).toBeUndefined();
    } finally { await manager.stop(); db.close(); }
  }, 25_000);

});
