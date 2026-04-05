import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { buildStagedLiveInputInstruction } from '../src/lib/pending-input.js';
import { normalizeComparableText, stableTextHash } from '../src/lib/text.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionKeystrokeRejectedError, SessionManager } from '../src/sessions/session-manager.js';
import type { TmuxClient } from '../src/sessions/tmux-client.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import type { MergedProviderSettings } from '../src/config/service.js';

class FakeTmux implements TmuxClient {
  created: string[] = [];
  createdCommands: string[] = [];
  sent: string[] = [];
  pasted: string[] = [];
  sentKeys: string[][] = [];
  alive = new Set<string>();
  failPipePane = false;
  failKill = false;
  paneText = '';
  captureSequence: string[] = [];

  async newDetachedSession(sessionName: string, _cwd: string, shellCommand: string): Promise<void> {
    this.created.push(sessionName);
    this.createdCommands.push(shellCommand);
    this.alive.add(sessionName);
  }
  async pipePaneToFile(): Promise<void> {
    if (this.failPipePane) {
      throw new Error('pipe-pane failed');
    }
  }
  async sendLiteralText(_sessionName: string, text: string): Promise<void> { this.sent.push(text); }
  async pasteText(_sessionName: string, text: string): Promise<void> {
    this.pasted.push(text);
    this.sent.push(text);
  }
  async sendKeys(_sessionName: string, keys: string[]): Promise<void> { this.sentKeys.push(keys); }
  async sendLiteralInput(_sessionName: string, text: string): Promise<void> { this.sent.push(text); }
  async capturePane(): Promise<string> {
    if (this.captureSequence.length > 0) {
      const next = this.captureSequence.shift();
      if (next !== undefined) {
        this.paneText = next;
      }
    }
    return this.paneText;
  }
  async interrupt(): Promise<void> {}
  async killSession(sessionName: string): Promise<void> {
    if (this.failKill) {
      throw new Error('kill failed');
    }
    this.alive.delete(sessionName);
  }
  async hasSession(sessionName: string): Promise<boolean> { return this.alive.has(sessionName); }
  async getPanePid(): Promise<number | undefined> { return 4242; }
  async setUserOption(): Promise<void> {}
}

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  rootPath: '/srv/demo',
  path: '/srv/demo',
  matchPaths: ['/srv/demo'],
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, explicit: false, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

const provider: ProviderAdapter = {
  id: 'codex',
  async discoverLocalState() { return {}; },
  async listConversations() { return []; },
  async getConversation() { return null; },
  getLaunchCommand(_project, _conversationRef, _settings, options) {
    return {
      cwd: '/srv/demo',
      argv: ['codex', ...(options?.initialPrompt ? [options.initialPrompt] : [])],
      env: {},
    };
  },
};

const claudeProvider: ProviderAdapter = {
  ...provider,
  id: 'claude',
};

const providerSettings = {
  id: 'codex',
  enabled: true,
  discoveryRoot: '/home/user/.codex',
  commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
} satisfies MergedProviderSettings;

function createRecoveryManager(
  db: AppDatabase,
  tmux: TmuxClient,
  runtimeDir: string,
  eventBus = new RealtimeEventBus(),
  recoveryProvider: ProviderAdapter = provider,
  recoveryProviderSettings: MergedProviderSettings = providerSettings,
): SessionManager {
  return new SessionManager(db, tmux, runtimeDir, eventBus, {
    projectService: {
      getProjectBySlug: async (slug: string) => slug === project.slug ? project : undefined,
      getMergedProviderSettings: () => recoveryProviderSettings,
    },
    providerRegistry: {
      get: () => recoveryProvider,
    },
  });
}

describe('SessionManager', () => {
  it('tracks bind → input → release transitions through the database', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:test',
      title: 'New conversation',
      kind: 'pending',
    });

    expect(session.status).toBe('bound');
    await manager.sendInput(session.id, 'Hello agent');
    expect(tmux.sent).toEqual(['Hello agent']);
    expect(tmux.sentKeys).toEqual([['Enter']]);

    await manager.releaseSession(session.id);
    const ended = db.getBoundSessionById(session.id);
    expect(ended?.status).toBe('ended');
    db.close();
  });

  it('marks failed bind attempts as error and cleans up tmux state', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.failPipePane = true;
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    await expect(manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-fail',
      title: 'Broken conversation',
      kind: 'history',
    })).rejects.toThrow(/pipe-pane failed/);

    expect(db.listBoundSessions()).toHaveLength(1);
    expect(db.listBoundSessions()[0]?.status).toBe('error');
    expect(tmux.alive.size).toBe(0);
    db.close();
  });

  it('restores the same bound session when the tmux session is gone', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const first = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-rebind',
      title: 'Conversation',
      kind: 'history',
    });
    tmux.alive.clear();

    const second = await manager.ensureSession(first.id);

    expect(second?.id).toBe(first.id);
    expect(second?.status).toBe('bound');
    expect(tmux.created).toHaveLength(2);
    db.close();
  });

  it('resolves and restores pending sessions after provider adoption can be matched', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const recoveryProvider: ProviderAdapter = {
      ...provider,
      async listConversations() {
        return [{
          ref: 'real-restored',
          kind: 'history',
          projectSlug: project.slug,
          provider: 'codex',
          title: 'Recovered conversation',
          createdAt: '2026-03-14T18:00:30.000Z',
          updatedAt: '2026-03-14T18:00:30.000Z',
          transcriptPath: '/tmp/real-restored.jsonl',
          isBound: false,
          degraded: false,
          rawMetadata: {
            lastUserTextHash: 'match-hash',
          },
        }];
      },
      getLaunchCommand(_project, conversationRef) {
        return {
          cwd: '/srv/demo',
          argv: ['codex', 'resume', conversationRef ?? ''],
          env: {},
        };
      },
    };
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus(), recoveryProvider);
    db.putPendingConversation({
      ref: 'pending:restore-me',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'Pending conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'placeholder',
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'match-hash',
      },
    });

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:restore-me',
      title: 'Pending conversation',
      kind: 'pending',
    });
    tmux.alive.clear();

    const restored = await manager.ensureSession(session.id);

    expect(restored?.id).toBe(session.id);
    expect(restored?.conversationRef).toBe('real-restored');
    expect(restored?.resumeConversationRef).toBe('real-restored');
    expect(db.getPendingConversation('pending:restore-me')?.rawMetadata?.adoptedConversationRef).toBe('real-restored');
    expect(tmux.createdCommands.at(-1)).toContain("'codex' 'resume' 'real-restored'");
    db.close();
  });

  it('leaves pending sessions unrestored when no resumable conversation can be resolved yet', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    db.putPendingConversation({
      ref: 'pending:unresolved',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'Pending conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'placeholder',
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'missing-match',
      },
    });

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:unresolved',
      title: 'Pending conversation',
      kind: 'pending',
    });
    tmux.alive.clear();

    const restored = await manager.ensureSession(session.id);

    expect(restored).toBeUndefined();
    expect(tmux.created).toHaveLength(1);
    expect(db.getBoundSessionById(session.id)?.status).toBe('error');
    expect(db.getBoundSessionById(session.id)?.shouldRestore).toBe(true);
    db.close();
  });

  it('restores pending sessions when the real conversation only captured the staged bridge instruction hash', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const runtimeDir = path.join(tempDir, 'runtime');
    const stagedPrompt = 'ship the staged prompt restore fix';
    const stagedPromptHash = stableTextHash(normalizeComparableText(stagedPrompt));
    const stagedPath = path.join(runtimeDir, 'placeholder', 'bridge-inputs', '1000-b0bc257719.md');
    const stagedInstructionHash = stableTextHash(normalizeComparableText(buildStagedLiveInputInstruction(stagedPath)));
    const recoveryProvider: ProviderAdapter = {
      ...provider,
      async listConversations() {
        return [{
          ref: 'real-staged',
          kind: 'history',
          projectSlug: project.slug,
          provider: 'codex',
          title: 'Recovered staged conversation',
          createdAt: '2026-03-14T18:00:30.000Z',
          updatedAt: '2026-03-14T18:00:30.000Z',
          transcriptPath: '/tmp/real-staged.jsonl',
          isBound: false,
          degraded: false,
          rawMetadata: {
            lastUserTextHash: stagedInstructionHash,
          },
        }];
      },
      getLaunchCommand(_project, conversationRef) {
        return {
          cwd: '/srv/demo',
          argv: ['codex', 'resume', conversationRef ?? ''],
          env: {},
        };
      },
    };
    const manager = createRecoveryManager(db, tmux, runtimeDir, new RealtimeEventBus(), recoveryProvider);
    db.putPendingConversation({
      ref: 'pending:restore-staged',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'Pending conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'placeholder',
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: stagedPromptHash,
        lastUserInputPreview: stagedPrompt,
      },
    });

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:restore-staged',
      title: 'Pending conversation',
      kind: 'pending',
    });
    const stagedDir = path.join(runtimeDir, session.id, 'bridge-inputs');
    await fs.mkdir(stagedDir, { recursive: true });
    const sessionStagedPath = path.join(stagedDir, '1000-b0bc257719.md');
    await fs.writeFile(
      sessionStagedPath,
      stagedPrompt,
      'utf8',
    );
    const sessionStagedInstructionHash = stableTextHash(
      normalizeComparableText(buildStagedLiveInputInstruction(sessionStagedPath)),
    );
    recoveryProvider.listConversations = async () => [{
      ref: 'real-staged',
      kind: 'history',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'Recovered staged conversation',
      createdAt: '2026-03-14T18:00:30.000Z',
      updatedAt: '2026-03-14T18:00:30.000Z',
      transcriptPath: '/tmp/real-staged.jsonl',
      isBound: false,
      degraded: false,
      rawMetadata: {
        lastUserTextHash: sessionStagedInstructionHash,
      },
    }];
    tmux.alive.clear();

    const restored = await manager.ensureSession(session.id);

    expect(restored?.conversationRef).toBe('real-staged');
    expect(db.getPendingConversation('pending:restore-staged')?.rawMetadata?.adoptedConversationRef).toBe('real-staged');
    db.close();
  });

  it('abandons dead zero-turn pending sessions instead of keeping them durably bound', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    db.putPendingConversation({
      ref: 'pending:zero-turn',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'Pending conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'placeholder',
      degraded: false,
      rawMetadata: {
        pending: true,
      },
    });

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:zero-turn',
      title: 'Pending conversation',
      kind: 'pending',
    });
    tmux.alive.clear();

    const restored = await manager.ensureSession(session.id);

    expect(restored).toBeUndefined();
    expect(db.getBoundSessionById(session.id)?.status).toBe('ended');
    expect(db.getBoundSessionById(session.id)?.shouldRestore).toBe(false);
    expect(db.getPendingConversation('pending:zero-turn')?.isBound).toBe(false);
    db.close();
  });

  it('surfaces release failures instead of reporting ended sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-release-fail',
      title: 'Conversation',
      kind: 'history',
    });

    tmux.failKill = true;
    await expect(manager.releaseSession(session.id)).rejects.toThrow(/Failed to release/);
    expect(db.getBoundSessionById(session.id)?.status).toBe('error');
    db.close();
  });

  it('captures a live screen snapshot for bound sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Reviewing repository state…',
      'Applying patch…',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-screen',
      title: 'Conversation',
      kind: 'history',
    });

    const liveScreen = await manager.getSessionScreen(session.id);
    expect(liveScreen?.screen.content).toContain('Reviewing repository state…');
    expect(liveScreen?.screen.status).toContain('98% left');
    db.close();
  });

  it('marks sessions as waiting when the live screen is waiting on user input', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Ready for input.',
      '❯ ',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-waiting-attention',
      title: 'Conversation',
      kind: 'history',
    });

    expect(db.getBoundSessionById(session.id)?.attentionState).toBe('waiting');
    db.close();
  });

  it('marks sessions as working when the live screen shows an ellipsis status line', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Thinking about the repository…',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-ellipsis-attention',
      title: 'Conversation',
      kind: 'history',
    });

    expect(db.getBoundSessionById(session.id)?.attentionState).toBe('working');
    db.close();
  });

  it('adds the Claude bypass-permissions badge to live status', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Reviewing repository state…',
      '96% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'claude-screen',
      title: 'Conversation',
      kind: 'history',
    });

    const liveScreen = await manager.getSessionScreen(session.id);
    expect(liveScreen?.screen.status).toContain('bypass permissions on');
    expect(liveScreen?.screen.status).toContain('96% left');
    db.close();
  });

  it('emits visible screen updates when bound session output changes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Thinking about the repository…',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    const events: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        events.push(event.screen.content);
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-screen-events',
      title: 'Conversation',
      kind: 'history',
    });

    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Thinking about the repository…',
      'Applying patch now…',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    await manager.sendInput(session.id, 'continue');

    expect(events.at(-1)).toContain('Applying patch now…');
    unsubscribe();
    db.close();
  });

  it('tracks completion recency only after the screen leaves Working', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Reviewing repository state…',
      '• Working (20s • esc to interrupt)',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    const workingStates: Array<{ isWorking?: boolean; lastCompletedAt?: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.updated') {
        workingStates.push({
          isWorking: event.session.isWorking,
          lastCompletedAt: event.session.lastCompletedAt,
        });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-working-recency',
      title: 'Conversation',
      kind: 'history',
    });

    expect(db.getBoundSessionById(session.id)?.isWorking).toBe(true);
    expect(db.getBoundSessionById(session.id)?.attentionState).toBe('working');
    expect(db.getBoundSessionById(session.id)?.lastCompletedAt).toBeUndefined();

    tmux.captureSequence = [[
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n')];

    await manager.sendInput(session.id, 'continue');

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.attentionState).toBe('idle');
    expect(updated?.lastCompletedAt).toBeTruthy();
    expect(workingStates.some((state) => state.isWorking === true && !state.lastCompletedAt)).toBe(true);
    expect(workingStates.some((state) => state.isWorking === false && Boolean(state.lastCompletedAt))).toBe(true);
    unsubscribe();
    db.close();
  });

  it('repairs idle completion recency when newer output exists than the stored completion timestamp', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-idle-recency-repair',
      title: 'Conversation',
      kind: 'history',
    });

    const staleCompletion = new Date(Date.now() - 10 * 60_000).toISOString();
    const newerOutput = new Date(Date.now() - 30_000).toISOString();
    db.upsertBoundSession({
      ...session,
      isWorking: false,
      lastCompletedAt: staleCompletion,
      lastOutputAt: newerOutput,
    });

    await manager.getSessionScreen(session.id);

    expect(db.getBoundSessionById(session.id)?.lastCompletedAt).toBe(newerOutput);
    db.close();
  });

  it('backfills completion recency for already-idle sessions on first screen capture', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-idle-backfill',
      title: 'Conversation',
      kind: 'history',
    });

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.lastCompletedAt).toBeTruthy();
    db.close();
  });

  it('does not reactivate a stale Working screen when the output heartbeat is old', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Summary ready.',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-stale-working-screen',
      title: 'Conversation',
      kind: 'history',
    });

    const staleTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
    db.upsertBoundSession({
      ...session,
      isWorking: false,
      lastOutputAt: staleTimestamp,
      lastCompletedAt: staleTimestamp,
      lastActivityAt: staleTimestamp,
    });
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Investigating recency updates…',
      '• Working (9m 42s • esc to interrupt)',
      '',
      '› review current changes',
      'gpt-5.4 xhigh · 92% left · ~/demo',
    ].join('\n');

    await manager.getSessionScreen(session.id);

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.lastCompletedAt).toBe(staleTimestamp);
    db.close();
  });

  it('expires working sessions after the heartbeat goes cold even if the pane still shows Working', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Investigating recency updates…',
      '• Working (5s • esc to interrupt)',
      '',
      '› review current changes',
      'gpt-5.4 xhigh · 92% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-working-expiry',
      title: 'Conversation',
      kind: 'history',
    });

    expect(db.getBoundSessionById(session.id)?.isWorking).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 4_500));

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.isWorking).toBe(false);
    expect(updated?.attentionState).toBe('idle');
    expect(updated?.lastCompletedAt).toBeTruthy();
    db.close();
  }, 10_000);

  it('does not treat idle housekeeping output as fresh completion activity', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Review complete.',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'session-housekeeping-ignore',
      title: 'Conversation',
      kind: 'history',
    });

    const previousTimestamp = '2026-03-14T21:00:00.000Z';
    const tracked = db.getBoundSessionById(session.id)!;
    db.upsertBoundSession({
      ...tracked,
      updatedAt: previousTimestamp,
      lastActivityAt: previousTimestamp,
      lastOutputAt: undefined,
      lastCompletedAt: previousTimestamp,
      isWorking: false,
    });
    tmux.paneText = [
      'Claude Code',
      '',
      'Checking for updates',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    await fs.appendFile(tracked.rawLogPath!, 'Checking for updates\n');
    await new Promise((resolve) => setTimeout(resolve, 350));

    const updated = db.getBoundSessionById(session.id);
    expect(updated?.lastOutputAt).toBeUndefined();
    expect(updated?.lastCompletedAt).toBe(previousTimestamp);
    db.close();
  });

  it('repairs stale idle completion timestamps that were last advanced only by housekeeping output', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Review complete.',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'session-housekeeping-repair',
      title: 'Conversation',
      kind: 'history',
    });

    const meaningfulTimestamp = '2026-03-14T21:37:41.960Z';
    const housekeepingTimestamp = '2026-03-14T21:59:15.684Z';
    const tracked = db.getBoundSessionById(session.id)!;
    await fs.appendFile(tracked.eventLogPath!, `${JSON.stringify({
      type: 'raw-output',
      text: 'Real assistant output',
      timestamp: meaningfulTimestamp,
    })}\n`);
    await fs.appendFile(tracked.eventLogPath!, `${JSON.stringify({
      type: 'raw-output',
      text: 'Checking for updates',
      timestamp: housekeepingTimestamp,
    })}\n`);
    db.upsertBoundSession({
      ...tracked,
      updatedAt: housekeepingTimestamp,
      lastActivityAt: housekeepingTimestamp,
      lastOutputAt: housekeepingTimestamp,
      lastCompletedAt: housekeepingTimestamp,
      isWorking: false,
    });

    await manager.getSessionScreen(session.id);

    const repaired = db.getBoundSessionById(session.id);
    expect(repaired?.lastOutputAt).toBe(meaningfulTimestamp);
    expect(repaired?.lastCompletedAt).toBe(meaningfulTimestamp);
    db.close();
  });

  it('sends raw keystrokes directly to the tmux session without synthesizing chat input', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Select model',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-keys',
      title: 'Conversation',
      kind: 'history',
    });

    await manager.sendKeystrokes(session.id, { text: '3', keys: ['Enter'] });

    expect(tmux.sent).toEqual(['3']);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    db.close();
  });

  it('waits for pasted text to settle before sending Enter on combined submit keystrokes', async () => {
    class PasteAwareTmux extends FakeTmux {
      private pasteVisible = false;
      private submitted = false;
      private capturesSincePaste = 0;
      private readonly promptPrefix = [
        'Claude Code',
        '',
        'How is Claude doing this session? (optional)',
        '1: Bad    2: Fine   3: Good   0: Dismiss',
        '',
      ];

      constructor() {
        super();
        this.paneText = this.renderComposer('did yo');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.pasteVisible = false;
        this.capturesSincePaste = 0;
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        if (this.pasteVisible) {
          this.submitted = true;
          this.paneText = [
            ...this.promptPrefix,
            'Working through the request…',
            '• Working (1s • esc to interrupt)',
            '',
            '❯ ',
            '⏵⏵ bypass permissions on (shift+tab to cycle)',
          ].join('\n');
        }
      }

      override async capturePane(): Promise<string> {
        if (!this.submitted && this.sent.length > 0 && !this.pasteVisible) {
          this.capturesSincePaste += 1;
          if (this.capturesSincePaste >= 2) {
            this.pasteVisible = true;
            this.paneText = this.renderComposer('did yo[Pasted text #1 +58 lines]');
          }
        }
        return this.paneText;
      }

      private renderComposer(input: string): string {
        return [
          ...this.promptPrefix,
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new PasteAwareTmux();
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ inputText: string; content: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ inputText: event.screen.inputText, content: event.screen.content });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-paste-submit',
      title: 'Conversation',
      kind: 'history',
    });

    screens.length = 0;
    await manager.sendKeystrokes(session.id, {
      text: 'run this review request',
      keys: ['Enter'],
    });

    expect(tmux.sent).toEqual(['run this review request']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    expect(screens.some((screen) => screen.inputText === 'did yo[Pasted text #1 +58 lines]')).toBe(true);
    expect(screens.at(-1)?.inputText).toBe('');
    expect(`${screens.at(-1)?.content ?? ''}`).toContain('Working through the request…');
    unsubscribe();
    db.close();
  });

  it('accepts Claude pasted-text placeholders rendered on companion lines before submitting', async () => {
    class ClaudeCompanionPasteTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = this.renderComposer();
      }

      override async pasteText(_sessionName: string, text: string): Promise<void> {
        this.pasted.push(text);
        this.sent.push(text);
        this.paneText = this.renderComposer('⎿ [Pasted text #1 +58 lines]');
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        this.paneText = [
          'Claude Code',
          '',
          'Running the pasted request…',
          '• Working (1s • esc to interrupt)',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      private renderComposer(pastedPlaceholder?: string): string {
        return [
          'Claude Code',
          '',
          'Ready for input.',
          '',
          '❯ ',
          ...(pastedPlaceholder ? [pastedPlaceholder] : []),
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new ClaudeCompanionPasteTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'session-claude-companion-paste',
      title: 'Conversation',
      kind: 'history',
    });

    await manager.sendKeystrokes(session.id, {
      text: 'line one\nline two',
      keys: ['Enter'],
    });

    expect(tmux.pasted).toEqual(['line one\nline two']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    db.close();
  });

  it('uses bracketed paste for long submitted input', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-long-input',
      title: 'Conversation',
      kind: 'history',
    });

    const longText = 'A'.repeat(1300);
    await manager.sendInput(session.id, longText);

    expect(tmux.pasted).toEqual([longText]);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    db.close();
  });

  it('uses bracketed paste for long bridge text before the submit key', async () => {
    class LongComposerTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          '❯ draft',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          `❯ ${this.sent.join('')}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      override async pasteText(_sessionName: string, text: string): Promise<void> {
        this.pasted.push(text);
        this.sent.push(text);
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          `❯ ${text}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        this.paneText = [
          'OpenAI Codex',
          '',
          'Working through the request…',
          '• Working (1s • esc to interrupt)',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new LongComposerTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-long-keystrokes',
      title: 'Conversation',
      kind: 'history',
    });

    const longText = 'follow-up '.repeat(180);
    await manager.sendKeystrokes(session.id, { text: longText, keys: ['Enter'] });

    expect(tmux.pasted).toEqual([longText]);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    db.close();
  });

  it('opens the Codex composer before applying a large text-only paste', async () => {
    class QueueMessagePasteTmux extends FakeTmux {
      private stage: 'queue' | 'composer' | 'pasted' = 'queue';

      constructor() {
        super();
        this.paneText = this.renderQueue();
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Tab')) {
          return;
        }
        this.stage = 'composer';
        this.paneText = this.renderComposer('');
      }

      override async pasteText(_sessionName: string, text: string): Promise<void> {
        this.pasted.push(text);
        this.stage = 'pasted';
        this.paneText = this.renderComposer(text);
      }

      private renderQueue(): string {
        return [
          'OpenAI Codex',
          '',
          'Ready when you are.',
          'Tab to queue message',
          'gpt-5.4 xhigh · 88% left · ~/demo',
        ].join('\n');
      }

      private renderComposer(input: string): string {
        return [
          'OpenAI Codex',
          '',
          'Ready when you are.',
          '',
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new QueueMessagePasteTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-queue-paste',
      title: 'Conversation',
      kind: 'history',
    });

    const longText = `${'deep context '.repeat(80)}\n${'follow-up '.repeat(40)}`;
    await manager.sendKeystrokes(session.id, { text: longText });

    expect(tmux.sentKeys).toContainEqual(['Tab']);
    expect(tmux.pasted).toEqual([longText]);
    db.close();
  });

  it('stages very large submitted bridge text into a file-backed instruction', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    class StagedInputTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = this.renderComposer('');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.paneText = this.renderComposer(text);
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        this.paneText = [
          'OpenAI Codex',
          '',
          'Working through the staged prompt…',
          '• Working (1s • esc to interrupt)',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      private renderComposer(input: string): string {
        return [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tmux = new StagedInputTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-file-backed-live-input',
      title: 'Conversation',
      kind: 'history',
    });

    const veryLongText = 'long prompt content '.repeat(220);
    await manager.sendKeystrokes(session.id, { text: veryLongText, keys: ['Enter'] });

    expect(tmux.pasted).toEqual([]);
    expect(tmux.sent).toHaveLength(1);
    const stagedMessage = tmux.sent[0];
    expect(stagedMessage).toBeTruthy();
    if (!stagedMessage) {
      throw new Error('Expected staged bridge instruction');
    }
    expect(stagedMessage).toContain('Read and follow the full user prompt saved at');
    expect(stagedMessage).toContain('Treat the file contents as the user\'s latest message before replying.');
    const stagedPathMatch = stagedMessage.match(/"([^"]+bridge-inputs[^"]+\.md)"/);
    expect(stagedPathMatch?.[1]).toBeTruthy();
    const stagedPath = stagedPathMatch?.[1];
    if (!stagedPath) {
      throw new Error('Expected staged file path in bridge instruction');
    }
    expect(await fs.readFile(stagedPath, 'utf8')).toBe(veryLongText);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    db.close();
  });

  it('waits long enough for slower pasted text repaints before sending Enter', async () => {
    class SlowPasteAwareTmux extends FakeTmux {
      private pasteVisible = false;
      private submitted = false;
      private capturesSincePaste = 0;
      private readonly promptPrefix = [
        'Claude Code',
        '',
        'How is Claude doing this session? (optional)',
        '1: Bad    2: Fine   3: Good   0: Dismiss',
        '',
      ];

      constructor() {
        super();
        this.paneText = this.renderComposer('draft');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.pasteVisible = false;
        this.capturesSincePaste = 0;
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        if (this.pasteVisible) {
          this.submitted = true;
          this.paneText = [
            ...this.promptPrefix,
            'Running the slower paste submit…',
            '• Working (1s • esc to interrupt)',
            '',
            '❯ ',
            '⏵⏵ bypass permissions on (shift+tab to cycle)',
          ].join('\n');
        }
      }

      override async capturePane(): Promise<string> {
        if (!this.submitted && this.sent.length > 0 && !this.pasteVisible) {
          this.capturesSincePaste += 1;
          if (this.capturesSincePaste >= 19) {
            this.pasteVisible = true;
            this.paneText = this.renderComposer('draft[Pasted text #1 +58 lines]');
          }
        }
        return this.paneText;
      }

      private renderComposer(input: string): string {
        return [
          ...this.promptPrefix,
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new SlowPasteAwareTmux();
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ inputText: string; content: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ inputText: event.screen.inputText, content: event.screen.content });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-slow-paste-submit',
      title: 'Conversation',
      kind: 'history',
    });

    screens.length = 0;
    await manager.sendKeystrokes(session.id, {
      text: 'large pasted request content that takes longer than the initial repaint budget to appear in the composer',
      keys: ['Enter'],
    });

    expect(tmux.sentKeys).toContainEqual(['Enter']);
    expect(screens.some((screen) => screen.inputText === 'draft[Pasted text #1 +58 lines]')).toBe(true);
    expect(screens.at(-1)?.inputText).toBe('');
    expect(`${screens.at(-1)?.content ?? ''}`).toContain('Running the slower paste submit…');
    unsubscribe();
    db.close();
  });

  it('waits for Codex queue-message mode and opens the composer before typing into a fresh session', async () => {
    class QueueMessageCodexTmux extends FakeTmux {
      private captureCount = 0;
      private stage: 'starting' | 'queue' | 'composer' | 'typed' | 'submitted' = 'starting';

      constructor() {
        super();
        this.paneText = this.renderStarting();
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        expect(this.stage).toBe('composer');
        this.stage = 'typed';
        this.paneText = this.renderComposer(text);
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (keys.includes('Tab')) {
          expect(this.stage).toBe('queue');
          this.stage = 'composer';
          this.paneText = this.renderComposer('');
          return;
        }
        if (keys.includes('Enter')) {
          expect(this.stage).toBe('typed');
          this.stage = 'submitted';
          this.paneText = [
            'OpenAI Codex',
            '',
            'Working through the queued follow-up…',
            '• Working (1s • esc to interrupt)',
            'gpt-5.4 xhigh · 37% left · ~/demo',
          ].join('\n');
        }
      }

      override async capturePane(): Promise<string> {
        this.captureCount += 1;
        if (this.stage === 'starting' && this.captureCount >= 3) {
          this.stage = 'queue';
          this.paneText = this.renderQueue();
        }
        return this.paneText;
      }

      private renderStarting(): string {
        return [
          'OpenAI Codex',
          '',
          'Starting MCP servers (0/3): chrome-devtools, codex_apps, playwright',
        ].join('\n');
      }

      private renderQueue(): string {
        return [
          'OpenAI Codex',
          '',
          'Resumed conversation.',
          '',
          'tab to queue message                                        37% context left',
        ].join('\n');
      }

      private renderComposer(input: string): string {
        return [
          'OpenAI Codex',
          '',
          'Resumed conversation.',
          '',
          `› ${input}`,
          'gpt-5.4 xhigh · 37% left · ~/demo',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new QueueMessageCodexTmux();
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ inputText: string; status: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ inputText: event.screen.inputText, status: event.screen.status });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-queue-message',
      title: 'Conversation',
      kind: 'history',
    });

    screens.length = 0;
    await manager.sendKeystrokes(session.id, {
      text: 'follow up on the failed Vite restart',
      keys: ['Enter'],
    });

    expect(tmux.sent).toEqual(['follow up on the failed Vite restart']);
    expect(tmux.sentKeys).toContainEqual(['Tab']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    expect(screens.some((screen) => screen.inputText === 'follow up on the failed Vite restart')).toBe(true);
    expect(screens.at(-1)?.status).toContain('37% left');
    unsubscribe();
    db.close();
  });

  it('rejects combined submit keystrokes when typed text never lands in the live input buffer', async () => {
    class InputRejectingTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = [
          'OpenAI Codex',
          '',
          '1. review the issue',
          '2. patch the behavior',
          '3. rerun the targeted tests',
          '',
          'Message: fix live session reliability and sidebar state',
          '',
          'I left the unrelated local edits in localhost-proxy.ts and vite.config.ts',
          'unstaged and out of this commit.',
          '',
          '› Run /review on my current changes',
          '',
          '  Message: fix live session reliability and sidebar state',
          '',
          '  I left the unrelated local edits in localhost-proxy.ts and vite.config.ts',
          '  unstaged and out of this commit.',
          'gpt-5.4 xhigh · 65% left · ~/demo',
        ].join('\n');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.paneText = [
          'OpenAI Codex',
          '',
          'Message: fix live session reliability and sidebar state',
          '',
          'I left the unrelated local edits in localhost-proxy.ts and vite.config.ts',
          'unstaged and out of this commit.',
          '',
          text,
          'gpt-5.4 xhigh · 65% left · ~/demo',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new InputRejectingTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-input-rejected',
      title: 'Conversation',
      kind: 'history',
    });

    await expect(manager.sendKeystrokes(session.id, {
      text: 'this should stay local until the session accepts input',
      keys: ['Enter'],
    })).rejects.toThrow(SessionKeystrokeRejectedError);
    expect(tmux.sentKeys).toEqual([]);
    db.close();
  });

  it('waits for a visible screen change after special-key input before emitting the update', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      '  1. Default',
      '❯ 2. Sonnet',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ content: string; status: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ content: event.screen.content, status: event.screen.status });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-key-change',
      title: 'Conversation',
      kind: 'history',
    });

    tmux.captureSequence = [
      tmux.paneText,
      [
        'Claude Code',
        '',
        '  1. Default',
        '  2. Sonnet',
        '❯ 3. Haiku',
        'Enter to confirm · Esc to exit',
      ].join('\n'),
    ];

    await manager.sendKeystrokes(session.id, { keys: ['Down'] });

    expect(tmux.sentKeys).toContainEqual(['Down']);
    expect(`${screens.at(-1)?.content ?? ''}\n${screens.at(-1)?.status ?? ''}`).toContain('❯ 3. Haiku');
    unsubscribe();
    db.close();
  });

  it('publishes the settled post-keystroke screen even when the immediate wait window misses the repaint', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const initialScreen = [
      'Claude Code',
      '',
      'Draft prompt still in composer',
      '› summarize the timing bug',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    const settledScreen = [
      'Claude Code',
      '',
      'Working through the timing bug…',
      '• Working (2s • esc to interrupt)',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    tmux.paneText = initialScreen;
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ inputText: string; content: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ inputText: event.screen.inputText, content: event.screen.content });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-key-settled-screen',
      title: 'Conversation',
      kind: 'history',
    });

    screens.length = 0;
    tmux.captureSequence = [
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      settledScreen,
    ];

    await manager.sendKeystrokes(session.id, { keys: ['Enter'] });

    expect(screens.at(-1)?.inputText).toBe('');
    expect(`${screens.at(-1)?.content ?? ''}`).toContain('Working through the timing bug…');
    unsubscribe();
    db.close();
  });

  it('launches pending sessions with an initial prompt argument when requested', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:launch-arg',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'New conversation',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
      rawMetadata: { pending: true },
    });
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:launch-arg',
      title: 'New conversation',
      kind: 'pending',
      initialPrompt: 'Reply with exactly: smoke-token',
    });

    expect(tmux.createdCommands[0]).toContain('Reply with exactly: smoke-token');
    expect(db.getPendingConversation('pending:launch-arg')?.rawMetadata?.lastUserInputHash).toBeTruthy();
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('"type":"user-input"');
    db.close();
  });

  it('records pending-session first input when the live bridge submits text through keystrokes', async () => {
    class PendingComposerTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          `❯ ${text}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        this.paneText = [
          'OpenAI Codex',
          '',
          'Working through the request…',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:keystroke-first-turn',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'New conversation',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
      rawMetadata: { pending: true },
    });
    const tmux = new PendingComposerTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:keystroke-first-turn',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.sendKeystrokes(session.id, { text: 'yes i trust it', keys: ['Enter'] });

    expect(tmux.sent).toEqual(['yes i trust it']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    expect(db.getPendingConversation('pending:keystroke-first-turn')?.rawMetadata?.lastUserInputHash).toBeTruthy();
    expect(db.getPendingConversation('pending:keystroke-first-turn')?.rawMetadata?.lastUserInputPreview).toBe('yes i trust it');
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('"type":"user-input"');
    db.close();
  });

  it('forces color output for tmux-launched provider sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'conv-color',
      title: 'Color session',
      kind: 'history',
    });

    expect(tmux.createdCommands[0]).toContain('unset CLAUDECODE NO_COLOR');
    expect(tmux.createdCommands[0]).toContain("export FORCE_COLOR='1'");
    expect(tmux.createdCommands[0]).toContain("export CLICOLOR_FORCE='1'");
    db.close();
  });
});
