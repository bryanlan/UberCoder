import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { SqliteRow } from './utils.js';

// This function is the complete worker entrypoint in both source and compiled
// execution. It has no closure dependencies or provider/session capabilities.
function workerMain(): void {
  const { parentPort, workerData } = require('node:worker_threads') as typeof import('node:worker_threads');
  const Database = require(workerData.sqliteModule) as typeof import('better-sqlite3');
  const sqlite = new Database(workerData.databasePath, { readonly: true, fileMustExist: true });
  sqlite.pragma('query_only = ON');
  sqlite.pragma('cache_size = -65536');
  parentPort!.on('message', ({ id, sql, parameters }: { id: number; sql: string; parameters: unknown[] }) => {
    try {
      parentPort!.postMessage({ id, rows: sqlite.prepare(sql).all(...parameters) });
    } catch (error) {
      parentPort!.postMessage({ id, error: error instanceof Error ? error.message : 'Search read failed.' });
    }
  });
}

interface PendingRead {
  resolve: (rows: SqliteRow[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One bounded read-only connection; index writes remain on the owning thread. */
export class ReadQueryWorker {
  private worker?: Worker;
  private readonly pending = new Map<number, PendingRead>();
  private nextId = 0;
  private closed = false;

  constructor(private readonly databasePath: string) {}

  query(sql: string, parameters: unknown[]): Promise<SqliteRow[]> {
    if (this.closed) return Promise.reject(new Error('Search reader is closed.'));
    if (this.pending.size >= 16) return Promise.reject(new Error('Search reader is busy; try again.'));
    if (!this.databasePath || this.databasePath === ':memory:') {
      return Promise.reject(new Error('Search requires a file-backed database.'));
    }
    const worker = this.worker ?? this.start();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(worker, new Error('Search read timed out.')), 10_000);
      this.pending.set(id, { resolve, reject, timer });
      worker.ref();
      try {
        worker.postMessage({ id, sql, parameters });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Invalid search parameters.'));
        if (this.pending.size === 0) worker.unref();
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.rejectPending(new Error('Search reader is closed.'));
    if (worker) await worker.terminate();
  }

  private start(): Worker {
    const worker = new Worker(`(${workerMain.toString()})();`, {
      eval: true,
      workerData: { databasePath: this.databasePath, sqliteModule: createRequire(import.meta.url).resolve('better-sqlite3') },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    this.worker = worker;
    worker.on('message', (result: { id: number; rows: SqliteRow[]; error?: string }) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(result.id);
      if (!pending) return;
      this.pending.delete(result.id);
      clearTimeout(pending.timer);
      if (result.error) pending.reject(new Error(result.error));
      else pending.resolve(result.rows);
      if (this.pending.size === 0) worker.unref();
    });
    worker.on('error', (error) => this.fail(worker, error));
    worker.on('exit', () => this.fail(worker, new Error('Search reader stopped.')));
    worker.unref();
    return worker;
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.rejectPending(error);
    void worker.terminate();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
