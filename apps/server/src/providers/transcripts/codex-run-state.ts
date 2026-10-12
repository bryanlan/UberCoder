import fs from 'node:fs';
import type { ProviderChildActivity, ProviderRunMonitor, ProviderRunState } from '../types.js';

export function codexRunState(record: Record<string, unknown>): ProviderRunState | undefined {
  if (record.type !== 'event_msg') return undefined;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload || !['task_started', 'task_complete', 'turn_aborted'].includes(String(payload.type))) return undefined;
  if (typeof payload.turn_id !== 'string' || typeof record.timestamp !== 'string') return undefined;
  const error = payload.error as Record<string, unknown> | undefined;
  return {
    turnId: payload.turn_id,
    timestamp: record.timestamp,
    startedAt: typeof payload.started_at === 'number' && Number.isFinite(payload.started_at) ? new Date(payload.started_at * 1000).toISOString() : undefined,
    status: payload.type === 'task_started' ? 'running' : payload.type === 'turn_aborted' ? 'cancelled' : error ? 'failed' : 'completed',
    error: error ? {
      code: typeof error.codex_error_info === 'string' ? error.codex_error_info : 'unknown',
      message: typeof error.message === 'string' ? error.message : 'The provider stopped without completing this turn.',
    } : undefined,
  };
}

/** Incremental, bounded-memory lifecycle reader, independent of the large-chat display cache. */
export class CodexRunMonitor implements ProviderRunMonitor {
  private offset = 0;
  private identity = '';
  private pending = Buffer.alloc(0);
  private skipLine = false;
  private latest?: ProviderRunState;
  private children: ProviderChildActivity[] = [];
  takeChildActivity(): ProviderChildActivity[] { return this.children.splice(0); }

  async read(filePath: string): Promise<ProviderRunState | undefined> {
    const stat = await fs.promises.stat(filePath);
    const identity = `${filePath}:${stat.dev}:${stat.ino}`;
    if (identity !== this.identity || stat.size < this.offset) {
      this.identity = identity;
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.skipLine = false;
      this.latest = undefined;
      this.children = [];
    }
    if (stat.size === this.offset) return this.latest;
    const stream = fs.createReadStream(filePath, { start: this.offset, end: stat.size - 1 });
    for await (const chunk of stream) {
      const data = chunk as Buffer;
      this.offset += data.length;
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        if (!this.skipLine) {
          const line = Buffer.concat([this.pending, data.subarray(start, end)]);
          try {
            const record = JSON.parse(line.toString('utf8')) as Record<string, unknown>;
            const payload = record.payload as Record<string, unknown> | undefined;
            const item = payload?.item as Record<string, unknown> | undefined;
            if (record.type === 'event_msg' && payload?.type === 'item_completed' && item?.type === 'SubAgentActivity'
              && (item.kind === 'completed' || item.kind === 'failed') && typeof item.id === 'string'
              && typeof item.agent_thread_id === 'string' && typeof record.timestamp === 'string') {
              this.children.push({ id: item.id, childId: item.agent_thread_id, kind: item.kind, timestamp: record.timestamp });
              if (this.children.length > 128) this.children.shift();
            }
            const run = codexRunState(record);
            if (run && (run.status === 'running' || !this.latest || run.turnId === this.latest.turnId)) {
              // task_complete.started_at has only whole seconds. Keep the precise
              // task_started timestamp so a newly submitted turn is not mistaken
              // for the preceding turn cancelled milliseconds before it began.
              if (run.turnId === this.latest?.turnId) run.startedAt = this.latest.startedAt ?? run.startedAt;
              else if (run.status === 'running') run.startedAt = run.timestamp;
              this.latest = run;
            }
          } catch { /* An incomplete provider record cannot establish a run outcome. */ }
        }
        this.pending = Buffer.alloc(0);
        this.skipLine = false;
        start = end + 1;
      }
      if (!this.skipLine) {
        this.pending = Buffer.concat([this.pending, data.subarray(start)]);
        // Lifecycle envelopes are small. Do not retain giant tool/image records.
        if (this.pending.length > 1024 * 1024) {
          this.pending = Buffer.alloc(0);
          this.skipLine = true;
        }
      }
    }
    return this.latest;
  }
}
