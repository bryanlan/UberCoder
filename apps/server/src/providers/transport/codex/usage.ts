// Portions of this file are ported from T3 Code (https://github.com/pingdotgg/t3code, tag v0.1.2):
//   apps/server/src/provider/codexUsageLimits.ts   (window parsing, partial merge, reset time)
//   apps/server/src/provider/CodexTurnTokenUsage.ts (per-turn token usage from thread-wide totals)
//   apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts lines 195-207 (context fill)
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
// Modifications: Effect `DateTime`/`Option` replaced by `Date`; T3 contract types replaced by local types;
// T3's `clampPercent` helper is reimplemented here; the UI-message helpers (`codexUsageLimitMessage`,
// reset credits) are not ported.

import type { CodexThreadTokenUsage, CodexTokenUsageBreakdown } from './protocol.js';

// ---------------------------------------------------------------------------------------------------------
// Rate limits

interface CodexRateLimitWindow {
  usedPercent: number;
  /** Unix seconds. */
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}

/**
 * A rate-limit snapshot as it arrives in `account/rateLimits/read` and `account/rateLimits/updated`. Updates
 * are partial: an omitted (`undefined`) field keeps its earlier value; an explicit `null` clears it.
 */
export interface CodexRateLimitSnapshot {
  limitId?: string | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  individualLimit?: { remainingPercent: number; resetsAt: number } | null;
}

export type CodexUsageWindowKind = 'session' | 'weekly' | 'monthly';

export interface CodexUsageWindow {
  /** `primary`, `secondary` or `individual`: positions, not durations. */
  id: string;
  kind: CodexUsageWindowKind;
  label: string;
  usedPercent: number;
  windowDurationMins?: number;
  /** ISO time. */
  resetsAt?: string;
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function kindForDuration(mins: number): CodexUsageWindowKind {
  if (mins >= MONTH_MINS) return 'monthly';
  if (mins >= WEEK_MINS) return 'weekly';
  return 'session';
}

function labelForKind(kind: CodexUsageWindowKind): string {
  return kind === 'session' ? 'Session' : kind === 'weekly' ? 'Weekly' : 'Monthly';
}

/**
 * `primary` / `secondary` are positions, not durations. Codex usually sends `windowDurationMins`; when it does
 * not, paid plans expose the 5-hour and weekly pair and Free/Go expose one monthly allowance.
 */
export function rateLimitsToWindows(snapshot: CodexRateLimitSnapshot | undefined): CodexUsageWindow[] {
  if (!snapshot) return [];
  // Show the main allowance only. Model-specific notifications (such as Spark) must not replace its
  // primary/secondary rows. Older CLIs omit the limit id.
  if (snapshot.limitId && snapshot.limitId !== 'codex') return [];
  const isMonthlyPlan = snapshot.planType === 'free' || snapshot.planType === 'go';
  const positions = [
    ['primary', snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ['secondary', snapshot.secondary, WEEK_MINS],
  ] as const;
  const windows: CodexUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const windowDurationMins = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : fallbackMins;
    const kind = kindForDuration(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.resetsAt);
    windows.push({
      id,
      kind,
      label: labelForKind(kind),
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const individualLimit = snapshot.individualLimit;
  if (individualLimit && Number.isFinite(individualLimit.remainingPercent)) {
    const resetsAt = isoFromEpochSeconds(individualLimit.resetsAt);
    windows.push({
      id: 'individual',
      kind: 'monthly',
      label: 'Monthly credit limit',
      usedPercent: clampPercent(100 - individualLimit.remainingPercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

/**
 * Codex sends `account/rateLimits/updated` as a partial view of the snapshot: a field the update omits keeps
 * the value observed earlier, so a later notification that only names the limit it reached must not drop the
 * windows an earlier one carried.
 */
export function mergeRateLimits(previous: CodexRateLimitSnapshot | undefined, update: CodexRateLimitSnapshot): CodexRateLimitSnapshot | undefined {
  // Model-specific snapshots (such as Spark) describe a different allowance and must not overwrite the main
  // one, the same rule the window rows apply.
  if (update.limitId && update.limitId !== 'codex') return previous;
  if (!previous) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined ? { rateLimitReachedType: update.rateLimitReachedType } : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
    ...(update.individualLimit !== undefined ? { individualLimit: update.individualLimit } : {}),
  };
}

/** All exhausted windows must reset before a continuation can run, so the latest reset time is the answer. */
export function usageLimitResetAt(snapshot: CodexRateLimitSnapshot | undefined): string | null {
  if (!snapshot) return null;
  const exhausted = rateLimitsToWindows(snapshot).filter((window) => window.usedPercent >= 100);
  if (exhausted.length === 0 || exhausted.some((window) => !window.resetsAt)) return null;
  return exhausted.reduce<string | null>(
    (latest, window) => (latest === null || Date.parse(window.resetsAt!) > Date.parse(latest) ? window.resetsAt! : latest),
    null,
  );
}

/** Windows in the shape of the `usage.updated` transport event. */
export function usageEventWindows(windows: CodexUsageWindow[]): Array<{ id: string; usedPercent: number; resetsAt?: string }> {
  return windows.map((window) => ({ id: window.id, usedPercent: window.usedPercent, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) }));
}

// ---------------------------------------------------------------------------------------------------------
// Context fill

/**
 * `last` is the usage of the newest model request, so `last.totalTokens / modelContextWindow` is how full the
 * context is. `total` is the running total of the whole thread and says nothing about the window.
 */
export function contextFill(tokenUsage: CodexThreadTokenUsage): { usedTokens: number; maxTokens: number | null; fraction: number | null } {
  const usedTokens = Math.max(0, tokenUsage.last.totalTokens);
  const maxTokens = tokenUsage.modelContextWindow ?? null;
  const fraction = maxTokens !== null && maxTokens > 0 ? Math.min(1, usedTokens / maxTokens) : null;
  return { usedTokens, maxTokens, fraction };
}

// ---------------------------------------------------------------------------------------------------------
// Per-turn token usage

type CumulativeTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens?: number;
  outputTokens: number;
  reasoningTokens: number;
};

interface TurnTokenUsageAccumulator {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number | undefined;
  outputTokens: number;
  reasoningTokens: number;
  observed: boolean;
}

export interface CodexTurnTokenUsageState {
  baseline: CumulativeTokenUsage | undefined;
  activeTurnId: string | undefined;
  readonly byTurnId: Map<string, TurnTokenUsageAccumulator>;
}

export interface CodexTurnTokenUsage {
  usageStatus: 'unavailable' | 'partial' | 'complete';
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

function tokenUsageBreakdown(usage: CodexTokenUsageBreakdown): CumulativeTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheCreationTokens: usage.cacheWriteInputTokens } : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
  };
}

export function makeTurnTokenUsageState(): CodexTurnTokenUsageState {
  return { baseline: undefined, activeTurnId: undefined, byTurnId: new Map() };
}

function getTurnAccumulator(state: CodexTurnTokenUsageState, turnId: string): TurnTokenUsageAccumulator {
  const existing = state.byTurnId.get(turnId);
  if (existing) return existing;
  const created: TurnTokenUsageAccumulator = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    observed: false,
  };
  state.byTurnId.set(turnId, created);
  return created;
}

/** Codex reports a running `total` for the thread and `last`, the usage of the newest model response. */
function turnTokenUsageDelta(previous: CumulativeTokenUsage | undefined, current: CumulativeTokenUsage, last: CumulativeTokenUsage): CumulativeTokenUsage {
  if (
    previous === undefined ||
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens
  ) {
    return last;
  }
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    ...(current.cacheCreationTokens !== undefined && previous.cacheCreationTokens !== undefined && current.cacheCreationTokens >= previous.cacheCreationTokens
      ? { cacheCreationTokens: current.cacheCreationTokens - previous.cacheCreationTokens }
      : {}),
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
  };
}

export function accumulateTurnTokenUsage(state: CodexTurnTokenUsageState, turnId: string, usage: CodexThreadTokenUsage): void {
  const current = tokenUsageBreakdown(usage.total);
  if (state.activeTurnId !== turnId) {
    // The total is thread-wide, so every update moves the baseline. A late update for a finished turn is not
    // counted toward the live turn.
    state.baseline = current;
    return;
  }

  const accumulator = getTurnAccumulator(state, turnId);
  const delta = turnTokenUsageDelta(state.baseline, current, tokenUsageBreakdown(usage.last));
  state.baseline = current;

  if (delta.inputTokens > 0 || delta.cachedInputTokens > 0 || delta.outputTokens > 0 || delta.reasoningTokens > 0) {
    accumulator.observed = true;
  }
  accumulator.inputTokens += delta.inputTokens;
  accumulator.cachedInputTokens += delta.cachedInputTokens;
  accumulator.outputTokens += delta.outputTokens;
  accumulator.reasoningTokens += delta.reasoningTokens;
  if (delta.cacheCreationTokens === undefined) {
    accumulator.cacheCreationTokens = undefined;
  } else if (accumulator.cacheCreationTokens !== undefined) {
    accumulator.cacheCreationTokens += delta.cacheCreationTokens;
  }
}

export function completeTurnTokenUsage(state: CodexTurnTokenUsageState, turnId: string, completed: boolean): CodexTurnTokenUsage {
  const usage = state.byTurnId.get(turnId);
  state.byTurnId.delete(turnId);
  if (state.activeTurnId === turnId) state.activeTurnId = undefined;
  if (!usage?.observed) return { usageStatus: 'unavailable' };

  // Codex counts cache reads and writes inside inputTokens.
  return {
    usageStatus: completed ? 'complete' : 'partial',
    inputTokens: usage.inputTokens,
    cachedInputTokens: Math.min(usage.inputTokens, usage.cachedInputTokens),
    ...(usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: Math.min(usage.inputTokens, usage.cacheCreationTokens) } : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
  };
}
