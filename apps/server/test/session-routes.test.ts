import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BoundSession, ConversationSummary } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';
import { imagePromptFiles, imagePromptSuffix } from '../src/images/prompt.js';
import { SessionInputRejectedError, StructuredRequestNotFoundError } from '../src/sessions/session-manager.js';

function commandResult(session: BoundSession, recordedUserInput?: { id: string; text: string; timestamp: string }) {
  return { ...session, session, recordedUserInput };
}

describe('session routes', () => {
  it('returns queued delivery separately from submitted input and exposes cancellation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-queued-route-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const session: BoundSession = { id: 'queued-session', provider: 'claude', projectSlug: 'demo', conversationRef: 'native-chat',
      status: 'bound', startedAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' };
    const submissionId = 'd5f77c99-fdf8-48f7-a4ae-4b7f2caa04c5';
    const queuedInput = { requestId: submissionId, text: 'my draft', requestedAt: session.updatedAt,
      state: 'queued' as const, reason: 'Waiting for input.' };
    const sendKeystrokes = vi.fn(async () => ({ ...commandResult(session), queuedInput }));
    const cancelQueuedInput = vi.fn(async () => ({ session }));
    const ensureAuthenticated = vi.fn(async () => undefined);
    const app = fastify();
    await registerSessionRoutes(app, { ensureAuthenticated } as never, db, {} as never,
      { getSessionById: () => session, sendKeystrokes, cancelQueuedInput } as never);
    try {
      const payload = { submissionId, text: 'my draft', submittedText: 'my draft', keys: ['Enter'] };
      const accepted = await app.inject({ method: 'POST', url: '/api/sessions/queued-session/keys', payload });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ session, queuedInput });
      expect(sendKeystrokes).toHaveBeenCalledWith(session.id, payload, 0);
      const invalid = await app.inject({ method: 'POST', url: '/api/sessions/queued-session/keys', payload: { ...payload, keys: ['Escape'] } });
      expect(invalid.statusCode).toBe(400);
      expect(sendKeystrokes).toHaveBeenCalledTimes(1);
      const cancelled = await app.inject({ method: 'DELETE', url: `/api/sessions/queued-session/queued-inputs/${submissionId}` });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelQueuedInput).toHaveBeenCalledWith(session.id, submissionId);
      expect(ensureAuthenticated).toHaveBeenCalledTimes(3);
    } finally { await app.close(); db.close(); await fs.rm(tempDir, { recursive: true, force: true }); }
  });

  it('accepts message payloads larger than the old route limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-large',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-large',
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
        payload: { text: largeText, keys: ['Enter'] },
      });

      expect(response.statusCode).toBe(200);
      expect(sendKeystrokes).toHaveBeenCalledWith('session-large', { text: largeText, keys: ['Enter'] }, 0);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('rejects message payloads above the expanded session route limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-too-large',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-too-large',
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
        payload: { text: tooLargeText, keys: ['Enter'] },
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
      {
        getSessionById: vi.fn(() => session),
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
        payload: { text: 'try ssd now', keys: ['Enter'] },
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

  it('accepts and explicitly cancels durable model-profile requests', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const requestId = '1e84ca5a-e606-4bc8-b648-93b5c686d101';
    const session: BoundSession = {
      id: 'session-profile',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-profile',
      status: 'bound',
      shouldRestore: true,
      startedAt: '2026-09-18T18:00:00.000Z',
      updatedAt: '2026-09-18T18:00:00.000Z',
    };
    const queued: BoundSession = {
      ...session,
      modelProfileRequest: {
        requestId,
        profile: 'high',
        requestedAt: '2026-09-18T18:01:00.000Z',
        state: 'queued',
        deferredReason: 'turn_running',
      },
    };
    const requestModelProfile = vi.fn(async () => ({ session: queued }));
    const cancelModelProfileRequest = vi.fn(async () => ({ session }));
    const app = fastify();
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {
        getProjectBySlug: vi.fn(async () => ({ slug: 'demo' })),
        getMergedProviderSettings: vi.fn(() => ({ enabled: true })),
      } as never,
      {
        getSessionById: vi.fn(() => session),
        requestModelProfile,
        cancelModelProfileRequest,
      } as never,
    );
    await app.ready();

    try {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-profile/model-profile',
        payload: { profile: 'high' },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ session: queued });
      expect(requestModelProfile).toHaveBeenCalledWith('session-profile', 'high');

      const cancelled = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/session-profile/model-profile/requests/${requestId}`,
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toEqual({ session });
      expect(cancelModelProfileRequest).toHaveBeenCalledWith('session-profile', requestId);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('takes a message with Enter or Stop with Escape, and refuses every other key, text without Enter and removed fields', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-keys-contract-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const session: BoundSession = { id: 'keys-session', provider: 'codex', projectSlug: 'demo', conversationRef: 'native-keys',
      status: 'bound', startedAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' };
    const sendKeystrokes = vi.fn(async () => commandResult(session));
    const app = fastify();
    await registerSessionRoutes(app, { ensureAuthenticated: async () => undefined } as never, db, {} as never,
      { getSessionById: () => session, sendKeystrokes } as never);
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/sessions/keys-session/keys', payload });
    try {
      expect((await post({ text: 'hello', keys: ['Enter'] })).statusCode).toBe(200);
      expect((await post({ submittedText: 'hello', keys: ['Enter'] })).statusCode).toBe(200);
      expect((await post({ keys: ['Escape'] })).statusCode).toBe(200);
      expect(sendKeystrokes).toHaveBeenCalledTimes(3);

      for (const payload of [
        { keys: ['Tab'] }, { keys: ['Up'] }, { keys: ['C-c'] }, { text: 'typed', keys: ['Down'] },
        { text: 'typed without Enter' }, { keys: ['Enter'] }, { keys: ['Escape', 'Enter'] },
        { text: 'stop with text', keys: ['Escape'] },
      ]) {
        const response = await post(payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(JSON.stringify(response.json())).toContain("keys ['Enter'] and text, or keys ['Escape'] alone");
      }
      const removedField = await post({ text: 'typing', keys: ['Enter'], deferScreenUpdate: true });
      expect(removedField.statusCode).toBe(400);
      expect(JSON.stringify(removedField.json())).toContain('deferScreenUpdate');
      expect(sendKeystrokes).toHaveBeenCalledTimes(3);
    } finally { await app.close(); db.close(); await fs.rm(tempDir, { recursive: true, force: true }); }
  });

  it('serves the synthesized status on /screen, whatever the query, and no longer serves terminal routes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-screen-route-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const session: BoundSession = { id: 'screen-session', provider: 'claude', projectSlug: 'demo', conversationRef: 'native-screen',
      status: 'bound', startedAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' };
    const screen = { status: 'Claude idle', capturedAt: '2026-10-14T00:00:01.000Z' };
    const getSessionScreen = vi.fn(async () => ({ session, screen }));
    const app = fastify();
    await registerSessionRoutes(app, { ensureAuthenticated: async () => undefined } as never, db, {} as never,
      { getSessionById: () => session, getSessionScreen } as never);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/sessions/screen-session/screen?lines=120' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ session, screen });
      expect(getSessionScreen).toHaveBeenCalledWith('screen-session');
      expect((await app.inject({ method: 'GET', url: '/api/sessions/screen-session/raw-output' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/sessions/structured-migration' })).statusCode).toBe(404);
    } finally { await app.close(); db.close(); await fs.rm(tempDir, { recursive: true, force: true }); }
  });

  describe('structured sessions', () => {
    const structuredSession: BoundSession = {
      id: 'session-structured',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:structured-first-turn',
      status: 'bound',
      shouldRestore: true,
      startedAt: '2026-10-26T10:00:00.000Z',
      updatedAt: '2026-10-26T10:00:00.000Z',
    };

    it('attaches stored images to a message', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
      const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
      const imageId = 'd5f77c99-fdf8-48f7-a4ae-4b7f2caa04c5';
      const image = { id: imageId, mediaType: 'image/png' as const, name: 'Pasted image.png', sizeBytes: 10, width: 4, height: 4, path: `/data/images/${imageId}.png` };
      const resolve = vi.fn(async () => [image]);
      const sendKeystrokes = vi.fn(async () => commandResult(structuredSession));
      const app = fastify();
      await registerSessionRoutes(
        app,
        { ensureAuthenticated: async () => undefined } as never,
        db,
        {} as never,
        { getSessionById: vi.fn(() => structuredSession), sendKeystrokes } as never,
        { resolve } as never,
      );
      await app.ready();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/sessions/session-structured/keys',
          payload: { text: 'look at this', keys: ['Enter'], imageIds: [imageId] },
        });
        expect(response.statusCode).toBe(200);
        expect(resolve).toHaveBeenCalledWith([imageId], structuredSession);
        expect(sendKeystrokes).toHaveBeenCalledOnce();
        const [, payload] = sendKeystrokes.mock.calls[0] as unknown as [string, { text: string; submittedText: string; imageIds?: string[] }];
        // The envelope names the stored file; SessionManager turns it into a native attachment.
        expect(imagePromptFiles(payload.text, '/data/images')).toEqual([{ path: image.path, mimeType: 'image/png' }]);
        expect(payload.submittedText).toBe(`look at this${imagePromptSuffix([image], 'codex')}`);
        expect(payload.imageIds).toBeUndefined();
      } finally {
        await app.close();
        db.close();
      }
    });

    describe('answering a question the agent asked', () => {
      const requestUrl = '/api/sessions/session-structured/requests/q%201';
      async function routes(manager: Record<string, unknown>, session: BoundSession | undefined = structuredSession) {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
        const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
        const ensureAuthenticated = vi.fn(async () => undefined);
        const app = fastify();
        await registerSessionRoutes(app, { ensureAuthenticated } as never, db, {} as never,
          { getSessionById: vi.fn((id: string) => (id === structuredSession.id ? session : undefined)), ...manager } as never);
        await app.ready();
        return { app, ensureAuthenticated, close: async () => { await app.close(); db.close(); } };
      }

      it('forwards an answer to the session and returns the updated row', async () => {
        const answered = { ...structuredSession, updatedAt: '2026-10-26T11:00:00.000Z' };
        const answerStructuredRequest = vi.fn(async () => answered);
        const r = await routes({ answerStructuredRequest });
        try {
          const body = { decision: 'answer', answers: { schema: ['Strict'] }, text: 'and fast' };
          const response = await r.app.inject({ method: 'POST', url: requestUrl, payload: body });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ session: answered });
          expect(answerStructuredRequest).toHaveBeenCalledWith('session-structured', 'q 1', body);
          expect(r.ensureAuthenticated).toHaveBeenCalledOnce();
        } finally { await r.close(); }
      });

      it('forwards a decline', async () => {
        const answerStructuredRequest = vi.fn(async () => structuredSession);
        const r = await routes({ answerStructuredRequest });
        try {
          const response = await r.app.inject({ method: 'POST', url: requestUrl, payload: { decision: 'decline' } });
          expect(response.statusCode).toBe(200);
          expect(answerStructuredRequest).toHaveBeenCalledWith('session-structured', 'q 1', { decision: 'decline' });
        } finally { await r.close(); }
      });

      it('answers 404 when the request is not waiting for an answer', async () => {
        const answerStructuredRequest = vi.fn(async () => { throw new StructuredRequestNotFoundError(); });
        const r = await routes({ answerStructuredRequest });
        try {
          const response = await r.app.inject({ method: 'POST', url: requestUrl, payload: { decision: 'decline' } });
          expect(response.statusCode).toBe(404);
          expect(response.json()).toEqual({ error: 'That request is no longer waiting for an answer.' });
        } finally { await r.close(); }
      });

      it('answers 404 for an unknown session without asking the manager', async () => {
        const answerStructuredRequest = vi.fn();
        const r = await routes({ answerStructuredRequest });
        try {
          const response = await r.app.inject({ method: 'POST', url: '/api/sessions/unknown/requests/q1', payload: { decision: 'decline' } });
          expect(response.statusCode).toBe(404);
          expect(response.json()).toEqual({ error: 'Session not found.' });
          expect(answerStructuredRequest).not.toHaveBeenCalled();
        } finally { await r.close(); }
      });

      it('passes a refusal from the session on with its status', async () => {
        const answerStructuredRequest = vi.fn(async () => { throw new SessionInputRejectedError('Not now.'); });
        const r = await routes({ answerStructuredRequest });
        try {
          const response = await r.app.inject({ method: 'POST', url: requestUrl, payload: { decision: 'decline' } });
          expect(response.statusCode).toBe(409);
          expect(response.json()).toEqual({ error: 'Not now.' });
        } finally { await r.close(); }
      });

      it.each([
        ['no body', undefined],
        ['an unknown decision', { decision: 'approve' }],
        ['an answer without answers', { decision: 'answer' }],
        ['answers that are not lists', { decision: 'answer', answers: { schema: 'Strict' } }],
        ['a non-string answer', { decision: 'answer', answers: { schema: [1] } }],
        ['an oversized answer', { decision: 'answer', answers: { schema: ['x'.repeat(8_001)] } }],
        ['too many answers for one question', { decision: 'answer', answers: { schema: Array.from({ length: 33 }, () => 'a') } }],
        ['text that is not a string', { decision: 'answer', answers: {}, text: 3 }],
      ])('answers 400 for %s', async (_label, payload) => {
        const answerStructuredRequest = vi.fn();
        const r = await routes({ answerStructuredRequest });
        try {
          const response = await r.app.inject({ method: 'POST', url: requestUrl, ...(payload === undefined ? {} : { payload }) });
          expect(response.statusCode).toBe(400);
          expect(answerStructuredRequest).not.toHaveBeenCalled();
        } finally { await r.close(); }
      });
    });

  });
});
