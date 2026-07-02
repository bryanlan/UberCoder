import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

interface WatchState {
  offset: number;
  watcher?: fs.FSWatcher;
  processing: boolean;
  queued: boolean;
  pendingChunk: string;
  flushTimer?: NodeJS.Timeout;
}

export class OutputWatcherRegistry {
  private readonly watchers = new Map<string, WatchState>();

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

    state.watcher = fs.watch(input.rawLogPath, { persistent: false }, () => {
      void pump();
    });
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
