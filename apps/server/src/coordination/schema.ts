import type Database from 'better-sqlite3';

// Keep version 6 intact as migration history. Version 7 preserves the ownership
// evidence as activity, then removes the tables and their locking semantics.
export function retireCoordinationEnforcement(db: Database.Database): void {
  db.exec(`
    insert into coordination_events(assignment_id, checkout, kind, text, timestamp)
      select assignment_id, checkout, 'claim-retired',
        json_object('path', path, 'acquiredAt', acquired_at,
          'note', 'Historical claim only. Enforcement retired; unfinished files were not changed.'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      from coordination_claims;
    insert into coordination_events(assignment_id, checkout, kind, text, timestamp)
      select assignment_id, checkout, 'git-operation-retired',
        json_object('repository', repository, 'startedAt', started_at,
          'pid', server_pid, 'processStart', process_start,
          'note', 'Historical operation only. Inspect Git state before continuing; no Git state was changed.'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      from coordination_git_operations;
    drop table coordination_git_operations;
    drop table coordination_claims;
  `);
}

export function createCoordinationSchema(db: Database.Database): void {
  db.exec(`
    create table coordination_assignments (
      id text primary key, provider text not null, native_session_id text not null,
      token_hash text not null, description text not null, status text not null,
      pid integer not null, process_start text not null,
      started_at text not null, last_seen_at text not null,
      unique(provider, native_session_id)
    );
    create table coordination_scopes (
      assignment_id text not null references coordination_assignments(id),
      checkout text not null, repository text not null, summary text not null,
      primary key(assignment_id, checkout)
    );
    create table coordination_claims (
      checkout text not null, path text not null,
      assignment_id text not null references coordination_assignments(id),
      acquired_at text not null, primary key(checkout, path)
    );
    create table coordination_events (
      seq integer primary key autoincrement,
      assignment_id text not null references coordination_assignments(id),
      checkout text, kind text not null, text text not null, timestamp text not null
    );
    create index coordination_events_checkout on coordination_events(checkout, seq);
    create table coordination_messages (
      id text primary key,
      sender_id text not null references coordination_assignments(id),
      recipient_id text not null references coordination_assignments(id),
      text text not null, created_at text not null, supplied_at text, acknowledged_at text
    );
    create index coordination_messages_inbox on coordination_messages(recipient_id, created_at);
    create table coordination_git_operations (
      repository text primary key, checkout text not null, assignment_id text not null,
      started_at text not null, server_pid integer not null, process_start text not null
    );
  `);
}
