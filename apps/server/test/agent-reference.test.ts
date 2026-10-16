import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { BoundSession, ProviderId } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { registerCoordinationRoutes } from '../src/coordination/transport.js';

let root: string;
let db: AppDatabase;
let service: CoordinationService;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reference-'));
  db = new AppDatabase(path.join(root, 'state.sqlite'));
  service = new CoordinationService(db, { enabled: true, pilotPaths: [] });
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function bind(provider: ProviderId, overrides: Partial<BoundSession> = {}) {
  const nativeSessionId = randomUUID();
  const { assignmentId } = service.register({ provider, nativeSessionId, token: randomUUID(), pid: process.pid, cwd: root });
  const session: BoundSession = {
    id: randomUUID(), projectSlug: 'other-project', provider, conversationRef: nativeSessionId,
    title: 'Review the console', tmuxSessionName: 'fixture-only', status: 'bound', shouldRestore: true,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  };
  db.boundSessions.upsert(session);
  return { session, assignmentId: assignmentId!, nativeSessionId };
}

it.each(['codex', 'claude'] as const)('resolves the exact %s assignment across projects without enrolled scope or provider input', provider => {
  const { session, assignmentId } = bind(provider);
  const reference = service.conversationReference(session);
  expect(reference).toEqual({ recipientId: assignmentId, provider, projectSlug: session.projectSlug,
    conversationRef: session.conversationRef, title: session.title });
  expect(reference.recipientId).not.toBe(session.id);
  expect(reference.recipientId).not.toBe(session.conversationRef);
  expect(db.sqlite.prepare('select count(*) as n from coordination_messages').get()).toEqual({ n: 0 });
  expect(() => service.conversationReference({ ...session, projectSlug: 'wrong-project' })).toThrow('no connected agent');
  expect(() => service.conversationReference({ ...session, provider: provider === 'codex' ? 'claude' : 'codex' })).toThrow('no connected agent');
});

it('resolves a pending binding by its native resume identity and retains a sleeping agent', () => {
  const { session, nativeSessionId, assignmentId } = bind('codex');
  db.boundSessions.upsert({ ...session, conversationRef: 'pending:first', resumeConversationRef: nativeSessionId,
    pid: null, idleSuspendedAt: new Date().toISOString() });
  db.sqlite.prepare("update coordination_assignments set status='disconnected' where id=?").run(assignmentId);
  expect(service.conversationReference({ ...session, conversationRef: 'pending:first' }).recipientId).toBe(assignmentId);
});

it('resolves adopted pending aliases only within their own project and provider', () => {
  const { session, assignmentId } = bind('claude');
  db.pendingConversations.put({ ref: 'pending:old', projectSlug: session.projectSlug, provider: session.provider,
    kind: 'pending', title: 'Original title', updatedAt: session.updatedAt, isBound: true, degraded: false,
    rawMetadata: { adoptedConversationRef: session.conversationRef } });
  expect(service.conversationReference({ ...session, conversationRef: 'pending:old' }).recipientId).toBe(assignmentId);
  expect(() => service.conversationReference({ ...session, projectSlug: 'wrong', conversationRef: 'pending:old' })).toThrow('no connected agent');
});

it('rejects finished, closed, unregistered and disabled agents', () => {
  const { session, assignmentId } = bind('codex');
  db.sqlite.prepare("update coordination_assignments set status='finished' where id=?").run(assignmentId);
  expect(() => service.conversationReference(session)).toThrow('no available coordinating agent');
  db.boundSessions.upsert({ ...session, resumeConversationRef: randomUUID() });
  expect(() => service.conversationReference(session)).toThrow('no available coordinating agent');
  db.boundSessions.upsert({ ...session, shouldRestore: false });
  expect(() => service.conversationReference(session)).toThrow('no connected agent');
  expect(() => new CoordinationService(db, { enabled: false, pilotPaths: [] }).conversationReference(session)).toThrow('disabled');
});

it('requires browser authentication and validates the reference before resolving it', async () => {
  const { session, assignmentId } = bind('codex');
  const app = fastify();
  await registerCoordinationRoutes(app, { ensureAuthenticated: async (request: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (v: unknown) => void } }) => {
    if (request.headers.authorization !== 'fixture') reply.code(401).send({ error: 'Authentication required.' });
  } } as never, service);
  try {
    const url = `/api/agent-reference?${new URLSearchParams({ projectSlug: session.projectSlug, provider: session.provider, conversationRef: session.conversationRef })}`;
    expect((await app.inject(url)).statusCode).toBe(401);
    const response = await app.inject({ url, headers: { authorization: 'fixture' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().recipientId).toBe(assignmentId);
    expect((await app.inject({ url: '/api/agent-reference?provider=unknown', headers: { authorization: 'fixture' } })).statusCode).toBe(400);
    db.boundSessions.upsert({ ...session, status: 'ended' });
    expect((await app.inject({ url, headers: { authorization: 'fixture' } })).statusCode).toBe(409);
  } finally { await app.close(); }
});
