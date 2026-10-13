import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { UNATTENDED_CONTINUATION_PROMPT, peerWakeAttemptKey, peerWakeFollowupKey, peerWakeRestoreKey } from '../src/coordination/wake.js';
import { continuationControl, prepareContinuation, saveContinuation, signalContinuation } from '../src/coordination/continuation.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { parseCodexConversationFile } from '../src/providers/transcripts/codex.js';
import { parseClaudeConversationFile } from '../src/providers/transcripts/claude.js';
import { dispatchCoordination } from '../src/coordination/transport.js';
import type { ProviderChildActivity, ProviderRunState } from '../src/providers/types.js';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

const codexReady = 'OpenAI Codex\n\nCompleted response.\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 98% left · ~/demo';
const claudeReady = 'Claude Code\nOpus 5.5 · Claude Max\n❯ \n  bypass permissions on (shift+tab to cycle)';
const claudeResumeChoice = ['Claude Code', 'This session is 22h 53m old and 423.3k tokens.',
  'Resuming the full session will consume a substantial portion of your usage limits.',
  'We recommend resuming from a summary.', '❯ 1. Resume from summary (recommended)',
  '  2. Resume full session as-is', "  3. Don't ask me again", 'Enter to confirm · Esc to cancel',
  '⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(id: 'codex' | 'claude' = 'codex', options: Parameters<typeof createRecoveryManager>[6] = {}, tmux = new FakeTmux(), run?: ProviderRunState, settings = providerSettings, children: ProviderChildActivity[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-wake-'));
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const selected = { ...(id === 'codex' ? provider : claudeProvider), ...(run ? { createRunMonitor: () => ({ read: async () => run, takeChildActivity: () => children.splice(0) }) } : {}) };
  tmux.paneText = id === 'codex' ? codexReady : claudeReady;
  const paste = tmux.pasteText.bind(tmux), keys = tmux.sendKeys.bind(tmux);
  tmux.pasteText = async (name, text) => { await paste(name, text); if (id === 'claude') tmux.paneText = tmux.paneText.replace('❯ ', '❯ ' + text); };
  tmux.sendKeys = async (name, input) => { await keys(name, input); if (id === 'claude' && input.includes('Enter')) tmux.paneText = claudeReady; };
  const manager = createRecoveryManager(db, tmux, root, new RealtimeEventBus(), selected, settings,
    { queueCodexNotice: async () => { tmux.sent.push(UNATTENDED_CONTINUATION_PROMPT); }, ...options });
  const service = new CoordinationService(db, { enabled: true, pilotPaths: [] }, () => { void manager.wakePendingAssignments(); });
  const native = randomUUID();
  const token = randomUUID();
  const recipient = service.register({ provider: id, nativeSessionId: native, token, pid: process.pid, cwd: root }).assignmentId!;
  const sender = service.register({ provider: 'claude', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: root }).assignmentId!;
  service.update(recipient, { continuation: 'unattended' });
  if (run) {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '{}\n');
    db.conversationIndex.replace(project.slug, id, [{ ref: native, kind: 'history', projectSlug: project.slug, provider: id,
      title: 'Existing task', updatedAt: new Date().toISOString(), transcriptPath, isBound: false, degraded: false }]);
  }
  const session = await manager.bindConversation({ project, provider: selected, providerSettings: settings, conversationRef: native, title: 'Existing task', kind: 'history' });
  const send = () => {
    const message = { id: randomUUID(), recipientId: recipient, text: 'Please answer the existing assignment question.' };
    service.send(sender, message);
    return message;
  };
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, tmux, manager, service, recipient, sender, session, send, token };
}

function continuationDue(db: AppDatabase, recipient: string) {
  const control = continuationControl(db, recipient);
  if (control.recovery) { control.recovery.nextAttemptAt = new Date(Date.now() - 1).toISOString(); saveContinuation(db, recipient, control); }
}

function backdate(db: AppDatabase, sessionId: string, minutes: number) {
  const timestamp = new Date(Date.now() - minutes * 60_000).toISOString();
  db.sqlite.prepare(`update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, is_working=0 where id=?`)
    .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, sessionId);
}

describe('Peer message wake and one-hour sleep', () => {
  it.each(['codex', 'claude'] as const)('permits one %s follow-up after completion and never a third automatic turn, even after restart', async (id) => {
    const f = await fixture(id);
    const message = f.send();
    await f.manager.wakePendingAssignments();
    const original = JSON.parse(f.db.meta.get(peerWakeAttemptKey(message.id))!);
    const initialAt = new Date(Date.now() - 120_000).toISOString();
    f.db.meta.set(peerWakeAttemptKey(message.id), JSON.stringify({ ...original, timestamp: initialAt }));
    const initialRecord = f.db.meta.get(peerWakeAttemptKey(message.id));
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false,
      lastCompletedAt: new Date(Date.now() - 30_000).toISOString() });
    continuationDue(f.db, f.recipient);
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT.repeat(2));
    expect(JSON.parse(f.db.meta.get(peerWakeFollowupKey(message.id))!)).toMatchObject({ status: 'submitted', sessionId: f.session.id });
    expect(f.db.meta.get(peerWakeAttemptKey(message.id))).toBe(initialRecord);
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false, lastCompletedAt: new Date().toISOString() });
    await f.manager.stop();
    const restarted = createRecoveryManager(f.db, f.tmux, f.root, new RealtimeEventBus(), id === 'claude' ? claudeProvider : provider);
    try { await restarted.wakePendingAssignments(); expect(f.tmux.sent).toHaveLength(2); }
    finally { await restarted.stop(); }
  });

  it.each(['too_recent', 'not_completed', 'offered_recently', 'acknowledged', 'failed', 'submitting', 'working', 'approval', 'manual_pause'] as const)
    ('defers or suppresses follow-up when %s', async (guard) => {
      const f = await fixture(); const message = f.send(); await f.manager.wakePendingAssignments();
      const original = JSON.parse(f.db.meta.get(peerWakeAttemptKey(message.id))!);
      f.db.meta.set(peerWakeAttemptKey(message.id), JSON.stringify({ ...original,
        timestamp: new Date(Date.now() - (guard === 'too_recent' ? 1000 : 120_000)).toISOString(),
        status: guard === 'failed' || guard === 'submitting' ? guard : 'submitted' }));
      f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: guard === 'working',
        lastCompletedAt: guard === 'not_completed' ? new Date(Date.now() - 150_000).toISOString() : new Date().toISOString() });
      if (guard === 'offered_recently') f.service.poll(f.recipient, 0);
      if (guard === 'acknowledged') { f.service.poll(f.recipient, 0); f.service.acknowledge(f.recipient, [message.id]); }
      if (guard === 'manual_pause') f.db.boundSessions.setManualSuspendedAt(f.session.id, new Date().toISOString());
      if (guard === 'approval') f.tmux.paneText = 'OpenAI Codex\nApproval required\n❯ 1. Yes\n  2. No\nPress enter to confirm or esc to go back\ngpt-6.1-sol xhigh';
      await f.manager.wakePendingAssignments();
      expect(f.tmux.sent).toHaveLength(1);
      expect(f.db.meta.get(peerWakeFollowupKey(message.id))).toBeUndefined();
    });
  it.each(['codex', 'claude'] as const)('wakes idle %s once and delivers authenticated peer data separately from user input', async (id) => {
    const f = await fixture(id);
    const message = f.send();
    await Promise.all([f.manager.wakePendingAssignments(), f.manager.wakePendingAssignments()]);
    expect(f.tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
    expect(f.tmux.sentKeys).toEqual(id === 'codex' ? [] : [['Enter']]);
    expect(f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(true);
    expect(JSON.parse(f.db.meta.get(peerWakeAttemptKey(message.id))!)).toMatchObject({ restoration: 'already_loaded' });
    expect(fs.readFileSync(f.session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');
    expect(f.service.send(f.sender, message)).toMatchObject({ delivery: 'wake_started', queued: true });
    const inbox = await dispatchCoordination(f.service, { action: 'poll', assignmentId: f.recipient, token: f.token });
    expect(inbox).toMatchObject({ messages: [{ id: message.id, text: message.text }] });
    f.service.acknowledge(f.recipient, [message.id]);
    expect(f.service.send(f.sender, message).delivery).toBe('acknowledged');
    await expect(dispatchCoordination(f.service, { action: 'poll', assignmentId: f.recipient, token: 'x'.repeat(32) })).rejects.toThrow('credential');
  });

  it('coalesces new messages and wakes again only for new IDs after the current response ends', async () => {
    const f = await fixture();
    const first = f.send();
    f.send();
    await f.manager.wakePendingAssignments();
    const count = f.tmux.sent.length;
    expect(count).toBeGreaterThan(0);
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toHaveLength(count);
    f.service.send(f.sender, first);
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toHaveLength(count);
    f.send();
    continuationDue(f.db, f.recipient);
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toHaveLength(count * 2);
  });

  it.each(['codex', 'claude'] as const)('defers working %s recipients until completion', async (id) => {
    const f = await fixture(id);
    f.db.boundSessions.upsert({ ...f.session, isWorking: true });
    f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toEqual([]);
    f.db.boundSessions.upsert({ ...f.session, isWorking: false });
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
  });

  it.each([
    'OpenAI Codex\nApproval required\n❯ 1. Yes\n  2. No\nPress enter to confirm or esc to go back\ngpt-6.1-sol xhigh',
    'OpenAI Codex\n› \nWorking (Esc to interrupt)\ngpt-6.1-sol xhigh',
    'OpenAI Codex\n› \nTab to queue message\ngpt-6.1-sol xhigh',
  ])('does not submit during an approval, working or queued-input screen', async (screen) => {
    const f = await fixture();
    f.tmux.paneText = screen;
    const message = f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.db.meta.get(peerWakeAttemptKey(message.id))).toBeUndefined();
    expect(f.tmux.paneText).toBe(screen);
    f.tmux.paneText = codexReady;
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
  });

  it('defers the Codex queue while preserving an unsent native draft', async () => {
    const f = await fixture();
    f.tmux.paneText = codexReady.replace('› Ask Codex to do anything', '› UNSENT_DRAFT');
    f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.tmux.paneText).toContain('UNSENT_DRAFT');
  });

  it('defers Claude wake while an unsent native draft is present', async () => {
    const f = await fixture('claude');
    f.tmux.paneText = claudeReady.replace('❯ ', '❯ UNSENT_DRAFT');
    f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
    f.tmux.paneText = claudeReady;
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
  });

  it('preserves manual suspension and defers wake under low memory', async () => {
    let available = 100;
    const f = await fixture('codex', { pressureSuspendAvailableBytes: 1024 * 1024, readMemInfo: () => `MemAvailable: ${available} kB` });
    f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toEqual([]);
    available = 2048;
    f.db.boundSessions.setManualSuspendedAt(f.session.id, new Date().toISOString());
    f.tmux.alive.clear();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.created).toHaveLength(1);
    expect(f.tmux.sent).toEqual([]);
  });

  it('resumes automatically suspended recipients in the original conversation after memory recovers', async () => {
    const f = await fixture('codex', { pressureSuspendAvailableBytes: 1024 * 1024, readMemInfo: () => 'MemAvailable: 2048 kB' });
    f.db.boundSessions.setPressureSuspendedAt(f.session.id, new Date().toISOString());
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    f.tmux.alive.clear();
    const message = f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.created).toEqual([f.session.tmuxSessionName, f.session.tmuxSessionName]);
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ conversationRef: f.session.conversationRef, pressureSuspendedAt: undefined, isWorking: true });
    expect(f.tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
    expect(JSON.parse(f.db.meta.get(peerWakeAttemptKey(message.id))!)).toMatchObject({ restoration: 'restored' });
  });

  it('retains cold-restore measurement across provider startup deferral and consumes it after the first wake', async () => {
    const f = await fixture('claude');
    f.db.boundSessions.upsert({ ...f.session, startedAt: new Date(Date.now() - 120 * 60_000).toISOString(),
      lastResponseAt: new Date(Date.now() - 60 * 60_000).toISOString(), pid: undefined });
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    f.tmux.alive.clear(); f.tmux.paneText = 'Starting Claude';
    const first = f.send();
    await f.manager.wakePendingAssignments();
    expect(f.db.meta.get(peerWakeAttemptKey(first.id))).toBeUndefined();
    f.tmux.paneText = claudeReady;
    await f.manager.wakePendingAssignments();
    expect(JSON.parse(f.db.meta.get(peerWakeAttemptKey(first.id))!)).toMatchObject({ restoration: 'restored' });
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    const next = f.send();
    continuationDue(f.db, f.recipient);
    await f.manager.wakePendingAssignments();
    expect(JSON.parse(f.db.meta.get(peerWakeAttemptKey(next.id))!)).toMatchObject({ restoration: 'already_loaded' });
  });

  it('records a warm wake if the restored process completed another response during startup deferral', async () => {
    const f = await fixture('claude');
    f.db.boundSessions.upsert({ ...f.session, pid: undefined });
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    f.tmux.alive.clear(); f.tmux.paneText = 'Starting Claude';
    const message = f.send();
    await f.manager.wakePendingAssignments();
    const restore = JSON.parse(f.db.meta.get(peerWakeRestoreKey(f.session.id))!) as { restoredAt: string };
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false,
      lastResponseAt: new Date(Date.parse(restore.restoredAt) + 1).toISOString() });
    f.tmux.paneText = claudeReady;
    await f.manager.wakePendingAssignments();
    expect(JSON.parse(f.db.meta.get(peerWakeAttemptKey(message.id))!)).toMatchObject({ restoration: 'already_loaded' });
  });

  it('never launches a second writer when the original provider survives outside the tmux binding', async () => {
    const f = await fixture();
    f.tmux.alive.clear();
    f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.created).toHaveLength(1);
    expect(f.tmux.sent).toEqual([]);
  });

  it('routes an unexpected process exit through durable backoff even with a queued peer message', async () => {
    const f = await fixture();
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    f.tmux.alive.clear(); const message = f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.created).toHaveLength(1);
    expect(f.tmux.sent).toEqual([]);
    expect(f.db.boundSessions.getById(f.session.id)?.runFailure).toMatchObject({ code: 'process_exited', status: 'scheduled', attempts: 0 });
    expect(f.db.meta.get(peerWakeAttemptKey(message.id))).toBeUndefined();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.created).toHaveLength(1);
  });

  it('does not replay an ambiguous submission after a backend restart', async () => {
    class FailingTmux extends FakeTmux {
      override async sendKeys(): Promise<void> { throw new Error('input outcome unknown'); }
    }
    const f = await fixture('claude', {}, new FailingTmux());
    const message = f.send();
    await f.manager.wakePendingAssignments();
    expect(f.service.send(f.sender, message)).toMatchObject({ delivery: 'wake_blocked' });
    const count = f.tmux.sent.length;
    await f.manager.stop();
    const restarted = createRecoveryManager(f.db, f.tmux, f.root);
    await restarted.wakePendingAssignments();
    expect(f.tmux.sent).toHaveLength(count);
    await restarted.stop();
  });

  it('reports a rejected Codex queue without typing into the composer or retrying input', async () => {
    const f = await fixture('codex', { queueCodexNotice: async () => { throw new Error('native queue unavailable'); } });
    const message = f.send();
    await f.manager.wakePendingAssignments();
    expect(f.service.send(f.sender, message)).toMatchObject({ delivery: 'wake_blocked', note: expect.stringContaining('native queue unavailable') });
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it.each(['codex', 'claude'] as const)('settles a rejected %s wake and requires explicit reauthorization before new messages can wake', async (id) => {
    let reject = true;
    class RejectingTmux extends FakeTmux {
      override async pasteText(sessionName: string, text: string): Promise<void> {
        if (reject) throw new Error('input was not delivered');
        await super.pasteText(sessionName, text);
      }
    }
    const run: ProviderRunState = { turnId: 'prior-completed-turn', status: 'completed', timestamp: new Date(Date.now() - 130 * 60_000).toISOString() };
    const tmux = new RejectingTmux();
    const f = await fixture(id, { queueCodexNotice: async () => {
      if (reject) throw new Error('native queue unavailable');
      tmux.sent.push(UNATTENDED_CONTINUATION_PROMPT);
    } }, tmux, run);
    const rejectedMessage = f.send();
    await f.manager.wakePendingAssignments();
    await f.manager.getSessionScreen(f.session.id);
    expect(f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(false);
    expect(f.db.meta.get(peerWakeAttemptKey(rejectedMessage.id))).toContain('failed');
    backdate(f.db, f.session.id, 61);
    await f.manager.reconcileSessions();
    expect(tmux.alive.has(f.session.tmuxSessionName)).toBe(false);
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    reject = false;
    f.send();
    await f.manager.wakePendingAssignments();
    expect(tmux.sent).toEqual([]);
    f.service.update(f.recipient, { continuation: 'unattended' });
    await f.manager.wakePendingAssignments();
    expect(tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
    expect(f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(true);
  });

  it('sleeps a ready registered assignment without needing another turn to mark it waiting', async () => {
    const f = await fixture();
    expect(f.db.sqlite.prepare('select status from coordination_assignments where id=?').get(f.recipient)).toEqual({ status: 'active' });
    backdate(f.db, f.session.id, 61);
    await f.manager.reconcileSessions();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(false);
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(f.db.sqlite.prepare('select status from coordination_assignments where id=?').get(f.recipient)).toEqual({ status: 'active' });
  });

  it('restores an old Claude conversation through its full-session choice before waking it', async () => {
    class ResumeChoiceTmux extends FakeTmux {
      override async newDetachedSession(name: string, cwd: string, command: string): Promise<void> {
        await super.newDetachedSession(name, cwd, command);
        if (this.created.length > 1) this.paneText = claudeResumeChoice;
      }
      override async sendKeys(name: string, keys: string[]): Promise<void> {
        await super.sendKeys(name, keys);
        if (keys.includes('Down') && this.paneText === claudeResumeChoice) {
          this.paneText = claudeResumeChoice.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
        } else if (keys.includes('Enter') && this.paneText.includes('❯ 2. Resume full session as-is')) {
          this.paneText = claudeReady;
        }
      }
    }
    const tmux = new ResumeChoiceTmux();
    const f = await fixture('claude', {}, tmux);
    backdate(f.db, f.session.id, 61);
    await f.manager.reconcileSessions();
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    const message = f.send();
    await f.manager.wakePendingAssignments();
    expect(tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
    expect(tmux.sentKeys).toEqual([['Down'], ['Enter'], ['Enter']]);
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ conversationRef: f.session.conversationRef, isWorking: true });
    expect(f.service.send(f.sender, message).delivery).toBe('wake_started');
    expect(fs.readFileSync(f.session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');
  });

  it('lets an unanswered native Claude resume choice sleep after the idle deadline', async () => {
    const f = await fixture('claude');
    f.tmux.paneText = claudeResumeChoice;
    backdate(f.db, f.session.id, 61);
    await f.manager.reconcileSessions();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(false);
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it('does not replay an ambiguous Claude resume confirmation after a restart or a new message', async () => {
    class AmbiguousChoiceTmux extends FakeTmux {
      override async sendKeys(name: string, keys: string[]): Promise<void> {
        await super.sendKeys(name, keys);
        if (keys.includes('Enter')) throw new Error('Resume confirmation outcome unknown');
      }
    }
    const tmux = new AmbiguousChoiceTmux();
    const f = await fixture('claude', {}, tmux);
    tmux.paneText = claudeResumeChoice.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
    const first = f.send();
    await f.manager.wakePendingAssignments();
    expect(f.service.send(f.sender, first).delivery).toBe('wake_blocked');
    expect(tmux.sentKeys).toEqual([['Enter']]);
    await f.manager.stop();
    const restarted = createRecoveryManager(f.db, tmux, f.root, new RealtimeEventBus(), claudeProvider);
    try {
      const second = f.send();
      await restarted.wakePendingAssignments();
      expect(tmux.sentKeys).toEqual([['Enter']]);
      expect(tmux.sent).toEqual([]);
      expect(f.service.send(f.sender, second).delivery).toBe('wake_blocked');
    } finally { await restarted.stop(); }
  });

  it('does not confirm a Claude resume choice when native pane ownership changes', async () => {
    class ChangedPaneTmux extends FakeTmux {
      override async getPanePid(): Promise<number | undefined> {
        return this.sentKeys.length ? 4243 : 4242;
      }
      override async sendKeys(name: string, keys: string[]): Promise<void> {
        await super.sendKeys(name, keys);
        if (keys.includes('Down')) this.paneText = claudeResumeChoice.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
      }
    }
    const tmux = new ChangedPaneTmux();
    const f = await fixture('claude', {}, tmux);
    tmux.paneText = claudeResumeChoice;
    const message = f.send();
    await f.manager.wakePendingAssignments();
    expect(tmux.sentKeys).toEqual([['Down']]);
    expect(tmux.sent).toEqual([]);
    expect(f.service.send(f.sender, message)).toMatchObject({ delivery: 'wake_blocked', note: expect.stringContaining('ownership') });
  });

  it.each([1, 2])('defers without consuming messages when shutdown interrupts pre-input resume check %i', async (checkNumber) => {
    let entered!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    class ShutdownChoiceTmux extends FakeTmux {
      pauseCheckAt = 0;
      checkCount = 0;
      keysAtError: string[][] | undefined;
      override async getPanePid(): Promise<number | undefined> {
        if (this.pauseCheckAt && ++this.checkCount === this.pauseCheckAt) { entered(); await released; }
        return 4242;
      }
      override async sendKeys(name: string, keys: string[]): Promise<void> {
        await super.sendKeys(name, keys);
        if (keys.includes('Enter')) this.paneText = claudeReady;
      }
    }
    const tmux = new ShutdownChoiceTmux();
    const f = await fixture('claude', {}, tmux);
    tmux.paneText = claudeResumeChoice.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
    tmux.pauseCheckAt = checkNumber;
    const message = f.send();
    const wake = f.manager.wakePendingAssignments();
    await checking;
    const stopping = f.manager.stop();
    release();
    await Promise.all([wake, stopping]);
    expect(tmux.sentKeys).toEqual([]);
    expect(f.db.meta.get(peerWakeAttemptKey(message.id))).toBeUndefined();
    tmux.pauseCheckAt = 0;
    const restarted = createRecoveryManager(f.db, tmux, f.root, new RealtimeEventBus(), claudeProvider);
    try {
      await restarted.wakePendingAssignments();
      expect(tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
      expect(f.service.send(f.sender, message).delivery).toBe('wake_started');
    } finally { await restarted.stop(); }
  });

  it.each([1, 2])('retries transient pre-input resume ownership read %i without consuming its message', async (checkNumber) => {
    class TransientChoiceTmux extends FakeTmux {
      failReadAt = 0;
      checkCount = 0;
      keysAtError: string[][] | undefined;
      override async getPanePid(): Promise<number | undefined> {
        if (this.failReadAt && ++this.checkCount === this.failReadAt) { this.keysAtError = this.sentKeys.slice(); this.failReadAt = 0; throw new Error('temporary tmux read failure'); }
        return 4242;
      }
      override async sendKeys(name: string, keys: string[]): Promise<void> {
        await super.sendKeys(name, keys);
        if (keys.includes('Enter')) this.paneText = claudeReady;
      }
    }
    const tmux = new TransientChoiceTmux();
    const f = await fixture('claude', {}, tmux);
    tmux.paneText = claudeResumeChoice.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
    tmux.failReadAt = checkNumber;
    const message = f.send();
    await f.manager.wakePendingAssignments();
    expect(tmux.keysAtError).toEqual([]);
    await f.manager.wakePendingAssignments();
    expect(tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
    expect(f.service.send(f.sender, message).delivery).toBe('wake_started');
  });

  it('recognizes a native Claude resume choice even when the cached turn flag is stale', async () => {
    class ReadyAfterChoiceTmux extends FakeTmux {
      override async sendKeys(name: string, keys: string[]): Promise<void> {
        await super.sendKeys(name, keys);
        if (keys.includes('Enter')) this.paneText = claudeReady;
      }
    }
    const run: ProviderRunState = { turnId: 'prior-completed-turn', status: 'completed', timestamp: new Date(Date.now() - 130 * 60_000).toISOString() };
    const tmux = new ReadyAfterChoiceTmux();
    const f = await fixture('claude', {}, tmux, run);
    tmux.paneText = claudeResumeChoice.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: true });
    f.send();
    await f.manager.wakePendingAssignments();
    expect(tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
  });

  it('passes the merged project provider settings to the Codex queue transport', async () => {
    const settings = { ...providerSettings, commands: { ...providerSettings.commands,
      resumeCommand: ['/project/codex', 'resume', '{{conversationId}}'], env: { CODEX_HOME: '/project/state' } } };
    const received: unknown[][] = [];
    const f = await fixture('codex', { queueCodexNotice: async (...args) => { received.push(args); } }, new FakeTmux(), undefined, settings);
    f.send();
    await f.manager.wakePendingAssignments();
    expect(received).toEqual([[f.session.conversationRef, settings, project.path, UNATTENDED_CONTINUATION_PROMPT]]);
  });

  it('reattaches output monitoring after restart when background work prevents idle sleep', async () => {
    const f = await fixture();
    await f.manager.stop();
    f.tmux.paneText = codexReady.replace('Completed response.', 'Completed response.\n1 background terminal running · /ps to view · /stop to close');
    backdate(f.db, f.session.id, 61);
    f.db.sqlite.prepare("update bound_sessions set status='error' where id=?").run(f.session.id);
    const piped = f.tmux.pipedToFiles.length;
    const restarted = createRecoveryManager(f.db, f.tmux, f.root);
    try {
      await restarted.reconcileSessions();
      expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
      expect(f.db.boundSessions.getById(f.session.id)?.status).toBe('bound');
      expect(f.tmux.pipedToFiles.length).toBeGreaterThan(piped);
    } finally { await restarted.stop(); }
  });

  it.each(['codex', 'claude'] as const)('keeps %s background work loaded until its native indicator clears', async (id) => {
    const f = await fixture(id);
    // Captured from Codex 0.162.1 and Claude Code 2.1.296 with real sleep tasks.
    f.tmux.paneText = id === 'codex'
      ? codexReady.replace('› Ask Codex', '1 background terminal running · /ps to view · /stop to close\n› Ask Codex')
      : claudeReady.replace('bypass permissions on (shift+tab to cycle)', '⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage');
    backdate(f.db, f.session.id, 61);
    await f.manager.reconcileSessions();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
    f.tmux.paneText = id === 'codex' ? codexReady : claudeReady;
    await f.manager.reconcileSessions();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(false);
  });

  it('keeps an idle session loaded for an hour, sleeps it, and wakes it for a new message', async () => {
    const f = await fixture();
    backdate(f.db, f.session.id, 59);
    await f.manager.reconcileSessions();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
    backdate(f.db, f.session.id, 61);
    await f.manager.reconcileSessions();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(false);
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    f.send();
    await f.manager.wakePendingAssignments();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    await f.manager.reconcileSessions();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
  });

  it('does not sleep an old session with an unsent draft', async () => {
    const f = await fixture();
    f.tmux.paneText = codexReady.replace('› Ask Codex to do anything', '› KEEP_DRAFT');
    backdate(f.db, f.session.id, 120);
    await f.manager.reconcileSessions();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
  });

  it.each(['codex', 'claude'] as const)('classifies the %s wake notice as coordination, preserving the real user prompt and reply', async (id) => {
    const f = await fixture(id);
    const records = ['Original human request', UNATTENDED_CONTINUATION_PROMPT, 'Useful answer'].map((text, index) => {
      const role = index === 2 ? 'assistant' : 'user';
      const timestamp = new Date(Date.now() + index * 1000).toISOString();
      return id === 'codex'
        ? { type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }
        : { type: role, timestamp, message: { role, content: [{ type: 'text', text }] } };
    });
    const filePath = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n'));
    const parsed = await (id === 'codex' ? parseCodexConversationFile : parseClaudeConversationFile)({ filePath, provider: id, projectSlug: project.slug, conversationRef: f.session.conversationRef });
    expect(parsed.messages[1]).toMatchObject({ role: 'status', statusKind: 'coordination' });
    expect(parsed.displayMessages.map((message) => message.text)).toEqual(['Original human request', 'Useful answer']);
    expect(parsed.summary.title).toBe('Original human request');
    expect(parsed.summary.rawMetadata?.firstUserTextHash).toBe(parsed.summary.rawMetadata?.lastUserTextHash);
  });
});

// These tests exercise the backend command queue and real guarded transports;
// only provider lifecycle facts, tmux and the scheduling clock are controlled.
describe('Unattended assignment continuation', () => {
  const done = (): ProviderRunState => ({ turnId: 'root', status: 'completed', timestamp: new Date().toISOString() });
  function due(f: Awaited<ReturnType<typeof fixture>>) {
    const control = continuationControl(f.db, f.recipient);
    control.recovery!.nextAttemptAt = new Date(Date.now() - 1).toISOString();
    saveContinuation(f.db, f.recipient, control);
  }
  function completed(f: Awaited<ReturnType<typeof fixture>>, run: ProviderRunState) {
    run.timestamp = new Date().toISOString();
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false,
      lastCompletedAt: run.timestamp, lastResponseAt: run.timestamp });
  }

  it.each(['codex', 'claude'] as const)('continues %s after a native child result without needing a peer send', async id => {
    const children: ProviderChildActivity[] = [], run = done();
    const f = await fixture(id, {}, new FakeTmux(), run, providerSettings, children);
    await f.manager.wakePendingAssignments();
    children.push({ id: 'native-result', childId: 'worker', kind: 'completed', timestamp: new Date().toISOString() });
    fs.appendFileSync(path.join(f.root, 'transcript.jsonl'), '{}\n');
    await expect.poll(() => continuationControl(f.db, f.recipient).seenSignals).toContain('native-child:native-result');
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toEqual([]);
    due(f); await f.manager.wakePendingAssignments();
    expect(continuationControl(f.db, f.recipient).seenSignals).toContain('native-child:native-result');
    expect(f.tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
    expect(continuationControl(f.db, f.recipient).signals).toEqual([]);
  });

  it('schedules a silent idle lead, honors backoff and caps attempts through new worker facts and restart', async () => {
    const run = done(); const f = await fixture('codex', {}, new FakeTmux(), run);
    f.service.update(f.sender, { continuation: 'unattended' });
    f.service.update(f.recipient, { supervisorId: f.sender });
    const control = continuationControl(f.db, f.recipient);
    control.enabledAt = new Date(Date.now() - 6 * 60_000).toISOString(); saveContinuation(f.db, f.recipient, control);
    backdate(f.db, f.session.id, 6);
    await f.manager.wakePendingAssignments();
    expect(continuationControl(f.db, f.recipient).recovery).toMatchObject({ status: 'scheduled', attempts: 0 });
    expect(f.tmux.sent).toEqual([]);
    for (let i = 1; i <= 3; i++) {
      due(f); await f.manager.wakePendingAssignments(); expect(f.tmux.sent).toHaveLength(i);
      completed(f, run);
      signalContinuation(f.db, f.recipient, { key: `new-worker:${i}`, source: 'worker', timestamp: run.timestamp, reason: 'New result' });
      f.send(); await f.manager.wakePendingAssignments();
      expect(f.tmux.sent).toHaveLength(i); // new facts cannot bypass backoff or the cap
    }
    expect(continuationControl(f.db, f.recipient).recovery).toMatchObject({ status: 'stalled', attempts: 3 });
    expect(continuationControl(f.db, f.sender).signals).toEqual([expect.objectContaining({ source: f.recipient, reason: expect.stringContaining('exhausted') })]);
    await f.manager.wakePendingAssignments();
    expect(continuationControl(f.db, f.sender).signals).toHaveLength(1);
    await f.manager.stop();
    const restarted = createRecoveryManager(f.db, f.tmux, f.root);
    try { await restarted.wakePendingAssignments(); expect(f.tmux.sent).toHaveLength(3); }
    finally { await restarted.stop(); }
  });

  it.each(['waiting_for_input', 'disabled', 'finished'] as const)('never wakes a %s assignment', async guard => {
    const f = await fixture('codex', guard === 'disabled' ? { coordinationEnabled: false } : {});
    if (guard === 'waiting_for_input') f.service.update(f.recipient, { continuation: guard });
    if (guard === 'finished') f.service.finish(f.recipient, 'Complete');
    if (guard !== 'finished') f.send();
    await f.manager.wakePendingAssignments(); expect(f.tmux.sent).toEqual([]);
  });

  it('leaves a Claude continuation unsent when Stop arrives during paste', async () => {
    const f = await fixture('claude'); const paste = f.tmux.pasteText.bind(f.tmux);
    let stop: Promise<unknown> | undefined;
    f.tmux.pasteText = async (...args) => { await paste(...args); stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] }); };
    f.send(); await f.manager.wakePendingAssignments(); await stop;
    expect(f.tmux.sentKeys.some(keys => keys.includes('Enter'))).toBe(false);
    expect(continuationControl(f.db, f.recipient).continuation).toBe('waiting_for_input');
    await f.manager.wakePendingAssignments(); expect(f.tmux.sent).toHaveLength(1);
  });

  it('rechecks pause after the asynchronous ownership read immediately before Enter', async () => {
    const f = await fixture('claude'); const read = f.tmux.getOption.bind(f.tmux);
    f.tmux.getOption = async (...args) => {
      const value = await read(...args);
      if (f.tmux.paneText.includes(UNATTENDED_CONTINUATION_PROMPT)) f.service.update(f.recipient, { continuation: 'waiting_for_input' });
      return value;
    };
    f.send(); await f.manager.wakePendingAssignments();
    expect(f.tmux.sentKeys.some(keys => keys.includes('Enter'))).toBe(false);
    expect(continuationControl(f.db, f.recipient).continuation).toBe('waiting_for_input');
  });

  it('never submits unrelated text that appears in the composer during paste', async () => {
    const f = await fixture('claude'); const paste = f.tmux.pasteText.bind(f.tmux);
    f.tmux.pasteText = async (...args) => { await paste(...args); f.tmux.paneText = claudeReady.replace('❯ ', '❯ HUMAN_DRAFT'); };
    f.send(); await f.manager.wakePendingAssignments();
    expect(f.tmux.sentKeys.some(keys => keys.includes('Enter'))).toBe(false);
    expect(f.tmux.paneText).toContain('HUMAN_DRAFT');
    expect(continuationControl(f.db, f.recipient).recovery?.status).toBe('blocked');
  });

  it('keeps a late wake request that arrives after the current inbox selection', async () => {
    const run = done(); let finishQueue!: () => void, entering!: () => void;
    const queued = new Promise<void>(resolve => { entering = resolve; });
    const release = new Promise<void>(resolve => { finishQueue = resolve; });
    let calls = 0;
    const tmux = new FakeTmux();
    const f = await fixture('codex', { queueCodexNotice: async (_id, _settings, _cwd, prompt) => {
      tmux.sent.push(prompt); if (++calls === 1) { entering(); await release; }
    } }, tmux, run);
    const first = f.send(); await queued;
    const second = f.send();
    finishQueue(); await f.manager.wakePendingAssignments();
    expect(f.db.meta.get(peerWakeAttemptKey(first.id))).toBeTruthy();
    expect(f.db.meta.get(peerWakeAttemptKey(second.id))).toBeUndefined();
    completed(f, run); due(f);
    // Native completion itself requests a drain. No third send is needed.
    f.service.update(f.recipient, { status: 'waiting' });
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toHaveLength(2);
    expect(f.db.meta.get(peerWakeAttemptKey(second.id))).toBeTruthy();
  });

  it('restores the original conversation without treating its historical running turn as live work', async () => {
    const run: ProviderRunState = { turnId: 'before-death', status: 'running', timestamp: new Date(Date.now() - 3600_000).toISOString() };
    const f = await fixture('codex', {}, new FakeTmux(), run);
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false, pid: undefined });
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    f.tmux.alive.clear(); f.send(); await f.manager.wakePendingAssignments();
    expect(f.tmux.created).toHaveLength(2);
    expect(f.tmux.sent.join('')).toBe(UNATTENDED_CONTINUATION_PROMPT);
  });

  it('blocks lack of provider acknowledgement after 30 seconds rather than replaying', async () => {
    const f = await fixture(); f.send(); await f.manager.wakePendingAssignments();
    const control = continuationControl(f.db, f.recipient);
    control.recovery!.startedAt = new Date(Date.now() - 31_000).toISOString(); saveContinuation(f.db, f.recipient, control);
    f.send(); await f.manager.wakePendingAssignments();
    expect(continuationControl(f.db, f.recipient).recovery?.status).toBe('blocked');
    expect(f.tmux.sent).toHaveLength(1);
  });
});
