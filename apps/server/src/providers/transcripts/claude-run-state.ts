import fs from 'node:fs';
import type { ProviderChildActivity, ProviderRunMonitor, ProviderRunState } from '../types.js';

/** Native API failures only; assistant prose and tool output cannot establish failure. */
export function claudeRunError(record: Record<string, unknown>): ProviderRunState['error'] {
  if (record.type !== 'assistant' || record.isSidechain === true || record.isApiErrorMessage !== true) return undefined;
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const text = Array.isArray(content) ? content.flatMap((part: unknown) => {
    if (!part || typeof part !== 'object') return [];
    const item = part as Record<string, unknown>;
    return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join('\n') : typeof content === 'string' ? content : 'The provider stopped without completing this turn.';
  // Claude also labels OAuth refresh failures server_error. Require the native HTTP
  // failure envelope before admitting retry; quota/authentication never inherit it.
  const transient = record.error === 'server_error' && /^API Error: (500|502|503|504|529)\b/.exec(text);
  return { code: transient ? transient[1] === '529' ? 'server_overloaded' : 'server_unavailable'
    : typeof record.error === 'string' ? record.error : 'unknown', message: text };
}

/** Claude's user records include tool results. Only a real submitted prompt starts a turn. */
function isSubmittedPrompt(record: Record<string, unknown>): boolean {
  if (record.type !== 'user' || record.isSidechain === true || record.isMeta === true
    || record.isCompactSummary === true) return false;
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === 'string' && content.trim().startsWith('<task-notification>')) return false;
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
      this.turnId = undefined;
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
            const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
            const message = record.message as Record<string, unknown> | undefined;
            const content = message?.content;
            if (timestamp && record.type === 'user' && record.isSidechain !== true && typeof content === 'string'
              && content.trim().startsWith('<task-notification>') && content.trim().endsWith('</task-notification>')) {
              const task = /<task-id>([^<]+)<\/task-id>/.exec(content)?.[1];
              const status = /<status>(completed|failed)<\/status>/.exec(content)?.[1];
              if (task && status && typeof record.uuid === 'string') {
                this.children.push({ id: record.uuid, childId: task, kind: status as 'completed' | 'failed', timestamp });
                if (this.children.length > 128) this.children.shift();
              }
            }
            if (timestamp && isSubmittedPrompt(record)) {
              this.turnId = typeof record.uuid === 'string' ? record.uuid : timestamp;
              this.latest = { turnId: this.turnId, timestamp, startedAt: timestamp, status: 'running' };
            } else if (timestamp && record.type === 'assistant' && record.isSidechain !== true && this.turnId) {
              const message = record.message as Record<string, unknown> | undefined;
              const error = claudeRunError(record);
              this.latest = {
                turnId: this.turnId,
                timestamp,
                startedAt: this.latest?.startedAt,
                status: error ? 'failed' : message?.stop_reason === 'end_turn' ? 'completed' : 'running',
                ...(error ? { error } : {}),
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
