import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CURRENT_SCHEMA_VERSION } from '../src/db/schema.js';

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
