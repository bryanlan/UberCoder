import fs from 'node:fs';
import type { ProviderRunMonitor, ProviderRunState } from '../types.js';

/** Claude's user records include tool results. Only a real submitted prompt starts a turn. */
function isSubmittedPrompt(record: Record<string, unknown>): boolean {
  if (record.type !== 'user' || record.isSidechain === true || record.isMeta === true) return false;
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === 'string'
    ? content.trim().length > 0
    : Array.isArray(content) && content.some((part) => typeof part === 'object' && part !== null
      && (part as Record<string, unknown>).type === 'text');
}

export class ClaudeRunMonitor implements ProviderRunMonitor {
  private offset = 0;
  private identity = '';
  private pending = Buffer.alloc(0);
  private skipLine = false;
  private latest?: ProviderRunState;
  private turnId?: string;

  async read(filePath: string): Promise<ProviderRunState | undefined> {
    const stat = await fs.promises.stat(filePath);
    const identity = `${filePath}:${stat.dev}:${stat.ino}`;
    if (identity !== this.identity || stat.size < this.offset) {
      this.identity = identity;
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.skipLine = false;
      this.latest = undefined;
      this.turnId = undefined;
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
            const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
            if (timestamp && isSubmittedPrompt(record)) {
              this.turnId = typeof record.uuid === 'string' ? record.uuid : timestamp;
              this.latest = { turnId: this.turnId, timestamp, startedAt: timestamp, status: 'running' };
            } else if (timestamp && record.type === 'assistant' && record.isSidechain !== true && this.turnId) {
              const message = record.message as Record<string, unknown> | undefined;
              this.latest = {
                turnId: this.turnId,
                timestamp,
                startedAt: this.latest?.startedAt,
                status: message?.stop_reason === 'end_turn' ? 'completed' : 'running',
              };
            }
          } catch { /* An incomplete record cannot establish a turn outcome. */ }
        }
        this.pending = Buffer.alloc(0);
        this.skipLine = false;
        start = end + 1;
      }
      if (!this.skipLine) {
        this.pending = Buffer.concat([this.pending, data.subarray(start)]);
        if (this.pending.length > 1024 * 1024) {
          this.pending = Buffer.alloc(0);
          this.skipLine = true;
        }
      }
    }
    return this.latest;
  }
}
