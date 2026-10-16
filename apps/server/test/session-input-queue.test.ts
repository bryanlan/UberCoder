import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { createRecoveryManager, FakeTmux, project, provider, claudeProvider, providerSettings } from './helpers/session-fixtures.js';

const ready = (text = '') => `OpenAI Codex\n\n› ${text}\n  gpt-6.1-sol xhigh · 65% left · ~/demo`;
const busy = 'OpenAI Codex\n\n• Working (1s • esc to interrupt)\n› \n  gpt-6.1-sol xhigh · 65% left · ~/demo';
const approval = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend';

class InputTmux extends FakeTmux {
  acceptText = true;
  failEnter = false;
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
    if (keys.includes('C-c') && /^› ?\S/m.test(this.paneText)) this.paneText = ready();
    if (keys.includes('Enter')) {
      await this.onEnter?.();
      this.paneText = busy;
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

async function fixture(providerId: 'codex' | 'claude' = 'codex', recovery = false, tmux = new InputTmux()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'console-input-queue-'));
  const databasePath = path.join(directory, 'console.sqlite');
  let db = new AppDatabase(databasePath);
  const eventBus = new RealtimeEventBus();
  const runtimeDir = path.join(directory, 'runtime');
  const createManager = () => recovery ? createRecoveryManager(db, tmux, runtimeDir, eventBus)
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

  it('recognizes a persisted collapsed draft already entered through Text Bypass', async () => {
    const f = await fixture();
    const text = 'A long multiline draft\n'.repeat(30).trim();
    f.tmux.onText = async () => { f.tmux.paneText = ready('[Pasted text #1 +30 lines]'); };
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

  it('waits through busy and approval screens without writing, then delivers FIFO', async () => {
    const f = await fixture();
    f.tmux.paneText = busy;
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

  it('defers when the backend still reports work and native lifecycle is unavailable', async () => {
    const f = await fixture();
    f.db.boundSessions.upsert({ ...f.session, isWorking: true, updatedAt: new Date().toISOString() });
    expect((await f.submit('wait for known completion')).queuedInput?.state).toBe('queued');
    expect(f.tmux.sent).toEqual([]);
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(f.session.id)!, isWorking: false, updatedAt: new Date().toISOString() });
    await vi.waitFor(() => expect(f.tmux.sentKeys).toEqual([['Enter']]), { timeout: 4000 });
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

  it('after Stop, clears the stranded queued text once before typing the next message', async () => {
    const f = await fixture();
    let stop: Promise<unknown> | undefined;
    f.tmux.onText = async () => { f.tmux.onText = undefined; stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] }); };
    await f.submit('stranded by Stop');
    await stop;
    expect(f.tmux.paneText).toContain('stranded by Stop');
    expect(f.tmux.sentKeys).toEqual([['Escape']]);
    const result = await f.submit('the next message');
    expect(result.recordedUserInput?.text).toBe('the next message');
    expect(f.tmux.sentKeys).toEqual([['Escape'], ['C-c'], ['Enter']]);
    expect(f.tmux.sent).toEqual(['stranded by Stop', 'the next message']);
  });

  it('does not clear stranded text after the human edits it', async () => {
    const f = await fixture();
    let stop: Promise<unknown> | undefined;
    f.tmux.onText = async () => { f.tmux.onText = undefined; stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] }); };
    await f.submit('stranded by Stop');
    await stop;
    f.tmux.paneText = ready('stranded by Stop, edited by hand');
    expect((await f.submit('the next message')).queuedInput?.state).toBe('queued');
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.tmux.sentKeys).toEqual([['Escape']]);
    expect(f.tmux.paneText).toContain('edited by hand');
  });

  it('Stop during text entry prevents the queued Enter', async () => {
    const f = await fixture();
    let stop: Promise<unknown> | undefined;
    f.tmux.onText = async () => { stop = f.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] }); };
    await f.submit('stop before Enter');
    await stop;
    expect(f.tmux.sentKeys).toEqual([['Escape']]);
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
    f.tmux.paneText = busy;
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
    f.tmux.paneText = busy;
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
    f.tmux.paneText = busy;
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
