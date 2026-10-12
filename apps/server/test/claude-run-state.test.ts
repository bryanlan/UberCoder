import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeRunMonitor } from '../src/providers/transcripts/claude-run-state.js';
import { parseClaudeConversationFile } from '../src/providers/transcripts/claude.js';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { createRecoveryManager, enableUnattendedRecovery, FakeTmux, project, providerSettings } from './helpers/session-fixtures.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
const prompt = { type: 'user', uuid: 'turn1', timestamp: new Date().toISOString(), message: { content: 'Continue the assignment.' } };
const failure = (text: string, extra = {}) => ({ type: 'assistant', uuid: 'failure', timestamp: new Date().toISOString(),
  isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text }], stop_reason: 'stop_sequence' }, ...extra });
const line = (r: unknown) => JSON.stringify(r) + '\n';
async function file(records: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-run-state-')); paths.push(dir);
  const p = path.join(dir, 'transcript.jsonl'); await fs.writeFile(p, records.map(line).join('')); return p;
}

describe('Claude authoritative failed turns', () => {
  it.each([['529 Overloaded', 'server_overloaded'], ['500 Internal server error', 'server_unavailable']])
    ('detects native %s and preserves visible failure history', async (message, code) => {
      const p = await file([prompt, failure(`API Error: ${message}`)]);
      expect(await new ClaudeRunMonitor().read(p)).toMatchObject({ turnId: 'turn1', status: 'failed', error: { code } });
      const transcript = await parseClaudeConversationFile({ filePath: p, provider: 'claude', projectSlug: 'demo', conversationRef: 'c1' });
      expect(transcript.displayMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'status', text: `Run stopped: API Error: ${message}` })]));
    });

  it.each([
    ['ordinary prose', { isApiErrorMessage: false }, 'API Error: 529 Overloaded', 'running'],
    ['background child', { isSidechain: true }, 'API Error: 529 Overloaded', 'running'],
    ['authentication', {}, 'Failed to refresh OAuth token', 'failed'],
    ['quota', { error: 'rate_limit' }, "You've hit your session limit", 'failed'],
  ])('does not classify %s as transient capacity', async (_name, extra, text, status) => {
    const p = await file([prompt, failure(text, extra)]); const run = await new ClaudeRunMonitor().read(p);
    expect(run?.status).toBe(status); expect(run?.error?.code).not.toBe('server_overloaded'); expect(run?.error?.code).not.toBe('server_unavailable');
  });

  it('starts a new turn after the failed turn and ignores child failures', async () => {
    const p = await file([prompt, failure('API Error: 529 Overloaded')]); const m = new ClaudeRunMonitor();
    expect((await m.read(p))?.status).toBe('failed');
    await fs.appendFile(p, line({ ...prompt, uuid: 'turn2' }) + line(failure('API Error: 529 Overloaded', { isSidechain: true })));
    expect(await m.read(p)).toMatchObject({ turnId: 'turn2', status: 'running' });
  });

  it('emits native task notification once without treating it as a human prompt', async () => {
    const p = await file([prompt, { type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn' } }]);
    const m = new ClaudeRunMonitor(); const root = await m.read(p);
    const native = { type: 'user', uuid: 'notification-1', timestamp: new Date().toISOString(),
      message: { content: '<task-notification>\n<task-id>child-1</task-id>\n<status>completed</status>\n<result>Finished</result>\n</task-notification>' } };
    await fs.appendFile(p, line(native)); expect(await m.read(p)).toEqual(root);
    expect(m.takeChildActivity()).toEqual([{ id: 'notification-1', childId: 'child-1', timestamp: native.timestamp, kind: 'completed' }]);
    await m.read(p); expect(m.takeChildActivity()).toEqual([]);
    await fs.appendFile(p, line({ ...native, type: 'assistant' }) + line({ ...native, isSidechain: true }));
    await m.read(p); expect(m.takeChildActivity()).toEqual([]);
  });

  it('automatically continues an owned Claude session after the bounded capacity delay', async () => {
    const p = await file([prompt]); const db = new AppDatabase(path.join(path.dirname(p), 'test.sqlite'));
    const tmux = new FakeTmux(); tmux.paneText = 'Claude Code\nAPI Error: 529 Overloaded\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)';
    const adapter = new ClaudeProvider(); const settings = { ...providerSettings, id: 'claude' as const };
    const manager = createRecoveryManager(db, tmux, path.dirname(p), new RealtimeEventBus(), adapter, settings);
    db.conversationIndex.replace('demo', 'claude', [{ ref: 'c1', kind: 'history', projectSlug: 'demo', provider: 'claude', title: 'Recovery', updatedAt: new Date().toISOString(), transcriptPath: p, isBound: false, degraded: false }]);
    try {
      enableUnattendedRecovery(db, adapter.id, 'c1');
      const session = await manager.bindConversation({ project, provider: adapter, providerSettings: settings, conversationRef: 'c1', title: 'Recovery', kind: 'history' });
      await fs.appendFile(p, line(failure('API Error: 529 Overloaded')));
      await expect.poll(() => tmux.sent.join(''), { timeout: 20_000 }).toContain('Automatic recovery after a transient provider failure');
      expect(tmux.sentKeys.filter(keys => keys.includes('Enter'))).toHaveLength(1);
      expect(db.boundSessions.getById(session.id)?.runFailure).toMatchObject({ attempts: 1, status: 'retrying' });
      expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('Provider recovery scheduled');
    } finally { await manager.stop(); db.close(); }
  }, 25_000);

  it('never sends Enter when Stop arrives during automatic text entry', async () => {
    const p = await file([prompt]); const db = new AppDatabase(path.join(path.dirname(p), 'test.sqlite'));
    const tmux = new FakeTmux(); tmux.paneText = 'Claude Code\nAPI Error: 529 Overloaded\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)';
    const adapter = new ClaudeProvider(); const settings = { ...providerSettings, id: 'claude' as const };
    const manager = createRecoveryManager(db, tmux, path.dirname(p), new RealtimeEventBus(), adapter, settings);
    db.conversationIndex.replace('demo', 'claude', [{ ref: 'c1', kind: 'history', projectSlug: 'demo', provider: 'claude', title: 'Recovery', updatedAt: new Date().toISOString(), transcriptPath: p, isBound: false, degraded: false }]);
    let stopCommand: Promise<unknown> | undefined;
    try {
      enableUnattendedRecovery(db, adapter.id, 'c1');
      const session = await manager.bindConversation({ project, provider: adapter, providerSettings: settings, conversationRef: 'c1', title: 'Recovery', kind: 'history' });
      let stopped = false;
      const stop = () => {
        if (!stopped) { stopped = true; stopCommand = manager.sendKeystrokes(session.id, { keys: ['Escape'] }); }
      };
      const literal = tmux.sendLiteralText.bind(tmux); const paste = tmux.pasteText.bind(tmux);
      tmux.sendLiteralText = async (...args) => { await literal(...args); stop(); };
      tmux.pasteText = async (...args) => { await paste(...args); stop(); };
      await fs.appendFile(p, line(failure('API Error: 529 Overloaded')));
      await expect.poll(() => stopped, { timeout: 20_000 }).toBe(true);
      await expect.poll(() => db.boundSessions.getById(session.id)?.runFailure?.status).toBe('stopped');
      expect(tmux.sentKeys.some(keys => keys.includes('Enter'))).toBe(false);
      expect(db.boundSessions.getById(session.id)?.runFailure?.stoppedReason).toContain('cancelled by user');
    } finally { await stopCommand; await manager.stop(); db.close(); }
  }, 25_000);

  it('protects paused sessions, input waits, native drafts, ownership and memory limits', async () => {
    const checks = await Promise.allSettled(['manual_pause', 'pressure_pause', 'low_memory', 'draft', 'approval', 'ownership'].map(async (guard) => {
      const p = await file([prompt]); const db = new AppDatabase(path.join(path.dirname(p), 'test.sqlite'));
      const tmux = new FakeTmux(); tmux.paneText = 'Claude Code\nAPI Error: 529 Overloaded\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)';
      const adapter = new ClaudeProvider(); const settings = { ...providerSettings, id: 'claude' as const };
      const manager = createRecoveryManager(db, tmux, path.dirname(p), new RealtimeEventBus(), adapter, settings,
        guard === 'low_memory' ? { pressureSuspendAvailableBytes: 1024 * 1024, readMemInfo: () => 'MemAvailable: 100 kB' } : {});
      db.conversationIndex.replace('demo', 'claude', [{ ref: 'c1', kind: 'history', projectSlug: 'demo', provider: 'claude', title: 'Recovery', updatedAt: new Date().toISOString(), transcriptPath: p, isBound: false, degraded: false }]);
      try {
        enableUnattendedRecovery(db, adapter.id, 'c1');
      const session = await manager.bindConversation({ project, provider: adapter, providerSettings: settings, conversationRef: 'c1', title: 'Recovery', kind: 'history' });
        await fs.appendFile(p, line(failure('API Error: 529 Overloaded')));
        await expect.poll(() => db.boundSessions.getById(session.id)?.runFailure?.status, { timeout: 2000, message: `${guard} observes failure` }).toBe('scheduled');
        if (guard === 'manual_pause') db.boundSessions.setManualSuspendedAt(session.id, new Date().toISOString());
        if (guard === 'pressure_pause') db.boundSessions.setPressureSuspendedAt(session.id, new Date().toISOString());
        if (guard === 'draft') tmux.paneText = tmux.paneText.replace('❯ ', '❯ KEEP_UNSENT');
        if (guard === 'approval') tmux.paneText = 'Claude Code\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel\n⏵⏵ bypass permissions on';
        if (guard === 'ownership') await tmux.setOption(session.tmuxSessionName, '@agent_console_session_id', 'another-session');
        const screen = tmux.paneText;
        await expect.poll(() => db.boundSessions.getById(session.id)?.runFailure?.status, { timeout: 20_000, message: `${guard} stops recovery` }).toBe('stopped');
        expect(tmux.sent).toEqual([]); expect(tmux.sentKeys).toEqual([]); expect(tmux.paneText).toBe(screen);
        expect(db.boundSessions.getById(session.id)?.runFailure?.attempts).toBe(0);
      } finally { await manager.stop(); db.close(); }
    }));
    for (const result of checks) if (result.status === 'rejected') throw result.reason;
  }, 25_000);
});
