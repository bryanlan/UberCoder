import type { ProviderId } from './index.js';

export interface WorkerSummary {
  task: string;
  latest: string;
  coordination: string;
}

export interface WorkerCard {
  id: string;
  projectSlug: string;
  projectName: string;
  provider: ProviderId;
  conversationRef: string;
  title: string;
  working: boolean;
  task: string;
  summary: WorkerSummary | null;
  summaryAt: string | null;
  stale: boolean;
}

/** Shared runtime counts uncached input separately from cache reads/writes. */
export interface WorkerTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface WorkerUsageToday extends WorkerTokenUsage {
  date: string;
  calls: number;
  failedCalls: number;
  unknownUsageCalls: number;
  runningCalls: number;
}

export interface WorkerPanelSnapshot {
  workers: WorkerCard[];
  workingCount: number;
  generating: boolean;
  enabled: boolean;
  trackingEnabled: boolean;
  error: string | null;
  usage: WorkerUsageToday;
}
