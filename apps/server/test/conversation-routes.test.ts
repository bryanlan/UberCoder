import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationSummary, SessionScreen } from '@agent-console/shared';
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
});
