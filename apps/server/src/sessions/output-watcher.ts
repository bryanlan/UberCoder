import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

interface WatchState {
  offset: number;
  watcher?: fs.FSWatcher;
  pollTimer?: NodeJS.Timeout;
  processing: boolean;
  queued: boolean;
  pendingChunk: string;
  flushTimer?: NodeJS.Timeout;
}

interface OutputWatcherRegistryOptions {
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;

export class OutputWatcherRegistry {
  private readonly watchers = new Map<string, WatchState>();
  private readonly pollIntervalMs: number;

  constructor(options: OutputWatcherRegistryOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  keys(): IterableIterator<string> {
    return this.watchers.keys();
  }

  has(sessionId: string): boolean {
    return this.watchers.has(sessionId);
  }

  watch(input: {
    sessionId: string;
    rawLogPath: string;
    initialOffset: number;
    onChunk: (chunk: string) => void;
  }): void {
    if (this.watchers.has(input.sessionId)) return;

    const state: WatchState = {
      offset: input.initialOffset,
      processing: false,
      queued: false,
      pendingChunk: '',
    };
    this.watchers.set(input.sessionId, state);
    const pump = async (): Promise<void> => {
      if (state.processing) {
        state.queued = true;
        return;
      }
      state.processing = true;
      try {
        const stat = await fsPromises.stat(input.rawLogPath);
        if (stat.size <= state.offset) return;
        const handle = await fsPromises.open(input.rawLogPath, 'r');
        try {
          const length = stat.size - state.offset;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, state.offset);
          state.offset = stat.size;
          const chunk = buffer.toString('utf8');
          if (chunk.trim()) {
            state.pendingChunk += chunk;
            this.scheduleFlush(input.sessionId, state, input.onChunk);
          }
        } finally {
          await handle.close();
        }
      } catch {
        return;
      } finally {
        state.processing = false;
        if (state.queued) {
          state.queued = false;
          void pump();
        }
      }
    };

    try {
      state.watcher = fs.watch(input.rawLogPath, { persistent: false }, () => {
        void pump();
      });
    } catch {
      state.watcher = undefined;
    }
    if (this.pollIntervalMs > 0) {
      state.pollTimer = setInterval(() => {
        void pump();
      }, this.pollIntervalMs);
      state.pollTimer.unref?.();
    }
    void pump();
  }

  stop(sessionId: string, options: { flush?: boolean } = {}, onChunk?: (chunk: string) => void): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
      if (options.flush !== false && onChunk) {
        this.flush(state, onChunk);
      }
    }
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = undefined;
    }
    state.watcher?.close();
    this.watchers.delete(sessionId);
  }

  private scheduleFlush(sessionId: string, state: WatchState, onChunk: (chunk: string) => void): void {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      this.flush(state, onChunk);
    }, 120);
  }

  private flush(state: WatchState, onChunk: (chunk: string) => void): void {
    const chunk = state.pendingChunk;
    state.pendingChunk = '';
    if (chunk.trim()) {
      onChunk(chunk);
    }
  }
}
