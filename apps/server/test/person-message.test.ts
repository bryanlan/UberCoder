import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerPersonMessageRoutes } from '../src/routes/person-message.js';
import { LiveOutputReader } from '../src/sessions/live-output/reader.js';
import { structuredSessionFixture } from './helpers/structured-session-fixture.js';
import { project, provider, providerSettings } from './helpers/session-fixtures.js';

describe('local person-message route', () => {
  it('requires an owner-only credential and loopback, validates prefix and delivers through the real structured input journal', async () => {
    const f = structuredSessionFixture();
    const app = fastify();
    try {
      const { session } = await f.bindNew();
      registerPersonMessageRoutes(app, f.root, f.manager,
        { getProjectBySlug: async () => project, getMergedProviderSettings: () => providerSettings } as never,
        { get: () => provider } as never, new LiveOutputReader(), f.db);
      const url = `/api/local/person-message/${session.id}/input`;
      const key = path.join(f.root, 'person-message.key');
      const token = randomBytes(32).toString('hex');
      const headers = { authorization: `Bearer ${token}` };
      expect((await app.inject({ method: 'POST', url, payload: { text: 'Bryan: test' } })).statusCode).toBe(401);
      fs.writeFileSync(key, token, { mode: 0o600 });
      expect((await app.inject({ method: 'POST', url, headers, remoteAddress: '192.0.2.1', payload: { text: 'Bryan: test' } })).statusCode).toBe(401);
      fs.chmodSync(key, 0o644);
      expect((await app.inject({ method: 'POST', url, headers, payload: { text: 'Bryan: test' } })).statusCode).toBe(401);
      fs.chmodSync(key, 0o600);
      expect((await app.inject({ method: 'POST', url, headers, payload: { text: 'test' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url, headers, payload: { text: 'Bryan: how is progress?' } })).statusCode).toBe(200);
      expect(f.calls(session.conversationRef, 'sendTurn')[0]?.args[0]).toMatchObject({ text: 'Bryan: how is progress?' });
      const read = await app.inject({ url: `/api/local/person-message/${session.id}/messages`, headers });
      expect(read.statusCode).toBe(200);
      expect(read.json().messages.some((m: { text: string }) => m.text === 'Bryan: how is progress?')).toBe(true);
    } finally { await app.close(); await f.cleanup(); }
  });
});
