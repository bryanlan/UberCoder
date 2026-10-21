import { randomUUID } from 'node:crypto';
import type { AssignmentContinuation, AssignmentRecovery } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';

export const CONTINUATION_DELAYS_MS = [15_000, 45_000, 120_000] as const;
export const AWAIT_ALERT_MS = 4 * 60 * 60_000;
export const UNATTENDED_IDLE_MS = 5 * 60_000;
export const CONTINUATION_POLICY = 'Unattended means permission to continue the existing human-authorized assignment without another prompt. It grants no new authority. Assignments start waiting_for_input. Peer-message wake is enabled by default, independently of continuation. After handling its inbox, an unattended assignment continues its authorized work in that same turn unless recovery is blocked or stalled. A waiting assignment handles its inbox and returns to waiting; pending Bryan decisions stay pending. A wake grants no new authority or continuation permission and does not spend or reset the work budget. Human Stop or manual pause disables peer wake until the next accepted human turn; peer messages and agent updates cannot clear that pause. Use update continuation: unattended only for authorized continued work; set waiting_for_input before asking a human for a decision. Renew unattended only after actual progress, never to suppress a stall warning. Ordinary native turn-end waiting status preserves this permission; Console Stop, new human input, manual suspension and release pause it. Declare supervisorId on the worker and use notifySupervisor: true for a result handoff; worker facts cannot enable the supervisor or reset its budget. For a long external job, update awaiting with a short description while unattended, then end the turn. Awaiting suppresses automatic continuation without spending its budget; the next new peer message clears it and resumes authorized work. Set awaiting to null to cancel a wait. After four hours the supervisor receives one alert. Automatic continuation is bounded to three attempts with backoff, and preserves drafts, approvals and resource limits.';
export interface ContinuationSignal { key: string; timestamp: string; source: string; reason: string }
export interface ContinuationControl {
  continuation: AssignmentContinuation;
  supervisorId: string | null;
  awaiting?: { description: string; startedAt: string; alerted?: boolean } | null;
  revision: number;
  enabledAt: string | null;
  signals: ContinuationSignal[];
  seenSignals: string[];
  recovery: (AssignmentRecovery & { startedAt: string }) | null;
}
const key = (id: string) => `assignment-continuation:${id}`;

export function continuationControl(db: AppDatabase, id: string): ContinuationControl {
  const value = db.meta.get(key(id));
  if (value) return JSON.parse(value) as ContinuationControl;
  return { continuation: 'waiting_for_input', supervisorId: null, revision: 0, enabledAt: null,
    signals: [], seenSignals: [], recovery: null };
}
export function saveContinuation(db: AppDatabase, id: string, control: ContinuationControl): void {
  db.meta.set(key(id), JSON.stringify(control));
}
export function setContinuation(db: AppDatabase, id: string, continuation: AssignmentContinuation,
  supervisorId?: string | null): ContinuationControl {
  const prior = continuationControl(db, id);
  const next = { ...prior, continuation, supervisorId: supervisorId === undefined ? prior.supervisorId : supervisorId,
    revision: prior.revision + 1, enabledAt: continuation === 'unattended' ? new Date().toISOString() : null,
    signals: [], recovery: null, awaiting: null };
  saveContinuation(db, id, next); return next;
}

/** Waiting is scheduling state, never a permission renewal or budget reset. */
export function setAwaiting(db: AppDatabase, id: string, description: string | null): void {
  const control = continuationControl(db, id);
  if (description !== null && control.continuation !== 'unattended') throw new Error('Awaiting requires unattended continuation.');
  control.awaiting = description === null ? null : { description, startedAt: new Date().toISOString() };
  // An authenticated agent declaring a wait has acknowledged its submitted turn.
  if (description !== null && control.recovery?.status === 'submitted') control.recovery.status = 'scheduled';
  control.revision++;
  saveContinuation(db, id, control);
}

export function endAwaiting(db: AppDatabase, id: string): void {
  if (continuationControl(db, id).awaiting) setAwaiting(db, id, null);
}

/** Durable, once-per-wait inbox alert, retried if the supervisor inbox is full. */
export function alertOverdueAwait(db: AppDatabase, id: string, now = Date.now()): boolean {
  return db.sqlite.transaction(() => {
    const control = continuationControl(db, id), awaiting = control.awaiting;
    if (control.continuation !== 'unattended' || !awaiting || awaiting.alerted || !control.supervisorId
      || now - Date.parse(awaiting.startedAt) < AWAIT_ALERT_MS) return false;
    const parent = db.sqlite.prepare('select status from coordination_assignments where id=?').get(control.supervisorId) as { status: string } | undefined;
    if (!parent) return false;
    const count = db.sqlite.prepare('select count(*) as n from coordination_messages where recipient_id=? and acknowledged_at is null')
      .get(control.supervisorId) as { n: number };
    if (count.n >= 100) return false;
    const timestamp = new Date(now).toISOString();
    const reason = `Supervised worker ${id} has awaited an external result for at least four hours: ${awaiting.description}`;
    db.sqlite.prepare('insert into coordination_messages values(?,?,?,?,?,null,null)')
      .run(randomUUID(), id, control.supervisorId, reason, timestamp);
    awaiting.alerted = true;
    saveContinuation(db, id, control);
    endAwaiting(db, control.supervisorId);
    signalContinuation(db, control.supervisorId, { key: `worker-await:${id}:${awaiting.startedAt}`, source: id, timestamp, reason });
    return true;
  })();
}

/** Native/declared worker facts request continuation; they never enable it. */
export function signalContinuation(db: AppDatabase, id: string, signal: ContinuationSignal): boolean {
  const control = continuationControl(db, id);
  const observedAt = Date.parse(signal.timestamp), enabledAt = Date.parse(control.enabledAt ?? '');
  if (control.continuation !== 'unattended' || !Number.isFinite(observedAt) || !Number.isFinite(enabledAt) || observedAt < enabledAt
    || control.seenSignals.includes(signal.key)) return false;
  control.seenSignals = [...control.seenSignals, signal.key].slice(-128);
  control.signals = [...control.signals, signal].slice(-16);
  // Facts cannot renew permission or reset a spent/ambiguous recovery budget.
  saveContinuation(db, id, control); return true;
}

export function prepareContinuation(db: AppDatabase, id: string, idleSince: string | undefined, now = Date.now()): ContinuationControl {
  const control = continuationControl(db, id);
  if (control.continuation !== 'unattended' || !control.enabledAt || control.awaiting) return control;
  if (control.recovery?.status === 'submitting') {
    control.recovery = { ...control.recovery, status: 'blocked', reason: 'Continuation submission was interrupted. Review the conversation before enabling unattended work again.' };
  } else if (control.recovery && control.recovery.attempts >= CONTINUATION_DELAYS_MS.length
    && control.recovery.status !== 'blocked' && control.recovery.status !== 'stalled') {
    control.recovery = { ...control.recovery, status: 'stalled', reason: 'Three automatic continuations ended without renewing the unattended assignment. Review its progress before enabling continuation again.' };
  } else if (!control.recovery) {
    const observedIdle = Date.parse(idleSince ?? '');
    const idle = Math.max(Number.isFinite(observedIdle) ? observedIdle : 0, Date.parse(control.enabledAt));
    if (!control.signals.length && (!Number.isFinite(idle) || now - idle < UNATTENDED_IDLE_MS)) return control;
    control.recovery = { status: 'scheduled', attempts: 0,
      reason: control.signals.at(-1)?.reason ?? 'The unattended assignment is idle with unfinished work.',
      startedAt: new Date(now).toISOString(), nextAttemptAt: new Date(now + CONTINUATION_DELAYS_MS[0]).toISOString() };
  } else if (control.recovery.status === 'submitted' && now >= Date.parse(control.recovery.nextAttemptAt)) {
    if (control.recovery.attempts >= CONTINUATION_DELAYS_MS.length) {
      control.recovery = { ...control.recovery, status: 'stalled', reason: 'Three automatic continuations ended without renewing the unattended assignment. Review its progress before enabling continuation again.' };
    } else control.recovery = { ...control.recovery, status: 'scheduled' };
  }
  saveContinuation(db, id, control); return control;
}

export function pendingContinuation(control: ContinuationControl, now = Date.now()): boolean {
  return control.continuation === 'unattended' && !control.awaiting && control.recovery?.status === 'scheduled'
    && now >= Date.parse(control.recovery.nextAttemptAt);
}
