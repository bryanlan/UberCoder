// What the Antigravity plugin knows about Antigravity's ACP dialect (`agy acp`).
// Checked against Antigravity ACP Server 1.5.19 on 2026-11-28. Standard ACP lives in transport/acp.

import { spawn } from 'node:child_process';
import type { TransportCapabilities } from '../types.js';
import type { JsonRpcRequestError } from '../codex/jsonrpc.js';
import { hostIdFor as acpHostId, launchMetaKey, turnMetaKey } from '../acp/meta.js';

export const ANTIGRAVITY_RATE_LIMIT_NOTICE = 'Antigravity rate limit reached; try again later or switch provider';

export const ANTIGRAVITY_QUOTA_COMMAND = 'wo';

export const ANTIGRAVITY_QUOTA_LIMITED_ARGS = ['quota', 'limited', '--subscription', 'google_ai_pro'] as const;

export const DEFAULT_ANTIGRAVITY_COMMAND = ['agy', 'acp', '--stdio', '--dangerously-skip-permissions'];

export const ANTIGRAVITY_CAPABILITIES: TransportCapabilities = {
  processModel: 'per-session',
  nativeIds: 'server-allocated',
  resume: 'reattach',
  // A second prompt cannot fold into a running ACP turn. The Console cancels the turn and sends the reply next.
  steer: 'none',
  interrupt: 'terminal-follows',
  images: true,
  enforcement: 'host',
  modelSwitch: 'next-turn',
};

/** The turn in flight, kept in plugin meta. `requestId` is the JSON-RPC id of `session/prompt`, so a late answer can be matched. */
export interface AntigravityTurnRecord {
  turnId: string;
  requestId: number;
  startedAt: string;
  /** Highest `step_index` in `transcript.jsonl` before this prompt was written. */
  lastStepIndex?: number;
}

export function antigravityLaunchKey(conversationId: string): string {
  return launchMetaKey('antigravity', conversationId);
}

export function antigravityTurnKey(conversationId: string): string {
  return turnMetaKey('antigravity', conversationId);
}

export function hostIdFor(conversationId: string): string {
  return acpHostId('antigravity', conversationId);
}

/** Drop Gemini/Google API keys from child env so `agy acp` stays on the Google AI Pro OAuth subscription. */
export function isGoogleApiKey(key: string): boolean {
  return key === 'GEMINI_API_KEY' || key === 'GOOGLE_API_KEY';
}

/** Detects rate-limit / quota-exhausted JSON-RPC errors from Antigravity ACP. */
export function isAntigravityRateLimitError(error: JsonRpcRequestError): boolean {
  if (error.code === 429 || error.code === -31001) return true;
  return /rate.?limit|quota|resource_exhausted|too many requests|429/i.test(error.message);
}

/**
 * Records a rate limit for the router. Best effort: a missing `wo` or a failed command is logged and never thrown.
 */
export function recordAntigravityQuota(argv: readonly string[], log: { warn(fields: object, message: string): void }): void {
  const [command, ...args] = argv;
  if (!command) return;
  try {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', (error) => log.warn({ error: error.message }, 'antigravity quota record failed'));
    child.unref();
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, 'antigravity quota record failed');
  }
}
