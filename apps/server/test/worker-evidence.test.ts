import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { WorkerEvidenceSource } from '../src/workers/evidence.js';
import type { BoundSession, ConversationSummary, NormalizedMessage } from '@agent-console/shared';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-12T16:00:00Z'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-evidence-'));
  const db = new AppDatabase(path.join(root, 'console.sqlite'));
  cleanups.push(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const session: BoundSession = { id: 'worker', provider: 'codex', projectSlug: 'demo', conversationRef: 'native-one',
    status: 'bound', pid: process.pid, isWorking: true, tmuxSessionName: 'fixture', shouldRestore: true,
    startedAt: '2026-10-12T12:00:00Z', updatedAt: '2026-10-12T12:00:00Z' };
  db.boundSessions.upsert(session);
  const conversation: ConversationSummary = { ref: session.conversationRef, provider: 'codex', projectSlug: 'demo', title: 'Original title',
    kind: 'history', isBound: true, degraded: false, updatedAt: session.updatedAt };
  db.conversationIndex.upsert(conversation); db.titleOverrides.set('demo', 'codex', session.conversationRef, 'Same title as left sidebar', session.updatedAt);
  const readLiveMessages = vi.fn(async () => [{ id: 'action', role: 'assistant', text: 'Checking the final module',
    timestamp: '2026-10-12T12:01:00Z' }, { id: 'noise', role: 'status', text: 'Compacting context', timestamp: '2026-10-12T12:02:00Z' }] as NormalizedMessage[]);
  const source = new WorkerEvidenceSource(db, { listActiveProjects: async () => [{ slug: 'demo', displayName: 'Demo' }] } as never,
    { readLiveMessages } as never);
  return { db, source, session, readLiveMessages };
}

it('uses exact sidebar identity and native working state without treating assignment active as running', async () => {
  const f = await fixture();
  f.db.sqlite.prepare('insert into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)')
    .run('assignment', 'codex', 'native-one', 'fixture', 'Verify deployment', 'active', process.pid, 'fixture', f.session.startedAt, f.session.startedAt);
  const first = (await f.source.roster())[0]!;
  expect(first).toMatchObject({ title: 'Same title as left sidebar', working: true, task: 'Verify deployment' });
  f.db.boundSessions.upsert({ ...f.session, isWorking: false });
  expect((await f.source.roster())[0]!.working).toBe(false);
  expect(f.readLiveMessages).not.toHaveBeenCalled(); // Frequent roster reads do not parse output/history.
});

it('excludes suspended sessions and internal exec workers', async () => {
  const f = await fixture();
  f.db.sqlite.prepare('update bound_sessions set manual_suspended_at=? where id=?').run(f.session.updatedAt, f.session.id);
  expect(await f.source.roster()).toEqual([]);
  f.db.sqlite.prepare('update bound_sessions set manual_suspended_at=null where id=?').run(f.session.id);
  f.db.sqlite.prepare('update conversation_index set raw_metadata_json=?').run(JSON.stringify({ originator: 'codex_exec' }));
  expect(await f.source.roster()).toEqual([]);
});

it('collects bounded per-worker actions and cross-repo delivery evidence without acknowledging or sending messages', async () => {
  const f = await fixture(); const time = f.session.updatedAt;
  const insert = f.db.sqlite.prepare('insert into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)');
  insert.run('assignment', 'codex', 'native-one', 'fixture', 'Own task', 'active', process.pid, 'fixture', time, time);
  insert.run('peer', 'claude', 'peer-native', 'fixture', 'Other repository task', 'active', process.pid, 'fixture', time, time);
  f.db.sqlite.prepare('insert into coordination_messages values(?,?,?,?,?,?,?)').run('message', 'assignment', 'peer', 'Please inspect the producer contract.', time, time, null);
  const evidence = await f.source.collect((await f.source.roster())[0]!);
  expect(f.readLiveMessages).toHaveBeenCalledWith(expect.objectContaining({ id: 'worker' }), { maxBytesFromEnd: 128 * 1024 });
  expect(evidence.actions.map((a) => a.text)).toEqual(['Checking the final module']);
  expect(evidence.peers).toEqual([{ direction: 'sent', peer: 'claude: Other repository task',
    text: 'Please inspect the producer contract.', createdAt: time, delivery: 'older pending message: offered, awaiting acknowledgement' }]);
  expect(f.db.sqlite.prepare('select acknowledged_at from coordination_messages').get()).toEqual({ acknowledged_at: null });
  f.db.sqlite.prepare('update coordination_messages set acknowledged_at=?').run(time);
  expect((await f.source.collect((await f.source.roster())[0]!)).peers).toEqual([]);
});
