import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

interface WatchState {
  transcriptPath: string;
  size: number;
  mtimeMs: number;
  watcher?: fs.FSWatcher;
  pollTimer?: NodeJS.Timeout;
  processing: boolean;
  queued: boolean;
}

interface TranscriptWatcherRegistryOptions {
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

function readInitialStat(transcriptPath: string): { size: number; mtimeMs: number } {
  try {
    const stat = fs.statSync(transcriptPath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

export class TranscriptWatcherRegistry {
  private readonly watchers = new Map<string, WatchState>();
  private readonly pollIntervalMs: number;

  constructor(options: TranscriptWatcherRegistryOptions = {}) {
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
    transcriptPath: string;
    onChange: () => void;
  }): void {
    const existing = this.watchers.get(input.sessionId);
    if (existing?.transcriptPath === input.transcriptPath) {
      return;
    }
    if (existing) {
      this.stop(input.sessionId);
    }

    const initial = readInitialStat(input.transcriptPath);
    const state: WatchState = {
      transcriptPath: input.transcriptPath,
      size: initial.size,
      mtimeMs: initial.mtimeMs,
      processing: false,
      queued: false,
    };
    this.watchers.set(input.sessionId, state);

    const pump = async (): Promise<void> => {
      if (this.watchers.get(input.sessionId) !== state) {
        return;
      }
      if (state.processing) {
        state.queued = true;
        return;
      }
      state.processing = true;
      try {
        if (this.watchers.get(input.sessionId) !== state) {
          return;
        }
        const stat = await fsPromises.stat(input.transcriptPath);
        const changed = stat.size !== state.size || stat.mtimeMs !== state.mtimeMs;
        if (!changed) {
          return;
        }
        if (this.watchers.get(input.sessionId) !== state) {
          return;
        }
        state.size = stat.size;
        state.mtimeMs = stat.mtimeMs;
        input.onChange();
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
      state.watcher = fs.watch(input.transcriptPath, { persistent: false }, () => {
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
  }

  stop(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = undefined;
    }
    state.watcher?.close();
    this.watchers.delete(sessionId);
  }
}
