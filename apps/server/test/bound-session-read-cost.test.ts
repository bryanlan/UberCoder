import { afterEach, expect, it, vi } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';

const db = new AppDatabase(':memory:');
afterEach(() => vi.restoreAllMocks());

it('keeps historical sessions out of routine session hydration while preserving selection and order', () => {
  const base: BoundSession = {
    id: 'live', provider: 'codex', projectSlug: 'demo', conversationRef: 'live',
    status: 'bound', shouldRestore: true, startedAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z', isWorking: false,
  };
  for (let i = 0; i < 100; i++) db.boundSessions.upsert({ ...base, id: `old-${i}`, conversationRef: `old-${i}`, status: 'ended', shouldRestore: false });
  for (const [i, status] of ['starting', 'bound', 'releasing', 'failed'].entries()) {
    db.boundSessions.upsert({ ...base, id: status, conversationRef: status, status: status as BoundSession['status'], updatedAt: `2026-11-0${i + 2}T00:00:00.000Z` });
  }
  const all = db.boundSessions.list();
  const prepare = vi.spyOn(db.sqlite, 'prepare');
  expect(db.boundSessions.listRestorable()).toEqual(all.filter(s => s.shouldRestore && s.status !== 'ended'));
  expect(prepare.mock.calls.length).toBeLessThan(20);
  db.close();
});
