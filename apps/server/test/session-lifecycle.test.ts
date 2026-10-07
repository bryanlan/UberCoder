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

function backdateFinishedSession(db: AppDatabase, sessionId: string, minutesAgo: number): void {
  const finishedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.sqlite.prepare(`
    update bound_sessions
    set started_at = ?, updated_at = ?, last_activity_at = ?, last_output_at = ?,
        last_completed_at = ?, last_response_at = ?, is_working = 0
    where id = ?
  `).run(finishedAt, finishedAt, finishedAt, finishedAt, finishedAt, finishedAt, sessionId);
}

function addCoordinationAssignment(db: AppDatabase, session: { provider: string; conversationRef: string }, status: 'active' | 'waiting'): void {
  const now = new Date().toISOString();
  db.sqlite.prepare(`
    insert into coordination_assignments (
      id, provider, native_session_id, token_hash, description, status, pid,
      process_start, started_at, last_seen_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('assignment-1', session.provider, session.conversationRef, 'token-hash', 'Unfinished work',
    status, 123, 'process-start', now, now);
}

describe('SessionManager lifecycle', () => {
  it('restarts an idle Codex session with the selected cost profile', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n› \ngpt-5.6-sol medium · 98% left · ~/demo';
    const profileProvider: ProviderAdapter = {
      ...provider,
      getLaunchCommand(_project, conversationRef, _settings, options) {
        return {
          cwd: '/srv/demo',
          argv: ['codex', options?.codexProfile ?? 'unprofiled', 'resume', conversationRef ?? ''],
          env: {},
        };
      },
    };
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus(), profileProvider);
    const session = await manager.bindConversation({
      project,
      provider: profileProvider,
      providerSettings,
      conversationRef: 'history-profile-test',
      title: 'Profile test',
      kind: 'history',
    });

    const accepted = await manager.requestModelProfile(session.id, 'high');

    expect(accepted.session.modelProfileRequest).toMatchObject({ profile: 'high', state: 'queued' });
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest).toBeUndefined();
    expect(db.boundSessions.getById(session.id)?.modelProfileRequest).toBeUndefined();
    expect(tmux.created).toHaveLength(2);
    expect(tmux.createdCommands.at(-1)).toContain('high');
    db.close();
  });

  it('keeps the original Codex session bound when a profile-switch kill fails', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n› \ngpt-5.6-sol medium · 98% left · ~/demo';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history-profile-kill-failure',
      title: 'Profile test',
      kind: 'history',
    });

    tmux.failKill = true;
    await manager.requestModelProfile(session.id, 'high');

    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest?.state).toBe('failed');

    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    expect(tmux.created).toHaveLength(1);
    expect(db.boundSessions.getById(session.id)).toMatchObject({
      status: 'bound',
      codexProfile: undefined,
      modelProfileRequest: expect.objectContaining({ state: 'failed', profile: 'high' }),
    });
    db.close();
  });

  it('does not launch or kill another process when liveness is unknown after a failed profile-switch kill', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n› \ngpt-5.6-sol medium · 98% left · ~/demo';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history-profile-unknown-after-kill',
      title: 'Profile test',
      kind: 'history',
    });

    tmux.failKill = true;
    tmux.hasSessionResults.push(true, new Error('tmux unavailable'));
    await manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest?.state).toBe('failed');

    expect(tmux.created).toHaveLength(1);
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    expect(db.boundSessions.getById(session.id)).toMatchObject({
      status: 'error',
      codexProfile: undefined,
      modelProfileRequest: expect.objectContaining({ state: 'failed', profile: 'high' }),
    });
    await manager.stop();
    db.close();
  });

  it('reports an error and removes a partial process when both a profile switch and rollback fail', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n› \ngpt-5.6-sol medium · 98% left · ~/demo';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history-profile-rollback-failure',
      title: 'Profile test',
      kind: 'history',
    });

    tmux.failPipePane = true;
    await manager.requestModelProfile(session.id, 'high');
    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest?.state).toBe('failed');

    expect(tmux.created).toHaveLength(3);
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(false);
    expect(db.boundSessions.getById(session.id)).toMatchObject({
      status: 'error',
      codexProfile: undefined,
      modelProfileRequest: expect.objectContaining({ state: 'failed', profile: 'high' }),
    });
    await manager.stop();
    db.close();
  });

  it('selects a Codex profile for the existing first-turn prompt restart', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · /tmp';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:first-profile',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.requestModelProfile(session.id, 'high');

    await expect.poll(() => db.boundSessions.getById(session.id)?.modelProfileRequest).toBeUndefined();
    expect(db.boundSessions.getById(session.id)?.codexProfile).toBe('high');
    expect(db.boundSessions.getById(session.id)?.modelProfileRequest).toBeUndefined();
    expect(tmux.created).toHaveLength(1);
    await manager.stop();
    db.close();
  });

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

  it('auto-tracks unique indexed conversations with failure isolation and separate provenance', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const recentConversation = {
      ref: 'recent-external-conversation',
      kind: 'history' as const,
      projectSlug: 'demo',
      provider: 'codex' as const,
      title: 'Recent external conversation',
      updatedAt: '2026-03-07T07:00:00.000Z',
      isBound: false,
      degraded: false,
    };

    const result = await manager.autoTrackConversations([
      recentConversation,
      recentConversation,
      { ...recentConversation, ref: 'missing-project-conversation', projectSlug: 'missing' },
    ], '2026-03-07T08:00:00.000Z');

    expect(result.attempted).toBe(2);
    expect(result.tracked).toHaveLength(1);
    expect(result.failed).toEqual([expect.objectContaining({
      projectSlug: 'missing',
      conversationRef: 'missing-project-conversation',
      error: 'Project not found.',
    })]);
    expect(tmux.created).toHaveLength(1);
    expect(db.boundSessions.getById(result.tracked[0]!.id)).toMatchObject({
      conversationRef: 'recent-external-conversation',
      resumeConversationRef: 'recent-external-conversation',
      autoTrackedAt: '2026-03-07T08:00:00.000Z',
      lastActivityAt: undefined,
      lastCompletedAt: undefined,
    });
    db.close();
  });

  it('keeps auto-track launch concurrency global across concurrent refresh calls', async () => {
    class SlowLaunchTmux extends FakeTmux {
      activeLaunches = 0;
      maxActiveLaunches = 0;

      override async newDetachedSession(sessionName: string, cwd: string, shellCommand: string): Promise<void> {
        this.activeLaunches += 1;
        this.maxActiveLaunches = Math.max(this.maxActiveLaunches, this.activeLaunches);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          await super.newDetachedSession(sessionName, cwd, shellCommand);
        } finally {
          this.activeLaunches -= 1;
        }
      }

      override async pipePaneToFile(sessionName: string, filePath: string): Promise<void> {
        await super.pipePaneToFile(sessionName, filePath);
        await fs.writeFile(filePath, 'ready');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new SlowLaunchTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const conversation = (ref: string) => ({
      ref,
      kind: 'history' as const,
      projectSlug: 'demo',
      provider: 'codex' as const,
      title: ref,
      updatedAt: '2026-03-07T07:00:00.000Z',
      isBound: false,
      degraded: false,
    });

    await Promise.all([
      manager.autoTrackConversations([conversation('first'), conversation('second')], '2026-03-07T08:00:00.000Z'),
      manager.autoTrackConversations([conversation('third'), conversation('fourth')], '2026-03-07T08:00:00.000Z'),
    ]);

    expect(tmux.created).toHaveLength(4);
    expect(tmux.maxActiveLaunches).toBeLessThanOrEqual(2);
    db.close();
  });

  it('coalesces concurrent binds for the same provider conversation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const input = {
      project,
      provider,
      providerSettings,
      conversationRef: 'concurrent-bind',
      title: 'Concurrent bind',
      kind: 'history' as const,
    };

    const [first, second] = await Promise.all([
      manager.bindConversation(input),
      manager.bindConversation({ ...input, autoTrackedAt: '2026-03-07T08:00:00.000Z' }),
    ]);

    expect(first.id).toBe(second.id);
    expect(second.autoTrackedAt).toBe('2026-03-07T08:00:00.000Z');
    expect(db.boundSessions.getById(first.id)?.autoTrackedAt).toBe('2026-03-07T08:00:00.000Z');
    expect(tmux.created).toHaveLength(1);
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

  it('does not report a bind as successful when the provider exits during startup', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    class ExitingTmux extends FakeTmux {
      override async newDetachedSession(sessionName: string, cwd: string, shellCommand: string): Promise<void> {
        await super.newDetachedSession(sessionName, cwd, shellCommand);
        this.alive.delete(sessionName);
      }
    }
    const tmux = new ExitingTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    await expect(manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-exits-during-bind',
      title: 'Exited bind',
      kind: 'history',
    })).rejects.toThrow('Provider session exited during startup.');

    const failed = db.boundSessions.list()[0];
    expect(failed?.status).toBe('error');
    expect(failed?.shouldRestore).toBe(false);
    const eventLog = await fs.readFile(failed?.eventLogPath ?? '', 'utf8');
    expect(eventLog).not.toContain('Bound codex session');
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

  it('records one restore failure when the provider exits during startup', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    class ExitingRestoreTmux extends FakeTmux {
      private launchCount = 0;

      override async newDetachedSession(sessionName: string, cwd: string, shellCommand: string): Promise<void> {
        await super.newDetachedSession(sessionName, cwd, shellCommand);
        this.launchCount += 1;
        if (this.launchCount > 1) {
          this.alive.delete(sessionName);
        }
      }
    }
    const tmux = new ExitingRestoreTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-exits-during-restore',
      title: 'Exited restore',
      kind: 'history',
    });
    tmux.alive.clear();

    await expect(manager.getSessionScreen(session.id)).resolves.toBeUndefined();
    await expect(manager.getSessionScreen(session.id)).resolves.toBeUndefined();

    expect(tmux.created).toHaveLength(2);
    expect(db.boundSessions.getById(session.id)?.status).toBe('error');
    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    expect(eventLog).not.toContain('Restored bound session.');
    expect(eventLog.match(/Provider session exited during startup\./g)).toHaveLength(1);
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

  it('suspends idle history sessions during reconciliation while keeping them restorable', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history:idle-suspend',
      title: 'Idle suspend',
      kind: 'history',
    });
    const beforeRelease = new Date(Date.now() - 215 * 60 * 60 * 1000).toISOString();
    db.boundSessions.upsert({
      ...db.boundSessions.getById(session.id)!,
      lastActivityAt: beforeRelease,
      lastOutputAt: beforeRelease,
      lastCompletedAt: beforeRelease,
      isWorking: false,
    });
    // started_at is insert-only in the repo; backdate it directly.
    db.sqlite.prepare('update bound_sessions set started_at = ? where id = ?').run(beforeRelease, session.id);

    await manager.reconcileSessions();

    const suspended = db.boundSessions.getById(session.id);
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(false);
    expect(suspended?.status).toBe('bound');
    expect(suspended?.shouldRestore).toBe(true);

    // Repeated reconciliation must not resurrect the suspended session.
    await manager.reconcileSessions();
    expect(tmux.created).toHaveLength(1);
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(false);

    // Selecting the conversation restores on demand, and the restore grace keeps
    // the reaper from immediately re-suspending it.
    const restored = await manager.ensureSession(session.id);
    expect(restored?.id).toBe(session.id);
    expect(tmux.created).toHaveLength(2);

    await manager.reconcileSessions();
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    db.close();
  });

  it.each([
    'gpt-5.6-sol medium · 98% left · ~/demo',
    'GPT-6.1-Sol xhigh fast · ~/code/Omnilearner · Ass…  ⚠ 2 warnings · f2 to view',
  ])('keeps manual suspension stopped and resumes on request with footer %s', async (footer) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = `OpenAI Codex\n\nCompleted response.\n› Ask Codex to do anything\n${footer}`;
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:manual-suspend', title: 'Manual suspend', kind: 'history',
    });

    const suspended = await manager.suspendSession(session.id);
    expect(suspended.manualSuspendedAt).toBeTruthy();
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(false);
    await manager.reconcileSessions();
    expect(tmux.created).toHaveLength(1);

    const resumed = await manager.resumeSession(session.id);
    expect(resumed.manualSuspendedAt).toBeUndefined();
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    await manager.stop();
    db.close();
  });

  it.each(['active', 'waiting'] as const)('checks manual suspension with coordination status %s', async (status) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n\nCompleted response.\n› Ask Codex to do anything\nGPT-6.1-Sol xhigh fast · ~/demo';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:manual-assignment', title: 'Assigned', kind: 'history',
    });
    addCoordinationAssignment(db, session, status);

    if (status === 'active') {
      await expect(manager.suspendSession(session.id)).rejects.toThrow('active coordination assignment');
      expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
      expect(db.boundSessions.getById(session.id)?.manualSuspendedAt).toBeUndefined();
    } else {
      const suspended = await manager.suspendSession(session.id);
      expect(suspended.manualSuspendedAt).toBeTruthy();
      expect(suspended.shouldRestore).toBe(true);
      expect(tmux.alive.has(session.tmuxSessionName)).toBe(false);
      await manager.resumeSession(session.id);
      expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
      expect(db.boundSessions.getById(session.id)?.manualSuspendedAt).toBeUndefined();

      tmux.paneText = 'OpenAI Codex\n› unsent draft\nGPT-6.1-Sol xhigh fast · ~/demo';
      await expect(manager.suspendSession(session.id)).rejects.toThrow('The provider is busy');
      expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);

      tmux.paneText = 'OpenAI Codex\nSelect Model and Effort\n1. GPT-6-Astra\n› 2. GPT-6-Sol (current)\nenter select · esc back\nGPT-6.1-Sol xhigh fast · ~/demo';
      await expect(manager.suspendSession(session.id)).rejects.toThrow('The provider is busy');
      expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);

      db.boundSessions.upsert({ ...db.boundSessions.getById(session.id)!, isWorking: true });
      await expect(manager.suspendSession(session.id)).rejects.toThrow('Only an idle, established session');
      expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    }
    expect(db.sqlite.prepare('select status, description from coordination_assignments where id=?')
      .get('assignment-1')).toEqual({ status, description: 'Unfinished work' });
    await manager.stop();
    db.close();
  });

  it('rejects manual suspension when a waiting assignment becomes active during readiness checks', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n\nCompleted response.\n› Ask Codex to do anything\ngpt-5.6-sol medium · 98% left · ~/demo';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:assignment-race', title: 'Assigned', kind: 'history',
    });
    addCoordinationAssignment(db, session, 'waiting');
    tmux.capturePane = async () => {
      db.sqlite.prepare("update coordination_assignments set status='active' where id=?").run('assignment-1');
      return tmux.paneText;
    };

    await expect(manager.suspendSession(session.id)).rejects.toThrow('active coordination assignment');
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    expect(db.boundSessions.getById(session.id)?.manualSuspendedAt).toBeUndefined();
    await manager.stop();
    db.close();
  });

  it('suspends one oldest finished session per low-memory pass and resumes it on selection', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-pressure-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n\nCompleted response.\n› Ask Codex to do anything\ngpt-5.6-sol medium · 98% left · ~/demo';
    let availableKiB = 2 * 1024 * 1024;
    const options = {
      pressureSuspendAvailableBytes: 3 * 1024 * 1024 * 1024,
      pressureSuspendIdleMs: 60 * 60 * 1000,
      readMemInfo: () => `MemAvailable: ${availableKiB} kB\n`,
    };
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'),
      new RealtimeEventBus(), provider, providerSettings, options);
    const older = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:pressure-older', title: 'Older', kind: 'history',
    });
    const newer = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:pressure-newer', title: 'Newer', kind: 'history',
    });
    backdateFinishedSession(db, older.id, 90);
    backdateFinishedSession(db, newer.id, 70);

    await manager.reconcileSessions();
    expect(tmux.alive.has(older.tmuxSessionName)).toBe(true);
    availableKiB = 4 * 1024 * 1024;
    await manager.reconcileSessions();
    availableKiB = 2 * 1024 * 1024;
    await manager.reconcileSessions();
    expect(tmux.alive.has(older.tmuxSessionName)).toBe(true);

    await manager.reconcileSessions();
    expect(tmux.alive.has(older.tmuxSessionName)).toBe(false);
    expect(tmux.alive.has(newer.tmuxSessionName)).toBe(true);
    expect(db.boundSessions.getById(older.id)?.pressureSuspendedAt).toBeTruthy();
    expect(db.boundSessions.getById(older.id)?.shouldRestore).toBe(true);

    availableKiB = 4 * 1024 * 1024;
    await manager.stop();
    const restarted = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'),
      new RealtimeEventBus(), provider, providerSettings, options);
    await restarted.reconcileSessions();
    expect(tmux.alive.has(older.tmuxSessionName)).toBe(false);
    expect(tmux.created).toHaveLength(2);

    await restarted.resumeSession(older.id);
    expect(tmux.alive.has(older.tmuxSessionName)).toBe(true);
    expect(db.boundSessions.getById(older.id)?.pressureSuspendedAt).toBeUndefined();
    availableKiB = 2 * 1024 * 1024;
    await restarted.reconcileSessions();
    await restarted.reconcileSessions();
    expect(tmux.alive.has(older.tmuxSessionName)).toBe(true);
    await restarted.stop();
    db.close();
  });

  it.each(['none', 'waiting'] as const)('keeps a finished dead session with %s assignment stopped under memory pressure', async (status) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-pressure-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n› Ask Codex to do anything\ngpt-5.6-sol medium · 98% left · ~/demo';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'),
      new RealtimeEventBus(), provider, providerSettings, {
        pressureSuspendAvailableBytes: 3 * 1024 * 1024 * 1024,
        readMemInfo: () => 'MemAvailable: 2097152 kB\n',
      });
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:pressure-dead', title: 'Dead', kind: 'history',
    });
    backdateFinishedSession(db, session.id, 90);
    if (status === 'waiting') addCoordinationAssignment(db, session, status);
    tmux.alive.delete(session.tmuxSessionName);
    await manager.reconcileSessions();
    expect(tmux.created).toHaveLength(1);
    expect(db.boundSessions.getById(session.id)?.pressureSuspendedAt).toBeUndefined();

    await manager.reconcileSessions();

    expect(tmux.created).toHaveLength(1);
    expect(db.boundSessions.getById(session.id)?.pressureSuspendedAt).toBeTruthy();
    await manager.stop();
    db.close();
  });

  it('does not pressure-suspend a session with an unsent draft', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-pressure-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n› unsent draft\ngpt-5.6-sol medium · 98% left · ~/demo';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'),
      new RealtimeEventBus(), provider, providerSettings, {
        pressureSuspendAvailableBytes: 3 * 1024 * 1024 * 1024,
        readMemInfo: () => 'MemAvailable: 2097152 kB\n',
      });
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:pressure-draft', title: 'Draft', kind: 'history',
    });
    backdateFinishedSession(db, session.id, 90);
    await manager.reconcileSessions();
    await manager.reconcileSessions();

    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    expect(db.boundSessions.getById(session.id)?.pressureSuspendedAt).toBeUndefined();
    await manager.stop();
    db.close();
  });

  it.each(['active', 'waiting'] as const)('checks pressure suspension with coordination status %s', async (status) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-pressure-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = 'OpenAI Codex\n\nCompleted response.\n› Ask Codex to do anything\ngpt-5.6-sol medium · 98% left · ~/demo';
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'),
      new RealtimeEventBus(), provider, providerSettings, {
        pressureSuspendAvailableBytes: 3 * 1024 * 1024 * 1024,
        readMemInfo: () => 'MemAvailable: 2097152 kB\n',
      });
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:pressure-assignment', title: 'Assigned', kind: 'history',
    });
    backdateFinishedSession(db, session.id, 90);
    addCoordinationAssignment(db, session, status);

    await manager.reconcileSessions();
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    expect(db.boundSessions.getById(session.id)?.pressureSuspendedAt).toBeUndefined();
    await manager.reconcileSessions();

    expect(tmux.alive.has(session.tmuxSessionName)).toBe(status === 'active');
    expect(Boolean(db.boundSessions.getById(session.id)?.pressureSuspendedAt)).toBe(status === 'waiting');
    expect(db.sqlite.prepare('select status, description from coordination_assignments where id=?')
      .get('assignment-1')).toEqual({ status, description: 'Unfinished work' });
    await manager.stop();
    db.close();
  });

  it('re-checks idle state inside the queued suspend so fresh activity cancels a stale suspension', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'history:idle-race',
      title: 'Idle race',
      kind: 'history',
    });
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    db.boundSessions.upsert({
      ...db.boundSessions.getById(session.id)!,
      lastActivityAt: sixDaysAgo,
      isWorking: false,
    });
    db.sqlite.prepare('update bound_sessions set started_at = ? where id = ?').run(sixDaysAgo, session.id);
    const staleIdleRow = db.boundSessions.getById(session.id)!;

    // User activity lands after the reconcile loop snapshotted the idle row but
    // before the queued suspend executes.
    db.boundSessions.upsert({
      ...staleIdleRow,
      lastActivityAt: new Date().toISOString(),
    });

    await (manager as unknown as {
      suspendIdleSession(session: typeof staleIdleRow): Promise<void>;
    }).suspendIdleSession(staleIdleRow);

    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    db.close();
  });

  it.each([
    { hours: 120, suspension: 'none', released: false },
    { hours: 168, suspension: 'none', released: false },
    { hours: 215.99, suspension: 'none', released: false },
    { hours: 216, suspension: 'none', released: true },
    { hours: 217, suspension: 'none', released: true },
    { hours: 215.99, suspension: 'pressure', released: false },
    { hours: 216, suspension: 'pressure', released: true },
    { hours: 240, suspension: 'manual', released: false },
  ])('sets history release to $released after $hours idle hours with $suspension suspension', async ({ hours, suspension, released }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:expired-work', title: 'Expired work', kind: 'history',
    });
    const transcriptPath = path.join(tempDir, 'expired-work.jsonl');
    await fs.writeFile(transcriptPath, '{"type":"session_meta"}\n');
    db.conversationIndex.upsert({
      ref: session.conversationRef, kind: 'history', projectSlug: project.slug,
      provider: provider.id, title: 'Expired work', updatedAt: new Date().toISOString(),
      transcriptPath, isBound: true, degraded: false,
    });
    const old = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    db.boundSessions.upsert({
      ...db.boundSessions.getById(session.id)!,
      lastActivityAt: old,
      lastOutputAt: old,
      lastCompletedAt: old,
      lastResponseAt: old,
      isWorking: false,
    });
    db.sqlite.prepare('update bound_sessions set started_at = ? where id = ?').run(old, session.id);
    if (suspension !== 'none') {
      if (suspension === 'manual') db.boundSessions.setManualSuspendedAt(session.id, old);
      else db.boundSessions.setPressureSuspendedAt(session.id, old);
      tmux.alive.clear();
    }
    tmux.paneText = 'OpenAI Codex\n› Ask Codex to do anything\ngpt-5.6-sol medium · 98% left · ~/demo';

    await manager.reconcileSessions();

    expect(db.boundSessions.getById(session.id)).toMatchObject({
      status: released ? 'ended' : 'bound', shouldRestore: !released,
    });
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(false);
    expect(manager.listActiveSessions().some((active) => active.id === session.id)).toBe(!released);
    expect((await fs.stat(transcriptPath)).isFile()).toBe(true);
    await manager.stop();
    db.close();
  });

  it('retains an expired history session when Browse has no readable transcript', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:missing-transcript', title: 'Missing transcript', kind: 'history',
    });
    await fs.appendFile(session.eventLogPath!, `${JSON.stringify({
      type: 'status', text: 'Console-only history', timestamp: new Date().toISOString(),
    })}\n`);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.boundSessions.upsert({
      ...db.boundSessions.getById(session.id)!,
      lastActivityAt: old, lastOutputAt: old, lastCompletedAt: old,
      lastResponseAt: old, isWorking: false,
    });
    db.sqlite.prepare('update bound_sessions set started_at = ? where id = ?').run(old, session.id);

    await manager.reconcileSessions();
    expect(db.boundSessions.getById(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('Console-only history');

    const transcriptPath = path.join(tempDir, 'missing-transcript.jsonl');
    db.conversationIndex.upsert({
      ref: session.conversationRef, kind: 'history', projectSlug: project.slug,
      provider: provider.id, title: 'Missing transcript', updatedAt: old,
      transcriptPath, isBound: true, degraded: false,
    });
    await manager.reconcileSessions();
    expect(db.boundSessions.getById(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('Console-only history');

    await manager.stop();
    db.close();
  });

  it('releases an expired pending session and removes its Console-only input log', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'pending:expired-work', title: 'Expired pending work', kind: 'pending',
    });
    db.pendingConversations.put({
      ref: session.conversationRef, kind: 'pending', projectSlug: project.slug,
      provider: provider.id, title: 'Expired pending work', updatedAt: new Date().toISOString(),
      isBound: true, boundSessionId: session.id, degraded: false,
    });
    await manager.sendInput(session.id, 'Pending user input');
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('Pending user input');
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.boundSessions.upsert({
      ...db.boundSessions.getById(session.id)!,
      lastActivityAt: old, lastOutputAt: old, lastCompletedAt: old, isWorking: false,
    });
    db.sqlite.prepare('update bound_sessions set started_at = ? where id = ?').run(old, session.id);
    tmux.alive.clear();

    await manager.reconcileSessions();

    expect(db.boundSessions.getById(session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
    expect(db.pendingConversations.get(session.conversationRef)).toBeUndefined();
    await expect.poll(async () => fs.stat(session.eventLogPath!).then(() => true, () => false)).toBe(false);
    await manager.stop();
    db.close();
  });

  it('keeps an apparently old session when its live terminal is still working', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));
    const session = await manager.bindConversation({
      project, provider, providerSettings,
      conversationRef: 'history:old-but-working', title: 'Old but working', kind: 'history',
    });
    backdateFinishedSession(db, session.id, 10 * 24 * 60);
    const transcriptPath = path.join(tempDir, 'old-but-working.jsonl');
    await fs.writeFile(transcriptPath, '{"type":"session_meta"}\n');
    db.conversationIndex.upsert({
      ref: session.conversationRef, kind: 'history', projectSlug: project.slug,
      provider: provider.id, title: 'Old but working', updatedAt: new Date().toISOString(),
      transcriptPath, isBound: true, degraded: false,
    });
    tmux.paneText = 'OpenAI Codex\n• Working (20s • esc to interrupt)';

    await manager.reconcileSessions();

    expect(db.boundSessions.getById(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    await manager.stop();
    db.close();
  });

  it('keeps pending sessions active before the nine-day release cutoff', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = createRecoveryManager(db, tmux, path.join(tempDir, 'runtime'));

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:idle-pending',
      title: 'Idle pending',
      kind: 'pending',
    });
    backdateFinishedSession(db, session.id, 8 * 24 * 60);

    await manager.reconcileSessions();

    expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
    expect(db.boundSessions.getById(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    await manager.stop();
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
