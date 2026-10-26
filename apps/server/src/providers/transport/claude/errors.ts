// Portions of this file are ported from T3 Code (https://github.com/pingdotgg/t3code, tag v0.1.2):
//   apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
//     lines 2976-3025  (`resultUserFacingError`, `terminalResultError`, `isOverloadedResult`: one sentence per
//                       `terminal_reason`, the 529 test)
//     lines 3027-3062  (`terminalStatusFromResult`: a `terminal_reason` of aborted wins over `subtype: success`)
//     lines 3171-3257  (`providerFailureFromResult`, `providerFailureFromApiRetry`: 429 is a usage limit, 529 is
//                       overload, a gateway 503 that embeds a 429 carries its reset time, `api_retry` with a null
//                       status is a transport error)
//     lines 8500-8600  (what the result handler feeds in: authentication and rate-limit evidence from earlier frames)
//
// MIT License
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Modifications: Effect `DateTime` and the T3 failure contract are replaced by plain TypeScript and the plugin
// contract's `ProviderFailure`; failure classes follow the Console recovery rules (`server_overloaded` and
// `server_unavailable` are the codes RunRecovery retries); `cancelled` is reported as `interrupted`; max-turns and
// budget results are `validation_error`; authentication failures are `permission_error`.

import { ResumeFailedError, type ProviderFailure } from '../types.js';
import { redactFreeText } from '../codex/redact.js';
import type { ClaudeResultFrame, SystemApiRetryFrame } from './protocol.js';
import { claudeUsageLimitResetAt, latestResetAt } from './usage.js';

const MAX_MESSAGE_CHARS = 500;

// ---------------------------------------------------------------------------------------------------------
// Typed startup errors (thrown by `start` and `resume`)

export type ClaudeLaunchRefusal = 'no_hooks' | 'api_key' | 'unsupported';

/**
 * The process started but must not be used: it came up without the Console's hooks (bare mode), or on an API key
 * instead of the subscription login. The process has been ended; nothing was sent to it.
 */
export class ClaudeLaunchRefusedError extends Error {
  readonly code = 'launch_refused';
  readonly reason: ClaudeLaunchRefusal;
  constructor(reason: ClaudeLaunchRefusal, message: string) {
    super(message);
    this.name = 'ClaudeLaunchRefusedError';
    this.reason = reason;
  }
}

/**
 * Another live Claude process already holds the session (it is registered under `<config>/sessions/<pid>.json`).
 * The CLI does not refuse two writers on one transcript, so the plugin does. A `ResumeFailedError`, so hosts that
 * catch that class need no change.
 */
export class ClaudeSessionHeldError extends ResumeFailedError {
  readonly heldByPid: number;
  readonly sessionId: string;
  constructor(sessionId: string, pid: number) {
    super(`Claude session ${sessionId} is already open in process ${pid}; it cannot be resumed while that process runs.`);
    this.name = 'ClaudeSessionHeldError';
    this.heldByPid = pid;
    this.sessionId = sessionId;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Evidence gathered from the frames before a result

/** What earlier frames of the turn say about why it may have failed. One per turn. */
export interface TurnEvidence {
  /** An assistant frame carried `error: 'authentication_failed'`. */
  authenticationFailed: boolean;
  /** Limits that block the account, with their reset times, from `rate_limit_event`. */
  blockedLimits: Map<string, string | null>;
  /** An assistant frame carried `error: 'rate_limit'`; the reset time comes from its `api_error_params`. */
  assistantRateLimit: { type: string | null; resetAt: string | null } | null;
  /** The newest `api_retry` of the turn, classified. */
  lastRetry: ProviderFailure | null;
}

export function newTurnEvidence(blocked?: Map<string, string | null>): TurnEvidence {
  return { authenticationFailed: false, blockedLimits: new Map(blocked ?? []), assistantRateLimit: null, lastRetry: null };
}

// ---------------------------------------------------------------------------------------------------------
// Result to terminal

export interface ClassifiedResult {
  status: 'completed' | 'interrupted' | 'failed';
  failure?: ProviderFailure;
}

const CONTEXT_WINDOW_FULL_ERROR = "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";

/** One sentence per `terminal_reason` that ends a turn badly; undefined for reasons that are not failures. */
export function terminalReasonMessage(reason: string | undefined, hint?: string): string | undefined {
  switch (reason) {
    case 'api_error':
      return hint ?? 'Claude gave up after repeated API errors.';
    case 'malformed_tool_use_exhausted':
      return 'Claude gave up after repeated malformed tool calls.';
    case 'budget_exhausted':
      return "Claude stopped: the turn's token budget was exhausted.";
    case 'structured_output_retry_exhausted':
      return 'Claude could not produce the requested structured output.';
    case 'tool_deferred_unavailable':
      return 'Claude could not resume a deferred tool call: the tool is no longer available.';
    case 'turn_setup_failed':
      return 'Claude could not start the turn.';
    case 'blocking_limit':
      // The CLI also ends a turn with blocking_limit once the context window is full. Only rate-limit evidence sets the hint.
      return hint ?? CONTEXT_WINDOW_FULL_ERROR;
    case 'rapid_refill_breaker':
      return 'Claude stopped: the context refilled too quickly after compaction.';
    case 'prompt_too_long':
      return CONTEXT_WINDOW_FULL_ERROR;
    case 'image_error':
      return 'Claude stopped: an image in the conversation could not be processed.';
    case 'model_error':
      return 'Claude stopped: the model returned an error.';
    default:
      return undefined;
  }
}

const VALIDATION_REASONS = new Set(['prompt_too_long', 'image_error', 'budget_exhausted', 'structured_output_retry_exhausted', 'rapid_refill_breaker']);

/** "[ede_diagnostic] ..." entries are CLI-internal telemetry; they must never become the error text. */
function userFacingError(result: ClaudeResultFrame): string | undefined {
  if (result.subtype === 'success' && !result.is_error) return undefined;
  return result.errors?.find((error) => typeof error === 'string' && !error.startsWith('[ede_diagnostic]'));
}

function bounded(text: string): string {
  return redactFreeText(text.trim(), MAX_MESSAGE_CHARS);
}

/** A gateway can answer 503 with a body that embeds a 429 and "(reset after 1h 2m 3s)". */
const GATEWAY_LIMIT = /^API Error: 503 \[[^\]\r\n]+\] \[429\]: \{"type":"error","error":\{"type":"rate_limit_error",[^\r\n]*\} \(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/;

function gatewayLimitResetAt(result: ClaudeResultFrame, nowMs: number): string | null {
  if (result.api_error_status !== 503 || typeof result.result !== 'string') return null;
  const match = GATEWAY_LIMIT.exec(result.result);
  if (!match) return null;
  const seconds = Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  const resetMs = nowMs + seconds * 1_000;
  return seconds > 0 && resetMs < 8.64e15 ? new Date(resetMs).toISOString() : null;
}

export interface ClassifyOptions {
  /** `interrupt` was sent for this turn: whatever the CLI reports, the person stopped it. */
  interruptRequested: boolean;
  nowMs: number;
}

/**
 * Maps a `result` frame to the contract's terminal status and failure.
 *
 * Rules (T3 ports marked):
 *   - `terminal_reason` aborted_streaming / aborted_tools is `interrupted`, whatever `subtype` says (T3);
 *   - `subtype: 'success'` with `is_error`, or with a failing `terminal_reason`, or `api_error_status` 429 / 529, is
 *     `failed` (T3): the CLI reports API failures as successes;
 *   - 429, or rate-limit evidence from earlier frames, is `usage_limit` with `resetAt` (T3);
 *   - 529 or "overloaded" is `provider_error` / `server_overloaded`, 500-599 otherwise `server_unavailable`: the two
 *     codes RunRecovery retries;
 *   - `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` are `validation_error`;
 *   - authentication (assistant `authentication_failed`, status 401 / 403) is `permission_error`;
 *   - an `api_error` that followed `api_retry` frames with no HTTP status is `transport_error` (T3).
 */
export function classifyResult(result: ClaudeResultFrame, evidence: TurnEvidence, options: ClassifyOptions): ClassifiedResult {
  const aborted = result.terminal_reason === 'aborted_streaming' || result.terminal_reason === 'aborted_tools';
  if (aborted || options.interruptRequested) return { status: 'interrupted' };

  if (result.subtype !== 'success') {
    const errorText = (result.errors ?? []).join('\n').toLowerCase();
    if (errorText.includes('interrupt') || errorText.includes('cancel')) return { status: 'interrupted' };
    return { status: 'failed', failure: failureFromErrorSubtype(result) };
  }

  const status = result.api_error_status ?? null;
  const resultText = typeof result.result === 'string' ? result.result : '';
  const usageLimited =
    !evidence.authenticationFailed &&
    (evidence.blockedLimits.size > 0 || evidence.assistantRateLimit !== null) &&
    (status === null || status === 429) &&
    (result.terminal_reason === undefined || result.terminal_reason === 'api_error' || result.terminal_reason === 'blocking_limit');
  const failing = result.is_error === true || terminalReasonMessage(result.terminal_reason) !== undefined || status === 429 || status === 529;
  if (!failing) return { status: 'completed' };

  // Every reset time must be known for the account to be usable again; the latest one decides.
  const resets = [...evidence.blockedLimits.values()];
  const assistant = evidence.assistantRateLimit;
  if (assistant && assistant.type !== null && !evidence.blockedLimits.has(assistant.type)) resets.push(assistant.resetAt);
  const evidenceResetAt = latestResetAt(resets);

  const gatewayReset = gatewayLimitResetAt(result, options.nowMs);
  if (status === 429 || usageLimited || gatewayReset) {
    const resetAt = evidenceResetAt ?? gatewayReset;
    return {
      status: 'failed',
      failure: {
        class: 'usage_limit',
        code: status === null ? 'usage_limit' : `api_error_${status}`,
        message: bounded(userFacingError(result) ?? 'Claude usage limit reached. Send the message again once the limit resets.'),
        retryable: false,
        ...(resetAt ? { resetAt } : {}),
      },
    };
  }
  if (evidence.authenticationFailed || status === 401 || status === 403) {
    return {
      status: 'failed',
      failure: {
        class: 'permission_error',
        code: evidence.authenticationFailed && status !== 403 ? 'authentication_failed' : `api_error_${status ?? 'auth'}`,
        message: bounded(resultText || 'Claude is not signed in or may not use this account. Sign in with `claude` and try again.'),
        retryable: false,
      },
    };
  }
  if (status === 529 || /overloaded/i.test(resultText)) {
    return {
      status: 'failed',
      failure: { class: 'provider_error', code: 'server_overloaded', message: bounded('Claude API is overloaded (529). Try again shortly.'), retryable: true },
    };
  }
  if (status !== null && status >= 500 && status <= 599) {
    return {
      status: 'failed',
      failure: { class: 'provider_error', code: 'server_unavailable', message: bounded(resultText || `Claude API is unavailable (${status}). Try again shortly.`), retryable: true },
    };
  }
  const reason = result.terminal_reason;
  if (reason === 'api_error' && status === null && evidence.lastRetry) {
    // Retries with no HTTP status were connection failures, not answers from the API.
    return { status: 'failed', failure: { ...evidence.lastRetry, message: bounded(resultText || evidence.lastRetry.message) } };
  }
  const message = bounded(userFacingError(result) ?? terminalReasonMessage(reason, resultText || undefined) ?? (resultText || 'The Claude turn failed.'));
  if (reason !== undefined && VALIDATION_REASONS.has(reason)) {
    return { status: 'failed', failure: { class: 'validation_error', code: reason, message, retryable: false } };
  }
  return {
    status: 'failed',
    failure: {
      class: reason === undefined && status === null ? 'unknown' : 'provider_error',
      code: status !== null ? `api_error_${status}` : (reason ?? 'sdk_result_error'),
      message,
      retryable: false,
    },
  };
}

function failureFromErrorSubtype(result: ClaudeResultFrame): ProviderFailure {
  const message = bounded(userFacingError(result) ?? terminalReasonMessage(result.terminal_reason) ?? (result.errors ?? []).join('\n'));
  switch (result.subtype) {
    case 'error_max_turns':
      return { class: 'validation_error', code: 'error_max_turns', message: message || 'Claude stopped: the turn limit was reached.', retryable: false };
    case 'error_max_budget_usd':
      return { class: 'validation_error', code: 'error_max_budget_usd', message: message || 'Claude stopped: the budget limit was reached.', retryable: false };
    case 'error_max_structured_output_retries':
      return { class: 'validation_error', code: 'error_max_structured_output_retries', message: message || 'Claude could not produce the requested structured output.', retryable: false };
    default:
      return { class: 'provider_error', code: String(result.subtype), message: message || 'The Claude turn failed.', retryable: false };
  }
}

/** `system/api_retry`: a 429 is a usage limit, no HTTP status is a transport error, anything else a provider error. */
export function failureFromApiRetry(frame: Pick<SystemApiRetryFrame, 'error_status' | 'error'>): ProviderFailure {
  const errorName = String(frame.error ?? 'error').replaceAll('_', ' ');
  const status = typeof frame.error_status === 'number' ? Math.trunc(frame.error_status) : null;
  return {
    class: status === 429 ? 'usage_limit' : status === null ? 'transport_error' : 'provider_error',
    code: status === null ? String(frame.error ?? 'transport_error') : `api_error_${status}`,
    message: bounded(`Claude API ${errorName}.`),
    retryable: true,
  };
}

/** The reset time of a blocked assistant rate-limit frame, for {@link TurnEvidence.assistantRateLimit}. */
export function assistantRateLimitEvidence(info: { rateLimitType?: unknown; resetsAt?: unknown } | undefined): { type: string | null; resetAt: string | null } {
  if (!info) return { type: null, resetAt: null };
  return { type: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown', resetAt: claudeUsageLimitResetAt(info.resetsAt) };
}

/** The process ended (or never became ready): how it ended, in one phrase, without any process output. */
export function processExitFailure(how: string): ProviderFailure {
  return { class: 'transport_error', code: 'process_exited', message: how, retryable: true };
}
