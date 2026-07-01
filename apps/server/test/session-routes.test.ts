import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationSummary } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';

describe('session routes', () => {
  it('accepts live input bridge paste payloads larger than the old route limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-large',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-large',
      tmuxSessionName: 'ac-codex-demo-large',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify({ bodyLimit: 1024 });
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const largeText = 'x'.repeat((12 * 1024 * 1024) + 1024);
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-large/keys',
        payload: { text: largeText },
      });

      expect(response.statusCode).toBe(200);
      expect(sendKeystrokes).toHaveBeenCalledWith('session-large', { text: largeText });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('rejects live input bridge payloads above the expanded session route limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-too-large',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-too-large',
      tmuxSessionName: 'ac-codex-demo-too-large',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify({ bodyLimit: 1024 });
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const tooLargeText = 'x'.repeat((64 * 1024 * 1024) + 1024);
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-too-large/keys',
        payload: { text: tooLargeText },
      });

      expect(response.statusCode).toBe(413);
      expect(sendKeystrokes).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('restarts a first-turn pending Codex session from combined text and Enter keystrokes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:first-turn',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-pending',
      degraded: false,
      rawMetadata: { pending: true },
    } satisfies ConversationSummary);
    const session: BoundSession = {
      id: 'session-pending',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:first-turn',
      tmuxSessionName: 'ac-codex-demo-pending',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const restartedSession: BoundSession = {
      ...session,
      id: 'session-restarted',
      tmuxSessionName: 'ac-codex-demo-restarted',
      shouldRestore: true,
      updatedAt: '2026-03-14T18:01:00.000Z',
      lastActivityAt: '2026-03-14T18:01:00.000Z',
    };
    const restartPendingSessionWithInitialPrompt = vi.fn(async () => {
      db.upsertBoundSession(restartedSession);
      return restartedSession;
    });
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify();
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {
        getProjectBySlug: vi.fn(async () => ({ slug: 'demo', displayName: 'Demo' })),
        getMergedProviderSettings: vi.fn(() => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        })),
      } as never,
      {
        get: vi.fn(() => ({ id: 'codex' })),
      } as never,
      {
        getSessionById: vi.fn(() => session),
        allowsLiteralSelectionKeystroke: vi.fn(async () => false),
        restartPendingSessionWithInitialPrompt,
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-pending/keys',
        payload: { text: 'fix the stuck pending console', keys: ['Enter'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: 'session-restarted' });
      expect(restartPendingSessionWithInitialPrompt).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-pending',
        initialPrompt: 'fix the stuck pending console',
      }));
      expect(sendKeystrokes).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('restarts a first-turn pending Codex session from the full submittedText when Enter also carries transport text', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:first-turn-submitted',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-pending',
      degraded: false,
      rawMetadata: { pending: true },
    } satisfies ConversationSummary);
    const session: BoundSession = {
      id: 'session-pending',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:first-turn-submitted',
      tmuxSessionName: 'ac-codex-demo-pending',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const restartedSession: BoundSession = {
      ...session,
      id: 'session-restarted',
      tmuxSessionName: 'ac-codex-demo-restarted',
      shouldRestore: true,
      updatedAt: '2026-03-14T18:01:00.000Z',
      lastActivityAt: '2026-03-14T18:01:00.000Z',
    };
    const restartPendingSessionWithInitialPrompt = vi.fn(async () => {
      db.upsertBoundSession(restartedSession);
      return restartedSession;
    });
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify();
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {
        getProjectBySlug: vi.fn(async () => ({ slug: 'demo', displayName: 'Demo' })),
        getMergedProviderSettings: vi.fn(() => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        })),
      } as never,
      {
        get: vi.fn(() => ({ id: 'codex' })),
      } as never,
      {
        getSessionById: vi.fn(() => session),
        allowsLiteralSelectionKeystroke: vi.fn(async () => false),
        restartPendingSessionWithInitialPrompt,
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-pending/keys',
        payload: { text: 'delta only', keys: ['Enter'], submittedText: 'fix via text bypass' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: 'session-restarted' });
      expect(restartPendingSessionWithInitialPrompt).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-pending',
        initialPrompt: 'fix via text bypass',
      }));
      expect(sendKeystrokes).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('keeps first-turn pending Codex slash commands on the live session bridge', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:slash-command',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-pending',
      degraded: false,
      rawMetadata: { pending: true },
    } satisfies ConversationSummary);
    const session: BoundSession = {
      id: 'session-pending',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:slash-command',
      tmuxSessionName: 'ac-codex-demo-pending',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const restartPendingSessionWithInitialPrompt = vi.fn(async () => session);
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify();
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        allowsLiteralSelectionKeystroke: vi.fn(async () => false),
        restartPendingSessionWithInitialPrompt,
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-pending/keys',
        payload: { keys: ['Enter'], submittedText: '/model' },
      });

      expect(response.statusCode).toBe(200);
      expect(restartPendingSessionWithInitialPrompt).not.toHaveBeenCalled();
      expect(sendKeystrokes).toHaveBeenCalledWith('session-pending', { keys: ['Enter'], submittedText: '/model' });
      expect(db.getPendingConversation('pending:slash-command')?.rawMetadata?.lastUserInputPreview).toBeUndefined();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('keeps first-turn pending Codex selection keystrokes on the live session bridge', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:selection',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-pending',
      degraded: false,
      rawMetadata: { pending: true },
    } satisfies ConversationSummary);
    const session: BoundSession = {
      id: 'session-pending',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:selection',
      tmuxSessionName: 'ac-codex-demo-pending',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    db.upsertBoundSession({ ...session, shouldRestore: true });
    const allowsLiteralSelectionKeystroke = vi.fn(async () => true);
    const restartPendingSessionWithInitialPrompt = vi.fn(async () => session);
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify();
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        allowsLiteralSelectionKeystroke,
        restartPendingSessionWithInitialPrompt,
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-pending/keys',
        payload: { text: '1', keys: ['Enter'] },
      });

      expect(response.statusCode).toBe(200);
      expect(allowsLiteralSelectionKeystroke).toHaveBeenCalledWith('session-pending', '1');
      expect(restartPendingSessionWithInitialPrompt).not.toHaveBeenCalled();
      expect(sendKeystrokes).toHaveBeenCalledWith('session-pending', { text: '1', keys: ['Enter'] });
      expect(db.getPendingConversation('pending:selection')?.boundSessionId).toBe('session-pending');
    } finally {
      await app.close();
      db.close();
    }
  });

  it('keeps text-only pending Codex keystrokes on the live session bridge', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:text-only',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-pending',
      degraded: false,
      rawMetadata: { pending: true },
    } satisfies ConversationSummary);
    const session: BoundSession = {
      id: 'session-pending',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:text-only',
      tmuxSessionName: 'ac-codex-demo-pending',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const restartPendingSessionWithInitialPrompt = vi.fn(async () => session);
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify();
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        restartPendingSessionWithInitialPrompt,
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-pending/keys',
        payload: { text: 'buffered bridge text' },
      });

      expect(response.statusCode).toBe(200);
      expect(restartPendingSessionWithInitialPrompt).not.toHaveBeenCalled();
      expect(sendKeystrokes).toHaveBeenCalledWith('session-pending', { text: 'buffered bridge text' });
    } finally {
      await app.close();
      db.close();
    }
  });
});
