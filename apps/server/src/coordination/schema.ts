import type Database from 'better-sqlite3';

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
