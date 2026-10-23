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
import { GrantService } from '../src/grants/service.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';

let root: string;
let db: AppDatabase;
let service: CoordinationService;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reference-'));
  db = new AppDatabase(path.join(root, 'state.sqlite'));
  service = new CoordinationService(db, { enabled: true, pilotPaths: [] }, undefined,
    new GrantService(db, new RealtimeEventBus()));
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function bind(provider: ProviderId, overrides: Partial<BoundSession> = {}) {
  const nativeSessionId = randomUUID();
  const session: BoundSession = {
    id: randomUUID(), projectSlug: 'other-project', provider, conversationRef: nativeSessionId,
    title: 'Review the console', tmuxSessionName: 'fixture-only', status: 'bound', shouldRestore: true,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  };
  db.boundSessions.upsert(session);
  const { assignmentId } = service.register({ provider, nativeSessionId, token: randomUUID(), pid: process.pid, cwd: root,
    consoleSessionId: session.id });
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

it.each(['codex', 'claude'] as const)('resolves a registered %s agent before its pending chat has a native resume identity', provider => {
  const { session, assignmentId } = bind(provider, { conversationRef: `pending:${provider}` });
  expect(db.boundSessions.getById(session.id)?.resumeConversationRef).toBeUndefined();
  expect(db.meta.get(`console-session:${assignmentId}`)).toBe(session.id);
  expect(service.conversationReference(session)).toMatchObject({ recipientId: assignmentId, provider,
    projectSlug: session.projectSlug, conversationRef: session.conversationRef });
  db.sqlite.prepare("update coordination_assignments set status='finished' where id=?").run(assignmentId);
  expect(service.conversationReference(session).recipientId).toBe(assignmentId);
});

it('rejects ambiguous pending registrations instead of choosing an agent', () => {
  const { session } = bind('codex', { conversationRef: 'pending:ambiguous' });
  service.register({ provider: 'codex', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid,
    cwd: root, consoleSessionId: session.id });
  expect(() => service.conversationReference(session)).toThrow('no available coordinating agent');
});

it('resolves adopted pending aliases only within their own project and provider', () => {
  const { session, assignmentId } = bind('claude');
  db.pendingConversations.put({ ref: 'pending:old', projectSlug: session.projectSlug, provider: session.provider,
    kind: 'pending', title: 'Original title', updatedAt: session.updatedAt, isBound: true, degraded: false,
    rawMetadata: { adoptedConversationRef: session.conversationRef } });
  expect(service.conversationReference({ ...session, conversationRef: 'pending:old' }).recipientId).toBe(assignmentId);
  expect(() => service.conversationReference({ ...session, projectSlug: 'wrong', conversationRef: 'pending:old' })).toThrow('no connected agent');
});

it('retains finished references and rejects closed, unregistered and disabled agents', () => {
  const { session, assignmentId } = bind('codex');
  db.sqlite.prepare("update coordination_assignments set status='finished' where id=?").run(assignmentId);
  expect(service.conversationReference(session).recipientId).toBe(assignmentId);
  db.boundSessions.upsert({ ...session, resumeConversationRef: randomUUID() });
  expect(() => service.conversationReference(session)).toThrow('no available coordinating agent');
  db.boundSessions.upsert({ ...session, shouldRestore: false });
  expect(() => service.conversationReference(session)).toThrow('no connected agent');
  expect(() => new CoordinationService(db, { enabled: false, pilotPaths: [] }).conversationReference(session)).toThrow('disabled');
});

it.each(['codex', 'claude'] as const)('keeps a finished %s chat reference inert and accepts inbox messages without reopening work', provider => {
  const { session, assignmentId } = bind(provider);
  const sender = service.register({ provider, nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: root }).assignmentId!;
  service.update(assignmentId, { continuation: 'unattended' });
  service.finish(assignmentId, 'Prior human task complete.');
  expect(service.conversationReference(session).recipientId).toBe(assignmentId);
  expect(service.agentStatus(assignmentId).assignment?.status).toBe('finished');
  const message = { priority:'P2' as const, id: randomUUID(), recipientId: assignmentId, text: 'A new peer question, not a new work grant.' };
  expect(service.send(sender, message).queued).toBe(true);
  expect(service.agentStatus(assignmentId).assignment).toMatchObject({ status: 'finished', continuation: 'waiting_for_input' });
  expect(service.poll(assignmentId).messages).toEqual([expect.objectContaining({ id: message.id, text: message.text })]);
  service.finish(assignmentId, 'Peer response is complete.');
  service.send(sender, message);
  expect(service.agentStatus(assignmentId).assignment?.status).toBe('finished');
});

it.each(['closed', 'dead', 'full'] as const)('does not reopen a %s finished recipient', condition => {
  const { session, assignmentId } = bind('codex');
  const sender = service.register({ provider: 'codex', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: root }).assignmentId!;
  service.finish(assignmentId, 'Prior task complete.');
  if (condition === 'closed') db.boundSessions.upsert({ ...session, shouldRestore: false });
  if (condition === 'dead') db.sqlite.prepare("update coordination_assignments set process_start='not-the-current-process' where id=?").run(assignmentId);
  if (condition === 'full') db.sqlite.transaction(() => {
    for (let i = 0; i < 100; i++) db.sqlite.prepare('insert into coordination_messages values(?,?,?,?,?,null,null)')
      .run(randomUUID(), sender, assignmentId, 'Existing inbox entry', new Date().toISOString());
  })();
  const send = () => service.send(sender, { priority: 'P2', id: randomUUID(), recipientId: assignmentId, text: 'New peer question' });
  if (condition === 'full') expect(send).toThrow('inbox is full');
  else expect(send()).toMatchObject({ queued: true, delivery: 'on_resume', recipient: { status: 'stopped' } });
  expect(service.agentStatus(assignmentId).assignment?.status).toBe('finished');
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
