import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionInputRejectedError, SessionKeystrokeRejectedError, SessionManager } from '../src/sessions/session-manager.js';
import { TmuxError } from '../src/sessions/tmux-client.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

describe('SessionManager lifecycle', () => {
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
    const ended = db.boundSessions.getById(session.id);
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

    expect(db.boundSessions.list()).toHaveLength(1);
    expect(db.boundSessions.list()[0]?.status).toBe('error');
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

  it('leaves a bound session unchanged when tmux liveness is unknown', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-transient-liveness',
      title: 'Conversation',
      kind: 'history',
    });
    tmux.hasSessionResults.push(new Error('tmux timed out'));

    const checked = await manager.ensureSession(session.id);

    expect(checked?.id).toBe(session.id);
    expect(checked?.status).toBe('bound');
    expect(db.boundSessions.getById(session.id)?.status).toBe('bound');
    expect(tmux.created).toHaveLength(1);
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
    db.pendingConversations.put({
      ref: 'pending:restore-me',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'Pending conversation',
      createdAt: '2026-03-14T17:00:00.000Z',
      updatedAt: '2026-03-14T18:00:20.000Z',
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
    expect(db.pendingConversations.get('pending:restore-me')?.rawMetadata?.adoptedConversationRef).toBe('real-restored');
    expect(tmux.createdCommands.at(-1)).toContain("'codex' 'resume' 'real-restored'");
    db.close();
  });

  it('leaves pending sessions unrestored when no resumable conversation can be resolved yet', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    db.pendingConversations.put({
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
    expect(db.boundSessions.getById(session.id)?.status).toBe('error');
    expect(db.boundSessions.getById(session.id)?.shouldRestore).toBe(true);
    db.close();
  });

  it('observes dead restorable sessions without relaunching them', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history:lazy',
      title: 'Lazy restore',
      kind: 'history',
    });
    tmux.alive.clear();

    await manager.observeSessions();

    expect(tmux.created).toHaveLength(1);
    expect(db.boundSessions.getById(session.id)?.status).toBe('bound');
    expect(db.boundSessions.getById(session.id)?.shouldRestore).toBe(true);

    const restored = await manager.ensureSession(session.id);

    expect(restored?.id).toBe(session.id);
    expect(tmux.created).toHaveLength(2);
    db.close();
  });

  it('actively reconciles dead restorable sessions by restoring them', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history:reconcile',
      title: 'Reconcile restore',
      kind: 'history',
    });
    tmux.alive.clear();

    await manager.reconcileSessions();

    expect(db.boundSessions.getById(session.id)?.status).toBe('bound');
    expect(tmux.created).toHaveLength(2);
    db.close();
  });

  it('keeps repeated restore failures from refreshing session recency or duplicating status events', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const recoveryProviderSettings = { ...providerSettings, enabled: true as boolean };
    const manager = createRecoveryManager(
      db,
      tmux,
      path.join(tempDir, 'runtime'),
      new RealtimeEventBus(),
      provider,
      recoveryProviderSettings,
    );

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history:reconcile-failure',
      title: 'Reconcile failure',
      kind: 'history',
    });
    tmux.alive.clear();
    tmux.failPipePane = true;

    await manager.reconcileSessions();
    const firstFailure = db.boundSessions.getById(session.id);
    const firstEventLog = await fs.readFile(firstFailure?.eventLogPath ?? '', 'utf8');

    await manager.reconcileSessions();
    const secondFailure = db.boundSessions.getById(session.id);
    const secondEventLog = await fs.readFile(secondFailure?.eventLogPath ?? '', 'utf8');

    expect(firstFailure?.status).toBe('error');
    expect(secondFailure?.status).toBe('error');
    expect(secondFailure?.updatedAt).toBe(firstFailure?.updatedAt);
    expect(secondEventLog).toBe(firstEventLog);
    expect(tmux.created).toHaveLength(3);

    recoveryProviderSettings.enabled = false;
    await manager.reconcileSessions();
    const changedFailure = db.boundSessions.getById(session.id);
    const changedEventLog = await fs.readFile(changedFailure?.eventLogPath ?? '', 'utf8');

    expect(changedFailure?.updatedAt).toBe(firstFailure?.updatedAt);
    expect(changedEventLog).toContain('Failed to restore session: provider is disabled.');
    expect(changedEventLog.length).toBeGreaterThan(secondEventLog.length);
    db.close();
  });

  it('rejects input without recording activity when tmux disappears during the write', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    class VanishingTmux extends FakeTmux {
      override async sendLiteralText(sessionName: string, _text: string): Promise<void> {
        this.alive.delete(sessionName);
        throw new TmuxError(
          `can't find session: ${sessionName}`,
          ['send-keys', '-t', sessionName],
          1,
          `can't find session: ${sessionName}`,
        );
      }
    }
    const tmux = new VanishingTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history:vanishing-input',
      title: 'Vanishing input',
      kind: 'history',
    });

    await expect(manager.sendInput(session.id, 'Hello agent')).rejects.toThrow(SessionInputRejectedError);
    const failed = db.boundSessions.getById(session.id);
    expect(failed?.status).toBe('error');
    expect(failed?.lastActivityAt).toBeUndefined();
    db.close();
  });

  it('marks dead pending sessions with user input as not live during passive observation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    db.pendingConversations.put({
      ref: 'pending:submitted-dead',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'Submitted pending conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:01:00.000Z',
      isBound: true,
      boundSessionId: 'placeholder',
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'submitted-hash',
      },
    });

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:submitted-dead',
      title: 'Submitted pending conversation',
      kind: 'pending',
    });
    tmux.alive.clear();

    await manager.observeSessions();

    const observed = db.boundSessions.getById(session.id);
    const pending = db.pendingConversations.get('pending:submitted-dead');
    expect(observed?.status).toBe('error');
    expect(observed?.shouldRestore).toBe(true);
    expect(pending?.isBound).toBe(false);
    expect(pending?.updatedAt).toBe('2026-03-14T18:01:00.000Z');
    expect(tmux.created).toHaveLength(1);
    db.close();
  });

  it('abandons dead zero-turn pending sessions during passive observation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    db.pendingConversations.put({
      ref: 'pending:zero-turn-observed',
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
      conversationRef: 'pending:zero-turn-observed',
      title: 'Pending conversation',
      kind: 'pending',
    });
    tmux.alive.clear();

    await manager.observeSessions();

    expect(db.boundSessions.getById(session.id)?.status).toBe('ended');
    expect(db.boundSessions.getById(session.id)?.shouldRestore).toBe(false);
    expect(db.pendingConversations.get('pending:zero-turn-observed')?.isBound).toBe(false);
    expect(tmux.created).toHaveLength(1);
    db.close();
  });

  it('abandons dead zero-turn pending sessions instead of keeping them durably bound', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    db.pendingConversations.put({
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
    expect(db.boundSessions.getById(session.id)?.status).toBe('ended');
    expect(db.boundSessions.getById(session.id)?.shouldRestore).toBe(false);
    expect(db.pendingConversations.get('pending:zero-turn')?.isBound).toBe(false);
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
    expect(db.boundSessions.getById(session.id)?.status).toBe('error');
    db.close();
  });

  it('closes tmux raw-log pipes on shutdown without killing restorable sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-shutdown-pipe-cleanup',
      title: 'Conversation',
      kind: 'history',
    });

    await manager.stop();

    expect(tmux.closedPipes).toEqual([session.tmuxSessionName]);
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    expect(db.boundSessions.getById(session.id)?.status).toBe('bound');
    db.close();
  });

  it('reattaches raw-log pipes when refreshing already-live sessions after restart', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const firstManager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await firstManager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-restart-pipe-reattach',
      title: 'Conversation',
      kind: 'history',
    });
    await firstManager.stop();
    const pipeCountAfterShutdown = tmux.pipedToFiles.length;
    const recoveredManager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const refreshed = await recoveredManager.ensureSession(session.id);

    expect(refreshed?.status).toBe('bound');
    expect(tmux.pipedToFiles).toHaveLength(pipeCountAfterShutdown + 1);
    expect(tmux.pipedToFiles.at(-1)).toEqual({
      sessionName: session.tmuxSessionName,
      filePath: session.rawLogPath,
    });
    await recoveredManager.stop();
    db.close();
  });

});
