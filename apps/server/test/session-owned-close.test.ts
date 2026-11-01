import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../src/providers/types.js';
import { setContinuation } from '../src/coordination/continuation.js';
import { project, provider } from './helpers/session-fixtures.js';
import type { FakeTransportPlugin } from './helpers/structured-fixtures.js';
import { structuredSessionFixture } from './helpers/structured-session-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** A helper conversation whose assignment has finished (by default), with its native history indexed and readable. */
async function fixture(options: { launched?: boolean; status?: 'finished' | 'waiting'; history?: boolean; registeredHistory?: boolean } = {}) {
  let transcriptPath = '';
  const adapter: ProviderAdapter = options.registeredHistory ? { ...provider, getConversation: async (_project, ref) => ({
    summary: { ref, kind: 'history' as const, projectSlug: project.slug, provider: provider.id, title: 'Helper',
      updatedAt: new Date().toISOString(), transcriptPath, isBound: true, degraded: false }, messages: [],
  }) } : provider;
  const f = structuredSessionFixture({ provider: adapter });
  cleanups.push(f.cleanup);
  transcriptPath = path.join(f.root, 'native.jsonl');
  const plugins: FakeTransportPlugin[] = [f.plugin];
  let manager = f.manager;
  const session = await f.bindHistory(randomUUID(), { title: 'Helper', launchContext: options.launched === false ? undefined : {
    launchedBy: randomUUID(), launcherName: 'Lead', grantIds: [randomUUID()], requestId: randomUUID(), supervisorId: randomUUID(),
  } });
  const assignmentId = randomUUID(), now = new Date().toISOString();
  f.db.sqlite.prepare(`insert into coordination_assignments (id,provider,native_session_id,token_hash,description,status,pid,process_start,started_at,last_seen_at)
    values(?,?,?,?,?,?,?,?,?,?)`).run(assignmentId, 'codex', session.conversationRef, 'token-hash', 'Helper', options.status ?? 'finished', 123, 'old-process', now, now);
  setContinuation(f.db, assignmentId, 'unattended');
  const history = JSON.stringify({ type: 'assistant', message: { content: 'Completed helper work.' } }) + '\n';
  if (options.history !== false) {
    await fs.writeFile(transcriptPath, history);
    f.db.conversationIndex.upsert({ ref: session.conversationRef, kind: 'history', projectSlug: project.slug, provider: provider.id,
      title: 'Helper', updatedAt: now, transcriptPath, isBound: true, degraded: false });
  }
  const threads = () => plugins.flatMap(plugin => plugin.instances).flatMap(instance => instance.sessions).filter(thread => thread.nativeSessionId === session.conversationRef);
  /** Loads of the conversation: the bind's own, plus any reload after it. */
  const resumes = () => plugins.flatMap(plugin => plugin.instances).flatMap(instance => instance.calls).filter(call => call.method === 'resume').length;
  return { db: f.db, root: f.root, session, assignmentId, transcriptPath, history, resumes, thread: () => threads().at(-1)!,
    row: () => f.db.boundSessions.getById(session.id)!, get manager() { return manager; },
    /** A new backend over the same database: the helper's provider process ended with the old one, and nothing is loaded. */
    restart: async () => { const next = await f.restartBackend(); plugins.push(next.plugin); manager = next.manager; return next.manager; } };
}

describe('Finished agent inbox retention and explicit close', () => {
  it('adopts the exact registered native identity while retaining a finished helper inbox', async () => {
    const f = await fixture({ registeredHistory: true });
    f.db.boundSessions.upsert({ ...f.row(), conversationRef: 'pending:startup-registration', resumeConversationRef: undefined });
    f.db.meta.set(`console-session:${f.assignmentId}`, f.session.id);
    const manager = await f.restart();
    await manager.reconcileSessions();
    expect(f.row()).toMatchObject({ shouldRestore: true, idleSuspendedAt: expect.any(String) });
    await manager.adoptRegisteredSession(f.session.id, 'codex', f.session.conversationRef);
    expect(f.row()).toMatchObject({ conversationRef: f.session.conversationRef, shouldRestore: true });
    expect(await fs.readFile(f.transcriptPath, 'utf8')).toBe(f.history);
    expect(f.resumes()).toBe(1);
  });

  it('retains a finished exited helper inbox without eager restoration across restart', async () => {
    const f = await fixture();
    const manager = await f.restart();
    await manager.reconcileSessions();
    expect(f.row()).toMatchObject({ shouldRestore: true, isWorking: false, idleSuspendedAt: expect.any(String) });
    expect(manager.listActiveSessions().map(s => s.id)).toContain(f.session.id);
    expect(manager.getSessionByConversation(project.slug, 'codex', f.session.conversationRef)?.id).toBe(f.session.id);
    expect(await fs.readFile(f.transcriptPath, 'utf8')).toBe(f.history);
    expect(f.db.conversationIndex.get(project.slug, 'codex', f.session.conversationRef)?.kind).toBe('history');
    await f.restart(); await f.manager.reconcileSessions();
    expect(f.resumes()).toBe(1);
    expect(f.row().shouldRestore).toBe(true);
  });

  it('keeps a finished inbox restorable while screen polling leaves its process asleep', async () => {
    const f = await fixture();
    const manager = await f.restart();
    await manager.getSessionScreen(f.session.id);
    expect(f.row().shouldRestore).toBe(true);
    expect(f.resumes()).toBe(1);
  });

  it('keeps a completed close ended when a screen poll waiting behind it finishes', async () => {
    const f = await fixture({ status: 'waiting' });
    const manager = await f.restart();
    const releasing = manager.releaseSession(f.session.id);
    const screen = manager.getSessionScreen(f.session.id);
    await releasing;
    expect(await screen).toBeUndefined();
    expect(f.row()).toMatchObject({ status: 'ended', shouldRestore: false });
    expect(f.resumes()).toBe(1);
  });

  it('retains a finished inbox both before and after its history becomes readable', async () => {
    const f = await fixture({ history: false });
    const manager = await f.restart();
    await manager.reconcileSessions();
    expect(f.resumes()).toBe(1);
    expect(f.row().shouldRestore).toBe(true);
    await fs.writeFile(f.transcriptPath, f.history);
    f.db.conversationIndex.upsert({ ref: f.session.conversationRef, kind: 'history', projectSlug: project.slug, provider: 'codex',
      title: 'Helper', updatedAt: new Date().toISOString(), transcriptPath: f.transcriptPath, isBound: true, degraded: false });
    await manager.reconcileSessions();
    expect(f.row().shouldRestore).toBe(true);
    expect(f.resumes()).toBe(1);
    expect(await fs.readFile(f.transcriptPath, 'utf8')).toBe(f.history);
  });

  it('clears a dead completed provider working flag while preserving its restorable inbox', async () => {
    const f = await fixture();
    f.db.boundSessions.upsert({ ...f.row(), isWorking: true });
    const manager = await f.restart();
    await manager.reconcileSessions();
    expect(f.row()).toMatchObject({ shouldRestore: true, isWorking: false });
    expect(f.row().pid).toBeUndefined();
    expect(f.row().idleSuspendedAt).toBeTruthy();
    expect(f.resumes()).toBe(1);
  });

  it('keeps a live finished helper available for inbox delivery', async () => {
    const f = await fixture(); await f.manager.reconcileSessions();
    expect(f.row().shouldRestore).toBe(true);
    expect(f.row().idleSuspendedAt).toBeUndefined();
    expect(f.thread().closed).toBe(false);
  });

  it('preserves manual suspension and allows the human resume action', async () => {
    const f = await fixture();
    f.db.boundSessions.setManualSuspendedAt(f.session.id, new Date().toISOString());
    const manager = await f.restart();
    await manager.reconcileSessions();
    expect(f.row().manualSuspendedAt).toBeTruthy();
    expect(f.row().shouldRestore).toBe(true);
    expect(f.resumes()).toBe(1);
    const resumed = await manager.resumeSession(f.session.id);
    expect(resumed.manualSuspendedAt).toBeUndefined();
    expect(f.resumes()).toBe(2);
    expect(f.thread().closed).toBe(false);
  });

  it('also leaves a finished human-created conversation asleep and restorable', async () => {
    const f = await fixture({ launched: false });
    f.db.meta.set(`assignment-continuation:${f.assignmentId}`, '');
    const manager = await f.restart();
    await manager.reconcileSessions();
    expect(f.row().shouldRestore).toBe(true);
    expect(f.row().idleSuspendedAt).toBeTruthy();
    expect(f.resumes()).toBe(1);
  });
});
