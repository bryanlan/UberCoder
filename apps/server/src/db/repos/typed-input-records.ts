import Database from 'better-sqlite3';

/** How a typed message left the Console: delivered in the request that carried it, or held in the input journal first. */
export type TypedInputHowSent = 'immediate' | 'queued';

export interface TypedInputRecord {
  sessionId: string;
  /** The id of the send. A message that is journaled and retried keeps one id, so it is recorded once. */
  requestId: string;
  provider: string;
  projectSlug: string;
  /** The conversation's provider reference at the time (the native thread or session id). */
  conversationRef: string;
  /** When the backend accepted the message, in UTC. */
  typedAt: string;
  text: string;
  howSent: TypedInputHowSent;
}

/**
 * The permanent record of what the person typed. Rows are only inserted: the table refuses UPDATE and DELETE and has no
 * relation to bound_sessions, so nothing about a session's lifecycle removes them.
 */
export class TypedInputRecordsRepo {
  constructor(private readonly sqlite: Database.Database) {}

  /** Inserts once per (session, request id); a repeat is ignored. Throws if the write fails. */
  append(record: TypedInputRecord): void {
    this.sqlite.prepare(`
      insert or ignore into typed_input_records
        (session_id, request_id, provider, project_slug, conversation_ref, typed_at, recorded_at, text, how_sent)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.sessionId, record.requestId, record.provider, record.projectSlug, record.conversationRef,
      record.typedAt, new Date().toISOString(), record.text, record.howSent);
  }

  /** Records with `since <= typed_at < until` (UTC ISO strings), oldest first. */
  list(since: string, until: string): TypedInputRecord[] {
    const rows = this.sqlite.prepare(`
      select session_id, request_id, provider, project_slug, conversation_ref, typed_at, text, how_sent
      from typed_input_records where typed_at >= ? and typed_at < ? order by typed_at, id
    `).all(since, until) as Array<Record<string, string>>;
    return rows.map(row => ({
      sessionId: row.session_id!, requestId: row.request_id!, provider: row.provider!, projectSlug: row.project_slug!,
      conversationRef: row.conversation_ref!, typedAt: row.typed_at!, text: row.text!, howSent: row.how_sent as TypedInputHowSent,
    }));
  }
}
