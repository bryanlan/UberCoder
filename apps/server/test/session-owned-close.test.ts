import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { processStart } from '../src/coordination/service.js';
import { setContinuation } from '../src/coordination/continuation.js';
import { FakeTmux, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: { launched?: boolean; status?: 'finished' | 'waiting'; history?: boolean; registeredHistory?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-owned-close-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite')), tmux = new FakeTmux();
  tmux.paneText = 'OpenAI Codex\nCompleted helper work.\n› Ask Codex to do anything\ngpt-6-luna xhigh · ~/demo';
  const transcriptPath = path.join(root, 'native.jsonl');
  const adapter = options.registeredHistory ? { ...provider, getConversation: async (_project: unknown, ref: string) => ({
    summary: { ref, kind: 'history' as const, projectSlug: project.slug, provider: provider.id, title: 'Helper',
      updatedAt: new Date().toISOString(), transcriptPath, isBound: true, degraded: false }, messages: [],
  }) } : provider;
  let manager = createRecoveryManager(db, tmux, path.join(root, 'runtime'), undefined, adapter);
  const session = await manager.bindConversation({ project, provider, providerSettings, conversationRef: randomUUID(),
    kind: 'history', title: 'Helper', launchContext: options.launched === false ? undefined : {
      launchedBy: randomUUID(), launcherName: 'Lead', grantIds: [randomUUID()], requestId: randomUUID(), flags: [], supervisorId: randomUUID(),
    } });
  const assignmentId = randomUUID(), now = new Date().toISOString();
  db.sqlite.prepare(`insert into coordination_assignments (id,provider,native_session_id,token_hash,description,status,pid,process_start,started_at,last_seen_at)
    values(?,?,?,?,?,?,?,?,?,?)`).run(assignmentId, 'codex', session.conversationRef, 'token-hash', 'Helper', options.status ?? 'finished', 123, 'old-process', now, now);
  setContinuation(db, assignmentId, 'unattended');
  const history = JSON.stringify({ type: 'assistant', message: { content: 'Completed helper work.' } }) + '\n';
  if (options.history !== false) {
    await fs.writeFile(transcriptPath, history);
    db.conversationIndex.upsert({ ref: session.conversationRef, kind: 'history', projectSlug: project.slug, provider: provider.id,
      title: 'Helper', updatedAt: now, transcriptPath, isBound: true, degraded: false });
  }
  cleanups.push(async () => { await manager.stop(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { db, tmux, session, assignmentId, transcriptPath, history, get manager() { return manager; },
    restart: async () => { await manager.stop(); manager = createRecoveryManager(db, tmux, path.join(root, 'runtime'), undefined, adapter); } };
}

describe('Finished agent inbox retention and explicit close', () => {
  it('retries startup adoption from the exact registered native identity while retaining a finished helper inbox', async () => {
    const f = await fixture({ registeredHistory: true });
    f.db.boundSessions.upsert({ ...f.session, conversationRef: 'pending:startup-registration', resumeConversationRef: undefined });
    f.db.meta.set(`console-session:${f.assignmentId}`, f.session.id);
    f.tmux.alive.clear();
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ conversationRef: f.session.conversationRef, shouldRestore: true });
    expect(await fs.readFile(f.transcriptPath, 'utf8')).toBe(f.history);
    expect(f.tmux.created).toHaveLength(1);
  });
  it('retains a finished exited helper inbox without eager restoration across restart', async () => {
    const f = await fixture(); f.tmux.alive.clear();
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ shouldRestore: true, isWorking: false });
    expect(f.manager.listActiveSessions().map(s => s.id)).toContain(f.session.id);
    expect(f.manager.getSessionByConversation(project.slug, 'codex', f.session.conversationRef)?.id).toBe(f.session.id);
    expect(await fs.readFile(f.transcriptPath, 'utf8')).toBe(f.history);
    expect(f.db.conversationIndex.get(project.slug, 'codex', f.session.conversationRef)?.kind).toBe('history');
    await f.restart(); await f.manager.reconcileSessions();
    expect(f.tmux.created).toHaveLength(1);
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
  });

  it('keeps a finished inbox restorable while screen polling leaves its process asleep', async () => {
    const f = await fixture(); f.tmux.alive.clear();
    await f.manager.getSessionScreen(f.session.id);
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(f.tmux.created).toHaveLength(1);
  });

  it('keeps a completed close ended when an in-flight screen poll finishes its liveness read', async () => {
    const f = await fixture({ status: 'waiting' }); let reads = 0;
    f.tmux.hasSession = async () => {
      if (++reads === 2) await f.manager.releaseSession(f.session.id);
      return f.tmux.alive.has(f.session.tmuxSessionName);
    };
    expect(await f.manager.getSessionScreen(f.session.id)).toBeUndefined();
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
  });

  it('retains a finished inbox both before and after its history becomes readable', async () => {
    const f = await fixture({ history: false }); f.tmux.alive.clear();
    await f.manager.reconcileSessions();
    expect(f.tmux.created).toHaveLength(1);
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    await fs.writeFile(f.transcriptPath, f.history);
    f.db.conversationIndex.upsert({ ref: f.session.conversationRef, kind: 'history', projectSlug: project.slug, provider: 'codex',
      title: 'Helper', updatedAt: new Date().toISOString(), transcriptPath: f.transcriptPath, isBound: true, degraded: false });
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(await fs.readFile(f.transcriptPath, 'utf8')).toBe(f.history);
  });

  it('does not archive a finished helper whose native process still runs outside its missing tmux pane', async () => {
    const f = await fixture(); f.tmux.alive.clear();
    f.db.sqlite.prepare('update coordination_assignments set pid=?,process_start=? where id=?').run(process.pid, processStart(process.pid), f.assignmentId);
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(f.tmux.created).toHaveLength(1);
  });

  it('clears a dead completed provider working flag while preserving its restorable inbox', async () => {
    const f = await fixture(); f.tmux.alive.clear();
    f.db.boundSessions.upsert({ ...f.session, isWorking: true });
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ shouldRestore: true, isWorking: false });
    expect(f.db.boundSessions.getById(f.session.id)?.pid).toBeUndefined();
    expect(f.db.boundSessions.getById(f.session.id)?.idleSuspendedAt).toBeTruthy();
    expect(f.tmux.created).toHaveLength(1);
  });

  it('keeps a live finished helper available for inbox delivery', async () => {
    const f = await fixture(); await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
  });

  it('preserves manual suspension and allows the human resume action', async () => {
    const f = await fixture();
    f.db.boundSessions.setManualSuspendedAt(f.session.id, new Date().toISOString()); f.tmux.alive.clear();
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)?.manualSuspendedAt).toBeTruthy();
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    const resumed = await f.manager.resumeSession(f.session.id);
    expect(resumed.manualSuspendedAt).toBeUndefined();
    expect(f.tmux.alive.has(f.session.tmuxSessionName)).toBe(true);
  });

  it('also leaves a finished human-created conversation asleep and restorable', async () => {
    const f = await fixture({ launched: false }); f.tmux.alive.clear();
    f.db.meta.set(`assignment-continuation:${f.assignmentId}`, '');
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(f.tmux.created).toHaveLength(1);
  });

  it('does not archive on unknown tmux liveness', async () => {
    const f = await fixture(); f.tmux.hasSessionResults.push(new Error('tmux unavailable'));
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(f.tmux.created).toHaveLength(1);
  });

  it('preserves a replacement provider that appears during a stale liveness read', async () => {
    const f = await fixture(); f.tmux.alive.clear();
    let changed = false;
    f.tmux.hasSession = async () => {
      if (!changed) {
        changed = true;
        f.db.boundSessions.upsert({ ...f.session, pid: 987654, startedAt: new Date(Date.now() + 1000).toISOString(), isWorking: true });
      }
      return false;
    };
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ pid: 987654, shouldRestore: true, isWorking: true });
    expect(f.db.boundSessions.getById(f.session.id)?.idleSuspendedAt).toBeUndefined();
  });

  it('rechecks assignment completion after liveness I/O', async () => {
    const f = await fixture(); f.tmux.alive.clear(); let reads = 0;
    f.tmux.hasSession = async () => { if (++reads === 2) f.db.sqlite.prepare("update coordination_assignments set status='waiting' where id=?").run(f.assignmentId); return false; };
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)?.shouldRestore).toBe(true);
    expect(f.tmux.created).toHaveLength(1);
  });
});
