import type Database from 'better-sqlite3';
import type { RecordedUserInput, SessionQueuedInput } from '@agent-console/shared';
import { imagePromptDisplay } from '../images/prompt.js';

/** One message a person sent with a submission id. The journal replaces any send-and-confirm step: queued, submitting, submitted. */
export interface QueuedInputRecord {
  requestId: string;
  text: string;
  requestedAt: string;
  state: 'queued' | 'submitting' | 'submitted' | 'failed' | 'cancelled';
  reason: string;
  recordedUserInput?: RecordedUserInput;
  /** The provider turn that received the message, and whether it started or steered one. */
  turnId?: string;
  deliveryMode?: 'turn' | 'steer';
  /** When the transport first refused this message before writing it, in an unbroken run of such refusals. */
  notSentSince?: string;
}

const prefix = (sessionId: string) => `session-input:${sessionId}:`;
const pendingKey = (sessionId: string) => `session-input-pending:${sessionId}`;

const pending = (record: QueuedInputRecord) => !['submitted', 'cancelled'].includes(record.state);

/** Delivery journals use the existing durable metadata store, not runtime files. */
export class InputQueue {
  constructor(private readonly sqlite: Database.Database) {}

  /** Moves on every Stop and every direct send, so a queued send captured before them is known to be stale. */
  revision(sessionId: string): number {
    const row = this.sqlite.prepare('select value from meta where key = ?')
      .get(`session-input-revision:${sessionId}`) as { value: string } | undefined;
    return Number(row?.value ?? 0);
  }

  advanceRevision(sessionId: string): void {
    this.sqlite.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run(`session-input-revision:${sessionId}`, String(this.revision(sessionId) + 1));
  }

  get(sessionId: string, requestId: string): QueuedInputRecord | undefined {
    const row = this.sqlite.prepare('select value from meta where key = ?')
      .get(prefix(sessionId) + requestId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as QueuedInputRecord : undefined;
  }

  list(sessionId: string): QueuedInputRecord[] {
    return this.pendingIds(sessionId).map(id => this.get(sessionId, id)!);
  }

  private pendingIds(sessionId: string): string[] {
    const row = this.sqlite.prepare('select value from meta where key = ?')
      .get(pendingKey(sessionId)) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as string[] : [];
  }

  put(sessionId: string, record: QueuedInputRecord): void {
    this.sqlite.transaction(() => {
      // A late observation or transport failure cannot revive an abandoned send.
      if (this.get(sessionId, record.requestId)?.state === 'cancelled') return;
      const ids = this.pendingIds(sessionId).filter(id => id !== record.requestId || pending(record));
      if (pending(record) && !ids.includes(record.requestId)) ids.push(record.requestId);
      const put = this.sqlite.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value');
      put.run(prefix(sessionId) + record.requestId, JSON.stringify(record));
      put.run(pendingKey(sessionId), JSON.stringify(ids));
    })();
  }

  summaries(sessionId: string): SessionQueuedInput[] {
    return this.list(sessionId).map(queuedInputSummary);
  }
}

export function queuedInputSummary(record: QueuedInputRecord): SessionQueuedInput {
  return {
    requestId: record.requestId,
    text: imagePromptDisplay(record.text).text,
    requestedAt: record.requestedAt,
    state: record.state === 'submitting' || record.state === 'failed' ? record.state : 'queued',
    reason: record.reason,
  };
}
