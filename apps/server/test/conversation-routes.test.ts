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
          content: '',
        },
      });
      expect(getSessionScreen).toHaveBeenCalledWith('session-live-adopted');
      expect(getConversation).toHaveBeenCalledTimes(1);
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

  it('does not split same-role transcript runs at timeline page boundaries', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-ref',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Paged transcript',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:06.000Z',
      isBound: false,
      degraded: false,
    } satisfies ConversationSummary]);

    const providerMessages: NormalizedMessage[] = [
      {
        id: 'old-user',
        provider: 'codex',
        role: 'user',
        lifecycle: 'durable',
        text: 'Older prompt',
        timestamp: '2026-03-14T18:00:00.000Z',
        conversationRef: 'history-ref',
        source: 'history-file',
      },
      {
        id: 'old-assistant',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
        text: 'Older answer',
        timestamp: '2026-03-14T18:00:01.000Z',
        conversationRef: 'history-ref',
        source: 'history-file',
      },
      {
        id: 'same-turn-first',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
        text: 'Same turn first chunk',
        timestamp: '2026-03-14T18:00:02.000Z',
        conversationRef: 'history-ref',
        source: 'history-file',
      },
      {
        id: 'same-turn-second',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
        text: 'Same turn second chunk',
        timestamp: '2026-03-14T18:00:03.000Z',
        conversationRef: 'history-ref',
        source: 'history-file',
      },
      {
        id: 'new-user',
        provider: 'codex',
        role: 'user',
        lifecycle: 'durable',
        text: 'Next prompt',
        timestamp: '2026-03-14T18:00:04.000Z',
        conversationRef: 'history-ref',
        source: 'history-file',
      },
      {
        id: 'new-assistant',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
        text: 'Latest answer',
        timestamp: '2026-03-14T18:00:05.000Z',
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
        title: 'Paged transcript',
        createdAt: '2026-03-14T18:00:00.000Z',
        updatedAt: '2026-03-14T18:00:06.000Z',
        isBound: false,
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
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
        getSessionScreen: async () => undefined,
      } as never,
      new RealtimeEventBus(),
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/conversations/demo/codex/history-ref/messages?limit=3',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        messagePage: {
          hasOlder: true,
          olderCursor: 1,
          total: 6,
        },
      });
      expect(response.json().messages.map((message: NormalizedMessage) => message.text)).toEqual([
        'Older answer',
        'Same turn first chunk',
        'Same turn second chunk',
        'Next prompt',
        'Latest answer',
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('keeps raw-output assistant chunks out of transcript-backed timelines', async () => {
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
      JSON.stringify({ type: 'user-input', text: 'One more live follow-up.', timestamp: '2026-03-14T18:02:06.500Z' }),
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
        lifecycle: 'durable',
        text: 'Continue with the implementation plan.',
        timestamp: '2026-03-14T18:00:00.000Z',
        conversationRef: 'history-ref',
        source: 'history-file',
      },
      {
        id: 'history-assistant',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
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
        content: `${liveTranscriptTail}\nFresh live-only follow-up.`,
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
      expect(texts.filter((text: string) => text === 'Continue with the implementation plan.')).toHaveLength(1);
      expect(texts).toContain('One more live follow-up.');
      expect(texts).toContain('Fresh live-only follow-up.');
      expect(texts).not.toContain(liveTranscriptTail);
      expect(response.json().messages.find((message: NormalizedMessage) => message.text === 'Fresh live-only follow-up.')).toMatchObject({
        lifecycle: 'pending',
        role: 'assistant',
        source: 'live-output',
      });
      expect(response.json().liveScreen.content).toBe('');
    } finally {
      await app.close();
      db.close();
    }
  });

  it('keeps repeated pending live output when provider history has only the submitted user turn', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const userPrompt = 'Continue deployment checks.';
    const repeatedReply = 'Done.';
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: userPrompt, timestamp: '2026-03-14T18:02:00.100Z' }),
      JSON.stringify({ type: 'raw-output', text: repeatedReply, timestamp: '2026-03-14T18:02:01.000Z' }),
    ].join('\n'));

    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-pending-live',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Deployment checks',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:00.000Z',
      isBound: true,
      boundSessionId: 'session-pending-live',
      degraded: false,
    } satisfies ConversationSummary]);
    const session: BoundSession = {
      id: 'session-pending-live',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-pending-live',
      tmuxSessionName: 'ac-codex-demo-pending-live',
      status: 'bound',
      title: 'Deployment checks',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:01.000Z',
      lastActivityAt: '2026-03-14T18:02:01.000Z',
      eventLogPath,
    };
    db.upsertBoundSession(session);

    const providerMessages: NormalizedMessage[] = [
      {
        id: 'history-user-1',
        provider: 'codex',
        role: 'user',
        lifecycle: 'durable',
        text: 'Initial checklist.',
        timestamp: '2026-03-14T18:00:00.000Z',
        conversationRef: 'history-pending-live',
        source: 'history-file',
      },
      {
        id: 'history-assistant-1',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
        text: repeatedReply,
        timestamp: '2026-03-14T18:01:00.000Z',
        conversationRef: 'history-pending-live',
        source: 'history-file',
      },
      {
        id: 'history-user-2',
        provider: 'codex',
        role: 'user',
        lifecycle: 'durable',
        text: userPrompt,
        timestamp: '2026-03-14T18:02:00.000Z',
        conversationRef: 'history-pending-live',
        source: 'history-file',
      },
    ];
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'history-pending-live',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Deployment checks',
        createdAt: '2026-03-14T18:00:00.000Z',
        updatedAt: '2026-03-14T18:02:00.000Z',
        isBound: true,
        boundSessionId: 'session-pending-live',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: repeatedReply,
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-03-14T18:02:02.000Z',
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
        url: '/api/conversations/demo/codex/history-pending-live/messages',
      });

      expect(response.statusCode).toBe(200);
      const messages = response.json().messages as NormalizedMessage[];
      expect(messages.map((message) => message.text)).toEqual([
        'Initial checklist.',
        repeatedReply,
        userPrompt,
        repeatedReply,
      ]);
      expect(messages.filter((message) => message.text === userPrompt)).toHaveLength(1);
      expect(messages.filter((message) => message.text === repeatedReply)).toHaveLength(2);
      expect(messages.find((message) => message.text === repeatedReply && message.source === 'live-output')).toMatchObject({
        lifecycle: 'pending',
        role: 'assistant',
        source: 'live-output',
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('drops stale short transcript scrollback after a transcript-backed user turn', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const userPrompt = 'Continue deployment checks.';
    const staleTranscriptReply = 'OK.';
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: userPrompt, timestamp: '2026-03-14T18:02:00.100Z' }),
      JSON.stringify({ type: 'raw-output', text: staleTranscriptReply, timestamp: '2026-03-14T18:02:01.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'Pending streamed answer.', timestamp: '2026-03-14T18:02:02.000Z' }),
    ].join('\n'));

    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-stale-short-scrollback',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Deployment checks',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:00.000Z',
      isBound: true,
      boundSessionId: 'session-stale-short-scrollback',
      degraded: false,
    } satisfies ConversationSummary]);
    const session: BoundSession = {
      id: 'session-stale-short-scrollback',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-stale-short-scrollback',
      tmuxSessionName: 'ac-codex-demo-stale-short-scrollback',
      status: 'bound',
      title: 'Deployment checks',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:02.000Z',
      lastActivityAt: '2026-03-14T18:02:02.000Z',
      eventLogPath,
    };
    db.upsertBoundSession(session);

    const providerMessages: NormalizedMessage[] = [
      {
        id: 'history-user-1',
        provider: 'codex',
        role: 'user',
        lifecycle: 'durable',
        text: 'Initial checklist.',
        timestamp: '2026-03-14T18:00:00.000Z',
        conversationRef: 'history-stale-short-scrollback',
        source: 'history-file',
      },
      {
        id: 'history-assistant-1',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
        text: staleTranscriptReply,
        timestamp: '2026-03-14T18:01:00.000Z',
        conversationRef: 'history-stale-short-scrollback',
        source: 'history-file',
      },
      {
        id: 'history-user-2',
        provider: 'codex',
        role: 'user',
        lifecycle: 'durable',
        text: userPrompt,
        timestamp: '2026-03-14T18:02:00.000Z',
        conversationRef: 'history-stale-short-scrollback',
        source: 'history-file',
      },
    ];
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'history-stale-short-scrollback',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Deployment checks',
        createdAt: '2026-03-14T18:00:00.000Z',
        updatedAt: '2026-03-14T18:02:00.000Z',
        isBound: true,
        boundSessionId: 'session-stale-short-scrollback',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: `${staleTranscriptReply}\nPending streamed answer.`,
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-03-14T18:02:03.000Z',
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
        url: '/api/conversations/demo/codex/history-stale-short-scrollback/messages',
      });

      expect(response.statusCode).toBe(200);
      const messages = response.json().messages as NormalizedMessage[];
      expect(messages.map((message) => message.text)).toEqual([
        'Initial checklist.',
        staleTranscriptReply,
        userPrompt,
        'Pending streamed answer.',
      ]);
      expect(messages.filter((message) => message.text === staleTranscriptReply)).toHaveLength(1);
      expect(messages.find((message) => message.text === 'Pending streamed answer.')).toMatchObject({
        lifecycle: 'pending',
        role: 'assistant',
        source: 'live-output',
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('drops live terminal process text and flattened repeats once provider history has the formatted answer', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const userPrompt = 'what scchema changes and any data do I need to push to prod to verify this';
    const formattedAnswer = [
      'To verify in prod, you need three things:',
      '',
      '1. **Deploy waltiumweb code**',
      '   - Commit already exists: `aa1892a Add portal usage tracking surfaces`',
      '   - Current `main` includes it, so a normal waltiumweb production deploy is enough.',
      '',
      '2. **Apply the app-schema DDL**',
      '   - Use: `/home/bryan/code/plaidbasic/sql/app_usage_tracking_2026-06-30.sql`',
      '   - This creates:',
      '     - `app.usage_sessions`',
      '     - `app.usage_events`',
      '     - `app.usage_daily_rollup`',
      '',
      '3. **No usage data needs to be pushed**',
      '   - Start with empty usage tables.',
      '   - Data should be generated by real client portal activity in production.',
      '',
      'Admin UI should then show it at `/app/admin/usage`.',
    ].join('\n');
    const flattenedRepeat = [
      'Search replace-staging|manifest|drop|exclude|app\\.usage|usage_ in db_cache.py',
      'To verify in prod, you need three things:',
      '1. Deploy waltiumweb code',
      '- Commit already exists: aa1892a Add portal usage tracking surfaces',
      '- Current main includes it, so a normal waltiumweb production deploy is enough.',
      '2. Apply the app-schema DDL',
      '- Use: /home/bryan/code/plaidbasic/sql/app_usage_tracking_2026-06-30.sql',
      '- This creates:',
      '- app.usage_sessions',
      '- app.usage_events',
      '- app.usage_daily_rollup',
      '3. No usage data needs to be pushed',
      '- Start with empty usage tables.',
      '- Data should be generated by real client portal activity in production.',
      'Admin UI should then show it at /app/admin/usage.',
    ].join('\n');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: userPrompt, timestamp: '2026-07-01T18:36:28.861Z' }),
      JSON.stringify({
        type: 'raw-output',
        text: [
          'I’ll check the committed migration and current app DB access pattern so the production checklist is exact.',
          'Explored',
        ].join('\n'),
        timestamp: '2026-07-01T18:37:20.268Z',
      }),
      JSON.stringify({ type: 'raw-output', text: flattenedRepeat, timestamp: '2026-07-01T18:37:20.268Z' }),
    ].join('\n'));

    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-usage-prod',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Prod usage verification',
      createdAt: '2026-07-01T18:36:28.000Z',
      updatedAt: '2026-07-01T18:37:20.112Z',
      isBound: true,
      boundSessionId: 'session-usage-prod',
      degraded: false,
    } satisfies ConversationSummary]);
    const session: BoundSession = {
      id: 'session-usage-prod',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-usage-prod',
      tmuxSessionName: 'ac-codex-demo-usage-prod',
      status: 'bound',
      title: 'Prod usage verification',
      startedAt: '2026-07-01T18:36:28.000Z',
      updatedAt: '2026-07-01T18:37:20.268Z',
      lastActivityAt: '2026-07-01T18:37:20.268Z',
      eventLogPath,
    };
    db.upsertBoundSession(session);

    const providerMessages: NormalizedMessage[] = [
      {
        id: 'history-user',
        provider: 'codex',
        role: 'user',
        lifecycle: 'durable',
        text: userPrompt,
        timestamp: '2026-07-01T18:36:29.000Z',
        conversationRef: 'history-usage-prod',
        source: 'history-file',
      },
      {
        id: 'history-assistant',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
        text: formattedAnswer,
        timestamp: '2026-07-01T18:37:20.112Z',
        conversationRef: 'history-usage-prod',
        source: 'history-file',
      },
    ];
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'history-usage-prod',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Prod usage verification',
        createdAt: '2026-07-01T18:36:28.000Z',
        updatedAt: '2026-07-01T18:37:20.112Z',
        isBound: true,
        boundSessionId: 'session-usage-prod',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: flattenedRepeat,
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-07-01T18:37:21.000Z',
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
        url: '/api/conversations/demo/codex/history-usage-prod/messages',
      });

      expect(response.statusCode).toBe(200);
      const messages = response.json().messages as NormalizedMessage[];
      expect(messages.map((message) => ({ role: message.role, source: message.source, text: message.text }))).toEqual([
        { role: 'user', source: 'history-file', text: userPrompt },
        { role: 'assistant', source: 'history-file', text: formattedAnswer },
      ]);
      expect(JSON.stringify(messages)).not.toContain('I’ll check');
      expect(JSON.stringify(messages)).not.toContain('Search replace-staging');
    } finally {
      await app.close();
      db.close();
    }
  });

  it('does not expose raw live screen scrollback in transcript-backed timelines', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-long-tail',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Long transcript',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:16:00.000Z',
      isBound: true,
      boundSessionId: 'session-long-tail',
      degraded: false,
    } satisfies ConversationSummary]);

    const session: BoundSession = {
      id: 'session-long-tail',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-long-tail',
      tmuxSessionName: 'ac-codex-demo-long-tail',
      status: 'bound',
      title: 'Long transcript',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:16:00.000Z',
      lastActivityAt: '2026-03-14T18:16:00.000Z',
    };
    db.upsertBoundSession(session);

    const providerMessages: NormalizedMessage[] = Array.from({ length: 16 }, (_, index) => ({
      id: `history-assistant-${index}`,
      provider: 'codex',
      role: 'assistant',
      lifecycle: 'durable',
      text: `Saved transcript segment ${index + 1} has enough unique content to identify long terminal scrollback ${index + 1}.`,
      timestamp: `2026-03-14T18:${String(index).padStart(2, '0')}:00.000Z`,
      conversationRef: 'history-long-tail',
      source: 'history-file',
    }));
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'history-long-tail',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Long transcript',
        createdAt: '2026-03-14T18:00:00.000Z',
        updatedAt: '2026-03-14T18:16:00.000Z',
        isBound: true,
        boundSessionId: 'session-long-tail',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: `${providerMessages.map((message) => message.text).join('\n')}\nFresh live-only follow-up.`,
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-03-14T18:16:01.000Z',
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
        url: '/api/conversations/demo/codex/history-long-tail/messages?limit=0',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().messages).toEqual([]);
      expect(response.json().liveScreen.content).toBe('');
      expect(getConversation).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it('does not expose raw live screen scrollback with interleaved terminal chrome', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-chrome-tail',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Terminal chrome tail',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:00.000Z',
      isBound: true,
      boundSessionId: 'session-chrome-tail',
      degraded: false,
    } satisfies ConversationSummary]);

    const session: BoundSession = {
      id: 'session-chrome-tail',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-chrome-tail',
      tmuxSessionName: 'ac-codex-demo-chrome-tail',
      status: 'bound',
      title: 'Terminal chrome tail',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:00.000Z',
      lastActivityAt: '2026-03-14T18:02:00.000Z',
    };
    db.upsertBoundSession(session);

    const transcriptLineA = 'The data availability update now derives its real data window from the source rows instead of a fixed mock constant.';
    const transcriptLineB = 'The managed accounts client shows a quiet caption and warns only when the requested start predates available history.';
    const providerMessages: NormalizedMessage[] = [{
      id: 'history-assistant',
      provider: 'codex',
      role: 'assistant',
      lifecycle: 'durable',
      text: `${transcriptLineA}\n\n${transcriptLineB}`,
      timestamp: '2026-03-14T18:02:00.000Z',
      conversationRef: 'history-chrome-tail',
      source: 'history-file',
    }];
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'history-chrome-tail',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Terminal chrome tail',
        createdAt: '2026-03-14T18:00:00.000Z',
        updatedAt: '2026-03-14T18:02:00.000Z',
        isBound: true,
        boundSessionId: 'session-chrome-tail',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: [
          transcriptLineA,
          '⎿ Updated apps/web/src/ManagedAccountsClient.tsx',
          transcriptLineB,
          'Fresh active terminal line.',
        ].join('\n'),
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-03-14T18:02:01.000Z',
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
        url: '/api/conversations/demo/codex/history-chrome-tail/messages?limit=0',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().messages).toEqual([]);
      expect(response.json().liveScreen.content).toBe('');
    } finally {
      await app.close();
      db.close();
    }
  });

  it('renders a Claude transcript paragraph only once when the event log replays it with command status lines', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('waltiumweb', 'claude', [{
      ref: 'claude-duplicate-tail',
      kind: 'history',
      projectSlug: 'waltiumweb',
      provider: 'claude',
      title: 'Claude duplicate tail',
      createdAt: '2026-06-30T12:30:00.000Z',
      updatedAt: '2026-06-30T12:35:41.995Z',
      isBound: true,
      boundSessionId: 'session-claude-duplicate-tail',
      degraded: false,
    } satisfies ConversationSummary]);

    const assistantText = [
      'That "completed" was just the launcher returning — the actual codex run is detached via `nohup`. Let me check its progress:',
      '',
      'Good news in the run log: this retry **ran the proof-of-read `wc -l` successfully** — so local file access is working (the bwrap bypass holds), and Codex is now analyzing. It\'s still running (detached via nohup), output is written at the end. Let me wait for it to finish:',
    ].join('\n');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'raw-output',
        text: [
          '● That "completed" was just the launcher returning — the actual codex run is detached via `nohup`. Let me check its progress:',
          '',
          'Ran 1 shell command',
          '',
          '● Good news in the run log: this retry ran the proof-of-read wc -l successfully — so local file access is working (the bwrap bypass holds), and Codex is now analyzing. It\'s still running (detached via nohup), output is written at the end. Let me wait for it to finish:',
        ].join('\n'),
        timestamp: '2026-06-30T12:35:42.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-claude-duplicate-tail',
      provider: 'claude',
      projectSlug: 'waltiumweb',
      conversationRef: 'claude-duplicate-tail',
      tmuxSessionName: 'ac-claude-waltiumweb-duplicate-tail',
      status: 'bound',
      title: 'Claude duplicate tail',
      startedAt: '2026-06-30T12:30:00.000Z',
      updatedAt: '2026-06-30T12:35:41.995Z',
      lastActivityAt: '2026-06-30T12:35:41.995Z',
      eventLogPath,
    };
    db.upsertBoundSession(session);

    const providerMessages: NormalizedMessage[] = [
      {
        id: 'history-assistant-duplicate',
        provider: 'claude',
        role: 'assistant',
        lifecycle: 'durable',
        text: assistantText,
        timestamp: '2026-06-30T12:35:41.995Z',
        conversationRef: 'claude-duplicate-tail',
        source: 'history-file',
      },
      {
        id: 'history-assistant-frontier',
        provider: 'claude',
        role: 'assistant',
        lifecycle: 'durable',
        text: 'Later durable transcript frontier.',
        timestamp: '2026-06-30T12:36:00.000Z',
        conversationRef: 'claude-duplicate-tail',
        source: 'history-file',
      },
    ];
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'claude-duplicate-tail',
        kind: 'history',
        projectSlug: 'waltiumweb',
        provider: 'claude',
        title: 'Claude duplicate tail',
        createdAt: '2026-06-30T12:30:00.000Z',
        updatedAt: '2026-06-30T12:35:41.995Z',
        isBound: true,
        boundSessionId: 'session-claude-duplicate-tail',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: [
          'hat "completed" was just the launcher returning — the actual codex run is detached via `nohup`. Let me check its progress:',
          '',
          'Ran 1 shell command',
          '',
          '● Good news in the run log: this retry ran the proof-of-read wc -l successfully — so local file access is working (the bwrap bypass holds), and Codex is now analyzing. It\'s still running (detached via nohup), output is written at the end. Let me wait for it to finish:',
        ].join('\n'),
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-06-30T12:35:42.000Z',
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
          projectSlug === 'waltiumweb'
            ? {
                slug: 'waltiumweb',
                displayName: 'Waltium Web',
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
        url: '/api/conversations/waltiumweb/claude/claude-duplicate-tail/messages',
      });

      expect(response.statusCode).toBe(200);
      const messages = response.json().messages as NormalizedMessage[];
      expect(messages.filter((message) => message.text.includes('launcher returning'))).toHaveLength(1);
      expect(messages.filter((message) => message.text.includes('proof-of-read'))).toHaveLength(1);
      expect(messages.some((message) => message.text === 'Ran 1 shell command')).toBe(false);
      expect(messages.filter((message) => message.lifecycle === 'pending')).toHaveLength(0);
      expect(response.json().liveScreen.content).toBe('');
    } finally {
      await app.close();
      db.close();
    }
  });

  it('trims Claude status-only live output and saved prompt echoes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('waltiumweb', 'claude', [{
      ref: 'claude-status-tail',
      kind: 'history',
      projectSlug: 'waltiumweb',
      provider: 'claude',
      title: 'Claude status tail',
      createdAt: '2026-06-30T19:00:00.000Z',
      updatedAt: '2026-06-30T19:14:01.072Z',
      isBound: true,
      boundSessionId: 'session-claude-status-tail',
      degraded: false,
    } satisfies ConversationSummary]);

    const session: BoundSession = {
      id: 'session-claude-status-tail',
      provider: 'claude',
      projectSlug: 'waltiumweb',
      conversationRef: 'claude-status-tail',
      tmuxSessionName: 'ac-claude-waltiumweb-status-tail',
      status: 'bound',
      title: 'Claude status tail',
      startedAt: '2026-06-30T19:00:00.000Z',
      updatedAt: '2026-06-30T19:14:01.072Z',
      lastActivityAt: '2026-06-30T19:14:01.072Z',
    };
    db.upsertBoundSession(session);

    const providerMessages: NormalizedMessage[] = [{
      id: 'history-user-short-prompt',
      provider: 'claude',
      role: 'user',
      lifecycle: 'durable',
      text: 'what happene',
      timestamp: '2026-06-30T19:14:01.072Z',
      conversationRef: 'claude-status-tail',
      source: 'history-file',
    }];
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'claude-status-tail',
        kind: 'history',
        projectSlug: 'waltiumweb',
        provider: 'claude',
        title: 'Claude status tail',
        createdAt: '2026-06-30T19:00:00.000Z',
        updatedAt: '2026-06-30T19:14:01.072Z',
        isBound: true,
        boundSessionId: 'session-claude-status-tail',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: [
          '✻ Baked for 12m 40s',
          '',
          '● Background command "Proof-gated Codex review of ingest layer" failed with exit',
          'code 144',
          '',
          '❯ what happene',
          '',
          '✽ Gusting…',
          '  tmux focus-events off · add \'set -g focus-events on\' to ~/.tmux.conf and rea…',
        ].join('\n'),
        inputText: '',
        status: 'Session active',
        capturedAt: '2026-06-30T19:14:02.000Z',
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
          projectSlug === 'waltiumweb'
            ? {
                slug: 'waltiumweb',
                displayName: 'Waltium Web',
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
        url: '/api/conversations/waltiumweb/claude/claude-status-tail/messages?limit=0',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().messages).toEqual([]);
      expect(response.json().liveScreen.content).toBe('');
    } finally {
      await app.close();
      db.close();
    }
  });

  it('trims saved transcript scrollback when newer live input is only in the active input buffer', async () => {
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
    const activeInput = 'Switch model from the live bridge without duplicating the saved transcript tail.';
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: activeInput, timestamp: '2026-03-14T18:02:07.000Z' }),
    ].join('\n'));

    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [{
      ref: 'history-input-buffer',
      kind: 'history',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Input buffer trim',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:05.000Z',
      isBound: true,
      boundSessionId: 'session-input-buffer',
      degraded: false,
    } satisfies ConversationSummary]);

    const session: BoundSession = {
      id: 'session-input-buffer',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-input-buffer',
      tmuxSessionName: 'ac-codex-demo-input-buffer',
      status: 'bound',
      title: 'Input buffer trim',
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
        lifecycle: 'durable',
        text: 'Continue with the implementation plan.',
        timestamp: '2026-03-14T18:00:00.000Z',
        conversationRef: 'history-input-buffer',
        source: 'history-file',
      },
      {
        id: 'history-assistant',
        provider: 'codex',
        role: 'assistant',
        lifecycle: 'durable',
        text: transcriptAnswer,
        timestamp: '2026-03-14T18:02:05.000Z',
        conversationRef: 'history-input-buffer',
        source: 'history-file',
      },
    ];
    const getConversation = vi.fn(async () => ({
      summary: {
        ref: 'history-input-buffer',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Input buffer trim',
        createdAt: '2026-03-14T18:00:00.000Z',
        updatedAt: '2026-03-14T18:02:05.000Z',
        isBound: true,
        boundSessionId: 'session-input-buffer',
        degraded: false,
      } satisfies ConversationSummary,
      messages: providerMessages,
      allMessages: providerMessages,
    }));
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: `${liveTranscriptTail}\nLive model menu is waiting for a selection.`,
        inputText: activeInput,
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
        url: '/api/conversations/demo/codex/history-input-buffer/messages',
      });

      expect(response.statusCode).toBe(200);
      const texts = response.json().messages.map((message: NormalizedMessage) => message.text);
      expect(texts).toContain(activeInput);
      expect(response.json().liveScreen.content).toBe('');
      expect(response.json().liveScreen.inputText).toBe(activeInput);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('trims live screen scrollback against event-log-only pending history', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversation-route-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const eventOnlyAnswer = 'Event-only assistant answer has enough unique content to identify duplicated pending terminal output.';
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'user-input', text: 'Draft an event-only implementation plan.', timestamp: '2026-03-14T18:02:00.000Z' }),
      JSON.stringify({ type: 'raw-output', text: eventOnlyAnswer, timestamp: '2026-03-14T18:02:05.000Z' }),
    ].join('\n'));

    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:event-tail',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'New Codex conversation',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:05.000Z',
      isBound: true,
      boundSessionId: 'session-event-tail',
      degraded: false,
      rawMetadata: { pending: true },
    });

    const session: BoundSession = {
      id: 'session-event-tail',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:event-tail',
      tmuxSessionName: 'ac-codex-demo-event-tail',
      status: 'bound',
      title: 'New Codex conversation',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:02:05.000Z',
      lastActivityAt: '2026-03-14T18:02:05.000Z',
      eventLogPath,
    };
    db.upsertBoundSession(session);

    const getConversation = vi.fn(async () => null);
    const getSessionScreen = vi.fn(async () => ({
      session,
      screen: {
        content: `${eventOnlyAnswer}\nFresh active terminal line.`,
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
        url: '/api/conversations/demo/codex/pending%3Aevent-tail/messages',
      });

      expect(response.statusCode).toBe(200);
      const texts = response.json().messages.map((message: NormalizedMessage) => message.text);
      expect(texts).toContain('Draft an event-only implementation plan.');
      expect(texts).toContain(eventOnlyAnswer);
      expect(response.json().liveScreen.content).toBe('');
      expect(getConversation).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });
});
