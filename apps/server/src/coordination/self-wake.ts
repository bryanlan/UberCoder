import type { AppDatabase } from '../db/database.js';

export interface SelfWakeInput {
  intervalSeconds: number;
  objective: string;
}

export interface SelfWakeSchedule extends SelfWakeInput {
  id: string;
  sessionId: string;
  nextWakeAt: string;
  state: 'scheduled' | 'submitting' | 'blocked';
  lastSubmittedAt?: string;
  reason?: string;
}

const key = (assignmentId: string) => `assignment-self-wake:${assignmentId}`;

export function selfWakeSchedule(db: AppDatabase, assignmentId: string): SelfWakeSchedule | undefined {
  const value = db.meta.get(key(assignmentId));
  return value ? JSON.parse(value) as SelfWakeSchedule : undefined;
}

export function saveSelfWake(db: AppDatabase, assignmentId: string, schedule: SelfWakeSchedule): void {
  db.meta.set(key(assignmentId), JSON.stringify(schedule));
}

export function cancelSelfWake(db: AppDatabase, assignmentId: string): void {
  db.sqlite.prepare('delete from meta where key=?').run(key(assignmentId));
}
