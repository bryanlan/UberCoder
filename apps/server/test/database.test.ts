import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';

describe('AppDatabase', () => {
  it('deduplicates repeated conversation refs during index replacement', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.replaceConversationIndex('demo', 'claude', [
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

    const conversations = db.listConversationIndex();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe('Newer transcript');
    db.close();
  });

  it('filters Codex exec-spawned conversations from the persisted conversation index', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.replaceConversationIndex('demo', 'codex', [
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

    expect(db.listConversationIndex().map((conversation) => conversation.ref)).toEqual(['interactive']);
    db.close();
  });

  it('lists conversations by creation placement instead of recent activity', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.replaceConversationIndex('demo', 'codex', [
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

    expect(db.listConversationIndex().map((conversation) => conversation.ref)).toEqual([
      'newer-created',
      'older-created',
    ]);
    db.close();
  });

  it('lists pending conversations by creation placement instead of recent activity', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.putPendingConversation({
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
    db.putPendingConversation({
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

    expect(db.listPendingConversations().map((conversation) => conversation.ref)).toEqual([
      'pending:newer-created',
      'pending:older-created',
    ]);
    db.close();
  });

  it('does not mark indexed conversations bound from errored restorable sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.replaceConversationIndex('demo', 'claude', [{
      ref: 'errored-session',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'claude',
      title: 'Errored session',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
    }]);
    db.upsertBoundSession({
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

    const conversation = db.listConversationIndex()[0];
    expect(conversation?.isBound).toBe(false);
    expect(conversation?.boundSessionId).toBeUndefined();
    db.close();
  });

  it('keeps raw pending conversation bindings for errored restorable sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-db-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));

    db.putPendingConversation({
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
    db.upsertBoundSession({
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

    const conversation = db.listPendingConversations()[0];
    expect(conversation?.isBound).toBe(true);
    expect(conversation?.boundSessionId).toBe('session-error');
    db.close();
  });
});
