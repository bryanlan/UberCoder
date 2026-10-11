import { createReadStream } from 'node:fs';
import readline from 'node:readline';

// Restore this derived value once, without materializing the event history. New
// input is recorded directly in the cache after its durable event append.
export async function readLastUserInput(filePath: string): Promise<string | undefined> {
  const input = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lastInput: string | undefined;
  let yieldedAt = performance.now();
  try {
    for await (const line of lines) {
      try {
        const event = JSON.parse(line) as { type?: unknown; text?: unknown };
        if (event?.type === 'user-input' && typeof event.text === 'string') lastInput = event.text;
      } catch {
        // An incomplete or malformed event cannot replace a recorded prompt.
      }
      if (performance.now() - yieldedAt >= 8) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        yieldedAt = performance.now();
      }
    }
    return lastInput;
  } finally {
    lines.close();
    input.destroy();
  }
}

interface Entry {
  path: string;
  text?: string;
  loaded: boolean;
  loading?: Promise<string | undefined>;
}

export class LastUserInputCache {
  private entry?: Entry;

  constructor(private readonly load = readLastUserInput) {}

  record(path: string, text: string): void {
    this.entry = { path, text, loaded: true };
  }

  current(path: string | undefined): { text?: string } | undefined {
    const entry = this.entry;
    return entry && entry.path === path && entry.loaded ? { text: entry.text } : undefined;
  }

  async read(path: string | undefined): Promise<string | undefined> {
    if (!path) return undefined;
    if (this.entry?.path !== path) this.entry = { path, loaded: false };
    const entry = this.entry;
    if (entry.loaded) return entry.text;
    entry.loading ??= this.load(path).then((text) => {
      // A user can submit new input while restoration is reading history.
      // Its durable append supersedes the older value, including for waiters.
      if (this.entry === entry) {
        entry.text = text;
        entry.loaded = true;
      }
      return this.entry?.path === path ? this.entry.text : undefined;
    }, () => {
      // A transient read failure must not become a permanently cached absence.
      if (this.entry === entry) entry.loading = undefined;
      return this.entry?.path === path ? this.entry.text : undefined;
    });
    return entry.loading;
  }
}
