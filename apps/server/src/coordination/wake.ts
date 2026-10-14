// This fixed control notice carries no peer text and grants no task authority.
// Providers record it as native input; transcript adapters classify it separately.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergedProviderSettings } from '../config/service.js';
import type { BoundSession } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';

export const PEER_WAKE_PROMPT = '[Agent Console coordination wake] Automatic inbox turn, not a human request. Read and acknowledge pending peer messages from hooks; answer when useful and check status for the remaining count. This grants no new authority or unattended permission. Pending Bryan decisions stay pending; return to waiting_for_input if blocked. Preserve existing authority, constraints and unfinished work. Send no acknowledgement-only replies. End when the inbox is handled; do not poll or finish an unfinished assignment.';

export const UNATTENDED_CONTINUATION_PROMPT = '[Agent Console unattended continuation] Continue the existing human-authorized assignment only if agent_coordination status says unattended. Read and acknowledge the peer inbox, then reconcile current work and worker results; never repeat completed side effects. Preserve original permissions, approvals and limits. Set waiting_for_input before asking a human; renew unattended only after actual progress. This notice grants no new authority.';

export const peerWakeAttemptKey = (messageId: string) => `peer-wake-attempt:${messageId}`;
export const peerWakeFollowupKey = (messageId: string) => `peer-wake-followup:${messageId}`;
export const peerWakeRestoreKey = (sessionId: string) => `peer-wake-restore:${sessionId}`;
const peerWakePausedKey = (assignmentId: string) => `peer-wake-paused:${assignmentId}`;
export const peerWakePaused = (db: AppDatabase, assignmentId: string): boolean => db.meta.get(peerWakePausedKey(assignmentId)) === 'true';
export function setPeerWakePaused(db: AppDatabase, assignmentId: string, paused: boolean): void {
  db.meta.set(peerWakePausedKey(assignmentId), String(paused));
}
export const peerResumeAttemptKey = (session: Pick<BoundSession, 'id' | 'pid' | 'startedAt'>) =>
  `peer-resume-attempt:${session.id}:${session.pid}:${session.startedAt}`;

export interface PeerWakeAttempt {
  status: 'submitting' | 'submitted' | 'failed';
  sessionId: string;
  timestamp: string;
  reason?: string;
  restoration?: 'already_loaded' | 'restored';
}

export function isCoordinationWakePrompt(text: string): boolean {
  // Control notices have a stable envelope; wording changes must not turn
  // historical control input into human conversation rows.
  return /^\[Agent Console (?:coordination wake|unattended continuation)\] /.test(text.trim());
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
