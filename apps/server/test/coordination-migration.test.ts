import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createCoordinationSchema } from '../src/coordination/schema.js';
import { migrateDatabase } from '../src/db/schema.js';

it('retires version 6 locks once, preserving assignments, inboxes and ownership evidence', () => {
  const db = new Database(':memory:');
  try {
    createCoordinationSchema(db);
    db.exec('create table schema_version (version integer primary key, name text, applied_at text)');
    for (let version = 1; version <= 6; version++) db.prepare('insert into schema_version values(?,?,?)').run(version, 'fixture', 'before');
    db.prepare('insert into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)')
      .run('a', 'codex', 'native', 'private-hash', 'Unfinished work', 'disconnected', 1, 'start', 'before', 'before');
    db.prepare('insert into coordination_scopes values(?,?,?,?)').run('a', '/repo', '/repo/.git', 'Shared document');
    db.prepare('insert into coordination_claims values(?,?,?,?)').run('/repo', '.', 'a', 'acquired');
    db.prepare('insert into coordination_git_operations values(?,?,?,?,?,?)').run('/repo/.git', '/repo', 'a', 'started', 1, 'start');
    db.prepare('insert into coordination_messages values(?,?,?,?,?,?,?)').run('m', 'a', 'a', 'Keep my draft', 'before', null, null);
    const assignments = db.prepare('select * from coordination_assignments').all();
    const scopes = db.prepare('select * from coordination_scopes').all();
    const messages = db.prepare('select * from coordination_messages').all();

    migrateDatabase(db);
    migrateDatabase(db);

    expect(db.prepare('select * from coordination_assignments').all()).toEqual(assignments);
    expect(db.prepare('select * from coordination_scopes').all()).toEqual(scopes);
    expect(db.prepare('select * from coordination_messages').all()).toEqual(messages);
    expect(db.prepare("select name from sqlite_master where name in ('coordination_claims', 'coordination_git_operations')").all()).toEqual([]);
    const events = db.prepare('select kind, text from coordination_events order by seq').all() as { kind: string; text: string }[];
    expect(events.map((event) => event.kind)).toEqual(['claim-retired', 'git-operation-retired']);
    expect(JSON.parse(events[0]!.text)).toMatchObject({ path: '.', acquiredAt: 'acquired' });
    expect(JSON.parse(events[1]!.text)).toMatchObject({ repository: '/repo/.git', startedAt: 'started', pid: 1, processStart: 'start' });
    expect(db.prepare('select max(version) version from schema_version').get()).toEqual({ version: 7 });
  } finally { db.close(); }
});
