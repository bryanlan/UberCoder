#!/usr/bin/env node
// Lists the messages a person typed into Agent Console, from the backend's permanent typed_input_records table.
// Read-only. Usage: node scripts/typed-input-records.mjs --since 2026-11-02T00:00:00Z --until 2026-11-09T00:00:00Z [--db PATH]
// Output: one JSON object per line, oldest first, window `since <= typedAt < until` (UTC).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: typed-input-records.mjs --since <ISO time> --until <ISO time> [--db <sqlite path>]');
  process.exit(2);
}

function parseTime(name, value) {
  const time = value ? new Date(value) : undefined;
  if (!time || Number.isNaN(time.getTime())) usage(`${name} must be an ISO date or time.`);
  return time.toISOString();
}

function defaultDatabasePath() {
  const configPath = process.env.AGENT_CONSOLE_CONFIG ?? path.join(os.homedir(), '.config/agent-console/config.json');
  const configured = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')).databasePath : undefined;
  return (configured ?? '~/.local/share/agent-console/agent-console.sqlite').replace(/^~(?=\/)/, os.homedir());
}

export function listTypedInputRecords(db, since, until) {
  return db.prepare(`
    select session_id as sessionId, request_id as requestId, provider, project_slug as projectSlug,
      conversation_ref as conversationRef, typed_at as typedAt, text, how_sent as howSent
    from typed_input_records where typed_at >= ? and typed_at < ? order by typed_at, id
  `).all(since, until);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const since = parseTime('--since', option('--since'));
  const until = parseTime('--until', option('--until'));
  const databasePath = option('--db') ?? defaultDatabasePath();
  if (!fs.existsSync(databasePath)) usage(`No database at ${databasePath}.`);
  const db = new Database(databasePath, { readonly: true });
  try {
    for (const row of listTypedInputRecords(db, since, until)) console.log(JSON.stringify(row));
  } finally {
    db.close();
  }
}
