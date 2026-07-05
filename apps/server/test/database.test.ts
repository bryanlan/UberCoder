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
    projectSlug: input.projectSlug ?? 'demo',
    conversationRef: input.conversationRef,
    resumeConversationRef: input.resumeConversationRef ?? input.conversationRef,
    tmuxSessionName: input.tmuxSessionName ?? `ac-codex-demo-${input.id}`,
    status: input.status ?? 'bound',
    shouldRestore: input.shouldRestore ?? true,
    title: input.title ?? 'Bound conversation',
    startedAt: input.startedAt ?? '2026-03-07T00:00:00.000Z',
    updatedAt: input.updatedAt,
    lastActivityAt: input.lastActivityAt,
    lastOutputAt: input.lastOutputAt,
    lastCompletedAt: input.lastCompletedAt,
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
      'is_working',
    ]));
    expect(session).toMatchObject({
      id: 'legacy-session',
      shouldRestore: true,
      resumeConversationRef: 'legacy-ref',
    });
    db.close();
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
