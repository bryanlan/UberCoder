// Portions of this file are ported from T3 Code (https://github.com/pingdotgg/t3code, tag v0.1.2):
//   apps/server/src/provider/claudeUsageLimits.ts  (window ids and labels, utilization as a 0..1 fraction, reset times)
//   apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts lines 3164-3169 (`claudeUsageLimitResetAt`) and
//   lines 7444-7500 (`rate_limit_event`: `rejected` without overage means blocked, tracked per `rateLimitType`
//   with `resetsAt * 1000`, `allowed` clears it, announced once per limit type and reset time)
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
// Modifications: Effect `DateTime`, `Ref` and the T3 usage-limit contract types are replaced by plain TypeScript;
// the model-scoped and spend rows that T3 reads from `get_usage` are not ported (the CLI sends them only on request);
// context fill is new (T3 reads it from partial-message stream events, which this plugin does not enable).

import type { ClaudeModelUsage, ClaudeRateLimitInfo, ClaudeResultUsage, ContextUsageResponseBody } from './protocol.js';
import { asNumber } from './protocol.js';

// ---------------------------------------------------------------------------------------------------------
// Rate limits

export interface ClaudeUsageWindow {
  id: string;
  usedPercent: number;
  /** ISO time. */
  resetsAt?: string;
}

/** The limit types shown as usage windows. `overage` and `seven_day_overage_included` describe spend, not a window. */
const WINDOW_TYPES = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** An ISO time from unix seconds, or null when the value is missing or not a date. */
export function claudeUsageLimitResetAt(resetsAt: unknown): string | null {
  const resetMs = typeof resetsAt === 'number' ? resetsAt * 1000 : NaN;
  return Number.isFinite(resetMs) && resetMs > 0 && resetMs < 8.64e15 ? new Date(resetMs).toISOString() : null;
}

function overageAllowed(info: ClaudeRateLimitInfo): boolean {
  return info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning' || info.isUsingOverage === true || info.overageInUse === true;
}

interface LimitState {
  blocked: boolean;
  utilization: number | undefined;
  resetAt: string | null;
}

export interface RateLimitUpdate {
  /** The windows after this update. Empty when no window type has been seen. */
  windows: ClaudeUsageWindow[];
  /** True when the windows differ from before the update. */
  changed: boolean;
  /** Text for a status line, set once per limit type and reset time when the limit blocks the account. */
  announce?: string;
}

/** Latest `rate_limit_event` per `rateLimitType`. One tracker per session; account-level state is re-sent by the CLI. */
export class ClaudeRateLimitTracker {
  private readonly states = new Map<string, LimitState>();
  private readonly announced = new Set<string>();
  private lastKey = '[]';

  apply(info: ClaudeRateLimitInfo): RateLimitUpdate {
    const type = typeof info.rateLimitType === 'string' && info.rateLimitType.length > 0 ? info.rateLimitType : 'unknown';
    const blocked = info.status === 'rejected' && !overageAllowed(info);
    if (blocked || info.status === 'allowed' || info.status === 'allowed_warning' || overageAllowed(info)) {
      this.states.set(type, {
        blocked,
        utilization: typeof info.utilization === 'number' ? info.utilization : this.states.get(type)?.utilization,
        resetAt: claudeUsageLimitResetAt(info.resetsAt) ?? (blocked ? null : this.states.get(type)?.resetAt ?? null),
      });
    }
    const windows = this.windows();
    const key = JSON.stringify(windows);
    const changed = key !== this.lastKey;
    this.lastKey = key;
    let announce: string | undefined;
    if (blocked) {
      const announceKey = `${type}:${info.resetsAt ?? 'unknown'}`;
      if (!this.announced.has(announceKey)) {
        this.announced.add(announceKey);
        const resetAt = this.states.get(type)?.resetAt;
        announce = `Claude ${LIMIT_LABELS[type] ?? type} usage limit reached${resetAt ? `; it resets at ${resetAt}` : ''}.`;
      }
    }
    return { windows, changed, ...(announce ? { announce } : {}) };
  }

  windows(): ClaudeUsageWindow[] {
    const windows: ClaudeUsageWindow[] = [];
    for (const [id, state] of this.states) {
      if (!WINDOW_TYPES.has(id)) continue;
      // A blocked window is exhausted whatever its last utilization said.
      const used = state.blocked ? 100 : state.utilization !== undefined ? clampPercent(state.utilization * 100) : undefined;
      if (used === undefined) continue;
      windows.push({ id, usedPercent: used, ...(state.resetAt ? { resetsAt: state.resetAt } : {}) });
    }
    return windows;
  }

  /** Limit types that block the account right now, with the time each resets (null when unknown). */
  blocked(): Map<string, string | null> {
    const result = new Map<string, string | null>();
    for (const [id, state] of this.states) if (state.blocked) result.set(id, state.resetAt);
    return result;
  }
}

/** All blocked limits must reset before a continuation can run, so the latest reset time is the answer; null when any is unknown. */
export function latestResetAt(resets: Iterable<string | null>): string | null {
  const list = [...resets];
  if (list.length === 0 || list.some((reset) => reset === null)) return null;
  return list.reduce<string>((latest, reset) => (reset! > latest ? reset! : latest), '');
}

// ---------------------------------------------------------------------------------------------------------
// Context fill

/**
 * The model's context window from a result's `modelUsage`. `modelUsage` is keyed by model and cumulative, so it says
 * how large the window is, not how full. With several models (a subagent on another model) the entry named
 * `preferredModel` wins, then the largest window.
 */
export function contextMaxFromModelUsage(modelUsage: Record<string, ClaudeModelUsage> | undefined, preferredModel?: string): number | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  const preferred = preferredModel ? entries.find(([model]) => model === preferredModel || preferredModel.startsWith(model) || model.startsWith(preferredModel)) : undefined;
  const window = asNumber(preferred?.[1].contextWindow);
  if (window !== undefined && window > 0) return window;
  let best: number | undefined;
  for (const [, usage] of entries) {
    const candidate = asNumber(usage.contextWindow);
    if (candidate !== undefined && candidate > 0 && (best === undefined || candidate > best)) best = candidate;
  }
  return best;
}

/**
 * Context used after the turn's last model request: the final entry of `usage.iterations`. The turn's own totals sum
 * every request of the turn (each one re-reads the whole context), so they overstate the fill; without iterations
 * the answer is unknown and `get_context_usage` supplies it.
 */
export function contextUsedFromResultUsage(usage: ClaudeResultUsage | undefined): number | undefined {
  const last = usage?.iterations?.at(-1);
  if (!last) return undefined;
  const total = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.output_tokens ?? 0);
  return total > 0 ? total : undefined;
}

/** `get_context_usage` reply: tokens in the window now and the model's raw window size. */
export function contextFromUsageResponse(response: ContextUsageResponseBody | undefined): { used?: number; max?: number } {
  if (!response) return {};
  const used = asNumber(response.totalTokens) ?? asNumber((response as { total_tokens?: unknown }).total_tokens);
  const max = asNumber(response.rawMaxTokens) ?? asNumber((response as { raw_max_tokens?: unknown }).raw_max_tokens) ?? asNumber(response.maxTokens);
  return { ...(used !== undefined && used >= 0 ? { used } : {}), ...(max !== undefined && max > 0 ? { max } : {}) };
}
