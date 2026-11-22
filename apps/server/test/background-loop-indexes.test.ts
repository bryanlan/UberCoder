import { expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { BLOCKED_SUPERVISOR_HANDOFF_SQL } from '../src/db/schema.js';

// The wake loop, the project tree and the handoff flush run every few seconds. Each of these reads scanned a whole
// table on the live file (2026-11-22); the plans must keep using the migration 26 indexes.
const db = new AppDatabase(':memory:');
const plan = (sql: string) => (db.sqlite.prepare(`explain query plan ${sql}`).all() as Array<{ detail: string }>)
  .map(row => row.detail).join('\n');
const sqlOf = (read: () => unknown) => {
  const prepare = vi.spyOn(db.sqlite, 'prepare');
  try { read(); return prepare.mock.calls.map(([sql]) => sql); } finally { prepare.mockRestore(); }
};

it('finds assignments with unacknowledged mail through the pending-recipient index', () => {
  expect(plan(`select a.id from coordination_assignments a where a.status!='finished'
    or exists(select 1 from coordination_messages m where m.recipient_id=a.id and m.acknowledged_at is null)`))
    .toContain('coordination_messages_pending_recipient');
});

it('finds the newest session row of a conversation through the conversation index', () => {
  for (const read of [() => db.boundSessions.listTreeVisible(), () => db.conversationIndex.list()]) {
    const [sql] = sqlOf(read);
    expect(plan(sql!)).toContain('bound_sessions_conversation');
  }
});

it('reads only blocked supervisor handoffs', () => {
  expect(plan(`select key,value from meta where ${BLOCKED_SUPERVISOR_HANDOFF_SQL}`)).toContain('meta_blocked_supervisor_handoffs');
});
