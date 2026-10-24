import type { AssignmentTask } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import { continuationControl } from './continuation.js';
import { messagePolicy } from './inbox-policy.js';
import { peerWakePaused } from './wake.js';

export type TaskInput = Partial<Pick<AssignmentTask, 'deliverable' | 'doneWhen' | 'evidencePath' | 'state' | 'actionNeeded'>>;
const taskKey = (id: string) => `assignment-task:${id}`;
export function assignmentTask(db: AppDatabase, id: string): AssignmentTask | null {
  const value = db.meta.get(taskKey(id));
  return value ? JSON.parse(value) as AssignmentTask : null;
}
export function updateTask(db: AppDatabase, id: string, input: TaskInput): AssignmentTask {
  const prior = assignmentTask(db, id);
  const task = { ...prior, ...input, ownerId: id, state: input.state ?? prior?.state ?? 'working',
    actionNeeded: input.actionNeeded === undefined ? prior?.actionNeeded ?? null : input.actionNeeded };
  for (const field of ['deliverable', 'doneWhen', 'evidencePath'] as const) {
    if (!task[field]?.trim()) throw new Error(`Task ${field} is required. Supply a complete task record first.`);
  }
  if (task.state === 'blocked' && !task.actionNeeded?.trim()) throw new Error('Blocked tasks require actionNeeded from the supervisor. Expected external waits stay working with awaiting.');
  if (task.state !== 'blocked') task.actionNeeded = null;
  const value = { ...task, deliverable: task.deliverable!, doneWhen: task.doneWhen!, evidencePath: task.evidencePath!,
    revision: (prior?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
  // Repeated status text must not move the task or create another notification.
  if (prior && ['deliverable', 'doneWhen', 'evidencePath', 'state', 'actionNeeded'].every(field =>
    prior[field as keyof AssignmentTask] === value[field as keyof AssignmentTask])) return prior;
  db.meta.set(taskKey(id), JSON.stringify(value));
  return value;
}

/** A task command is separate from message urgency. Recheck it immediately before input. */
export function dispatchEligible(db: AppDatabase, messageId: string): boolean {
  const policy = messagePolicy(db, messageId);
  if (policy.origin !== 'dispatch' || policy.expired) return false;
  const control = continuationControl(db, policy.recipientId);
  const task = assignmentTask(db, policy.recipientId);
  const dispatch = db.meta.get(`task-dispatch:${messageId}`);
  const status = db.sqlite.prepare('select status from coordination_assignments where id=?').get(policy.recipientId) as { status: string } | undefined;
  const parent = db.sqlite.prepare('select status from coordination_assignments where id=?').get(policy.senderId) as { status: string } | undefined;
  return !!parent && parent.status !== 'finished' && !!dispatch && JSON.parse(dispatch).taskRevision === task?.revision && task?.state === 'working'
    && status?.status !== 'finished' && !!status && control.supervisorId === policy.senderId
    && control.continuation === 'unattended' && !control.awaiting
    && !['blocked', 'stalled'].includes(control.recovery?.status ?? '') && !peerWakePaused(db, policy.recipientId);
}
