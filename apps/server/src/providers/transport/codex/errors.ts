// Portions of this file are copied from T3 Code (https://github.com/pingdotgg/t3code, tag v0.1.2):
//   apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts, lines 1087-1150
//   (`parseCodexRetryProgress`, `codexErrorInfoCode`, `codexExhaustionHttpStatus`, `codexUsageLimitError`).
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
// Modifications: removed the Effect and T3 contract types; `classifyCodexFailure` is new.

import type { ProviderFailure } from '../types.js';
import type { CodexErrorInfo, CodexTurnError } from './protocol.js';
import { redactFreeText } from './redact.js';
import { usageLimitResetAt, type CodexRateLimitSnapshot } from './usage.js';

export function parseCodexRetryProgress(message: string): { attempt: number; maxAttempts: number } | null {
  const match = /\b(\d+)\s*\/\s*(\d+)\b/u.exec(message);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const attempt = Number.parseInt(match[1], 10);
  const maxAttempts = Number.parseInt(match[2], 10);
  if (attempt < 1 || maxAttempts < 1) {
    return null;
  }
  return { attempt, maxAttempts };
}

export function codexErrorInfoCode(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return Object.keys(value)[0] ?? null;
}

/**
 * Retry exhaustion only says why it failed through the last attempt's HTTP
 * status. Exhaustion on 429 is a usage or rate limit, so it keeps the usage-limit
 * class; other statuses stay provider or transport errors.
 */
export function codexExhaustionHttpStatus(errorInfo: CodexErrorInfo | null | undefined): number | null {
  return typeof errorInfo === 'object' && errorInfo !== null && 'responseTooManyFailedAttempts' in errorInfo
    ? ((errorInfo as { responseTooManyFailedAttempts: { httpStatusCode?: number | null } }).responseTooManyFailedAttempts.httpStatusCode ?? null)
    : null;
}

export function codexUsageLimitError(code: string | null, errorInfo: CodexErrorInfo | null | undefined): boolean {
  return code === 'usageLimitExceeded' || code === 'rateLimitExceeded' || codexExhaustionHttpStatus(errorInfo) === 429;
}

const PERMISSION_CODES = new Set(['unauthorized', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials']);
const VALIDATION_CODES = new Set(['contextWindowExceeded', 'badRequest']);

function failureMessage(error: CodexTurnError | null | undefined): string {
  const text = error?.additionalDetails?.trim() || error?.message?.trim();
  return redactFreeText(text && text.length > 0 ? text : 'The Codex turn failed.');
}

/**
 * Maps a failed turn's error to the plugin contract's {@link ProviderFailure}.
 * `rateLimits` is the latest merged rate-limit snapshot; it fills `resetAt` for usage limits.
 */
export function classifyCodexFailure(turnError: CodexTurnError | null | undefined, rateLimits?: CodexRateLimitSnapshot): ProviderFailure {
  const info = turnError?.codexErrorInfo ?? null;
  const code = codexErrorInfoCode(info);
  const message = failureMessage(turnError);

  if (codexUsageLimitError(code, info)) {
    const resetAt = usageLimitResetAt(rateLimits);
    return { class: 'usage_limit', ...(code ? { code } : {}), message, retryable: false, ...(resetAt ? { resetAt } : {}) };
  }
  if (code === 'serverOverloaded') {
    return { class: 'provider_error', code: 'server_overloaded', message, retryable: true };
  }
  if (code === 'internalServerError') {
    return { class: 'provider_error', code: 'server_unavailable', message, retryable: true };
  }
  if (code !== null && PERMISSION_CODES.has(code)) {
    return { class: 'permission_error', code, message, retryable: false };
  }
  if (code !== null && VALIDATION_CODES.has(code)) {
    return { class: 'validation_error', code, message, retryable: false };
  }
  if (code !== null && (code.startsWith('http') || code.startsWith('responseStream'))) {
    return { class: 'transport_error', code, message, retryable: true };
  }
  if (code === 'responseTooManyFailedAttempts' || code === 'sessionBudgetExceeded' || code === 'flexUnavailable') {
    return { class: 'provider_error', code, message, retryable: false };
  }
  return { class: 'unknown', ...(code && code !== 'other' ? { code } : {}), message };
}

/**
 * Combines the failed `turn/completed` error with the `error { willRetry: false }` notification that preceded
 * it. The notification usually carries the richer message (`additionalDetails`), so it wins when both name the
 * same code; a different explicit code on the completion decides.
 */
export function mergeTurnErrors(completion: CodexTurnError | null | undefined, notification: CodexTurnError | null | undefined): CodexTurnError | null {
  if (!notification) return completion ?? null;
  if (!completion) return notification;
  const completionCode = codexErrorInfoCode(completion.codexErrorInfo);
  const notificationCode = codexErrorInfoCode(notification.codexErrorInfo);
  if (completionCode !== null && notificationCode !== null && completionCode !== notificationCode) return completion;
  return {
    ...completion,
    ...notification,
    codexErrorInfo: notification.codexErrorInfo ?? completion.codexErrorInfo,
    additionalDetails: notification.additionalDetails ?? completion.additionalDetails,
  };
}

/**
 * A steer that raced a finished turn. Codex answers "no active turn to steer" or "expected active turn id `X`
 * but found `Y`" (wording taken from the codex sources, not recorded on the wire); anything else, such as a
 * review or compaction turn that cannot be steered, is a different failure.
 */
export function steerLostRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no active turn|expected active turn id/i.test(message);
}

/**
 * `turn/interrupt` refused because the server holds no running turn of that id (it already ended, or the thread
 * was unloaded): "no active turn", "expected active turn id", `thread not found: <id>` or `thread not loaded: <id>`.
 * Any other refusal leaves it open whether the turn is still running.
 */
export function interruptTurnGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no active turn|expected active turn id|thread not (?:found|loaded)/i.test(message);
}

/** `thread/resume` refuses an archived thread with a message naming the archive. */
export function isArchivedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session \S+ is archived|codex unarchive/i.test(message);
}
