import fs from 'node:fs/promises';
import type { ConversationSummary, WorkerOpeningMessage } from '@agent-console/shared';
import { iterateJsonlRecords } from '../providers/transcripts/base.js';
import { codexOpeningUserText } from '../providers/transcripts/codex.js';
import { claudeOpeningUserText } from '../providers/transcripts/claude.js';
import { imagePromptDisplay } from '../images/prompt.js';
import { normalizeComparableText, stableTextHash } from '../lib/text.js';

const HEAD_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 8 * 1024 * 1024;
const unavailable = (): WorkerOpeningMessage => ({ text: null, error: 'The complete opening message is unavailable.' });

/** Static opening text only: never parse full histories, read agent activity or run a model. */
export class WorkerOpeningMessages {
  private readonly cached = new Map<string, string>();
  private readonly pending = new Map<string, Promise<WorkerOpeningMessage>>();
  private bytes = 0;

  async read(summary: ConversationSummary): Promise<WorkerOpeningMessage> {
    const expected = summary.rawMetadata?.firstUserTextHash;
    if (!summary.transcriptPath || typeof expected !== 'string') return unavailable();
    try {
      const stat = await fs.stat(summary.transcriptPath);
      const key = `${summary.provider}:${summary.transcriptPath}:${stat.dev}:${stat.ino}:${expected}`;
      const cached = this.cached.get(key);
      if (cached !== undefined) return { text: cached, error: null };
      const pending = this.pending.get(key);
      if (pending) return await pending;
      const read = this.scan(summary, expected).then(result => {
        if (result.text !== null) {
          this.cached.set(key, result.text); this.bytes += Buffer.byteLength(result.text);
          while (this.cached.size > 128 || this.bytes > CACHE_BYTES) {
            const oldest = this.cached.keys().next().value!;
            this.bytes -= Buffer.byteLength(this.cached.get(oldest)!); this.cached.delete(oldest);
          }
        }
        return result;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, read);
      return await read;
    } catch { return unavailable(); }
  }

  private async scan(summary: ConversationSummary, expected: string): Promise<WorkerOpeningMessage> {
    const extract = summary.provider === 'codex' ? codexOpeningUserText : claudeOpeningUserText;
    for await (const { record } of iterateJsonlRecords(summary.transcriptPath!, { maxBytes: HEAD_BYTES })) {
      const text = extract(record);
      if (text !== undefined && stableTextHash(normalizeComparableText(text)) === expected) {
        return { text: imagePromptDisplay(text).text || 'Image message', error: null };
      }
    }
    return unavailable();
  }
}
