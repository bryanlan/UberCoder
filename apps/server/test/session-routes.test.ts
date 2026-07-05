import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationSummary } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';
import { SessionInputRejectedError } from '../src/sessions/session-manager.js';

function commandResult(session: BoundSession, recordedUserInput?: { id: string; text: string; timestamp: string }) {
  return { ...session, session, recordedUserInput };
}

describe('session routes', () => {
  it('bounds raw output responses to the useful tail of large session logs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const sessionDir = path.join(tempDir, 'runtime', 'session-raw');
    await fs.mkdir(sessionDir, { recursive: true });
    const rawLogPath = path.join(sessionDir, 'raw.log');
    const debugLogPath = path.join(sessionDir, 'debug.log');
    await fs.writeFile(rawLogPath, `${'old raw line\n'.repeat(40_000)}latest raw tail`);
    await fs.writeFile(debugLogPath, 'debug tail');
    const session: BoundSession = {
      id: 'session-raw',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-raw',
      tmuxSessionName: 'ac-codex-demo-raw',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      rawLogPath,
    };
    const app = fastify();
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
      } as never,
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions/session-raw/raw-output',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { text: string };
      expect(body.text).toContain('[showing last 256 KiB of raw session output]');
      expect(body.text).toContain('latest raw tail');
      expect(body.text).toContain('===== session-debug =====');
      expect(body.text).toContain('debug tail');
      expect(body.text.length).toBeLessThan(350_000);
    } finally {
      await app.close();
      db.close();
    }
  });

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
    const sendKeystrokes = vi.fn(async () => commandResult(session));
    const app = fastify({ bodyLimit: 1024 });
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        allowsLiteralSelectionKeystroke: vi.fn(async () => false),
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
    const sendKeystrokes = vi.fn(async () => commandResult(session));
    const app = fastify({ bodyLimit: 1024 });
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        allowsLiteralSelectionKeystroke: vi.fn(async () => false),
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

  it('returns the recorded user-input message id from keystroke submits', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-recorded',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-recorded',
      tmuxSessionName: 'ac-codex-demo-recorded',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const recordedUserInput = {
      id: 'live:session-recorded:42',
      text: 'hello',
      timestamp: '2026-03-14T18:01:00.000Z',
    };
    const allowsLiteralSelectionKeystroke = vi.fn(async () => false);
    const sendKeystrokes = vi.fn(async () => commandResult(session, recordedUserInput));
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
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-recorded/keys',
        payload: { keys: ['Enter'], submittedText: 'hello' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ session, recordedUserInput });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('returns a conflict instead of an internal error when live input cannot reach a session', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-missing',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-missing',
      tmuxSessionName: 'ac-codex-demo-missing',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
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
        sendKeystrokes: vi.fn(async () => {
          throw new SessionInputRejectedError('Session is no longer running. Rebind or restore the conversation before sending input.');
        }),
      } as never,
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-missing/keys',
        payload: { text: 'try ssd now' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Session is no longer running. Rebind or restore the conversation before sending input.',
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('restarts a first-turn pending Codex session from combined text and Enter keystrokes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
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
      db.boundSessions.upsert(restartedSession);
      return commandResult(restartedSession);
    });
    const sendKeystrokes = vi.fn(async () => commandResult(session));
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
      expect(response.json()).toMatchObject({ session: { id: 'session-restarted' } });
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
    db.pendingConversations.put({
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
      db.boundSessions.upsert(restartedSession);
      return commandResult(restartedSession);
    });
    const sendKeystrokes = vi.fn(async () => commandResult(session));
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
      expect(response.json()).toMatchObject({ session: { id: 'session-restarted' } });
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
    db.pendingConversations.put({
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
    const restartPendingSessionWithInitialPrompt = vi.fn(async () => commandResult(session));
    const sendKeystrokes = vi.fn(async () => commandResult(session));
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
      expect(db.pendingConversations.get('pending:slash-command')?.rawMetadata?.lastUserInputPreview).toBeUndefined();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('keeps first-turn pending Codex selection keystrokes on the live session bridge', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
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
    db.boundSessions.upsert({ ...session, shouldRestore: true });
    const allowsLiteralSelectionKeystroke = vi.fn(async () => true);
    const restartPendingSessionWithInitialPrompt = vi.fn(async () => commandResult(session));
    const sendKeystrokes = vi.fn(async () => commandResult(session));
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
      expect(db.pendingConversations.get('pending:selection')?.boundSessionId).toBe('session-pending');
    } finally {
      await app.close();
      db.close();
    }
  });

  it('keeps text-only pending Codex keystrokes on the live session bridge', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
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
    const restartPendingSessionWithInitialPrompt = vi.fn(async () => commandResult(session));
    const sendKeystrokes = vi.fn(async () => commandResult(session));
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
