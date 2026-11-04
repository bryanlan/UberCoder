// What the Vibe plugin knows about Mistral Vibe's ACP dialect. Checked against Vibe 3.0.4 on 2026-11-03
// (see docs/structured-providers.md, "Vibe plugin"). Standard ACP lives in transport/acp; this file is only Vibe's own.

import { spawn } from 'node:child_process';
import type { TransportCapabilities } from '../types.js';
import { hostIdFor as acpHostId, launchMetaKey, turnMetaKey } from '../acp/meta.js';

/** JSON-RPC code Vibe returns when the subscription is rate limited. There is no reset time. */
export const VIBE_RATE_LIMIT_CODE = -31001;

export const VIBE_RATE_LIMIT_NOTICE = 'Mistral Vibe rate limit reached; try again later or switch provider';

/** The router command that records the limit. One name, so a later catalog rename is a one-line change. */
export const VIBE_QUOTA_COMMAND = 'wo';

export const VIBE_QUOTA_LIMITED_ARGS = ['quota', 'limited', '--subscription', 'mistral_vibe'] as const;

export const DEFAULT_VIBE_COMMAND = ['vibe-acp'];

export const VIBE_CAPABILITIES: TransportCapabilities = {
  processModel: 'per-session',
  nativeIds: 'server-allocated',
  resume: 'reattach',
  // A second prompt cannot fold into a running Vibe turn. The Console cancels the turn and sends the reply next.
  steer: 'none',
  interrupt: 'terminal-follows',
  images: true,
  enforcement: 'host',
  modelSwitch: 'next-turn',
};

/** The turn in flight, kept in plugin meta. `requestId` is the JSON-RPC id of `session/prompt`, so a late answer can be matched. */
export interface VibeTurnRecord {
  turnId: string;
  requestId: number;
  startedAt: string;
  /** CURRENT generation and snapshot sequence at the moment the prompt was written. Absent when the store could not be read. */
  generation?: string;
  snapshotSequence?: number;
}

export function vibeLaunchKey(conversationId: string): string {
  return launchMetaKey('vibe', conversationId);
}

export function vibeTurnKey(conversationId: string): string {
  return turnMetaKey('vibe', conversationId);
}

export function hostIdFor(conversationId: string): string {
  return acpHostId('vibe', conversationId);
}

/** A Mistral API key or token. Subscription billing uses the OS keyring, so these never reach the child. */
export function isMistralApiKey(key: string): boolean {
  return key === 'MISTRAL_API_KEY' || (/^MISTRAL_/i.test(key) && /KEY|TOKEN|SECRET/i.test(key));
}

/**
 * Records a rate limit for the router. Best effort: a missing `wo` or a failed command is logged and never thrown.
 * `argv` is the whole command (tests pass a fake). Nothing is written to the child's streams.
 */
export function recordVibeQuota(argv: readonly string[], log: { warn(fields: object, message: string): void }): void {
  const [command, ...args] = argv;
  if (!command) return;
  try {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', (error) => log.warn({ error: error.message }, 'vibe quota record failed'));
    child.unref();
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, 'vibe quota record failed');
  }
}
