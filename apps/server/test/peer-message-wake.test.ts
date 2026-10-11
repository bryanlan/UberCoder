import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { PEER_WAKE_PROMPT, peerWakeAttemptKey } from '../src/coordination/wake.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { parseCodexConversationFile } from '../src/providers/transcripts/codex.js';
import { parseClaudeConversationFile } from '../src/providers/transcripts/claude.js';
import { dispatchCoordination } from '../src/coordination/transport.js';
import type { ProviderRunState } from '../src/providers/types.js';
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

async function fixture(id: 'codex' | 'claude' = 'codex', options: Parameters<typeof createRecoveryManager>[6] = {}, tmux = new FakeTmux(), run?: ProviderRunState, settings = providerSettings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-wake-'));
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const selected = { ...(id === 'codex' ? provider : claudeProvider), ...(run ? { createRunMonitor: () => ({ read: async () => run }) } : {}) };
  tmux.paneText = id === 'codex' ? codexReady : claudeReady;
  const manager = createRecoveryManager(db, tmux, root, new RealtimeEventBus(), selected, settings,
    { queueCodexNotice: async () => { tmux.sent.push(PEER_WAKE_PROMPT); }, ...options });
  const service = new CoordinationService(db, { enabled: true, pilotPaths: [] }, () => { void manager.wakePendingPeerMessages(); });
  const native = randomUUID();
  const token = randomUUID();
  const recipient = service.register({ provider: id, nativeSessionId: native, token, pid: process.pid, cwd: root }).assignmentId!;
  const sender = service.register({ provider: 'claude', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: root }).assignmentId!;
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

function backdate(db: AppDatabase, sessionId: string, minutes: number) {
  const timestamp = new Date(Date.now() - minutes * 60_000).toISOString();
  db.sqlite.prepare(`update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, is_working=0 where id=?`)
    .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, sessionId);
}

describe('Peer message wake and one-hour sleep', () => {
  it.each(['codex', 'claude'] as const)('wakes idle %s once and delivers authenticated peer data separately from user input', async (id) => {
    const f = await fixture(id);
    const message = f.send();
    await Promise.all([f.manager.wakePendingPeerMessages(), f.manager.wakePendingPeerMessages()]);
    expect(f.tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
    expect(f.tmux.sentKeys).toEqual(id === 'codex' ? [] : [['Enter']]);
    expect(f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(true);
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
    await f.manager.wakePendingPeerMessages();
    const count = f.tmux.sent.length;
    expect(count).toBeGreaterThan(0);
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent).toHaveLength(count);
    f.service.send(f.sender, first);
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent).toHaveLength(count);
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent).toHaveLength(count * 2);
  });

  it.each(['codex', 'claude'] as const)('defers working %s recipients until completion', async (id) => {
    const f = await fixture(id);
    f.db.boundSessions.upsert({ ...f.session, isWorking: true });
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent).toEqual([]);
    f.db.boundSessions.upsert({ ...f.session, isWorking: false });
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
  });

  it.each([
    'OpenAI Codex\nApproval required\n❯ 1. Yes\n  2. No\nPress enter to confirm or esc to go back\ngpt-6.1-sol xhigh',
    'OpenAI Codex\n› \nWorking (Esc to interrupt)\ngpt-6.1-sol xhigh',
    'OpenAI Codex\n› \nTab to queue message\ngpt-6.1-sol xhigh',
  ])('does not submit during an approval, working or queued-input screen', async (screen) => {
    const f = await fixture();
    f.tmux.paneText = screen;
    const message = f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.db.meta.get(peerWakeAttemptKey(message.id))).toBeUndefined();
    expect(f.tmux.paneText).toBe(screen);
    f.tmux.paneText = codexReady;
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
  });

  it('uses the Codex queue while preserving an unsent native draft', async () => {
    const f = await fixture();
    f.tmux.paneText = codexReady.replace('› Ask Codex to do anything', '› UNSENT_DRAFT');
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.tmux.paneText).toContain('UNSENT_DRAFT');
  });

  it('defers Claude wake while an unsent native draft is present', async () => {
    const f = await fixture('claude');
    f.tmux.paneText = claudeReady.replace('❯ ', '❯ UNSENT_DRAFT');
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
    f.tmux.paneText = claudeReady;
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
  });

  it('preserves manual suspension and defers wake under low memory', async () => {
    let available = 100;
    const f = await fixture('codex', { pressureSuspendAvailableBytes: 1024 * 1024, readMemInfo: () => `MemAvailable: ${available} kB` });
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent).toEqual([]);
    available = 2048;
    f.db.boundSessions.setManualSuspendedAt(f.session.id, new Date().toISOString());
    f.tmux.alive.clear();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.created).toHaveLength(1);
    expect(f.tmux.sent).toEqual([]);
  });

  it('resumes automatically suspended recipients in the original conversation after memory recovers', async () => {
    const f = await fixture('codex', { pressureSuspendAvailableBytes: 1024 * 1024, readMemInfo: () => 'MemAvailable: 2048 kB' });
    f.db.boundSessions.setPressureSuspendedAt(f.session.id, new Date().toISOString());
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    f.tmux.alive.clear();
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.created).toEqual([f.session.tmuxSessionName, f.session.tmuxSessionName]);
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ conversationRef: f.session.conversationRef, pressureSuspendedAt: undefined, isWorking: true });
    expect(f.tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
  });

  it('never launches a second writer when the original provider survives outside the tmux binding', async () => {
    const f = await fixture();
    f.tmux.alive.clear();
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.created).toHaveLength(1);
    expect(f.tmux.sent).toEqual([]);
  });

  it('does not replay an ambiguous submission after a backend restart', async () => {
    class FailingTmux extends FakeTmux {
      override async sendKeys(): Promise<void> { throw new Error('input outcome unknown'); }
    }
    const f = await fixture('claude', {}, new FailingTmux());
    const message = f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.service.send(f.sender, message)).toMatchObject({ delivery: 'wake_blocked' });
    const count = f.tmux.sent.length;
    await f.manager.stop();
    const restarted = createRecoveryManager(f.db, f.tmux, f.root);
    await restarted.wakePendingPeerMessages();
    expect(f.tmux.sent).toHaveLength(count);
    await restarted.stop();
  });

  it('reports a rejected Codex queue without typing into the composer or retrying input', async () => {
    const f = await fixture('codex', { queueCodexNotice: async () => { throw new Error('native queue unavailable'); } });
    const message = f.send();
    await f.manager.wakePendingPeerMessages();
    expect(f.service.send(f.sender, message)).toMatchObject({ delivery: 'wake_blocked', note: expect.stringContaining('native queue unavailable') });
    await f.manager.wakePendingPeerMessages();
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it.each(['codex', 'claude'] as const)('settles a rejected %s wake so new messages can wake and ordinary idle sleep remains available', async (id) => {
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
      tmux.sent.push(PEER_WAKE_PROMPT);
    } }, tmux, run);
    const rejectedMessage = f.send();
    await f.manager.wakePendingPeerMessages();
    await f.manager.getSessionScreen(f.session.id);
    expect(f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(false);
    expect(f.db.meta.get(peerWakeAttemptKey(rejectedMessage.id))).toContain('failed');
    backdate(f.db, f.session.id, 61);
    await f.manager.reconcileSessions();
    expect(tmux.alive.has(f.session.tmuxSessionName)).toBe(false);
    f.db.sqlite.prepare('update coordination_assignments set pid=2147483647 where id=?').run(f.recipient);
    reject = false;
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
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
    await f.manager.wakePendingPeerMessages();
    expect(tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
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
    await f.manager.wakePendingPeerMessages();
    expect(f.service.send(f.sender, first).delivery).toBe('wake_blocked');
    expect(tmux.sentKeys).toEqual([['Enter']]);
    await f.manager.stop();
    const restarted = createRecoveryManager(f.db, tmux, f.root, new RealtimeEventBus(), claudeProvider);
    try {
      const second = f.send();
      await restarted.wakePendingPeerMessages();
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
    await f.manager.wakePendingPeerMessages();
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
    const wake = f.manager.wakePendingPeerMessages();
    await checking;
    const stopping = f.manager.stop();
    release();
    await Promise.all([wake, stopping]);
    expect(tmux.sentKeys).toEqual([]);
    expect(f.db.meta.get(peerWakeAttemptKey(message.id))).toBeUndefined();
    tmux.pauseCheckAt = 0;
    const restarted = createRecoveryManager(f.db, tmux, f.root, new RealtimeEventBus(), claudeProvider);
    try {
      await restarted.wakePendingPeerMessages();
      expect(tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
      expect(f.service.send(f.sender, message).delivery).toBe('wake_started');
    } finally { await restarted.stop(); }
  });

  it.each([1, 2])('retries transient pre-input resume ownership read %i without consuming its message', async (checkNumber) => {
    class TransientChoiceTmux extends FakeTmux {
      failReadAt = 0;
      checkCount = 0;
      override async getPanePid(): Promise<number | undefined> {
        if (this.failReadAt && ++this.checkCount === this.failReadAt) { this.failReadAt = 0; throw new Error('temporary tmux read failure'); }
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
    await f.manager.wakePendingPeerMessages();
    expect(tmux.sentKeys).toEqual([]);
    expect(f.db.meta.get(peerWakeAttemptKey(message.id))).toBeUndefined();
    await f.manager.wakePendingPeerMessages();
    expect(tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
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
    await f.manager.wakePendingPeerMessages();
    expect(tmux.sent.join('')).toBe(PEER_WAKE_PROMPT);
  });

  it('passes the merged project provider settings to the Codex queue transport', async () => {
    const settings = { ...providerSettings, commands: { ...providerSettings.commands,
      resumeCommand: ['/project/codex', 'resume', '{{conversationId}}'], env: { CODEX_HOME: '/project/state' } } };
    const received: unknown[][] = [];
    const f = await fixture('codex', { queueCodexNotice: async (...args) => { received.push(args); } }, new FakeTmux(), undefined, settings);
    f.send();
    await f.manager.wakePendingPeerMessages();
    expect(received).toEqual([[f.session.conversationRef, settings, project.path]]);
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
    await f.manager.wakePendingPeerMessages();
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
    const records = ['Original human request', PEER_WAKE_PROMPT, 'Useful answer'].map((text, index) => {
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
