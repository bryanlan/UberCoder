import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import cookie from '@fastify/cookie';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES, type BoundSession, type ProviderId } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { AuthService } from '../src/security/auth-service.js';
import { ImageStore } from '../src/images/store.js';
import { registerImageRoutes } from '../src/images/routes.js';
import { imageMessageDisplay, imagePromptDisplay, imagePromptSuffix } from '../src/images/prompt.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';
import { parseCodexConversationFile } from '../src/providers/transcripts/codex.js';
import { parseClaudeConversationFile } from '../src/providers/transcripts/claude.js';
import { mergeTimelineMessages } from '../src/sessions/timeline-merge.js';
import { sanitizeSearchableProse } from '../src/lib/prose-sanitizer.js';
import { normalizeComparableText, stableTextHash } from '../src/lib/text.js';

async function fixture(provider: ProviderId = 'codex', pending = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'console-images-'));
  const db = new AppDatabase(path.join(directory, 'console.sqlite'));
  const session: BoundSession = {
    id: 'session-1', projectSlug: 'demo', provider, conversationRef: pending ? 'pending:image' : 'history-1',
    tmuxSessionName: 'fixture', status: 'bound', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  if (pending) db.pendingConversations.put({
    ref: session.conversationRef, projectSlug: 'demo', provider, kind: 'pending', title: 'New chat',
    updatedAt: session.startedAt, isBound: true, degraded: false, boundSessionId: session.id,
  });
  const store = new ImageStore(path.join(directory, 'images'));
  const app = fastify();
  await app.register(cookie);
  const auth = new AuthService({ security: {
    sessionSecret: 'fixture-session-secret-long-enough', sessionTtlHours: 24, cookieSecure: false, trustTailscaleHeaders: false,
  } } as never, db);
  app.post('/fixture-login', async (_request, reply) => auth.loginWithPassword(reply));
  const sendKeystrokes = vi.fn(async (_id: string, payload: { submittedText?: string }) => ({
    ...session, session,
    recordedUserInput: { id: 'recorded', timestamp: new Date().toISOString(), ...imagePromptDisplay(payload.submittedText ?? '') },
  }));
  const restartPendingSessionWithInitialPrompt = vi.fn(async (input: { initialPrompt: string }) => ({
    ...session, session,
    recordedUserInput: { id: 'first', timestamp: session.startedAt, ...imagePromptDisplay(input.initialPrompt) },
  }));
  const sessions = { getSessionById: () => session, allowsLiteralSelectionKeystroke: async () => false, sendKeystrokes, restartPendingSessionWithInitialPrompt };
  registerImageRoutes(app, auth, sessions as never, store);
  await registerSessionRoutes(app, auth, db, {
    getProjectBySlug: async () => ({ slug: 'demo', path: directory }), getMergedProviderSettings: () => ({ enabled: true }),
  } as never, { get: () => ({ id: provider }) } as never, sessions as never, store);
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/fixture-login' });
  const authCookie = String(login.headers['set-cookie']).split(';')[0]!;
  const headers = { cookie: authCookie, 'x-csrf-token': login.json().csrfToken };
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#25af65' } }).png().toBuffer();
  async function upload(bytes = png, mediaType = 'image/png') {
    return await app.inject({ method: 'POST', url: '/api/sessions/session-1/images', headers: { ...headers, 'content-type': mediaType }, payload: bytes });
  }
  return { app, db, directory, session, store, headers, png, upload, sendKeystrokes, restartPendingSessionWithInitialPrompt,
    async close() { await app.close(); db.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

describe('clipboard image backend', () => {
  it('requires authentication and CSRF, validates pixels and preserves exact bytes outside session runtime', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'POST', url: '/api/sessions/session-1/images', headers: { 'content-type': 'image/png' }, payload: f.png })).statusCode).toBe(401);
      expect((await f.app.inject({ method: 'POST', url: '/api/sessions/session-1/images', headers: { cookie: f.headers.cookie, 'content-type': 'image/png' }, payload: f.png })).statusCode).toBe(403);
      expect((await f.upload(Buffer.from('not an image'))).statusCode).toBe(400);
      expect((await f.upload(f.png, 'image/jpeg')).statusCode).toBe(400);
      expect((await f.upload(f.png.subarray(0, 48))).statusCode).toBe(400);
      expect((await f.upload(Buffer.alloc(MAX_IMAGE_BYTES + 1))).statusCode).toBe(413);
      expect((await f.upload(Buffer.from('<svg/>'), 'image/svg+xml')).statusCode).toBe(415);
      const response = await f.upload();
      expect(response.statusCode).toBe(201);
      const image = response.json().image;
      expect(image).toMatchObject({ mediaType: 'image/png', width: 24, height: 16, sizeBytes: f.png.length });
      expect((await f.app.inject({ url: `/api/images/${image.id}` })).statusCode).toBe(401);
      await fs.mkdir(path.join(f.directory, 'runtime', 'session-1'), { recursive: true });
      await fs.rm(path.join(f.directory, 'runtime'), { recursive: true });
      const restartedStore = new ImageStore(path.join(f.directory, 'images'));
      expect((await restartedStore.read(image.id)).bytes).toEqual(f.png);
      const read = await f.app.inject({ url: `/api/images/${image.id}`, headers: f.headers });
      expect(read.statusCode).toBe(200);
      expect(read.rawPayload).toEqual(f.png);
      expect(read.headers['cache-control']).toBe('private, no-store');
      expect((await f.app.inject({ url: '/api/images/not-a-valid-id', headers: f.headers })).statusCode).toBe(404);
    } finally { await f.close(); }
  });

  for (const provider of ['codex', 'claude'] as const) {
    it(`${provider} submits captions and image-only messages without replacing existing bypass text`, async () => {
      const f = await fixture(provider);
      try {
        const image = (await f.upload()).json().image;
        const response = await f.app.inject({ method: 'POST', url: '/api/sessions/session-1/keys', headers: f.headers,
          payload: { keys: ['Enter'], submittedText: 'What is shown?', imageIds: [image.id] },
        });
        expect(response.statusCode).toBe(200);
        const payload = f.sendKeystrokes.mock.calls[0]![1];
        expect(payload).toMatchObject({ keys: ['Enter'], text: expect.stringContaining(path.join(f.directory, 'images', image.id)) });
        expect((payload as { text: string }).text).not.toContain('What is shown?');
        expect(payload.submittedText).toContain('What is shown?');
        expect(payload.submittedText).toContain(provider === 'codex' ? 'view_image' : 'Read');
        expect(response.json().recordedUserInput).toMatchObject({ text: 'What is shown?', images: [image] });
        const imageOnly = await f.app.inject({ method: 'POST', url: '/api/sessions/session-1/keys', headers: f.headers, payload: { keys: ['Enter'], imageIds: [image.id] } });
        expect(imageOnly.json().recordedUserInput).toMatchObject({ text: '', images: [image] });
        const slash = await f.app.inject({ method: 'POST', url: '/api/sessions/session-1/keys', headers: f.headers, payload: { text: '/model', keys: ['Enter'], imageIds: [image.id] } });
        expect(slash.statusCode).toBe(400);
        const typing = await f.app.inject({ method: 'POST', url: '/api/sessions/session-1/keys', headers: f.headers, payload: { text: 'typing', imageIds: [image.id] } });
        expect(typing.statusCode).toBe(400);
        const foreign = await f.store.save(f.png, 'image/png', { ...f.session, projectSlug: 'other' });
        const foreignResponse = await f.app.inject({ method: 'POST', url: '/api/sessions/session-1/keys', headers: f.headers, payload: { keys: ['Enter'], imageIds: [foreign.id] } });
        expect(foreignResponse.statusCode).toBe(403);
        expect(f.sendKeystrokes).toHaveBeenCalledTimes(2);
      } finally { await f.close(); }
    });

    it(`${provider} keeps uploaded thumbnails after provider transcript catch-up`, async () => {
      const f = await fixture(provider);
      try {
        const image = (await f.upload()).json().image;
        const attached = await f.store.resolve([image.id], f.session);
        const prompt = 'What is shown?' + imagePromptSuffix(attached, provider);
        const filePath = path.join(f.directory, 'history.jsonl');
        const record = provider === 'codex'
          ? { timestamp: f.session.startedAt, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }
          : { uuid: 'user-image', timestamp: f.session.startedAt, type: 'user', message: { role: 'user', content: [{ type: 'text', text: `<pasted_content id="0d00">\n${prompt}\n</pasted_content id="0d00">` }] } };
        await fs.writeFile(filePath, JSON.stringify(record) + '\n');
        const parse = provider === 'codex' ? parseCodexConversationFile : parseClaudeConversationFile;
        const parsed = await parse({ provider, projectSlug: 'demo', conversationRef: 'history-1', filePath });
        expect(parsed.displayMessages[0]!.text).toBe(prompt);
        expect(parsed.summary.rawMetadata?.firstUserTextHash).toBe(stableTextHash(normalizeComparableText(prompt)));
        const live = { ...parsed.displayMessages[0]!, text: prompt, id: 'live:one', source: 'user-input' as const };
        const merged = mergeTimelineMessages({ allMessages: parsed.messages, visibleMessages: parsed.displayMessages, liveMessages: [live] });
        expect(merged.mergedMessages).toHaveLength(1);
        expect(imageMessageDisplay(merged.mergedMessages[0]!)).toMatchObject({ text: 'What is shown?', images: [image] });
        expect(parsed.summary.title).toBe('What is shown?');
        expect(sanitizeSearchableProse(prompt)).toBe('What is shown?');
        expect(imagePromptDisplay(prompt.replace(image.id, 'invalid')).images).toBeUndefined();
        if (provider === 'claude') {
          const suffix = imagePromptSuffix(attached, provider);
          const bypassPrompt = `What is shown?<pasted_content id="paste-2">\n${suffix}\n</pasted_content id="paste-2">`;
          await fs.writeFile(filePath, JSON.stringify({ ...record, message: { role: 'user', content: [{ type: 'text', text: bypassPrompt }] } }) + '\n');
          const bypassParsed = await parse({ provider, projectSlug: 'demo', conversationRef: 'history-1', filePath });
          expect(bypassParsed.displayMessages[0]!.text).toBe(prompt);
          expect(imageMessageDisplay(bypassParsed.displayMessages[0]!)).toMatchObject({ text: 'What is shown?', images: [image] });
        }
      } finally { await f.close(); }
    });
  }

  it('includes uploaded images in the first pending Codex launch prompt', async () => {
    const f = await fixture('codex', true);
    try {
      const image = (await f.upload()).json().image;
      const response = await f.app.inject({ method: 'POST', url: '/api/sessions/session-1/keys', headers: f.headers, payload: { text: 'Check this', keys: ['Enter'], submittedText: 'Check this', imageIds: [image.id] } });
      expect(response.statusCode).toBe(200);
      expect(f.restartPendingSessionWithInitialPrompt).toHaveBeenCalledWith(expect.objectContaining({ initialPrompt: expect.stringContaining(image.id) }));
      expect(f.sendKeystrokes).not.toHaveBeenCalled();
      expect(response.json().recordedUserInput).toMatchObject({ text: 'Check this', images: [image] });
    } finally { await f.close(); }
  });
});
