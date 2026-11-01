import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { CURRENT_SCHEMA_VERSION } from '../src/db/schema.js';

function boundSession(input: Partial<BoundSession> & { id: string; conversationRef: string; updatedAt: string }): BoundSession {
  return {
    id: input.id,
    provider: input.provider ?? 'codex',
    codexProfile: input.codexProfile,
    claudeProfile: input.claudeProfile,
    grokProfile: input.grokProfile,
    projectSlug: input.projectSlug ?? 'demo',
    conversationRef: input.conversationRef,
    resumeConversationRef: input.resumeConversationRef ?? input.conversationRef,
    tmuxSessionName: input.tmuxSessionName ?? `ac-codex-demo-${input.id}`,
    transport: input.transport ?? 'tmux',
    status: input.status ?? 'bound',
    shouldRestore: input.shouldRestore ?? true,
    title: input.title ?? 'Bound conversation',
    startedAt: input.startedAt ?? '2026-03-07T00:00:00.000Z',
    updatedAt: input.updatedAt,
    lastActivityAt: input.lastActivityAt,
    lastOutputAt: input.lastOutputAt,
    lastCompletedAt: input.lastCompletedAt,
    lastResponseAt: input.lastResponseAt,
    autoTrackedAt: input.autoTrackedAt,
    isWorking: input.isWorking ?? false,
    pid: input.pid,
    rawLogPath: input.rawLogPath,
    eventLogPath: input.eventLogPath,
  };
}

describe('AppDatabase', () => {
  it('records the current schema version for a fresh database', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-schema-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    const row = db.sqlite.prepare(`select max(version) as version from schema_version`).get() as { version: number };
    expect(row.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('opens an existing pre-version database and stamps the migration', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-legacy-'));
    const databasePath = path.join(tempDir, 'agent-console.sqlite');
    const legacy = new Database(databasePath);
    legacy.exec(`
      create table bound_sessions (
        id text primary key,
        provider text not null,
        project_slug text not null,
        conversation_ref text not null,
        tmux_session_name text not null,
        status text not null,
        title text,
        started_at text not null,
        updated_at text not null,
        last_activity_at text,
        pid integer,
        raw_log_path text,
        event_log_path text
      );

      insert into bound_sessions (
        id, provider, project_slug, conversation_ref, tmux_session_name, status,
        title, started_at, updated_at
      ) values (
        'legacy-session', 'codex', 'demo', 'legacy-ref', 'ac-codex-demo-legacy', 'bound',
        'Legacy session', '2026-03-07T00:00:00.000Z', '2026-03-07T00:01:00.000Z'
      );
    `);
    legacy.close();

    const db = new AppDatabase(databasePath);
    const version = db.sqlite.prepare(`select max(version) as version from schema_version`).get() as { version: number };
    const columns = new Set((db.sqlite.prepare(`pragma table_info(bound_sessions)`).all() as Array<{ name: string }>)
      .map((row) => row.name));
    const session = db.boundSessions.getRestorableByConversation('demo', 'codex', 'legacy-ref');

    expect(version.version).toBe(CURRENT_SCHEMA_VERSION);
    expect([...columns]).toEqual(expect.arrayContaining([
      'resume_conversation_ref',
      'should_restore',
      'last_output_at',
      'last_completed_at',
      'last_response_at',
      'auto_tracked_at',
      'is_working',
      'model_profile_request_json',
      'claude_profile',
      'pressure_suspended_at',
    ]));
    expect(session).toMatchObject({
      id: 'legacy-session',
      shouldRestore: true,
      resumeConversationRef: 'legacy-ref',
    });
    db.close();
  });

  it('backfills provider response time when upgrading a version 11 database', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-v11-'));
    const databasePath = path.join(tempDir, 'agent-console.sqlite');
    const before = new AppDatabase(databasePath);
    const completedAt = '2026-09-20T12:00:00.000Z';
    before.boundSessions.upsert(boundSession({
      id: 'completed-session', conversationRef: 'completed-ref', updatedAt: completedAt,
      lastCompletedAt: completedAt,
    }));
    before.sqlite.exec('alter table bound_sessions drop column last_response_at; delete from schema_version where version = 12');
    before.close();

    const after = new AppDatabase(databasePath);
    expect(after.boundSessions.getById('completed-session')?.lastResponseAt).toBe(completedAt);
    after.close();
  });

  it('upgrades a version 19 database with a column for the Auto profile state, and keeps that state apart from ordinary upserts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-v19-'));
    const databasePath = path.join(tempDir, 'agent-console.sqlite');
    const before = new AppDatabase(databasePath);
    before.boundSessions.upsert(boundSession({ id: 'auto-session', conversationRef: 'auto-ref', updatedAt: '2026-10-01T00:00:00.000Z' }));
    before.sqlite.exec('alter table bound_sessions drop column grok_profile; alter table bound_sessions drop column auto_route_json; delete from schema_version where version in (20, 21)');
    expect(before.sqlite.prepare('select max(version) as version from schema_version').get()).toEqual({ version: 19 });
    before.close();

    const after = new AppDatabase(databasePath);
    expect(after.sqlite.prepare('select name from schema_version where version = 20').get()).toEqual({ name: 'auto-model-profile' });
    expect(after.boundSessions.getById('auto-session')?.autoRoute).toBeUndefined();
    const decision = { source: 'router' as const, decidedAt: '2026-11-01T12:00:00.000Z', model: 'gpt-6.1-terra', effort: 'low', launchName: 'gpt-6.1-terra' };
    after.boundSessions.setAutoRoute('auto-session', { routePending: false, decision }, '2026-11-01T12:00:00.000Z');
    // An ordinary status upsert must not erase it.
    after.boundSessions.upsert({ ...after.boundSessions.getById('auto-session')!, title: 'renamed', updatedAt: '2026-11-01T12:00:01.000Z' });
    expect(after.boundSessions.getById('auto-session')?.autoRoute).toEqual({ routePending: false, decision });

    // A switch to Auto commits the Auto state its request carries; a switch to High clears it.
    const request = (profile: 'auto' | 'high', requestId: string) => ({
      requestId, profile, requestedAt: '2026-11-01T12:01:00.000Z', state: 'applying' as const, startedAt: '2026-11-01T12:01:00.000Z',
      resumeConversationRef: 'auto-ref', ...(profile === 'auto' ? { autoRoute: { routePending: true, decision } } : {}),
    });
    after.boundSessions.replaceModelProfileRequest('auto-session', request('auto', 'r1'), '2026-11-01T12:01:00.000Z');
    after.boundSessions.completeModelProfileRequest({ id: 'auto-session', requestId: 'r1', profile: 'auto', updatedAt: '2026-11-01T12:01:01.000Z' });
    expect(after.boundSessions.getById('auto-session')).toMatchObject({ codexProfile: 'auto', autoRoute: { routePending: true, decision } });
    after.boundSessions.replaceModelProfileRequest('auto-session', request('high', 'r2'), '2026-11-01T12:02:00.000Z');
    after.boundSessions.completeModelProfileRequest({ id: 'auto-session', requestId: 'r2', profile: 'high', updatedAt: '2026-11-01T12:02:01.000Z' });
    expect(after.boundSessions.getById('auto-session')).toMatchObject({ codexProfile: 'high', autoRoute: undefined });
    after.close();
  });

  it('upgrades a version 18 database so existing rows read as tmux sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-v18-'));
    const databasePath = path.join(tempDir, 'agent-console.sqlite');
    const before = new AppDatabase(databasePath);
    before.boundSessions.upsert(boundSession({ id: 'older-session', conversationRef: 'older-ref', updatedAt: '2026-10-01T00:00:00.000Z' }));
    before.sqlite.exec('alter table bound_sessions drop column auto_route_json; alter table bound_sessions drop column transport; delete from schema_version where version >= 19');
    expect(before.sqlite.prepare('select max(version) as version from schema_version').get()).toEqual({ version: 18 });
    before.close();

    const after = new AppDatabase(databasePath);
    const column = (after.sqlite.prepare('pragma table_info(bound_sessions)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>)
      .find((row) => row.name === 'transport');
    expect(column).toMatchObject({ notnull: 1, dflt_value: "'tmux'" });
    expect(after.sqlite.prepare('select max(version) as version from schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    expect(after.sqlite.prepare('select name from schema_version where version = 19').get()).toEqual({ name: 'session-transport' });
    expect(after.boundSessions.getById('older-session')).toMatchObject({ transport: 'tmux', tmuxSessionName: 'ac-codex-demo-older-session' });
    expect(after.boundSessions.getRestorableByConversation('demo', 'codex', 'older-ref')?.transport).toBe('tmux');
    after.close();
  });

  it('stores the session transport, defaults to tmux, and keeps it when an update omits it', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-transport-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const { transport: _omitted, ...withoutTransport } = boundSession({ id: 'plain', conversationRef: 'plain-ref', updatedAt: '2026-10-02T00:00:00.000Z' });
    db.boundSessions.upsert(withoutTransport);
    db.boundSessions.upsert(boundSession({
      id: 'structured', conversationRef: 'thread-1', updatedAt: '2026-10-02T00:00:00.000Z',
      transport: 'structured', tmuxSessionName: 'structured:structured',
    }));
    expect(db.boundSessions.getById('plain')?.transport).toBe('tmux');
    expect(db.boundSessions.getById('structured')).toMatchObject({ transport: 'structured', tmuxSessionName: 'structured:structured' });

    const { transport: _dropped, ...structuredWithoutTransport } = db.boundSessions.getById('structured')!;
    db.boundSessions.upsert({ ...structuredWithoutTransport, title: 'Renamed', updatedAt: '2026-10-02T00:00:01.000Z' });
    expect(db.boundSessions.getById('structured')).toMatchObject({ transport: 'structured', title: 'Renamed' });
    expect(db.boundSessions.getRestorableByConversation('demo', 'codex', 'thread-1')?.transport).toBe('structured');
    db.close();
  });

  it('round-trips auto-tracked session provenance separately from activity recency', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.boundSessions.upsert(boundSession({
      id: 'auto-tracked-session',
      conversationRef: 'recent-external-conversation',
      updatedAt: '2026-03-07T08:00:00.000Z',
      autoTrackedAt: '2026-03-07T08:00:00.000Z',
    }));

    expect(db.boundSessions.getById('auto-tracked-session')).toMatchObject({
      autoTrackedAt: '2026-03-07T08:00:00.000Z',
      lastActivityAt: undefined,
      lastCompletedAt: undefined,
    });
    db.close();
  });

  it('persists model-profile requests independently from ordinary session upserts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const databasePath = path.join(tempDir, 'agent-console.sqlite');
    const db = new AppDatabase(databasePath);
    const session = boundSession({
      id: 'profile-request-session',
      conversationRef: 'profile-request-conversation',
      updatedAt: '2026-09-18T10:00:00.000Z',
    });
    db.boundSessions.upsert(session);
    const request = {
      requestId: 'request-1',
      profile: 'high' as const,
      requestedAt: '2026-09-18T10:01:00.000Z',
      state: 'queued' as const,
      deferredReason: 'turn_running' as const,
    };

    db.boundSessions.replaceModelProfileRequest(session.id, request, request.requestedAt);
    db.boundSessions.upsert({ ...session, updatedAt: '2026-09-18T10:02:00.000Z', isWorking: true });

    expect(db.boundSessions.getById(session.id)?.modelProfileRequest).toEqual(request);
    db.close();

    const reopened = new AppDatabase(databasePath);
    expect(reopened.boundSessions.getById(session.id)?.modelProfileRequest).toEqual(request);
    reopened.close();
  });

  it('persists pressure suspension independently from ordinary session updates', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const databasePath = path.join(tempDir, 'agent-console.sqlite');
    const db = new AppDatabase(databasePath);
    const session = boundSession({
      id: 'pressure-session', conversationRef: 'pressure-conversation',
      updatedAt: '2026-09-18T10:00:00.000Z', pid: 4242,
    });
    db.boundSessions.upsert(session);
    const suspendedAt = '2026-09-18T11:00:00.000Z';
    expect(db.boundSessions.setPressureSuspendedAt(session.id, suspendedAt)).toMatchObject({
      pressureSuspendedAt: suspendedAt, pid: undefined, isWorking: false,
    });
    db.boundSessions.upsert({ ...session, updatedAt: '2026-09-18T12:00:00.000Z' });
    expect(db.boundSessions.getById(session.id)?.pressureSuspendedAt).toBe(suspendedAt);
    db.close();

    const reopened = new AppDatabase(databasePath);
    expect(reopened.boundSessions.getById(session.id)?.pressureSuspendedAt).toBe(suspendedAt);
    expect(reopened.boundSessions.setPressureSuspendedAt(session.id, undefined)?.pressureSuspendedAt).toBeUndefined();
    reopened.close();
  });

  it('uses request identity when transitioning and atomically completing a model-profile request', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session = boundSession({
      id: 'profile-cas-session',
      conversationRef: 'profile-cas-conversation',
      updatedAt: '2026-09-18T11:00:00.000Z',
    });
    db.boundSessions.upsert(session);
    const queued = {
      requestId: 'request-new',
      profile: 'high' as const,
      requestedAt: '2026-09-18T11:01:00.000Z',
      state: 'queued' as const,
    };
    db.boundSessions.replaceModelProfileRequest(session.id, queued, queued.requestedAt);

    expect(db.boundSessions.compareAndSetModelProfileRequest({
      id: session.id,
      requestId: 'request-stale',
      expectedState: 'queued',
      next: undefined,
      updatedAt: '2026-09-18T11:02:00.000Z',
    })).toBeUndefined();

    const applying = {
      ...queued,
      state: 'applying' as const,
      startedAt: '2026-09-18T11:03:00.000Z',
      resumeConversationRef: session.conversationRef,
    };
    expect(db.boundSessions.compareAndSetModelProfileRequest({
      id: session.id,
      requestId: queued.requestId,
      expectedState: 'queued',
      next: applying,
      updatedAt: applying.startedAt,
    })?.modelProfileRequest).toEqual(applying);
    expect(db.boundSessions.completeModelProfileRequest({
      id: session.id,
      requestId: 'request-stale',
      profile: 'high',
      updatedAt: '2026-09-18T11:04:00.000Z',
    })).toBeUndefined();

    expect(db.boundSessions.completeModelProfileRequest({
      id: session.id,
      requestId: queued.requestId,
      profile: 'high',
      updatedAt: '2026-09-18T11:05:00.000Z',
    })).toMatchObject({ codexProfile: 'high', modelProfileRequest: undefined });

    db.boundSessions.upsert({ ...session, updatedAt: '2026-09-18T11:04:30.000Z', isWorking: true });
    expect(db.boundSessions.getById(session.id)).toMatchObject({
      codexProfile: 'high',
      modelProfileRequest: undefined,
      isWorking: true,
    });
    db.close();
  });

  it('commits a Claude profile to the Claude column and preserves it against stale upserts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session = boundSession({
      id: 'claude-profile-session', provider: 'claude', conversationRef: 'claude-conversation',
      updatedAt: '2026-09-24T11:00:00.000Z',
    });
    db.boundSessions.upsert(session);
    const applying = {
      requestId: 'claude-request', profile: 'high' as const, state: 'applying' as const,
      requestedAt: '2026-09-24T11:01:00.000Z', startedAt: '2026-09-24T11:02:00.000Z',
      resumeConversationRef: session.conversationRef,
    };
    db.boundSessions.replaceModelProfileRequest(session.id, applying, applying.startedAt);
    const completed = db.boundSessions.completeModelProfileRequest({
      id: session.id, requestId: applying.requestId, profile: 'high', updatedAt: '2026-09-24T11:03:00.000Z',
    });
    expect(completed).toMatchObject({ claudeProfile: 'high', codexProfile: undefined, modelProfileRequest: undefined });
    db.boundSessions.upsert({ ...session, updatedAt: '2026-09-24T11:02:30.000Z' });
    expect(db.boundSessions.getById(session.id)).toMatchObject({ claudeProfile: 'high', codexProfile: undefined });
    db.close();
  });

  it('commits a Grok profile to the Grok column and preserves it against stale upserts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session = boundSession({
      id: 'grok-profile-session', provider: 'grok', grokProfile: 'medium', conversationRef: 'grok-conversation',
      updatedAt: '2026-11-01T11:00:00.000Z',
    });
    db.boundSessions.upsert(session);
    expect(db.boundSessions.getById(session.id)).toMatchObject({ provider: 'grok', grokProfile: 'medium', codexProfile: undefined, claudeProfile: undefined });
    const applying = {
      requestId: 'grok-request', profile: 'high' as const, state: 'applying' as const,
      requestedAt: '2026-11-01T11:01:00.000Z', startedAt: '2026-11-01T11:02:00.000Z',
      resumeConversationRef: session.conversationRef,
    };
    db.boundSessions.replaceModelProfileRequest(session.id, applying, applying.startedAt);
    const completed = db.boundSessions.completeModelProfileRequest({
      id: session.id, requestId: applying.requestId, profile: 'high', updatedAt: '2026-11-01T11:03:00.000Z',
    });
    expect(completed).toMatchObject({ grokProfile: 'high', codexProfile: undefined, claudeProfile: undefined, modelProfileRequest: undefined });
    db.boundSessions.upsert({ ...session, updatedAt: '2026-11-01T11:02:30.000Z' });
    expect(db.boundSessions.getById(session.id)).toMatchObject({ grokProfile: 'high' });
    db.close();
  });

  it('upgrades a version 20 database with a column for the Grok profile, and old rows read as having none', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-v20-'));
    const databasePath = path.join(tempDir, 'agent-console.sqlite');
    const before = new AppDatabase(databasePath);
    before.boundSessions.upsert(boundSession({ id: 'old-session', provider: 'claude', claudeProfile: 'low', conversationRef: 'old-ref', updatedAt: '2026-10-01T00:00:00.000Z' }));
    before.sqlite.exec('alter table bound_sessions drop column grok_profile; delete from schema_version where version = 21');
    expect(before.sqlite.prepare('select max(version) as version from schema_version').get()).toEqual({ version: 20 });
    before.close();

    const after = new AppDatabase(databasePath);
    expect(after.sqlite.prepare('select name from schema_version where version = 21').get()).toEqual({ name: 'grok-cost-profile' });
    expect(after.boundSessions.getById('old-session')).toMatchObject({ claudeProfile: 'low', grokProfile: undefined });
    after.close();
  });

  it('deduplicates repeated conversation refs during index replacement', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.conversationIndex.replace('demo', 'claude', [
      {
        ref: 'dup-ref',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'claude',
        title: 'Older transcript',
        updatedAt: '2026-03-07T00:00:00.000Z',
        isBound: false,
        degraded: false,
      },
      {
        ref: 'dup-ref',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'claude',
        title: 'Newer transcript',
        updatedAt: '2026-03-07T01:00:00.000Z',
        isBound: false,
        degraded: false,
      },
    ]);

    const conversations = db.conversationIndex.list();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe('Newer transcript');
    db.close();
  });

  it('derives the last Console close from ended bindings for the exact project and provider', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const summary = {
      ref: 'closed-chat', kind: 'history' as const, projectSlug: 'demo', provider: 'claude' as const,
      title: 'Closed chat', updatedAt: '2026-03-07T00:00:00.000Z', isBound: false, degraded: false,
      lastClosedAt: 'untrusted-provider-metadata',
    };
    try {
      db.conversationIndex.upsert(summary);
      const ended = boundSession({
        id: 'other-project', conversationRef: summary.ref, provider: 'claude', projectSlug: 'other',
        status: 'ended', shouldRestore: false, updatedAt: '2026-03-08T00:00:00.000Z',
      });
      db.boundSessions.upsert(ended);
      db.boundSessions.upsert({ ...ended, id: 'other-provider', projectSlug: 'demo', provider: 'codex' });
      db.boundSessions.upsert({ ...ended, id: 'failed-start', projectSlug: 'demo', status: 'error' });
      expect(db.conversationIndex.get('demo', 'claude', summary.ref)?.lastClosedAt).toBeUndefined();
      expect(db.conversationIndex.list()[0]?.lastClosedAt).toBeUndefined();

      const lastClosedAt = '2026-03-07T02:00:00.000Z';
      db.boundSessions.upsert({ ...ended, id: 'first-close', projectSlug: 'demo', updatedAt: '2026-03-07T01:00:00.000Z' });
      db.boundSessions.upsert({ ...ended, id: 'latest-close', projectSlug: 'demo', updatedAt: lastClosedAt });
      expect(db.conversationIndex.get('demo', 'claude', summary.ref)).toMatchObject({ isBound: false, lastClosedAt });
      expect(db.conversationIndex.list()[0]).toMatchObject({ isBound: false, lastClosedAt });

      db.boundSessions.upsert({ ...ended, id: 'resumed', projectSlug: 'demo', status: 'bound', shouldRestore: true,
        updatedAt: '2026-03-07T03:00:00.000Z' });
      expect(db.conversationIndex.get('demo', 'claude', summary.ref)).toMatchObject({ isBound: true, lastClosedAt });
    } finally {
      db.close();
      await fs.rm(tempDir, { recursive: true });
    }
  });

  it('uses the newest visible bound session for legacy duplicate session rows', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.conversationIndex.replace('demo', 'codex', [{
      ref: 'conversation-1',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Conversation',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
    }]);
    const insert = db.sqlite.prepare(`
      insert into bound_sessions (
        id, provider, project_slug, conversation_ref, resume_conversation_ref,
        tmux_session_name, status, should_restore, title, started_at, updated_at,
        is_working
      ) values (?, 'codex', 'demo', 'conversation-1', 'conversation-1', ?, 'bound', 1, 'Conversation', ?, ?, 0)
    `);
    insert.run('older-session', 'ac-codex-demo-older', '2026-03-07T00:00:00.000Z', '2026-03-07T00:01:00.000Z');
    insert.run('newer-session', 'ac-codex-demo-newer', '2026-03-07T00:00:00.000Z', '2026-03-07T00:02:00.000Z');

    const conversations = db.conversationIndex.list();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      ref: 'conversation-1',
      isBound: true,
      boundSessionId: 'newer-session',
    });
    expect(db.boundSessions.listTreeVisible().map((session) => session.id)).toEqual(['newer-session']);
    db.close();
  });

  it('retires older visible sessions when a newer session is upserted for the same conversation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.boundSessions.upsert(boundSession({
      id: 'older-session',
      conversationRef: 'conversation-1',
      updatedAt: '2026-03-07T00:01:00.000Z',
    }));
    db.boundSessions.upsert(boundSession({
      id: 'newer-session',
      conversationRef: 'conversation-1',
      updatedAt: '2026-03-07T00:02:00.000Z',
    }));

    expect(db.boundSessions.getById('older-session')).toMatchObject({
      status: 'ended',
      shouldRestore: false,
      isWorking: false,
    });
    expect(db.boundSessions.listTreeVisible().map((session) => session.id)).toEqual(['newer-session']);
    db.close();
  });

  it('filters Codex exec-spawned conversations from the persisted conversation index', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.conversationIndex.replace('demo', 'codex', [
      {
        ref: 'interactive',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Interactive transcript',
        updatedAt: '2026-03-07T00:00:00.000Z',
        isBound: false,
        degraded: false,
        rawMetadata: {
          originator: 'codex-tui',
          source: 'cli',
        },
      },
      {
        ref: 'spawned',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Programmatic transcript',
        updatedAt: '2026-03-07T01:00:00.000Z',
        isBound: false,
        degraded: false,
        rawMetadata: {
          originator: 'codex_exec',
          source: 'exec',
        },
      },
    ]);

    expect(db.conversationIndex.list().map((conversation) => conversation.ref)).toEqual(['interactive']);
    db.close();
  });

  it('lists conversations by creation placement instead of recent activity', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.conversationIndex.replace('demo', 'codex', [
      {
        ref: 'older-created',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Older created, recently active',
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-07T02:00:00.000Z',
        isBound: false,
        degraded: false,
      },
      {
        ref: 'newer-created',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Newer created',
        createdAt: '2026-03-07T01:00:00.000Z',
        updatedAt: '2026-03-07T01:00:00.000Z',
        isBound: false,
        degraded: false,
      },
    ]);

    expect(db.conversationIndex.list().map((conversation) => conversation.ref)).toEqual([
      'newer-created',
      'older-created',
    ]);
    db.close();
  });

  it('lists pending conversations by creation placement instead of recent activity', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.pendingConversations.put({
      ref: 'pending:older-created',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Older pending, recently active',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T02:00:00.000Z',
      isBound: false,
      degraded: false,
    });
    db.pendingConversations.put({
      ref: 'pending:newer-created',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Newer pending',
      createdAt: '2026-03-07T01:00:00.000Z',
      updatedAt: '2026-03-07T01:00:00.000Z',
      isBound: false,
      degraded: false,
    });

    expect(db.pendingConversations.list().map((conversation) => conversation.ref)).toEqual([
      'pending:newer-created',
      'pending:older-created',
    ]);
    db.close();
  });

  it('does not mark indexed conversations bound from errored restorable sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.conversationIndex.replace('demo', 'claude', [{
      ref: 'errored-session',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'claude',
      title: 'Errored session',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
    }]);
    db.boundSessions.upsert({
      id: 'session-error',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'errored-session',
      tmuxSessionName: 'ac-claude-demo-error',
      status: 'error',
      shouldRestore: true,
      title: 'Errored session',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:01:00.000Z',
    });

    const conversation = db.conversationIndex.list()[0];
    expect(conversation?.isBound).toBe(false);
    expect(conversation?.boundSessionId).toBeUndefined();
    db.close();
  });

  it('keeps raw pending conversation bindings for errored restorable sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.pendingConversations.put({
      ref: 'pending:errored-session',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Errored pending session',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-error',
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'hash',
      },
    });
    db.boundSessions.upsert({
      id: 'session-error',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:errored-session',
      tmuxSessionName: 'ac-codex-demo-error',
      status: 'error',
      shouldRestore: true,
      title: 'Errored pending session',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:01:00.000Z',
    });

    const conversation = db.pendingConversations.list()[0];
    expect(conversation?.isBound).toBe(true);
    expect(conversation?.boundSessionId).toBe('session-error');
    db.close();
  });
});
