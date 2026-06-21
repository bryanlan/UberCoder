import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationSummary, NormalizedMessage, SessionScreen } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { registerConversationRoutes } from '../src/routes/conversations.js';

describe('conversation routes', () => {
  it('force rebind releases an existing live session before creating a replacement', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-ref',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Existing conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:05.000Z',
      isBound: false,
      degraded: false,
    } satisfies ConversationSummary]);

    const existingSession: BoundSession = {
      id: 'session-old',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-ref',
      tmuxSessionName: 'ac-codex-demo-old',
      status: 'bound',
      title: 'Existing conversation',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:01:00.000Z',
      lastActivityAt: '2026-03-14T18:01:00.000Z',
    };
    const replacementSession: BoundSession = {
      ...existingSession,
      id: 'session-new',
      tmuxSessionName: 'ac-codex-demo-new',
      updatedAt: '2026-03-14T18:02:00.000Z',
      lastActivityAt: '2026-03-14T18:02:00.000Z',
    };

    const releaseSession = vi.fn(async () => undefined);
    const bindConversation = vi.fn(async () => replacementSession);

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation: async () => null,
        }),
      } as never,
      {
        bindConversation,
        getSessionByConversation: vi.fn(() => existingSession),
        releaseSession,
        getSessionScreen: async () => undefined,
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/conversations/demo/codex/history-ref/bind',
        payload: { force: true, initialPrompt: 'follow up from recovery' },
      });

      expect(response.statusCode).toBe(200);
      expect(releaseSession).toHaveBeenCalledWith('session-old');
      expect(bindConversation).toHaveBeenCalledOnce();
      expect(bindConversation).toHaveBeenCalledWith(expect.objectContaining({
        initialPrompt: 'follow up from recovery',
      }));
      expect(response.json()).toMatchObject({
        session: {
          id: 'session-new',
        },
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('binds an adopted pending alias through its indexed history conversation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'real-history',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Adopted history',
      createdAt: '2026-03-14T18:00:30.000Z',
      updatedAt: '2026-03-14T18:00:30.000Z',
      isBound: false,
      degraded: false,
    } satisfies ConversationSummary]);
    db.putPendingConversation({
      ref: 'pending:adopted',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-14T17:59:00.000Z',
      updatedAt: '2026-03-14T18:01:00.000Z',
      isBound: false,
      degraded: false,
      rawMetadata: {
        pending: true,
        adoptedConversationRef: 'real-history',
      },
    });

    const reboundSession: BoundSession = {
      id: 'session-real-history',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'real-history',
      resumeConversationRef: 'real-history',
      tmuxSessionName: 'ac-codex-demo-real-history',
      status: 'bound',
      shouldRestore: true,
      title: 'Adopted history',
      startedAt: '2026-03-14T18:02:00.000Z',
      updatedAt: '2026-03-14T18:02:00.000Z',
    };
    const bindConversation = vi.fn(async () => reboundSession);

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation: async () => null,
        }),
      } as never,
      {
        bindConversation,
        getSessionByConversation: vi.fn(() => undefined),
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/conversations/demo/codex/pending%3Aadopted/bind',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(bindConversation).toHaveBeenCalledWith(expect.objectContaining({
        conversationRef: 'real-history',
        title: 'Adopted history',
        kind: 'history',
      }));
      expect(response.json()).toMatchObject({
        session: {
          id: 'session-real-history',
          conversationRef: 'real-history',
        },
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('creates a new pending conversation when the old zero-turn pending bind cannot be restored and gets cleared', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:stale',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'claude',
      title: 'New Claude conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-stale',
      degraded: false,
      rawMetadata: { pending: true },
    });

    const staleSession: BoundSession = {
      id: 'session-stale',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:stale',
      tmuxSessionName: 'ac-claude-demo-stale',
      status: 'error',
      shouldRestore: true,
      title: 'New Claude conversation',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:01:00.000Z',
    };
    db.upsertBoundSession(staleSession);

    const freshSession: BoundSession = {
      id: 'session-new',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:new',
      tmuxSessionName: 'ac-claude-demo-new',
      status: 'bound',
      shouldRestore: true,
      title: 'New Claude conversation',
      startedAt: '2026-03-14T18:02:00.000Z',
      updatedAt: '2026-03-14T18:02:00.000Z',
    };

    const bindConversation = vi.fn(async () => freshSession);
    const ensureSession = vi.fn(async () => undefined);
    let getSessionByIdCalls = 0;
    const getSessionById = vi.fn((id: string) => {
      if (id === 'session-stale') {
        getSessionByIdCalls += 1;
        if (getSessionByIdCalls === 1) {
          return staleSession;
        }
        return {
          ...staleSession,
          shouldRestore: false,
          status: 'ended',
        };
      }
      return undefined;
    });

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'claude',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['claude'],
            resumeCommand: ['claude', '--resume', '{{conversationId}}'],
            continueCommand: ['claude', '--continue'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation: async () => null,
        }),
      } as never,
      {
        bindConversation,
        ensureSession,
        getSessionById,
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/conversations/demo/claude/new/bind',
      });

      expect(response.statusCode).toBe(200);
      expect(ensureSession).toHaveBeenCalledWith('session-stale');
      expect(bindConversation).toHaveBeenCalledOnce();
      expect(response.json()).toMatchObject({
        session: { id: 'session-new' },
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('clears an unrestorable pending bind with recorded input before starting a replacement', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:stale',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'claude',
      title: 'New Claude conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:30.000Z',
      isBound: true,
      boundSessionId: 'session-stale',
      degraded: false,
      rawMetadata: {
        pending: true,
        lastUserInputHash: 'hash',
        lastUserInputPreview: 'c',
      },
    });

    const staleSession: BoundSession = {
      id: 'session-stale',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:stale',
      tmuxSessionName: 'ac-claude-demo-stale',
      status: 'error',
      shouldRestore: true,
      title: 'New Claude conversation',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:01:00.000Z',
    };
    db.upsertBoundSession(staleSession);

    const freshSession: BoundSession = {
      id: 'session-new',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:new',
      tmuxSessionName: 'ac-claude-demo-new',
      status: 'bound',
      shouldRestore: true,
      title: 'New Claude conversation',
      startedAt: '2026-03-14T18:02:00.000Z',
      updatedAt: '2026-03-14T18:02:00.000Z',
    };

    const bindConversation = vi.fn(async () => freshSession);
    const ensureSession = vi.fn(async () => undefined);

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'claude',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['claude'],
            resumeCommand: ['claude', '--resume', '{{conversationId}}'],
            continueCommand: ['claude', '--continue'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation: async () => null,
        }),
      } as never,
      {
        bindConversation,
        ensureSession,
        getSessionById: vi.fn(() => staleSession),
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/conversations/demo/claude/new/bind',
      });

      expect(response.statusCode).toBe(200);
      expect(ensureSession).toHaveBeenCalledWith('session-stale');
      expect(bindConversation).toHaveBeenCalledOnce();
      expect(db.getPendingConversation('pending:stale')?.isBound).toBe(false);
      expect(db.getBoundSessionById('session-stale')).toMatchObject({
        status: 'ended',
        shouldRestore: false,
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('serves a live adopted session before the conversation has been indexed', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-live-adopted',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'real-adopted',
      tmuxSessionName: 'ac-codex-demo-live-adopted',
      status: 'bound',
      title: 'Recovered live session',
      startedAt: '2026-03-14T17:00:00.000Z',
      updatedAt: '2026-03-14T17:02:00.000Z',
      lastActivityAt: '2026-03-14T17:02:00.000Z',
      isWorking: true,
    };
    db.upsertBoundSession(session);

    const recoverSessions = vi.fn(async () => undefined);
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: 'Still working through the direct-load case…',
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-03-14T17:02:01.000Z',
      } satisfies SessionScreen,
    }));
    const getConversation = vi.fn(async () => null);

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation,
        }),
      } as never,
      {
        recoverSessions,
        getSessionScreen,
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/conversations/demo/codex/real-adopted/messages',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        conversation: {
          ref: 'real-adopted',
          title: 'Recovered live session',
          kind: 'history',
          isBound: true,
          boundSessionId: 'session-live-adopted',
        },
        boundSession: {
          id: 'session-live-adopted',
        },
        liveScreen: {
          content: 'Still working through the direct-load case…',
        },
      });
      expect(getSessionScreen).toHaveBeenCalledWith('session-live-adopted');
      expect(getConversation).toHaveBeenCalledTimes(1);
      expect(recoverSessions).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('returns 409 when a history conversation is still durably bound but cannot be restored', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-ref',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Existing conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:05.000Z',
      isBound: true,
      boundSessionId: 'session-old',
      degraded: false,
    } satisfies ConversationSummary]);

    const existingSession: BoundSession = {
      id: 'session-old',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-ref',
      tmuxSessionName: 'ac-codex-demo-old',
      status: 'error',
      shouldRestore: true,
      title: 'Existing conversation',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:01:00.000Z',
    };

    const bindConversation = vi.fn();
    const ensureSession = vi.fn(async () => undefined);

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation: async () => null,
        }),
      } as never,
      {
        bindConversation,
        ensureSession,
        getSessionById: vi.fn(() => existingSession),
        getSessionByConversation: vi.fn(() => existingSession),
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/conversations/demo/codex/history-ref/bind',
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: 'Conversation is already bound but could not be restored.',
      });
      expect(ensureSession).toHaveBeenCalledWith('session-old');
      expect(bindConversation).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('loads indexed history directly from the cached transcript path without rediscovering provider files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const transcriptPath = path.join(tempDir, 'cached-history.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/tmp/demo-project',
          id: 'cached-history',
        },
      }),
      JSON.stringify({
        role: 'user',
        text: 'Use the indexed transcript path first.',
        timestamp: '2026-03-14T18:00:00.000Z',
      }),
      JSON.stringify({
        role: 'assistant',
        text: 'Loaded from the cached transcript file.',
        timestamp: '2026-03-14T18:00:05.000Z',
      }),
    ].join('\n'));

    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'cached-history',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Indexed conversation title',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:05.000Z',
      transcriptPath,
      providerConversationId: 'cached-history',
      isBound: false,
      degraded: false,
      rawMetadata: {
        projectPaths: ['/tmp/demo-project'],
      },
    } satisfies ConversationSummary]);

    const getConversation = vi.fn(async () => {
      throw new Error('provider.getConversation should not run when transcriptPath is indexed');
    });

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation,
        }),
      } as never,
      {
        getSessionScreen: async () => undefined,
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/conversations/demo/codex/cached-history/messages',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        conversation: {
          ref: 'cached-history',
          title: 'Indexed conversation title',
          isBound: false,
        },
        messages: [
          {
            role: 'user',
            text: 'Use the indexed transcript path first.',
          },
          {
            role: 'assistant',
            text: 'Loaded from the cached transcript file.',
          },
        ],
      });
      expect(getConversation).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('serves metadata-only message requests from the index without reading transcript files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'cached-history',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Indexed conversation title',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:05.000Z',
      transcriptPath: path.join(tempDir, 'missing-large-transcript.jsonl'),
      providerConversationId: 'cached-history',
      isBound: false,
      degraded: false,
    } satisfies ConversationSummary]);

    const getConversation = vi.fn(async () => {
      throw new Error('provider.getConversation should not run for metadata-only requests');
    });

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation,
        }),
      } as never,
      {
        getSessionScreen: async () => undefined,
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/conversations/demo/codex/cached-history/messages?limit=0',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        conversation: {
          ref: 'cached-history',
          title: 'Indexed conversation title',
          isBound: false,
        },
        messages: [],
        allMessages: [],
        messagePage: {
          hasOlder: false,
          total: 0,
        },
      });
      expect(getConversation).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('suppresses live-output message tails that are already backed by the provider transcript', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const transcriptAnswer = [
      'The revised design needs to evolve. Use code tables with FKs.',
      'Typed observations and normalized result tables keep cockpit workflows queryable.',
      'JSONB remains evidence and detail, not the main query surface.',
    ].join(' ');
    const liveTranscriptTail = [
      'evolve. Use code tables with FKs.',
      'Typed observations and normalized result tables keep cockpit workflows queryable.',
      'JSONB remains evidence and detail, not the main query surface.',
    ].join('\n');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'Continue with the implementation plan.', timestamp: '2026-03-14T18:02:00.000Z' }),
      JSON.stringify({ type: 'raw-output', text: liveTranscriptTail, timestamp: '2026-03-14T18:02:05.000Z' }),
      JSON.stringify({ type: 'status', text: 'Still working.', timestamp: '2026-03-14T18:02:06.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'Fresh live-only follow-up.', timestamp: '2026-03-14T18:02:07.000Z' }),
    ].join('\n'));

    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-ref',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Planning schema',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:05.000Z',
      isBound: true,
      boundSessionId: 'session-live',
      degraded: false,
    } satisfies ConversationSummary]);
    const session: BoundSession = {
      id: 'session-live',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-ref',
      tmuxSessionName: 'ac-codex-demo-live',
      status: 'bound',
      title: 'Planning schema',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:07.000Z',
      lastActivityAt: '2026-03-14T18:02:07.000Z',
      eventLogPath,
    };
    db.upsertBoundSession(session);

    const providerMessages: NormalizedMessage[] = [
      {
        id: 'history-user',
        provider: 'codex',
        role: 'user',
        text: 'Continue with the implementation plan.',
        timestamp: '2026-03-14T18:00:00.000Z',
        conversationRef: 'history-ref',
        source: 'history-file',
      },
      {
        id: 'history-assistant',
        provider: 'codex',
        role: 'assistant',
        text: transcriptAnswer,
        timestamp: '2026-03-14T18:02:05.000Z',
        conversationRef: 'history-ref',
        source: 'history-file',
      },
    ];
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'history-ref',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Planning schema',
        createdAt: '2026-03-14T18:00:00.000Z',
        updatedAt: '2026-03-14T18:02:05.000Z',
        isBound: true,
        boundSessionId: 'session-live',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: liveTranscriptTail,
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-03-14T18:02:08.000Z',
      } satisfies SessionScreen,
    }));

    const app = fastify();
    await registerConversationRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      db,
      {
        getProjectBySlug: async (projectSlug: string) => (
          projectSlug === 'demo'
            ? {
                slug: 'demo',
                displayName: 'Demo',
              }
            : undefined
        ),
        getMergedProviderSettings: () => ({
          id: 'codex',
          enabled: true,
          discoveryRoot: tempDir,
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: {},
          },
        }),
      } as never,
      {
        get: () => ({
          getConversation,
        }),
      } as never,
      {
        getSessionScreen,
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/conversations/demo/codex/history-ref/messages',
      });

      expect(response.statusCode).toBe(200);
      const texts = response.json().messages.map((message: NormalizedMessage) => message.text);
      expect(texts).toContain(transcriptAnswer);
      expect(texts).toContain('Continue with the implementation plan.');
      expect(texts.filter((text: string) => text === 'Continue with the implementation plan.')).toHaveLength(2);
      expect(texts).toContain('Fresh live-only follow-up.');
      expect(texts).not.toContain(liveTranscriptTail);
    } finally {
      await app.close();
      db.close();
    }
  });
});
