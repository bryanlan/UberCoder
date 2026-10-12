import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { WorkerTokenUsage, WorkerUsageToday } from '@agent-console/shared';

export interface SummaryAuditRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'started' | 'completed' | 'failed';
  model: 'gpt-6-luna';
  effort: 'low';
  workerIds: string[];
  durationMs: number | null;
  usage: WorkerTokenUsage | null;
}
const MAX_DAILY_BYTES = 8 * 1024 * 1024;
const count = z.number().int().nonnegative().safe();
const recordSchema = z.object({ id: z.string().min(1), startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  status: z.enum(['started', 'completed', 'failed']), model: z.literal('gpt-6-luna'), effort: z.literal('low'),
  workerIds: z.array(z.string()).max(16), durationMs: count.nullable(), usage: z.object({ inputTokens: count,
    cachedInputTokens: count, cacheWriteTokens: count, outputTokens: count, totalTokens: count }).refine(
    (u) => u.totalTokens === u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens + u.outputTokens).nullable() }).strict();
export async function privateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Worker storage must not be a symlink.');
  await fs.chmod(directory, 0o700);
}

/** Separate append-only accounting: no prompts, summaries or peer message bodies. */
export class WorkerSummaryAudit {
  private records = new Map<string, SummaryAuditRecord>();
  private loadedDate?: string;
  private loading?: Promise<void>;
  lastAttemptAt = 0;
  constructor(private readonly directory: string) {}

  async load(date: string): Promise<void> {
    if (this.loading) await this.loading;
    if (this.loadedDate === date) return;
    const loading = this.loadDate(date);
    this.loading = loading;
    try { await loading; } finally { if (this.loading === loading) this.loading = undefined; }
  }

  private async loadDate(date: string): Promise<void> {
    await privateDirectory(this.directory);
    const file = path.join(this.directory, `usage-${date}.jsonl`);
    this.records.clear();
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || stat.size > MAX_DAILY_BYTES) throw new Error('Worker audit is unavailable.');
      const text = await fs.readFile(file, 'utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        const record = recordSchema.parse(JSON.parse(line));
        this.records.set(record.id, record);
        this.lastAttemptAt = Math.max(this.lastAttemptAt, Date.parse(record.startedAt));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.loadedDate = date;
  }

  async record(record: SummaryAuditRecord): Promise<void> {
    const date = record.startedAt.slice(0, 10);
    const file = path.join(this.directory, `usage-${date}.jsonl`);
    const line = JSON.stringify(record) + '\n';
    let size = 0;
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Worker audit must not be a symlink.');
      size = stat.size;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (size + Buffer.byteLength(line) > MAX_DAILY_BYTES) throw new Error('Worker audit daily limit reached.');
    await fs.appendFile(file, line, { mode: 0o600 });
    if (date === this.loadedDate) this.records.set(record.id, record);
    this.lastAttemptAt = Math.max(this.lastAttemptAt, Date.parse(record.startedAt));
  }

  snapshot(date: string): WorkerUsageToday {
    const result: WorkerUsageToday = { date, calls: 0, failedCalls: 0, unknownUsageCalls: 0, runningCalls: 0,
      inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const record of this.records.values()) {
      if (record.startedAt.slice(0, 10) !== date) continue;
      result.calls++;
      if (record.status === 'failed') result.failedCalls++;
      if (record.status === 'started') result.runningCalls++;
      if (!record.usage) result.unknownUsageCalls++;
      else for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'] as const) {
        result[key] += record.usage[key];
      }
    }
    return result;
  }
}
