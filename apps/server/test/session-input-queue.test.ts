import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { InputQueue } from '../src/sessions/input-queue.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';
import { PEER_WAKE_PROMPT, peerWakeComposerKey } from '../src/coordination/wake.js';
import { createRecoveryManager, enableUnattendedRecovery, FakeTmux, project, provider, claudeProvider, providerSettings } from './helpers/session-fixtures.js';

const ready = (text = '') => `OpenAI Codex\n\n› ${text}\n  gpt-6.1-sol xhigh · 65% left · ~/demo`;
const busy = 'OpenAI Codex\n\n• Working (1s • esc to interrupt)\n› \n  gpt-6.1-sol xhigh · 65% left · ~/demo';
const unavailable = 'OpenAI Codex\n\n• Working (1s • esc to interrupt)';
const approval = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend';

class InputTmux extends FakeTmux {
  acceptText = true;
  failEnter = false;
  acceptEnter = true;
  clearInput = true;
  pid = 4241;
  onText?: () => Promise<void>;
  onEnter?: () => Promise<void>;
  constructor() { super(); this.paneText = ready(); }
  override async newDetachedSession(name: string, cwd: string, command: string): Promise<void> {
    await super.newDetachedSession(name, cwd, command);
    this.pid++;
    this.paneText = ready();
  }
  override async getPanePid(): Promise<number> { return this.pid; }
  override async sendLiteralText(_name: string, text: string): Promise<void> {
    this.sent.push(text);
    if (this.acceptText) this.paneText = ready((this.paneText.match(/^› ?(.*)$/m)?.[1] ?? '') + text);
    await this.onText?.();
  }
  override async pasteText(name: string, text: string): Promise<void> {
    this.pasted.push(text);
    await this.sendLiteralText(name, text);
  }
  override async sendKeys(name: string, keys: string[]): Promise<void> {
    await super.sendKeys(name, keys);
    if (this.clearInput && keys.includes('C-c') && /^› ?\S/m.test(this.paneText)) this.paneText = ready();
    if (keys.includes('Enter')) {
      await this.onEnter?.();
      this.paneText = this.acceptEnter ? busy : this.paneText.replace(/\\(?=\n)/, '');
      if (this.failEnter) throw new Error('transport disconnected after Enter');
    }
  }
}

/** Claude consumes a leading typed question mark as its shortcuts toggle. */
class QuestionShortcutTmux extends InputTmux {
  override async sendLiteralText(name: string, text: string): Promise<void> {
    await super.sendLiteralText(name, text.startsWith('?') ? text.slice(1) : text);
  }
  override async pasteText(name: string, text: string): Promise<void> {
    this.pasted.push(text);
    await super.sendLiteralText(name, text);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(providerId: 'codex' | 'claude' = 'codex', recovery = false, tmux = new InputTmux(), nativeRunning = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'console-input-queue-'));
  const databasePath = path.join(directory, 'console.sqlite');
  let db = new AppDatabase(databasePath);
  const eventBus = new RealtimeEventBus();
  const runtimeDir = path.join(directory, 'runtime');
  const adapter = { ...(providerId === 'codex' ? provider : claudeProvider),
    ...(nativeRunning ? { createRunMonitor: () => ({ read: async () => ({
      turnId: 'active-turn', timestamp: new Date().toISOString(), status: 'running' as const,
    }) }) } : {}),
  };
  if (nativeRunning) {
    const transcriptPath = path.join(directory, 'native.jsonl');
    await fs.writeFile(transcriptPath, '');
    db.conversationIndex.upsert({ ref: 'native-queue-test', kind: 'history', provider: providerId,
      projectSlug: project.slug, title: 'Active turn', updatedAt: new Date().toISOString(),
      transcriptPath, isBound: false, degraded: false });
  }
  const createManager = () => recovery || nativeRunning ? createRecoveryManager(db, tmux, runtimeDir, eventBus,
    adapter, { ...providerSettings, id: providerId })
    : new SessionManager(db, tmux, runtimeDir, eventBus);
  let manager = createManager();
  const session = await manager.bindConversation({ project, provider: providerId === 'codex' ? provider : claudeProvider,
    providerSettings: { ...providerSettings, id: providerId }, conversationRef: 'native-queue-test', title: 'Queue', kind: 'history' });
  cleanups.push(async () => { await manager.stop(); db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, tmux, eventBus, session, get manager() { return manager; },
    restart: async () => { await manager.stop(); db.close(); db = new AppDatabase(databasePath); manager = createManager(); },
    submit: (text: string, submissionId = randomUUID()) => manager.sendKeystrokes(session.id, { text, submittedText: text, keys: ['Enter'], submissionId }) };
}

describe('durable human input queue', () => {
  it('rejects a cancelled native menu choice even after preflight removes its submission ID', async () => {
    const f = await fixture();
    const revision = new InputQueue(f.db.sqlite).revision(f.session.id);
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    await expect(f.manager.sendKeystrokes(f.session.id, { text: '1', submittedText: '1', keys: ['Enter'] }, revision))
      .rejects.toThrow('cancelled by a later Stop');
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([['Escape']]);
    // An explicit interrupt remains available even when its snapshot is old.
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] }, revision);
    expect(f.tmux.sentKeys).toEqual([['Escape'], ['Escape']]);
  });
  it.each(['codex', 'claude'] as const)('waits for the %s Stop repaint before clearing an unchanged mixed draft', async providerId => {
    const f = await fixture(providerId);
    const text = 'mixed old native prefix';
    f.tmux.paneText = ready(text);
    await f.submit('blocked message');
    const sendKeys = f.tmux.sendKeys.bind(f.tmux);
    vi.spyOn(f.tmux, 'sendKeys').mockImplementation(async (name, keys) => {
      await sendKeys(name, keys);
      if (keys.includes('Escape')) f.tmux.captureSequence = [busy.replace('› ', `› ${text}`), ready(text)];
    });
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(f.tmux.sentKeys).toEqual([['Escape'], ['C-c']]);
    expect((await f.submit('next explicit message')).recordedUserInput?.text).toBe('next explicit message');
    expect(f.tmux.sent).toEqual(['next explicit message']);
  });

  it('preserves a native draft changed during the Stop repaint wait', async () => {
    const f = await fixture();
    const sendKeys = f.tmux.sendKeys.bind(f.tmux);
    vi.spyOn(f.tmux, 'sendKeys').mockImplementation(async (name, keys) => {
      await sendKeys(name, keys);
      if (keys.includes('Escape')) f.tmux.captureSequence = [busy.replace('› ', '› old draft'), ready('new human draft')];
    });
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(f.tmux.sentKeys).toEqual([['Escape']]);
    expect(f.tmux.paneText).toContain('new human draft');
  });

  it.each(['working', 'ready'] as const)('clears Claude\'s interrupted prompt restored after an initially %s empty composer', async repaint => {
    const f = await fixture('claude');
    const original = 'how is progress I just woke up';
    await f.submit(original);
    f.tmux.paneText = '✢ Thinking…\n────────────────\n❯ \n────────────────\n  ⏵⏵ bypass permissions on · esc to interrupt';
    const sendKeys = f.tmux.sendKeys.bind(f.tmux);
    vi.spyOn(f.tmux, 'sendKeys').mockImplementation(async (name, keys) => {
      await sendKeys(name, keys);
      if (keys.includes('Escape')) f.tmux.captureSequence = [repaint === 'working' ? busy : ready(), ready(original)];
    });
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(f.tmux.sentKeys).toEqual([['Enter'], ['Escape'], ['C-c']]);
    expect((await f.submit('the next question')).recordedUserInput?.text).toBe('the next question');
    expect(f.tmux.sent).toEqual([original, 'the next question']);
    expect(f.db.boundSessions.getById(f.session.id)?.pid).toBe(f.session.pid);
  });

  it.each(['different draft', 'edited original'] as const)('preserves a %s appearing after Claude Stop', async change => {
    const f = await fixture('claude');
    const original = 'already submitted';
    await f.submit(original);
    f.tmux.paneText = '✢ Thinking…\n────────────────\n❯ \n────────────────\n  ⏵⏵ bypass permissions on · esc to interrupt';
    const changed = change === 'edited original' ? original + ', with new edits' : 'a new human draft';
    const sendKeys = f.tmux.sendKeys.bind(f.tmux);
    vi.spyOn(f.tmux, 'sendKeys').mockImplementation(async (name, keys) => {
      await sendKeys(name, keys);
      if (keys.includes('Escape')) f.tmux.captureSequence = [busy, ready(changed)];
    });
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(f.tmux.sentKeys).toEqual([['Enter'], ['Escape']]);
    expect(f.tmux.paneText).toContain(changed);
  });

  it.each(['new native input', 'still working', 'empty composer'] as const)('does not clear Claude\'s restored prompt across %s', async guard => {
    const f = await fixture('claude');
    const original = 'already submitted';
    await f.submit(original);
    f.tmux.paneText = '✢ Thinking…\n────────────────\n❯ \n────────────────\n  ⏵⏵ bypass permissions on · esc to interrupt';
    const sendKeys = f.tmux.sendKeys.bind(f.tmux);
    vi.spyOn(f.tmux, 'sendKeys').mockImplementation(async (name, keys) => {
      await sendKeys(name, keys);
      if (!keys.includes('Escape')) return;
      f.tmux.paneText = guard === 'empty composer' ? ready()
        : guard === 'still working' ? `✢ Thinking…\n────────────────\n❯ ${original}\n────────────────\n  ⏵⏵ bypass permissions on · esc to interrupt` : ready(original);
      if (guard === 'new native input') new InputQueue(f.db.sqlite).invalidateNativeInput(f.session.id);
    });
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(f.tmux.sentKeys).toEqual([['Enter'], ['Escape']]);
  });

  it.each(['native-selection', 'images', 'pending-project'] as const)('cancels an HTTP send held in %s preflight before Stop', async phase => {
    const f = await fixture();
    if (phase === 'pending-project') {
      const ref = 'pending:cancelled-first-turn';
      f.db.boundSessions.upsert({ ...f.session, conversationRef: ref });
      f.db.pendingConversations.put({ ref, kind: 'pending', projectSlug: project.slug, provider: 'codex',
        title: 'Pending', createdAt: f.session.startedAt, updatedAt: f.session.updatedAt,
        isBound: true, boundSessionId: f.session.id, degraded: false, rawMetadata: { pending: true } });
    }
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    const hold = async () => { if (first) { first = false; entered(); await held; } };
    if (phase === 'native-selection') {
      const allows = f.manager.allowsLiteralSelectionKeystroke.bind(f.manager);
      vi.spyOn(f.manager, 'allowsLiteralSelectionKeystroke').mockImplementation(async (...args) => {
        await hold(); return allows(...args);
      });
    }
    const app = fastify();
    await registerSessionRoutes(app, { ensureAuthenticated: async () => undefined } as never, f.db,
      { getProjectBySlug: async () => { await hold(); return project; },
        getMergedProviderSettings: () => providerSettings } as never,
      { get: () => provider } as never, f.manager,
      { resolve: async () => { await hold(); return []; } } as never);
    const payload = { text: 'abandoned request', submittedText: 'abandoned request', keys: ['Enter'], submissionId: randomUUID(),
      ...(phase === 'images' ? { imageIds: [randomUUID()] } : {}) };
    const send = () => app.inject({ method: 'POST', url: `/api/sessions/${f.session.id}/keys`, payload });
    const pending = send().then(response => response);
    try {
      await started;
      expect((await app.inject({ method: 'POST', url: `/api/sessions/${f.session.id}/keys`, payload: { keys: ['Escape'] } })).statusCode).toBe(200);
      release();
      expect((await pending).statusCode).toBe(409);
      expect(f.tmux.sent).toEqual([]);
      expect(f.tmux.sentKeys).toEqual([['Escape']]);
      expect(JSON.parse(f.db.meta.get(`session-input:${f.session.id}:${payload.submissionId}`)!).state).toBe('cancelled');
      expect((await send()).statusCode).toBe(200);
      expect(f.tmux.sent).toEqual([]);
      expect((await f.submit('next explicit message')).recordedUserInput?.text).toBe('next explicit message');
      expect(f.tmux.sent).toEqual(['next explicit message']);
      expect(f.tmux.created).toHaveLength(1);
    } finally { release(); await pending; await app.close(); }
  });

  it.each(['Stop', 'cancel'] as const)('keeps cancellation terminal when an expired paste capture races %s', async action => {
    const f = await fixture();
    const queue = new InputQueue(f.db.sqlite), requestId = randomUUID();
    const text = 'an unconfirmed message';
    queue.put(f.session.id, { requestId, text, state: 'awaiting_input', reason: 'Waiting for input.',
      baselineInput: '', panePid: f.session.pid!, nativeRevision: queue.revision(f.session.id),
      requestedAt: f.session.startedAt, typedAt: new Date(Date.now() - 31_000).toISOString() });
    f.tmux.paneText = ready('unrecognized native paste');
    let cancelled: Promise<unknown> | undefined;
    const capture = f.tmux.capturePane.bind(f.tmux);
    vi.spyOn(f.tmux, 'capturePane').mockImplementationOnce(async () => {
      const screen = await capture();
      cancelled = action === 'Stop' ? f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] })
        : f.manager.cancelQueuedInput(f.session.id, requestId);
      return screen;
    });
    await f.submit(text, requestId);
    await cancelled;
    expect(queue.get(f.session.id, requestId)?.state).toBe('cancelled');
    expect(queue.list(f.session.id)).toEqual([]);
    if (action === 'Stop') expect((await f.submit('next explicit message')).recordedUserInput?.text).toBe('next explicit message');
    else expect(f.tmux.paneText).toContain('unrecognized native paste');
  });

  it.each(['codex', 'claude'] as const)('Escape clears an abandoned %s native draft and allows the next message once', async providerId => {
    const f = await fixture(providerId);
    f.tmux.paneText = ready('an older draft that does not match the queued message');
    const id = randomUUID();
    expect((await f.submit('the blocked message', id)).queuedInput?.state).toBe('queued');
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(f.tmux.paneText).toBe(ready());
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
    const next = randomUUID();
    expect((await f.submit('the next message', next)).recordedUserInput?.text).toBe('the next message');
    await f.submit('the next message', next);
    expect(f.tmux.sent).toEqual(['the next message']);
    expect(f.tmux.sentKeys).toEqual([['Escape'], ['C-c'], ['Escape'], ['Enter']]);
    expect(f.db.boundSessions.getById(f.session.id)?.pid).toBe(f.session.pid);
  });

  it('Escape cancels reviewable sends without leaving a queue barrier', async () => {
    const f = await fixture();
    f.tmux.acceptEnter = false;
    const id = randomUUID();
    expect((await f.submit('not accepted', id)).queuedInput?.state).toBe('needs_review');
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    f.tmux.acceptEnter = true;
    expect((await f.submit('fresh message')).recordedUserInput?.text).toBe('fresh message');
    await f.submit('not accepted', id);
    expect(f.tmux.sent.filter(text => text === 'not accepted')).toHaveLength(1);
  });

  it.each(['draft', 'owner'] as const)('does not clear a %s that changes during Stop ownership checks', async changed => {
    const f = await fixture();
    f.tmux.paneText = ready('old native text');
    const getOption = f.tmux.getOption.bind(f.tmux);
    vi.spyOn(f.tmux, 'getOption').mockImplementation(async (name, option) => {
      const value = await getOption(name, option);
      if (option !== '@agent_console_session_id' || !f.tmux.sentKeys.some(keys => keys.includes('Escape'))) return value;
      if (changed === 'draft') f.tmux.paneText = ready('a new human draft');
      return changed === 'owner' ? 'another binding' : value;
    });
    await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(f.tmux.sentKeys).toEqual([['Escape']]);
    expect(f.tmux.paneText).toContain(changed === 'draft' ? 'a new human draft' : 'old native text');
  });

  it.each([false, true])('Stop during Enter releases the queue without replaying ambiguous input (transport failure %s)', async failEnter => {
    const f = await fixture();
    const id = randomUUID();
    let stop: Promise<unknown> | undefined;
    f.tmux.failEnter = failEnter;
    f.tmux.onEnter = async () => {
      f.tmux.onEnter = undefined;
      stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    };
    await f.submit('possibly submitted', id);
    await stop;
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
    f.tmux.failEnter = false;
    f.tmux.paneText = ready();
    expect((await f.submit('new explicit message')).recordedUserInput?.text).toBe('new explicit message');
    await f.submit('possibly submitted', id);
    expect(f.tmux.sent.filter(text => text === 'possibly submitted')).toHaveLength(1);
  });

  it.each(['codex', 'claude'] as const)('does not report %s delivery or replay Enter when the message remains in the composer', async providerId => {
    const f = await fixture(providerId);
    f.tmux.acceptEnter = false;
    const id = randomUUID();
    const result = await f.submit('a message ending in \\', id);
    expect(result.recordedUserInput).toBeUndefined();
    expect(result.queuedInput?.state).toBe('needs_review');
    expect(f.tmux.paneText).toContain('a message ending in');
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
    await f.restart();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs?.[0]?.state).toBe('needs_review');
  });

  it('Stop cancels a human send that has not yet acquired the session command lock', async () => {
    const f = await fixture();
    let release!: () => void;
    let captured!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { captured = resolve; });
    const capture = f.tmux.capturePane.bind(f.tmux);
    vi.spyOn(f.tmux, 'capturePane').mockImplementationOnce(async () => {
      captured();
      await blocked;
      return capture();
    });
    const earlier = f.manager.sendKeystrokes(f.session.id, { keys: ['Left'] });
    await started;
    const requestId = randomUUID();
    const pending = f.submit('must not arrive after Stop', requestId);
    const cancelled = expect(pending).rejects.toThrow('cancelled by a later Stop');
    const stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    release();
    await Promise.all([earlier, cancelled, stop]);
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([['Left'], ['Escape']]);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
    // Retrying the same request ID cannot resurrect the cancelled request.
    await f.submit('must not arrive after Stop', requestId);
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([['Left'], ['Escape']]);
  });

  it.each(['codex', 'claude'] as const)('hands %s human follow-ups to the running native turn once and in order', async (providerId) => {
    const f = await fixture(providerId, false, new InputTmux(), true);
    const active = (text = '') => providerId === 'codex'
      ? busy.replace('› ', `› ${text}`)
      : `Claude Code\n✻ Thinking… (1s · esc to interrupt)\n────────────────────\n❯ ${text}\n────────────────────\n⏵⏵ bypass permissions on`;
    f.tmux.paneText = active();
    f.db.boundSessions.upsert({ ...f.session, isWorking: true });
    f.tmux.onText = async () => { f.tmux.paneText = active(f.tmux.sent.at(-1)); };
    f.tmux.onEnter = async () => {
      expect(f.db.boundSessions.getById(f.session.id)?.isWorking).toBe(true);
      expect(f.tmux.paneText).toContain('esc to interrupt');
    };
    const requestId = randomUUID();
    const first = await f.submit('approved', requestId);
    expect(first.recordedUserInput?.text).toBe('approved');
    expect(first.queuedInput).toBeUndefined();
    expect((await f.submit('approved', requestId)).recordedUserInput?.id).toBe(first.recordedUserInput?.id);
    f.tmux.paneText = active();
    expect((await f.submit('and preserve the draft')).recordedUserInput?.text).toBe('and preserve the draft');
    expect(f.tmux.sent).toEqual(['approved', 'and preserve the draft']);
    expect(f.tmux.sentKeys).toEqual([['Enter'], ['Enter']]);
    expect(f.tmux.created).toHaveLength(1);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
  });

  it.each(['codex', 'claude'] as const)('does not interrupt %s to clear a cancelled active-turn paste', async (providerId) => {
    const f = await fixture(providerId, false, new InputTmux(), true);
    f.db.boundSessions.upsert({ ...f.session, isWorking: true });
    const requestId = randomUUID();
    f.tmux.onText = async () => { await f.manager.cancelQueuedInput(f.session.id, requestId); };
    await f.submit('keep the running tool intact', requestId);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.tmux.paneText).toContain('keep the running tool intact');
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
  });

  it.each(['codex', 'claude'] as const)('preserves %s drafts and approvals, then delivers during the still-running turn', async (providerId) => {
    const f = await fixture(providerId, false, new InputTmux(), true);
    f.tmux.paneText = ready('an unrelated terminal draft');
    expect((await f.submit('a new instruction')).queuedInput?.state).toBe('queued');
    f.tmux.paneText = approval;
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
    f.tmux.paneText = ready();
    await vi.waitFor(() => expect(f.tmux.sentKeys).toEqual([['Enter']]), { timeout: 4000 });
    expect(f.tmux.sent).toEqual(['a new instruction']);
  });

  it('does not interrupt a running Claude turn to retire an automatic notice', async () => {
    const f = await fixture('claude', false, new InputTmux(), true);
    const assignmentId = enableUnattendedRecovery(f.db, 'claude', f.session.conversationRef);
    f.db.meta.set(peerWakeComposerKey(f.session.id), JSON.stringify({ assignmentId,
      pid: f.session.pid, startedAt: f.session.startedAt, timestamp: new Date().toISOString(),
      status: 'staged', notice: 'peer', messages: [] }));
    f.tmux.paneText = ready(PEER_WAKE_PROMPT);
    expect((await f.submit('the human instruction')).queuedInput?.state).toBe('queued');
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.tmux.paneText).toContain(PEER_WAKE_PROMPT);
    expect(JSON.parse(f.db.meta.get(peerWakeComposerKey(f.session.id))!)).toMatchObject({ status: 'staged' });
  });

  it.each([
    ['queued', '?'], ['queued', '? are you there'], ['combined', '?'], ['bypass', '?'],
  ] as const)('delivers leading question marks through %s input: %s', async (mode, text) => {
    const f = await fixture('claude', false, new QuestionShortcutTmux());
    let result;
    if (mode === 'queued') {
      result = await f.submit(text);
    } else {
      if (mode === 'bypass') await f.manager.sendKeystrokes(f.session.id, { text, deferScreenUpdate: true });
      result = await f.manager.sendKeystrokes(f.session.id, {
        text: mode === 'combined' ? text : undefined, submittedText: text, keys: ['Enter'],
      });
    }
    expect(result.recordedUserInput?.text).toBe(text);
    expect(result.queuedInput).toBeUndefined();
    expect(f.tmux.pasted).toEqual([text]);
    expect(f.tmux.sent).toEqual([text]);
    expect(f.tmux.sentKeys).toEqual([['Enter']]);

    await f.submit('are you there');
    f.tmux.paneText = ready();
    // This fake has no provider lifecycle watcher to finish the first turn.
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    await vi.waitFor(() => {
      expect(f.tmux.sentKeys).toEqual([['Enter'], ['Enter']]);
      expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
    }, { timeout: 4000 });
    const entries = (await fs.readFile(f.session.eventLogPath!, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === 'user-input').map(entry => entry.text)).toEqual([text, 'are you there']);
  });

  it.each(['codex', 'claude'] as const)('submits confirmed %s input once and deduplicates the same request', async (providerId) => {
    const f = await fixture(providerId);
    const id = randomUUID();
    const result = await f.submit('a complete message', id);
    expect(result.recordedUserInput?.text).toBe('a complete message');
    expect(result.queuedInput).toBeUndefined();
    expect((await f.submit('a complete message', id)).recordedUserInput?.id).toBe(result.recordedUserInput?.id);
    expect(f.tmux.sent).toEqual(['a complete message']);
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
    await expect(f.submit('different text', id)).rejects.toThrow('another message');
  });

  it('keeps a slow repaint queued, survives restart and submits without a second paste', async () => {
    const f = await fixture();
    f.tmux.acceptText = false;
    const result = await f.submit('slowly painted message');
    expect(result.queuedInput?.state).toBe('waiting_for_input');
    expect(result.recordedUserInput).toBeUndefined();
    expect(f.tmux.sentKeys).toEqual([]);
    await f.restart();
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs?.[0]?.text).toBe('slowly painted message');
    f.tmux.paneText = ready('slowly painted message');
    await vi.waitFor(() => expect(f.tmux.sentKeys).toEqual([['Enter']]), { timeout: 4000 });
    expect(f.tmux.sent).toEqual(['slowly painted message']);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
    const entries = (await fs.readFile(f.session.eventLogPath!, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === 'user-input')).toHaveLength(1);
  });

  it.each(['a'.repeat(1265), '🧭é'.repeat(600)])('delivers a collapsed Codex paste exactly once (%#. Unicode scalar count)', async text => {
    const f = await fixture();
    f.tmux.onText = async () => { f.tmux.paneText = ready(`[Pasted Content ${[...text].length} chars]`); };
    const requestId = randomUUID();
    const result = await f.submit(text, requestId);
    expect(result.recordedUserInput?.text).toBe(text);
    expect(result.queuedInput).toBeUndefined();
    await f.restart();
    expect((await f.submit(text, requestId)).recordedUserInput?.id).toBe(result.recordedUserInput?.id);
    expect(f.tmux.pasted).toEqual([text]);
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
  });

  it('waits for the correct collapsed paste after a partial repaint and backend restart', async () => {
    const f = await fixture();
    const text = 'long queued input '.repeat(80).trim();
    const requestId = randomUUID();
    f.tmux.onText = async () => { f.tmux.paneText = ready(`[Pasted Content ${text.length - 1} chars]`); };
    const result = await f.submit(text, requestId);
    expect(result.queuedInput?.state).toBe('waiting_for_input');
    expect(f.tmux.sentKeys).toEqual([]);
    await f.restart();
    f.tmux.paneText = ready(`[Pasted Content ${text.length} chars] #2`);
    expect((await f.submit(text, requestId)).recordedUserInput?.text).toBe(text);
    expect(f.tmux.pasted).toEqual([text]);
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
  });

  it('confirms the pasted delta after an existing visible prefix, including wrapped placeholder rows', async () => {
    const f = await fixture();
    const delta = 'a'.repeat(1265), prefix = 'existing prefix ';
    f.tmux.paneText = ready(prefix);
    f.tmux.onText = async () => { f.tmux.paneText = ready(`${prefix}[Pasted Con\ntent ${delta.length} chars]\n#2`); };
    const result = await f.manager.sendKeystrokes(f.session.id, {
      text: delta, submittedText: prefix + delta, keys: ['Enter'], submissionId: randomUUID(),
    });
    expect(result.recordedUserInput?.text).toBe(prefix + delta);
    expect(f.tmux.pasted).toEqual([delta]);
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
  });

  it.each(['codex', 'claude'] as const)('refuses the other provider paste display in %s', async providerId => {
    const f = await fixture(providerId);
    const text = 'a'.repeat(1265);
    f.tmux.onText = async () => { f.tmux.paneText = ready(providerId === 'codex' ? '[Pasted text #1 +1 lines]' : `[Pasted Content ${text.length} chars]`); };
    expect((await f.submit(text)).queuedInput?.state).toBe('waiting_for_input');
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it('requires review for an unconfirmed paste after 30 seconds and never replays it after restart', async () => {
    const f = await fixture();
    const text = 'a'.repeat(1265), requestId = randomUUID();
    f.tmux.onText = async () => { f.tmux.paneText = ready('[Unrecognized native paste display]'); };
    await f.submit(text, requestId);
    const key = `session-input:${f.session.id}:${requestId}`;
    const record = JSON.parse(f.db.meta.get(key)!);
    f.db.meta.set(key, JSON.stringify({ ...record, typedAt: new Date(Date.now() - 31_000).toISOString() }));
    await vi.waitFor(() => expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs?.[0]?.state).toBe('needs_review'), { timeout: 4000 });
    await f.restart();
    expect((await f.submit(text, requestId)).queuedInput?.state).toBe('needs_review');
    expect(f.tmux.pasted).toEqual([text]);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it.each(['restart', 'approval'] as const)('submits a freshly confirmed paste after a long %s wait', async waitKind => {
    const f = await fixture();
    const text = 'a'.repeat(1265), requestId = randomUUID();
    f.tmux.acceptText = false;
    await f.submit(text, requestId);
    const key = `session-input:${f.session.id}:${requestId}`;
    const record = JSON.parse(f.db.meta.get(key)!);
    f.db.meta.set(key, JSON.stringify({ ...record, typedAt: new Date(Date.now() - 31_000).toISOString() }));
    if (waitKind === 'restart') await f.restart();
    else {
      f.tmux.paneText = approval;
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs?.[0]?.state).toBe('waiting_for_input');
      expect(f.tmux.sentKeys).toEqual([]);
    }
    f.tmux.paneText = ready(`[Pasted Content ${text.length} chars]`);
    expect((await f.submit(text, requestId)).recordedUserInput?.text).toBe(text);
    expect(f.tmux.pasted).toEqual([text]);
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
  });

  it('requires review when the native process changes after its paste was entered', async () => {
    const f = await fixture();
    f.tmux.acceptText = false;
    await f.submit('unconfirmed text');
    f.tmux.pid++;
    await vi.waitFor(() => expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs?.[0]?.state).toBe('needs_review'), { timeout: 4000 });
    expect(f.tmux.sent).toEqual(['unconfirmed text']);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it('preserves a human Claude paste entered after cancelling our active-turn paste', async () => {
    const f = await fixture('claude');
    const requestId = randomUUID(), text = 'cancelled long input '.repeat(70).trim();
    f.tmux.onText = async () => {
      f.tmux.paneText = 'Claude Code\n✻ Thinking… (1s · esc to interrupt)\n────────────────────\n❯ [Pasted text #1 +1 lines]\n────────────────────\n⏵⏵ bypass permissions on';
      f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: true });
      await f.manager.cancelQueuedInput(f.session.id, requestId);
    };
    await f.submit(text, requestId);
    await new Promise(resolve => setTimeout(resolve, 100));
    f.tmux.paneText = ready();
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    f.tmux.onText = async () => { f.tmux.paneText = ready('[Pasted text #2 +1 lines]'); };
    await f.manager.sendKeystrokes(f.session.id, { text: 'human foreign paste '.repeat(70), deferScreenUpdate: true });
    expect((await f.submit('next intended message')).queuedInput).toBeDefined();
    expect(f.tmux.paneText).toContain('[Pasted text #2');
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it('clears only its cancelled collapsed paste before the next queued message', async () => {
    const f = await fixture();
    const text = 'cancelled long input '.repeat(70).trim();
    const requestId = randomUUID();
    f.tmux.onText = async () => {
      f.tmux.paneText = ready(`[Pasted Content ${text.length} chars]`);
      await f.manager.cancelQueuedInput(f.session.id, requestId);
    };
    await f.submit(text, requestId);
    await vi.waitFor(() => expect(f.tmux.sentKeys).toEqual([['C-c']]));
    f.tmux.onText = undefined;
    expect((await f.submit('next actual message')).recordedUserInput?.text).toBe('next actual message');
    expect(f.tmux.sentKeys).toEqual([['C-c'], ['Enter']]);
  });

  it('does not accept a collapsed paste with extra native draft text', async () => {
    const f = await fixture();
    const text = 'long queued input '.repeat(80).trim();
    f.tmux.onText = async () => { f.tmux.paneText = ready(`foreign [Pasted Content ${text.length} chars]`); };
    expect((await f.submit(text)).queuedInput?.state).toBe('waiting_for_input');
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it.each(['claude', 'codex'] as const)('recognizes a persisted %s collapsed draft already entered through Text Bypass', async providerId => {
    const f = await fixture(providerId);
    const text = 'A long multiline draft\n'.repeat(70).trim();
    f.tmux.onText = async () => { f.tmux.paneText = ready(providerId === 'codex' ? `[Pasted Content ${text.length} chars]` : '[Pasted text #1 +70 lines]'); };
    await f.manager.sendKeystrokes(f.session.id, { text, deferScreenUpdate: true });
    await f.restart();
    const result = await f.manager.sendKeystrokes(f.session.id, { submittedText: text, keys: ['Enter'], submissionId: randomUUID() });
    expect(result.recordedUserInput?.text).toBe(text);
    expect(f.tmux.sent).toEqual([text]);
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
  });

  it('cannot acknowledge another raw paste as the pending message', async () => {
    const f = await fixture();
    f.tmux.acceptText = false;
    await f.submit('unconfirmed message');
    f.tmux.onText = async () => { f.tmux.paneText = ready('[Pasted text #2 +30 lines]'); };
    await f.manager.sendKeystrokes(f.session.id, { text: 'a different\nraw paste', deferScreenUpdate: true });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs?.[0]?.state).toBe('needs_review');
  });

  it('waits through unavailable composers and approval screens, then delivers FIFO', async () => {
    const f = await fixture();
    f.tmux.paneText = unavailable;
    await f.submit('first message');
    await f.submit('second message');
    expect(f.tmux.sent).toEqual([]);
    f.tmux.paneText = approval;
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
    f.tmux.paneText = ready();
    await vi.waitFor(() => expect(f.tmux.sent).toEqual(['first message']), { timeout: 4000 });
    f.tmux.paneText = ready();
    // The fake provider has no transcript watcher; project its completed first turn.
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false, updatedAt: new Date().toISOString() });
    await vi.waitFor(() => expect(f.tmux.sent).toEqual(['first message', 'second message']), { timeout: 4000 });
    expect(f.tmux.sentKeys).toEqual([['Enter'], ['Enter']]);
  });

  it('accepts human input at a composer when the backend reports work without native lifecycle', async () => {
    const f = await fixture();
    f.db.boundSessions.upsert({ ...f.session, isWorking: true, updatedAt: new Date().toISOString() });
    expect((await f.submit('read this during your turn')).recordedUserInput?.text).toBe('read this during your turn');
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
  });

  it('does not submit unrelated changed input or paste again after an unconfirmed write', async () => {
    const f = await fixture();
    f.tmux.acceptText = false;
    await f.submit('expected draft');
    f.tmux.paneText = ready('a different native draft');
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sent).toEqual(['expected draft']);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it('defers a foreign draft and reuses an already matching draft', async () => {
    const f = await fixture();
    f.tmux.paneText = ready('unrelated draft');
    await f.submit('expected draft');
    expect(f.tmux.sent).toEqual([]);
    f.tmux.paneText = ready('expected draft');
    await vi.waitFor(() => expect(f.tmux.sentKeys).toEqual([['Enter']]), { timeout: 4000 });
    expect(f.tmux.sent).toEqual([]);
  });

  it.each(['cancel', 'Stop', 'restart'] as const)('clears live-staged text after %s, with immediate clearance only for human Stop', async action => {
    const f = await fixture('claude');
    const text = 'the already answered approval', requestId = randomUUID();
    await f.manager.sendKeystrokes(f.session.id, { text, deferScreenUpdate: true });
    f.tmux.paneText = approval;
    await f.manager.sendKeystrokes(f.session.id, { submittedText: text, keys: ['Enter'], submissionId: requestId });
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: true });
    f.tmux.paneText = ready(text);
    if (action === 'Stop') await f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    else await f.manager.cancelQueuedInput(f.session.id, requestId);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(f.tmux.sentKeys).toEqual(action === 'Stop' ? [['Escape'], ['C-c']] : []);
    if (action === 'Stop') expect(f.tmux.paneText).toBe(ready());
    else expect(f.tmux.paneText).toContain(text);
    if (action === 'restart') await f.restart();
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    const result = await f.submit('the next message');
    expect(result.recordedUserInput?.text).toBe('the next message');
    expect(f.tmux.sentKeys).toEqual([...(action === 'Stop' ? [['Escape']] : []), ['C-c'], ['Enter']]);
    expect(f.tmux.sent).toEqual([text, 'the next message']);
    const events = (await fs.readFile(f.session.eventLogPath!, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'user-input').map(event => event.text)).toEqual(['the next message']);
  });

  it('clears an owned collapsed live-staged paste on idle cancellation', async () => {
    const f = await fixture('claude');
    const text = 'cancelled long approval '.repeat(70).trim(), requestId = randomUUID();
    f.tmux.onText = async () => { f.tmux.paneText = ready('[Pasted text #1 +70 lines]'); };
    await f.manager.sendKeystrokes(f.session.id, { text, deferScreenUpdate: true });
    f.tmux.onText = undefined;
    f.tmux.paneText = approval;
    await f.manager.sendKeystrokes(f.session.id, { submittedText: text, keys: ['Enter'], submissionId: requestId });
    f.tmux.paneText = ready('[Pasted text #1 +70 lines]');
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    await f.manager.cancelQueuedInput(f.session.id, requestId);
    expect((await f.submit('the next message')).recordedUserInput?.text).toBe('the next message');
    expect(f.tmux.sentKeys).toEqual([['C-c'], ['Enter']]);
    expect(f.tmux.sent).toEqual([text, 'the next message']);
  });

  it.each(['edited', 'prefix', 'PID', 'key', 'owner'] as const)('preserves cancelled live-staged text after a change to its %s', async change => {
    const f = await fixture('claude');
    const prefix = change === 'prefix' ? 'existing human draft ' : '';
    f.tmux.paneText = ready(prefix);
    const text = 'cancelled approval', requestId = randomUUID();
    await f.manager.sendKeystrokes(f.session.id, { text, deferScreenUpdate: true });
    f.tmux.paneText = approval;
    await f.manager.sendKeystrokes(f.session.id, { submittedText: prefix + text, keys: ['Enter'], submissionId: requestId });
    if (change === 'key') await f.manager.sendKeystrokes(f.session.id, { keys: ['Left'] });
    if (change === 'PID') f.tmux.pid++;
    if (change === 'owner') await f.tmux.setOption(f.session.tmuxSessionName, '@agent_console_session_id', 'another-owner');
    f.tmux.paneText = ready(prefix + text + (change === 'edited' ? ', edited by hand' : ''));
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    await f.manager.cancelQueuedInput(f.session.id, requestId);
    expect((await f.submit('the next message')).queuedInput?.state).toBe('queued');
    expect(f.tmux.sentKeys).toEqual(change === 'key' ? [['Left']] : []);
    expect(f.tmux.paneText).toContain(text);
  });

  it('does not clear live-staged text when human typing invalidates its captured screen', async () => {
    const f = await fixture('claude');
    const text = 'cancelled approval', requestId = randomUUID();
    await f.manager.sendKeystrokes(f.session.id, { text, deferScreenUpdate: true });
    f.tmux.paneText = approval;
    await f.manager.sendKeystrokes(f.session.id, { submittedText: text, keys: ['Enter'], submissionId: requestId });
    f.tmux.paneText = ready(text);
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    const capture = f.tmux.capturePane.bind(f.tmux);
    let edit: Promise<unknown> | undefined;
    vi.spyOn(f.tmux, 'capturePane').mockImplementationOnce(async () => {
      const snapshot = await capture();
      edit = f.manager.sendKeystrokes(f.session.id, { text: ', edited by hand', deferScreenUpdate: true });
      return snapshot;
    });
    await f.manager.cancelQueuedInput(f.session.id, requestId);
    await vi.waitFor(() => expect(edit).toBeDefined());
    await edit;
    expect((await f.submit('the next message')).queuedInput?.state).toBe('queued');
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.tmux.paneText).toContain('edited by hand');
  });

  it('does not repeat an uncertain clear of cancelled live-staged text', async () => {
    const f = await fixture('claude');
    const text = 'cancelled approval', requestId = randomUUID();
    await f.manager.sendKeystrokes(f.session.id, { text, deferScreenUpdate: true });
    f.tmux.paneText = approval;
    await f.manager.sendKeystrokes(f.session.id, { submittedText: text, keys: ['Enter'], submissionId: requestId });
    f.tmux.paneText = ready(text);
    f.tmux.clearInput = false;
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false });
    await f.manager.cancelQueuedInput(f.session.id, requestId);
    expect((await f.submit('the next message')).queuedInput?.state).toBe('queued');
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sentKeys).toEqual([['C-c']]);
    expect(f.tmux.sent).toEqual([text]);
    expect(f.tmux.paneText).toContain(text);
  });

  it('cancels during text transport before Enter and clears only the text it typed', async () => {
    const f = await fixture();
    const id = randomUUID();
    f.tmux.onText = async () => { await f.manager.cancelQueuedInput(f.session.id, id); };
    await f.submit('cancel me', id);
    await vi.waitFor(() => expect(f.tmux.sentKeys).toEqual([['C-c']]), { timeout: 4000 });
    expect(f.tmux.paneText).not.toContain('cancel me');
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
  });

  it('keeps a cancelled message when it was appended to an existing human draft', async () => {
    const f = await fixture();
    const id = randomUUID();
    f.tmux.paneText = ready('my own words ');
    f.tmux.onText = async () => { await f.manager.cancelQueuedInput(f.session.id, id); };
    await f.manager.sendKeystrokes(f.session.id, { text: 'cancel me', submittedText: 'my own words cancel me', keys: ['Enter'], submissionId: id });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.tmux.paneText).toContain('my own words cancel me');
  });

  it.each([false, true])('Stop clears the draft before the next input, including navigation (%s)', async navigate => {
    const f = await fixture();
    let stop: Promise<unknown> | undefined;
    f.tmux.onText = async () => { f.tmux.onText = undefined; stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] }); };
    await f.submit('stranded by Stop');
    await stop;
    expect(f.tmux.paneText).toBe(ready());
    expect(f.tmux.sentKeys).toEqual([['Escape'], ['C-c']]);
    if (navigate) await f.manager.sendKeystrokes(f.session.id, { keys: ['Left'] });
    const result = await f.submit('the next message');
    expect(result.recordedUserInput?.text).toBe('the next message');
    expect(f.tmux.sentKeys).toEqual([['Escape'], ['C-c'], ...(navigate ? [['Left']] : []), ['Enter']]);
    expect(f.tmux.sent).toEqual(['stranded by Stop', 'the next message']);
  });

  it('preserves a new native draft entered after Stop', async () => {
    const f = await fixture();
    let stop: Promise<unknown> | undefined;
    f.tmux.onText = async () => { f.tmux.onText = undefined; stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] }); };
    await f.submit('stranded by Stop');
    await stop;
    f.tmux.paneText = ready('stranded by Stop, edited by hand');
    expect((await f.submit('the next message')).queuedInput?.state).toBe('queued');
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sentKeys).toEqual([['Escape'], ['C-c']]);
    expect(f.tmux.paneText).toContain('edited by hand');
  });

  it('Stop during text entry prevents the queued Enter', async () => {
    const f = await fixture();
    let stop: Promise<unknown> | undefined;
    f.tmux.onText = async () => { stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] }); };
    await f.submit('stop before Enter');
    await stop;
    expect(f.tmux.sentKeys).toEqual([['Escape'], ['C-c']]);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
  });

  it('rejects cancellation once Enter is in flight and keeps delivery visible', async () => {
    const f = await fixture();
    const id = randomUUID();
    f.tmux.onEnter = async () => {
      expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs?.[0]?.state).toBe('submitting');
      await expect(f.manager.cancelQueuedInput(f.session.id, id)).rejects.toThrow('already started');
      expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toHaveLength(1);
    };
    const result = await f.submit('send exactly once', id);
    expect(result.recordedUserInput?.text).toBe('send exactly once');
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
    await expect(f.manager.cancelQueuedInput(f.session.id, id)).rejects.toThrow('already started');
  });

  it('makes a pre-Enter ownership failure reviewable without leaving a permanent sending state', async () => {
    const f = await fixture();
    f.eventBus.subscribe(event => {
      if (event.type === 'session.updated' && event.session.queuedInputs?.[0]?.state === 'submitting') {
        void f.tmux.setOption(f.session.tmuxSessionName, '@agent_console_session_id', 'replacement-owner');
      }
    });
    const id = randomUUID();
    expect((await f.submit('do not enter on the replacement pane', id)).queuedInput?.state).toBe('needs_review');
    expect(f.tmux.sentKeys).toEqual([]);
    await f.manager.cancelQueuedInput(f.session.id, id);
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs).toBeUndefined();
  });

  it('rechecks the native composer after final ownership reads before Enter', async () => {
    const f = await fixture();
    f.eventBus.subscribe(event => {
      if (event.type === 'session.updated' && event.session.queuedInputs?.[0]?.state === 'submitting') {
        f.tmux.paneText = ready('a different native draft');
      }
    });
    expect((await f.submit('the queued message')).queuedInput?.state).toBe('needs_review');
    expect(f.tmux.sentKeys).toEqual([]);
    expect(f.tmux.paneText).toContain('a different native draft');
  });

  it.each(['busy', 'ownership', 'kill'] as const)('preserves queued messages when manual suspension fails on %s', async (failure) => {
    const f = await fixture();
    f.tmux.paneText = unavailable;
    await f.submit('preserve my queued message');
    if (failure !== 'busy') f.tmux.paneText = ready();
    if (failure === 'ownership') await f.tmux.setOption(f.session.tmuxSessionName, '@agent_console_session_id', 'another-owner');
    if (failure === 'kill') f.tmux.failKill = true;
    await expect(f.manager.suspendSession(f.session.id)).rejects.toThrow();
    expect(f.db.boundSessions.getById(f.session.id)?.queuedInputs?.map(input => input.text)).toEqual(['preserve my queued message']);
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it('cancels untyped queued messages only after a successful manual suspension', async () => {
    const f = await fixture();
    f.tmux.paneText = unavailable;
    await f.submit('cancel on successful pause');
    f.tmux.paneText = ready();
    const result = await f.manager.suspendSession(f.session.id);
    expect(result.manualSuspendedAt).toBeDefined();
    expect(result.queuedInputs).toBeUndefined();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(false);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it('defers a model switch while a paste awaits confirmation, then delivers on the original pane', async () => {
    const f = await fixture('codex', true);
    f.tmux.acceptText = false;
    await f.submit('unconfirmed draft');
    const originalPid = f.tmux.pid;
    await f.manager.requestModelProfile(f.session.id, 'high');
    await vi.waitFor(() => expect(f.db.boundSessions.getById(f.session.id)?.modelProfileRequest)
      .toMatchObject({ state: 'queued', deferredReason: 'unsent_input' }));
    expect(f.tmux.created).toHaveLength(1);
    expect(f.tmux.pid).toBe(originalPid);
    f.tmux.paneText = ready('unconfirmed draft');
    await vi.waitFor(() => expect(f.tmux.sentKeys).toEqual([['Enter']]), { timeout: 4000 });
    expect(f.tmux.sent).toEqual(['unconfirmed draft']);
    f.tmux.paneText = ready();
    const completed = { ...f.db.boundSessions.getById(f.session.id)!, isWorking: false, updatedAt: new Date().toISOString() };
    f.db.boundSessions.upsert(completed);
    f.eventBus.emit({ type: 'session.updated', session: completed });
    await vi.waitFor(() => expect(f.db.boundSessions.getById(f.session.id)?.codexProfile).toBe('high'), { timeout: 4000 });
    expect(f.tmux.pid).not.toBe(originalPid);
  });

  it('checks tmux ownership before delivering and never follows a replacement owner', async () => {
    const f = await fixture();
    f.tmux.paneText = unavailable;
    await f.submit('owned message');
    await f.tmux.setOption(f.session.tmuxSessionName, '@agent_console_session_id', 'other-owner');
    f.tmux.paneText = ready();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sent).toEqual([]);
    expect(f.tmux.sentKeys).toEqual([]);
  });

  it('blocks replay after an uncertain Enter, including a server restart', async () => {
    const f = await fixture();
    const id = randomUUID();
    f.tmux.failEnter = true;
    expect((await f.submit('uncertain delivery', id)).queuedInput?.state).toBe('needs_review');
    await f.restart();
    f.tmux.paneText = ready('uncertain delivery');
    expect((await f.submit('uncertain delivery', id)).queuedInput?.state).toBe('needs_review');
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sentKeys).toEqual([['Enter']]);
  });
});
