import type Database from 'better-sqlite3';
import type { RecordedUserInput, SessionQueuedInput } from '@agent-console/shared';
import { imagePromptDisplay } from '../images/prompt.js';

export interface QueuedInputRecord {
  requestId: string;
  text: string;
  initialText?: string;
  requestedAt: string;
  state: 'queued' | 'awaiting_input' | 'submitting' | 'submitted' | 'failed' | 'cancelled';
  reason: string;
  baselineInput?: string;
  typedAt?: string;
  panePid?: number;
  nativeRevision?: number;
  recordedUserInput?: RecordedUserInput;
}

/** The same delta is used for transport and native paste confirmation. */
export function queuedTransportText(record: QueuedInputRecord): string {
  return record.baselineInput?.trim() ? record.initialText ?? record.text : record.text;
}

const prefix = (sessionId: string) => `session-input:${sessionId}:`;
const remnantKey = (sessionId: string) => `session-input-remnant:${sessionId}`;
const pendingKey = (sessionId: string) => `session-input-pending:${sessionId}`;
export interface QueuedInputRemnant { requestId: string; text: string; panePid: number; nativeRevision?: number }

const pending = (record: QueuedInputRecord) => !['submitted', 'cancelled'].includes(record.state);

/** Delivery journals use the existing durable metadata store, not runtime files. */
export class InputQueue {
  constructor(private readonly sqlite: Database.Database) {}

  staged(sessionId: string): { text: string; prefix: string; panePid: number; hasPaste?: boolean } | undefined {
    const row = this.sqlite.prepare('select value from meta where key = ?')
      .get(`session-draft:${sessionId}`) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  stage(sessionId: string, draft: { text: string; prefix: string; panePid: number; hasPaste?: boolean } | undefined): void {
    const key = `session-draft:${sessionId}`;
    if (!draft) { this.sqlite.prepare('delete from meta where key = ?').run(key); return; }
    this.sqlite.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run(key, JSON.stringify(draft));
  }

  /** Cancellation owns only the whole draft typed into an otherwise empty composer. */
  cancelledRemnant(sessionId: string, record: QueuedInputRecord, panePid: number | null | undefined): QueuedInputRemnant | undefined {
    if (['awaiting_input', 'failed'].includes(record.state) && record.panePid !== undefined && !record.baselineInput?.trim()) {
      return { requestId: record.requestId, text: record.text, panePid: record.panePid, nativeRevision: record.nativeRevision };
    }
    if (record.state !== 'queued') return undefined;
    const draft = this.staged(sessionId);
    if (!draft || draft.panePid !== panePid || draft.prefix.trim() || draft.text.trim() !== record.text.trim()) return undefined;
    // Live typing precedes the queued Enter. Keep its cleanup ownership out of
    // the queued record's panePid/nativeRevision delivery and replay guards.
    return { requestId: record.requestId, text: record.text, panePid: draft.panePid, nativeRevision: this.revision(sessionId) };
  }

  /** Text Console typed into an otherwise empty composer before cancellation. */
  remnant(sessionId: string): QueuedInputRemnant | undefined {
    const row = this.sqlite.prepare('select value from meta where key = ?')
      .get(remnantKey(sessionId)) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as QueuedInputRemnant : undefined;
  }

  setRemnant(sessionId: string, remnant: QueuedInputRemnant | undefined): void {
    if (!remnant) { this.sqlite.prepare('delete from meta where key = ?').run(remnantKey(sessionId)); return; }
    this.sqlite.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run(remnantKey(sessionId), JSON.stringify(remnant));
  }

  revision(sessionId: string): number {
    const row = this.sqlite.prepare('select value from meta where key = ?')
      .get(`session-input-revision:${sessionId}`) as { value: string } | undefined;
    return Number(row?.value ?? 0);
  }

  invalidateNativeInput(sessionId: string): void {
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
    state: record.state === 'submitting' ? 'submitting' : record.state === 'failed' ? 'needs_review'
      : record.state === 'awaiting_input' ? 'waiting_for_input' : 'queued',
    reason: record.reason,
  };
}
