// This fixed control notice carries no peer text and grants no task authority.
// Providers record it as native input; transcript adapters classify it separately.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergedProviderSettings } from '../config/service.js';
import type { BoundSession } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
export { PEER_WAKE_PROMPT, UNATTENDED_CONTINUATION_PROMPT, GRANTED_RESTART_PROMPT, isCoordinationWakePrompt } from '../../../../scripts/coordination-notices.mjs';

export const peerWakeAttemptKey = (messageId: string) => `peer-wake-attempt:${messageId}`;
export const peerWakeFollowupKey = (messageId: string) => `peer-wake-followup:${messageId}`;
export const peerWakeRestoreKey = (sessionId: string) => `peer-wake-restore:${sessionId}`;
export const peerWakeComposerKey = (sessionId: string) => `peer-wake-composer:${sessionId}`;
export const peerWakePauseDetailsKey = (assignmentId: string) => `peer-wake-pause-details:${assignmentId}`;
export interface AutomaticInputPause {
  sessionId: string;
  timestamp: string;
  code: 'human_input' | 'human_keys' | 'human_stop' | 'native_cancellation' | 'manual_suspend' | 'release' | 'owned_close';
  reason: string;
}
export interface WakeBlock {
  code: string;
  reason: string;
  availableBytes?: number;
  thresholdBytes?: number;
}
export interface PeerWakeComposer {
  assignmentId: string;
  pid: number;
  startedAt: string;
  timestamp: string;
  status: 'pasting' | 'staged' | 'retiring' | 'submitting';
  notice: 'peer' | 'unattended';
  continuationRevision?: number;
  messages: Array<{ id: string; key: string }>;
}
const peerWakePausedKey = (assignmentId: string) => `peer-wake-paused:${assignmentId}`;
export const peerWakePaused = (db: AppDatabase, assignmentId: string): boolean => db.meta.get(peerWakePausedKey(assignmentId)) === 'true';
export function setPeerWakePaused(db: AppDatabase, assignmentId: string, paused: boolean, details?: AutomaticInputPause): void {
  db.meta.set(peerWakePausedKey(assignmentId), String(paused));
  if (paused && details) {
    db.meta.set(peerWakePauseDetailsKey(assignmentId), JSON.stringify(details));
    db.sqlite.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,null,?,?,?)')
      .run(assignmentId, 'automatic-input-paused', JSON.stringify(details), details.timestamp);
  }
}
export const peerResumeAttemptKey = (session: Pick<BoundSession, 'id' | 'pid' | 'startedAt'>) =>
  `peer-resume-attempt:${session.id}:${session.pid}:${session.startedAt}`;

export interface PeerWakeAttempt {
  status: 'submitting' | 'submitted' | 'failed' | 'deferred';
  sessionId: string;
  timestamp: string;
  reason?: string;
  restoration?: 'already_loaded' | 'restored';
  block?: WakeBlock;
  nextAttemptAt?: string;
}

const execFileAsync = promisify(execFile);
export async function queueCodexNotice(threadId: string, settings: MergedProviderSettings, cwd: string, prompt: string): Promise<void> {
  // Use the provider's queue, preserving its native composer. Failure is reported;
  // never fall back to typing or start a second provider process for this thread.
  const executable = settings.commands.resumeCommand[0];
  if (!executable) throw new Error('Configured Codex resume executable is missing.');
  await execFileAsync(executable, ['queue', '--thread', threadId, '--message', prompt], {
    cwd, env: { ...process.env, ...settings.commands.env }, timeout: 5_000, maxBuffer: 64 * 1024,
  });
}
